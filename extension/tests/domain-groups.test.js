const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  MULTIPLE_DOMAINS_KEY,
  UNKNOWN_DOMAIN_KEY,
  buildDomainGroups,
} = require('../lib/domain-groups.js');

function result(id, urls) {
  const tabs = urls.map((url, index) => ({
    id: `${id}-tab-${index}`,
    title: `${id} tab ${index}`,
    url,
    position: index,
  }));
  return {
    event: {
      id,
      kind: tabs.length > 1 ? 'group' : 'single',
      tabs,
    },
    matchedTabs: tabs.slice(),
    matchedTabCount: tabs.length,
    totalTabCount: tabs.length,
    matchRanges: {},
  };
}

test('groups and labels by the exact lowercase hostname', () => {
  const wwwFirst = result('www-first', ['https://WWW.Example.COM/one']);
  const wwwSecond = result('www-second', ['https://www.example.com/two']);
  const subdomain = result('subdomain', ['https://docs.example.com/guide']);

  const groups = buildDomainGroups([subdomain, wwwFirst, wwwSecond]);

  assert.deepEqual(groups.map(({ key, domain, label, eventCount, tabCount }) => ({
    key, domain, label, eventCount, tabCount,
  })), [
    { key: 'www.example.com', domain: 'www.example.com', label: 'www.example.com', eventCount: 2, tabCount: 2 },
    { key: 'docs.example.com', domain: 'docs.example.com', label: 'docs.example.com', eventCount: 1, tabCount: 1 },
  ]);
  assert.deepEqual(groups[0].results, [wwwFirst, wwwSecond]);
  assert.deepEqual(groups[1].results, [subdomain]);
});

test('keeps a same-hostname close group as one result in that hostname bucket', () => {
  const closeGroup = result('same-host', [
    'https://news.example.com/first',
    'https://NEWS.EXAMPLE.COM/second',
  ]);

  const groups = buildDomainGroups([closeGroup]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'news.example.com');
  assert.equal(groups[0].eventCount, 1);
  assert.equal(groups[0].tabCount, 2);
  assert.deepEqual(groups[0].results, [closeGroup]);
});

test('puts one cross-domain close event into the multiple-domains bucket without splitting or duplication', () => {
  const crossDomain = result('cross-domain', [
    'https://one.example/page',
    'https://two.example/page',
    'https://one.example/again',
  ]);

  const groups = buildDomainGroups([crossDomain]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, MULTIPLE_DOMAINS_KEY);
  assert.equal(groups[0].label, 'Multiple domains');
  assert.equal(groups[0].eventCount, 1);
  assert.equal(groups[0].tabCount, 3);
  assert.deepEqual(groups[0].results, [crossDomain]);
});

test('puts malformed or hostname-less URLs into the unknown-domain bucket', () => {
  const malformed = result('malformed', ['not a valid URL']);
  const hostnameLess = result('hostname-less', ['about:blank']);

  const groups = buildDomainGroups([malformed, hostnameLess]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, UNKNOWN_DOMAIN_KEY);
  assert.equal(groups[0].label, 'Unknown domain');
  assert.equal(groups[0].eventCount, 2);
  assert.equal(groups[0].tabCount, 2);
});

test('treats an event containing both a valid and invalid URL as unknown', () => {
  const mixedValidity = result('mixed-validity', [
    'https://valid.example/page',
    'invalid',
  ]);

  const groups = buildDomainGroups([mixedValidity]);

  assert.deepEqual(groups.map((group) => group.key), [UNKNOWN_DOMAIN_KEY]);
  assert.deepEqual(groups[0].results, [mixedValidity]);
});

test('sorts by event count rather than tab count, then by label and key', () => {
  const groups = buildDomainGroups([
    result('many-tabs', [
      'https://zeta.example/one',
      'https://zeta.example/two',
      'https://zeta.example/three',
    ]),
    result('beta-one', ['https://beta.example/one']),
    result('beta-two', ['https://beta.example/two']),
    result('www-alpha', ['https://www.alpha.example/one']),
    result('alpha', ['https://alpha.example/one']),
  ]);

  assert.deepEqual(groups.map((group) => group.key), [
    'beta.example',
    'alpha.example',
    'www.alpha.example',
    'zeta.example',
  ]);
  assert.deepEqual(groups.map((group) => group.eventCount), [2, 1, 1, 1]);
  assert.equal(groups.at(-1).tabCount, 3);
});

test('does not mutate the result array, results, events, or tabs', () => {
  const source = [
    result('first', ['https://first.example/page']),
    result('second', ['https://second.example/page']),
  ];
  const snapshot = structuredClone(source);
  for (const item of source) {
    Object.freeze(item.event.tabs);
    item.event.tabs.forEach(Object.freeze);
    Object.freeze(item.event);
    Object.freeze(item.matchedTabs);
    Object.freeze(item.matchRanges);
    Object.freeze(item);
  }
  Object.freeze(source);

  const groups = buildDomainGroups(source);

  assert.deepEqual(source, snapshot);
  assert.deepEqual(groups.flatMap((group) => group.results), source);
});

test('returns an empty list for omitted or non-array input', () => {
  assert.deepEqual(buildDomainGroups(), []);
  assert.deepEqual(buildDomainGroups(null), []);
  assert.deepEqual(buildDomainGroups({}), []);
});

test('exports the same API as a browser global without CommonJS', () => {
  const source = fs.readFileSync(path.join(__dirname, '../lib/domain-groups.js'), 'utf8');
  const context = vm.createContext({ URL });

  vm.runInContext(source, context);

  assert.equal(typeof context.TabEchoDomainGroups.buildDomainGroups, 'function');
  assert.equal(context.TabEchoDomainGroups.MULTIPLE_DOMAINS_KEY, MULTIPLE_DOMAINS_KEY);
  assert.equal(context.TabEchoDomainGroups.UNKNOWN_DOMAIN_KEY, UNKNOWN_DOMAIN_KEY);
});
