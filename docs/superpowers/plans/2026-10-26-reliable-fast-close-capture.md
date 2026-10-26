# Reliable Fast-Close Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Tab Echo close records when a tab closes before navigation commits or after Chrome replaces its tab ID.

**Architecture:** Keep the existing tracker/outbox/repository pipeline. Make snapshots accept an HTTP(S) `pendingUrl` only when no committed HTTP(S) `url` exists, add an in-place tracker ID migration, and wire `tabs.onReplaced` through the existing serialized mutation queue.

**Tech Stack:** Manifest V3 service worker, vanilla JavaScript UMD modules, `chrome.tabs`, Node.js built-in test runner and VM-based Background harness.

---

### Task 1: Capture a pending HTTP URL without replacing a committed page

**Files:**
- Modify: `tests/close-tracker.test.js`
- Modify: `extension/lib/close-tracker.js`

- [x] **Step 1: Write failing tracker tests**

Add tests equivalent to:

```js
test('a new tab pending HTTP URL survives an ordinary fast close', () => {
  const subject = tracker();
  subject.upsertTab(tab(1, 10, 0, { url: '', pendingUrl: 'https://pending.example/' }));
  const result = subject.removeTab(1, { windowId: 10, isWindowClosing: false });
  assert.equal(result.event.tabs[0].url, 'https://pending.example/');
});

test('a committed HTTP URL wins over a different pending navigation', () => {
  const subject = tracker();
  subject.upsertTab(tab(1, 10, 0, {
    url: 'https://committed.example/', pendingUrl: 'https://pending.example/',
  }));
  const result = subject.removeTab(1, { windowId: 10, isWindowClosing: false });
  assert.equal(result.event.tabs[0].url, 'https://committed.example/');
});
```

Adapt the existing `tab()` helper to accept an optional patch object without changing existing callers.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='pending HTTP URL|committed HTTP URL wins' tests/close-tracker.test.js
```

Expected: the pending-only case fails because no snapshot/event exists; the committed case passes.

- [x] **Step 3: Implement URL selection in `snapshotTab()`**

Select the restorable URL without mutating the input:

```js
const url = isHttpUrl(tab && tab.url)
  ? String(tab.url)
  : isHttpUrl(tab && tab.pendingUrl) ? String(tab.pendingUrl) : null;
if (!tab || !Number.isInteger(tab.id) || !url) return null;
```

Use `url` for the snapshot title fallback and stored URL. Keep the mode and ID validation unchanged.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the Task 1 command again. Expected: both tests pass.

### Task 2: Migrate snapshots when Chrome replaces a tab ID

**Files:**
- Modify: `tests/close-tracker.test.js`
- Modify: `extension/lib/close-tracker.js`

- [x] **Step 1: Write failing tracker migration tests**

Add tests equivalent to:

```js
test('replacing a tab id preserves its snapshot and window position', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  const result = subject.replaceTabId(20, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.state.tabSnapshotsById['1'], undefined);
  assert.equal(result.state.tabSnapshotsById['20'].url, 'https://1.example/');
  assert.deepEqual(result.state.windowSnapshotsById['10'].tabIds, ['20', '2']);
  assert.equal(subject.removeTab(20, { windowId: 10, isWindowClosing: false }).event.tabs[0].id, '20');
});

test('replacing an unknown or invalid tab id is a safe no-op', () => {
  const subject = tracker();
  assert.equal(subject.replaceTabId(20, 1).accepted, false);
  assert.equal(subject.replaceTabId(20, 20).accepted, false);
});
```

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='replacing a tab id|replacing an unknown' tests/close-tracker.test.js
```

Expected: FAIL because `replaceTabId` is not exported.

- [x] **Step 3: Implement `replaceTabId()`**

Validate integer IDs, look up the old snapshot, and return `{ accepted: false, state }` for invalid, identical or unknown IDs. Otherwise:

```js
const previous = state.tabSnapshotsById[String(removedTabId)];
delete state.tabSnapshotsById[String(removedTabId)];
state.tabSnapshotsById[String(addedTabId)] = {
  ...previous,
  id: String(addedTabId),
};
const windowSnapshot = state.windowSnapshotsById[String(previous.sourceWindowId)];
if (windowSnapshot) {
  windowSnapshot.tabIds = windowSnapshot.tabIds.map((id) => (
    String(id) === String(removedTabId) ? String(addedTabId) : String(id)
  ));
  sortWindow(windowSnapshot);
}
```

Export `replaceTabId` from the tracker instance.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the Task 2 command again. Expected: both tests pass.

### Task 3: Wire the missing Chrome lifecycle events through Background

**Files:**
- Modify: `tests/background-contract.test.js`
- Modify: `extension/background.js`

- [x] **Step 1: Extend the Background harness and write failing event-chain tests**

Add `replaced: chromeEvent()` and expose it as `chrome.tabs.onReplaced`.

Add tests equivalent to:

```js
test('a pending-url tab closed before commit is immediately visible', async () => {
  const subject = await loadBackground();
  subject.events.created.listeners[0]({
    id: 801, windowId: 80, index: 0, incognito: false,
    title: 'Pending', url: '', pendingUrl: 'https://pending.example/',
  });
  subject.events.removed.listeners[0](801, { windowId: 80, isWindowClosing: false });
  const history = await subject.message({ type: 'get-history' });
  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].url, 'https://pending.example/');
});

test('a replaced tab id remains recordable through its new id', async () => {
  const subject = await loadBackground({ tabs: [{
    id: 1, windowId: 10, index: 0, incognito: false,
    title: 'Prerender', url: 'https://prerender.example/',
  }] });
  subject.events.replaced.listeners[0](2, 1);
  subject.events.removed.listeners[0](2, { windowId: 10, isWindowClosing: false });
  const history = await subject.message({ type: 'get-history' });
  assert.equal(history.statistics.totalRecords, 1);
  assert.equal(history.results[0].event.tabs[0].url, 'https://prerender.example/');
});
```

Also add a loading update case with `pendingUrl` so both `onCreated` and `onUpdated` paths exercise the fallback.

- [x] **Step 2: Run Background tests and verify RED**

Run:

```bash
node --test --test-name-pattern='pending-url tab|loading pending URL|replaced tab id' tests/background-contract.test.js
```

Expected: pending URL cases report 0 records and the replaced listener is missing.

- [x] **Step 3: Register `tabs.onReplaced`**

Wire it into the existing tracker queue:

```js
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  enqueueTrackerMutation(async () => {
    tracker.replaceTabId(addedTabId, removedTabId);
    await persistTrackerState();
    await commitAllPendingEvents();
  }).catch(reportError);
});
```

Do not add a separate queue or new storage path.

- [x] **Step 4: Run Background tests and verify GREEN**

Run the Task 3 command again. Expected: all event-chain tests pass.

### Task 4: Full regression and delivery

**Files:**
- Verify: `extension/background.js`
- Verify: `extension/lib/close-tracker.js`
- Verify: `tests/background-contract.test.js`
- Verify: `tests/close-tracker.test.js`

- [x] **Step 1: Run full tests and static checks**

Run:

```bash
npm test
npm run check
```

Expected: all tests pass and all checks exit 0.

- [x] **Step 2: Re-run the original deterministic reproduction**

Run a Background harness for:

```text
onCreated(url='', pendingUrl='https://fast-close.example/') -> onRemoved
```

Expected: `records: 1` with the pending URL.

- [x] **Step 3: Review the diff and repository hygiene**

Run:

```bash
git diff --check
git diff --stat
git status --short
```

Expected: only the tracker, Background, tests and implementation plan differ from the design commit.

- [x] **Step 4: Prepare the implementation commit after confirmation**

Proposed message:

```text
fix: capture fast and replaced tab closes
```
