const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { buildSearchResults } = require('../lib/history-store.js');

const extensionRoot = path.resolve(__dirname, '..');
const paths = {
  html: path.join(extensionRoot, 'dashboard.html'),
  css: path.join(extensionRoot, 'dashboard.css'),
  js: path.join(extensionRoot, 'dashboard.js'),
};

test('dashboard assets exist as an extension-owned page', () => {
  for (const file of Object.values(paths)) {
    assert.equal(fs.existsSync(file), true, `${path.basename(file)} should exist`);
  }
});

test('sidebar navigation icons share one geometry and stroke system', () => {
  assert.equal((html.match(/class="nav-icon"/g) || []).length, 3);
  assert.match(css, /\.nav-icon \{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*stroke-width:\s*1\.6/s);
  assert.doesNotMatch(html, />[↶⌫⚙]</);
});

const assetsExist = Object.values(paths).every((file) => fs.existsSync(file));
const html = assetsExist ? fs.readFileSync(paths.html, 'utf8') : '';
const css = assetsExist ? fs.readFileSync(paths.css, 'utf8') : '';
const js = assetsExist ? fs.readFileSync(paths.js, 'utf8') : '';
const helpers = assetsExist ? require(paths.js) : {};

test('dashboard declares localized navigation, search, status, paging, and settings skeleton', () => {
  for (const text of ['Closed tabs', 'Trash', 'Settings', '已关闭标签页', '回收站', '设置']) {
    assert.ok(`${html}\n${js}`.includes(text), `missing localized copy: ${text}`);
  }
  assert.doesNotMatch(`${html}\n${js}`, /普通历史|当前模式/);
  assert.match(html, /id="dashboardNav"/);
  assert.match(html, /id="searchInput"[^>]+type="search"/);
  assert.match(html, /id="statusMessage"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="migrationNotice"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="historyList"[^>]+aria-busy="true"/);
  assert.match(html, /id="pageSizeSelect"/);
  assert.match(html, /id="moveHistoryButton"/);
  assert.doesNotMatch(html, /id="moveResultsButton"|id="clearHistoryButton"/);
  for (const size of ['25', '50', '100']) assert.match(html, new RegExp(`value=\"${size}\"`));
  for (const name of ['maxRecords', 'maxAgeDays', 'trashMaxAgeDays', 'popupSize', 'language', 'theme', 'excludedDomains']) {
    assert.match(html, new RegExp(`name=\"${name}\"`));
  }
  assert.doesNotMatch(html, /name="pageSize"/);
  for (const id of ['removeHistoryButton', 'historyRemovePanel', 'confirmHistoryRemoveButton', 'trashEmptyPanel', 'confirmEmptyTrashButton', 'confirmSettingsAndRemoveButton']) assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /previewExcludedCleanupButton|excludedCleanupPanel|confirmExcludedCleanupButton/);
  assert.match(`${html}\n${js}`, /Unlimited/);
  assert.match(`${html}\n${js}`, /无限|永久/);
  assert.match(html, /<link rel="stylesheet" href="dashboard.css">/);
  assert.match(html, /<script src="dashboard.js"><\/script>/);
  assert.doesNotMatch(html, /on(?:click|change|input|submit)=/i);
  assert.doesNotMatch(html, /<style|<script(?! src)/i);
});

test('Dashboard renders the localized migration notice before acknowledging it once', async () => {
  const listeners = {}; const nodes = new Map(); const messages = [];
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', children: [], elements: {},
      classList: { toggle() {} }, addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; },
      setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      querySelectorAll() { return []; }, closest() { return { hidden: false }; }, focus() {},
    }; nodes.set(id, value); return value;
  }
  const form = node('settingsForm');
  form.elements = Object.fromEntries(['maxRecords', 'maxAgeDays', 'trashMaxAgeDays'].map((name) => [name, node(name)]));
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const notice = { id: 'notice-dashboard', version: 2, skippedEvents: 2, createdAt: 12345 };
  const settings = { maxRecords: 10, maxAgeDays: null, trashMaxAgeDays: 3, pageSize: 50, language: 'zh', theme: 'system' };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm: () => true,
    location: { search: '?view=settings', pathname: '/dashboard.html' }, history: { replaceState() {}, pushState() {} },
    addEventListener(type, handler) { listeners[`window:${type}`] = handler; }, chrome: { runtime: { async sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' };
      if (message.type === 'get-settings') return { ok: true, mode: 'normal', settings };
      if (message.type === 'get-migration-notice') return { ok: true, notice };
      if (message.type === 'acknowledge-migration-notice') {
        assert.equal(node('migrationNotice').textContent, '已迁移现有关闭记录，其中 2 条损坏记录无法恢复。');
        assert.equal(node('migrationNotice').hidden, false);
        return { ok: true, acknowledged: true };
      }
      return { ok: true };
    } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context);
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(messages.filter((message) => /migration-notice/.test(message.type)), [
    { type: 'get-migration-notice' }, { type: 'acknowledge-migration-notice', id: notice.id },
  ]);
});

test('Dashboard does not display or acknowledge notice when its independent settings request fails', () => {
  assert.match(js, /get-migration-notice/);
  assert.match(js, /get-settings/);
  assert.match(js, /noticeResponse, settingsResponse/);
  assert.ok(js.includes('if (!settingsResponse || !settingsResponse.settings) return;'));
});

test('Dashboard VM keeps the migration banner hidden and unacknowledged when settings fail', async () => {
  const listeners = {}; const nodes = new Map(); const messages = [];
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: id === 'migrationNotice', disabled: false, value: '', textContent: '', children: [], elements: {},
      classList: { toggle() {} }, addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; },
      setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      querySelectorAll() { return []; }, closest() { return { hidden: false }; }, focus() {},
    }; nodes.set(id, value); return value;
  }
  node('settingsForm').elements = Object.fromEntries(['maxRecords', 'maxAgeDays', 'trashMaxAgeDays'].map((name) => [name, node(name)]));
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const empty = { ok: true, mode: 'normal', settings: { language: 'en', theme: 'system', pageSize: 50 }, results: [],
    totalEventCount: 0, totalTabCount: 0, resultEventCount: 0, matchedTabCount: 0 };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm: () => true,
    location: { search: '?view=history', pathname: '/dashboard.html' }, history: { replaceState() {}, pushState() {} },
    addEventListener(type, handler) { listeners[`window:${type}`] = handler; }, chrome: { runtime: { async sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.type === 'get-migration-notice') return { ok: true, notice: { id: 'retry', version: 2, skippedEvents: 1, createdAt: 1 } };
      if (message.type === 'get-settings') throw new Error('settings failed');
      if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' };
      return empty;
    } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context);
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node('migrationNotice').hidden, true);
  assert.equal(messages.some((message) => message.type === 'acknowledge-migration-notice'), false);
});

test('URL state accepts only known views and normalizes pagination', () => {
  assert.deepEqual(helpers.parseUrlState('?view=trash&q=needle&page=3&pageSize=100'), {
    view: 'trash', query: 'needle', page: 3, pageSize: 100,
  });
  assert.deepEqual(helpers.parseUrlState('?view=evil&q=x&page=-1&pageSize=17'), {
    view: 'history', query: 'x', page: 1, pageSize: 50,
  });
  assert.equal(helpers.buildUrlState({ view: 'settings', query: '', page: 1, pageSize: 50 }), '?view=settings');
  assert.equal(helpers.buildUrlState({ view: 'history', query: 'a b', page: 2, pageSize: 25 }), '?view=history&q=a+b&page=2&pageSize=25');
});

test('pagination slices result events and clamps stale pages', () => {
  const results = Array.from({ length: 61 }, (_, id) => ({ id }));
  assert.deepEqual(helpers.paginateResults(results, 2, 25), {
    items: results.slice(25, 50), page: 2, pageCount: 3, total: 61,
  });
  assert.equal(helpers.paginateResults(results, 99, 50).page, 2);
  assert.equal(helpers.paginateResults([], 4, 25).page, 1);
});

test('range keys follow history-store keys including duplicate and missing ids', () => {
  const tabs = [
    { id: 'same' }, { title: 'missing' }, { id: 'same@2' }, { id: 'same' }, { id: '__proto__' },
  ];
  assert.deepEqual(helpers.buildTabRangeKeys(tabs), [
    'id:same', 'index:1', 'id:same@2', 'id:same@3', 'id:__proto__',
  ]);
});

test('highlight rendering creates text and mark nodes without parsing HTML', () => {
  const created = [];
  const fakeDocument = {
    createTextNode(value) { return { type: 'text', value }; },
    createElement(tag) {
      const node = { type: tag, children: [], append(...items) { this.children.push(...items); } };
      created.push(node);
      return node;
    },
  };
  const parent = { children: [], append(...items) { this.children.push(...items); } };
  helpers.appendHighlightedText(fakeDocument, parent, '<img src=x> needle', [[12, 18]]);
  assert.deepEqual(parent.children.map((node) => node.type), ['text', 'mark']);
  assert.equal(parent.children[0].value, '<img src=x> ');
  assert.equal(parent.children[1].children[0].value, 'needle');
  assert.equal(created.length, 1);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
});

test('runtime uses background result counts, complete-event bulk operations, and current request wins', () => {
  assert.match(js, /type:\s*'get-history'/);
  assert.match(js, /response\.resultEventCount/);
  assert.match(js, /response\.matchedTabCount/);
  assert.match(js, /type:\s*'move-to-trash'/);
  assert.match(js, /eventIds:\s*selection\.eventIds/);
  assert.match(js, /type:\s*'move-to-trash',\s*all:\s*true/);
  assert.doesNotMatch(js, /type:\s*'move-to-trash',\s*all:\s*true,\s*query/);
  assert.match(js, /settingsRequestToken/);
  assert.match(js, /data\.token/);
  assert.match(js, /popstate/);
  assert.match(js, /chrome\.storage\.session/);
  assert.doesNotMatch(js, /storage\.session[^\n]+(?:query|page)/i);
});

test('history bulk move derives its single action scope from the search query', () => {
  assert.doesNotMatch(html, /id="moveScopeSelect"/);
  assert.match(html, /id="moveHistoryButton"/);
  assert.match(js, /moveHistory:\s*doc\.getElementById\('moveHistoryButton'\)/);
  assert.match(js, /if \(!state\.query\.trim\(\)\) \{/);
  assert.match(js, /type:\s*'move-to-trash',\s*all:\s*true/);
  assert.match(js, /eventIds:\s*selection\.eventIds/);
  assert.match(js, /hasSearchQuery \? data\.resultEventCount === 0 : data\.totalEventCount === 0/);
});

test('bulk search selection counts complete matched events without requesting confirmation', () => {
  const responseResults = buildSearchResults([
    { id: 'new-duplicate', kind: 'single', tabs: [{ id: 'new-tab', url: 'https://same.example' }] },
    { id: 'old-duplicate', kind: 'single', tabs: [{ id: 'old-tab', url: 'https://same.example' }] },
    { id: 'group', kind: 'group', tabs: [
      { id: 'one', url: 'https://one.example' }, { id: 'two', url: 'https://two.example' },
      { id: 'three', url: 'https://three.example' },
    ] },
  ], '', { deduplicateSingles: true });
  assert.deepEqual(helpers.getResultSelection(responseResults), {
    eventIds: ['new-duplicate', 'group'], eventCount: 2, tabCount: 4,
  });
  const moveHandler = js.slice(js.indexOf("elements.moveHistory.addEventListener"), js.indexOf("elements.settingsForm.addEventListener"));
  assert.doesNotMatch(moveHandler, /confirm\(/);
});

test('dashboard removes every result for the loaded query after inline confirmation', async () => {
  const listeners = {}; const nodes = new Map(); const messages = []; let focused = '';
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', children: [], elements: {}, attrs: {},
      classList: { toggle() {} }, addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; },
      setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      querySelectorAll() { return []; }, querySelector() { return node(); }, closest() { return { hidden: false }; }, focus() { focused = id; },
    }; nodes.set(id, value); return value;
  }
  node('settingsForm').elements = Object.fromEntries(['maxRecords', 'maxAgeDays', 'trashMaxAgeDays'].map((name) => [name, node(name)]));
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const settings = { maxRecords: 10000, maxAgeDays: null, trashMaxAgeDays: 3, pageSize: 25, popupSize: 10, language: 'en', theme: 'system', excludedDomains: [] };
  const historyResponse = { ok: true, mode: 'normal', settings, results: [
    { event: { id: 'first', closedAt: 2, tabs: [{ id: 'a', title: 'needle one', url: 'https://a.example' }] }, totalTabCount: 1, matchedTabCount: 1, matchRanges: {} },
    { event: { id: 'second', closedAt: 1, tabs: [{ id: 'b', title: 'needle two', url: 'https://b.example' }] }, totalTabCount: 1, matchedTabCount: 1, matchRanges: {} },
  ], totalEventCount: 500, totalTabCount: 700, resultEventCount: 120, resultTabCount: 140, matchedTabCount: 140 };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, location: { search: '?view=history&q=needle&pageSize=25', pathname: '/dashboard.html' },
    history: { replaceState() {}, pushState() {} }, addEventListener(type, handler) { listeners[`window:${type}`] = handler; },
    chrome: { runtime: { async sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' };
      if (message.type === 'get-history') return historyResponse;
      if (message.type === 'permanently-delete-history') return { ok: true, deleted: 120 };
      return { ok: true, settings };
    } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context); await new Promise((resolve) => setImmediate(resolve));
  listeners['removeHistoryButton:click']();
  assert.equal(node('historyRemovePanel').hidden, false);
  assert.match(node('historyRemoveMessage').textContent, /120 matching records.*140 tabs/i);
  assert.equal(focused, 'confirmHistoryRemoveButton');
  await listeners['confirmHistoryRemoveButton:click'](); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.find((message) => message.type === 'permanently-delete-history'), { type: 'permanently-delete-history', all: true, query: 'needle' });
});

test('typing invalidates an in-flight history request before debounce starts another', () => {
  const handler = js.slice(js.indexOf("search.addEventListener('input'"), js.indexOf("pageSize.addEventListener"));
  assert.ok(handler.includes('data.token += 1'));
  assert.ok(handler.includes('data.loading = true'));
  assert.ok(handler.includes('data.loadedQuery = null'));
  assert.equal(helpers.isLoadedResultCurrent({ loading: true, query: 'new', loadedQuery: 'old' }), false);
  assert.equal(helpers.isLoadedResultCurrent({ loading: false, query: 'new', loadedQuery: 'new' }), true);
  assert.ok(js.includes("if (!currentResource('history')) return;"));
  assert.ok(js.includes("if (!currentResource('trash')) return;"));
});

test('searched groups default open but an explicit toggle can close them', () => {
  const expanded = new Map();
  assert.equal(helpers.isGroupExpanded(expanded, 'group', 'needle'), true);
  expanded.set('group', false);
  assert.equal(helpers.isGroupExpanded(expanded, 'group', 'needle'), false);
  expanded.set('group', true);
  assert.equal(helpers.isGroupExpanded(expanded, 'group', ''), true);
  assert.doesNotMatch(js, /state\.query\.trim\(\)\s*\|\|\s*state\.expanded/);
});

test('remembered view is isolated by regular or incognito context', () => {
  assert.ok(js.includes("type: 'get-current-mode'"));
  assert.ok(js.includes('`${UI_STATE_KEY}:${state.mode}`'));
});

test('history offers list and domain layouts backed by extension modules', () => {
  assert.match(html, /id="historyLayoutToggle"[^>]+role="group"/);
  assert.match(html, /data-history-layout="list"/);
  assert.match(html, /data-history-layout="domain"/);
  assert.match(html, /id="domainHistoryView"/);
  assert.match(html, /id="domainIndex"/);
  assert.match(html, /id="domainHistoryList"/);
  assert.ok(html.indexOf('lib/domain-groups.js') < html.indexOf('dashboard.js'));
  assert.ok(html.indexOf('lib/time-format.js') < html.indexOf('dashboard.js'));
  assert.match(js, /root\.TabEchoDomainGroups/);
  assert.match(js, /domainGroups\.buildDomainGroups/);
  assert.match(js, /root\.TabEchoTimeFormat/);
  assert.match(js, /timeFormat\.formatRelativeTime/);
  assert.match(js, /timeFormat\.formatFullTime/);
  assert.match(js, /moveDomainRecords/);
  assert.match(js, /pending\.eventIds/);
  assert.match(js, /selected \? getResultSelection\(selected\.results\)/);
});

test('domain selection keeps an existing group and otherwise falls back to the first group', () => {
  const groups = [{ key: 'first.example' }, { key: 'second.example' }];
  assert.equal(helpers.resolveDomainSelection(groups, 'second.example'), 'second.example');
  assert.equal(helpers.resolveDomainSelection(groups, 'gone.example'), 'first.example');
  assert.equal(helpers.resolveDomainSelection([], 'gone.example'), null);
});

test('domain layout persists with the dashboard view per browsing context', () => {
  assert.match(js, /historyLayout:\s*state\.historyLayout/);
  assert.match(js, /savedState\.historyLayout/);
  assert.match(js, /historyLayoutToggle/);
  assert.match(js, /dataset\.historyLayout/);
});

test('relative times refresh only for a visible history or Trash view', () => {
  assert.match(js, /setInterval\([^,]+,\s*60\s*\*\s*1000\)/s);
  assert.match(js, /visibilityState\s*!==\s*'visible'/);
  assert.match(js, /state.view === 'history'/);
  assert.match(js, /state.view === 'trash'/);
  assert.match(js, /closedTimePrefix/);
  assert.match(js, /trashedTimePrefix/);
  assert.match(js, /node\.tabIndex = 0/);
  assert.match(css, /\.event-time:focus::after/);
});

test('settings are grouped and explain that cleanup impact is scoped to the current context', () => {
  for (const copy of ['Storage and cleanup', 'Popup display', 'Appearance and language', '保存与清理', '弹窗显示', '外观与语言']) {
    assert.ok((html + '\n' + js).includes(copy), 'missing settings group copy: ' + copy);
  }
  assert.match(html, /id="settingsScope"/);
  assert.match(js, /本次预览只统计当前\{mode\}的数据/);
  assert.match(css, /\.settings-section\s*\{/);
});

test('history layout and cross-domain group copy describe their actual meaning', () => {
  assert.match(js, /defaultList:\s*'按关闭时间'/);
  assert.match(js, /defaultList:\s*'By close time'/);
  assert.match(js, /multipleDomains:\s*'跨域标签组'/);
  assert.match(js, /domainGroupCount/);
});

test('domain layout becomes a horizontally scrolling chip index on narrow screens', () => {
  assert.match(css, /\.domain-history-layout\s*\{[^}]*grid-template-columns:\s*minmax\(150px,\s*220px\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*\.domain-history-layout\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*\.domain-index\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /@media\s*\(max-width:\s*760px\)[\s\S]*\.domain-index-list\s*\{[^}]*display:\s*flex/s);
});

test('dashboard is responsive and honors theme, focus, and reduced-motion preferences', () => {
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(max-width:/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /body\s*\{[^}]*height:\s*\d+px/s);
});

test('dashboard list summaries and tab details stay on one compact line', () => {
  assert.match(css, /\.event-summary, \.tab-copy \{[^}]*display:\s*flex[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.event-summary span, \.tab-copy span \{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.event-summary span::before, \.tab-copy span::before/);
  assert.match(js, /if \(isGroup && expanded\)/);
  assert.match(js, /appendHighlightedText\(doc, title, tab.title \|\| tab.url, ranges.title\)/);
  assert.match(js, /card.className = `event-card \${isGroup \? `is-group \${expanded \? 'is-expanded' : 'is-collapsed'}` : 'is-single'}`/);
  assert.match(js, /else \{ toggle = null; \}/);
  assert.match(css, /\.event-card\.is-single \.event-header \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
  assert.match(css, /\.event-summary span, \.tab-copy span \{[^}]*max-width:\s*36%[^}]*flex:\s*0 1 36%/s);
});

test('dashboard makes grouped close events visually distinct', () => {
  assert.match(js, /`is-group \${expanded \? 'is-expanded' : 'is-collapsed'}`/);
  assert.match(js, /group-summary/);
  assert.match(js, /group-badge/);
  assert.doesNotMatch(js + '\n' + css, /group-stack-icon/);
  assert.match(css, /\.event-card\.is-group \{[^}]*box-shadow:\s*inset 3px 0 0 var\(--accent\)/s);
  assert.match(css, /\.group-summary \.group-badge \{[^}]*background:\s*var\(--accent-soft\)/s);
  assert.match(css, /\.event-card\.is-group\.is-expanded/);
});

test('history and Trash expose permanent deletion directly without a more menu', () => {
  assert.match(js, /'delete-history'/);
  assert.match(js, /'delete-trash'/);
  assert.doesNotMatch(js, /'trash-more'|action-menu|more-button/);
});

test('Trash restore copy distinguishes moving records back from reopening tabs', () => {
  assert.match(`${html}\n${js}`, /Move all back to Closed tabs/);
  assert.match(js, /全部移回关闭记录/);
  assert.match(js, /移回 \{count\} 条搜索结果/);
  assert.doesNotMatch(`${html}\n${js}`, /Restore all entries|恢复全部记录/);
});

test('browser UMD passes its root to the factory and starts in a browser-like VM', async () => {
  const listeners = {};
  const messages = [];
  const nodes = new Map();
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '',
      classList: { toggle() {} }, style: {}, elements: {}, children: [],
      addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; },
      setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; }, querySelectorAll() { return []; },
      closest() { return { hidden: false }; }, focus() {},
    };
    nodes.set(id, value); return value;
  }
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node,
    querySelectorAll() { return []; }, addEventListener(type, handler) { listeners[`document:${type}`] = handler; },
    createElement() { return node(); }, createTextNode(value) { return { value }; },
  };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm: () => true,
    location: { search: '?view=settings&page=2', pathname: '/dashboard.html' },
    history: { replaceState() {}, pushState() {} }, addEventListener(type, handler) { listeners[`window:${type}`] = handler; },
    chrome: { runtime: { sendMessage: async (message) => { messages.push(message); return message.type === 'get-current-mode'
      ? { ok: true, mode: 'normal' }
      : { ok: true, mode: 'normal', settings: { maxRecords: null, maxAgeDays: null, trashMaxAgeDays: 3, language: 'en', theme: 'system', pageSize: 50 }, results: [], totalEventCount: 0, totalTabCount: 0, resultEventCount: 0, matchedTabCount: 0 }; } },
      storage: { session: { async get() { return {}; }, async set() {} } } },
  };
  context.globalThis = context;
  vm.runInNewContext(js, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(context.TabEchoDashboard);
  assert.equal(typeof listeners['dashboardNav:click'], 'function');
  assert.equal(typeof listeners['window:popstate'], 'function');
  assert.deepEqual(messages.map((message) => message.type), ['get-migration-notice', 'get-settings', 'get-current-mode', 'get-settings']);
});

test('browser VM guards stale Trash actions, restores explicit ids, and Empty Trash uses inline confirmation', async () => {
  const listeners = {}; const nodes = new Map(); const messages = []; const confirmations = []; let blockRestore = true; let failHistory = false; let focused = '';
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', parentNode: null,
      classList: { toggle() {} }, style: {}, elements: {}, children: [],
      attrs: {}, addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; }, setAttribute(name, data) { this.attrs[name] = data; }, removeAttribute(name) { delete this.attrs[name]; },
      append(...items) { this.children.push(...items); for (const item of items) if (item) item.parentNode = this; },
      replaceChildren(...items) { this.children = items; }, querySelectorAll() { return []; }, querySelector() { return node(); },
      closest() { return { hidden: false }; }, focus() { focused = this.id; }, dispatchEvent(event) { const handler = listeners[`${id}:${event.type}`]; if (handler) handler(event); },
    }; nodes.set(id, value); return value;
  }
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout,
    confirm(message) { confirmations.push(message); return true; },
    location: { search: '?view=trash&q=needle', pathname: '/dashboard.html' },
    history: { replaceState() {}, pushState() {} }, addEventListener(type, handler) { listeners[`window:${type}`] = handler; },
    chrome: { runtime: { async sendMessage(message) {
      messages.push(structuredClone(message));
      if (message.type === 'get-current-mode') return { ok: true, mode: 'incognito' };
      if (message.type === 'get-trash') return { ok: true, mode: 'incognito', settings: { language: 'en', theme: 'system', pageSize: 50 },
        results: [{ event: { id: 'old', deletedAt: 1, tabs: [{ id: 'a', title: 'needle', url: 'https://a.example' }] }, totalTabCount: 1, matchedTabCount: 1, matchRanges: {} },
          { event: { id: 'new', deletedAt: 2, tabs: [{ id: 'b', title: 'needle', url: 'https://b.example' }] }, totalTabCount: 1, matchedTabCount: 1, matchRanges: {} }],
        totalEventCount: 2, totalTabCount: 2, resultEventCount: 2, matchedTabCount: 2 };
      if (message.type === 'restore-trash' && blockRestore) return { ok: false, requiredSlots: 2, error: { code: 'INSUFFICIENT_CAPACITY', message: 'capacity' } };
      if (message.type === 'restore-trash') return { ok: true, restored: 2 };
      if (message.type === 'empty-trash') return { ok: true, deleted: 2 };
      if (message.type === 'get-history' && failHistory) return { ok: false, error: { code: 'FAILED', message: 'refresh failed' } };
      return { ok: true, mode: 'incognito', settings: { language: 'en', theme: 'system', pageSize: 50 }, results: [], totalEventCount: 0, totalTabCount: 0, resultEventCount: 0, matchedTabCount: 0 };
    } }, storage: { session: { async get() { return {}; }, async set() {} } } },
  };
  context.globalThis = context; vm.runInNewContext(js, context); await new Promise((resolve) => setImmediate(resolve));
  listeners['trashList:click']({ target: { closest() { return { dataset: { action: 'delete-trash', eventId: 'old' } }; } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.find((message) => message.type === 'permanently-delete-trash'), { type: 'permanently-delete-trash', trashIds: ['old'] });
  assert.equal(confirmations.length, 0);
  listeners['emptyTrashButton:click'](); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((message) => message.type === 'empty-trash').length, 0);
  assert.equal(node('trashEmptyPanel').hidden, false);
  await listeners['confirmEmptyTrashButton:click'](); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.filter((message) => message.type === 'empty-trash').length, 1);
  assert.equal(confirmations.length, 0);
  confirmations.length = 0;
  await listeners['restoreTrashResultsButton:click'](); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.find((message) => message.type === 'restore-trash'), { type: 'restore-trash', trashIds: ['new', 'old'] });
  assert.match(node('statusMessage').textContent, /2 more slot/);
  assert.equal(nodes.get('trashView').hidden, false);
  blockRestore = false; failHistory = true; await listeners['restoreTrashResultsButton:click'](); await new Promise((resolve) => setImmediate(resolve));
  assert.ok(messages.some((message) => message.type === 'get-history'));
  assert.match(node('statusMessage').textContent, /Restored successfully, but refreshing the list failed/); assert.equal(node('retryButton').hidden, false);
  assert.equal(confirmations.length, 0);
  failHistory = false; listeners['dashboardNav:click']({ target: { closest() { return { dataset: { view: 'trash' } }; } } }); await new Promise((resolve) => setImmediate(resolve));
  const singleRestoreStart = messages.filter((message) => message.type === 'restore-trash').length;
  listeners['trashList:click']({ target: { closest() { return { dataset: { action: 'restore-trash', eventId: 'old' } }; } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages.filter((message) => message.type === 'restore-trash')[singleRestoreStart], { type: 'restore-trash', trashIds: ['old'] });
  assert.equal(nodes.get('historyView').hidden, false); assert.equal(confirmations.length, 0);
  const restoreCount = messages.filter((message) => message.type === 'restore-trash').length;
  node('searchInput').value = 'new query'; listeners['searchInput:input']();
  listeners['restoreTrashResultsButton:click']();
  assert.equal(messages.filter((message) => message.type === 'restore-trash').length, restoreCount);
});

test('settings VM previews retention and new-domain impact with distinct save choices', async () => {
  const listeners = {}; const nodes = new Map(); const messages = []; let invalidPreview = false; let impactEvents = 0; let exclusionEvents = 0; let focused = ''; let confirmCount = 0;
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', parentNode: null,
      classList: { toggle() {} }, style: {}, elements: {}, children: [], addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; },
      setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      querySelectorAll() { return []; }, querySelector() { return node(); }, closest() { return { hidden: false }; }, focus() { focused = this.id || this.name; },
    }; nodes.set(id, value); return value;
  }
  const form = node('settingsForm');
  form.elements = Object.fromEntries(['maxRecords', 'maxAgeDays', 'trashMaxAgeDays', 'popupSize', 'language', 'theme', 'excludedDomains'].map((name) => { const input = node(`input-${name}`); input.name = name; return [name, input]; }));
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const settings = { maxRecords: null, maxAgeDays: null, trashMaxAgeDays: 3, pageSize: 50, language: 'zh', theme: 'dark', excludedDomains: [] };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm() { confirmCount += 1; return true; },
    location: { search: '?view=settings', pathname: '/dashboard.html' }, history: { replaceState() {}, pushState() {} },
    addEventListener(type, handler) { listeners[`window:${type}`] = handler; }, chrome: { runtime: { async sendMessage(message) {
      messages.push(structuredClone(message)); if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' };
      if (message.type === 'get-settings') return { ok: true, mode: 'normal', settings };
      if (message.type === 'preview-settings-impact' && invalidPreview) return { ok: false, error: { code: 'INVALID_SETTINGS', message: 'invalid', fields: { maxAgeDays: 'must be positive' } } };
      if (message.type === 'preview-settings-impact') return { ok: true, settings: { ...settings, ...message.settings }, impact: {
        combined: { historyEventCount: impactEvents + exclusionEvents, historyTabCount: impactEvents * 2 + exclusionEvents, trashEventCount: 0, trashTabCount: 0 },
        retention: { historyEventCount: impactEvents, historyTabCount: impactEvents * 2, trashEventCount: 0, trashTabCount: 0 },
        exclusions: { historyEventCount: exclusionEvents, historyTabCount: exclusionEvents, trashEventCount: 0, trashTabCount: 0 },
      } };
      if (message.type === 'save-settings' && invalidPreview) return { ok: false, error: { code: 'INVALID_SETTINGS', message: 'invalid', fields: { maxAgeDays: 'must be positive' } } };
      if (message.type === 'save-settings') return { ok: true, settings: { ...settings, ...message.settings }, settingsSaved: true, cleanupPending: true, otherContextPending: true };
      return { ok: true };
    } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context); await new Promise((resolve) => setImmediate(resolve));
  form.elements.maxRecords.value = ''; form.elements.maxAgeDays.value = '30'; form.elements.trashMaxAgeDays.value = '3';
  form.elements.popupSize.value = '200'; form.elements.language.value = 'en'; form.elements.theme.value = 'light';
  form.elements.excludedDomains.value = '';
  const submitEvent = { preventDefault() {} };
  await listeners['settingsForm:submit'](submitEvent);
  assert.equal(messages.filter((message) => message.type === 'save-settings').length, 1); assert.equal(confirmCount, 0);
  assert.equal(messages.filter((message) => message.type === 'preview-settings-impact').length, 1);
  const saved = messages.find((message) => message.type === 'save-settings');
  assert.deepEqual(saved.settings, { maxRecords: null, maxAgeDays: 30, trashMaxAgeDays: 3, pageSize: 50, popupSize: 200, language: 'en', theme: 'light', excludedDomains: [] });
  assert.match(node('settingsSummary').textContent, /next read or automatic cleanup/); assert.match(node('settingsSummary').textContent, /other regular or incognito browsing context/);

  impactEvents = 2; const savesBefore = messages.filter((message) => message.type === 'save-settings').length;
  await listeners['settingsForm:submit'](submitEvent); assert.equal(confirmCount, 0);
  assert.equal(messages.filter((message) => message.type === 'save-settings').length, savesBefore);
  assert.equal(node('settingsImpactPanel').hidden, false);
  assert.equal(node('saveSettingsButton').hidden, true);
  assert.match(node('settingsImpactMessage').textContent, /2 closed records/i);
  assert.match(node('settingsImpactMessage').textContent, /4 tabs/i);
  await listeners['confirmSettingsButton:click']();
  assert.equal(messages.filter((message) => message.type === 'save-settings').length, savesBefore + 1);
  assert.equal(messages.filter((message) => message.type === 'save-settings').at(-1).removeExistingExcludedMatches, false);
  assert.equal(node('settingsImpactPanel').hidden, true);
  assert.equal(node('saveSettingsButton').hidden, false);

  impactEvents = 0; exclusionEvents = 3; form.elements.excludedDomains.value = 'example.com';
  await listeners['settingsForm:submit'](submitEvent);
  assert.equal(node('settingsImpactPanel').hidden, false);
  assert.equal(node('saveSettingsButton').hidden, true);
  assert.match(node('settingsImpactMessage').textContent, /3 existing records/i);
  assert.equal(node('confirmSettingsAndRemoveButton').hidden, false);
  assert.match(node('confirmSettingsButton').textContent, /rules only/i);
  await listeners['confirmSettingsAndRemoveButton:click']();
  const exclusionSave = messages.filter((message) => message.type === 'save-settings').at(-1);
  assert.equal(exclusionSave.removeExistingExcludedMatches, true);
  assert.deepEqual(exclusionSave.settings.excludedDomains, ['example.com']);

  exclusionEvents = 0; impactEvents = 1; await listeners['settingsForm:submit'](submitEvent);
  assert.equal(node('settingsImpactPanel').hidden, false);
  listeners['settingsForm:input']();
  assert.equal(node('settingsImpactPanel').hidden, true);
  assert.equal(node('saveSettingsButton').hidden, false);
  assert.equal(node('confirmSettingsButton').disabled, true);
  await listeners['settingsForm:submit'](submitEvent);
  listeners['cancelSettingsImpactButton:click']();
  assert.equal(node('settingsImpactPanel').hidden, true);
  assert.equal(node('saveSettingsButton').hidden, false);

  invalidPreview = true; form.elements.maxAgeDays.value = '-1'; await listeners['settingsForm:submit'](submitEvent);
  assert.equal(focused, 'input-maxAgeDays'); assert.equal(node('maxAgeDaysError').textContent, 'Enter a positive integer or leave blank.');
  assert.equal(confirmCount, 0);
});

test('loading state preserves a deep-linked page until current results arrive', () => {
  assert.equal(helpers.resolveRenderPage({ loading: true, loadedQuery: null, query: '', page: 2 }, 1, 50), 2);
  assert.equal(helpers.resolveRenderPage({ loading: false, loadedQuery: '', query: '', page: 2 }, 1, 50), 1);
});

test('action pending keys reject duplicate work and release after completion', () => {
  const pending = new Set();
  assert.equal(helpers.beginAction(pending, 'move:one'), true);
  assert.equal(helpers.beginAction(pending, 'move:one'), false);
  helpers.endAction(pending, 'move:one');
  assert.equal(helpers.beginAction(pending, 'move:one'), true);
});

test('trash helpers sort newest first without deduplication and select complete matching events', () => {
  const results = [
    { event: { id: 'same-old', deletedAt: 1, tabs: [{ id: 'a' }] }, totalTabCount: 1 },
    { event: { id: 'same-new', deletedAt: 3, tabs: [{ id: 'b' }] }, totalTabCount: 1 },
    { event: { id: 'group', deletedAt: 2, tabs: [{ id: 'c' }, { id: 'd' }] }, totalTabCount: 2 },
  ];
  assert.deepEqual(helpers.sortTrashResults(results).map((item) => item.event.id), ['same-new', 'group', 'same-old']);
  assert.deepEqual(helpers.getResultSelection(helpers.sortTrashResults(results)), {
    eventIds: ['same-new', 'group', 'same-old'], eventCount: 3, tabCount: 4,
  });
});

test('settings helpers preserve strings until submit and convert only blank or integer values', () => {
  assert.deepEqual(helpers.buildRetentionPatch({ maxRecords: '', maxAgeDays: '30', trashMaxAgeDays: '3' }), {
    maxRecords: null, maxAgeDays: 30, trashMaxAgeDays: 3,
  });
  assert.deepEqual(helpers.buildRetentionPatch({ maxRecords: '1.5', maxAgeDays: '-2', trashMaxAgeDays: 'abc' }), {
    maxRecords: '1.5', maxAgeDays: '-2', trashMaxAgeDays: 'abc',
  });
  assert.deepEqual(helpers.getImpactCounts({
    historyEventCount: 2, historyTabCount: 4, trashEventCount: 3, trashTabCount: 7,
  }), { historyEvents: 2, historyTabs: 4, trashEvents: 3, trashTabs: 7, totalEvents: 5 });
});

test('dashboard declares complete trash and settings controls with permanent-retention guidance', () => {
  for (const id of ['trashList', 'trashResultSummary', 'trashPageSummary', 'trashPageSizeSelect',
    'restoreTrashResultsButton', 'emptyTrashButton', 'settingsSummary']) assert.match(html, new RegExp(`id=\"${id}\"`));
  assert.match(`${html}\n${js}`, /Move back to Closed tabs/);
  assert.match(`${html}\n${js}`, /移回关闭记录/);
  assert.match(`${html}\n${js}`, /Remove now/);
  assert.match(`${html}\n${js}`, /直接移除/);
  assert.match(`${html}\n${js}`, /browser storage/);
  assert.match(`${html}\n${js}`, /浏览器存储空间限制/);
  assert.doesNotMatch(html, /name="(?:maxRecords|maxAgeDays|trashMaxAgeDays)"[^>]*disabled/);
  assert.match(js, /Operation failed\. Please try again\./);
  assert.match(js, /操作失败，请重试。/);
  assert.doesNotMatch(js, /扩展请求失败|当前窗口的数据会/);
  assert.doesNotMatch(js, /其他标题或 URL/);
});

test('runtime uses explicit loaded trash ids, single permanent deletion, and an independent settings read', () => {
  assert.match(js, /type:\s*'get-trash',\s*query:\s*requestedQuery/);
  assert.match(js, /type:\s*'restore-trash',\s*trashIds:\s*selection\.eventIds/);
  assert.match(js, /type:\s*'restore-trash',\s*trashIds:\s*\[eventId\]/);
  assert.match(js, /type:\s*'permanently-delete-trash',\s*trashIds:\s*\[eventId\]/);
  assert.match(js, /type:\s*'empty-trash'/);
  assert.match(js, /type:\s*'get-settings'/);
  assert.match(js, /type:\s*'save-settings'/);
});

test('runtime keeps resource state and request tokens separate across views', () => {
  assert.match(js, /history:\s*createResourceState/);
  assert.match(js, /trash:\s*createResourceState/);
  assert.match(js, /settingsRequestToken/);
  assert.doesNotMatch(js, /state\.requestToken/);
  assert.doesNotMatch(js, /state\.results(?:[^A-Za-z]|$)/);
  assert.doesNotMatch(js, /isLoadedResultCurrent\(state\)/);
  assert.match(js, /renderEvent[\s\S]+currentResource\('history'\)/);
  assert.match(js, /renderTrashEvent[\s\S]+currentResource\('trash'\)/);
});

test('restore refresh failures use a partial-success message and leave retry available', () => {
  assert.match(js, /Restored successfully, but refreshing the list failed\. Please try again\./);
  assert.match(js, /恢复成功，但列表刷新失败，请重试。/);
  assert.match(js, /restoreRefreshFailed/);
});

test('deferred history mutation cannot overwrite Trash loaded after navigation', async () => {
  const listeners = {}; const nodes = new Map(); let resolveMove; let resolveDelete;
  const moveGate = new Promise((resolve) => { resolveMove = resolve; });
  const deleteGate = new Promise((resolve) => { resolveDelete = resolve; });
  function node(id = '') {
    if (nodes.has(id)) return nodes.get(id);
    const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', isConnected: true, parentNode: null, children: [], elements: {},
      classList: { toggle() {} }, addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; }, setAttribute() {}, removeAttribute() {},
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, querySelectorAll() { return []; }, querySelector() { return node(); },
      closest() { return { hidden: false }; }, focus() {}, dispatchEvent(event) { const handler = listeners[`${id}:${event.type}`]; if (handler) handler(event); },
    }; nodes.set(id, value); return value;
  }
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const response = (id, deletedAt) => ({ ok: true, mode: 'normal', settings: { language: 'en', theme: 'system', pageSize: 50 },
    results: [{ event: { id, closedAt: 1, deletedAt, tabs: [{ id: `${id}-tab`, title: id, url: `https://${id}.example` }] }, totalTabCount: 1, matchedTabCount: 1, matchRanges: {} }],
    totalEventCount: 1, totalTabCount: 1, resultEventCount: 1, matchedTabCount: 1 });
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm: () => true, location: { search: '?view=history', pathname: '/dashboard.html' },
    history: { replaceState() {}, pushState() {} }, addEventListener(type, handler) { listeners[`window:${type}`] = handler; },
    chrome: { runtime: { async sendMessage(message) {
      if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' };
      if (message.type === 'get-history') return response('history-only');
      if (message.type === 'get-trash') return response('trash-only', 2);
      if (message.type === 'move-to-trash') return moveGate;
      if (message.type === 'permanently-delete-trash') return deleteGate; return { ok: true };
    } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context); await new Promise((resolve) => setImmediate(resolve));
  listeners['historyList:click']({ target: { closest() { return { dataset: { action: 'move-event', eventId: 'history-only' } }; } } });
  listeners['dashboardNav:click']({ target: { closest() { return { dataset: { view: 'trash' } }; } } });
  await new Promise((resolve) => setImmediate(resolve)); resolveMove({ ok: true, moved: 1 }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node('trashView').hidden, false); assert.equal(node('trashResultSummary').textContent, '1 records (including Groups) · 1 tabs');
  assert.equal(node('trashList').attrs && node('trashList').attrs['aria-busy'], undefined);
  listeners['trashList:click']({ target: { closest() { return { dataset: { action: 'delete-trash', eventId: 'trash-only' } }; } } });
  listeners['dashboardNav:click']({ target: { closest() { return { dataset: { view: 'history' } }; } } });
  await new Promise((resolve) => setImmediate(resolve)); resolveDelete({ ok: true, deleted: 1 }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node('historyView').hidden, false); assert.equal(node('resultSummary').textContent, '1 records (including Groups) · 1 tabs');
});

test('late invalid save response is ignored after navigating away', async () => {
  const listeners = {}; const nodes = new Map(); let resolveSave; let focused = ''; const saveGate = new Promise((resolve) => { resolveSave = resolve; });
  function node(id = '') { if (nodes.has(id)) return nodes.get(id); const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', children: [], elements: {}, isConnected: true, classList: { toggle() {} },
    addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; }, setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, querySelectorAll() { return []; }, closest() { return { hidden: false }; }, focus() { focused = id; } }; nodes.set(id, value); return value; }
  const form = node('settingsForm'); form.elements = Object.fromEntries(['maxRecords', 'maxAgeDays', 'trashMaxAgeDays'].map((name) => [name, node(name)]));
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; }, addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const empty = { ok: true, mode: 'normal', settings: { language: 'en', theme: 'system', pageSize: 50 }, results: [], totalEventCount: 0, totalTabCount: 0, resultEventCount: 0, matchedTabCount: 0 };
  let saves = 0; const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm: () => true, location: { search: '?view=settings', pathname: '/dashboard.html' }, history: { replaceState() {}, pushState() {} }, addEventListener(type, handler) { listeners[`window:${type}`] = handler; }, chrome: { runtime: { async sendMessage(message) { if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' }; if (message.type === 'get-settings' || message.type === 'get-history') return empty; if (message.type === 'save-settings') { saves += 1; return saveGate; } return empty; } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context); await new Promise((resolve) => setImmediate(resolve));
  const submit = listeners['settingsForm:submit']({ preventDefault() {} }); await new Promise((resolve) => setImmediate(resolve));
  listeners['dashboardNav:click']({ target: { closest() { return { dataset: { view: 'history' } }; } } });
  resolveSave({ ok: false, error: { code: 'INVALID_SETTINGS', message: 'invalid', fields: { maxRecords: 'bad' } } }); await submit;
  assert.equal(focused, ''); assert.equal(saves, 1); assert.equal(node('historyView').hidden, false);
});

test('late save-settings response cannot update settings UI after navigation', async () => {
  const listeners = {}; const nodes = new Map(); let resolveSave; let focused = ''; const saveGate = new Promise((resolve) => { resolveSave = resolve; });
  function node(id = '') { if (nodes.has(id)) return nodes.get(id); const value = { id, dataset: {}, hidden: false, disabled: false, value: '', textContent: '', children: [], elements: {}, isConnected: true, classList: { toggle() {} }, addEventListener(type, handler) { listeners[`${id}:${type}`] = handler; }, setAttribute() {}, removeAttribute() {}, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, querySelectorAll() { return []; }, closest() { return { hidden: false }; }, focus() { focused = id; } }; nodes.set(id, value); return value; }
  const form = node('settingsForm'); form.elements = Object.fromEntries(['maxRecords', 'maxAgeDays', 'trashMaxAgeDays'].map((name) => [name, node(name)]));
  const document = { documentElement: { dataset: {} }, title: '', getElementById: node, querySelectorAll() { return []; }, addEventListener(type, handler) { listeners[`document:${type}`] = handler; }, createElement() { return node(); }, createTextNode(value) { return { value }; } };
  const settings = { maxRecords: 10, maxAgeDays: 5, trashMaxAgeDays: 3, pageSize: 50, language: 'en', theme: 'light' }; const empty = { ok: true, mode: 'normal', settings, results: [], totalEventCount: 0, totalTabCount: 0, resultEventCount: 0, matchedTabCount: 0 };
  const context = { document, URL, URLSearchParams, Event, setTimeout, clearTimeout, confirm: () => true, location: { search: '?view=settings', pathname: '/dashboard.html' }, history: { replaceState() {}, pushState() {} }, addEventListener(type, handler) { listeners[`window:${type}`] = handler; }, chrome: { runtime: { async sendMessage(message) { if (message.type === 'get-current-mode') return { ok: true, mode: 'normal' }; if (message.type === 'get-settings' || message.type === 'get-history') return empty; if (message.type === 'preview-settings-impact') return { ok: true, impact: { historyEventCount: 0, trashEventCount: 0 } }; if (message.type === 'save-settings') return saveGate; return empty; } }, storage: { session: { async get() { return {}; }, async set() {} } } } };
  context.globalThis = context; vm.runInNewContext(js, context); await new Promise((resolve) => setImmediate(resolve));
  form.elements.maxRecords.value = '20'; const submit = listeners['settingsForm:submit']({ preventDefault() {} }); await new Promise((resolve) => setImmediate(resolve));
  listeners['dashboardNav:click']({ target: { closest() { return { dataset: { view: 'history' } }; } } }); await new Promise((resolve) => setImmediate(resolve));
  const statusBefore = node('statusMessage').textContent; const formBefore = form.elements.maxRecords.value;
  resolveSave({ ok: true, settings: { ...settings, maxRecords: 99, language: 'zh', theme: 'dark' }, settingsSaved: true }); await submit;
  assert.equal(document.documentElement.lang, 'en'); assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(form.elements.maxRecords.value, formBefore); assert.equal(node('statusMessage').textContent, statusBefore); assert.equal(focused, '');
});

test('runtime clears loading on errors, exposes retry, and gives only groups disclosure buttons', () => {
  assert.match(html, /id="retryButton"/);
  assert.ok(js.includes("data.loading = false; data.loadedQuery = null; if (state.view === 'history') showError(error);"));
  assert.ok(js.includes("retry.addEventListener('click'"));
  assert.ok(js.includes('if (isGroup) {'));
  assert.ok(js.includes('else { toggle = null; }'));
  assert.equal(js.includes("toggle.textContent = '•'"), false);
});

test('runtime never exposes raw protocol error messages as user-facing copy', () => {
  assert.equal(js.includes('showStatus(error.message'), false);
  assert.equal(js.includes("makeStateNode('error-state', t('requestFailed'), error.message)"), false);
  assert.match(js, /invalidOptional: 'Enter a positive integer or leave blank.'/);
  assert.match(js, /invalidOptional: '请输入正整数或留空。'/);
});

test('dashboard shows group matched/total counts and localizes storage failures', () => {
  assert.match(js, /groupMatch:/);
  assert.ok(js.includes('matched: result.matchedTabCount'));
  assert.match(js, /storageWriteFailed: 'Could not save data to browser storage/);
  assert.match(js, /storageWriteFailed: '无法将数据保存到浏览器存储空间/);
  assert.match(js, /STORAGE_WRITE_FAILED/);
  assert.match(js, /function errorMessage/);
});

test('runtime localizes navigation, history, search, and pagination aria labels', () => {
  for (const key of ['dashboardLabel', 'historyListLabel', 'searchAriaLabel', 'paginationLabel']) {
    assert.equal((js.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} must be bilingual`);
  }
  assert.ok(js.includes("setAttribute('aria-label', t('dashboardLabel'))"));
  assert.ok(js.includes("setAttribute('aria-label', t('paginationLabel'))"));
});

test('bulk destructive actions use inline confirmation instead of native dialogs', () => {
  assert.doesNotMatch(js, /root\.confirm\(|window\.confirm\(/);
  assert.match(js, /permanently-delete-history', all: true, query: pending\.query/);
  assert.match(js, /elements\.emptyTrash\.addEventListener\('click', showTrashEmptyConfirmation\)/);
  assert.match(js, /clearDestructiveConfirmation\(\);\s*state\.historyLayout = button\.dataset\.historyLayout/);
  assert.match(js, /clearDestructiveConfirmation\(\); state\.selectedDomain = button\.dataset\.domainKey/);
});

test('dashboard keeps long addresses separate from always-visible relative times', () => {
  assert.match(js, /className = 'event-address'/);
  assert.match(js, /className = 'event-details-inline'/);
  assert.ok(js.includes("setTime(time, event.closedAt, t('closedTimePrefix'))"));
  assert.match(js, /trashTiming/);
  assert.match(css, /\.event-summary \.event-address[^}]*text-overflow:\s*ellipsis/s);
  assert.match(css, /\.event-summary \.event-time[^}]*flex:\s*0 0 auto/s);
});
