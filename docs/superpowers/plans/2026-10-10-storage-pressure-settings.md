# Tab Echo Storage Pressure Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show honest, separate storage pressure for regular records and local incognito/settings data in the Settings page.

**Architecture:** Extend the existing `get-storage-health` response with two independently measured pools while preserving legacy top-level fields. Render a read-only Settings status panel that treats health as optional, uses the highest pool pressure for the summary, and refreshes only when Settings opens or a save succeeds.

**Tech Stack:** Chrome Manifest V3, `navigator.storage.estimate`, `chrome.storage.local`, browser-owned JavaScript, HTML/CSS, Node.js `node:test` VM tests.

---

### Task 1: Return two explicit storage pools

**Files:**
- Modify: `extension/background.js`
- Test: `tests/background-contract.test.js`

- [ ] **Step 1: Add failing pool-shape tests**

Extend the existing storage-health tests to assert:

```js
assert.deepEqual(health.pools.regularRecords, {
  supported: true,
  bytesUsed: 2 * 1024 * 1024,
  quotaBytes: 100 * 1024 * 1024,
  usageRatio: 0.02,
  level: 'normal',
});
assert.deepEqual(health.pools.localData, {
  supported: true,
  bytesUsed: 9 * 1024 * 1024,
  quotaBytes: 10 * 1024 * 1024,
  usageRatio: 0.9,
  level: 'warning',
});
assert.equal(health.level, 'warning');
```

Add partial-support coverage where `navigator.storage.estimate` is unavailable but `chrome.storage.local` remains measurable, and where only the origin estimate is measurable. An unsupported pool must be:

```js
{ supported: false, bytesUsed: null, quotaBytes: null, usageRatio: null, level: 'unknown' }
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
node --test --test-name-pattern='storage health' tests/background-contract.test.js
```

Expected: FAIL because `get-storage-health` has no `pools` object.

- [ ] **Step 3: Add a pool constructor**

In `extension/background.js`, add:

```js
function storagePool(bytesUsed, quotaBytes) {
  const used = Number(bytesUsed);
  const quota = Number(quotaBytes);
  if (!Number.isFinite(used) || used < 0 || !Number.isFinite(quota) || quota <= 0) {
    return { supported: false, bytesUsed: null, quotaBytes: null, usageRatio: null, level: 'unknown' };
  }
  const usageRatio = used / quota;
  return {
    supported: true,
    bytesUsed: Math.round(used),
    quotaBytes: Math.round(quota),
    usageRatio,
    level: storagePressureLevel(usageRatio),
  };
}
```

- [ ] **Step 4: Construct the two pools without combining capacities**

Add the explicit rank map and build the response:

```js
const STORAGE_PRESSURE_RANK = Object.freeze({ unknown: 0, normal: 1, elevated: 2, warning: 3, critical: 4 });
const regularBytes = originEstimate
  ? (Number.isFinite(Number(originEstimate.usageDetails && originEstimate.usageDetails.indexedDB))
    ? Number(originEstimate.usageDetails.indexedDB)
    : originEstimate.usage)
  : null;
const regularRecords = storagePool(regularBytes, originEstimate && originEstimate.quota);
const localData = storagePool(localBytesUsed, localQuotaBytes);
const measuredLevels = [regularRecords, localData]
  .filter((pool) => pool.supported)
  .map((pool) => pool.level);
const level = measuredLevels.reduce((highest, current) => (
  STORAGE_PRESSURE_RANK[current] > STORAGE_PRESSURE_RANK[highest] ? current : highest
), 'unknown');
```

Return `pools: { regularRecords, localData }`, preserve the existing top-level compatibility fields, and set `supported` when at least one pool is measurable.

- [ ] **Step 5: Run focused background tests**

Run:

```bash
node --test --test-name-pattern='storage health' tests/background-contract.test.js
```

Expected: all storage-health tests pass.

### Task 2: Add pure formatting and localization helpers

**Files:**
- Modify: `extension/dashboard.js`
- Test: `tests/dashboard-ui.test.js`

- [ ] **Step 1: Add failing helper tests**

Add tests for exported helpers:

```js
assert.equal(helpers.formatStorageBytes(0, 'en'), '0 B');
assert.equal(helpers.formatStorageBytes(1536, 'en'), '1.5 KB');
assert.equal(helpers.formatStorageBytes(10 * 1024 * 1024, 'zh'), '10 MB');
assert.equal(helpers.formatStoragePercent(0.004, 'en'), 'Less than 1%');
assert.equal(helpers.formatStoragePercent(0.9, 'zh'), '90%');
```

Add bilingual keys for the panel title, pool labels, four pressure levels, unknown capacity, usage template, and recent write failure.

- [ ] **Step 2: Run the helper test and confirm failure**

Run:

```bash
node --test --test-name-pattern='storage formatting' tests/dashboard-ui.test.js
```

Expected: FAIL because the helpers and copy do not exist.

- [ ] **Step 3: Implement deterministic formatting helpers**

Add pure top-level functions:

```js
function formatStorageBytes(value, language = 'en') {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  const digits = amount >= 10 || Number.isInteger(amount) ? 0 : 1;
  return `${new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits: digits }).format(amount)} ${units[unit]}`;
}

function formatStoragePercent(value, language = 'en') {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0) return '';
  if (ratio > 0 && ratio < 0.01) return language === 'zh' ? '不到 1%' : 'Less than 1%';
  return `${Math.round(ratio * 100)}%`;
}
```

Export both functions through `TabEchoDashboard`.

- [ ] **Step 4: Run the helper tests**

Run the focused helper command again. Expected: PASS.

### Task 3: Render the Settings storage panel

**Files:**
- Modify: `extension/dashboard.html`
- Modify: `extension/dashboard.css`
- Modify: `extension/dashboard.js`
- Test: `tests/dashboard-ui.test.js`

- [ ] **Step 1: Add failing static UI contracts**

Require these elements:

```html
<section id="storageHealthPanel" class="storage-health" aria-labelledby="storageHealthTitle">
  <div class="storage-health-heading">
    <strong id="storageHealthTitle"></strong>
    <span id="storageHealthStatus"></span>
  </div>
  <div id="regularStoragePool" class="storage-pool">
    <span id="regularStorageLabel"></span>
    <span id="regularStorageValue"></span>
    <progress id="regularStorageProgress" max="1"></progress>
  </div>
  <div id="localStoragePool" class="storage-pool">
    <span id="localStorageLabel"></span>
    <span id="localStorageValue"></span>
    <progress id="localStorageProgress" max="1"></progress>
  </div>
  <p id="storageWriteWarning" hidden></p>
</section>
```

Assert that the panel appears after the retention heading and before `.settings-retention`, and that CSS defines neutral, elevated/warning, and critical states without using green as the default fill.

- [ ] **Step 2: Run static UI tests and confirm failure**

Run:

```bash
node --test --test-name-pattern='storage pressure panel' tests/dashboard-ui.test.js
```

Expected: FAIL because the panel is absent.

- [ ] **Step 3: Add the semantic HTML and minimal styling**

Add the panel structure to `dashboard.html`. Style it as a compact bordered block with a two-column pool grid that collapses to one column below 760 px. Use `progress` elements and `data-level` attributes; normal fill uses the existing neutral/accent system, warning uses amber, and critical uses `--danger`.

- [ ] **Step 4: Implement pool rendering**

In `dashboard.js`, add element references and:

```js
function renderStoragePool(pool, valueNode, progressNode) {
  if (!pool || !pool.supported) {
    valueNode.textContent = t('storageUnavailable');
    progressNode.hidden = true;
    progressNode.removeAttribute('value');
    return;
  }
  valueNode.textContent = t('storageUsage', {
    used: formatStorageBytes(pool.bytesUsed, state.language),
    quota: formatStorageBytes(pool.quotaBytes, state.language),
    percent: formatStoragePercent(pool.usageRatio, state.language),
  });
  progressNode.hidden = false;
  progressNode.value = Math.min(1, Math.max(0, pool.usageRatio));
}
```

`renderStorageHealth(health)` sets the overall localized label, `data-level`, both pools, and the recent write-failure warning. Unknown health renders both pools as unavailable without throwing.

- [ ] **Step 5: Run the static and helper tests**

Run:

```bash
node --test --test-name-pattern='storage pressure|storage formatting' tests/dashboard-ui.test.js
```

Expected: PASS.

### Task 4: Load health independently and refresh after save

**Files:**
- Modify: `extension/dashboard.js`
- Test: `tests/dashboard-ui.test.js`

- [ ] **Step 1: Add a failing Settings VM regression test**

Create a VM test where `get-settings` succeeds and `get-storage-health` returns two pools. Assert that Settings remains enabled and both localized values render. Add a second case where health rejects but settings still load and the panel displays the unavailable copy.

Track messages and assert one health request when Settings opens. After a successful `save-settings`, assert a second health request occurs.

- [ ] **Step 2: Run the VM test and confirm failure**

Run:

```bash
node --test --test-name-pattern='Settings storage health' tests/dashboard-ui.test.js
```

Expected: FAIL because Settings never requests health.

- [ ] **Step 3: Implement isolated health loading**

Add a separate `storageHealthRequestToken` to state and:

```js
async function refreshStorageHealth() {
  const token = ++state.storageHealthRequestToken;
  try {
    const health = await sendMessage({ type: 'get-storage-health' });
    if (token === state.storageHealthRequestToken && state.view === 'settings') renderStorageHealth(health);
  } catch (_) {
    if (token === state.storageHealthRequestToken && state.view === 'settings') renderStorageHealth(null);
  }
}
```

Start `refreshStorageHealth()` when `refreshSettings()` begins, but do not await it before enabling the form. After a successful settings save and only while still in Settings, await one new `refreshStorageHealth()` call.

- [ ] **Step 4: Run the Settings VM tests**

Run the focused VM command again. Expected: both success and failure-isolation cases pass.

### Task 5: Document and verify the feature

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `proposal.md`
- Modify: `docs/testing/2026-09-18-manual-acceptance.md`
- Modify: `tests/docs-contract.test.js`

- [ ] **Step 1: Add documentation contract assertions**

Require both languages to explain that Settings shows regular-record and incognito/settings capacity separately and never combines the quotas.

- [ ] **Step 2: Update product documentation**

Document the two-pool status, thresholds, unknown-capacity behavior, and the absence of `unlimitedStorage`. Add manual acceptance cases for a measurable normal state, local pressure higher than IndexedDB pressure, and unavailable capacity.

- [ ] **Step 3: Run all automated checks**

Run:

```bash
npm test
npm run check
```

Expected: all tests and checks pass.

- [ ] **Step 4: Perform a real Chrome smoke test**

Reload the unpacked extension, open Settings, and record:

- the two pool labels and values;
- the overall status matching the higher pressure;
- no combined total;
- settings remaining editable if one pool is unavailable;
- no extension error in `chrome://extensions`.
