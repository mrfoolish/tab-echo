const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INDEXEDDB_KEYS: KEYS,
  createIndexedDbStorageRepository,
} = require('../extension/lib/indexeddb-storage-repository.js');
const { STORAGE_KEYS } = require('../extension/lib/storage-repository.js');

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
  let scanCount = 0;
  return {
    values, mutations, revisions,
    get scanCount() { return scanCount; },
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
    async scanGeneration(storeName, mode, generation, visit) {
      scanCount += 1;
      const bucket = structuredClone(values[storeName].get(key(mode, generation)) || [])
        .sort(storeName === 'history'
          ? (left, right) => right.closedAt - left.closedAt
          : (left, right) => right.deletedAt - left.deletedAt);
      for (const item of bucket) visit(item);
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
      if (failMutation) throw failMutation instanceof Error ? failMutation : new Error('mutation failed');
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

test('regular records ignore local arrays when no IndexedDB generation exists', async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.history.normal]: [event('legacy-history')],
    [STORAGE_KEYS.trash.normal]: [event('legacy-trash', { deletedAt: 200 })],
  });
  const repository = createIndexedDbStorageRepository(storage, memoryRecordStore(), {
    indexedModes: ['normal'],
  });

  const context = await repository.readContext('normal');

  assert.deepEqual(context.history, []);
  assert.deepEqual(context.trash, []);
});

test('the first regular write creates an IndexedDB generation directly', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, {
    indexedModes: ['normal'], now: () => 500,
  });

  await repository.updateContext('normal', (context) => ({
    history: [event('first')],
    trash: context.trash,
  }));

  assert.equal(typeof storage.values[KEYS.generation.normal], 'string');
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['first']);
});

test('keeps incognito collections in durable local storage', async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.history.incognito]: [event('secret', { mode: 'incognito' })],
    [STORAGE_KEYS.revision.incognito]: 4,
  });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, {
    indexedModes: ['normal'],
  });

  await repository.updateContext('incognito', (context) => ({
    history: context.history.concat(event('later', { mode: 'incognito' })),
    trash: context.trash,
  }));

  assert.deepEqual((await repository.readHistory('incognito')).map((item) => item.id), ['secret', 'later']);
  assert.deepEqual(storage.values[STORAGE_KEYS.history.incognito].map((item) => item.id), ['secret', 'later']);
  assert.equal(storage.values[KEYS.generation.incognito], undefined);
  assert.equal(records.mutations.length, 0);
});

test('ordinary updates mutate the active generation without rewriting unchanged collections', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { now: () => 500 });
  await repository.updateContext('normal', (context) => ({
    history: [event('one')], trash: context.trash,
  }));
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
  assert.equal(records.mutations[0].expectedRevision, 1);
  assert.equal(records.mutations[0].nextRevision, 2);
  assert.equal(storage.values[STORAGE_KEYS.revision.normal], 1);
});

test('failed incremental transaction leaves the previous generation authoritative', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { retryLimit: 0 });
  await repository.updateContext('normal', (context) => ({
    history: [event('one')], trash: context.trash,
  }));
  const previousGeneration = storage.values[KEYS.generation.normal];
  records.failMutation = true;

  await assert.rejects(repository.updateContext('normal', (context) => ({
    history: context.history.concat(event('two')), trash: context.trash,
  })), /mutation failed/);

  assert.equal(storage.values[KEYS.generation.normal], previousGeneration);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['one']);
});

test('wraps native IndexedDB mutation failures with stable storage error details', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records);
  await repository.updateContext('normal', (context) => ({
    history: [event('one')], trash: context.trash,
  }));
  const quotaError = new Error('origin quota exhausted');
  quotaError.name = 'QuotaExceededError';
  records.failMutation = quotaError;

  await assert.rejects(
    repository.updateContext('normal', (context) => ({
      history: context.history.concat(event('two')), trash: context.trash,
    })),
    (error) => error
      && error.name === 'StorageWriteError'
      && error.code === 'STORAGE_WRITE_FAILED'
      && error.operation === 'indexedDB.updateContext(normal)'
      && error.causeName === 'QuotaExceededError'
      && error.retryable === false,
  );
});

test('settings and cleaned records become visible through one metadata write', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { now: () => 700 });
  await repository.updateContext('normal', (context) => ({
    history: [event('one'), event('two')], trash: context.trash,
  }));

  await repository.updateSettingsAndContext('normal', (context) => ({
    settings: { ...context.settings, maxRecords: 1 },
    history: context.history.slice(1),
    trash: context.trash,
  }));

  const context = await repository.readContext('normal');
  assert.equal(context.settings.maxRecords, 1);
  assert.deepEqual(context.history.map((item) => item.id), ['two']);
  assert.equal(context.revision, 2);
  assert.equal(context.settingsRevision, 1);
});

test('retries a context read when the active generation changes before the read completes', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, { now: () => 700 });
  await repository.updateContext('normal', (context) => ({
    history: [event('old')], trash: context.trash,
  }));
  const oldGeneration = storage.values[KEYS.generation.normal];
  const newGeneration = 'replacement-generation';
  await records.resetGeneration('normal', newGeneration);
  await records.putBatch('history', 'normal', newGeneration, [event('new')]);
  await records.setGenerationRevision('normal', newGeneration, 2);
  const originalRead = records.readGeneration.bind(records);
  let switched = false;
  records.readGeneration = async (storeName, mode, generation) => {
    const result = await originalRead(storeName, mode, generation);
    if (!switched && generation === oldGeneration) {
      switched = true;
      storage.values[KEYS.generation.normal] = newGeneration;
      storage.values[STORAGE_KEYS.revision.normal] = 2;
      await records.deleteGeneration('normal', oldGeneration);
    }
    return result;
  };

  const context = await repository.readContext('normal');

  assert.equal(switched, true);
  assert.equal(context.revision, 2);
  assert.deepEqual(context.history.map((item) => item.id), ['new']);
});

test('retries a paged query when an incremental revision changes during its cursor scan', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records);
  await repository.updateContext('normal', (context) => ({
    history: [event('old')], trash: context.trash,
  }));
  const generation = storage.values[KEYS.generation.normal];
  const originalScan = records.scanGenerationPage.bind(records);
  let switched = false;
  records.scanGenerationPage = async (...args) => {
    const result = await originalScan(...args);
    if (!switched) {
      switched = true;
      const bucket = records.values.history.get(`normal:${generation}`);
      bucket.push(event('new', { closedAt: 200 }));
      records.revisions.set(`normal:${generation}`, 2);
    }
    return result;
  };

  const page = await repository.queryCollection('history', 'normal', '', { offset: 0, limit: 10 });

  assert.equal(switched, true);
  assert.equal(page.revision, 2);
  assert.deepEqual(page.results.map((item) => item.event.id), ['new', 'old']);
  assert.equal(page.statistics.totalRecords, 2);
});

test('indexed queries scan statistics but retain only the requested result page', async () => {
  const storage = memoryStorage();
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records);
  await repository.updateContext('normal', (context) => ({
    history: [
      event('old', { closedAt: 1 }), event('middle', { closedAt: 2 }), event('new', { closedAt: 3 }),
    ],
    trash: context.trash,
  }));

  const page = await repository.queryCollection('history', 'normal', '', { offset: 1, limit: 1 });

  assert.deepEqual(page.results.map((item) => item.event.id), ['middle']);
  assert.equal(page.statistics.totalRecords, 3);
  assert.equal(page.statistics.matchingRecords, 3);
  assert.equal(page.statistics.totalTabs, 3);
});

test('domain query returns the index, selected page, and complete selected ids in one scan', async () => {
  const storage = memoryStorage();
  const initialHistory = [
      event('alpha-old', { closedAt: 1, tabs: [{ id: 'a1', title: 'old', url: 'https://alpha.example/old' }] }),
      event('beta', { closedAt: 2, tabs: [{ id: 'b1', title: 'beta', url: 'https://beta.example/' }] }),
      event('alpha-new', { closedAt: 3, tabs: [{ id: 'a2', title: 'new', url: 'https://alpha.example/new' }] }),
  ];
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records);
  await repository.updateContext('normal', (context) => ({
    history: initialHistory, trash: context.trash,
  }));

  const page = await repository.queryHistoryByDomain('normal', '', {
    domain: 'alpha.example', offset: 1, limit: 1,
  });

  assert.equal(records.scanCount, 1);
  assert.deepEqual(page.groups, [
    { key: 'alpha.example', domain: 'alpha.example', label: 'alpha.example', eventCount: 2, tabCount: 2 },
    { key: 'beta.example', domain: 'beta.example', label: 'beta.example', eventCount: 1, tabCount: 1 },
  ]);
  assert.equal(page.selectedDomain, 'alpha.example');
  assert.deepEqual(page.results.map((item) => item.event.id), ['alpha-old']);
  assert.deepEqual(page.eventIds, ['alpha-new', 'alpha-old']);
  assert.equal(page.statistics.matchingRecords, 3);
  assert.equal(page.statistics.selectedRecords, 2);
});

test('incognito domain queries stay on the durable legacy partition', async () => {
  const storage = memoryStorage({
    [STORAGE_KEYS.history.incognito]: [
      event('private', {
        mode: 'incognito',
        tabs: [{ id: 'private-tab', title: 'Private', url: 'https://private.example/' }],
      }),
    ],
    [STORAGE_KEYS.revision.incognito]: 6,
  });
  const records = memoryRecordStore();
  const repository = createIndexedDbStorageRepository(storage, records, {
    indexedModes: ['normal'],
  });

  const page = await repository.queryHistoryByDomain('incognito', '', { limit: 25 });

  assert.equal(records.scanCount, 0);
  assert.equal(page.revision, 6);
  assert.equal(page.selectedDomain, 'private.example');
  assert.deepEqual(page.results.map((item) => item.event.id), ['private']);
});
