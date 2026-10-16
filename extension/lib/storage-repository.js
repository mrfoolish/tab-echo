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
  const STORAGE_KEYS = Object.freeze({
    settings: 'tabEcho:settings:v2',
    settingsRevision: 'tabEcho:settings-revision:v2',
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

  function normalizeRevision(value) {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }

  function createUnavailableStorageRepository(options = {}) {
    const code = typeof options.code === 'string' && options.code
      ? options.code : 'STORAGE_UNAVAILABLE';
    const message = typeof options.message === 'string' && options.message
      ? options.message : 'Storage is unavailable.';
    async function unavailable() {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    return {
      getSettings: unavailable,
      readContext: unavailable,
      readHistory: unavailable,
      readTrash: unavailable,
      queryCollection: unavailable,
      queryHistoryByDomain: unavailable,
      saveSettings: unavailable,
      updateContext: unavailable,
      updateSettingsAndContext: unavailable,
    };
  }

  function createStorageRepository(storageArea, options = {}) {
    validateStorageArea(storageArea);
    const retryLimit = Number.isSafeInteger(options.retryLimit) && options.retryLimit >= 0
      ? options.retryLimit
      : 3;
    const maxAttempts = retryLimit + 1;
    // Concurrency boundary: one repository instance is the sole writer for each mode.
    // Split workers must create repositories only in trusted contexts and write their own partition.
    const queues = { normal: Promise.resolve(), incognito: Promise.resolve() };

    async function getMany(keys) {
      return storageArea.get(keys);
    }

    async function getSettings() {
      const result = await getMany(STORAGE_KEYS.settings);
      return clone(historyStore.normalizeSettings(readValue(result, STORAGE_KEYS.settings)));
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
      const current = await getMany(STORAGE_KEYS.settingsRevision);
      const settingsRevision = normalizeRevision(readValue(current, STORAGE_KEYS.settingsRevision)) + 1;
      const payload = {
        [STORAGE_KEYS.settings]: settings,
        [STORAGE_KEYS.settingsRevision]: settingsRevision,
      };
      await writeWithRetry('saveSettings', async () => payload);
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
      const keys = [
        STORAGE_KEYS.settings,
        STORAGE_KEYS.settingsRevision,
        STORAGE_KEYS.history[activeMode],
        STORAGE_KEYS.trash[activeMode],
        STORAGE_KEYS.revision[activeMode],
      ];
      const result = await getMany(keys);
      return {
        settings: historyStore.normalizeSettings(readValue(result, STORAGE_KEYS.settings)),
        history: normalizeEventList(readValue(result, STORAGE_KEYS.history[activeMode]), activeMode),
        trash: normalizeTrashList(readValue(result, STORAGE_KEYS.trash[activeMode]), activeMode),
        revision: normalizeRevision(readValue(result, STORAGE_KEYS.revision[activeMode])),
        settingsRevision: normalizeRevision(readValue(result, STORAGE_KEYS.settingsRevision)),
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
      const revision = current.revision + 1;
      // Clone before storage.set so clone failures cannot happen after a successful commit.
      const preparedResult = clone(returnValue);
      const payload = clone({
        [STORAGE_KEYS.history[mode]]: history,
        [STORAGE_KEYS.trash[mode]]: trash,
        [STORAGE_KEYS.revision[mode]]: revision,
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

    async function performSettingsAndContextUpdate(mode, mutator) {
      if (typeof mutator !== 'function') {
        throw new TypeError('mutator must be a function.');
      }
      const current = await readContext(mode);
      const mutation = await mutator(clone(current));
      if (!mutation || typeof mutation !== 'object') {
        throw new TypeError('mutator must return an object.');
      }
      const settingsInput = Object.hasOwn(mutation, 'settings') ? mutation.settings : current.settings;
      const validation = historyStore.validateSettingsInput(settingsInput);
      if (!validation.valid) {
        throw new SettingsValidationError(validation.errors);
      }
      const settings = historyStore.normalizeSettings(validation.settings);
      const history = normalizeEventList(
        Object.hasOwn(mutation, 'history') ? mutation.history : current.history,
        mode,
      );
      const trash = normalizeTrashList(
        Object.hasOwn(mutation, 'trash') ? mutation.trash : current.trash,
        mode,
      );
      const contextChanged = !equivalent(history, current.history) || !equivalent(trash, current.trash);
      const settingsChanged = !equivalent(settings, current.settings);
      const revision = current.revision + (contextChanged ? 1 : 0);
      const settingsRevision = current.settingsRevision + (settingsChanged ? 1 : 0);
      const committed = { settings, history, trash, revision, settingsRevision };
      const returnValue = Object.hasOwn(mutation, 'result') ? mutation.result : committed;
      const preparedResult = clone(returnValue);
      const payload = clone({
        [STORAGE_KEYS.settings]: settings,
        [STORAGE_KEYS.settingsRevision]: settingsRevision,
        [STORAGE_KEYS.history[mode]]: history,
        [STORAGE_KEYS.trash[mode]]: trash,
        [STORAGE_KEYS.revision[mode]]: revision,
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
      throw new StorageWriteError(`updateSettingsAndContext(${mode})`, maxAttempts, lastWriteError);
    }

    function updateSettingsAndContext(mode, mutator) {
      const activeMode = assertMode(mode);
      const run = queues[activeMode].then(() => performSettingsAndContextUpdate(activeMode, mutator));
      queues[activeMode] = run.catch(() => undefined);
      return run;
    }

    return {
      getSettings,
      readContext,
      readHistory,
      readTrash,
      saveSettings,
      updateContext,
      updateSettingsAndContext,
    };
  }

  return {
    STORAGE_KEYS,
    SettingsValidationError,
    StorageWriteError,
    createUnavailableStorageRepository,
    createStorageRepository,
  };
});
