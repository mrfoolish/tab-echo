const assert = require('node:assert/strict');
const test = require('node:test');

const {
  STORAGE_KEYS,
  createStorageRepository,
} = require('../lib/storage-repository.js');

const NOW = Date.parse('2026-09-18T12:00:00Z');
const NOTICE_ID = 'migration-notice-test-id';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createStorageFake(initial = {}) {
  const data = clone(initial);
  const calls = { get: [], set: [], remove: [] };
  let setFailures = 0;
  let removeFailures = 0;
  const partialSets = [];

  return {
    calls,
    data,
    failNextSets(count) {
      setFailures += count;
    },
    failNextRemoves(count) { removeFailures += count; },
    partiallyApplyNextMatchingSet(matchKey, droppedKeys, throws = true) {
      partialSets.push({ matchKey, droppedKeys: new Set(droppedKeys), throws });
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
      const partialIndex = partialSets.findIndex(({ matchKey }) => Object.hasOwn(items, matchKey));
      if (partialIndex >= 0) {
        const [{ droppedKeys, throws }] = partialSets.splice(partialIndex, 1);
        for (const [key, value] of Object.entries(clone(items))) {
          if (!droppedKeys.has(key)) data[key] = value;
        }
        if (throws) throw new Error('injected partial set failure');
        return;
      }
      Object.assign(data, clone(items));
    },
    async remove(keys) {
      calls.remove.push(clone(keys));
      if (removeFailures > 0) { removeFailures -= 1; throw new Error('injected remove failure'); }
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
    migration: 'tabEcho:migration:v2',
    migrationNotice: 'tabEcho:migration-notice:v2',
    legacy: 'tabEchoState',
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
  const repository = createStorageRepository(storage, { now: () => NOW, createNoticeId: () => NOTICE_ID });

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

test('migrates legacy defaults, partitions valid events, skips damage, verifies, marks, then removes legacy', async () => {
  const storage = createStorageFake({
    [STORAGE_KEYS.legacy]: {
      settings: { maxRecords: 65536, maxAgeDays: 30, pageSize: 100, language: 'zh', theme: 'dark' },
      events: {
        normal: [makeEvent('normal'), { id: 'broken', tabs: [] }],
        incognito: [makeEvent('private', 'incognito')],
      },
    },
  });
  const repository = createStorageRepository(storage, { now: () => NOW, createNoticeId: () => NOTICE_ID });

  const result = await repository.migrateLegacyState();

  assert.deepEqual(result, { migrated: true, skippedEvents: 1 });
  assert.deepEqual(storage.data[STORAGE_KEYS.settings], {
    maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3,
    popupSize: 10, pageSize: 100, language: 'zh', theme: 'dark', excludedDomains: [], settingsVersion: 2,
  });
  assert.deepEqual(storage.data[STORAGE_KEYS.history.normal].map((item) => item.id), ['normal']);
  assert.deepEqual(storage.data[STORAGE_KEYS.history.incognito].map((item) => item.id), ['private']);
  assert.deepEqual(storage.data[STORAGE_KEYS.trash.normal], []);
  assert.deepEqual(storage.data[STORAGE_KEYS.trash.incognito], []);
  assert.deepEqual(storage.data[STORAGE_KEYS.migration], {
    version: 2, skippedEvents: 1, completedAt: NOW, noticeRequired: true, noticeId: NOTICE_ID,
  });
  assert.deepEqual(storage.data[STORAGE_KEYS.migrationNotice], {
    id: NOTICE_ID, version: 2, skippedEvents: 1, createdAt: NOW,
  });
  assert.deepEqual(await repository.getMigrationNotice(), {
    id: NOTICE_ID, version: 2, skippedEvents: 1, createdAt: NOW,
  });
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
  assert.equal(storage.calls.remove.length, 1);
});

test('migration commits its marker and one-time notice in the same durable write', async () => {
  const storage = createStorageFake({
    [STORAGE_KEYS.legacy]: { settings: {}, events: { normal: [{ id: 'broken', tabs: [] }] } },
  });
  const repository = createStorageRepository(storage, { now: () => NOW, createNoticeId: () => NOTICE_ID });

  await repository.migrateLegacyState();

  const commit = storage.calls.set.find((items) => Object.hasOwn(items, STORAGE_KEYS.migration));
  assert.deepEqual(commit, {
    [STORAGE_KEYS.migration]: { version: 2, skippedEvents: 1, completedAt: NOW, noticeRequired: true, noticeId: NOTICE_ID },
    [STORAGE_KEYS.migrationNotice]: { id: NOTICE_ID, version: 2, skippedEvents: 1, createdAt: NOW },
  });
});

test('a new repository repairs marker-only partial set before deleting legacy', async () => {
  const legacy = { settings: {}, events: { normal: [makeEvent('legacy')] } };
  const storage = createStorageFake({ [STORAGE_KEYS.legacy]: legacy });
  storage.partiallyApplyNextMatchingSet(STORAGE_KEYS.migration, [STORAGE_KEYS.migrationNotice]);
  const first = createStorageRepository(storage, { now: () => NOW, retryLimit: 0, createNoticeId: () => NOTICE_ID });

  await assert.rejects(first.migrateLegacyState(), /Migration marker write failed/);
  assert.equal(storage.data[STORAGE_KEYS.migration].noticeId, NOTICE_ID);
  assert.equal(storage.data[STORAGE_KEYS.migrationNotice], undefined);
  assert.deepEqual(storage.data[STORAGE_KEYS.legacy], legacy);

  const restarted = createStorageRepository(storage, { retryLimit: 0, createNoticeId: () => 'unused' });
  await restarted.migrateLegacyState();
  assert.equal(storage.data[STORAGE_KEYS.migrationNotice].id, NOTICE_ID);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
});

test('migration notice is shared, acknowledged only by its matching token, and then stays consumed', async () => {
  const notice = { id: NOTICE_ID, version: 2, skippedEvents: 4, createdAt: NOW };
  const marker = { version: 2, skippedEvents: 4, completedAt: NOW, noticeRequired: true, noticeId: NOTICE_ID };
  const storage = createStorageFake({ [STORAGE_KEYS.migration]: marker, [STORAGE_KEYS.migrationNotice]: notice });
  const repository = createStorageRepository(storage);

  assert.deepEqual(await repository.getMigrationNotice(), notice);
  assert.equal(await repository.acknowledgeMigrationNotice('stale-id'), false);
  assert.deepEqual(await repository.getMigrationNotice(), notice);
  assert.equal(await repository.acknowledgeMigrationNotice(NOTICE_ID), true);
  assert.deepEqual(storage.data[STORAGE_KEYS.migration], { ...marker, noticeAcknowledged: true });
  assert.equal(await repository.getMigrationNotice(), null);
  assert.equal(await repository.acknowledgeMigrationNotice(NOTICE_ID), false);
});

test('upgrades a pre-notice v2 marker, delivers its count once, and never recreates after acknowledgement', async () => {
  const oldMarker = { version: 2, skippedEvents: 7, completedAt: NOW };
  const storage = createStorageFake({ [STORAGE_KEYS.migration]: oldMarker });
  const firstRepository = createStorageRepository(storage, { createNoticeId: () => NOTICE_ID });

  assert.deepEqual(await firstRepository.migrateLegacyState(), { migrated: false, skippedEvents: 7 });
  assert.deepEqual(storage.data[STORAGE_KEYS.migration], {
    ...oldMarker, noticeRequired: true, noticeId: NOTICE_ID, noticeAcknowledged: false,
  });
  assert.deepEqual(await firstRepository.getMigrationNotice(), {
    id: NOTICE_ID, version: 2, skippedEvents: 7, createdAt: NOW,
  });
  assert.equal(await firstRepository.acknowledgeMigrationNotice(NOTICE_ID), true);

  const restartedRepository = createStorageRepository(storage, { createNoticeId: () => 'must-not-be-used' });
  assert.deepEqual(await restartedRepository.migrateLegacyState(), { migrated: false, skippedEvents: 7 });
  assert.equal(await restartedRepository.getMigrationNotice(), null);
  assert.equal(storage.data[STORAGE_KEYS.migration].noticeId, NOTICE_ID);
});

test('concurrent split workers accept the winning pre-notice marker upgrade', async () => {
  const oldMarker = { version: 2, skippedEvents: 7, completedAt: NOW };
  const base = createStorageFake({ [STORAGE_KEYS.migration]: oldMarker });
  let initialReads = 0;
  let releaseInitialReads;
  const initialReadsReady = new Promise((resolve) => { releaseInitialReads = resolve; });
  let upgradeWrites = 0;
  let releaseUpgradeWrites;
  const upgradeWritesReady = new Promise((resolve) => { releaseUpgradeWrites = resolve; });
  const storage = {
    ...base,
    async get(keys) {
      const isInitialRead = Array.isArray(keys) && keys.includes(STORAGE_KEYS.legacy);
      if (!isInitialRead) return base.get(keys);
      const snapshot = await base.get(keys);
      initialReads += 1;
      if (initialReads === 2) releaseInitialReads();
      await initialReadsReady;
      return snapshot;
    },
    async set(items) {
      await base.set(items);
      if (!Object.hasOwn(items, STORAGE_KEYS.migrationNotice)) return;
      upgradeWrites += 1;
      if (upgradeWrites === 2) releaseUpgradeWrites();
      await upgradeWritesReady;
    },
  };
  const regular = createStorageRepository(storage, { createNoticeId: () => 'regular-notice' });
  const incognito = createStorageRepository(storage, { createNoticeId: () => 'incognito-notice' });

  const results = await Promise.all([
    regular.migrateLegacyState(),
    incognito.migrateLegacyState(),
  ]);

  assert.deepEqual(results, [
    { migrated: false, skippedEvents: 7 },
    { migrated: false, skippedEvents: 7 },
  ]);
  const marker = storage.data[STORAGE_KEYS.migration];
  const notice = storage.data[STORAGE_KEYS.migrationNotice];
  assert.equal(marker.noticeRequired, true);
  assert.equal(marker.noticeAcknowledged, false);
  assert.equal(notice.id, marker.noticeId);
  assert.equal(notice.skippedEvents, marker.skippedEvents);
  assert.equal(notice.createdAt, marker.completedAt);
});

test('acknowledgement marker failure keeps the notice, while remove failure leaves a stale notice that is not redisplayed', async () => {
  const marker = { version: 2, skippedEvents: 1, completedAt: NOW, noticeRequired: true, noticeId: NOTICE_ID };
  const notice = { id: NOTICE_ID, version: 2, skippedEvents: 1, createdAt: NOW };
  const storage = createStorageFake({ [STORAGE_KEYS.migration]: marker, [STORAGE_KEYS.migrationNotice]: notice });
  const repository = createStorageRepository(storage, { retryLimit: 0 });
  storage.failNextSets(1);
  await assert.rejects(repository.acknowledgeMigrationNotice(NOTICE_ID), /acknowledgement/i);
  assert.deepEqual(storage.data[STORAGE_KEYS.migrationNotice], notice);

  storage.failNextRemoves(1);
  await assert.rejects(repository.acknowledgeMigrationNotice(NOTICE_ID), /remove failure/);
  assert.equal(storage.data[STORAGE_KEYS.migration].noticeAcknowledged, true);
  assert.deepEqual(storage.data[STORAGE_KEYS.migrationNotice], notice);
  assert.equal(await repository.getMigrationNotice(), null);
  assert.equal(storage.data[STORAGE_KEYS.migrationNotice], undefined);
});

for (const [label, createNoticeId] of [
  ['null', () => null], ['undefined', () => undefined], ['empty', () => ''], ['blank', () => '   '],
  ['throwing', () => { throw new Error('id source unavailable'); }],
]) {
  test(`invalid ${label} notice ids abort migration without marker or notice writes`, async () => {
    const legacy = { settings: {}, events: {} };
    const storage = createStorageFake({ [STORAGE_KEYS.legacy]: legacy });
    const repository = createStorageRepository(storage, { createNoticeId });
    await assert.rejects(repository.migrateLegacyState(), /notice id|id source unavailable/i);
    assert.deepEqual(storage.data[STORAGE_KEYS.legacy], legacy);
    assert.equal(storage.data[STORAGE_KEYS.migration], undefined);
    assert.equal(storage.data[STORAGE_KEYS.migrationNotice], undefined);
  });
}

for (const [label, legacy, markerExtra] of [
  ['valid', { settings: {}, events: { normal: [makeEvent('already-copied')] } }, {}],
  ['corrupt', 'damaged', { corruptLegacy: true }],
]) {
  test(`repairs a partially committed ${label} migration notice before removing legacy`, async () => {
    const marker = { version: 2, skippedEvents: label === 'valid' ? 2 : 0, completedAt: NOW,
      noticeRequired: true, noticeId: NOTICE_ID, ...markerExtra };
    const storage = createStorageFake({ [STORAGE_KEYS.migration]: marker, [STORAGE_KEYS.legacy]: legacy });
    const repository = createStorageRepository(storage, { retryLimit: 0 });

    assert.deepEqual(await repository.migrateLegacyState(), {
      migrated: false, skippedEvents: marker.skippedEvents, ...(marker.corruptLegacy ? { corruptLegacy: true } : {}),
    });
    assert.deepEqual(storage.data[STORAGE_KEYS.migrationNotice], {
      id: NOTICE_ID, version: 2, skippedEvents: marker.skippedEvents, createdAt: NOW,
    });
    assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
  });
}

test('keeps residual legacy data when a partial migration notice cannot be repaired', async () => {
  const marker = { version: 2, skippedEvents: 2, completedAt: NOW, noticeRequired: true, noticeId: NOTICE_ID };
  const legacy = { settings: {}, events: {} };
  const storage = createStorageFake({ [STORAGE_KEYS.migration]: marker, [STORAGE_KEYS.legacy]: legacy });
  storage.failNextSets(1);

  await assert.rejects(createStorageRepository(storage, { retryLimit: 0 }).migrateLegacyState(), /notice repair/i);

  assert.deepEqual(storage.data[STORAGE_KEYS.legacy], legacy);
  assert.equal(storage.data[STORAGE_KEYS.migrationNotice], undefined);
});

test('repairs a migration notice whose id does not match the committed marker', async () => {
  const marker = { version: 2, skippedEvents: 3, completedAt: NOW, noticeRequired: true, noticeId: NOTICE_ID };
  const storage = createStorageFake({
    [STORAGE_KEYS.migration]: marker,
    [STORAGE_KEYS.migrationNotice]: { id: 'wrong-id', version: 2, skippedEvents: 3, createdAt: NOW },
    [STORAGE_KEYS.legacy]: { settings: {}, events: {} },
  });

  await createStorageRepository(storage).migrateLegacyState();

  assert.deepEqual(storage.data[STORAGE_KEYS.migrationNotice], {
    id: NOTICE_ID, version: 2, skippedEvents: 3, createdAt: NOW,
  });
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
});

test('no legacy does not migrate while a pre-notice marker is upgraded', async () => {
  const emptyStorage = createStorageFake();
  const markedStorage = createStorageFake({
    [STORAGE_KEYS.migration]: { version: 2, skippedEvents: 3, completedAt: NOW },
  });

  await createStorageRepository(emptyStorage).migrateLegacyState();
  await createStorageRepository(markedStorage).migrateLegacyState();

  assert.equal(emptyStorage.data[STORAGE_KEYS.migrationNotice], undefined);
  assert.equal(markedStorage.data[STORAGE_KEYS.migrationNotice].skippedEvents, 3);
});

test('preserves legacy custom retention settings and legal nulls', async () => {
  const storage = createStorageFake({
    [STORAGE_KEYS.legacy]: {
      settings: { maxRecords: 123, maxAgeDays: null, pageSize: 50, language: 'en', theme: 'system' },
      events: {},
    },
  });
  await createStorageRepository(storage, { now: () => NOW }).migrateLegacyState();
  assert.equal(storage.data[STORAGE_KEYS.settings].maxRecords, 123);
  assert.equal(storage.data[STORAGE_KEYS.settings].maxAgeDays, null);
});

test('migrates each old default independently while preserving the other custom retention field', async () => {
  const storage = createStorageFake({
    [STORAGE_KEYS.legacy]: {
      settings: { maxRecords: 123, maxAgeDays: 30, pageSize: 50, language: 'en', theme: 'system' },
      events: {},
    },
  });

  await createStorageRepository(storage, { now: () => NOW }).migrateLegacyState();

  assert.equal(storage.data[STORAGE_KEYS.settings].maxRecords, 123);
  assert.equal(storage.data[STORAGE_KEYS.settings].maxAgeDays, null);
});

test('migration keeps existing new partitions, fills only missing keys, and then marks complete', async () => {
  const existing = [makeEvent('newer')];
  const storage = createStorageFake({
    [STORAGE_KEYS.legacy]: {
      settings: { maxRecords: 65536, maxAgeDays: 30 },
      events: { normal: [makeEvent('legacy')], incognito: [makeEvent('private', 'incognito')] },
    },
    [STORAGE_KEYS.history.normal]: existing,
    [STORAGE_KEYS.trash.incognito]: [{ ...makeEvent('existing-trash', 'incognito'), deletedAt: NOW }],
  });

  await createStorageRepository(storage, { now: () => NOW }).migrateLegacyState();

  assert.deepEqual(storage.data[STORAGE_KEYS.history.normal], existing);
  assert.deepEqual(storage.data[STORAGE_KEYS.history.incognito].map((item) => item.id), ['private']);
  assert.deepEqual(storage.data[STORAGE_KEYS.trash.incognito].map((item) => item.id), ['existing-trash']);
  assert.ok(storage.data[STORAGE_KEYS.migration]);
});

test('failed migration retains legacy state and can be retried without overwriting completed new keys', async () => {
  const legacy = { settings: { maxRecords: 65536, maxAgeDays: 30 }, events: { normal: [makeEvent('legacy')] } };
  const storage = createStorageFake({ [STORAGE_KEYS.legacy]: legacy });
  storage.failNextSets(1);
  const repository = createStorageRepository(storage, { now: () => NOW, retryLimit: 0 });

  await assert.rejects(repository.migrateLegacyState(), /Migration write failed/);
  assert.deepEqual(storage.data[STORAGE_KEYS.legacy], legacy);
  assert.equal(storage.data[STORAGE_KEYS.migration], undefined);

  storage.data[STORAGE_KEYS.history.normal] = [makeEvent('recovered-elsewhere')];
  assert.deepEqual(await repository.migrateLegacyState(), { migrated: true, skippedEvents: 0 });
  assert.deepEqual(storage.data[STORAGE_KEYS.history.normal].map((item) => item.id), ['recovered-elsewhere']);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
});

test('marker write interruption leaves legacy intact and retries from verified new keys', async () => {
  const legacy = { settings: { maxRecords: 65536, maxAgeDays: 30 }, events: { normal: [makeEvent('legacy')] } };
  const storage = createStorageFake({ [STORAGE_KEYS.legacy]: legacy });
  const originalSet = storage.set.bind(storage);
  storage.set = async (items) => {
    if (Object.hasOwn(items, STORAGE_KEYS.migration)) {
      throw new Error('marker interrupted');
    }
    return originalSet(items);
  };
  const repository = createStorageRepository(storage, { now: () => NOW, retryLimit: 0 });

  await assert.rejects(repository.migrateLegacyState(), /Migration marker write failed/);
  assert.deepEqual(storage.data[STORAGE_KEYS.legacy], legacy);
  assert.deepEqual(storage.data[STORAGE_KEYS.history.normal].map((item) => item.id), ['legacy']);

  storage.set = originalSet;
  assert.deepEqual(await repository.migrateLegacyState(), { migrated: true, skippedEvents: 0 });
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
});

test('migration marker prevents repeated migration and safely cleans up a leftover legacy key', async () => {
  const storage = createStorageFake({
    [STORAGE_KEYS.migration]: { version: 2, skippedEvents: 0, completedAt: NOW, noticeRequired: true,
      noticeId: NOTICE_ID, noticeAcknowledged: true },
    [STORAGE_KEYS.legacy]: { settings: {}, events: { normal: [makeEvent('must-not-copy')] } },
    [STORAGE_KEYS.history.normal]: [makeEvent('current')],
  });

  const result = await createStorageRepository(storage).migrateLegacyState();

  assert.deepEqual(result, { migrated: false, skippedEvents: 0 });
  assert.deepEqual(storage.data[STORAGE_KEYS.history.normal].map((item) => item.id), ['current']);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
  assert.equal(storage.calls.set.length, 0);
});

for (const [label, corruptLegacy] of [
  ['null', null],
  ['string', 'damaged'],
  ['array', []],
]) {
  test(`marks corrupt ${label} legacy state complete before deleting it`, async () => {
    const storage = createStorageFake({ [STORAGE_KEYS.legacy]: corruptLegacy });
    const repository = createStorageRepository(storage, { now: () => NOW, retryLimit: 0, createNoticeId: () => NOTICE_ID });

    assert.deepEqual(await repository.migrateLegacyState(), {
      migrated: true, skippedEvents: 0, corruptLegacy: true,
    });
    assert.deepEqual(storage.data[STORAGE_KEYS.migration], {
      version: 2, skippedEvents: 0, corruptLegacy: true, completedAt: NOW,
      noticeRequired: true, noticeId: NOTICE_ID,
    });
    assert.deepEqual(storage.data[STORAGE_KEYS.migrationNotice], {
      id: NOTICE_ID, version: 2, skippedEvents: 0, createdAt: NOW,
    });
    assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
    assert.equal(storage.calls.remove.length, 1);
  });
}

test('keeps corrupt legacy data when marker write fails and completes on retry', async () => {
  const storage = createStorageFake({ [STORAGE_KEYS.legacy]: 'damaged' });
  storage.failNextSets(1);
  const repository = createStorageRepository(storage, { now: () => NOW, retryLimit: 0 });

  await assert.rejects(repository.migrateLegacyState(), /Migration marker write failed/);
  assert.equal(storage.data[STORAGE_KEYS.legacy], 'damaged');
  assert.equal(storage.data[STORAGE_KEYS.migration], undefined);

  assert.equal((await repository.migrateLegacyState()).corruptLegacy, true);
  assert.equal(Object.hasOwn(storage.data, STORAGE_KEYS.legacy), false);
});
