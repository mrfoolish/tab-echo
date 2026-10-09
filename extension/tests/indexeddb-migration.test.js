const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYS,
  createIndexedDbMigration,
  createYieldControl,
} = require('../lib/indexeddb-migration.js');

function event(id, mode = 'normal', extra = {}) {
  return {
    id, batchId: id, mode, kind: 'single', closedAt: 100,
    sourceWindowId: 1,
    tabs: [{ id: `${id}-tab`, title: id, url: `https://${id}.example/` }],
    ...extra,
  };
}

function memoryStorage(initial = {}, controls = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(values, key)) result[key] = structuredClone(values[key]);
      }
      return result;
    },
    async set(items) {
      if (controls.failSet && controls.failSet(items)) throw new Error('set failed');
      Object.assign(values, structuredClone(items));
    },
    async remove(keys) {
      if (controls.failRemove) throw new Error('remove failed');
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

function memoryRecordStore(controls = {}) {
  const values = { history: new Map(), trash: new Map() };
  const key = (mode, generation) => `${mode}:${generation}`;
  return {
    values,
    async resetGeneration(mode, generation) {
      values.history.set(key(mode, generation), []);
      values.trash.set(key(mode, generation), []);
    },
    async putBatch(storeName, mode, generation, records) {
      if (controls.failPut && controls.failPut(storeName, records)) throw new Error('put failed');
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
  };
}

test('migrates one context, verifies it, switches authority, then removes only its arrays', async () => {
  const storage = memoryStorage({
    [KEYS.history.normal]: [event('one'), event('two')],
    [KEYS.trash.normal]: [event('deleted', 'normal', { deletedAt: 200 })],
    [KEYS.history.incognito]: [event('secret', 'incognito')],
    [KEYS.revision.normal]: 7,
  });
  const records = memoryRecordStore();
  const migration = createIndexedDbMigration({ storageArea: storage, recordStore: records, now: () => 999 });

  const result = await migration.migrateMode('normal');

  assert.deepEqual(result, {
    migrated: true,
    generation: 'v1-normal-7-2-1',
    skippedRecords: 0,
    cleanupPending: false,
  });
  assert.equal(storage.values[KEYS.history.normal], undefined);
  assert.equal(storage.values[KEYS.trash.normal], undefined);
  assert.equal(storage.values[KEYS.history.incognito][0].id, 'secret');
  assert.equal(storage.values[KEYS.generation.normal], result.generation);
  assert.deepEqual(storage.values[KEYS.marker.normal], {
    version: 1, status: 'complete', mode: 'normal', generation: result.generation,
    historyCount: 2, trashCount: 1, skippedRecords: 0, completedAt: 999,
  });
});

test('failed staging leaves arrays authoritative and a retry replaces the incomplete generation', async () => {
  let fail = true;
  const storage = memoryStorage({
    [KEYS.history.normal]: [event('one'), event('two')],
    [KEYS.trash.normal]: [],
    [KEYS.revision.normal]: 3,
  });
  const records = memoryRecordStore({ failPut(storeName) {
    if (fail && storeName === 'history') { fail = false; return true; }
    return false;
  } });
  const migration = createIndexedDbMigration({ storageArea: storage, recordStore: records, batchSize: 1 });

  await assert.rejects(migration.migrateMode('normal'), /put failed/);
  assert.equal(storage.values[KEYS.history.normal].length, 2);
  assert.equal(storage.values[KEYS.marker.normal], undefined);
  assert.equal(storage.values[KEYS.generation.normal], undefined);

  const retried = await migration.migrateMode('normal');
  assert.equal(retried.migrated, true);
  assert.equal(await records.countGeneration('history', 'normal', retried.generation), 2);
});

test('migration preserves duplicate event ids as separate ordered records', async () => {
  const storage = memoryStorage({
    [KEYS.history.normal]: [event('duplicate', 'normal', { closedAt: 100 }),
      event('duplicate', 'normal', { closedAt: 200 })],
    [KEYS.trash.normal]: [],
  });
  const records = memoryRecordStore();
  const migration = createIndexedDbMigration({ storageArea: storage, recordStore: records });

  const result = await migration.migrateMode('normal');
  const migrated = records.values.history.get(`normal:${result.generation}`);

  assert.equal(migrated.length, 2);
  assert.deepEqual(migrated.map((item) => item.closedAt), [100, 200]);
});

test('completed migration retries only interrupted legacy cleanup', async () => {
  let failRemove = true;
  const storage = memoryStorage({
    [KEYS.history.normal]: [event('one')],
    [KEYS.trash.normal]: [],
  }, { get failRemove() { return failRemove; } });
  storage.remove = async (keys) => {
    if (failRemove) throw new Error('remove failed');
    for (const key of keys) delete storage.values[key];
  };
  const records = memoryRecordStore();
  const migration = createIndexedDbMigration({ storageArea: storage, recordStore: records });

  const first = await migration.migrateMode('normal');
  assert.equal(first.cleanupPending, true);
  assert.equal(storage.values[KEYS.history.normal].length, 1);

  failRemove = false;
  const second = await migration.migrateMode('normal');
  assert.equal(second.migrated, false);
  assert.equal(second.cleanupPending, false);
  assert.equal(storage.values[KEYS.history.normal], undefined);
});

test('completed migration keeps a newer active generation after normal repository updates', async () => {
  const storage = memoryStorage({
    [KEYS.marker.normal]: {
      version: 1, status: 'complete', mode: 'normal', generation: 'initial-generation',
      historyCount: 2, trashCount: 1, skippedRecords: 0, completedAt: 100,
    },
    [KEYS.generation.normal]: 'updated-generation',
    [KEYS.revision.normal]: 9,
  });
  const records = memoryRecordStore();
  const migration = createIndexedDbMigration({ storageArea: storage, recordStore: records });

  const result = await migration.migrateMode('normal');

  assert.equal(result.migrated, false);
  assert.equal(result.generation, 'updated-generation');
  assert.equal(storage.values[KEYS.generation.normal], 'updated-generation');
  assert.equal(records.values.history.size, 0);
  assert.equal(records.values.trash.size, 0);
});

test('migration yields between slow batches and the fallback uses a zero-delay timer', async () => {
  const storage = memoryStorage({
    [KEYS.history.normal]: [event('one'), event('two'), event('three')],
    [KEYS.trash.normal]: [],
  });
  const records = memoryRecordStore();
  let clock = 0;
  let yields = 0;
  const migration = createIndexedDbMigration({
    storageArea: storage,
    recordStore: records,
    batchSize: 1,
    performanceNow: () => { clock += 60; return clock; },
    yieldControl: async () => { yields += 1; },
  });
  await migration.migrateMode('normal');
  assert.equal(yields, 2);

  const delays = [];
  const fallback = createYieldControl({ setTimeout(callback, delay) { delays.push(delay); callback(); } });
  await fallback();
  assert.deepEqual(delays, [0]);

  let schedulerYields = 0;
  const native = createYieldControl({
    scheduler: { async yield() { schedulerYields += 1; } },
    setTimeout() { throw new Error('fallback should not run'); },
  });
  await native();
  assert.equal(schedulerYields, 1);
});
