(function initStorageRepository(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./history-store.js'));
    return;
  }
  root.TabEchoStorageRepository = factory(root.TabEchoHistoryStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule(historyStore) {
  if (!historyStore) {
    throw new Error('TabEchoHistoryStore is required.');
  }

  const MODES = ['normal', 'incognito'];
  const MIGRATION_VERSION = 2;
  const STORAGE_KEYS = Object.freeze({
    settings: 'tabEcho:settings:v2',
    history: Object.freeze({
      normal: 'tabEcho:history:normal:v2',
      incognito: 'tabEcho:history:incognito:v2',
    }),
    trash: Object.freeze({
      normal: 'tabEcho:trash:normal:v2',
      incognito: 'tabEcho:trash:incognito:v2',
    }),
    migration: 'tabEcho:migration:v2',
    migrationNotice: 'tabEcho:migration-notice:v2',
    legacy: 'tabEchoState',
  });

  class SettingsValidationError extends Error {
    constructor(errors) {
      super('Settings validation failed.');
      this.name = 'SettingsValidationError';
      this.errors = clone(errors);
    }
  }

  class StorageWriteError extends Error {
    constructor(operation, attempts, cause) {
      super(`${operation} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${messageOf(cause)}`);
      this.name = 'StorageWriteError';
      this.operation = operation;
      this.attempts = attempts;
      this.cause = cause;
    }
  }

  function messageOf(error) {
    return error && error.message ? error.message : String(error);
  }

  function clone(value) {
    if (value === undefined) {
      return undefined;
    }
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function assertMode(mode) {
    if (!MODES.includes(mode)) {
      throw new TypeError('mode must be normal or incognito.');
    }
    return mode;
  }

  function validateStorageArea(storageArea) {
    for (const method of ['get', 'set', 'remove']) {
      if (!storageArea || typeof storageArea[method] !== 'function') {
        throw new TypeError(`storageArea.${method} must be a function.`);
      }
    }
  }

  function readValue(result, key) {
    return result && typeof result === 'object' && Object.hasOwn(result, key)
      ? result[key]
      : undefined;
  }

  function normalizeEventList(input, mode) {
    if (!Array.isArray(input)) {
      return [];
    }
    return input.map((event) => historyStore.normalizeCloseEvent(
      event && typeof event === 'object' ? { ...event, mode } : event,
      mode,
    )).filter(Boolean);
  }

  function normalizeTrashList(input, mode) {
    if (!Array.isArray(input)) {
      return [];
    }
    return input.map((source) => {
      const event = historyStore.normalizeCloseEvent(
        source && typeof source === 'object' ? { ...source, mode } : source,
        mode,
      );
      if (!event) {
        return null;
      }
      if (source && source.deletedAt !== null && source.deletedAt !== undefined
        && Number.isFinite(Number(source.deletedAt))) {
        return { ...event, deletedAt: Number(source.deletedAt) };
      }
      return event;
    }).filter(Boolean);
  }

  function equivalent(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function createStorageRepository(storageArea, options = {}) {
    validateStorageArea(storageArea);
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const createNoticeId = typeof options.createNoticeId === 'function'
      ? options.createNoticeId
      : () => (typeof globalThis.crypto === 'object' && typeof globalThis.crypto.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${now()}-${Math.random().toString(36).slice(2)}`);
    const retryLimit = Number.isSafeInteger(options.retryLimit) && options.retryLimit >= 0
      ? options.retryLimit
      : 3;
    const maxAttempts = retryLimit + 1;
    // Concurrency boundary: one repository instance is the sole writer for each mode.
    // Split workers must create repositories only in trusted contexts and write their own partition.
    const queues = { normal: Promise.resolve(), incognito: Promise.resolve() };
    let migrationQueue = Promise.resolve();

    async function getMany(keys) {
      return storageArea.get(keys);
    }

    async function getSettings() {
      const result = await getMany(STORAGE_KEYS.settings);
      return clone(historyStore.normalizeSettings(readValue(result, STORAGE_KEYS.settings)));
    }

    function normalizeMigrationNotice(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const id = typeof value.id === 'string' ? value.id.trim() : '';
      const version = Number(value.version);
      const skippedEvents = Number(value.skippedEvents);
      const createdAt = Number(value.createdAt);
      if (!id || version !== MIGRATION_VERSION || !Number.isSafeInteger(skippedEvents) || skippedEvents < 0
        || !Number.isFinite(createdAt)) return null;
      return { id, version, skippedEvents, createdAt };
    }

    function newNoticeId() {
      const candidate = createNoticeId();
      if (typeof candidate !== 'string' || !candidate.trim()) {
        throw new Error('Migration notice id must be a non-empty string.');
      }
      return candidate.trim();
    }

    async function getMigrationNotice() {
      const result = await getMany([STORAGE_KEYS.migration, STORAGE_KEYS.migrationNotice]);
      const marker = readValue(result, STORAGE_KEYS.migration);
      const notice = normalizeMigrationNotice(readValue(result, STORAGE_KEYS.migrationNotice));
      if (marker && marker.noticeAcknowledged === true) {
        if (notice) {
          try { await storageArea.remove(STORAGE_KEYS.migrationNotice); } catch (_) { /* Marker remains authoritative. */ }
        }
        return null;
      }
      return clone(notice);
    }

    async function acknowledgeMigrationNotice(expectedId) {
      const result = await getMany([STORAGE_KEYS.migration, STORAGE_KEYS.migrationNotice]);
      const marker = readValue(result, STORAGE_KEYS.migration);
      const current = normalizeMigrationNotice(readValue(result, STORAGE_KEYS.migrationNotice));
      if (!current || typeof expectedId !== 'string' || expectedId !== current.id) return false;
      if (!marker || marker.noticeId !== current.id || marker.noticeRequired !== true) return false;
      const acknowledgedMarker = { ...marker, noticeAcknowledged: true };
      await writeWithRetry('Migration notice acknowledgement', async () => ({
        [STORAGE_KEYS.migration]: acknowledgedMarker,
      }));
      const verified = await getMany(STORAGE_KEYS.migration);
      if (!equivalent(readValue(verified, STORAGE_KEYS.migration), acknowledgedMarker)) {
        throw new Error('Migration notice acknowledgement verification failed.');
      }
      // chrome.storage.local has no compare-and-swap. The token check prevents a stale UI
      // from normally deleting a newer notice, with only an extreme cross-worker race remaining.
      await storageArea.remove(STORAGE_KEYS.migrationNotice);
      return true;
    }

    async function writeWithRetry(operation, makeItems) {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const items = await makeItems(attempt);
          await storageArea.set(clone(items));
          return items;
        } catch (error) {
          lastError = error;
        }
      }
      throw new StorageWriteError(operation, maxAttempts, lastError);
    }

    async function saveSettings(input) {
      const validation = historyStore.validateSettingsInput(input);
      if (!validation.valid) {
        throw new SettingsValidationError(validation.errors);
      }
      const settings = historyStore.normalizeSettings(validation.settings);
      await writeWithRetry('saveSettings', async () => ({
        [STORAGE_KEYS.settings]: settings,
      }));
      return clone(settings);
    }

    async function readHistory(mode) {
      const activeMode = assertMode(mode);
      const key = STORAGE_KEYS.history[activeMode];
      const result = await getMany(key);
      return clone(normalizeEventList(readValue(result, key), activeMode));
    }

    async function readTrash(mode) {
      const activeMode = assertMode(mode);
      const key = STORAGE_KEYS.trash[activeMode];
      const result = await getMany(key);
      return clone(normalizeTrashList(readValue(result, key), activeMode));
    }

    async function readContext(mode) {
      const activeMode = assertMode(mode);
      const keys = [STORAGE_KEYS.settings, STORAGE_KEYS.history[activeMode], STORAGE_KEYS.trash[activeMode]];
      const result = await getMany(keys);
      return {
        settings: historyStore.normalizeSettings(readValue(result, STORAGE_KEYS.settings)),
        history: normalizeEventList(readValue(result, STORAGE_KEYS.history[activeMode]), activeMode),
        trash: normalizeTrashList(readValue(result, STORAGE_KEYS.trash[activeMode]), activeMode),
      };
    }

    async function performUpdate(mode, mutator) {
      if (typeof mutator !== 'function') {
        throw new TypeError('mutator must be a function.');
      }
      const current = await readContext(mode);
      const mutation = await mutator(clone(current));
      if (!mutation || typeof mutation !== 'object') {
        throw new TypeError('mutator must return an object.');
      }
      const history = normalizeEventList(
        Object.hasOwn(mutation, 'history') ? mutation.history : current.history,
        mode,
      );
      const trash = normalizeTrashList(
        Object.hasOwn(mutation, 'trash') ? mutation.trash : current.trash,
        mode,
      );
      const committed = { settings: current.settings, history, trash };
      const returnValue = Object.hasOwn(mutation, 'result') ? mutation.result : committed;
      // Clone before storage.set so clone failures cannot happen after a successful commit.
      const preparedResult = clone(returnValue);
      const payload = clone({
        [STORAGE_KEYS.history[mode]]: history,
        [STORAGE_KEYS.trash[mode]]: trash,
      });
      let lastWriteError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await storageArea.set(payload);
          return preparedResult;
        } catch (error) {
          lastWriteError = error;
        }
      }
      throw new StorageWriteError(`updateContext(${mode})`, maxAttempts, lastWriteError);
    }

    function updateContext(mode, mutator) {
      const activeMode = assertMode(mode);
      const run = queues[activeMode].then(() => performUpdate(activeMode, mutator));
      queues[activeMode] = run.catch(() => undefined);
      return run;
    }

    function migrateSettings(legacySettings) {
      const source = legacySettings && typeof legacySettings === 'object' ? legacySettings : {};
      const maxRecordsMissing = source.maxRecords === undefined || source.maxRecords === '';
      const maxAgeMissing = source.maxAgeDays === undefined || source.maxAgeDays === '';
      const candidate = {
        ...source,
        maxRecords: maxRecordsMissing || Number(source.maxRecords) === 65536
          ? historyStore.DEFAULT_SETTINGS.maxRecords
          : source.maxRecords,
        maxAgeDays: maxAgeMissing || Number(source.maxAgeDays) === 30
          ? historyStore.DEFAULT_SETTINGS.maxAgeDays
          : source.maxAgeDays,
        trashMaxAgeDays: source.trashMaxAgeDays === undefined
          ? historyStore.DEFAULT_SETTINGS.trashMaxAgeDays
          : source.trashMaxAgeDays,
        settingsVersion: MIGRATION_VERSION,
      };
      return historyStore.normalizeSettings(candidate);
    }

    function migrationPayload(legacy) {
      const events = legacy && legacy.events && typeof legacy.events === 'object' ? legacy.events : {};
      const payload = { settings: migrateSettings(legacy && legacy.settings), history: {}, trash: {} };
      let skippedEvents = 0;
      for (const mode of MODES) {
        const source = Array.isArray(events[mode]) ? events[mode] : [];
        payload.history[mode] = [];
        for (const event of source) {
          const normalized = historyStore.normalizeCloseEvent(
            event && typeof event === 'object' ? { ...event, mode } : event,
            mode,
          );
          if (normalized) {
            payload.history[mode].push(normalized);
          } else {
            skippedEvents += 1;
          }
        }
        payload.trash[mode] = [];
      }
      return { payload, skippedEvents };
    }

    function isCompatibleNoticeUpgrade(sourceMarker, committedMarker, committedNotice) {
      if (!committedMarker || typeof committedMarker !== 'object' || Array.isArray(committedMarker)) return false;
      const noticeId = typeof committedMarker.noticeId === 'string' ? committedMarker.noticeId.trim() : '';
      if (Number(committedMarker.version) < MIGRATION_VERSION || committedMarker.noticeRequired !== true || !noticeId) return false;
      for (const [key, value] of Object.entries(sourceMarker)) {
        if (key === 'completedAt') continue;
        if (!equivalent(committedMarker[key], value)) return false;
      }
      if (committedMarker.noticeAcknowledged === true) return true;
      if (committedMarker.noticeAcknowledged !== false) return false;
      return equivalent(normalizeMigrationNotice(committedNotice), {
        id: noticeId,
        version: MIGRATION_VERSION,
        skippedEvents: Number(committedMarker.skippedEvents) || 0,
        createdAt: Number(committedMarker.completedAt),
      });
    }

    async function performMigration() {
      const allKeys = [
        STORAGE_KEYS.migration, STORAGE_KEYS.migrationNotice, STORAGE_KEYS.legacy, STORAGE_KEYS.settings,
        STORAGE_KEYS.history.normal, STORAGE_KEYS.history.incognito,
        STORAGE_KEYS.trash.normal, STORAGE_KEYS.trash.incognito,
      ];
      const current = await getMany(allKeys);
      const marker = readValue(current, STORAGE_KEYS.migration);
      if (marker && Number(marker.version) >= MIGRATION_VERSION) {
        const hasResidualLegacy = Object.hasOwn(current, STORAGE_KEYS.legacy);
        let effectiveMarker = marker;
        const isPreNoticeMarker = marker.noticeRequired === undefined && marker.noticeId === undefined
          && marker.noticeAcknowledged === undefined;
        if (isPreNoticeMarker) {
          const noticeId = newNoticeId();
          const createdAt = Number.isFinite(Number(marker.completedAt)) ? Number(marker.completedAt) : now();
          effectiveMarker = { ...marker, completedAt: createdAt, noticeRequired: true, noticeId, noticeAcknowledged: false };
          const migrationNotice = {
            id: noticeId, version: MIGRATION_VERSION, skippedEvents: Number(marker.skippedEvents) || 0,
            createdAt,
          };
          await writeWithRetry('Migration notice upgrade', async () => ({
            [STORAGE_KEYS.migration]: effectiveMarker, [STORAGE_KEYS.migrationNotice]: migrationNotice,
          }));
          const upgraded = await getMany([STORAGE_KEYS.migration, STORAGE_KEYS.migrationNotice]);
          const committedMarker = readValue(upgraded, STORAGE_KEYS.migration);
          const committedNotice = readValue(upgraded, STORAGE_KEYS.migrationNotice);
          if (!equivalent(committedMarker, effectiveMarker)
            || !equivalent(normalizeMigrationNotice(committedNotice), migrationNotice)) {
            // Regular and incognito split workers share this marker. Both can observe the
            // pre-notice shape and race to upgrade it with different notice ids. A complete,
            // compatible winner is authoritative; only a partial or unrelated write is an error.
            if (!isCompatibleNoticeUpgrade(marker, committedMarker, committedNotice)) {
              throw new Error('Migration notice upgrade verification failed.');
            }
            effectiveMarker = committedMarker;
          }
        } else if (marker.noticeAcknowledged !== true && marker.noticeRequired === true
          && typeof marker.noticeId === 'string' && marker.noticeId.trim()) {
          const expectedNotice = {
            id: marker.noticeId.trim(), version: MIGRATION_VERSION,
            skippedEvents: Number(marker.skippedEvents) || 0, createdAt: Number(marker.completedAt),
          };
          const currentNotice = normalizeMigrationNotice(readValue(current, STORAGE_KEYS.migrationNotice));
          if (!equivalent(currentNotice, expectedNotice)) {
            await writeWithRetry('Migration notice repair', async () => ({
              [STORAGE_KEYS.migrationNotice]: expectedNotice,
            }));
            const repaired = await getMany(STORAGE_KEYS.migrationNotice);
            if (!equivalent(normalizeMigrationNotice(readValue(repaired, STORAGE_KEYS.migrationNotice)), expectedNotice)) {
              throw new Error('Migration notice repair verification failed.');
            }
          }
        }
        if (hasResidualLegacy) {
          await storageArea.remove(STORAGE_KEYS.legacy);
        }
        return { migrated: false, skippedEvents: Number(effectiveMarker.skippedEvents) || 0,
          ...(effectiveMarker.corruptLegacy === true ? { corruptLegacy: true } : {}) };
      }

      const hasLegacy = Object.hasOwn(current, STORAGE_KEYS.legacy);
      if (!hasLegacy) {
        return { migrated: false, skippedEvents: 0 };
      }
      const legacy = readValue(current, STORAGE_KEYS.legacy);
      const corruptLegacy = legacy === null || typeof legacy !== 'object' || Array.isArray(legacy);
      if (corruptLegacy) {
        const noticeId = newNoticeId();
        const corruptMarker = {
          version: MIGRATION_VERSION,
          skippedEvents: 0,
          corruptLegacy: true,
          completedAt: now(),
          noticeRequired: true,
          noticeId,
        };
        const migrationNotice = {
          id: noticeId, version: MIGRATION_VERSION, skippedEvents: 0, createdAt: corruptMarker.completedAt,
        };
        await writeWithRetry('Migration marker write', async () => ({
          [STORAGE_KEYS.migration]: corruptMarker,
          [STORAGE_KEYS.migrationNotice]: migrationNotice,
        }));
        const corruptMarkerResult = await getMany([STORAGE_KEYS.migration, STORAGE_KEYS.migrationNotice]);
        if (!equivalent(readValue(corruptMarkerResult, STORAGE_KEYS.migration), corruptMarker)) {
          throw new Error('Migration marker verification failed.');
        }
        if (!equivalent(readValue(corruptMarkerResult, STORAGE_KEYS.migrationNotice), migrationNotice)) {
          throw new Error('Migration notice verification failed.');
        }
        await storageArea.remove(STORAGE_KEYS.legacy);
        return { migrated: true, skippedEvents: 0, corruptLegacy: true };
      }
      const { payload, skippedEvents } = migrationPayload(legacy);
      const desired = {
        [STORAGE_KEYS.settings]: payload.settings,
        [STORAGE_KEYS.history.normal]: payload.history.normal,
        [STORAGE_KEYS.history.incognito]: payload.history.incognito,
        [STORAGE_KEYS.trash.normal]: payload.trash.normal,
        [STORAGE_KEYS.trash.incognito]: payload.trash.incognito,
      };
      const missing = {};
      for (const [key, value] of Object.entries(desired)) {
        if (!Object.hasOwn(current, key)) {
          missing[key] = value;
        }
      }

      if (Object.keys(missing).length > 0) {
        try {
          await writeWithRetry('Migration write', async () => missing);
        } catch (error) {
          throw error;
        }
      }

      const verifyResult = await getMany(Object.keys(desired));
      for (const key of Object.keys(desired)) {
        const expected = Object.hasOwn(current, key) ? current[key] : desired[key];
        if (!Object.hasOwn(verifyResult, key) || !equivalent(verifyResult[key], expected)) {
          throw new Error(`Migration verification failed for ${key}.`);
        }
      }

      const noticeId = newNoticeId();
      const migrationMarker = { version: MIGRATION_VERSION, skippedEvents, completedAt: now(),
        noticeRequired: true, noticeId };
      const migrationNotice = { id: noticeId, version: MIGRATION_VERSION, skippedEvents, createdAt: migrationMarker.completedAt };
      try {
        await writeWithRetry('Migration marker write', async () => ({
          [STORAGE_KEYS.migration]: migrationMarker,
          [STORAGE_KEYS.migrationNotice]: migrationNotice,
        }));
      } catch (error) {
        throw error;
      }
      const markerResult = await getMany([STORAGE_KEYS.migration, STORAGE_KEYS.migrationNotice]);
      if (!equivalent(readValue(markerResult, STORAGE_KEYS.migration), migrationMarker)) {
        throw new Error('Migration marker verification failed.');
      }
      if (!equivalent(readValue(markerResult, STORAGE_KEYS.migrationNotice), migrationNotice)) {
        throw new Error('Migration notice verification failed.');
      }
      await storageArea.remove(STORAGE_KEYS.legacy);
      return { migrated: true, skippedEvents };
    }

    function migrateLegacyState() {
      const run = migrationQueue.then(performMigration);
      migrationQueue = run.catch(() => undefined);
      return run;
    }

    return {
      acknowledgeMigrationNotice,
      getMigrationNotice,
      getSettings,
      migrateLegacyState,
      readHistory,
      readTrash,
      saveSettings,
      updateContext,
    };
  }

  return {
    MIGRATION_VERSION,
    STORAGE_KEYS,
    SettingsValidationError,
    StorageWriteError,
    createStorageRepository,
  };
});
