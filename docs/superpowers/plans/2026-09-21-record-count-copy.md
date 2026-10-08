# Record Count Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit because the user explicitly requested no automatic Git commit.

**Goal:** Make record totals consistent between the dashboard and popup while explaining that one record may be a Group.

**Architecture:** Keep the background response unchanged because it already exposes both raw totals and display-result totals. The popup selects `totalEventCount` only for the unfiltered summary and unfiltered permanent-removal impact, while retaining `resultEventCount` for search summaries and View all.

**Tech Stack:** Manifest V3 extension JavaScript, Node `node:test`, bilingual static UI copy.

---

### Task 1: Lock down the popup count semantics

**Files:**
- Modify: `extension/tests/popup-ui.test.js`
- Modify: `extension/popup.js`

- [ ] **Step 1: Write the failing VM regression test**

Use a `get-history` response containing `totalEventCount: 2690`, `resultEventCount: 2008`, `totalTabCount: 2712`, and a small `results` array. Assert that the unfiltered summary contains 2690, View all contains 2008, and the permanent-removal confirmation contains 2690. Then enter a query and assert that the summary and confirmation use the filtered result count.

- [ ] **Step 2: Run the focused test and verify the old implementation fails**

Run: `node --test --test-name-pattern="raw total.*display results" extension/tests/popup-ui.test.js`

Expected: FAIL because the unfiltered popup summary currently reads `resultEventCount`.

- [ ] **Step 3: Track raw and display totals separately**

In `extension/popup.js`, keep `state.totalResults` as the display/search result count and add a separate raw total populated from `history.totalEventCount`. Select the raw total for the unfiltered summary and unfiltered permanent-removal confirmation; continue using `state.totalResults` for View all and filtered summaries.

- [ ] **Step 4: Run the focused popup suite**

Run: `node --test extension/tests/popup-ui.test.js`

Expected: all popup UI tests pass.

### Task 2: Clarify bilingual record summaries and verify the product

**Files:**
- Modify: `extension/dashboard.js`
- Modify: `extension/popup.js`
- Modify: `extension/tests/dashboard-ui.test.js`
- Modify: `extension/tests/docs-contract.test.js`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `proposal.md`

- [ ] **Step 1: Add copy assertions**

Assert the dashboard uses `{events} records (including Groups) · {tabs} tabs` and `{events} 条记录（含标签组）· {tabs} 个标签页`, and the popup unfiltered summary uses the equivalent one-count wording.

- [ ] **Step 2: Update bilingual UI and product documentation**

Change only unfiltered record summaries. Preserve the existing matching-record wording for searches and all existing action labels. Document that raw totals include Groups while View all counts display results after single-URL deduplication.

- [ ] **Step 3: Run full verification**

Run: `node --test extension/tests/*.test.js`

Expected: all tests pass with zero failures.

Run: `for file in extension/*.js extension/lib/*.js; do node --check "$file" || exit 1; done`

Expected: exit code 0.
