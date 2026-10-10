(function initIndexedDbRepository(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.TabEchoIndexedDbRepository = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  const DATABASE_NAME = 'tab-echo-records';
  const DATABASE_VERSION = 3;
  const STORE_NAMES = Object.freeze({ history: 'history', trash: 'trash' });
  const METADATA_STORE_NAME = 'metadata';
  const INDEX_NAMES = Object.freeze({
    modeGeneration: 'mode-generation',
    modeGenerationClosedAt: 'mode-generation-closed-at',
    modeGenerationDeletedAt: 'mode-generation-deleted-at',
    hostname: 'hostname',
    domain: 'domain',
    groupId: 'group-id',
    eventId: 'event-id',
  });

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function assertMode(mode) {
    if (mode !== 'normal' && mode !== 'incognito') {
      throw new TypeError('mode must be normal or incognito.');
    }
    return mode;
  }

  function assertStoreName(storeName) {
    if (storeName !== STORE_NAMES.history && storeName !== STORE_NAMES.trash) {
      throw new TypeError('storeName must be history or trash.');
    }
    return storeName;
  }

  function normalizeGeneration(generation) {
    const value = String(generation || '').trim();
    if (!value) throw new TypeError('generation must be a non-empty string.');
    return value;
  }

  function hostnamesForEvent(event) {
    const values = new Set();
    for (const tab of Array.isArray(event && event.tabs) ? event.tabs : []) {
      try {
        const parsed = new URL(String(tab && tab.url || ''));
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const hostname = parsed.hostname.toLowerCase();
        if (hostname) values.add(hostname);
      } catch (_) { /* Invalid URLs remain searchable through their original record fields. */ }
    }
    return Array.from(values).sort();
  }

  function recordStorageKey(mode, generation, ordinal) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new TypeError('ordinal must be a non-negative integer.');
    }
    return [assertMode(mode), normalizeGeneration(generation), ordinal];
  }

  function toStoredRecord(storeName, mode, generation, event, ordinal = 0) {
    assertStoreName(storeName);
    const activeMode = assertMode(mode);
    const activeGeneration = normalizeGeneration(generation);
    if (!event || typeof event !== 'object' || event.id === null || event.id === undefined) {
      throw new TypeError('event must have an id.');
    }
    const hostnames = hostnamesForEvent(event);
    return {
      storageKey: recordStorageKey(activeMode, activeGeneration, ordinal),
      mode: activeMode,
      generation: activeGeneration,
      ordinal,
      eventId: String(event.id),
      closedAt: Number(event.closedAt) || 0,
      deletedAt: storeName === STORE_NAMES.trash ? Number(event.deletedAt) || 0 : 0,
      hostnames,
      domains: hostnames,
      groupId: event.kind === 'group' ? String(event.id) : '',
      event: clone({ ...event, mode: activeMode }),
    };
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    });
  }

  async function readGenerationPageFromIndex(index, range, options = {}) {
    const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
    const direction = options.direction === 'next' ? 'next' : 'prev';
    const count = Number(await requestResult(index.count(range))) || 0;
    const records = [];
    if (offset >= count) return { records, total: count };
    const request = index.openCursor(range, direction);
    let seen = 0;
    await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || records.length >= limit) { resolve(); return; }
        if (seen >= offset) records.push(clone(cursor.value));
        seen += 1;
        if (records.length >= limit) { resolve(); return; }
        cursor.continue();
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed.'));
    });
    return { records, total: count };
  }

  async function scanGenerationPageFromIndex(index, range, options = {}, transform = (value) => value) {
    const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
    const direction = options.direction === 'next' ? 'next' : 'prev';
    const records = [];
    const statistics = {
      totalRecords: 0, totalTabs: 0, matchingRecords: 0, matchingTabs: 0, resultTabs: 0,
    };
    const request = index.openCursor(range, direction);
    await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        try {
          const event = clone(cursor.value && cursor.value.event);
          const tabCount = Array.isArray(event && event.tabs) ? event.tabs.length : 0;
          statistics.totalRecords += 1;
          statistics.totalTabs += tabCount;
          const mapped = transform(event);
          if (mapped !== null && mapped !== undefined) {
            const matchIndex = statistics.matchingRecords;
            statistics.matchingRecords += 1;
            statistics.matchingTabs += Number(mapped.matchedTabCount) || 0;
            statistics.resultTabs += Number(mapped.totalTabCount) || tabCount;
            if (matchIndex >= offset && records.length < limit) records.push(clone(mapped));
          }
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed.'));
    });
    return { records, statistics };
  }

  function createIndexes(store, storeName) {
    const ensureIndex = (name, keyPath, options) => {
      if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
    };
    ensureIndex(INDEX_NAMES.modeGeneration, ['mode', 'generation'], { unique: false });
    ensureIndex(INDEX_NAMES.modeGenerationClosedAt,
      ['mode', 'generation', 'closedAt'], { unique: false });
    if (storeName === STORE_NAMES.trash) {
      ensureIndex(INDEX_NAMES.modeGenerationDeletedAt,
        ['mode', 'generation', 'deletedAt'], { unique: false });
    }
    ensureIndex(INDEX_NAMES.hostname, 'hostnames', { unique: false, multiEntry: true });
    ensureIndex(INDEX_NAMES.domain, 'domains', { unique: false, multiEntry: true });
    ensureIndex(INDEX_NAMES.groupId, 'groupId', { unique: false });
    ensureIndex(INDEX_NAMES.eventId, 'eventId', { unique: false });
  }

  function openDatabase(indexedDbFactory, name = DATABASE_NAME) {
    if (!indexedDbFactory || typeof indexedDbFactory.open !== 'function') {
      return Promise.reject(new Error('IndexedDB is unavailable.'));
    }
    const request = indexedDbFactory.open(name, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of Object.values(STORE_NAMES)) {
        const store = database.objectStoreNames.contains(storeName)
          ? request.transaction.objectStore(storeName)
          : database.createObjectStore(storeName, { keyPath: 'storageKey' });
        createIndexes(store, storeName);
      }
      if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
        database.createObjectStore(METADATA_STORE_NAME, { keyPath: 'storageKey' });
      }
    };
    return requestResult(request);
  }

  function createIndexedDbRecordStore(options = {}) {
    const indexedDbFactory = options.indexedDB
      || (typeof globalThis === 'object' ? globalThis.indexedDB : undefined);
    const keyRange = options.IDBKeyRange
      || (typeof globalThis === 'object' ? globalThis.IDBKeyRange : undefined);
    const databaseName = options.databaseName || DATABASE_NAME;
    let databasePromise;

    function database() {
      if (!databasePromise) databasePromise = openDatabase(indexedDbFactory, databaseName);
      return databasePromise;
    }

    function generationRange(mode, generation) {
      if (!keyRange || typeof keyRange.only !== 'function') {
        throw new Error('IDBKeyRange is unavailable.');
      }
      return keyRange.only([assertMode(mode), normalizeGeneration(generation)]);
    }

    function generationTimeRange(mode, generation) {
      if (!keyRange || typeof keyRange.bound !== 'function') {
        throw new Error('IDBKeyRange is unavailable.');
      }
      const prefix = [assertMode(mode), normalizeGeneration(generation)];
      return keyRange.bound([...prefix, Number.MIN_SAFE_INTEGER], [...prefix, Number.MAX_SAFE_INTEGER]);
    }

    function metadataKey(mode, generation) {
      return [assertMode(mode), normalizeGeneration(generation)];
    }

    async function deleteStoreGeneration(store, mode, generation) {
      const request = store.index(INDEX_NAMES.modeGeneration)
        .openCursor(generationRange(mode, generation));
      await new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(); return; }
          cursor.delete();
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed.'));
      });
    }

    async function resetGeneration(mode, generation) {
      const db = await database();
      const transaction = db.transaction([...Object.values(STORE_NAMES), METADATA_STORE_NAME], 'readwrite');
      const done = transactionDone(transaction);
      await Promise.all(Object.values(STORE_NAMES).map((storeName) => deleteStoreGeneration(
        transaction.objectStore(storeName), mode, generation,
      )));
      transaction.objectStore(METADATA_STORE_NAME).delete(metadataKey(mode, generation));
      await done;
    }

    async function putBatch(storeName, mode, generation, events, startOrdinal = 0) {
      const activeStore = assertStoreName(storeName);
      const source = Array.isArray(events) ? events : [];
      if (source.length === 0) return 0;
      const db = await database();
      const transaction = db.transaction(activeStore, 'readwrite');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(activeStore);
      for (let index = 0; index < source.length; index += 1) {
        store.put(toStoredRecord(activeStore, mode, generation, source[index], startOrdinal + index));
      }
      await done;
      return source.length;
    }

    async function readGeneration(storeName, mode, generation) {
      const activeStore = assertStoreName(storeName);
      const db = await database();
      const transaction = db.transaction(activeStore, 'readonly');
      const done = transactionDone(transaction);
      const records = await requestResult(transaction.objectStore(activeStore)
        .index(INDEX_NAMES.modeGeneration).getAll(generationRange(mode, generation)));
      await done;
      return records.map((record) => clone(record.event));
    }

    async function readGenerationPage(storeName, mode, generation, options = {}) {
      const activeStore = assertStoreName(storeName);
      const db = await database();
      const transaction = db.transaction(activeStore, 'readonly');
      const done = transactionDone(transaction);
      const indexName = activeStore === STORE_NAMES.history
        ? INDEX_NAMES.modeGenerationClosedAt : INDEX_NAMES.modeGenerationDeletedAt;
      const page = await readGenerationPageFromIndex(
        transaction.objectStore(activeStore).index(indexName),
        generationTimeRange(mode, generation),
        options,
      );
      await done;
      return { records: page.records.map((record) => clone(record.event)), total: page.total };
    }

    async function scanGenerationPage(storeName, mode, generation, options = {}, transform) {
      const activeStore = assertStoreName(storeName);
      const db = await database();
      const transaction = db.transaction(activeStore, 'readonly');
      const done = transactionDone(transaction);
      const indexName = activeStore === STORE_NAMES.history
        ? INDEX_NAMES.modeGenerationClosedAt : INDEX_NAMES.modeGenerationDeletedAt;
      try {
        const page = await scanGenerationPageFromIndex(
          transaction.objectStore(activeStore).index(indexName),
          generationTimeRange(mode, generation), options, transform,
        );
        await done;
        return page;
      } catch (error) {
        try { transaction.abort(); } catch (_) { /* The transaction may already be inactive. */ }
        try { await done; } catch (_) { /* Preserve the transform or cursor error. */ }
        throw error;
      }
    }

    async function readGenerationRevision(mode, generation) {
      const db = await database();
      const transaction = db.transaction(METADATA_STORE_NAME, 'readonly');
      const done = transactionDone(transaction);
      const metadata = await requestResult(transaction.objectStore(METADATA_STORE_NAME)
        .get(metadataKey(mode, generation)));
      await done;
      const revision = Number(metadata && metadata.revision);
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
    }

    async function setGenerationRevision(mode, generation, revision) {
      const normalized = Number(revision);
      if (!Number.isSafeInteger(normalized) || normalized < 0) throw new TypeError('revision must be a non-negative integer.');
      const db = await database();
      const transaction = db.transaction(METADATA_STORE_NAME, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(METADATA_STORE_NAME).put({
        storageKey: metadataKey(mode, generation), mode, generation, revision: normalized,
      });
      await done;
      return normalized;
    }

    async function scanGenerationForChanges(store, mode, generation, deleteIds) {
      const ids = new Set((Array.isArray(deleteIds) ? deleteIds : []).map(String));
      const ordinals = new Map();
      let maxOrdinal = -1;
      const request = store.index(INDEX_NAMES.modeGeneration).openCursor(generationRange(mode, generation));
      await new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(); return; }
          const record = cursor.value || {};
          const ordinal = Number(record.ordinal);
          if (Number.isSafeInteger(ordinal)) maxOrdinal = Math.max(maxOrdinal, ordinal);
          if (ids.has(String(record.eventId))) {
            ordinals.set(String(record.eventId), Number.isSafeInteger(ordinal) ? ordinal : ++maxOrdinal);
            cursor.delete();
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB cursor failed.'));
      });
      return { maxOrdinal, ordinals };
    }

    async function applyGenerationChanges(mode, generation, changes, expectedRevision, nextRevision) {
      const activeMode = assertMode(mode);
      const activeGeneration = normalizeGeneration(generation);
      const expected = Number(expectedRevision);
      const next = Number(nextRevision);
      if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isSafeInteger(next) || next < 0) {
        throw new TypeError('revisions must be non-negative integers.');
      }
      const db = await database();
      const transaction = db.transaction([...Object.values(STORE_NAMES), METADATA_STORE_NAME], 'readwrite');
      const done = transactionDone(transaction);
      const metadataStore = transaction.objectStore(METADATA_STORE_NAME);
      const currentMetadata = await requestResult(metadataStore.get(metadataKey(activeMode, activeGeneration)));
      const currentRevision = currentMetadata && Number.isSafeInteger(Number(currentMetadata.revision))
        ? Number(currentMetadata.revision) : expected;
      if (currentRevision !== expected) {
        transaction.abort();
        try { await done; } catch (_) { /* Report the stable conflict below. */ }
        const error = new Error('IndexedDB generation revision changed.');
        error.code = 'REVISION_CONFLICT';
        throw error;
      }
      for (const storeName of Object.values(STORE_NAMES)) {
        const store = transaction.objectStore(storeName);
        const input = changes && changes[storeName] ? changes[storeName] : {};
        const put = Array.isArray(input.put) ? input.put : [];
        const idsToReplace = put.map((event) => String(event && event.id));
        const scan = await scanGenerationForChanges(
          store, activeMode, activeGeneration,
          [...(Array.isArray(input.deleteIds) ? input.deleteIds : []), ...idsToReplace],
        );
        let nextOrdinal = scan.maxOrdinal;
        for (const event of put) {
          const eventId = String(event.id);
          const ordinal = scan.ordinals.has(eventId) ? scan.ordinals.get(eventId) : ++nextOrdinal;
          store.put(toStoredRecord(storeName, activeMode, activeGeneration, event, ordinal));
        }
      }
      metadataStore.put({
        storageKey: metadataKey(activeMode, activeGeneration),
        mode: activeMode, generation: activeGeneration, revision: next,
      });
      await done;
      return { revision: next };
    }

    async function countGeneration(storeName, mode, generation) {
      const activeStore = assertStoreName(storeName);
      const db = await database();
      const transaction = db.transaction(activeStore, 'readonly');
      const done = transactionDone(transaction);
      const count = await requestResult(transaction.objectStore(activeStore)
        .index(INDEX_NAMES.modeGeneration).count(generationRange(mode, generation)));
      await done;
      return Number(count) || 0;
    }

    async function getRecordsByOrdinals(storeName, mode, generation, ordinals) {
      const activeStore = assertStoreName(storeName);
      const sourceOrdinals = Array.isArray(ordinals) ? ordinals : [];
      if (sourceOrdinals.length === 0) return [];
      const db = await database();
      const transaction = db.transaction(activeStore, 'readonly');
      const done = transactionDone(transaction);
      const store = transaction.objectStore(activeStore);
      const records = await Promise.all(sourceOrdinals.map((ordinal) => requestResult(
        store.get(recordStorageKey(mode, generation, ordinal)),
      )));
      await done;
      return records.filter(Boolean).map((record) => clone(record.event));
    }

    async function deleteGeneration(mode, generation) {
      return resetGeneration(mode, generation);
    }

    async function close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = null;
    }

    return {
      close,
      countGeneration,
      deleteGeneration,
      getRecordsByOrdinals,
      applyGenerationChanges,
      putBatch,
      readGeneration,
      readGenerationPage,
      readGenerationRevision,
      resetGeneration,
      scanGenerationPage,
      setGenerationRevision,
    };
  }

  return {
    DATABASE_NAME,
    DATABASE_VERSION,
    INDEX_NAMES,
    METADATA_STORE_NAME,
    STORE_NAMES,
    createIndexedDbRecordStore,
    hostnamesForEvent,
    readGenerationPageFromIndex,
    scanGenerationPageFromIndex,
    recordStorageKey,
    toStoredRecord,
  };
});
