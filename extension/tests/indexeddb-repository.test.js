const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DATABASE_NAME,
  DATABASE_VERSION,
  INDEX_NAMES,
  STORE_NAMES,
  createIndexedDbRecordStore,
  hostnamesForEvent,
  recordStorageKey,
  toStoredRecord,
} = require('../lib/indexeddb-repository.js');

test('IndexedDB schema names are stable and versioned', () => {
  assert.equal(DATABASE_NAME, 'tab-echo-records');
  assert.equal(DATABASE_VERSION, 2);
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
