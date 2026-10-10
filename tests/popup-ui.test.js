const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const extensionRoot = path.resolve(__dirname, '../extension');
const html = fs.readFileSync(path.join(extensionRoot, 'popup.html'), 'utf8');
const css = fs.readFileSync(path.join(extensionRoot, 'popup.css'), 'utf8');
const js = fs.readFileSync(path.join(extensionRoot, 'popup.js'), 'utf8');
const helpers = require(path.join(extensionRoot, 'popup.js'));
const timeFormat = require(path.join(extensionRoot, 'lib/time-format.js'));

function result(id, tabs = [{ id: 'tab-' + id, title: 'Title ' + id, url: 'https://' + id + '.example/' }], matchedTabs = tabs) {
  return { event: { id, kind: tabs.length > 1 ? 'group' : 'single', closedAt: Date.now(), tabs },
    matchedTabs, matchedTabCount: matchedTabs.length, totalTabCount: tabs.length, matchRanges: {} };
}

function createVm(responder, runtime = {}) {
  const nodes = new Map(); const listeners = {}; const messages = []; let closeCount = 0;
  function makeNode(id = '', localName = '') {
    if (id && nodes.has(id)) return nodes.get(id);
    const value = { id, localName, dataset: {}, style: {}, hidden: id === 'migrationNotice', disabled: false, value: '', textContent: '', title: '', children: [],
      classList: { toggle(name, enabled) { value['class-' + name] = enabled; } },
      addEventListener(type, handler) { listeners[id + ':' + type] = handler; },
      setAttribute(name, data) { this[name] = String(data); }, removeAttribute(name) { delete this[name]; },
      append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); return item; },
      replaceChildren(...items) { this.children = items; }, focus() { this.focusCount = (this.focusCount || 0) + 1; }, select() {}, closest() { return null; },
      getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    };
    if (id) nodes.set(id, value); return value;
  }
  const document = { documentElement: { dataset: {}, lang: '' }, getElementById: makeNode, querySelectorAll() { return []; },
    addEventListener(type, handler) { listeners['document:' + type] = handler; }, createElement(localName) { return makeNode('', localName); },
    createDocumentFragment() { return makeNode(); } };
  const context = { document, URL, Element: function Element() {}, Event, setTimeout: runtime.setTimeout || setTimeout, clearTimeout: runtime.clearTimeout || clearTimeout, structuredClone, innerWidth: 400, innerHeight: 600,
    TabEchoTimeFormat: timeFormat,
    window: { close() { closeCount += 1; } }, chrome: { runtime: { async sendMessage(message) {
      messages.push(structuredClone(message)); return responder(message);
    } } } };
  context.globalThis = context;
  vm.runInNewContext(js, context, { filename: 'popup.js' });
  return { context, nodes, listeners, messages, get closeCount() { return closeCount; } };
}

async function settle() { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); }
function flatten(node) { return [node, ...(node.children || []).flatMap(flatten)]; }

test('statistics snapshots are authoritative even when an exact count is zero', () => {
  const counts = helpers.readStatistics({
    statistics: { revision: 4, totalRecords: 0, totalTabs: 0, matchingRecords: 0, matchingTabs: 0, resultTabs: 0, displayedRecords: 0 },
    totalEventCount: 99, totalTabCount: 99, resultEventCount: 99, resultTabCount: 99,
  }, [result('legacy')]);
  assert.deepEqual(counts, {
    revision: 4, totalRecords: 0, totalTabs: 0, matchingRecords: 0, matchingTabs: 0, resultTabs: 0, displayedRecords: 0,
  });
});

test('popup is a compact quick-entry surface without paging, embedded settings, or clear-all', () => {
  for (const id of ['searchInput', 'settingsButton', 'trashButton', 'trashCount', 'historyList', 'viewAllButton']) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.doesNotMatch(html + '\n' + js + '\n' + css, /refreshButton|refresh-button/);
  assert.doesNotMatch(html, /<input[^>]+id="searchInput"[^>]+autofocus/);
  assert.match(js, /event\.key === '\/'[^}]+elements\.searchInput\.focus\(\)/);
  assert.doesNotMatch(html, /settingsPanel|maxRecordsInput|pageSizeInput|prevPageButton|nextPageButton|clearButton/);
  assert.doesNotMatch(js, /get-state|searchEvents|getPagedEvents|clear-mode|save-settings/);
  assert.match(css, /body\s*\{[^}]*width:\s*400px[^}]*height:\s*600px/s);
  assert.match(css, /\.event-row\s*\{[^}]*min-height:\s*5[2-6]px/s);
  assert.match(css, /\.history-list\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/s);
  assert.match(html, /id="bulkMoveButton" class="bulk-move-button"/);
  assert.match(css, /\.bulk-move-button\s*\{[^}]*border:\s*1px solid/s);
  assert.match(css, /\.bulk-move-button\s*\{[^}]*background:\s*var\(--panel\)/s);
  assert.match(css, /\.reopen-button\s*\{[^}]*background:\s*var\(--accent\)/s);
  assert.match(js, /moveShown:\s*'Move to Trash \(\{count\}\)'/);
  assert.match(js, /moveShown:\s*'移入回收站（\{count\}）'/);
  for (const id of ['bulkRemoveMenu', 'removeShownButton', 'removeAllButton']) assert.match(html, new RegExp('id="' + id + '"'));
  assert.match(js, /setAttribute\('aria-label', t\('moveShownLabel'/);
  assert.match(html, /id="actionTooltip"[^>]+role="tooltip"/);
  assert.match(js, /button\.dataset\.tooltip = label/);
  assert.match(js, /elements\.historyList\.addEventListener\('pointerover', showActionTooltip/);
  assert.match(js, /elements\.bulkMoveButton\.addEventListener\('pointerenter', showActionTooltip/);
  assert.match(js, /elements\.bulkMoveButton\.dataset\.tooltip = t\('moveShownLabel'/);
  assert.match(css, /\.action-tooltip\s*\{[^}]*max-width:\s*calc\(100vw - 16px\)[^}]*white-space:\s*normal/s);
  assert.doesNotMatch(js, /button\.title = label/);
  assert.doesNotMatch(js, /elements\.bulkMoveButton\.title/);
  assert.match(html, /<script src="lib\/time-format\.js"><\/script>[\s\S]*<script src="popup\.js"><\/script>/);
  assert.match(css, /\.event-time\s*\{[^}]*white-space:\s*nowrap/s);
});

test('Popup exposes search, list, and remove disclosure semantics without menu claims', () => {
  assert.match(html, /<search class="search-row">/);
  assert.match(html, /id="historyList"[^>]*role="list"/);
  assert.match(html, /id="bulkRemoveButton"[^>]*aria-controls="bulkRemoveMenu"/);
  assert.doesNotMatch(html, /id="bulkRemoveButton"[^>]*aria-haspopup/);
  assert.match(html, /id="bulkRemovePanel"[^>]*role="region"[^>]*aria-live="polite"/);
});

test('Popup focuses the search field as soon as it opens', () => {
  const app = createVm(async () => ({ ok: true, mode: 'normal', settings: { language: 'en' }, results: [], resultEventCount: 0 }));

  app.listeners['document:DOMContentLoaded']();

  assert.equal(app.nodes.get('searchInput').focusCount, 1);
});

test('Popup search preserves literal queries and errors use an assertive live region', () => {
  assert.match(html, /id="searchInput"[^>]*autocorrect="off"[^>]*autocapitalize="off"[^>]*spellcheck="false"/);
  assert.match(js, /setAttribute\('aria-live', error \? 'assertive' : 'polite'\)/);
});

test('Popup keeps hidden menus and inline confirmations collapsed by default', () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s);
  assert.match(html, /id="bulkRemoveMenu"[^>]*\shidden(?:\s|>)/);
  assert.match(html, /id="bulkRemovePanel"[^>]*\shidden(?:\s|>)/);
});

test('Popup delays closing the bulk remove menu and cancels it when the pointer returns', async () => {
  const timers = new Map(); let nextTimer = 0;
  const runtime = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'zh' }, results: [result('one')], resultEventCount: 1 }, runtime);

  app.listeners['document:DOMContentLoaded']();
  await settle();

  app.listeners['bulkRemoveButton:click']();
  assert.equal(app.nodes.get('bulkRemoveMenu').hidden, false);
  assert.equal(app.nodes.get('bulkRemoveButton')['aria-expanded'], 'true');
  assert.equal(typeof app.listeners['bulkRemoveMenuWrap:pointerleave'], 'function');
  assert.equal(typeof app.listeners['bulkRemoveMenuWrap:pointerenter'], 'function');

  app.listeners['bulkRemoveMenuWrap:pointerleave']();
  assert.equal(app.nodes.get('bulkRemoveMenu').hidden, false);
  const pending = [...timers.values()].find((timer) => timer.delay === 300);
  assert.ok(pending);

  app.listeners['bulkRemoveMenuWrap:pointerenter']();
  assert.equal([...timers.values()].some((timer) => timer.delay === 300), false);
  assert.equal(app.nodes.get('bulkRemoveMenu').hidden, false);
});

test('Popup closes the bulk remove menu after the pointer stays away', async () => {
  const timers = new Map(); let nextTimer = 0;
  const runtime = {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'zh' }, results: [result('one')], resultEventCount: 1 }, runtime);

  app.listeners['document:DOMContentLoaded'](); await settle();
  app.listeners['bulkRemoveButton:click']();
  app.listeners['bulkRemoveMenuWrap:pointerleave']();
  const pending = [...timers.values()].find((timer) => timer.delay === 300);
  assert.ok(pending); pending.callback();
  assert.equal(app.nodes.get('bulkRemoveMenu').hidden, true);
  assert.equal(app.nodes.get('bulkRemoveButton')['aria-expanded'], 'false');
});

test('Popup renders compact relative close times for single and grouped events with full-time disclosure', async () => {
  const closedAt = Date.now() - 5 * 60 * 1000;
  const single = result('single'); single.event.closedAt = closedAt;
  const group = result('group', [
    { id: 'one', title: 'One', url: 'https://one.example/' },
    { id: 'two', title: 'Two', url: 'https://two.example/' },
  ]);
  group.event.closedAt = closedAt;
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'en' }, results: [single, group], resultEventCount: 2 });

  app.listeners['document:DOMContentLoaded'](); await settle();
  const times = flatten(app.nodes.get('historyList')).filter((node) => node.localName === 'time');

  assert.equal(times.length, 2);
  for (const time of times) {
    assert.equal(time.className, 'event-time');
    assert.equal(time.textContent, '5 minutes ago');
    assert.equal(time.title, '');
    assert.equal(time.dataset.fullTime, timeFormat.formatFullTime(closedAt, 'en'));
    assert.equal(time['aria-label'], time.dataset.fullTime);
    assert.equal(time.datetime, new Date(closedAt).toISOString());
  }
});

test('Popup keeps the bulk action tooltip inside the visible popup bounds', async () => {
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'zh' }, results: [result('one')], resultEventCount: 1 });
  app.listeners['document:DOMContentLoaded'](); await settle();
  const button = app.nodes.get('bulkMoveButton');
  const tooltip = app.nodes.get('actionTooltip');
  button.closest = () => button;
  button.getBoundingClientRect = () => ({ left: 340, top: 120, right: 390, bottom: 152, width: 50, height: 32 });
  tooltip.getBoundingClientRect = () => ({ left: 0, top: 0, right: 180, bottom: 40, width: 180, height: 40 });

  app.listeners['bulkMoveButton:pointerenter']({ target: button });

  assert.equal(tooltip.hidden, false);
  assert.equal(tooltip.style.left, '212px');
  assert.equal(tooltip.style.top, '72px');
});

test('popup keeps bilingual domain copy and avoids legacy wording', () => {
  for (const copy of ['Reopen', '重新打开', 'Move to Trash', '移至回收站', 'Regular window · Closed tabs',
    '常规窗口 · 已关闭标签页', 'Incognito window · Closed tabs', '无痕窗口 · 已关闭标签页']) {
    assert.ok((html + '\n' + js).includes(copy), 'missing copy: ' + copy);
  }
  assert.doesNotMatch(html + '\n' + js, /Normal history|普通历史|current mode|当前模式|搜索标题或 URL/);
  assert.match(html, /role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="migrationNotice"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(js, /\.innerHTML\s*=/);
});

test('Popup renders the localized migration notice before acknowledging it once', async () => {
  const notice = { id: 'notice-popup', version: 2, skippedEvents: 5, createdAt: 12345 };
  let app;
  app = createVm(async (message) => {
    if (message.type === 'get-migration-notice') return { ok: true, notice };
    if (message.type === 'get-settings') return { ok: true, settings: { language: 'zh' } };
    if (message.type === 'acknowledge-migration-notice') {
      assert.equal(app.nodes.get('migrationNotice').textContent, '已迁移现有关闭记录，其中 5 条损坏记录无法恢复。');
      assert.equal(app.nodes.get('migrationNotice').hidden, false);
      assert.equal(message.id, notice.id);
      return { ok: true, acknowledged: true };
    }
    if (message.type === 'get-history') return { ok: true, mode: 'normal', settings: { language: 'zh' }, results: [], resultEventCount: 0 };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    return { ok: true };
  });

  app.listeners['document:DOMContentLoaded']();
  await settle();

  assert.deepEqual(app.messages.filter((message) => /migration-notice/.test(message.type)), [
    { type: 'get-migration-notice' },
    { type: 'acknowledge-migration-notice', id: notice.id },
  ]);
});

test('Popup localizes and acknowledges a notice from settings even when history fails', async () => {
  const notice = { id: 'notice-settings', version: 2, skippedEvents: 6, createdAt: 12345 };
  const app = createVm(async (message) => {
    if (message.type === 'get-migration-notice') return { ok: true, notice };
    if (message.type === 'get-settings') return { ok: true, settings: { language: 'zh', theme: 'dark' } };
    if (message.type === 'get-history') throw new Error('history failed');
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    return { ok: true, acknowledged: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('migrationNotice').textContent, '已迁移现有关闭记录，其中 6 条损坏记录无法恢复。');
  assert.equal(app.nodes.get('migrationNotice').hidden, false);
  assert.ok(app.messages.some((message) => message.type === 'acknowledge-migration-notice'));
});

test('Popup leaves a notice hidden and unacknowledged when independent settings fail', async () => {
  const app = createVm(async (message) => {
    if (message.type === 'get-migration-notice') return { ok: true, notice: { id: 'retry', version: 2, skippedEvents: 1, createdAt: 1 } };
    if (message.type === 'get-settings') throw new Error('settings failed');
    if (message.type === 'get-history') return { ok: true, settings: { language: 'zh' }, results: [], resultEventCount: 0 };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    return { ok: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('migrationNotice').hidden, true);
  assert.equal(app.messages.some((message) => message.type === 'acknowledge-migration-notice'), false);
});

test('popup uses the query protocol, caps event results, and exposes counted dashboard navigation', () => {
  assert.match(js, /type:\s*'get-history'/);
  assert.match(js, /type:\s*'get-trash'/);
  assert.match(js, /slice\(0,\s*popupSize\(\)\)/);
  assert.match(js, /type:\s*'get-history',\s*query:\s*requestedQuery,\s*offset:\s*0,\s*limit:\s*popupSize\(\)/);
  assert.match(js, /type:\s*'get-trash',\s*query:\s*'',\s*offset:\s*0,\s*limit:\s*1/);
  assert.match(js, /MAX_POPUP_SIZE = 200/);
  assert.match(js, /resultEventCount/);
  assert.match(js, /type:\s*'open-dashboard',\s*view:\s*'history',\s*q:/);
  assert.match(js, /type:\s*'open-dashboard',\s*view:\s*'trash'/);
  assert.match(js, /type:\s*'open-dashboard',\s*view:\s*'settings'/);
});

test('popup display limit defaults to 10 and supports up to 200 entries', () => {
  assert.equal(helpers.popupSize(), 10);
  assert.equal(helpers.popupSize({ popupSize: 1 }), 1);
  assert.equal(helpers.popupSize({ popupSize: 200 }), 200);
  assert.equal(helpers.popupSize({ popupSize: 201 }), 10);
});

test('popup operations use explicit visible ids and distinguish tab and event reopen', () => {
  assert.match(js, /type:\s*'move-to-trash',\s*eventIds:/);
  assert.doesNotMatch(js, /type:\s*'move-to-trash'[^}]+(?:all|query):/s);
  assert.match(js, /type:\s*'reopen-tab'/);
  assert.match(js, /type:\s*'reopen-event'/);
  assert.match(js, /matchedTabs/);
  assert.match(js, /requestToken/);
  assert.match(js, /pending/);
});

test('popup preserves theme, focus, reduced-motion, structured errors, and safe startup', () => {
  assert.ok(css.includes(':root[data-theme="dark"]'));
  assert.ok(css.includes(':root[data-theme="light"]'));
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(js, /response && response\.error/);
  assert.match(js, /Operation failed\. Please try again\./);
  assert.match(js, /DOMContentLoaded/);
  assert.match(js, /root\.TabEchoPopup/);
});

test('VM renders ten of twenty-one events, total and trash counts, and explicit visible bulk ids', async () => {
  const results = Array.from({ length: 21 }, (_, index) => result('event-' + index));
  let moveResolve; const moveGate = new Promise((resolve) => { moveResolve = resolve; });
  const app = createVm(async (message) => {
    if (message.type === 'get-history') return { ok: true, mode: 'normal', settings: { language: 'en', theme: 'system' }, results, resultEventCount: 21 };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 7 };
    if (message.type === 'move-to-trash') { await moveGate; return { ok: true, moved: 10 }; }
    return { ok: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('historyList').children[0].children.length, 10);
  assert.equal(app.nodes.get('resultSummary').textContent, '21 records · showing 10');
  assert.equal(app.nodes.get('viewAllButton').textContent, 'Open full list');
  assert.equal(app.nodes.get('viewAllButton').hidden, false);
  assert.equal(app.nodes.get('trashCount').textContent, '7');
  const first = app.listeners['bulkMoveButton:click'](); const second = app.listeners['bulkMoveButton:click'](); await settle();
  const moves = app.messages.filter((message) => message.type === 'move-to-trash');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].eventIds, results.slice(0, 10).map((item) => item.event.id));
  moveResolve(); await Promise.all([first, second]);
});

test('Popup uses raw unfiltered totals without showing a conflicting deduplicated count', async () => {
  const visible = [result('visible')];
  const app = createVm(async (message) => {
    if (message.type === 'get-settings') return { ok: true, settings: { language: 'zh', popupSize: 10 } };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    if (message.type === 'get-history' && message.query === 'needle') return {
      ok: true, mode: 'normal', settings: { language: 'zh', popupSize: 10 }, results: visible,
      totalEventCount: 2690, totalTabCount: 2712, resultEventCount: 8, resultTabCount: 9,
    };
    if (message.type === 'get-history') return {
      ok: true, mode: 'normal', settings: { language: 'zh', popupSize: 10 }, results: visible,
      totalEventCount: 2690, totalTabCount: 2712, resultEventCount: 2008, resultTabCount: 2030,
    };
    if (message.type === 'prepare-destructive-action') return message.query === 'needle'
      ? { ok: true, token: 'search-token', eventCount: 8, tabCount: 9 }
      : { ok: true, token: 'all-token', eventCount: 2690, tabCount: 2712 };
    return { ok: true };
  });

  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('resultSummary').textContent, '2690 条记录 · 显示 1 条');
  assert.equal(app.nodes.get('viewAllButton').textContent, '打开完整列表');
  app.listeners['bulkRemoveButton:click'](); await app.listeners['removeAllButton:click']();
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /2690 条关闭记录/);
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /2712 个标签页/);

  await app.context.TabEchoPopup.refresh('needle');
  assert.equal(app.nodes.get('resultSummary').textContent, '8 条匹配 · 显示 1 条');
  assert.equal(app.nodes.get('viewAllButton').textContent, '查看全部 8 条结果');
  app.listeners['bulkRemoveButton:click'](); await app.listeners['removeAllButton:click']();
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /8 条关闭记录/);
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /9 个标签页/);
});

test('VM honors a configured popup limit up to 200 entries', async () => {
  const results = Array.from({ length: 205 }, (_, index) => result('configured-' + index));
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'en', popupSize: 200 }, results, resultEventCount: 205 });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('historyList').children[0].children.length, 200);
  assert.equal(app.nodes.get('bulkMoveLabel').textContent, 'Move to Trash (200)');
  assert.equal(app.nodes.get('viewAllButton').hidden, false);
});

test('Popup bulk removal confirms and removes every query result beyond the display limit', async () => {
  const results = Array.from({ length: 10 }, (_, index) => result('visible-' + index));
  const app = createVm(async (message) => {
    if (message.type === 'get-settings') return { ok: true, settings: { language: 'zh', popupSize: 10 } };
    if (message.type === 'get-history') return { ok: true, mode: 'normal', settings: { language: 'zh', popupSize: 10 }, results, totalEventCount: 500, totalTabCount: 620, resultEventCount: 500, resultTabCount: 620 };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    if (message.type === 'prepare-destructive-action') return { ok: true, token: 'all-token', eventCount: 500, tabCount: 620 };
    if (message.type === 'commit-destructive-action') return { ok: true, deleted: 500 };
    return { ok: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('bulkRemoveButton').textContent, '直接移除');
  app.listeners['bulkRemoveButton:click']();
  assert.equal(app.nodes.get('removeShownButton').textContent, '移除当前显示的 10 条');
  assert.equal(app.nodes.get('removeAllButton').textContent, '全部移除（500）');
  await app.listeners['removeAllButton:click']();
  assert.equal(app.messages.some((message) => message.type === 'commit-destructive-action'), false);
  assert.equal(app.nodes.get('bulkRemovePanel').hidden, false);
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /500 条关闭记录/);
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /620 个标签页/);
  await app.listeners['confirmBulkRemoveButton:click']();
  assert.deepEqual(app.messages.find((message) => message.type === 'prepare-destructive-action'), {
    type: 'prepare-destructive-action', operation: 'delete-history', all: true, query: '',
  });
  assert.deepEqual(app.messages.find((message) => message.type === 'commit-destructive-action'), {
    type: 'commit-destructive-action', token: 'all-token',
  });
});

test('Popup loads the latest settings before applying its display limit', async () => {
  const results = Array.from({ length: 100 }, (_, index) => result('saved-limit-' + index));
  const app = createVm(async (message) => {
    if (message.type === 'get-settings') return { ok: true, settings: { language: 'en', popupSize: 100 } };
    if (message.type === 'get-history') return { ok: true, mode: 'normal', settings: { language: 'en', popupSize: 10 }, results, resultEventCount: 100 };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    return { ok: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('historyList').children[0].children.length, 100);
  const ordered = app.messages.map((message) => message.type);
  assert.ok(ordered.indexOf('get-settings') < ordered.indexOf('get-history'));
});

test('VM keeps the full-list entry visible without a search even when every result fits', async () => {
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'en' }, results: [result('one')], resultEventCount: 1 });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('viewAllButton').hidden, false);
});

test('Popup removal menu can remove only the shown records', async () => {
  const results = Array.from({ length: 10 }, (_, index) => result('shown-' + index));
  const app = createVm(async (message) => {
    if (message.type === 'get-settings') return { ok: true, settings: { language: 'zh', popupSize: 10 } };
    if (message.type === 'get-history') return { ok: true, mode: 'normal', settings: { language: 'zh', popupSize: 10 }, results, totalEventCount: 200, totalTabCount: 220, resultEventCount: 200, resultTabCount: 220 };
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    if (message.type === 'prepare-destructive-action') return { ok: true, token: 'shown-token', eventCount: 10, tabCount: 10 };
    if (message.type === 'commit-destructive-action') return { ok: true, deleted: 10 };
    return { ok: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  app.listeners['bulkRemoveButton:click']();
  assert.equal(app.nodes.get('bulkRemoveMenu').hidden, false);
  await app.listeners['removeShownButton:click']();
  assert.equal(app.nodes.get('bulkRemoveMenu').hidden, true);
  assert.match(app.nodes.get('bulkRemoveMessage').textContent, /当前显示的 10 条/);
  await app.listeners['confirmBulkRemoveButton:click']();
  assert.deepEqual(app.messages.find((message) => message.type === 'prepare-destructive-action'), {
    type: 'prepare-destructive-action', operation: 'delete-history', eventIds: results.map((item) => item.event.id),
  });
  assert.deepEqual(app.messages.find((message) => message.type === 'commit-destructive-action'), {
    type: 'commit-destructive-action', token: 'shown-token',
  });
});

test('Popup hides counted full-result navigation only when searched results fit', async () => {
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: true, mode: 'normal', settings: { language: 'en', popupSize: 10 }, results: [result('one')], resultEventCount: 1 });
  app.listeners['document:DOMContentLoaded'](); await settle();
  await app.context.TabEchoPopup.refresh('needle');
  assert.equal(app.nodes.get('viewAllButton').hidden, true);
});

test('VM sends dashboard destinations and history query', async () => {
  const app = createVm(async (message) => message.type.startsWith('get-')
    ? { ok: true, mode: 'normal', settings: { language: 'en' }, results: [], resultEventCount: 0 }
    : { ok: true });
  app.listeners['document:DOMContentLoaded'](); await settle(); app.nodes.get('searchInput').value = 'needle';
  await app.listeners['viewAllButton:click'](); await app.listeners['trashButton:click'](); await app.listeners['settingsButton:click']();
  assert.deepEqual(app.messages.filter((message) => message.type === 'open-dashboard'), [
    { type: 'open-dashboard', view: 'history', q: 'needle' }, { type: 'open-dashboard', view: 'trash' }, { type: 'open-dashboard', view: 'settings' },
  ]);
  assert.equal(app.closeCount, 3);
});

test('VM keeps newest query and renders only matched group children with complete-event actions', async () => {
  let oldResolve; const oldGate = new Promise((resolve) => { oldResolve = resolve; });
  const tabs = [{ id: 'one', title: 'Needle', url: 'https://one.example/' }, { id: 'two', title: 'Other', url: 'https://two.example/' }];
  const app = createVm(async (message) => {
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    if (message.query === 'old') { await oldGate; return { ok: true, settings: { language: 'en' }, results: [result('old')], resultEventCount: 1 }; }
    if (message.query === 'needle') return { ok: true, settings: { language: 'en' }, results: [result('group', tabs, [tabs[0]])], resultEventCount: 1 };
    return { ok: true, settings: { language: 'en' }, results: [], resultEventCount: 0 };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  const old = app.context.TabEchoPopup.refresh('old'); await settle();
  await app.context.TabEchoPopup.refresh('needle'); oldResolve(); await old;
  const rendered = flatten(app.nodes.get('historyList'));
  assert.ok(rendered.some((node) => node.textContent === 'Needle'));
  assert.ok(!rendered.some((node) => node.textContent === 'Other'));
  assert.ok(!rendered.some((node) => node.textContent === 'Title old'));
  assert.ok(rendered.some((node) => node.dataset.action === 'reopen-tab' && node.dataset.tabId === 'one'));
  assert.ok(rendered.some((node) => node.dataset.action === 'reopen-event' && node.dataset.eventId === 'group'));
  assert.ok(rendered.some((node) => node.dataset.action === 'move-event' && node.dataset.eventId === 'group'));
  assert.ok(rendered.some((node) => node.textContent === '1 of 2 tabs match'));
});

test('popup localizes stable storage write failures', async () => {
  const app = createVm(async (message) => {
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 0 };
    if (message.type === 'get-history') return { ok: true, settings: { language: 'zh' }, results: [result('one')], resultEventCount: 1 };
    if (message.type === 'move-to-trash') return { ok: false, error: { code: 'STORAGE_WRITE_FAILED', message: 'raw storage detail' } };
    return { ok: true };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  await app.listeners['bulkMoveButton:click']();
  assert.equal(app.nodes.get('statusMessage').textContent, '无法将数据保存到浏览器存储空间，请检查可用空间后重试。');
  assert.equal(app.nodes.get('statusMessage').textContent.includes('raw storage detail'), false);
});

test('Trash failure does not block history rendering, count, language, or theme', async () => {
  const results = Array.from({ length: 12 }, (_, index) => result('event-' + index));
  const app = createVm(async (message) => {
    if (message.type === 'get-trash') throw new Error('trash unavailable');
    return { ok: true, mode: 'normal', settings: { language: 'zh', theme: 'dark' }, results, resultEventCount: 12 };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('historyList').children[0].children.length, 10);
  assert.equal(app.nodes.get('viewAllButton').textContent, '打开完整列表');
  assert.equal(app.nodes.get('trashCount').textContent, '—');
  assert.match(app.nodes.get('trashButton').title, /unavailable|不可用/);
  assert.equal(app.context.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.nodes.get('statusMessage').textContent, '');
});

test('History failure still updates Trash badge and a later success clears the main error', async () => {
  let failHistory = true;
  const app = createVm(async (message) => {
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 9 };
    if (failHistory) throw new Error('history unavailable');
    return { ok: true, mode: 'normal', settings: { language: 'en' }, results: [result('ok')], resultEventCount: 1 };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('trashCount').textContent, '9');
  assert.equal(app.nodes.get('statusMessage').textContent, 'Operation failed. Please try again.');
  assert.equal(app.nodes.get('statusMessage')['class-is-error'], true);
  failHistory = false; await app.context.TabEchoPopup.refresh('');
  assert.equal(app.nodes.get('statusMessage').textContent, '');
  assert.equal(app.nodes.get('statusMessage')['class-is-error'], false);
});

test('history load localizes a structured storage failure', async () => {
  const app = createVm(async (message) => message.type === 'get-trash'
    ? { ok: true, results: [], resultEventCount: 0 }
    : { ok: false, error: { code: 'STORAGE_WRITE_FAILED', message: 'raw detail' } });
  app.listeners['document:DOMContentLoaded'](); await settle();
  assert.equal(app.nodes.get('statusMessage').textContent, 'Could not save data to browser storage. Check available space and try again.');
});

test('input immediately invalidates loaded results and guards every result-dependent action until loaded', async () => {
  const initial = result('ready'); let releaseSearch;
  const gate = new Promise((resolve) => { releaseSearch = resolve; });
  const app = createVm(async (message) => {
    if (message.type === 'get-trash') return { ok: true, results: [], resultEventCount: 2 };
    if (message.type === 'get-history' && message.query === 'new') { await gate; return { ok: true, settings: { language: 'en' }, results: [result('new')], resultEventCount: 1 }; }
    return { ok: true, settings: { language: 'en' }, results: [initial], resultEventCount: 1 };
  });
  app.listeners['document:DOMContentLoaded'](); await settle();
  const actionButton = flatten(app.nodes.get('historyList')).find((node) => node.dataset.action === 'reopen-tab');
  app.nodes.get('searchInput').value = 'new'; app.listeners['searchInput:input']();
  const disabledAction = flatten(app.nodes.get('historyList')).find((node) => node.dataset.action === 'reopen-tab');
  assert.equal(app.context.TabEchoPopup.state.loading, true);
  assert.equal(app.context.TabEchoPopup.state.loadedQuery, null);
  assert.equal(app.nodes.get('bulkMoveButton').disabled, true);
  assert.equal(app.nodes.get('viewAllButton').disabled, true);
  assert.equal(disabledAction.disabled, true);
  await app.listeners['historyList:click']({ target: { closest() { return actionButton; } } });
  await app.listeners['bulkMoveButton:click'](); await app.listeners['viewAllButton:click']();
  assert.equal(app.messages.filter((message) => ['reopen-tab', 'move-to-trash', 'open-dashboard'].includes(message.type)).length, 0);
  const loading = app.context.TabEchoPopup.refresh('new'); await settle(); releaseSearch(); await loading;
  assert.equal(app.context.TabEchoPopup.state.loading, false);
  assert.equal(app.context.TabEchoPopup.state.loadedQuery, 'new');
  assert.equal(app.nodes.get('viewAllButton').disabled, false);
});
