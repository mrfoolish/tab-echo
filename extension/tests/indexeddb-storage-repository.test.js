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
  const mutations = [];
  const revisions = new Map();
  let failMutation = false;
  const key = (mode, generation) => `${mode}:${generation}`;
  return {
    values, mutations, revisions,
    set failMutation(value) { failMutation = value; },
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
    async scanGenerationPage(storeName, mode, generation, options, transform) {
      const bucket = structuredClone(values[storeName].get(key(mode, generation)) || [])
        .sort(storeName === 'history'
          ? (left, right) => right.closedAt - left.closedAt
          : (left, right) => right.deletedAt - left.deletedAt);
      const matches = bucket.map(transform).filter(Boolean);
      return {
        records: matches.slice(options.offset, options.offset + options.limit),
        statistics: {
          totalRecords: bucket.length,
          totalTabs: bucket.reduce((sum, item) => sum + item.tabs.length, 0),
          matchingRecords: matches.length,
          matchingTabs: matches.reduce((sum, item) => sum + item.matchedTabCount, 0),
          resultTabs: matches.reduce((sum, item) => sum + item.totalTabCount, 0),
        },
      };
    },
    async deleteGeneration(mode, generation) {
      values.history.delete(key(mode, generation));
      values.trash.delete(key(mode, generation));
      revisions.delete(key(mode, generation));
    },
    async readGenerationRevision(mode, generation) {
      return revisions.has(key(mode, generation)) ? revisions.get(key(mode, generation)) : null;
    },
    async setGenerationRevision(mode, generation, revision) {
      revisions.set(key(mode, generation), revision);
    },
    async applyGenerationChanges(mode, generation, changes, expectedRevision, nextRevision) {
      if (failMutation) throw new Error('mutation failed');
      mutations.push(structuredClone({ mode, generation, changes, expectedRevision, nextRevision }));
      for (const storeName of ['history', 'trash']) {
        const bucket = values[storeName].get(key(mode, generation)) || [];
        const deleted = new Set(changes[storeName].deleteIds.map(String));
        const retained = bucket.filter((item) => !deleted.has(String(item.id)));
        const replacements = new Map(changes[storeName].put.map((item) => [String(item.id), structuredClone(item)]));
        const updated = retained.map((item) => replacements.has(String(item.id))
          ? replacements.get(String(item.id)) : item);
        const present = new Set(updated.map((item) => String(item.id)));
        for (const item of replacements.values()) if (!present.has(String(item.id))) updated.push(item);
        values[storeName].set(key(mode, generation), updated);
      }
      revisions.set(key(mode, generation), nextRevision);
      return { revision: nextRevision };
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

test('ordinary updates mutate the active generation without rewriting unchanged collections', async () => {
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
  assert.equal(storage.values[KEYS.generation.normal], previousGeneration);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['one', 'two']);
  assert.equal(records.mutations.length, 1);
  assert.deepEqual(records.mutations[0].changes.history.deleteIds, []);
  assert.deepEqual(records.mutations[0].changes.history.put.map((item) => item.id), ['two']);
  assert.deepEqual(records.mutations[0].changes.trash, { deleteIds: [], put: [] });
  assert.equal(records.mutations[0].expectedRevision, 0);
  assert.equal(records.mutations[0].nextRevision, 1);
  assert.equal(storage.values[STORAGE_KEYS.revision.normal], undefined);
});

test('failed incremental transaction leaves the previous generation authoritative', async () => {
  const storage = memoryStorage({ [STORAGE_KEYS.history.normal]: [event('one')] });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { retryLimit: 0 });
  await repository.migrateLegacyState('normal');
  const previousGeneration = storage.values[KEYS.generation.normal];
  records.failMutation = true;

  await assert.rejects(repository.updateContext('normal', (context) => ({
    history: context.history.concat(event('two')), trash: context.trash,
  })), /mutation failed/);

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

test('indexed queries scan statistics but retain only the requested result page', async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.history.normal]: [
      event('old', { closedAt: 1 }), event('middle', { closedAt: 2 }), event('new', { closedAt: 3 }),
    ],
  });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records);
  await repository.migrateLegacyState('normal');

  const page = await repository.queryCollection('history', 'normal', '', { offset: 1, limit: 1 });

  assert.deepEqual(page.results.map((item) => item.event.id), ['middle']);
  assert.equal(page.statistics.totalRecords, 3);
  assert.equal(page.statistics.matchingRecords, 3);
  assert.equal(page.statistics.totalTabs, 3);
});
