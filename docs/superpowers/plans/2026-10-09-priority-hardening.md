# Tab Echo Priority Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Tab Echo against stale destructive confirmations, extension-reload recovery mistakes, storage exhaustion, and large-history performance limits, then finish consistency, accessibility, and release-quality work in priority order.

**Architecture:** Keep the current local-only MV3 design and trusted regular/incognito partitions. Add durable revisions and one-time action tokens at the background boundary, reconcile locally mirrored tracker snapshots against live tabs, then move record collections behind an IndexedDB repository while leaving settings and small metadata in `chrome.storage.local`.

**Tech Stack:** Chrome Manifest V3, browser-owned JavaScript without bundling, Chrome storage and IndexedDB APIs, HTML/CSS, Node.js `node:test`, VM-based UI tests, Chrome DevTools MCP.

**Implementation status (2026-10-09):** Complete. All P0, P1, and P2 tasks below have been implemented and verified; remaining unchecked items in the manual acceptance document require future human interaction rather than additional implementation.

---

## Delivery boundaries

- Preserve `maxRecords = 10000`, `maxAgeDays = null`, `trashMaxAgeDays = 3`, and `popupSize = 10` defaults.
- Keep regular and incognito records isolated while sharing settings.
- Keep Trash limited only by retention age, never by record count.
- Keep single-record direct removal confirmation-free; bulk irreversible actions and destructive settings changes require inline confirmation.
- Preserve the existing uncommitted settings-copy and Popup-focus changes.
- Do not add cloud sync, host permissions, content scripts, fuzzy search, page-state restoration, import/export, or a UI framework.
- Do not create commits unless the user explicitly requests one.

## Task 1: Add durable collection and settings revisions

**Files:**
- Modify: `extension/lib/storage-repository.js`
- Modify: `extension/tests/storage-repository.test.js`

- [x] **Step 1: Add failing tests for revision reads and writes**

Add tests that expect a new repository to expose revision zero, a changed History/Trash transaction to increment only its active-context revision, and a settings write to increment a shared settings revision. Also assert that a failed storage write does not expose an incremented revision.

- [x] **Step 2: Run the focused repository tests and verify failure**

Run: `node --test --test-name-pattern='revision|atomic settings' extension/tests/storage-repository.test.js`

Expected: FAIL because `readContext()` does not return revisions and no revision keys exist.

- [x] **Step 3: Implement revision metadata**

Add storage keys:

```js
revision: {
  normal: 'tabEcho:revision:normal:v2',
  incognito: 'tabEcho:revision:incognito:v2',
},
settingsRevision: 'tabEcho:settings-revision:v2',
```

`readContext(mode)` must return `{ settings, history, trash, revision, settingsRevision }`, normalizing missing or damaged revisions to zero. `updateContext(mode, mutator)` must write the collection revision in the same `chrome.storage.local.set()` call as History and Trash.

- [x] **Step 4: Add an atomic settings-plus-context update**

Implement:

```js
updateSettingsAndContext(mode, mutator)
```

It must serialize through the active mode queue, validate the returned settings, and write settings, History, Trash, context revision, and settings revision in one storage call. The mutator receives both revisions so it can reject stale previews before any write.

- [x] **Step 5: Run repository tests**

Run: `node --test extension/tests/storage-repository.test.js`

Expected: all repository tests PASS.

## Task 2: Freeze destructive scopes with one-time tokens

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/tests/background-contract.test.js`

- [x] **Step 1: Add failing prepare/commit protocol tests**

Cover `prepare-destructive-action` for `delete-history` and `empty-trash`. A prepared response must contain an opaque token plus exact event/tab counts. After any intervening context mutation, `commit-destructive-action` must return `ACTION_STALE` without deleting data. A token may be used only once.

- [x] **Step 2: Add a session-backed action-token store**

Store a bounded token map under `tabEcho:action-tokens:<mode>:v1` in `chrome.storage.session`. Each entry contains the operation, selected IDs, context revision, creation time, and expiry time. Tokens expire after five minutes and are pruned on every access.

- [x] **Step 3: Implement prepare handlers**

For History deletion, resolve `eventIds` or `{ all: true, query }` against the current authoritative context and store the exact normalized IDs. For Empty Trash, store every current Trash ID. Return:

```js
{ token, operation, eventCount, tabCount, expiresAt }
```

- [x] **Step 4: Implement commit handlers**

Consume the token, enter `repository.updateContext()`, compare the stored revision with the latest revision, and only then apply the stored IDs. Return stable `ACTION_STALE`, `ACTION_TOKEN_INVALID`, or `ACTION_TOKEN_EXPIRED` errors without side effects.

- [x] **Step 5: Preserve single-record protocols**

Keep direct `eventIds` deletion and single Trash deletion unchanged so single-record actions remain immediate. Reject token fields on legacy mutation messages to avoid mixed scope semantics.

- [x] **Step 6: Run background tests**

Run: `node --test extension/tests/background-contract.test.js`

Expected: all background tests PASS.

## Task 3: Bind settings preview and save to one snapshot

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/dashboard.js`
- Modify: `extension/tests/background-contract.test.js`
- Modify: `extension/tests/dashboard-ui.test.js`

- [x] **Step 1: Add failing settings-token tests**

When `preview-settings-impact` finds destructive impact, require it to return an action token tied to context and settings revisions. Changing History, Trash, or settings before commit must return `ACTION_STALE` and keep both settings and records unchanged.

- [x] **Step 2: Commit destructive settings atomically**

Use `updateSettingsAndContext()` for token commits. Recompute the preview from current data after revision validation, apply retention, optionally remove newly excluded matches, and persist settings plus resulting collections in one write.

- [x] **Step 3: Keep non-destructive settings saves direct**

If preview reports no removed records, continue using `save-settings`; it must not require an extra confirmation. If a destructive preview exists, reject direct `save-settings` for that draft and require its token.

- [x] **Step 4: Update Dashboard confirmation state**

Store the background token, expiry, and server-provided counts in `pendingSettingsConfirmation`. Both confirmation choices must call `commit-destructive-action` with the same token and the explicit exclusion-cleanup choice. On `ACTION_STALE`, close the panel and ask the user to preview again.

- [x] **Step 5: Run settings tests**

Run: `node --test --test-name-pattern='settings|impact|stale' extension/tests/background-contract.test.js extension/tests/dashboard-ui.test.js`

Expected: all selected tests PASS.

## Task 4: Use frozen scopes in Popup and Dashboard confirmations

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/dashboard.js`
- Modify: `extension/tests/popup-ui.test.js`
- Modify: `extension/tests/dashboard-ui.test.js`

- [x] **Step 1: Prepare before showing confirmation**

Popup and Dashboard must call `prepare-destructive-action` before displaying bulk History or Empty Trash confirmation. The panel uses only server-returned counts and stores only the opaque token.

- [x] **Step 2: Commit only the token**

Confirmation sends `{ type: 'commit-destructive-action', token }`. It must never resend `all`, `query`, or a recomputed ID list. Search changes, navigation, Escape, cancellation, expiry, and refresh failures clear the pending token locally.

- [x] **Step 3: Handle stale confirmations explicitly**

Add bilingual user-facing copy explaining that records changed and nothing was removed. Do not map this case to the generic “Operation failed” message.

- [x] **Step 4: Run UI tests**

Run: `node --test extension/tests/popup-ui.test.js extension/tests/dashboard-ui.test.js`

Expected: all UI tests PASS.

## Task 5: Reconcile session loss without treating extension reload as browser exit

**Files:**
- Modify: `extension/lib/close-tracker.js`
- Modify: `extension/background.js`
- Modify: `extension/tests/close-tracker.test.js`
- Modify: `extension/tests/background-contract.test.js`

- [x] **Step 1: Add failing live-tab reconciliation tests**

Cover a complete extension reload where durable snapshots exactly match live tabs, a browser restart with reused window IDs but different tabs, and a partially restored window. Matching live tabs must remain active; only missing durable snapshots become closed records.

- [x] **Step 2: Implement `reconcileRecoveredSession(tabs)`**

Match durable snapshots against live tabs using mode, tab ID, window ID, and URL. Move only missing snapshots to the durable outbox, preserve grouping by prior window, then hydrate the authoritative live set. The operation must be idempotent.

- [x] **Step 3: Replace archive-all session-loss startup**

When `recoveredAfterSessionLoss()` is true, call `reconcileRecoveredSession(tabs)` instead of archiving every old window before hydration.

- [x] **Step 4: Run tracker and background tests**

Run: `node --test extension/tests/close-tracker.test.js extension/tests/background-contract.test.js`

Expected: all lifecycle tests PASS.

## Task 6: Add storage-pressure protection

**Files:**
- Modify: `extension/background.js`
- Modify: `extension/lib/close-tracker.js`
- Modify: `extension/popup.js`
- Modify: `extension/dashboard.js`
- Modify: related tests

- [x] **Step 1: Stop persisting favicon payloads**

Keep favicon rendering optional but remove `faviconUrl` from new durable tab snapshots because the current UI does not consume it and data URLs can dominate storage.

- [x] **Step 2: Expose storage health**

Add `get-storage-health`, backed by `chrome.storage.local.getBytesInUse(null)` when available. Return bytes used, quota when exposed by Chrome, utilization level, and the last structured write failure.

- [x] **Step 3: Preserve pending tracker data on write failure**

Do not acknowledge a tracker outbox entry until its History transaction succeeds. Surface `STORAGE_WRITE_FAILED` in Popup and Dashboard with retry guidance.

- [x] **Step 4: Test quota and write failures**

Cover 70%, 85%, and 95% health levels, missing `getBytesInUse`, History write rejection, and successful retry without duplicate records.

## Task 7: Move record collections to IndexedDB

**Files:**
- Create: `extension/lib/indexeddb-repository.js`
- Create: `extension/lib/indexeddb-migration.js`
- Modify: `extension/background.js`
- Modify: `extension/manifest.json` only if script ordering requires it
- Add focused repository and migration tests

- [x] **Step 1: Define versioned stores and indexes**

Create `history` and `trash` stores keyed by a composite context/generation/record key. Add indexes for mode plus generation and close time, mode plus generation and delete time, hostname, normalized domain, and group ID. A generation is immutable after verification.

- [x] **Step 2: Implement the existing repository contract**

Provide reads, search pagination, exact-ID mutations, retention range deletion, domain queries, transactions, and revisions without changing the UI message contract. Mutations write a new generation first, then atomically update the small `chrome.storage.local` metadata pointer (and settings when applicable). Reads only use the active generation, so a browser or storage failure before pointer commit cannot expose a partially written context or a settings/records mismatch. Orphan generations are safe to reclaim later.

- [x] **Step 3: Implement resumable v2-array migration**

Copy records into an inactive deterministic generation in bounded batches, verify counts and representative fields, then atomically write the migration marker and active-generation pointer before removing old array keys. Any failure before pointer commit keeps the old arrays authoritative and is retryable; an interrupted cleanup may leave harmless old arrays but must not repeat or roll back the migration.

- [x] **Step 4: Yield during large migrations**

Use `scheduler.yield()` when available and a zero-delay timer fallback between batches so no task monopolizes the extension thread for roughly 50 ms or longer.

- [x] **Step 5: Run migration tests and real Chrome upgrade tests**

Test empty, normal, damaged, interrupted, retry, regular/incognito, and near-quota datasets before enabling IndexedDB as the default.

## Task 8: Finish domain, statistics, accessibility, and release quality

**Files:**
- Modify: `extension/lib/domain-groups.js`
- Modify: `extension/lib/history-store.js`
- Modify: `extension/dashboard.html`
- Modify: `extension/dashboard.js`
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`
- Replace: `extension/icons/*.png`
- Modify: tests and `docs/testing/2026-09-18-manual-acceptance.md`

- [x] **Step 1: Make domain identity and labels unambiguous**

Until a Public Suffix List implementation is deliberately added, group by exact lowercase hostname and display that exact hostname, including `www.`. Reject invalid exclusions instead of silently dropping them.

- [x] **Step 2: Return one statistics snapshot**

Every list response must include a revision and clearly separated total records, total tabs, matching records, matching tabs, and displayed records. Popup and Dashboard must render those exact fields without local reinterpretation.

- [x] **Step 3: Apply modern form and live-region semantics**

Connect visible labels, help, and errors with `aria-describedby`; use `setCustomValidity()`; disable spellcheck/autocorrect/capitalization for search and domain inputs; keep success announcements polite and stale/destructive errors assertive.

- [x] **Step 4: Fix icon assets**

Generate true 16, 32, 48, and 128 pixel PNGs matching manifest paths and verify dimensions before packaging.

- [x] **Step 5: Run automated and real Chrome acceptance**

Run all Node tests, JavaScript syntax checks, Chrome DevTools MCP keyboard/focus/console checks, extension reload, forced browser exit, regular/incognito isolation, 200-entry Popup, destructive-token staleness, migration, Lighthouse accessibility, and icon checks. Record observed results in the manual acceptance document.

## Final verification

Run:

```bash
node --check extension/background.js
node --check extension/popup.js
node --check extension/dashboard.js
node --test extension/tests/*.test.js
```

Expected: zero syntax failures and all tests PASS. Then load/reload the unpacked extension with Chrome DevTools MCP and complete the real-browser acceptance matrix without unresolved console errors.
