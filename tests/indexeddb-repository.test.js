const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DATABASE_NAME,
  DATABASE_VERSION,
  INDEX_NAMES,
  STORE_NAMES,
  createIndexedDbRecordStore,
  hostnamesForEvent,
  openDatabase,
  readGenerationPageFromIndex,
  recordStorageKey,
  scanGenerationFromIndex,
  scanGenerationPageFromIndex,
  toStoredRecord,
} = require('../extension/lib/indexeddb-repository.js');

function revisionDatabase(revision) {
  let closed = 0;
  const database = {
    get closed() { return closed; },
    close() { closed += 1; },
    transaction() {
      const transaction = {
        objectStore() {
          return {
            get() {
              const request = {};
              queueMicrotask(() => { request.result = { revision }; request.onsuccess(); });
              return request;
            },
          };
        },
      };
      queueMicrotask(() => transaction.oncomplete());
      return transaction;
    },
  };
  return database;
}

function openFactory(outcomes) {
  let calls = 0;
  return {
    get calls() { return calls; },
    open() {
      const request = {};
      const outcome = outcomes[calls++];
      queueMicrotask(() => {
        if (outcome instanceof Error) {
          request.error = outcome;
          request.onerror();
        } else if (outcome === 'blocked') {
          if (request.onblocked) request.onblocked();
        } else {
          request.result = outcome;
          request.onsuccess();
        }
      });
      return request;
    },
  };
}

test('IndexedDB schema names are stable and versioned', () => {
  assert.equal(DATABASE_NAME, 'tab-echo-records');
  assert.equal(DATABASE_VERSION, 3);
  assert.deepEqual(STORE_NAMES, { history: 'history', trash: 'trash' });
  assert.deepEqual(Object.values(INDEX_NAMES), [
    'mode-generation',
    'mode-generation-closed-at',
    'mode-generation-deleted-at',
    'hostname',
    'domain',
    'group-id',
    'event-id',
  ]);
});

test('stored records use a collision-safe context, generation, and event key', () => {
  const left = recordStorageKey('normal', 'gen:1', 12);
  const right = recordStorageKey('normal', 'gen:12', 1);
  assert.notDeepEqual(left, right);
  assert.deepEqual(left, ['normal', 'gen:1', 12]);
  assert.throws(() => recordStorageKey('other', 'gen', 0), /mode/);
  assert.throws(() => recordStorageKey('normal', '', 0), /generation/);
  assert.throws(() => recordStorageKey('normal', 'gen', -1), /ordinal/);
});

test('record metadata keeps exact lower-case hostnames without mutating events', () => {
  const event = {
    id: 'group-1', kind: 'group', mode: 'normal', closedAt: 123,
    tabs: [
      { id: 'a', title: 'A', url: 'https://WWW.Example.com/a' },
      { id: 'b', title: 'B', url: 'https://sub.example.com/b' },
      { id: 'c', title: 'C', url: 'chrome://settings' },
    ],
  };
  const before = structuredClone(event);
  assert.deepEqual(hostnamesForEvent(event), ['sub.example.com', 'www.example.com']);

  const stored = toStoredRecord('trash', 'normal', 'generation-1', { ...event, deletedAt: 456 }, 7);
  assert.deepEqual(stored.storageKey, ['normal', 'generation-1', 7]);
  assert.equal(stored.eventId, 'group-1');
  assert.equal(stored.ordinal, 7);
  assert.equal(stored.groupId, 'group-1');
  assert.equal(stored.closedAt, 123);
  assert.equal(stored.deletedAt, 456);
  assert.deepEqual(stored.hostnames, ['sub.example.com', 'www.example.com']);
  assert.deepEqual(stored.domains, stored.hostnames);
  assert.deepEqual(event, before);
});

test('record store fails explicitly when IndexedDB is unavailable', async () => {
  const store = createIndexedDbRecordStore({ indexedDB: null });
  await assert.rejects(store.readGeneration('history', 'normal', 'generation-1'), /unavailable/);
});

test('a blocked database upgrade rejects with a retryable stable error', async () => {
  const factory = openFactory(['blocked']);
  const opened = openDatabase(factory, 'blocked-database');
  const bounded = Promise.race([
    opened,
    new Promise((_, reject) => queueMicrotask(() => reject(new Error('blocked open did not reject')))),
  ]);

  await assert.rejects(bounded, (error) => error && error.code === 'IDB_OPEN_BLOCKED');
});

test('record store retries a transient database open failure in the same worker', async () => {
  const database = revisionDatabase(7);
  const factory = openFactory([new Error('transient open failure'), database]);
  const store = createIndexedDbRecordStore({
    indexedDB: factory,
    IDBKeyRange: { only(value) { return value; }, bound(left, right) { return [left, right]; } },
  });

  await assert.rejects(store.readGenerationRevision('normal', 'generation-1'), /transient open failure/);
  assert.equal(await store.readGenerationRevision('normal', 'generation-1'), 7);
  assert.equal(factory.calls, 2);
});

test('version changes close the stale connection and reopen on the next operation', async () => {
  const first = revisionDatabase(1);
  const second = revisionDatabase(2);
  const factory = openFactory([first, second]);
  const store = createIndexedDbRecordStore({
    indexedDB: factory,
    IDBKeyRange: { only(value) { return value; }, bound(left, right) { return [left, right]; } },
  });

  assert.equal(await store.readGenerationRevision('normal', 'generation-1'), 1);
  assert.equal(typeof first.onversionchange, 'function');
  first.onversionchange();
  assert.equal(first.closed, 1);
  assert.equal(await store.readGenerationRevision('normal', 'generation-1'), 2);
  assert.equal(factory.calls, 2);
});

test('generation pages use a descending cursor without loading the full collection', async () => {
  const source = [
    { event: { id: 'newest' } },
    { event: { id: 'middle' } },
    { event: { id: 'oldest' } },
  ];
  const index = {
    getAll() { throw new Error('getAll must not be used for a page'); },
    count() {
      const request = {};
      queueMicrotask(() => { request.result = source.length; request.onsuccess(); });
      return request;
    },
    openCursor(_range, direction) {
      assert.equal(direction, 'prev');
      const request = {};
      let position = -1;
      const dispatch = () => {
        position += 1;
        request.result = position < source.length ? {
          value: source[position],
          continue() { queueMicrotask(dispatch); },
        } : null;
        request.onsuccess();
      };
      queueMicrotask(dispatch);
      return request;
    },
  };

  const page = await readGenerationPageFromIndex(index, 'only-this-generation', {
    offset: 1, limit: 1,
  });

  assert.equal(page.total, 3);
  assert.deepEqual(page.records.map((record) => record.event.id), ['middle']);
});

test('generation scans keep only the requested matching page while counting the full scope', async () => {
  const source = [
    { event: { id: 'three', tabs: [{ id: '3' }] } },
    { event: { id: 'two', tabs: [{ id: '2a' }, { id: '2b' }] } },
    { event: { id: 'one', tabs: [{ id: '1' }] } },
  ];
  const index = {
    openCursor() {
      const request = {}; let position = -1;
      const dispatch = () => {
        position += 1;
        request.result = position < source.length ? {
          value: source[position], continue() { queueMicrotask(dispatch); },
        } : null;
        request.onsuccess();
      };
      queueMicrotask(dispatch);
      return request;
    },
  };

  const page = await scanGenerationPageFromIndex(index, 'range', { offset: 1, limit: 1 }, (event) => (
    event.id === 'two' ? null : { event, matchedTabCount: 1, totalTabCount: event.tabs.length }
  ));

  assert.deepEqual(page.records.map((item) => item.event.id), ['one']);
  assert.deepEqual(page.statistics, {
    totalRecords: 3, totalTabs: 4, matchingRecords: 2, matchingTabs: 2, resultTabs: 2,
  });
});

test('generation visitor scans records once in descending time order', async () => {
  const source = [
    { event: { id: 'newest' } },
    { event: { id: 'middle' } },
    { event: { id: 'oldest' } },
  ];
  let cursorCount = 0;
  const index = {
    openCursor(_range, direction) {
      assert.equal(direction, 'prev');
      const request = {}; let position = -1;
      const dispatch = () => {
        position += 1;
        request.result = position < source.length ? {
          value: source[position], continue() { queueMicrotask(dispatch); },
        } : null;
        if (request.result) cursorCount += 1;
        request.onsuccess();
      };
      queueMicrotask(dispatch);
      return request;
    },
  };
  const visited = [];

  await scanGenerationFromIndex(index, 'range', (event) => visited.push(event.id));

  assert.deepEqual(visited, ['newest', 'middle', 'oldest']);
  assert.equal(cursorCount, 3);
});
