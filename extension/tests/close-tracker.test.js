const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createCloseTracker, createTrackerPersistence } = require('../lib/close-tracker.js');
const { deleteEvent, getRestoreUrls } = require('../lib/history-store.js');

function tab(id, windowId, index, overrides = {}) {
  return {
    id,
    windowId,
    index,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    favIconUrl: `https://example.com/${id}.ico`,
    incognito: false,
    ...overrides,
  };
}

function tracker(state) {
  let sequence = 0;
  return createCloseTracker({
    mode: 'normal',
    now: () => 1700000000000 + sequence,
    createId: (prefix) => `${prefix}-${++sequence}`,
  }, state);
}

test('hydrates tab and window snapshots from currently open tabs', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1), tab(3, 11, 0)]);

  const state = subject.getState();
  assert.equal(state.tabSnapshotsById['1'].url, 'https://example.com/1');
  assert.deepEqual(state.windowSnapshotsById['10'].tabIds, ['1', '2']);
  assert.deepEqual(state.windowSnapshotsById['11'].tabIds, ['3']);
  assert.doesNotThrow(() => structuredClone(state));
});

test('hydrate rebuilds each live window order from authoritative tab indexes', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  subject.hydrate([tab(1, 10, 1), tab(2, 10, 0)]);

  assert.deepEqual(subject.getState().windowSnapshotsById['10'].tabIds, ['2', '1']);
  assert.deepEqual(['2', '1'].map((id) => subject.getState().tabSnapshotsById[id].position), [0, 1]);
});

test('created and updated tabs update snapshots', () => {
  const subject = tracker();
  subject.upsertTab(tab(1, 10, 0));
  subject.upsertTab(tab(1, 10, 0, { title: 'Updated', url: 'https://updated.example/' }));

  const state = subject.getState();
  assert.equal(state.tabSnapshotsById['1'].title, 'Updated');
  assert.equal(state.tabSnapshotsById['1'].sourceWindowId, 10);
  assert.deepEqual(state.windowSnapshotsById['10'].tabIds, ['1']);
});

test('inserting a new tab at index zero shifts existing positions without later updates reordering it', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  subject.upsertTab(tab(3, 10, 0));
  assert.deepEqual(subject.getState().windowSnapshotsById['10'].tabIds, ['3', '1', '2']);
  assert.deepEqual(['3', '1', '2'].map((id) => subject.getState().tabSnapshotsById[id].position), [0, 1, 2]);

  subject.upsertTab(tab(1, 10, 99, { title: 'Updated only' }));
  assert.deepEqual(subject.getState().windowSnapshotsById['10'].tabIds, ['3', '1', '2']);
});

test('detach then attach preserves the tab snapshot and moves it between window snapshots', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1), tab(3, 20, 0)]);
  subject.detachTab(2, { oldWindowId: 10, oldPosition: 1 });
  assert.ok(subject.getState().tabSnapshotsById['2']);
  assert.deepEqual(subject.getState().windowSnapshotsById['10'].tabIds, ['1']);

  subject.attachTab(2, { newWindowId: 20, newPosition: 0 });
  assert.deepEqual(subject.getState().windowSnapshotsById['20'].tabIds, ['2', '3']);
  assert.equal(subject.getState().tabSnapshotsById['2'].sourceWindowId, 20);
});

test('navigation away from http removes the prior restorable snapshot', () => {
  const subject = tracker();
  subject.upsertTab(tab(1, 10, 0));
  subject.upsertTab(tab(1, 10, 0, { url: 'chrome://settings' }));

  assert.equal(subject.getState().tabSnapshotsById['1'], undefined);
  assert.deepEqual(subject.getState().windowSnapshotsById['10'].tabIds, []);
});

test('moving within a window updates the complete window ordering', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1), tab(3, 10, 2)]);
  subject.moveTab(1, { windowId: 10, fromIndex: 0, toIndex: 2 });

  assert.deepEqual(subject.getState().windowSnapshotsById['10'].tabIds, ['2', '3', '1']);
  assert.deepEqual([
    subject.getState().tabSnapshotsById['2'].position,
    subject.getState().tabSnapshotsById['3'].position,
    subject.getState().tabSnapshotsById['1'].position,
  ], [0, 1, 2]);
});

test('quick ordinary removals aggregate by window into one group', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1), tab(3, 11, 0)]);
  subject.removeTab(1, { windowId: 10, isWindowClosing: false });
  subject.removeTab(2, { windowId: 10, isWindowClosing: false });
  subject.removeTab(3, { windowId: 11, isWindowClosing: false });

  const first = subject.flushBatch(10);
  const second = subject.flushBatch(11);
  assert.equal(first.event.kind, 'group');
  assert.deepEqual(first.event.tabs.map((item) => item.id), ['1', '2']);
  assert.equal(second.event.kind, 'single');
});

test('window removal uses the last durable window snapshot as one complete group', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);

  const result = subject.removeWindow(10);
  assert.equal(result.event.kind, 'group');
  assert.equal(result.event.sourceWindowId, 10);
  assert.deepEqual(result.event.tabs.map((item) => item.url), [
    'https://example.com/1',
    'https://example.com/2',
  ]);
});

test('a whole window with one http tab is still recorded as a group', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0)]);
  assert.equal(subject.removeWindow(10).event.kind, 'group');
});

test('returned events are deep copies of the durable outbox', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0)]);
  subject.removeTab(1, { windowId: 10 });
  const ordinary = subject.flushBatch(10).event;
  ordinary.tabs[0].title = 'mutated';
  assert.equal(subject.pendingEvents()[0].event.tabs[0].title, 'Tab 1');

  const second = tracker();
  second.hydrate([tab(2, 20, 0)]);
  const wholeWindow = second.removeWindow(20).event;
  wholeWindow.tabs[0].title = 'mutated';
  assert.equal(second.pendingEvents()[0].event.tabs[0].title, 'Tab 2');
});

test('window removal cancels a pending tab-first batch and prevents duplicate tab removals', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  subject.removeTab(1, { windowId: 10, isWindowClosing: true });

  const windowResult = subject.removeWindow(10);
  const lateTabResult = subject.removeTab(2, { windowId: 10, isWindowClosing: true });
  assert.deepEqual(windowResult.event.tabs.map((item) => item.id), ['1', '2']);
  assert.equal(subject.flushBatch(10).event, null);
  assert.equal(lateTabResult.ignored, true);
});

test('window-first order records once and ignores subsequent tab removals', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  const windowResult = subject.removeWindow(10);

  assert.ok(windowResult.event);
  assert.equal(subject.removeTab(1, { windowId: 10, isWindowClosing: true }).ignored, true);
  assert.equal(subject.removeTab(2, { windowId: 10, isWindowClosing: true }).ignored, true);
});

test('serialized session state contains window snapshots and pending batches for restart', () => {
  const first = tracker();
  first.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  first.removeTab(1, { windowId: 10, isWindowClosing: false });
  const durableState = structuredClone(first.getState());

  assert.deepEqual(durableState.windowSnapshotsById['10'].tabIds, ['1', '2']);
  assert.deepEqual(durableState.pendingBatches['10'].tabIds, ['1']);

  const restarted = tracker(durableState);
  const result = restarted.flushBatch(10);
  assert.deepEqual(result.event.tabs.map((item) => item.id), ['1']);
  assert.equal(restarted.getState().pendingBatches['10'], undefined);
});

test('restart exposes window-closing batches for direct window recovery without a timer', () => {
  const first = tracker();
  first.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  first.removeTab(1, { windowId: 10, isWindowClosing: true });

  const restarted = tracker(first.getState());
  assert.deepEqual(restarted.getPendingBatches(), [{
    windowId: 10,
    mode: 'normal',
    tabIds: ['1'],
    closedAt: 1700000000000,
    windowClosing: true,
  }]);
  assert.deepEqual(restarted.removeWindow(10).event.tabs.map((item) => item.id), ['1', '2']);
});

test('startup recovery consumes only window-closing batches whose window is no longer live', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 20, 0)]);
  subject.removeTab(1, { windowId: 10, isWindowClosing: true });
  subject.removeTab(2, { windowId: 20, isWindowClosing: true });

  const recovered = subject.recoverClosedWindows([20]);
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0].sourceWindowId, 10);
  assert.deepEqual(subject.getPendingBatches().map((item) => item.windowId), [20]);
});

test('startup recovery records durable window snapshots missing after a forced browser exit', () => {
  const first = tracker();
  first.hydrate([tab(1, 10, 0), tab(2, 10, 1), tab(3, 20, 0)]);

  const restarted = tracker(first.getState());
  const recovered = restarted.recoverMissingWindows([20]);

  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0].kind, 'group');
  assert.equal(recovered.events[0].sourceWindowId, 10);
  assert.deepEqual(recovered.events[0].tabs.map((item) => item.id), ['1', '2']);
  assert.deepEqual(restarted.getState().windowSnapshotsById['20'].tabIds, ['3']);
  assert.equal(restarted.getState().windowSnapshotsById['10'], undefined);
});

test('generated events have independent durable commit keys until acknowledged', () => {
  const first = tracker();
  first.hydrate([tab(1, 10, 0)]);
  first.removeTab(1, { windowId: 10, isWindowClosing: false });
  const result = first.flushBatch(10);

  const restarted = tracker(first.getState());
  assert.equal(restarted.pendingEvents()[0].event.id, result.event.id);
  assert.match(restarted.pendingEvents()[0].commitKey, /^close-/);
  restarted.acknowledgeEvent(restarted.pendingEvents()[0].commitKey);
  assert.deepEqual(restarted.pendingEvents(), []);
});

test('colliding generated ids still produce distinct stable event ids and batch ids', () => {
  const make = (state) => createCloseTracker({
    mode: 'normal',
    now: () => 1700000000000,
    createId: () => 'same-event-id',
  }, state);
  const subject = make();
  subject.hydrate([tab(1, 10, 0), tab(2, 20, 0)]);
  subject.removeTab(1, { windowId: 10 });
  subject.flushBatch(10);
  subject.removeTab(2, { windowId: 20 });
  subject.flushBatch(20);

  const entries = subject.pendingEvents();
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].event.id, entries[1].event.id);
  assert.equal(entries[0].event.id, entries[0].commitKey);
  assert.equal(entries[1].event.id, entries[1].commitKey);
  assert.equal(entries[0].event.batchId, entries[0].event.id);
  assert.equal(entries[1].event.batchId, entries[1].event.id);
  assert.notEqual(entries[0].commitKey, entries[1].commitKey);

  const restarted = make(subject.getState());
  assert.deepEqual(restarted.pendingEvents(), entries);

  const historyState = {
    settings: {},
    events: { normal: entries.map((entry) => entry.event), incognito: [] },
  };
  assert.equal(deleteEvent(historyState, 'normal', entries[0].event.id), true);
  assert.deepEqual(historyState.events.normal.map((event) => event.id), [entries[1].event.id]);
  assert.deepEqual(getRestoreUrls(historyState.events.normal[0]), ['https://example.com/2']);
});

test('hydrate preserves closed snapshots required by restored pending batches', () => {
  const first = tracker();
  first.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  first.removeTab(1, { windowId: 10, isWindowClosing: false });

  const restarted = tracker(first.getState());
  restarted.hydrate([tab(2, 10, 0)]);
  assert.equal(restarted.getState().tabSnapshotsById['1'].url, 'https://example.com/1');
  assert.equal(restarted.flushBatch(10).event.tabs[0].id, '1');
});

test('hydrate removes stale tabs from a still-open window when no close is pending', () => {
  const first = tracker();
  first.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);

  const restarted = tracker(first.getState());
  restarted.hydrate([tab(2, 10, 0)]);
  assert.equal(restarted.getState().tabSnapshotsById['1'], undefined);
  assert.deepEqual(restarted.getState().windowSnapshotsById['10'].tabIds, ['2']);
});

test('filters non-http tabs and rejects snapshots from the other context', () => {
  const subject = tracker();
  subject.hydrate([
    tab(1, 10, 0, { url: 'chrome://settings' }),
    tab(2, 10, 1, { incognito: true }),
    tab(3, 10, 2),
  ]);
  subject.removeTab(3, { windowId: 10, isWindowClosing: false });

  const result = subject.flushBatch(10);
  assert.deepEqual(result.event.tabs.map((item) => item.id), ['3']);
});

test('consumed window ids expire after the deduplication ttl', () => {
  let currentTime = 1000;
  const subject = createCloseTracker({
    mode: 'normal',
    now: () => currentTime,
    consumedWindowTtlMs: 300000,
  });
  subject.hydrate([tab(1, 10, 0)]);
  subject.removeWindow(10);
  assert.equal(subject.removeTab(1, { windowId: 10 }).ignored, true);

  currentTime += 300001;
  subject.upsertTab(tab(2, 20, 0));
  assert.equal(subject.getState().consumedWindowIds['10'], undefined);
});

test('background loads tracker and repository and derives its partition from worker context', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(source, /importScripts\(\s*'lib\/history-store\.js',[\s\S]*'lib\/storage-repository\.js',[\s\S]*'lib\/close-tracker\.js'\s*\)/);
  assert.match(source, /chrome\.extension\.inIncognitoContext\s*\?\s*'incognito'\s*:\s*'normal'/);
  assert.match(source, /tabEcho:close-tracker:.*activeMode/);
  assert.match(source, /chrome\.tabs\.onDetached\.addListener/);
  assert.match(source, /chrome\.tabs\.onAttached\.addListener/);
  assert.match(source, /if \(!result\.ignored && !result\.windowClosing\)[\s\S]*scheduleBatchFlush/);
  assert.match(source, /createTrackerPersistence/);
  assert.doesNotMatch(source, /storage\.local\.set\(\{\s*\[?STORAGE_KEY/);
});

function memoryArea(initial = {}, failure = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) {
      if (failure.get) throw new Error(failure.get);
      return { [key]: structuredClone(values[key]) };
    },
    async set(items) {
      if (failure.set) throw new Error(failure.set);
      Object.assign(values, structuredClone(items));
    },
    async remove(key) {
      if (failure.remove) throw new Error(failure.remove);
      delete values[key];
    },
  };
}

test('tracker persistence falls back to local when session is missing or rejects', async () => {
  const local = memoryArea({ 'tracker:normal': { source: 'local' } });
  const missingSession = createTrackerPersistence(null, local, 'tracker:normal');
  assert.deepEqual(await missingSession.load(), { source: 'local' });
  await missingSession.save({ saved: 1 });
  assert.deepEqual(local.values['tracker:normal'], { saved: 1, revision: 1 });

  const rejectingSession = memoryArea({}, { get: 'session failed', set: 'session failed' });
  const fallback = createTrackerPersistence(rejectingSession, local, 'tracker:normal');
  assert.deepEqual(await fallback.load(), { saved: 1, revision: 1 });
  await fallback.save({ saved: 2 });
  assert.deepEqual(local.values['tracker:normal'], { saved: 2, revision: 2 });
});

test('tracker persistence mirrors successful session writes to local for browser-restart recovery', async () => {
  const key = 'tracker:normal';
  const session = memoryArea();
  const local = memoryArea();
  const persistence = createTrackerPersistence(session, local, key);

  await persistence.save({ windowSnapshotsById: { 10: { tabIds: ['1'] } } });

  assert.deepEqual(local.values[key], session.values[key]);
  assert.deepEqual(local.values[key].windowSnapshotsById['10'].tabIds, ['1']);
});

test('tracker persistence reports when an empty session recovers a local browser snapshot', async () => {
  const key = 'tracker:normal';
  const session = memoryArea();
  const local = memoryArea({ [key]: { revision: 4, windowSnapshotsById: { 10: { tabIds: ['1'] } } } });
  const persistence = createTrackerPersistence(session, local, key);

  await persistence.load();

  assert.equal(persistence.recoveredAfterSessionLoss(), true);
});

test('an empty session recovers local outbox and keeps subsequent acknowledgement in local', async () => {
  const key = 'tracker:normal';
  const staleOutbox = { pendingEventsById: { one: { commitKey: 'one' } } };
  const session = memoryArea({});
  const local = memoryArea({
    [key]: staleOutbox,
    'tracker:incognito': { untouched: true },
  });

  const firstWorker = createTrackerPersistence(session, local, key);
  assert.deepEqual(await firstWorker.load(), staleOutbox);
  await firstWorker.save({ pendingEventsById: {} });

  const secondWorker = createTrackerPersistence(session, local, key);
  assert.deepEqual(await secondWorker.load(), { pendingEventsById: {}, revision: 1 });
  assert.deepEqual(local.values['tracker:incognito'], { untouched: true });
  assert.deepEqual(session.values[key], local.values[key]);
  assert.equal(secondWorker.recoveredAfterSessionLoss(), false);
});

test('tracker persistence rejects when both durable areas fail', async () => {
  const session = memoryArea({}, { set: 'session failed' });
  const local = memoryArea({}, { set: 'local failed' });
  const persistence = createTrackerPersistence(session, local, 'tracker:incognito');
  await assert.rejects(persistence.save({ pending: true }), /local failed/);
});

test('tracker persistence selects the higher revision and prevents stale session replay', async () => {
  const key = 'tracker:normal';
  const session = memoryArea({ [key]: { revision: 9, marker: 'S9' } }, { set: 'session write failed' });
  const local = memoryArea({ [key]: { revision: 10, marker: 'L10' } });
  const persistence = createTrackerPersistence(session, local, key);

  assert.equal((await persistence.load()).marker, 'L10');
  await persistence.save({ marker: 'L11' });
  assert.equal(local.values[key].revision, 11);

  const restarted = createTrackerPersistence(session, local, key);
  assert.equal((await restarted.load()).marker, 'L11');
});

test('tracker persistence tolerates one read failure and treats legacy state as revision zero', async () => {
  const key = 'tracker:incognito';
  const session = memoryArea({}, { get: 'session read failed' });
  const local = memoryArea({ [key]: { legacy: true } });
  const persistence = createTrackerPersistence(session, local, key);
  assert.deepEqual(await persistence.load(), { legacy: true });

  const localFailure = memoryArea({}, { get: 'local read failed' });
  const validSession = memoryArea({ [key]: { revision: 2, source: 'session' } });
  assert.equal((await createTrackerPersistence(validSession, localFailure, key).load()).source, 'session');
});

test('tracker persistence keeps the latest local mirror when a later session write fails', async () => {
  const key = 'tracker:normal';
  let sessionSetCalls = 0;
  const session = memoryArea({ [key]: { revision: 1, marker: 'S1' } });
  session.set = async (items) => {
    sessionSetCalls += 1;
    if (sessionSetCalls === 2) throw new Error('session fallback');
    Object.assign(session.values, structuredClone(items));
  };
  const local = memoryArea({ [key]: { revision: 1, marker: 'L1' } });
  const persistence = createTrackerPersistence(session, local, key);
  await persistence.load();

  await persistence.save({ marker: 'S2' });
  await persistence.save({ marker: 'L3' });
  assert.deepEqual(local.values[key], { revision: 3, marker: 'L3' });
  assert.equal(session.values[key], undefined);
});

test('tracker persistence keeps identical revisions in session and local after a successful save', async () => {
  const key = 'tracker:normal';
  const session = memoryArea({ [key]: { revision: 4, marker: 'S4' } });
  const local = memoryArea({ [key]: { revision: 3, marker: 'L3' } });
  const persistence = createTrackerPersistence(session, local, key);
  await persistence.load();
  await assert.doesNotReject(persistence.save({ marker: 'S5' }));
  assert.deepEqual(session.values[key], { revision: 5, marker: 'S5' });
  assert.deepEqual(local.values[key], { revision: 5, marker: 'S5' });

  const restarted = createTrackerPersistence(session, local, key);
  assert.equal((await restarted.load()).marker, 'S5');
});

test('background initialization retries after failure without concurrent duplicate initialization', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const listeners = {};
  let migrationAttempts = 0;
  let queryAttempts = 0;
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });
  const context = {
    clearTimeout, setTimeout, structuredClone, console: { error() {} },
    self: {
      TabEchoHistoryStore: require('../lib/history-store.js'),
      TabEchoStorageRepository: { createStorageRepository() {
        return {
          async migrateLegacyState() {
            migrationAttempts += 1;
            if (migrationAttempts === 1) throw new Error('first init fails');
          },
          async updateContext() {}, async readContext() { return { settings: {}, history: [], trash: [] }; },
          async saveSettings() {},
        };
      } },
      TabEchoCloseTracker: require('../lib/close-tracker.js'),
    },
    importScripts() {},
    chrome: {
      extension: { inIncognitoContext: false },
      storage: { local: memoryArea(), session: memoryArea() },
      runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
      tabs: {
        onCreated: event('created'), onUpdated: event('updated'), onMoved: event('moved'),
        onDetached: event('detached'), onAttached: event('attached'), onRemoved: event('removed'),
        async query() { queryAttempts += 1; return []; }, async create() {},
      },
      windows: { onRemoved: event('windowRemoved'), async getAll() { return []; }, async create() {} },
    },
  };
  vm.runInNewContext(source, context, { filename: 'background.js' });
  await new Promise((resolve) => setImmediate(resolve));
  listeners.created(tab(1, 10, 0));
  listeners.updated(1, { title: 'x' }, tab(1, 10, 0, { title: 'x' }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(migrationAttempts, 2);
  assert.equal(queryAttempts, 1);
});
