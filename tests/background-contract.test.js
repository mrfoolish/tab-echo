const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { indexedDbModuleStubs } = require('./test-helpers.js');

const extensionDir = path.join(__dirname, '../extension');

test('manifest grants the alarms permission', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('alarms'));
});

function memoryArea(initial = {}, controls = {}) {
  const values = structuredClone(initial);
  const writes = [];
  const getKeys = [];
  let reads = 0;
  return {
    ...(Number.isFinite(controls.quotaBytes) ? { QUOTA_BYTES: controls.quotaBytes } : {}),
    values, writes, get reads() { return reads; },
    ...(Number.isFinite(controls.bytesInUse) ? {
      async getBytesInUse(requestedKeys) {
        if (typeof requestedKeys === 'string') {
          return (controls.bytesInUse / 2) + requestedKeys.length + JSON.stringify([]).length;
        }
        return controls.bytesInUse;
      },
    } : {}),
    async get(keys) {
      reads += 1;
      getKeys.push(structuredClone(keys));
      if (keys === null || keys === undefined) return structuredClone(values);
      const selected = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.hasOwn(values, key)) selected[key] = structuredClone(values[key]);
      }
      return selected;
    },
    async set(items) {
      if (controls.failSet && controls.failSet(items)) throw new Error('forced storage failure');
      if (controls.beforeSet) await controls.beforeSet(items);
      Object.assign(values, structuredClone(items)); writes.push(structuredClone(items));
      if (controls.afterSet) await controls.afterSet(items);
    },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    getKeys,
  };
}

function chromeEvent() {
  const listeners = [];
  return { listeners, addListener(listener) { listeners.push(listener); } };
}

function entry(id, mode = 'normal', tabs = [{ id: `${id}-tab`, title: id, url: `https://${id}.example/` }], extra = {}) {
  return { id, batchId: id, mode, kind: tabs.length > 1 ? 'group' : 'single',
    closedAt: Date.now(), sourceWindowId: 1, childCount: tabs.length, tabs, ...extra };
}

const keys = {
  settings: 'tabEcho:settings:v2', normalHistory: 'tabEcho:history:normal:v2',
  incognitoHistory: 'tabEcho:history:incognito:v2', normalTrash: 'tabEcho:trash:normal:v2',
  incognitoTrash: 'tabEcho:trash:incognito:v2',
};

async function loadBackground({ incognito = false, indexedDbAvailable = true, localInitial = {}, localArea, sessionArea, tabs = [], awaitReady = true, queryGate, failCreateUrl, localControls = {}, storageEstimate } = {}) {
  const local = localArea || memoryArea(localInitial, localControls);
  const session = sessionArea || memoryArea();
  const createdAlarms = [];
  const openedTabs = [];
  const openedWindows = [];
  const events = {
    installed: chromeEvent(), startup: chromeEvent(), alarm: chromeEvent(), message: chromeEvent(),
    created: chromeEvent(), updated: chromeEvent(), moved: chromeEvent(), detached: chromeEvent(),
    attached: chromeEvent(), replaced: chromeEvent(), removed: chromeEvent(), windowRemoved: chromeEvent(),
  };
  const visibleTabs = tabs.map((tab) => ({ ...tab }));
  const chrome = {
    extension: { inIncognitoContext: incognito },
    storage: { local, session },
    alarms: {
      onAlarm: events.alarm, async get(name) { return createdAlarms.find((alarm) => alarm.name === name) || null; },
      async create(name, info) {
        const index = createdAlarms.findIndex((alarm) => alarm.name === name);
        const alarm = { name, ...info };
        if (index === -1) createdAlarms.push(alarm); else createdAlarms[index] = alarm;
      },
    },
    runtime: {
      onInstalled: events.installed, onStartup: events.startup, onMessage: events.message,
      getURL(relative) { return `chrome-extension://test/${relative}`; },
    },
    tabs: {
      onCreated: events.created, onUpdated: events.updated, onMoved: events.moved,
      onDetached: events.detached, onAttached: events.attached, onReplaced: events.replaced,
      onRemoved: events.removed,
      async query(filter = {}) {
        if (queryGate) await queryGate;
        return visibleTabs.filter((tab) => !filter.url || tab.url === filter.url).map((tab) => ({ ...tab }));
      },
      async create(details) {
        if (details.url === failCreateUrl) throw new Error('blocked by browser');
        const created = { id: 100 + openedTabs.length, incognito, ...details };
        openedTabs.push(created); visibleTabs.push(created); return created;
      },
    },
    windows: {
      onRemoved: events.windowRemoved, async getAll() {
        return [...new Set(visibleTabs.map((tab) => tab.windowId))].map((id) => ({ id }));
      },
      async create(details) { const created = { id: 90, incognito, ...details }; openedWindows.push(created); return created; },
    },
  };
  const context = {
    clearTimeout, setTimeout, structuredClone, URL, console: { error() {} }, chrome, importScripts() {},
    ...(storageEstimate ? { navigator: { storage: { estimate: storageEstimate } } } : {}),
    self: {
      ...(indexedDbAvailable ? {
        ...indexedDbModuleStubs(),
      } : {}),
      TabEchoHistoryStore: require('../extension/lib/history-store.js'),
      TabEchoDomainGroups: require('../extension/lib/domain-groups.js'),
      TabEchoStorageRepository: require('../extension/lib/storage-repository.js'),
      TabEchoCloseTracker: require('../extension/lib/close-tracker.js'),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8'), context, {
    filename: 'background.js',
  });
  async function message(payload) {
    return new Promise((resolve) => {
      const returned = events.message.listeners[0](payload, {}, resolve);
      assert.equal(returned, true);
    });
  }
  if (awaitReady) {
    const ready = await message({ type: 'get-current-mode' });
    assert.equal(ready.ok, true, JSON.stringify(ready));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { chrome, local, session, events, createdAlarms, openedTabs, openedWindows, message };
}

test('normal mode reports IndexedDB unavailable instead of reading legacy local arrays', async () => {
  const legacy = entry('legacy-local');
  const subject = await loadBackground({
    indexedDbAvailable: false,
    awaitReady: false,
    localInitial: { [keys.normalHistory]: [legacy] },
  });

  const result = await subject.message({ type: 'get-history' });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INDEXEDDB_UNAVAILABLE');
  assert.deepEqual(subject.local.values[keys.normalHistory], [legacy]);
});

test('incognito mode keeps using local storage when IndexedDB is unavailable', async () => {
  const subject = await loadBackground({ incognito: true, indexedDbAvailable: false });

  const result = await subject.message({ type: 'get-current-mode' });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'incognito');
});

test('initialization and lifecycle hooks ensure the fixed daily cleanup alarm', async () => {
  const subject = await loadBackground();
  await subject.events.installed.listeners[0]();
  await subject.events.startup.listeners[0]();
  assert.deepEqual(structuredClone(subject.createdAlarms), [{
    name: 'tab-echo-daily-cleanup', periodInMinutes: 1440,
  }]);
  assert.equal(subject.events.alarm.listeners.length, 1);
});

test('startup records locally mirrored window snapshots lost during a forced Chrome exit', async () => {
  const trackerKey = 'tabEcho:close-tracker:normal:v1';
  const tracker = require('../extension/lib/close-tracker.js').createCloseTracker({
    mode: 'normal', now: () => 1700000000000,
  });
  tracker.hydrate([
    { id: 1, windowId: 10, index: 0, incognito: false, title: 'One', url: 'https://one.example/' },
    { id: 2, windowId: 10, index: 1, incognito: false, title: 'Two', url: 'https://two.example/' },
  ]);

  const subject = await loadBackground({ localInitial: {
    [trackerKey]: { ...tracker.getState(), revision: 7 },
  } });

  assert.equal(subject.local.values[keys.normalHistory].length, 1);
  assert.equal(subject.local.values[keys.normalHistory][0].kind, 'group');
  assert.deepEqual(subject.local.values[keys.normalHistory][0].tabs.map((tab) => tab.url), [
    'https://one.example/', 'https://two.example/',
  ]);
});

test('browser restart archives old snapshots before hydrating a reused Chrome window id', async () => {
  const trackerKey = 'tabEcho:close-tracker:normal:v1';
  const tracker = require('../extension/lib/close-tracker.js').createCloseTracker({
    mode: 'normal', now: () => 1700000000000,
  });
  tracker.hydrate([
    { id: 1, windowId: 10, index: 0, incognito: false, title: 'Before exit', url: 'https://before.example/' },
  ]);

  const subject = await loadBackground({
    localInitial: { [trackerKey]: { ...tracker.getState(), revision: 7 } },
    tabs: [{ id: 2, windowId: 10, index: 0, incognito: false, title: 'After restart', url: 'https://after.example/' }],
  });

  assert.deepEqual(subject.local.values[keys.normalHistory][0].tabs.map((tab) => tab.url), [
    'https://before.example/',
  ]);
  assert.deepEqual(subject.local.values[trackerKey].windowSnapshotsById['10'].tabIds, ['2']);
});

test('extension reload does not archive durable snapshots that still match live tabs', async () => {
  const trackerKey = 'tabEcho:close-tracker:normal:v1';
  const tracker = require('../extension/lib/close-tracker.js').createCloseTracker({
    mode: 'normal', now: () => 1700000000000,
  });
  const tabs = [
    { id: 1, windowId: 10, index: 0, incognito: false, title: 'Still open', url: 'https://still-open.example/' },
  ];
  tracker.hydrate(tabs);

  const subject = await loadBackground({
    localInitial: { [trackerKey]: { ...tracker.getState(), revision: 7 } },
    tabs,
  });

  assert.deepEqual(subject.local.values[keys.normalHistory] || [], []);
  assert.deepEqual(subject.local.values[trackerKey].windowSnapshotsById['10'].tabIds, ['1']);
});

test('window-closing tab removals reuse the durable window snapshot without per-tab tracker writes', async () => {
  const trackerKey = 'tabEcho:close-tracker:normal:v1';
  const tabs = [
    { id: 1, windowId: 10, index: 0, incognito: false, title: 'One', url: 'https://one.example/' },
    { id: 2, windowId: 10, index: 1, incognito: false, title: 'Two', url: 'https://two.example/' },
    { id: 3, windowId: 10, index: 2, incognito: false, title: 'Three', url: 'https://three.example/' },
  ];
  const subject = await loadBackground({ tabs });
  const baselineWrites = subject.local.writes.filter((items) => Object.hasOwn(items, trackerKey)).length;

  subject.events.removed.listeners[0](1, { windowId: 10, isWindowClosing: true });
  subject.events.removed.listeners[0](2, { windowId: 10, isWindowClosing: true });
  subject.events.removed.listeners[0](3, { windowId: 10, isWindowClosing: true });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    subject.local.writes.filter((items) => Object.hasOwn(items, trackerKey)).length,
    baselineWrites,
  );
  assert.deepEqual(subject.local.values[trackerKey].windowSnapshotsById['10'].tabIds, ['1', '2', '3']);
});

test('ordinary close is immediately visible without waiting for a batch timer', async () => {
  const trackedTab = {
    id: 701, windowId: 70, index: 0, incognito: false,
    title: 'Just closed', url: 'https://just-closed.example/',
  };
  const subject = await loadBackground({ tabs: [trackedTab] });

  subject.events.removed.listeners[0](trackedTab.id, {
    windowId: trackedTab.windowId,
    isWindowClosing: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const history = await subject.message({ type: 'get-history' });
  assert.equal(history.ok, true);
  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].url, trackedTab.url);
});

test('a pending-url tab closed before commit is immediately visible', async () => {
  const subject = await loadBackground();
  const tab = {
    id: 801, windowId: 80, index: 0, incognito: false,
    title: '', url: '', pendingUrl: 'https://pending.example/',
  };

  subject.events.created.listeners[0](tab);
  subject.events.removed.listeners[0](tab.id, {
    windowId: tab.windowId,
    isWindowClosing: false,
  });
  const history = await subject.message({ type: 'get-history' });

  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].url, tab.pendingUrl);
});

test('a loading pending URL is captured before an ordinary close', async () => {
  const subject = await loadBackground();
  const tab = {
    id: 802, windowId: 80, index: 0, incognito: false,
    title: '', url: '', pendingUrl: 'https://loading.example/',
  };

  subject.events.updated.listeners[0](tab.id, { status: 'loading' }, tab);
  subject.events.removed.listeners[0](tab.id, {
    windowId: tab.windowId,
    isWindowClosing: false,
  });
  const history = await subject.message({ type: 'get-history' });

  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].url, tab.pendingUrl);
});

test('a replaced tab id remains recordable through its new id', async () => {
  const tab = {
    id: 1, windowId: 10, index: 0, incognito: false,
    title: 'Prerender', url: 'https://prerender.example/',
  };
  const subject = await loadBackground({ tabs: [tab] });

  subject.events.replaced.listeners[0](2, 1);
  subject.events.removed.listeners[0](2, {
    windowId: tab.windowId,
    isWindowClosing: false,
  });
  const history = await subject.message({ type: 'get-history' });

  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].id, '2');
  assert.equal(history.results[0].event.tabs[0].url, tab.url);
});

test('history reads wait for an ordinary close already queued for persistence', async () => {
  let releaseHistoryWrite;
  let markHistoryWriteStarted;
  const historyWriteGate = new Promise((resolve) => { releaseHistoryWrite = resolve; });
  const historyWriteStarted = new Promise((resolve) => { markHistoryWriteStarted = resolve; });
  const trackedTab = {
    id: 702, windowId: 70, index: 0, incognito: false,
    title: 'Queued close', url: 'https://queued-close.example/',
  };
  const subject = await loadBackground({ tabs: [trackedTab], localControls: {
    async beforeSet(items) {
      if (!Object.hasOwn(items, keys.normalHistory)) return;
      markHistoryWriteStarted();
      await historyWriteGate;
    },
  } });

  subject.events.removed.listeners[0](trackedTab.id, {
    windowId: trackedTab.windowId,
    isWindowClosing: false,
  });
  await historyWriteStarted;

  let querySettled = false;
  const query = subject.message({ type: 'get-history' }).then((result) => {
    querySettled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(querySettled, false);
  releaseHistoryWrite();
  const history = await query;
  assert.equal(history.ok, true);
  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].url, trackedTab.url);
});

test('message mutations use only the trusted active partition and query all moves underlying events', async () => {
  const normal = [entry('match', 'normal', [{ id: 'a', title: 'Needle', url: 'https://a.example/' }]), entry('keep')];
  const incognito = [entry('secret', 'incognito')];
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: normal, [keys.incognitoHistory]: incognito,
    [keys.normalTrash]: [], [keys.incognitoTrash]: [],
  } });
  const moved = await subject.message({ type: 'move-to-trash', mode: 'incognito', all: true, query: 'needle' });
  assert.equal(moved.ok, true);
  assert.equal(moved.moved, 1);
  assert.deepEqual(subject.local.values[keys.normalHistory].map((item) => item.id), ['keep']);
  assert.deepEqual(subject.local.values[keys.normalTrash].map((item) => item.id), ['match']);
  assert.deepEqual(subject.local.values[keys.incognitoHistory].map((item) => item.id), ['secret']);
});

test('permanently deleting a history event bypasses Trash and preserves other contexts', async () => {
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [entry('delete-me'), entry('keep')],
    [keys.normalTrash]: [entry('already-trashed', 'normal', undefined, { deletedAt: Date.now() })],
    [keys.incognitoHistory]: [entry('secret', 'incognito')],
  } });
  const result = await subject.message({ type: 'permanently-delete-history', eventIds: ['delete-me'] });
  assert.equal(result.deleted, 1);
  assert.deepEqual(subject.local.values[keys.normalHistory].map((item) => item.id), ['keep']);
  assert.deepEqual(subject.local.values[keys.normalTrash].map((item) => item.id), ['already-trashed']);
  assert.deepEqual(subject.local.values[keys.incognitoHistory].map((item) => item.id), ['secret']);
});

test('query-wide history removal deletes complete matching events without touching Trash', async () => {
  const group = entry('group', 'normal', [
    { id: 'match', title: 'Needle', url: 'https://match.test/' },
    { id: 'other', title: 'Other', url: 'https://other.test/' },
  ]);
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [group, entry('keep')],
    [keys.normalTrash]: [entry('trashed', 'normal', undefined, { deletedAt: Date.now() })],
    [keys.incognitoHistory]: [entry('secret', 'incognito')],
  } });
  const result = await subject.message({ type: 'permanently-delete-history', all: true, query: 'needle' });
  assert.equal(result.deleted, 1);
  assert.deepEqual(subject.local.values[keys.normalHistory].map((item) => item.id), ['keep']);
  assert.deepEqual(subject.local.values[keys.normalTrash].map((item) => item.id), ['trashed']);
  assert.deepEqual(subject.local.values[keys.incognitoHistory].map((item) => item.id), ['secret']);
  assert.equal((await subject.message({ type: 'permanently-delete-history', all: true, query: '' })).deleted, 1);
  assert.deepEqual(subject.local.values[keys.normalHistory], []);
  assert.equal((await subject.message({ type: 'permanently-delete-history', all: true, eventIds: ['x'] })).error.code, 'INVALID_REQUEST');
  assert.equal((await subject.message({ type: 'permanently-delete-history' })).error.code, 'INVALID_REQUEST');
});

test('prepared History deletion commits the exact server-side scope once', async () => {
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [entry('match', 'normal', [{ id: 'tab-a', title: 'Needle', url: 'https://a.test/' }]), entry('keep')],
  } });

  const prepared = await subject.message({
    type: 'prepare-destructive-action', operation: 'delete-history', all: true, query: 'needle',
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.operation, 'delete-history');
  assert.equal(prepared.eventCount, 1);
  assert.equal(prepared.tabCount, 1);
  assert.equal(typeof prepared.token, 'string');
  assert.deepEqual(subject.local.values[keys.normalHistory].map((event) => event.id), ['match', 'keep']);

  const committed = await subject.message({ type: 'commit-destructive-action', token: prepared.token });
  assert.equal(committed.ok, true);
  assert.equal(committed.deleted, 1);
  assert.deepEqual(subject.local.values[keys.normalHistory].map((event) => event.id), ['keep']);

  const replay = await subject.message({ type: 'commit-destructive-action', token: prepared.token });
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, 'ACTION_TOKEN_INVALID');
});

test('prepared destructive actions reject changed data without deleting the prepared scope', async () => {
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [entry('first'), entry('second')],
  } });
  const prepared = await subject.message({
    type: 'prepare-destructive-action', operation: 'delete-history', all: true, query: '',
  });

  assert.equal((await subject.message({ type: 'move-to-trash', eventIds: ['second'] })).moved, 1);
  const stale = await subject.message({ type: 'commit-destructive-action', token: prepared.token });

  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'ACTION_STALE');
  assert.deepEqual(subject.local.values[keys.normalHistory].map((event) => event.id), ['first']);
  assert.deepEqual(subject.local.values[keys.normalTrash].map((event) => event.id), ['second']);
});

test('prepared Empty Trash uses exact counts and rejects an intervening Trash change', async () => {
  const now = Date.now();
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [entry('new-history')],
    [keys.normalTrash]: [entry('old-trash', 'normal', [
      { id: 'a', title: 'A', url: 'https://a.test/' },
      { id: 'b', title: 'B', url: 'https://b.test/' },
    ], { deletedAt: now })],
  } });
  const prepared = await subject.message({
    type: 'prepare-destructive-action', operation: 'empty-trash',
  });
  assert.equal(prepared.eventCount, 1);
  assert.equal(prepared.tabCount, 2);

  await subject.message({ type: 'move-to-trash', eventIds: ['new-history'] });
  const stale = await subject.message({ type: 'commit-destructive-action', token: prepared.token });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'ACTION_STALE');
  assert.deepEqual(subject.local.values[keys.normalTrash].map((event) => event.id), ['old-trash', 'new-history']);
});

test('history reads lazily prune history and trash together and return search counts', async () => {
  const old = Date.now() - 10 * 86400000;
  const subject = await loadBackground({ localInitial: {
    [keys.settings]: { maxRecords: 10, maxAgeDays: 1, trashMaxAgeDays: 1, pageSize: 50, language: 'en', theme: 'system' },
    [keys.normalHistory]: [entry('old', 'normal', undefined, { closedAt: old }), entry('new')],
    [keys.normalTrash]: [entry('expired', 'normal', undefined, { deletedAt: old })],
  } });
  const result = await subject.message({ type: 'get-history', query: 'new' });
  assert.equal(result.ok, true);
  assert.equal(result.totalEventCount, 1);
  assert.equal(result.matchedTabCount, 1);
  assert.equal(result.revision, 1);
  assert.deepEqual(structuredClone(result.statistics), {
    revision: 1,
    totalRecords: 1,
    totalTabs: 1,
    matchingRecords: 1,
    matchingTabs: 1,
    resultTabs: 1,
    displayedRecords: 1,
  });
  assert.deepEqual(subject.local.values[keys.normalHistory].map((item) => item.id), ['new']);
  assert.deepEqual(subject.local.values[keys.normalTrash], []);
});

test('history list protocol returns only the requested page with full matching statistics', async () => {
  const closedAt = Date.now();
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [
      entry('oldest', 'normal', undefined, { closedAt: closedAt - 2 }),
      entry('middle', 'normal', undefined, { closedAt: closedAt - 1 }),
      entry('newest', 'normal', undefined, { closedAt }),
    ],
  } });

  const result = await subject.message({ type: 'get-history', offset: 1, limit: 1 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((item) => item.event.id), ['middle']);
  assert.equal(result.statistics.totalRecords, 3);
  assert.equal(result.statistics.matchingRecords, 3);
  assert.equal(result.statistics.displayedRecords, 1);
  assert.deepEqual(structuredClone(result.pagination), { offset: 1, limit: 1, hasMore: true });
});

test('domain history protocol returns one selected page and complete selected ids', async () => {
  const alphaOld = entry('alpha-old', 'normal', [
    { id: 'alpha-old-tab', title: 'Alpha old', url: 'https://alpha.example/old' },
  ], { closedAt: 1 });
  const beta = entry('beta', 'normal', [
    { id: 'beta-tab', title: 'Beta', url: 'https://beta.example/' },
  ], { closedAt: 2 });
  const alphaNew = entry('alpha-new', 'normal', [
    { id: 'alpha-new-tab', title: 'Alpha new', url: 'https://alpha.example/new' },
  ], { closedAt: 3 });
  const subject = await loadBackground({
    localInitial: { [keys.normalHistory]: [alphaOld, beta, alphaNew] },
  });

  const result = await subject.message({
    type: 'get-history-by-domain', domain: 'alpha.example', offset: 1, limit: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(structuredClone(result.groups), [
    { key: 'alpha.example', domain: 'alpha.example', label: 'alpha.example', eventCount: 2, tabCount: 2 },
    { key: 'beta.example', domain: 'beta.example', label: 'beta.example', eventCount: 1, tabCount: 1 },
  ]);
  assert.equal(result.selectedDomain, 'alpha.example');
  assert.deepEqual(structuredClone(result.results.map((item) => item.event.id)), ['alpha-old']);
  assert.deepEqual(structuredClone(result.eventIds), ['alpha-new', 'alpha-old']);
  assert.equal(result.statistics.selectedRecords, 2);
  assert.equal(result.pagination.hasMore, false);
});

test('reopen-tab uses the current window while reopen-event opens a group in a new window in source order', async () => {
  const group = entry('group', 'normal', [
    { id: 'first', title: 'First', url: 'https://first.example/' },
    { id: 'second', title: 'Second', url: 'https://second.example/' },
  ]);
  const subject = await loadBackground({ localInitial: { [keys.normalHistory]: [group] } });
  const reopened = await subject.message({ type: 'reopen-tab', eventId: 'group', tabId: 'second' });
  assert.equal(reopened.complete, true);
  assert.deepEqual(subject.openedTabs.map((tab) => tab.url), ['https://second.example/']);
  const completeGroup = await subject.message({ type: 'reopen-event', eventId: 'group' });
  assert.equal(completeGroup.reopened, 2);
  assert.deepEqual(subject.openedWindows.map((window) => window.url), ['https://first.example/']);
  assert.deepEqual(subject.openedTabs.slice(1).map((tab) => ({ url: tab.url, windowId: tab.windowId, active: tab.active })), [
    { url: 'https://second.example/', windowId: 90, active: false },
  ]);
  const unknown = await subject.message({ type: 'not-real' });
  assert.deepEqual(structuredClone(unknown), {
    ok: false, error: { code: 'UNKNOWN_MESSAGE', message: 'Unsupported message type: not-real' },
  });
});

test('open-dashboard reuses only a same-context dashboard tab', async () => {
  const dashboard = 'chrome-extension://test/dashboard.html';
  const subject = await loadBackground({ tabs: [
    { id: 7, windowId: 2, url: dashboard, incognito: true },
    { id: 8, windowId: 3, url: dashboard, incognito: false },
  ] });
  let activated;
  subject.chrome.tabs.update = async (id) => { activated = id; };
  subject.chrome.windows.update = async () => {};
  const result = await subject.message({ type: 'open-dashboard', mode: 'incognito' });
  assert.equal(result.reused, true);
  assert.equal(result.tabId, 8);
  assert.equal(activated, 8);
});

test('save-settings applies patch semantics and preserves omitted retention settings', async () => {
  const current = { maxRecords: 77, maxAgeDays: 9, trashMaxAgeDays: 3, pageSize: 50, language: 'en', theme: 'system' };
  const subject = await loadBackground({ localInitial: { [keys.settings]: current } });
  const saved = await subject.message({ action: 'save-settings', settings: { pageSize: 25, language: 'zh', theme: 'dark' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(structuredClone(subject.local.values[keys.settings]), {
    maxRecords: 77, maxAgeDays: 9, trashMaxAgeDays: 3, popupSize: 10, pageSize: 25, language: 'zh', theme: 'dark', excludedDomains: [], settingsVersion: 2,
  });
});

test('incognito mode exposes shared settings as read-only', async () => {
  const current = {
    maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3, popupSize: 10,
    pageSize: 50, language: 'en', theme: 'system', excludedDomains: [], settingsVersion: 2,
  };
  const subject = await loadBackground({ incognito: true, localInitial: { [keys.settings]: current } });

  const preview = await subject.message({ type: 'preview-settings-impact', settings: { theme: 'dark' } });
  const save = await subject.message({ type: 'save-settings', settings: { theme: 'dark' } });

  assert.equal(preview.ok, false);
  assert.equal(preview.error.code, 'SETTINGS_READ_ONLY_INCOGNITO');
  assert.equal(save.ok, false);
  assert.equal(save.error.code, 'SETTINGS_READ_ONLY_INCOGNITO');
  assert.deepEqual(subject.local.values[keys.settings], current);
});

test('settings preview token atomically saves and optionally removes only newly excluded matches', async () => {
  const current = { maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3, popupSize: 10, pageSize: 50, language: 'en', theme: 'system', excludedDomains: ['old.test'] };
  const mixed = entry('mixed', 'normal', [
    { id: 'old', title: 'Old', url: 'https://old.test/a' },
    { id: 'new', title: 'New', url: 'https://new.test/b' },
    { id: 'keep', title: 'Keep', url: 'https://keep.test/c' },
  ]);
  const subject = await loadBackground({ localInitial: { [keys.settings]: current, [keys.normalHistory]: [mixed] } });
  const preview = await subject.message({ type: 'preview-settings-impact', settings: { excludedDomains: ['old.test', 'new.test'] } });
  assert.deepEqual(structuredClone(preview.impact.addedExcludedDomains), ['new.test']);
  assert.equal(preview.impact.exclusions.historyTabCount, 1);
  assert.equal(typeof preview.token, 'string');
  const direct = await subject.message({ type: 'save-settings', settings: preview.settings, removeExistingExcludedMatches: false });
  assert.equal(direct.ok, false);
  assert.equal(direct.error.code, 'DESTRUCTIVE_PREVIEW_REQUIRED');
  const kept = await subject.message({
    type: 'commit-destructive-action', token: preview.token, removeExistingExcludedMatches: false,
  });
  assert.equal(kept.removedExcludedTabs, 0);
  assert.deepEqual(subject.local.values[keys.normalHistory][0].tabs.map((tab) => tab.id), ['old', 'new', 'keep']);

  const subject2 = await loadBackground({ localInitial: { [keys.settings]: current, [keys.normalHistory]: [mixed] } });
  const preview2 = await subject2.message({ type: 'preview-settings-impact', settings: { excludedDomains: ['old.test', 'new.test'] } });
  const removed = await subject2.message({
    type: 'commit-destructive-action', token: preview2.token, removeExistingExcludedMatches: true,
  });
  assert.equal(removed.removedExcludedTabs, 1);
  assert.deepEqual(subject2.local.values[keys.normalHistory][0].tabs.map((tab) => tab.id), ['old', 'keep']);
  assert.equal((await subject2.message({
    type: 'commit-destructive-action', token: 'missing', removeExistingExcludedMatches: 'yes',
  })).error.code, 'INVALID_REQUEST');
});

test('settings impact token becomes stale after records or settings change', async () => {
  const current = { maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3, popupSize: 10, pageSize: 50, language: 'en', theme: 'system', excludedDomains: [] };
  const subject = await loadBackground({ localInitial: {
    [keys.settings]: current,
    [keys.normalHistory]: [entry('remove-by-limit'), entry('keep')],
  } });
  const preview = await subject.message({ type: 'preview-settings-impact', settings: { maxRecords: 1 } });
  assert.equal(typeof preview.token, 'string');
  await subject.message({ type: 'move-to-trash', eventIds: ['keep'] });

  const stale = await subject.message({
    type: 'commit-destructive-action', token: preview.token, removeExistingExcludedMatches: false,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'ACTION_STALE');
  assert.equal(subject.local.values[keys.settings].maxRecords, 10000);

  const subject2 = await loadBackground({ localInitial: {
    [keys.settings]: current,
    [keys.normalHistory]: [entry('remove-by-limit'), entry('keep')],
  } });
  const preview2 = await subject2.message({ type: 'preview-settings-impact', settings: { maxRecords: 1 } });
  await subject2.message({ type: 'save-settings', settings: { theme: 'dark' } });
  const settingsStale = await subject2.message({
    type: 'commit-destructive-action', token: preview2.token, removeExistingExcludedMatches: false,
  });
  assert.equal(settingsStale.ok, false);
  assert.equal(settingsStale.error.code, 'ACTION_STALE');
  assert.equal(subject2.local.values[keys.settings].maxRecords, 10000);
  assert.equal(subject2.local.values[keys.settings].theme, 'dark');
});

test('get-settings returns settings and the trusted active browsing mode without loading history', async () => {
  const current = { maxRecords: null, maxAgeDays: 9, trashMaxAgeDays: 3, pageSize: 50, language: 'zh', theme: 'dark' };
  const subject = await loadBackground({ incognito: true, localInitial: {
    [keys.settings]: current, [keys.incognitoHistory]: [entry('secret', 'incognito')],
  } });
  const getBaseline = subject.local.getKeys.length;
  const result = await subject.message({ type: 'get-settings', mode: 'normal' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'incognito');
  assert.deepEqual(structuredClone(result.settings), { ...current, popupSize: 10, excludedDomains: [], settingsVersion: 2 });
  assert.equal(Object.hasOwn(result, 'events'), false);
  assert.equal(Object.hasOwn(result, 'results'), false);
  assert.deepEqual(subject.local.getKeys.slice(getBaseline), [keys.settings]);
});

test('storage health reports quota pressure levels without loading record arrays', async () => {
  const quotaBytes = 10 * 1024 * 1024;
  const local = memoryArea({}, { bytesInUse: Math.round(quotaBytes * 0.86), quotaBytes });
  const subject = await loadBackground({ localArea: local });
  const baselineReads = local.reads;

  const health = await subject.message({ type: 'get-storage-health' });

  assert.equal(health.ok, true);
  assert.equal(health.supported, true);
  assert.equal(health.quotaBytes, quotaBytes);
  assert.equal(health.level, 'warning');
  assert.ok(health.usageRatio >= 0.85 && health.usageRatio < 0.95);
  assert.deepEqual(structuredClone(health.pools.regularRecords), {
    supported: false, bytesUsed: null, quotaBytes: null, usageRatio: null, level: 'unknown',
  });
  assert.equal(health.pools.localData.level, 'warning');
  assert.equal(local.reads, baselineReads);

  for (const [ratio, level] of [[0.69, 'normal'], [0.70, 'elevated'], [0.85, 'warning'], [0.95, 'critical']]) {
    const worker = await loadBackground({ localArea: memoryArea({}, {
      bytesInUse: Math.round(quotaBytes * ratio), quotaBytes,
    }) });
    const result = await worker.message({ type: 'get-storage-health' });
    assert.equal(result.ok, true);
    assert.equal(result.level, level, `expected ${ratio} to be ${level}`);
  }
});

test('storage health measures only incognito history and trash in the incognito pool', async () => {
  const quotaBytes = 10 * 1024 * 1024;
  const historyPayloadBytes = 1200;
  const trashPayloadBytes = 848;
  const incognitoRecordBytes = historyPayloadBytes + trashPayloadBytes;
  const allLocalBytes = 7 * 1024 * 1024;
  const measuredKeys = [];
  const local = memoryArea({}, { quotaBytes });
  local.getBytesInUse = async (requestedKeys) => {
    measuredKeys.push(structuredClone(requestedKeys));
    const storedBytes = {
      [keys.incognitoHistory]: keys.incognitoHistory.length + 2 + historyPayloadBytes,
      [keys.incognitoTrash]: keys.incognitoTrash.length + 2 + trashPayloadBytes,
    };
    if (typeof requestedKeys === 'string') return storedBytes[requestedKeys] || 0;
    if (Array.isArray(requestedKeys)) {
      return requestedKeys.reduce((total, key) => total + (storedBytes[key] || 0), 0);
    }
    return allLocalBytes;
  };
  const subject = await loadBackground({ localArea: local });

  const health = await subject.message({ type: 'get-storage-health' });

  assert.deepEqual(measuredKeys, [keys.incognitoHistory, keys.incognitoTrash]);
  assert.equal(health.pools.localData.bytesUsed, incognitoRecordBytes);
  assert.equal(health.pools.localData.usageRatio, incognitoRecordBytes / quotaBytes);
});

test('storage health reports zero bytes for empty incognito history and trash arrays', async () => {
  const quotaBytes = 10 * 1024 * 1024;
  const local = memoryArea({}, { quotaBytes });
  local.getBytesInUse = async (requestedKeys) => {
    if (typeof requestedKeys === 'string') return requestedKeys.length + 2;
    return requestedKeys.reduce((total, key) => total + key.length + 2, 0);
  };
  const subject = await loadBackground({ localArea: local });

  const health = await subject.message({ type: 'get-storage-health' });

  assert.equal(health.pools.localData.bytesUsed, 0);
  assert.equal(health.pools.localData.usageRatio, 0);
});

test('storage health explicitly reports unsupported byte accounting', async () => {
  const subject = await loadBackground();
  const health = await subject.message({ type: 'get-storage-health' });

  assert.deepEqual(structuredClone(health), {
    ok: true,
    supported: false,
    bytesUsed: null,
    quotaBytes: null,
    usageRatio: null,
    level: 'unknown',
    pools: {
      regularRecords: { supported: false, bytesUsed: null, quotaBytes: null, usageRatio: null, level: 'unknown' },
      localData: { supported: false, bytesUsed: null, quotaBytes: null, usageRatio: null, level: 'unknown' },
    },
    lastWriteFailure: null,
  });
});

test('storage health includes IndexedDB usage and reports the highest storage pressure', async () => {
  const localQuotaBytes = 10 * 1024 * 1024;
  const originQuotaBytes = 100 * 1024 * 1024;
  const subject = await loadBackground({
    localArea: memoryArea({}, { bytesInUse: Math.round(localQuotaBytes * 0.90), quotaBytes: localQuotaBytes }),
    storageEstimate: async () => ({
      usage: Math.round(originQuotaBytes * 0.86),
      quota: originQuotaBytes,
      usageDetails: { indexedDB: 2 * 1024 * 1024 },
    }),
  });

  const health = await subject.message({ type: 'get-storage-health' });

  assert.equal(health.ok, true);
  assert.equal(health.bytesUsed, Math.round(originQuotaBytes * 0.86));
  assert.equal(health.quotaBytes, originQuotaBytes);
  assert.equal(health.indexedDbBytes, 2 * 1024 * 1024);
  assert.equal(health.localQuotaBytes, localQuotaBytes);
  assert.equal(health.level, 'warning');
  assert.deepEqual(structuredClone(health.pools.regularRecords), {
    supported: true,
    bytesUsed: 2 * 1024 * 1024,
    quotaBytes: originQuotaBytes,
    usageRatio: 0.02,
    level: 'normal',
  });
  assert.deepEqual(structuredClone(health.pools.localData), {
    supported: true,
    bytesUsed: 9 * 1024 * 1024,
    quotaBytes: localQuotaBytes,
    usageRatio: 0.9,
    level: 'warning',
  });
});

test('storage health can report regular records when local byte accounting is unavailable', async () => {
  const originQuotaBytes = 100 * 1024 * 1024;
  const subject = await loadBackground({
    storageEstimate: async () => ({ usage: 7 * 1024 * 1024, quota: originQuotaBytes }),
  });

  const health = await subject.message({ type: 'get-storage-health' });

  assert.equal(health.supported, true);
  assert.equal(health.pools.regularRecords.supported, true);
  assert.equal(health.pools.regularRecords.bytesUsed, 7 * 1024 * 1024);
  assert.deepEqual(structuredClone(health.pools.localData), {
    supported: false, bytesUsed: null, quotaBytes: null, usageRatio: null, level: 'unknown',
  });
});

test('permanent deletion supports explicit ids, all query, and rejects invalid selection', async () => {
  const trash = [entry('needle', 'normal', undefined, { deletedAt: Date.now() }), entry('keep', 'normal', undefined, { deletedAt: Date.now() })];
  const subject = await loadBackground({ localInitial: { [keys.normalTrash]: trash } });
  const result = await subject.message({ type: 'permanently-delete-trash', all: true, query: 'needle' });
  assert.equal(result.deleted, 1);
  assert.deepEqual(subject.local.values[keys.normalTrash].map((item) => item.id), ['keep']);
  const invalid = await subject.message({ type: 'permanently-delete-trash' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_REQUEST');
  const conflicting = await subject.message({ type: 'permanently-delete-trash', all: true, trashIds: ['keep'] });
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error.code, 'INVALID_REQUEST');
});

test('legacy delete protocols reject missing or empty ids', async () => {
  const subject = await loadBackground();
  for (const request of [
    { action: 'delete-event' }, { action: 'delete-events', eventIds: [] }, { action: 'bulk-delete', eventIds: [] },
  ]) {
    const result = await subject.message(request);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_REQUEST');
  }
});

test('history and trash preserve duplicate URLs so visible and actionable counts stay aligned', async () => {
  const now = Date.now();
  const duplicate = (id, deletedAt) => entry(id, 'normal', [{ id, title: id, url: 'https://same.example/' }], { deletedAt });
  const subject = await loadBackground({ localInitial: {
    [keys.normalHistory]: [duplicate('older', now - 1), duplicate('newer', now)],
    [keys.normalTrash]: [duplicate('trash-old', now - 1), duplicate('trash-new', now)],
  } });
  const baseline = subject.local.writes.length;
  const baselineReads = subject.local.reads;
  const history = await subject.message({ type: 'get-history' });
  const trash = await subject.message({ type: 'get-trash' });
  assert.equal(history.resultEventCount, 2);
  assert.equal(history.statistics.matchingRecords, 2);
  assert.equal(trash.resultEventCount, 2);
  assert.equal(subject.local.writes.length, baseline);
  // Each message reads settings, revisions, History, and Trash in one storage call.
  assert.equal(subject.local.reads, baselineReads + 2);
});

test('trash restore is atomic at capacity and restore-results restores full matching entries', async () => {
  const now = Date.now();
  const settings = { maxRecords: 1, maxAgeDays: null, trashMaxAgeDays: 3, pageSize: 50, language: 'en', theme: 'system' };
  const subject = await loadBackground({ localInitial: {
    [keys.settings]: settings, [keys.normalHistory]: [entry('occupied')],
    [keys.normalTrash]: [entry('needle', 'normal', undefined, { deletedAt: now })],
  } });
  const beforeHistory = structuredClone(subject.local.values[keys.normalHistory]);
  const beforeTrash = structuredClone(subject.local.values[keys.normalTrash]);
  const beforeWrites = subject.local.writes.length;
  const blocked = await subject.message({ type: 'restore-trash', trashIds: ['needle'] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.requiredSlots, 1);
  assert.deepEqual(subject.local.values[keys.normalTrash].map((item) => item.id), ['needle']);
  assert.deepEqual(subject.local.values[keys.normalHistory], beforeHistory);
  assert.deepEqual(subject.local.values[keys.normalTrash], beforeTrash);
  assert.equal(subject.local.writes.length, beforeWrites);
  await subject.message({ action: 'clear-mode' });
  const restored = await subject.message({ type: 'restore-trash-results', query: 'needle' });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, 1);
});

test('preview is non-mutating, empty-trash clears, and legacy delete/clear remain soft deletes', async () => {
  const subject = await loadBackground({ localInitial: { [keys.normalHistory]: [entry('one'), entry('two')] } });
  const preview = await subject.message({ type: 'preview-settings-impact', settings: { maxRecords: 1 } });
  assert.equal(preview.ok, true);
  assert.equal(preview.impact.retention.historyEventCount, 1);
  assert.equal(subject.local.values[keys.normalHistory].length, 2);
  assert.equal((await subject.message({ action: 'delete-event', eventId: 'one' })).deleted, 1);
  assert.equal((await subject.message({ action: 'clear-mode' })).deleted, 1);
  assert.equal(subject.local.values[keys.normalTrash].length, 2);
  assert.equal((await subject.message({ type: 'empty-trash' })).deleted, 2);
  assert.deepEqual(subject.local.values[keys.normalTrash], []);
});

test('alarm waits for initialization before performing cleanup', async () => {
  let release;
  const queryGate = new Promise((resolve) => { release = resolve; });
  const old = Date.now() - 10 * 86400000;
  const subject = await loadBackground({ awaitReady: false, queryGate, localInitial: {
    [keys.settings]: { maxRecords: 10, maxAgeDays: 1, trashMaxAgeDays: 1, pageSize: 50, language: 'en', theme: 'system' },
    [keys.normalHistory]: [entry('old', 'normal', undefined, { closedAt: old })],
  } });
  const alarm = subject.events.alarm.listeners[0]({ name: 'tab-echo-daily-cleanup' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.local.values[keys.normalHistory].length, 1);
  release();
  await alarm;
  assert.deepEqual(subject.local.values[keys.normalHistory], []);
});

test('reopen-event reports partial browser failures without claiming full success', async () => {
  const group = entry('group', 'normal', [
    { id: 'good', title: 'Good', url: 'https://good.example/' },
    { id: 'bad', title: 'Bad', url: 'https://bad.example/' },
  ]);
  const subject = await loadBackground({ localInitial: { [keys.normalHistory]: [group] }, failCreateUrl: 'https://bad.example/' });
  const result = await subject.message({ type: 'reopen-event', eventId: 'group' });
  assert.equal(result.complete, false);
  assert.equal(result.reopened, 1);
  assert.equal(result.failures[0].url, 'https://bad.example/');
});

test('storage write failures use the stable public STORAGE_WRITE_FAILED code', async () => {
  const subject = await loadBackground({ localInitial: { [keys.normalHistory]: [entry('one')] }, localControls: {
    failSet(items) { return Object.hasOwn(items, keys.normalTrash); },
  } });
  const result = await subject.message({ type: 'move-to-trash', eventIds: ['one'] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STORAGE_WRITE_FAILED');

  const health = await subject.message({ type: 'get-storage-health' });
  assert.equal(health.lastWriteFailure.code, 'STORAGE_WRITE_FAILED');
  assert.equal(health.lastWriteFailure.operation, 'updateContext(normal)');
  assert.ok(Number.isFinite(health.lastWriteFailure.occurredAt));
});

test('failed close-event writes remain in the durable outbox and retry without duplicates', async () => {
  let rejectHistoryWrites = true;
  const trackedTab = {
    id: 1, windowId: 10, index: 0, incognito: false,
    title: 'Recover me', url: 'https://recover.example/',
  };
  const subject = await loadBackground({ tabs: [trackedTab], localControls: {
    failSet(items) { return rejectHistoryWrites && Object.hasOwn(items, keys.normalHistory); },
  } });

  subject.events.windowRemoved.listeners[0](10);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const trackerKey = 'tabEcho:close-tracker:normal:v1';
  assert.equal(Object.keys(subject.local.values[trackerKey].pendingEventsById).length, 1);
  assert.equal(subject.local.values[keys.normalHistory], undefined);

  rejectHistoryWrites = false;
  subject.events.created.listeners[0]({
    id: 2, windowId: 20, index: 0, incognito: false,
    title: 'Retry trigger', url: 'https://trigger.example/',
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.local.values[keys.normalHistory].length, 1);
  assert.equal(subject.local.values[keys.normalHistory][0].tabs[0].url, trackedTab.url);
  assert.equal(Object.keys(subject.local.values[trackerKey].pendingEventsById).length, 0);

  subject.events.created.listeners[0]({
    id: 3, windowId: 20, index: 1, incognito: false,
    title: 'No duplicate', url: 'https://second-trigger.example/',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(subject.local.values[keys.normalHistory].length, 1);
});

test('legacy restore-event opens a complete group without consuming history', async () => {
  const group = entry('legacy-group', 'normal', [
    { id: 'one', title: 'One', url: 'https://one.example/' },
    { id: 'two', title: 'Two', url: 'https://two.example/' },
  ]);
  const subject = await loadBackground({ localInitial: { [keys.normalHistory]: [group] } });
  const result = await subject.message({ action: 'restore-event', eventId: 'legacy-group' });
  assert.equal(result.ok, true);
  assert.equal(result.restored, 2);
  assert.deepEqual(subject.local.values[keys.normalHistory].map((item) => item.id), ['legacy-group']);
});

test('daily alarm ensure is idempotent across init, installed, and startup', async () => {
  const subject = await loadBackground();
  await subject.events.installed.listeners[0]();
  await subject.events.startup.listeners[0]();
  assert.deepEqual(structuredClone(subject.createdAlarms), [{ name: 'tab-echo-daily-cleanup', periodInMinutes: 1440 }]);
});

test('dashboard reuses a parameterized tab and updates only allowed parameters', async () => {
  const subject = await loadBackground({ tabs: [{
    id: 9, windowId: 4, url: 'chrome-extension://test/dashboard.html?view=history#old', incognito: false,
  }] });
  let update;
  subject.chrome.tabs.update = async (id, details) => { update = { id, details }; };
  subject.chrome.windows.update = async () => {};
  const result = await subject.message({ type: 'open-dashboard', view: 'trash', query: 'needle', url: 'https://evil.example/' });
  assert.equal(result.reused, true);
  assert.deepEqual(structuredClone(update), { id: 9, details: {
    url: 'chrome-extension://test/dashboard.html?view=trash&q=needle', active: true,
  } });
  assert.equal(subject.openedTabs.length, 0);
});

test('open-dashboard accepts the popup q field as the dashboard search query', async () => {
  const subject = await loadBackground();
  await subject.message({ type: 'open-dashboard', view: 'history', q: 'two words' });
  assert.equal(subject.openedTabs[0].url, 'chrome-extension://test/dashboard.html?view=history&q=two+words');
});

test('legacy group window-create failure reports every URL as not opened', async () => {
  const group = entry('legacy-fail', 'normal', [
    { id: 'one', title: 'One', url: 'https://one.example/' },
    { id: 'two', title: 'Two', url: 'https://two.example/' },
  ]);
  const subject = await loadBackground({ localInitial: { [keys.normalHistory]: [group] } });
  subject.chrome.windows.create = async () => { throw new Error('window denied'); };
  const result = await subject.message({ action: 'restore-event', eventId: 'legacy-fail' });
  assert.equal(result.restored, 0);
  assert.equal(result.failures.length, 2);
});

test('destructive settings save is atomic when its storage write fails', async () => {
  const subject = await loadBackground({ localControls: { failSet(items) {
    return Object.hasOwn(items, keys.settings) && Object.hasOwn(items, keys.normalHistory);
  } } });
  subject.local.values[keys.normalHistory] = [entry('one'), entry('two')];
  const preview = await subject.message({ type: 'preview-settings-impact', settings: { maxRecords: 1 } });
  const result = await subject.message({
    type: 'commit-destructive-action', token: preview.token, removeExistingExcludedMatches: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'STORAGE_WRITE_FAILED');
  assert.equal(subject.local.values[keys.settings], undefined);
  assert.deepEqual(subject.local.values[keys.normalHistory].map((event) => event.id), ['one', 'two']);
});

test('normal worker is the sole settings writer and incognito cannot overwrite it', async () => {
  const shared = memoryArea({ [keys.settings]: {
    maxRecords: 100, maxAgeDays: null, trashMaxAgeDays: 3, pageSize: 50, language: 'en', theme: 'system',
  } });
  const normal = await loadBackground({ localArea: shared });
  const incognito = await loadBackground({ localArea: shared, incognito: true });
  const normalResult = await normal.message({ type: 'save-settings', settings: { maxRecords: 25 } });
  const incognitoResult = await incognito.message({ type: 'save-settings', settings: { theme: 'dark' } });
  assert.equal(normalResult.ok, true);
  assert.equal(incognitoResult.ok, false);
  assert.equal(incognitoResult.error.code, 'SETTINGS_READ_ONLY_INCOGNITO');
  assert.equal(shared.values[keys.settings].maxRecords, 25);
  assert.equal(shared.values[keys.settings].theme, 'system');
});
