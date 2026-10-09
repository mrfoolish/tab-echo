(function initIndexedDbMigration(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./history-store.js'));
    return;
  }
  root.TabEchoIndexedDbMigration = factory(root.TabEchoHistoryStore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule(historyStore) {
  if (!historyStore) throw new Error('TabEchoHistoryStore is required.');

  const MIGRATION_VERSION = 1;
  const MODES = ['normal', 'incognito'];
  const KEYS = Object.freeze({
    history: Object.freeze({
      normal: 'tabEcho:history:normal:v2',
      incognito: 'tabEcho:history:incognito:v2',
    }),
    trash: Object.freeze({
      normal: 'tabEcho:trash:normal:v2',
      incognito: 'tabEcho:trash:incognito:v2',
    }),
    revision: Object.freeze({
      normal: 'tabEcho:revision:normal:v2',
      incognito: 'tabEcho:revision:incognito:v2',
    }),
    marker: Object.freeze({
      normal: 'tabEcho:indexeddb-migration:normal:v1',
      incognito: 'tabEcho:indexeddb-migration:incognito:v1',
    }),
    generation: Object.freeze({
      normal: 'tabEcho:indexeddb-generation:normal:v1',
      incognito: 'tabEcho:indexeddb-generation:incognito:v1',
    }),
  });

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function assertMode(mode) {
    if (!MODES.includes(mode)) throw new TypeError('mode must be normal or incognito.');
    return mode;
  }

  function readValue(result, key) {
    return result && typeof result === 'object' && Object.hasOwn(result, key)
      ? result[key] : undefined;
  }

  function normalizeRevision(value) {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  function normalizeHistory(source, mode) {
    if (!Array.isArray(source)) return { records: [], skipped: 0 };
    const records = [];
    let skipped = 0;
    for (const candidate of source) {
      const event = historyStore.normalizeCloseEvent(
        candidate && typeof candidate === 'object' ? { ...candidate, mode } : candidate,
        mode,
      );
      if (event) records.push(event); else skipped += 1;
    }
    return { records, skipped };
  }

  function normalizeTrash(source, mode) {
    if (!Array.isArray(source)) return { records: [], skipped: 0 };
    const records = [];
    let skipped = 0;
    for (const candidate of source) {
      const event = historyStore.normalizeCloseEvent(
        candidate && typeof candidate === 'object' ? { ...candidate, mode } : candidate,
        mode,
      );
      if (!event) { skipped += 1; continue; }
      const deletedAt = Number(candidate && candidate.deletedAt);
      records.push(Number.isFinite(deletedAt) ? { ...event, deletedAt } : event);
    }
    return { records, skipped };
  }

  function createYieldControl(environment = globalThis) {
    return async function yieldControl() {
      if (environment.scheduler && typeof environment.scheduler.yield === 'function') {
        await environment.scheduler.yield();
        return;
      }
      await new Promise((resolve) => environment.setTimeout(resolve, 0));
    };
  }

  function representativeOrdinals(records) {
    if (records.length === 0) return [];
    if (records.length === 1) return [0];
    return [0, records.length - 1];
  }

  function representativeShape(event) {
    return event ? {
      id: String(event.id),
      mode: event.mode,
      kind: event.kind,
      closedAt: Number(event.closedAt),
      deletedAt: event.deletedAt === undefined ? null : Number(event.deletedAt),
      tabs: Array.isArray(event.tabs) ? event.tabs.map((tab) => ({
        id: String(tab.id), title: tab.title, url: tab.url,
      })) : [],
    } : null;
  }

  function createIndexedDbMigration(options = {}) {
    const storageArea = options.storageArea;
    const recordStore = options.recordStore;
    if (!storageArea || typeof storageArea.get !== 'function'
      || typeof storageArea.set !== 'function' || typeof storageArea.remove !== 'function') {
      throw new TypeError('storageArea get/set/remove methods are required.');
    }
    for (const method of ['resetGeneration', 'putBatch', 'countGeneration', 'getRecordsByOrdinals']) {
      if (!recordStore || typeof recordStore[method] !== 'function') {
        throw new TypeError(`recordStore.${method} is required.`);
      }
    }
    const batchSize = Number.isSafeInteger(options.batchSize) && options.batchSize > 0
      ? options.batchSize : 250;
    const timeBudgetMs = Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs > 0
      ? options.timeBudgetMs : 50;
    const performanceNow = typeof options.performanceNow === 'function'
      ? options.performanceNow
      : () => (globalThis.performance && typeof globalThis.performance.now === 'function'
        ? globalThis.performance.now() : Date.now());
    const yieldControl = typeof options.yieldControl === 'function'
      ? options.yieldControl : createYieldControl();
    const now = typeof options.now === 'function' ? options.now : Date.now;

    async function writeBatches(storeName, mode, generation, records) {
      let deadline = performanceNow() + timeBudgetMs;
      for (let offset = 0; offset < records.length; offset += batchSize) {
        await recordStore.putBatch(storeName, mode, generation,
          records.slice(offset, offset + batchSize), offset);
        if (offset + batchSize < records.length && performanceNow() >= deadline) {
          await yieldControl();
          deadline = performanceNow() + timeBudgetMs;
        }
      }
    }

    async function verifyCollection(storeName, mode, generation, records) {
      const count = await recordStore.countGeneration(storeName, mode, generation);
      if (count !== records.length) {
        throw new Error(`IndexedDB ${storeName} migration count mismatch.`);
      }
      const ordinals = representativeOrdinals(records);
      const stored = await recordStore.getRecordsByOrdinals(storeName, mode, generation, ordinals);
      if (stored.length !== ordinals.length) {
        throw new Error(`IndexedDB ${storeName} migration sample is missing.`);
      }
      const expectedShapes = ordinals.map((ordinal) => records[ordinal])
        .map(representativeShape);
      const storedShapes = stored.map(representativeShape);
      if (JSON.stringify(storedShapes) !== JSON.stringify(expectedShapes)) {
        throw new Error(`IndexedDB ${storeName} migration sample mismatch.`);
      }
    }

    async function cleanupLegacyArrays(mode) {
      try {
        await storageArea.remove([KEYS.history[mode], KEYS.trash[mode]]);
        return false;
      } catch (_) {
        return true;
      }
    }

    async function migrateMode(rawMode) {
      const mode = assertMode(rawMode);
      const requestedKeys = [KEYS.history[mode], KEYS.trash[mode], KEYS.revision[mode],
        KEYS.marker[mode], KEYS.generation[mode]];
      const current = await storageArea.get(requestedKeys);
      const marker = readValue(current, KEYS.marker[mode]);
      const activeGeneration = readValue(current, KEYS.generation[mode]);
      if (marker && marker.version === MIGRATION_VERSION && marker.status === 'complete'
        && typeof activeGeneration === 'string' && activeGeneration) {
        return {
          migrated: false,
          generation: activeGeneration,
          skippedRecords: Number(marker.skippedRecords) || 0,
          cleanupPending: await cleanupLegacyArrays(mode),
        };
      }

      const normalizedHistory = normalizeHistory(readValue(current, KEYS.history[mode]), mode);
      const normalizedTrash = normalizeTrash(readValue(current, KEYS.trash[mode]), mode);
      const revision = normalizeRevision(readValue(current, KEYS.revision[mode]));
      const generation = `v${MIGRATION_VERSION}-${mode}-${revision}-${normalizedHistory.records.length}-${normalizedTrash.records.length}`;
      await recordStore.resetGeneration(mode, generation);
      await writeBatches('history', mode, generation, normalizedHistory.records);
      await writeBatches('trash', mode, generation, normalizedTrash.records);
      await verifyCollection('history', mode, generation, normalizedHistory.records);
      await verifyCollection('trash', mode, generation, normalizedTrash.records);

      const completedAt = now();
      const skippedRecords = normalizedHistory.skipped + normalizedTrash.skipped;
      const committedMarker = {
        version: MIGRATION_VERSION,
        status: 'complete',
        mode,
        generation,
        historyCount: normalizedHistory.records.length,
        trashCount: normalizedTrash.records.length,
        skippedRecords,
        completedAt,
      };
      await storageArea.set({
        [KEYS.marker[mode]]: committedMarker,
        [KEYS.generation[mode]]: generation,
      });
      return {
        migrated: true,
        generation,
        skippedRecords,
        cleanupPending: await cleanupLegacyArrays(mode),
      };
    }

    return { migrateMode };
  }

  return {
    KEYS,
    MIGRATION_VERSION,
    createIndexedDbMigration,
    createYieldControl,
    normalizeHistory,
    normalizeTrash,
    representativeShape,
  };
});
