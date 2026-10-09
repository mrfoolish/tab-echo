const test = require('node:test');
const assert = require('node:assert/strict');

const { createIndexedDbStorageRepository } = require('../lib/indexeddb-storage-repository.js');
const { KEYS } = require('../lib/indexeddb-migration.js');
const { STORAGE_KEYS } = require('../lib/storage-repository.js');

function event(id, extra = {}) {
  return {
    id, batchId: id, mode: 'normal', kind: 'single', closedAt: 100,
    sourceWindowId: 1,
    tabs: [{ id: `${id}-tab`, title: id, url: `https://${id}.example/` }],
    ...extra,
  };
}

function memoryStorage(initial = {}) {
  const values = structuredClone(initial);
  let failMetadata = false;
  return {
    values,
    set failMetadata(value) { failMetadata = value; },
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(values);
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
      }
      return result;
    },
    async set(items) {
      if (failMetadata && Object.hasOwn(items, KEYS.generation.normal)) throw new Error('metadata failed');
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function memoryRecordStore() {
  const values = { history: new Map(), trash: new Map() };
  const key = (mode, generation) => `${mode}:${generation}`;
  return {
    values,
    async resetGeneration(mode, generation) {
      values.history.set(key(mode, generation), []);
      values.trash.set(key(mode, generation), []);
    },
    async putBatch(storeName, mode, generation, records) {
      const bucket = values[storeName].get(key(mode, generation)) || [];
      bucket.push(...structuredClone(records));
      values[storeName].set(key(mode, generation), bucket);
    },
    async countGeneration(storeName, mode, generation) {
      return (values[storeName].get(key(mode, generation)) || []).length;
    },
    async getRecordsByOrdinals(storeName, mode, generation, ordinals) {
      const bucket = values[storeName].get(key(mode, generation)) || [];
      return structuredClone(ordinals.map((ordinal) => bucket[ordinal]).filter(Boolean));
    },
    async readGeneration(storeName, mode, generation) {
      return structuredClone(values[storeName].get(key(mode, generation)) || []);
    },
    async deleteGeneration(mode, generation) {
      values.history.delete(key(mode, generation));
      values.trash.delete(key(mode, generation));
    },
  };
}

test('migrated repository reads IndexedDB generations after removing local arrays', async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.history.normal]: [event('one')],
    [STORAGE_KEYS.trash.normal]: [event('deleted', { deletedAt: 200 })],
    [STORAGE_KEYS.revision.normal]: 4,
  });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { now: () => 500 });

  const migration = await repository.migrateLegacyState('normal');
  const context = await repository.readContext('normal');

  assert.equal(migration.indexedDb.migrated, true);
  assert.deepEqual(context.history.map((item) => item.id), ['one']);
  assert.deepEqual(context.trash.map((item) => item.id), ['deleted']);
  assert.equal(context.revision, 4);
  assert.equal(storage.values[STORAGE_KEYS.history.normal], undefined);
});

test('updates stage a new generation before atomically switching metadata', async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.history.normal]: [event('one')] });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { now: () => 500 });
  await repository.migrateLegacyState('normal');
  const previousGeneration = storage.values[KEYS.generation.normal];

  const result = await repository.updateContext('normal', (context) => ({
    history: context.history.concat(event('two')),
    trash: context.trash,
    result: { added: 1 },
  }));

  assert.deepEqual(result, { added: 1 });
  assert.notEqual(storage.values[KEYS.generation.normal], previousGeneration);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['one', 'two']);
  assert.equal(records.values.history.has(`normal:${previousGeneration}`), false);
});

test('failed metadata switch leaves the previous generation authoritative', async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.history.normal]: [event('one')] });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { retryLimit: 0 });
  await repository.migrateLegacyState('normal');
  const previousGeneration = storage.values[KEYS.generation.normal];
  storage.failMetadata = true;

  await assert.rejects(repository.updateContext('normal', (context) => ({
    history: context.history.concat(event('two')), trash: context.trash,
  })), (error) => error.name === 'StorageWriteError');

  assert.equal(storage.values[KEYS.generation.normal], previousGeneration);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['one']);
});

test('settings and cleaned records become visible through one metadata write', async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.history.normal]: [event('one'), event('two')],
  });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { now: () => 700 });
  await repository.migrateLegacyState('normal');

  await repository.updateSettingsAndContext('normal', (context) => ({
    settings: { ...context.settings, maxRecords: 1 },
    history: context.history.slice(1),
    trash: context.trash,
  }));

  const context = await repository.readContext('normal');
  assert.equal(context.settings.maxRecords, 1);
  assert.deepEqual(context.history.map((item) => item.id), ['two']);
  assert.equal(context.revision, 1);
  assert.equal(context.settingsRevision, 1);
});
