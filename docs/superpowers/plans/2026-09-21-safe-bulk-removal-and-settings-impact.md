# Safe Bulk Removal and Settings Impact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add query-wide permanent removal with inline confirmation to the Dashboard and Popup, replace native Trash confirmation, and merge excluded-domain cleanup into the settings save impact flow.

**Architecture:** Extend the existing background message protocols so query-wide deletion and settings-plus-cleanup execute against the trusted active browsing partition. Keep presentation state local to `popup.js` and `dashboard.js`, but use the same inline confirmation semantics and invalidate confirmation state whenever its query or view changes. Extend pure history-store helpers for newly added exclusion rules and detailed retention impact so backend behavior remains independently testable.

**Tech Stack:** Chrome Manifest V3, browser-owned JavaScript without bundling, HTML/CSS, Node.js `node:test`, VM-based UI contract tests.

---

This repository currently has no tracked baseline. Do not create Git commits during execution; use focused test checkpoints instead.

### Task 1: Extend Pure Impact and Exclusion Helpers

**Files:**
- Modify: `extension/lib/history-store.js:230-355`
- Test: `extension/tests/history-store.test.js`

- [ ] **Step 1: Add failing tests for newly added exclusions and detailed impact**

Add tests asserting that:

```js
assert.deepEqual(getAddedExcludedDomains(['old.test'], ['old.test', 'new.test']), ['new.test']);
assert.deepEqual(getAddedExcludedDomains(['a.test', 'b.test'], ['b.test']), []);

const impact = previewSettingsImpact(history, trash, currentSettings, {
  ...currentSettings,
  maxRecords: 1,
  excludedDomains: ['new.test'],
});
assert.deepEqual(impact.addedExcludedDomains, ['new.test']);
assert.equal(impact.retention.historyEventCount, 1);
assert.equal(impact.exclusions.totalTabCount, 1);
assert.equal(impact.combined.totalEventCount, 2);
```

Also cover overlap, where the same event is removed by retention and contains an excluded tab; `combined` must count the affected event and tab only once.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test --test-name-pattern='added exclusions|settings impact' extension/tests/history-store.test.js`

Expected: FAIL because `getAddedExcludedDomains` and `previewSettingsImpact` are not exported.

- [ ] **Step 3: Implement the pure helpers**

Add these APIs to `history-store.js`:

```js
function getAddedExcludedDomains(currentDomains, nextDomains) {
  const current = new Set(normalizeExcludedDomains(currentDomains));
  return normalizeExcludedDomains(nextDomains).filter((domain) => !current.has(domain));
}

function previewSettingsImpact(history, trash, currentSettings, nextSettings, now = Date.now()) {
  const addedExcludedDomains = getAddedExcludedDomains(
    currentSettings && currentSettings.excludedDomains,
    nextSettings && nextSettings.excludedDomains,
  );
  // Return retention, exclusions, and a de-duplicated combined impact.
}
```

Build `combined` by applying retention first, then applying only `addedExcludedDomains` to the retained records, and derive total removed events/tabs against the original sources. Return enough per-cause counts for the UI to explain maximum-count, History-age, Trash-age, and new-domain effects without mutating inputs. Export both helpers.

- [ ] **Step 4: Add a scoped cleanup helper**

Add and export:

```js
function applySettingsAndOptionalExclusionCleanup(history, trash, settings, addedDomains, removeExisting, now = Date.now()) {
  const retainedHistory = pruneHistoryEntries(history, settings, now);
  const retainedTrash = pruneTrashEntries(trash, settings, now);
  if (!removeExisting || !addedDomains.length) {
    return { history: retainedHistory, trash: retainedTrash };
  }
  const cleaned = deleteExcludedDomainMatches(retainedHistory, retainedTrash, addedDomains);
  return { history: cleaned.history, trash: cleaned.trash };
}
```

Test that only newly added domains are cleaned, partial groups retain unmatched tabs, and existing exclusion rules are not reapplied.

- [ ] **Step 5: Run helper tests**

Run: `node --test extension/tests/history-store.test.js`

Expected: all history-store tests PASS.

### Task 2: Extend Background Protocols Atomically

**Files:**
- Modify: `extension/background.js:304-388`
- Test: `extension/tests/background-contract.test.js`

- [ ] **Step 1: Add failing query-wide History deletion tests**

Cover these messages:

```js
await subject.message({ type: 'permanently-delete-history', all: true, query: 'needle' });
await subject.message({ type: 'permanently-delete-history', all: true, query: '' });
```

Assert that the first deletes every complete matching event, the second deletes all History, neither writes to Trash, other browsing partitions remain unchanged, and `{ all: true, eventIds: [...] }` or a request without either selection returns `INVALID_REQUEST`.

- [ ] **Step 2: Run the background protocol test and verify failure**

Run: `node --test --test-name-pattern='query-wide history removal' extension/tests/background-contract.test.js`

Expected: FAIL because History deletion currently accepts only `eventIds`.

- [ ] **Step 3: Reuse `selectedEventIds` for History permanent deletion**

Change the handler to select IDs inside the serialized partition update:

```js
if (action === 'permanently-delete-history') {
  return repository.updateContext(activeMode, (context) => {
    const current = finalizeContext(context.history, context.trash, context.settings);
    const ids = new Set(selectedEventIds(current.history, message, 'eventIds', true).map(String));
    const history = current.history.filter((event) => !ids.has(String(event.id)));
    return {
      ...finalizeContext(history, current.trash, context.settings),
      result: { deleted: current.history.length - history.length },
    };
  });
}
```

The query path must call `buildSearchResults` and remove complete events, matching current History search semantics.

- [ ] **Step 4: Add failing combined settings preview/save tests**

Test `preview-settings-impact` returning normalized settings plus detailed retention, added-domain, and combined impact. Test `save-settings` with `removeExistingExcludedMatches: false` and `true`. Assert that saving and cleanup occur in one active-context update, only confirmed newly added domains are used, and another context remains untouched.

- [ ] **Step 5: Implement trusted settings preview and save**

For preview, compare the validated draft with `context.settings` and call `previewSettingsImpact`. For save, accept an explicit boolean `removeExistingExcludedMatches`; inside the active-context serialized update, recompute added domains from the currently persisted settings and the validated next settings before applying optional cleanup. Reject non-boolean cleanup flags. Persist settings with existing retry behavior, then apply the matching data transition without trusting a client-supplied domain list.

- [ ] **Step 6: Remove obsolete standalone exclusion cleanup protocols**

Delete `preview-excluded-domain-cleanup` and `delete-excluded-domain-matches` handlers after their replacement tests pass. Add contract assertions that Dashboard no longer sends these messages.

- [ ] **Step 7: Run background tests**

Run: `node --test extension/tests/background-contract.test.js`

Expected: all background contract tests PASS.

### Task 3: Add Dashboard Inline Confirmation Panels

**Files:**
- Modify: `extension/dashboard.html:35-115`
- Modify: `extension/dashboard.css:65-150`
- Modify: `extension/dashboard.js:15-925`
- Test: `extension/tests/dashboard-ui.test.js`

- [ ] **Step 1: Add failing Dashboard UI contracts**

Require the History heading to contain separate “Move to Trash” and bulk “Remove” actions, plus a reusable inline destructive panel with message, confirm, and cancel controls. Require a Trash inline confirmation panel. Assert that no runtime `window.confirm()` call remains.

Add VM tests proving:

```js
// First click only reveals confirmation.
assert.equal(messages.some((m) => m.type === 'permanently-delete-history'), false);
// Confirm uses all:true and the loaded query, not current page IDs.
assert.deepEqual(lastMessage, { type: 'permanently-delete-history', all: true, query: 'needle' });
```

Also verify search/view changes and Escape clear pending confirmation.

- [ ] **Step 2: Run focused Dashboard tests and verify failure**

Run: `node --test --test-name-pattern='bulk removal|inline confirmation|Empty Trash' extension/tests/dashboard-ui.test.js`

Expected: FAIL because the controls and state do not exist and Empty Trash still calls `confirm()`.

- [ ] **Step 3: Add semantic HTML for both panels**

Add `removeHistoryButton` alongside `moveHistoryButton`, followed by `historyRemovePanel` with `role="alert"`, `historyRemoveMessage`, `confirmHistoryRemoveButton`, and `cancelHistoryRemoveButton`. Add the parallel `trashEmptyPanel`, `trashEmptyMessage`, `confirmEmptyTrashButton`, and `cancelEmptyTrashButton` after the Trash heading. All panels start hidden.

- [ ] **Step 4: Add compact shared destructive panel styling**

Create a shared `.destructive-confirmation` style using the existing danger token for a narrow border, soft background, compact text, and flex-wrapped actions. Use `.danger-button` for confirmation and neutral `.secondary-button` for cancellation. Include dark-theme compatibility through existing CSS variables and a responsive rule that keeps actions usable on narrow screens.

- [ ] **Step 5: Implement Dashboard confirmation state**

Add `state.pendingDestructiveAction` with `{ kind, query, eventCount, tabCount }`. Implement:

```js
function clearDestructiveConfirmation({ restoreFocus = false } = {}) {}
function showHistoryRemovalConfirmation() {}
function showTrashEmptyConfirmation() {}
function confirmDestructiveAction() {}
```

History labels use `resultEventCount`: “全部移除” without a query and “移除 {count} 条搜索结果” with a query. Confirmation sends `{ type: 'permanently-delete-history', all: true, query: pending.query }`. Trash confirmation sends `{ type: 'empty-trash' }`. Use actual response counts in success feedback.

- [ ] **Step 6: Invalidate stale confirmation state**

Call `clearDestructiveConfirmation()` on search input, navigation, popstate, refresh failure, and Escape. Disable entry buttons when result state is stale or an action is pending. Move focus into the panel when opened and restore it to the entry on cancel where possible.

- [ ] **Step 7: Run Dashboard tests**

Run: `node --test extension/tests/dashboard-ui.test.js`

Expected: all Dashboard UI tests PASS and the existing single-entry removal still performs without confirmation.

### Task 4: Add Popup Query-Wide Removal and Inline Confirmation

**Files:**
- Modify: `extension/popup.html:25-45`
- Modify: `extension/popup.css:55-110`
- Modify: `extension/popup.js:8-305`
- Test: `extension/tests/popup-contract.test.js`

- [ ] **Step 1: Add failing Popup contracts and VM tests**

Require a second bulk action labeled from `state.totalResults`, not `state.results.length`, and an inline confirmation panel between the summary and list. Verify a Popup configured to display 10 entries but reporting 500 matches sends:

```js
{ type: 'permanently-delete-history', all: true, query: state.query }
```

only after explicit confirmation. Verify cancellation, Escape, input changes, failure feedback, and actual removed-count success text.

- [ ] **Step 2: Run focused Popup tests and verify failure**

Run: `node --test --test-name-pattern='bulk removal|confirmation' extension/tests/popup-contract.test.js`

Expected: FAIL because Popup currently only moves visible IDs to Trash.

- [ ] **Step 3: Add Popup controls and copy**

Keep the existing recoverable bulk move action and add a low-emphasis danger action: “全部移除” or “移除 {count} 条搜索结果”. Add `bulkRemovePanel`, `bulkRemoveMessage`, `confirmBulkRemoveButton`, and `cancelBulkRemoveButton`. Copy must state the full result count and “无法恢复”.

- [ ] **Step 4: Implement Popup state and event flow**

Add `pendingRemoval` to state. First click captures the current loaded query and counts, then reveals the panel without sending a mutation. Confirmation calls query-wide History deletion, refreshes the same query, and announces the actual removed count. Clear pending state on input, refresh failure, Escape, and navigation.

- [ ] **Step 5: Correct the existing move-to-Trash scope label**

Keep `bulkMoveButton` explicitly scoped to visible results because it still sends visible IDs. Its label must continue to say “移入当前显示的 {count} 条” or equivalent, while the new irreversible action clearly says “全部移除” / “移除 {count} 条搜索结果”. This prevents the two actions from implying the same scope.

- [ ] **Step 6: Run Popup tests**

Run: `node --test extension/tests/popup-contract.test.js`

Expected: all Popup tests PASS for limits 10, 100, and 200.

### Task 5: Merge Excluded-Domain Cleanup into Settings Save UI

**Files:**
- Modify: `extension/dashboard.html:84-115`
- Modify: `extension/dashboard.js:41-105, 653-922`
- Modify: `extension/dashboard.css:135-150`
- Test: `extension/tests/dashboard-ui.test.js`

- [ ] **Step 1: Add failing settings-flow tests**

Cover four cases: no impact saves directly; retention-only impact shows confirm/cancel; new-domain-only impact shows keep-existing/save-and-remove/cancel; combined impact shows retention-only cleanup/save-and-remove-all/cancel. Assert that old rules, removed rules, and edits to unrelated settings do not show domain cleanup choices.

- [ ] **Step 2: Remove standalone exclusion controls from HTML and runtime**

Remove `previewExcludedCleanupButton`, `excludedCleanupPanel`, and their confirm/cancel controls. Remove `pendingExcludedCleanup`, `clearExcludedCleanup`, and all standalone listeners. Keep the textarea and help copy.

- [ ] **Step 3: Expand the existing settings impact panel**

Give the panel a structured summary list for count limit, History age, Trash age, new excluded domains, and de-duplicated total. Add three dynamically shown actions: a primary save action whose label reflects mandatory retention cleanup, an optional “保存并移除” action for domain matches, and cancel.

- [ ] **Step 4: Implement the three save paths**

Store the full preview in `state.pendingSettingsConfirmation`. Call:

```js
saveSettings(pending.settings, { removeExistingExcludedMatches: false });
saveSettings(pending.settings, { removeExistingExcludedMatches: true });
```

Only expose the second path when `addedExcludedDomains.length > 0` and the exclusion impact is nonzero. Ensure the retention-only action remains explicit when both impact classes exist.

- [ ] **Step 5: Run Dashboard settings tests**

Run: `node --test --test-name-pattern='settings' extension/tests/dashboard-ui.test.js`

Expected: all settings tests PASS and no obsolete standalone cleanup IDs or message types remain.

### Task 6: Update Product Documentation and Acceptance Coverage

**Files:**
- Modify: `proposal.md`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `docs/testing/2026-09-18-manual-acceptance.md`
- Modify: `extension/tests/docs-contract.test.js`

- [ ] **Step 1: Update bilingual product behavior**

Document that Dashboard and Popup permanent bulk removal operates over all query results, requires inline two-stage confirmation, and bypasses Trash. Document that Empty Trash uses the same inline pattern instead of native dialogs.

- [ ] **Step 2: Replace the standalone excluded-domain cleanup workflow**

State that saving settings previews count, History age, Trash age, and newly excluded-domain impact in one place. Explain “仅保存规则” versus “保存并移除”, including the combined-impact case.

- [ ] **Step 3: Expand manual acceptance cases**

Add unchecked scenarios for query-wide removal across pagination/Popup limits, cancellation/Escape, stale query invalidation, Group semantics, browsing-context isolation, inline Trash confirmation, and combined settings impact.

- [ ] **Step 4: Update documentation contracts and run them**

Run: `node --test extension/tests/docs-contract.test.js`

Expected: PASS with no references requiring two native confirms or an independent “移除已有匹配记录” button.

### Task 7: Keep History and Trash Times Visible

**Files:**
- Modify: `extension/dashboard.js:433-548`
- Modify: `extension/dashboard.css:88-113`
- Test: `extension/tests/dashboard-ui.test.js`

- [ ] **Step 1: Add a failing rendering regression test**

Render a single History event and a single Trash event whose URL is long enough to overflow. Assert that each row contains a dedicated `.event-address` element and a separate `.event-time` element. Assert that History exposes the relative closed time and full timestamp, while Trash exposes both the relative/full closed time and relative/full moved-to-Trash time.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test --test-name-pattern='time remains visible' extension/tests/dashboard-ui.test.js`

Expected: FAIL because single rows currently append time text to the same clipped metadata span as the URL.

- [ ] **Step 3: Split address and time into separate nodes**

For a single History row, render this structure:

```js
const details = doc.createElement('span');
details.className = 'event-details-inline';
const address = doc.createElement('span');
address.className = 'event-address';
appendHighlightedText(doc, address, tab.url, ranges.url);
const time = doc.createElement('time');
setTime(time, event.closedAt, t('closedTimePrefix'));
details.append(address, time);
```

For a single Trash row, render a clipped `.event-address` plus a non-shrinking `.event-time` containing both closed and moved-to-Trash relative times. Set its `title` and accessible label to both full timestamps. Keep Group time as a dedicated non-shrinking node using the same wording.

- [ ] **Step 4: Make time non-shrinking while only the URL truncates**

Replace the broad `.event-summary span` truncation rule with role-specific rules:

```css
.event-details-inline { display: flex; min-width: 0; max-width: 62%; align-items: baseline; gap: 8px; }
.event-address { min-width: 0; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.event-time { flex: 0 0 auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
```

On narrow layouts, allow the details container to use the available row width without hiding `.event-time`.

- [ ] **Step 5: Run Dashboard rendering tests**

Run: `node --test extension/tests/dashboard-ui.test.js`

Expected: all Dashboard tests PASS, including History, Trash, Group, search highlighting, and compact single-line layout contracts.

### Task 8: Full Verification

**Files:**
- Verify: `extension/**/*.js`
- Verify: `extension/manifest.json`
- Verify: all modified documentation

- [ ] **Step 1: Run the complete automated suite**

Run: `node --test extension/tests/*.test.js`

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run syntax validation**

Run: `for file in extension/*.js extension/lib/*.js extension/tests/*.js; do node --check "$file" || exit 1; done`

Expected: exit code 0 and no output.

- [ ] **Step 3: Validate the manifest and patch formatting**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8'))"`

Run: `git diff --check`

Expected: both commands exit 0.

- [ ] **Step 4: Search for obsolete interaction paths**

Run: `rg -n "preview-excluded-domain-cleanup|delete-excluded-domain-matches|previewExcludedCleanupButton|confirmEmptyOne|confirmEmptyTwo|root\.confirm|window\.confirm" extension README.md README.zh.md proposal.md docs/testing`

Expected: no runtime or product-documentation matches; test-only negative assertions are allowed.

- [ ] **Step 5: Report manual checks without claiming they were executed**

List the Chrome interactions still requiring human acceptance: Popup height/focus behavior, long bilingual confirmation copy, light/dark visual balance, keyboard focus return, and incognito partition behavior. Keep every item unchecked until actually tested in Chrome.
