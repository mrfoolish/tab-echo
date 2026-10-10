const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('user-facing copy follows the bilingual closed-tab and Trash vocabulary', () => {
  const ui = [
    read('extension/popup.html'),
    read('extension/popup.js'),
    read('extension/dashboard.html'),
    read('extension/dashboard.js'),
  ].join('\n');

  for (const forbidden of [
    'Normal history', '普通历史', 'current mode', '当前模式',
    'Extension request failed', '扩展请求失败',
  ]) {
    assert.equal(ui.includes(forbidden), false, `user-facing copy must not contain ${forbidden}`);
  }
  assert.match(ui, /Regular window · Closed tabs/);
  assert.match(ui, /Incognito window · Closed tabs/);
  assert.match(ui, /常规窗口 · 已关闭标签页/);
  assert.match(ui, /无痕窗口 · 已关闭标签页/);
  assert.match(ui, /Reopen/);
  assert.match(ui, /Move back to Closed tabs/);
  assert.match(ui, /重新打开/);
  assert.match(ui, /移回关闭记录/);
  assert.match(ui, /移至回收站/);
  assert.match(ui, /records \(including Groups\)/);
  assert.match(ui, /记录（含标签组）/);
  assert.doesNotMatch(ui, /[一-鿿][^'\n]{0,30}URL|URL[^'\n]{0,30}[一-鿿]/);
});

test('every optional setting permanently explains blank semantics and browser limits', () => {
  const dashboard = read('extension/dashboard.js');
  assert.match(dashboard, /Blank means unlimited, and browser storage limits still apply./);
  assert.match(dashboard, /Blank means kept indefinitely, and browser storage limits still apply./);
  assert.equal((dashboard.match(/留空表示不限制，且仍受浏览器存储空间限制。/g) || []).length, 1);
  assert.equal((dashboard.match(/留空表示永久保留，且仍受浏览器存储空间限制。/g) || []).length, 2);
});

test('English and Chinese READMEs document the shipped product contract', () => {
  const en = read('README.md');
  const zh = read('README.zh.md');
  for (const required of [
    'README.zh.md', '10', '10,000', '3 days', 'unlimited', 'Trash',
    'storage-repository.js', 'indexeddb-repository.js', 'close-tracker.js', 'dashboard.html',
    'npm test', 'npm run check', 'alarms', 'storage', 'tabs',
    'Allow in Incognito', 'split', 'migration', 'confirmation',
  ]) assert.match(en, new RegExp(escapeRegExp(required), 'i'), `README.md must mention ${required}`);
  for (const required of [
    'README.md', '10', '10,000', '3 天', '不限制', '回收站',
    'storage-repository.js', 'indexeddb-repository.js', 'close-tracker.js', 'dashboard.html',
    'npm test', 'npm run check', 'alarms', 'storage', 'tabs',
    '允许在无痕模式下运行', 'split', '迁移', '页面内二阶段确认',
  ]) assert.match(zh, new RegExp(escapeRegExp(required), 'i'), `README.zh.md must mention ${required}`);
  assert.doesNotMatch(en, /Restore (?:one|a|the|grouped).*tab/i);
  assert.doesNotMatch(zh, /恢复(?:单个|一组|标签页|网页)|普通模式|当前模式|按标题或 URL/);
});

test('package scripts expose dependency-free test and check commands', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.match(pkg.scripts.check, /check:js/);
  assert.match(pkg.scripts.check, /check:manifest/);
});

test('product docs describe separate storage pools without a combined quota', () => {
  const en = read('README.md');
  const zh = read('README.zh.md');
  assert.match(en, /regular IndexedDB records and local incognito\/settings data/i);
  assert.match(en, /without combining their unrelated quotas/i);
  assert.match(zh, /常规 IndexedDB 记录与无痕记录\/设置数据/);
  assert.match(zh, /不把两套无关容量相加/);
});

test('manifest keeps context isolation and uses only documented permissions', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  assert.equal(manifest.incognito, 'split');
  assert.deepEqual(new Set(manifest.permissions), new Set(['storage', 'tabs', 'alarms']));
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});

test('manifest icon files have the exact declared PNG dimensions', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  for (const [declaredSize, relativePath] of Object.entries(manifest.icons)) {
    const data = fs.readFileSync(path.join(root, 'extension', relativePath));
    assert.equal(data.toString('ascii', 1, 4), 'PNG');
    assert.equal(data.readUInt32BE(16), Number(declaredSize), `${relativePath} width`);
    assert.equal(data.readUInt32BE(20), Number(declaredSize), `${relativePath} height`);
  }
});

test('manual acceptance distinguishes automated preflight from remaining manual scenarios', () => {
  const manual = read('docs/testing/2026-09-18-manual-acceptance.md');
  assert.match(manual, /状态：\*\*部分执行（自动化预检完成，人工交互待执行）\*\*/);
  assert.match(manual, /Chrome 版本：(待填写|\d+\.\d+\.\d+\.\d+)/);
  assert.match(manual, /扩展版本：(待填写|\d+\.\d+\.\d+)/);
  assert.match(manual, /执行日期：(待填写|\d{4}-\d{2}-\d{2})/);
  assert.match(manual, /执行人：\S[^\n]*/);
  assert.match(manual, /(?:阻塞|执行)记录/);
  assert.match(manual, /(?:真实浏览器交互项|人工交互和主观判断的完整验收)[^\n]*保持未勾选/);
  assert.doesNotMatch(manual, /- \[x\]/i);
  assert.match(manual, /Lighthouse Accessibility \/ Best Practices 均为 100/);
  assert.match(manual, /连续两次重载扩展后保持不变/);

  for (const scenario of [
    '常规窗口单独关闭一个标签页', '整窗', 'Service Worker 休眠', '最后一个无痕窗口',
    '互不可见', '按设置展示 1–200 条', '打开完整列表', 'Group 搜索', '移回关闭记录', '直接移除',
    '容量不足', '留空', '浅色、深色、跟随系统主题', '仅键盘', '中英文长文案',
  ]) assert.match(manual, new RegExp(escapeRegExp(scenario)), `manual acceptance must cover ${scenario}`);
});

test('manual acceptance covers the implemented one-time migration notice', () => {
  const manual = read('docs/testing/2026-09-18-manual-acceptance.md');
  assert.match(manual, /一次性迁移提示/);
  assert.match(manual, /首次从 legacy 成功迁移/);
  assert.match(manual, /损坏记录无法恢复/);
  assert.match(manual, /再次打开不重复/);
  assert.doesNotMatch(manual, /当前实现缺口/);
  assert.doesNotMatch(manual, /现阶段预期不能通过/);
});

test('only irreversible bulk actions and destructive settings require inline confirmation', () => {
  const productDocs = `${read('proposal.md')}\n${read('README.md')}\n${read('README.zh.md')}\n${read('docs/testing/2026-09-18-manual-acceptance.md')}`;
  assert.doesNotMatch(productDocs, /soft delete[^\n]*asks? for confirmation|软删除[^\n]*需要确认/i);
  assert.match(productDocs, /\*\*Remove now\*\* menu can target either the shown entries or every result[^\n]*inline second step/i);
  assert.match(productDocs, /“直接移除”可选择当前展示项或当前条件下的全部结果[^\n]*页面内二阶段确认/);
  assert.match(productDocs, /Empty Trash[^\n]*inline second step/);
  assert.match(productDocs, /清空回收站[^\n]*页面内确认区/);
  assert.match(productDocs, /destructive setting changes[^\n]*inline second step/);
  assert.match(productDocs, /会清理数据的设置变更[^\n]*页面内二阶段确认/);
  assert.match(productDocs, /no browser-native confirmation dialog/i);
  assert.match(productDocs, /不调用浏览器原生确认弹窗/);
});
