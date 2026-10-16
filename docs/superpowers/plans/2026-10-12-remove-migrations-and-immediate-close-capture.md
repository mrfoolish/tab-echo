# Remove Migrations and Capture Ordinary Closes Immediately Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unreleased-version migration compatibility and make ordinary tab closes immediately visible while preserving whole-window Groups.

**Architecture:** The final repository uses an IndexedDB generation pointer as the sole authority for regular records and the local partition for incognito records. The close tracker writes every ordinary `tabs.onRemoved` event directly to its durable outbox; only `windows.onRemoved` builds a Group from a complete window snapshot.

**Tech Stack:** Chrome Extension Manifest V3, JavaScript UMD modules, IndexedDB, `chrome.storage.local/session`, Node.js built-in test runner.

---

### Task 1: Lock down immediate ordinary-close behavior

**Files:**
- Modify: `tests/close-tracker.test.js`
- Modify: `tests/background-contract.test.js`
- Modify: `extension/lib/close-tracker.js`
- Modify: `extension/background.js`

- [ ] **Step 1: Replace the ordinary-close aggregation test with failing immediate-event tests**

Add tracker assertions equivalent to:

```js
test('ordinary removals create independent durable single events immediately', () => {
  const subject = tracker();
  subject.hydrate([tab(1, 10, 0), tab(2, 10, 1)]);
  const first = subject.removeTab(1, { windowId: 10, isWindowClosing: false });
  const second = subject.removeTab(2, { windowId: 10, isWindowClosing: false });
  assert.equal(first.event.kind, 'single');
  assert.equal(second.event.kind, 'single');
  assert.deepEqual(subject.pendingEvents().map((item) => item.event.tabs[0].id), ['1', '2']);
});
```

Add a Background contract that fires `tabs.onRemoved`, immediately calls `get-history`, and expects one record without sleeping.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='ordinary removals create independent|ordinary close is immediately visible' tests/close-tracker.test.js tests/background-contract.test.js
```

Expected: FAIL because `removeTab()` has no immediate `event` and history remains empty until the 450ms timer fires.

- [ ] **Step 3: Remove ordinary pending batches from the tracker**

Change `removeTab()` so an ordinary close builds one event, puts it in `pendingEventsById`, removes the closed snapshot, and returns the event. For `isWindowClosing`, leave the full window snapshot untouched so `removeWindow()` remains authoritative.

Remove `pendingBatches`, `flushBatch()`, `pendingWindowIds()`, `getPendingBatches()` and `recoverClosedWindows()`. Update state normalization so older in-memory shapes are ignored rather than migrated.

- [ ] **Step 4: Remove the 450ms timer path from Background**

Delete `CLOSE_BATCH_DELAY_MS`, `flushTimers`, `scheduleBatchFlush()`, `cancelBatchFlush()` and `flushBatch()`. In `tabs.onRemoved`, persist the tracker outbox immediately and then call `commitAllPendingEvents()`. Keep `windows.onRemoved` as the only Group creation path.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 command again. Expected: both tests PASS, with no timer wait.

### Task 2: Make the IndexedDB repository a final-state store

**Files:**
- Modify: `tests/indexeddb-storage-repository.test.js`
- Modify: `extension/lib/indexeddb-storage-repository.js`
- Delete: `extension/lib/indexeddb-migration.js`
- Delete: `tests/indexeddb-migration.test.js`

- [ ] **Step 1: Add failing final-state repository tests**

Add tests equivalent to:

```js
test('regular records ignore local arrays when no IndexedDB generation exists', async () => {
  const repository = createRepositoryWithLocalRegularArrays();
  const context = await repository.readContext('normal');
  assert.deepEqual(context.history, []);
  assert.deepEqual(context.trash, []);
});

test('the first regular write creates an IndexedDB generation directly', async () => {
  const repository = createFreshRepository();
  await repository.updateContext('normal', (context) => ({
    history: [makeEvent('first')], trash: context.trash,
  }));
  assert.equal((await repository.readHistory('normal'))[0].id, 'first');
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test tests/indexeddb-storage-repository.test.js
```

Expected: the no-generation read exposes local regular arrays or the repository still requires migration metadata.

- [ ] **Step 3: Remove migration-module dependencies**

Define the regular generation keys directly in `indexeddb-storage-repository.js`. Move the small scheduler-yield helper there because it supports large final-state rewrites rather than migration.

Use a generation pointer alone to identify active IndexedDB data:

```js
const indexed = indexedModes.has(mode) && typeof generation === 'string' && generation;
```

For an indexed mode with no pointer, return empty history/trash and current settings/revisions. Never delegate that mode to local history arrays. The first update stages and commits a generation through the existing atomic generation writer.

- [ ] **Step 4: Delete migration implementation and tests**

Delete `extension/lib/indexeddb-migration.js` and `tests/indexeddb-migration.test.js`. Remove migrate/restore exports and marker reads from the IndexedDB storage repository.

- [ ] **Step 5: Run the IndexedDB repository suites**

Run:

```bash
node --test tests/indexeddb-repository.test.js tests/indexeddb-storage-repository.test.js
```

Expected: PASS with fresh initialization, regular IndexedDB reads, incremental updates and incognito local delegation intact.

### Task 3: Remove legacy v1 migration and notice protocol

**Files:**
- Modify: `tests/storage-repository.test.js`
- Modify: `tests/background-contract.test.js`
- Modify: `tests/popup-ui.test.js`
- Modify: `tests/dashboard-ui.test.js`
- Modify: `tests/close-tracker.test.js`
- Modify: `extension/lib/storage-repository.js`
- Modify: `extension/background.js`
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`
- Modify: `extension/popup.css`
- Modify: `extension/dashboard.js`
- Modify: `extension/dashboard.html`
- Modify: `extension/dashboard.css`

- [ ] **Step 1: Add a failing removal contract**

Add a source contract asserting that production files no longer contain:

```js
for (const forbidden of [
  'tabEchoState', 'migration-notice', 'migrateLegacyState', 'indexeddb-migration.js',
]) assert.doesNotMatch(productionSource, new RegExp(forbidden));
```

Assert that Popup and Dashboard no longer contain `id="migrationNotice"`.

- [ ] **Step 2: Run the contract and verify RED**

Run:

```bash
node --test --test-name-pattern='production has no unreleased migration compatibility' tests/docs-contract.test.js
```

Expected: FAIL on existing migration imports, methods, keys and UI nodes.

- [ ] **Step 3: Simplify the local storage repository**

Remove migration keys, notice normalization and acknowledgement, legacy settings conversion, migration queues and `migrateLegacyState()`. Preserve settings, partitioned local context operations, validation, revisions, serialization and bounded retries.

- [ ] **Step 4: Remove Background and UI migration entry points**

Delete the migration import and initialization call from Background, plus `get-migration-notice` and `acknowledge-migration-notice`. Remove Popup/Dashboard notice requests, bilingual copy, HTML nodes and CSS.

- [ ] **Step 5: Remove obsolete migration tests and repair fixtures**

Delete migration-only cases while retaining storage atomicity, split-context isolation, retry and initialization-retry coverage. Replace test fixtures that depended on migration markers with final-state settings/generation fixtures.

- [ ] **Step 6: Run storage and UI suites**

Run:

```bash
node --test tests/storage-repository.test.js tests/background-contract.test.js tests/popup-ui.test.js tests/dashboard-ui.test.js tests/close-tracker.test.js tests/docs-contract.test.js
```

Expected: PASS with no migration protocol or UI references.

### Task 4: Update product and architecture documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `proposal.md`
- Modify: `docs/adr/0003-keep-incognito-records-out-of-indexeddb.md`
- Modify: `docs/testing/2026-09-18-manual-acceptance.md`
- Modify: `docs/superpowers/specs/2026-10-10-repository-layout-and-storage-pressure-design.md`
- Modify: `tests/docs-contract.test.js`

- [ ] **Step 1: Make documentation contracts describe only final behavior**

Assert that current product docs describe regular IndexedDB storage, incognito local storage, immediate ordinary closes and whole-window Groups, while excluding automatic migration and old defaults.

- [ ] **Step 2: Run documentation tests and verify RED**

Run:

```bash
node --test tests/docs-contract.test.js
```

Expected: FAIL while README/proposal still advertise migration.

- [ ] **Step 3: Update current documentation**

Remove data-migration sections and old-default language. Remove `indexeddb-migration.js` from repository trees. Update acceptance cases to require immediate ordinary-close visibility, independent records for consecutive ordinary closes, and one Group for a whole-window close. Keep historical plan documents unchanged as historical records.

- [ ] **Step 4: Run documentation tests and verify GREEN**

Run the Task 4 command again. Expected: PASS.

### Task 5: Full verification and delivery

**Files:**
- Verify all modified and deleted files.

- [ ] **Step 1: Search for unintended compatibility remnants**

Run:

```bash
rg -n 'tabEchoState|migration-notice|migrateLegacyState|indexeddb-migration|65536' extension tests README.md README.zh.md proposal.md docs/adr docs/testing docs/superpowers/specs
```

Expected: no production/current-product matches; the new design may name removed identifiers when documenting the removal.

- [ ] **Step 2: Run the full automated suite**

Run:

```bash
npm test
npm run check
```

Expected: all tests pass and checks exit 0.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --stat
git diff --check
git status --short
```

Expected: only intended source, test and current-documentation changes; `.DS_Store`, `.superpowers/`, `.trae/` and `log/` remain untracked and unstaged.

- [ ] **Step 4: Commit implementation after user confirmation**

Prepare a Conventional Commit summary such as:

```text
refactor: remove legacy migrations and record closes immediately
```

Do not push until the user confirms the completed implementation and explicitly requests the push.
