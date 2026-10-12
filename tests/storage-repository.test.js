const assert = require('node:assert/strict');
const test = require('node:test');

const {
  STORAGE_KEYS,
  createStorageRepository,
} = require('../extension/lib/storage-repository.js');

const NOW = Date.parse('2026-09-18T12:00:00Z');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorageFake(initial = {}) {
  const data = clone(initial);
  const calls = { get: [], set: [], remove: [] };
  let setFailures = 0;

  return {
    calls,
    data,
    failNextSets(count) {
      setFailures += count;
    },
    async get(keys) {
      calls.get.push(clone(keys));
      if (keys === null || keys === undefined) {
        return clone(data);
      }
      const result = {};
      const requested = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      for (const key of requested) {
        if (Object.hasOwn(data, key)) {
          result[key] = clone(data[key]);
        } else if (keys && !Array.isArray(keys) && typeof keys === 'object') {
          result[key] = clone(keys[key]);
        }
      }
      return result;
    },
    async set(items) {
      calls.set.push(clone(items));
      if (setFailures > 0) {
        setFailures -= 1;
        throw new Error('injected set failure');
      }
      Object.assign(data, clone(items));
    },
    async remove(keys) {
      calls.remove.push(clone(keys));
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete data[key];
      }
    },
  };
}

function makeEvent(id, mode = 'normal', overrides = {}) {
  return {
    id,
    batchId: id,
    mode,
    kind: 'single',
    closedAt: NOW - 1000,
    tabs: [{ id: `${id}-tab`, title: id, url: `https://${id}.example`, position: 0 }],
    ...overrides,
  };
}

test('exports all partitioned v2 storage keys', () => {
  assert.deepEqual(STORAGE_KEYS, {
    settings: 'tabEcho:settings:v2',
    settingsRevision: 'tabEcho:settings-revision:v2',
    history: {
      normal: 'tabEcho:history:normal:v2',
      incognito: 'tabEcho:history:incognito:v2',
    },
    trash: {
      normal: 'tabEcho:trash:normal:v2',
      incognito: 'tabEcho:trash:incognito:v2',
    },
    revision: {
      normal: 'tabEcho:revision:normal:v2',
      incognito: 'tabEcho:revision:incognito:v2',
    },
  });
});

test('context and settings revisions start at zero and advance with durable writes', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage);

  assert.deepEqual(await repository.readContext('normal'), {
    settings: {
      maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3, popupSize: 10,
      pageSize: 50, language: 'en', theme: 'system', excludedDomains: [], settingsVersion: 2,
    },
    history: [], trash: [], revision: 0, settingsRevision: 0,
  });

  await repository.updateContext('normal', (context) => ({
    ...context, history: [makeEvent('one')], result: 'saved',
  }));
  assert.equal((await repository.readContext('normal')).revision, 1);
  assert.equal((await repository.readContext('incognito')).revision, 0);

  await repository.saveSettings({
    maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3, popupSize: 10,
    pageSize: 25, language: 'en', theme: 'system', excludedDomains: [], settingsVersion: 2,
  });
  const afterSettings = await repository.readContext('normal');
  assert.equal(afterSettings.settingsRevision, 1);
  assert.equal(afterSettings.revision, 1);
});

test('atomic settings and context updates validate revisions before one durable write', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage);

  const result = await repository.updateSettingsAndContext('normal', (context) => {
    assert.equal(context.revision, 0);
    assert.equal(context.settingsRevision, 0);
    return {
      ...context,
      settings: { ...context.settings, maxRecords: 25 },
      history: [makeEvent('kept')],
      result: { committed: true },
    };
  });

  assert.deepEqual(result, { committed: true });
  const committed = await repository.readContext('normal');
  assert.equal(committed.settings.maxRecords, 25);
  assert.deepEqual(committed.history.map((event) => event.id), ['kept']);
  assert.equal(committed.revision, 1);
  assert.equal(committed.settingsRevision, 1);
  const write = storage.calls.set.at(-1);
  assert.equal(write[STORAGE_KEYS.revision.normal], 1);
  assert.equal(write[STORAGE_KEYS.settingsRevision], 1);
  assert.ok(Object.hasOwn(write, STORAGE_KEYS.settings));
  assert.ok(Object.hasOwn(write, STORAGE_KEYS.history.normal));
  assert.ok(Object.hasOwn(write, STORAGE_KEYS.trash.normal));
});

test('failed revisioned writes leave persisted revisions unchanged', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage, { retryLimit: 0 });
  storage.failNextSets(1);

  await assert.rejects(repository.updateContext('normal', (context) => ({
    ...context, history: [makeEvent('not-saved')],
  })), /updateContext\(normal\) failed/);

  const current = await repository.readContext('normal');
  assert.equal(current.revision, 0);
  assert.deepEqual(current.history, []);
});

test('normal context updates never overwrite incognito partitions', async () => {
  const privateHistory = [makeEvent('private', 'incognito')];
  const privateTrash = [{ ...makeEvent('private-trash', 'incognito'), deletedAt: NOW }];
  const storage = createStorageFake({
    [STORAGE_KEYS.history.incognito]: privateHistory,
    [STORAGE_KEYS.trash.incognito]: privateTrash,
  });
  const repository = createStorageRepository(storage);

  await repository.updateContext('normal', ({ history, trash }) => ({
    history: history.concat(makeEvent('normal')),
    trash,
    result: 'saved',
  }));

  assert.deepEqual(storage.data[STORAGE_KEYS.history.incognito], privateHistory);
  assert.deepEqual(storage.data[STORAGE_KEYS.trash.incognito], privateTrash);
  assert.equal(storage.calls.set.at(-1)[STORAGE_KEYS.history.incognito], undefined);
  assert.equal(storage.calls.set.at(-1)[STORAGE_KEYS.trash.incognito], undefined);
});

test('reads settings and partitions as defensive copies and rejects invalid modes', async () => {
  const stored = makeEvent('stored');
  const storage = createStorageFake({ [STORAGE_KEYS.history.normal]: [stored] });
  const repository = createStorageRepository(storage, { now: () => NOW });

  const first = await repository.readHistory('normal');
  first[0].tabs[0].title = 'mutated';
  assert.equal((await repository.readHistory('normal'))[0].tabs[0].title, 'stored');
  assert.deepEqual(await repository.readTrash('incognito'), []);
  assert.equal((await repository.getSettings()).maxRecords, 10000);
  await assert.rejects(repository.readHistory('private'), /mode must be normal or incognito/);
  assert.throws(() => repository.updateContext('', () => ({})), /mode must be normal or incognito/);
});

test('skips damaged trash entries without shifting deletedAt onto the next valid event', async () => {
  const valid = { ...makeEvent('valid-trash'), deletedAt: NOW - 1000 };
  const storage = createStorageFake({
    [STORAGE_KEYS.trash.normal]: [{ id: 'broken', tabs: [], deletedAt: NOW - 9000 }, valid],
  });
  const repository = createStorageRepository(storage);

  const trash = await repository.readTrash('normal');

  assert.equal(trash.length, 1);
  assert.equal(trash[0].id, 'valid-trash');
  assert.equal(trash[0].deletedAt, NOW - 1000);
});

test('saveSettings validates fields, preserves legal nulls, and does not silently default invalid input', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage);
  const valid = {
    maxRecords: null, maxAgeDays: null, trashMaxAgeDays: null,
    pageSize: 25, language: 'zh', theme: 'dark',
  };

  assert.deepEqual(await repository.saveSettings(valid), { ...valid, popupSize: 10, excludedDomains: [], settingsVersion: 2 });
  assert.equal(storage.data[STORAGE_KEYS.settings].maxRecords, null);
  await assert.rejects(
    repository.saveSettings({ ...valid, pageSize: 12, maxRecords: 0 }),
    (error) => Boolean(error.name === 'SettingsValidationError'
      && error.errors.pageSize
      && error.errors.maxRecords),
  );
});

test('serializes updates per mode and refreshes settings/history/trash before every mutation', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage);
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const seen = [];

  const first = repository.updateContext('normal', async (context) => {
    seen.push(context.history.map((item) => item.id));
    await firstGate;
    return { ...context, history: context.history.concat(makeEvent('one')), result: 'first' };
  });
  const second = repository.updateContext('normal', (context) => {
    seen.push(context.history.map((item) => item.id));
    return { ...context, history: context.history.concat(makeEvent('two')), result: 'second' };
  });
  releaseFirst();

  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.deepEqual(seen, [[], ['one']]);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['one', 'two']);
});

test('allows different modes to update independently', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage);
  let normalStarted;
  const started = new Promise((resolve) => { normalStarted = resolve; });
  let unblockNormal;
  const blocked = new Promise((resolve) => { unblockNormal = resolve; });

  const normal = repository.updateContext('normal', async (context) => {
    normalStarted();
    await blocked;
    return { ...context, history: [makeEvent('normal')] };
  });
  await started;
  const incognito = repository.updateContext('incognito', (context) => ({
    ...context, history: [makeEvent('private', 'incognito')], result: 'private-finished',
  }));

  assert.equal(await incognito, 'private-finished');
  unblockNormal();
  await normal;
});

test('retryLimit 3 retries the same prepared payload without rerunning the mutator', async () => {
  const storage = createStorageFake();
  storage.failNextSets(3);
  const repository = createStorageRepository(storage, { retryLimit: 3 });
  let calls = 0;

  const result = await repository.updateContext('normal', (context) => {
    calls += 1;
    return { ...context, history: context.history.concat(makeEvent(`try-${calls}`)), result: calls };
  });

  assert.equal(result, 1);
  assert.equal(calls, 1);
  assert.equal(storage.calls.set.length, 4);
  assert.deepEqual(storage.calls.set, [
    storage.calls.set[0],
    storage.calls.set[0],
    storage.calls.set[0],
    storage.calls.set[0],
  ]);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['try-1']);
});

test('retryLimit 0 attempts one write, then throws without exposing an unpersisted snapshot', async () => {
  const storage = createStorageFake({ [STORAGE_KEYS.history.normal]: [makeEvent('original')] });
  storage.failNextSets(1);
  const repository = createStorageRepository(storage, { retryLimit: 0 });

  await assert.rejects(
    repository.updateContext('normal', (context) => ({ ...context, history: [makeEvent('phantom')] })),
    (error) => error.name === 'StorageWriteError'
      && error.operation === 'updateContext(normal)'
      && error.attempts === 1
      && /injected set failure/.test(error.message),
  );
  assert.equal(storage.calls.set.length, 1);
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['original']);
});

test('does not retry a mutator programming error', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage, { retryLimit: 3 });
  let calls = 0;

  await assert.rejects(repository.updateContext('normal', () => {
    calls += 1;
    throw new Error('mutator bug');
  }), /mutator bug/);

  assert.equal(calls, 1);
  assert.equal(storage.calls.set.length, 0);
});

test('validates result cloneability before writing and never retries after a successful set', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage, { retryLimit: 3 });
  let calls = 0;

  await assert.rejects(repository.updateContext('normal', (context) => {
    calls += 1;
    return { ...context, history: [makeEvent('must-not-commit')], result: () => {} };
  }), /clone/i);

  assert.equal(calls, 1);
  assert.equal(storage.calls.set.length, 0);
  assert.deepEqual(await repository.readHistory('normal'), []);
});

test('continues a same-mode queue after the preceding operation rejects', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage, { retryLimit: 0 });

  const failed = repository.updateContext('normal', () => {
    throw new Error('first failed');
  });
  const next = repository.updateContext('normal', (context) => ({
    ...context, history: [makeEvent('after-failure')], result: 'continued',
  }));

  await assert.rejects(failed, /first failed/);
  assert.equal(await next, 'continued');
  assert.deepEqual((await repository.readHistory('normal')).map((item) => item.id), ['after-failure']);
});

test('returns a defensive context snapshot when mutator omits result', async () => {
  const storage = createStorageFake();
  const repository = createStorageRepository(storage);
  const snapshot = await repository.updateContext('normal', (context) => ({
    ...context, history: [makeEvent('saved')], trash: [],
  }));

  assert.deepEqual(snapshot.history.map((item) => item.id), ['saved']);
  snapshot.history[0].tabs[0].title = 'leaked';
  assert.equal((await repository.readHistory('normal'))[0].tabs[0].title, 'saved');
});
