const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_SETTINGS,
  addCloseEvent,
  buildSearchResults,
  bulkDeleteEvents,
  clearMode,
  countTabs,
  createEmptyHistoryState,
  deleteEvent,
  findMatchRanges,
  getVisibleEvents,
  moveEventsToTrash,
  normalizeCloseEvent,
  normalizeSettings,
  parseOptionalPositiveInteger,
  permanentlyDeleteTrashEntries,
  pruneHistory,
  pruneHistoryEntries,
  pruneTrashEntries,
  previewRetentionImpact,
  restoreTrashEntries,
  searchEvents,
  validateSettingsInput,
  normalizeExcludedDomains,
  filterEventByExcludedDomains,
  previewExcludedDomainImpact,
  deleteExcludedDomainMatches,
  getAddedExcludedDomains,
  previewSettingsImpact,
  applySettingsAndOptionalExclusionCleanup,
} = require('../extension/lib/history-store.js');

const TEST_NOW = Date.parse('2026-07-27T12:00:00Z');

function addTestEvent(state, event, now = TEST_NOW) {
  return addCloseEvent(state, event, now);
}

function tab(overrides = {}) {
  return {
    id: overrides.id || 'tab-1',
    title: overrides.title || 'Example',
    url: overrides.url || 'https://example.com/page',
    faviconUrl: overrides.faviconUrl || '',
    position: overrides.position || 0,
  };
}

function event(id, closedAt, tabCount = 1, overrides = {}) {
  return {
    id,
    mode: 'normal',
    kind: tabCount > 1 ? 'group' : 'single',
    closedAt,
    tabs: Array.from({ length: tabCount }, (_, index) => tab({
      id: `${id}-tab-${index}`,
      url: `https://${id}-${index}.example`,
      position: index,
    })),
    ...overrides,
  };
}

test('keeps normal and incognito records isolated', () => {
  const state = createEmptyHistoryState();

  addTestEvent(state, {
    id: 'normal-1',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 1000,
    tabs: [tab({ title: 'Normal', url: 'https://normal.test' })],
  });
  addTestEvent(state, {
    id: 'incognito-1',
    mode: 'incognito',
    kind: 'single',
    closedAt: TEST_NOW - 500,
    tabs: [tab({ title: 'Incognito', url: 'https://private.test' })],
  });

  assert.deepEqual(
    searchEvents(state, 'normal', '').map((event) => event.id),
    ['normal-1'],
  );
  assert.deepEqual(
    searchEvents(state, 'incognito', '').map((event) => event.id),
    ['incognito-1'],
  );
});

test('filters by title and url with case-insensitive substring search', () => {
  const state = createEmptyHistoryState();

  addTestEvent(state, {
    id: 'docs',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 1000,
    tabs: [tab({ title: 'Chrome Extension Docs', url: 'https://developer.chrome.com/docs/extensions' })],
  });
  addTestEvent(state, {
    id: 'mail',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 2000,
    tabs: [tab({ title: 'Inbox', url: 'https://mail.example.com' })],
  });

  assert.deepEqual(searchEvents(state, 'normal', 'extension').map((event) => event.id), ['docs']);
  assert.deepEqual(searchEvents(state, 'normal', 'MAIL.EXAMPLE').map((event) => event.id), ['mail']);
});

test('deduplicates repeated single-tab URLs at top level by most recent event', () => {
  const state = createEmptyHistoryState();

  addTestEvent(state, {
    id: 'old',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 2000,
    tabs: [tab({ title: 'Old title', url: 'https://same.example/path' })],
  });
  addTestEvent(state, {
    id: 'new',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 1000,
    tabs: [tab({ title: 'New title', url: 'https://same.example/path' })],
  });

  assert.deepEqual(getVisibleEvents(state, 'normal').map((event) => event.id), ['new']);
});

test('keeps grouped snapshots complete even when a child URL duplicates a newer single record', () => {
  const state = createEmptyHistoryState();

  addTestEvent(state, {
    id: 'group',
    mode: 'normal',
    kind: 'group',
    closedAt: TEST_NOW - 2000,
    tabs: [
      tab({ id: 'a', title: 'Duplicate in group', url: 'https://same.example/path', position: 0 }),
      tab({ id: 'b', title: 'Unique in group', url: 'https://unique.example/path', position: 1 }),
    ],
  });
  addTestEvent(state, {
    id: 'new-single',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 1000,
    tabs: [tab({ title: 'New single', url: 'https://same.example/path' })],
  });

  const group = getVisibleEvents(state, 'normal').find((event) => event.id === 'group');
  assert.equal(group.tabs.length, 2);
  assert.deepEqual(group.tabs.map((child) => child.url), [
    'https://same.example/path',
    'https://unique.example/path',
  ]);
});

test('finds every non-overlapping case-insensitive literal match range', () => {
  assert.deepEqual(findMatchRanges('BaNaNa banana', 'ANA'), [[1, 4], [8, 11]]);
  assert.deepEqual(findMatchRanges('a.b A.B', 'a.b'), [[0, 3], [4, 7]]);
  assert.deepEqual(findMatchRanges('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(findMatchRanges('Example', ''), []);
  assert.deepEqual(findMatchRanges(null, 'null'), []);
  assert.deepEqual(findMatchRanges('Example', null), []);
});

test('maps case-folded matches back to original UTF-16 ranges', () => {
  assert.deepEqual(findMatchRanges('İ', 'İ'), [[0, 1]]);
  assert.deepEqual(findMatchRanges('İx', 'x'), [[1, 2]]);
});

test('searches matching group children without changing or narrowing the source event', () => {
  const group = event('group', TEST_NOW - 1000, 3, {
    tabs: [
      tab({ id: 'first', title: 'Inbox', url: 'https://mail.example', position: 0 }),
      tab({ id: 'match', title: 'Chrome Extension Docs', url: 'https://docs.example/extensions', position: 1 }),
      tab({ id: 'last', title: 'Calendar', url: 'https://calendar.example', position: 2 }),
    ],
  });
  const snapshot = structuredClone(group);

  const results = buildSearchResults([group], 'EXTENSION', { deduplicateSingles: true });

  assert.equal(results.length, 1);
  assert.notStrictEqual(results[0].event, group);
  assert.notStrictEqual(results[0].event.tabs, group.tabs);
  assert.notStrictEqual(results[0].event.tabs[1], group.tabs[1]);
  assert.strictEqual(results[0].matchedTabs[0], results[0].event.tabs[1]);
  assert.equal(results[0].matchedTabCount, 1);
  assert.equal(results[0].totalTabCount, 3);
  assert.deepEqual(results[0].matchRanges, Object.assign(Object.create(null), {
    'id:match': {
      title: [[7, 16]],
      url: [[21, 30]],
    },
  }));
  results[0].event.tabs[0].title = 'Changed output';
  results[0].matchedTabs[0].title = 'Changed match';
  assert.deepEqual(group, snapshot);
  assert.equal(results.reduce((total, result) => total + result.matchedTabCount, 0), 1);
});

test('returns complete display metadata for an empty query in stable input order', () => {
  const entries = [event('group', TEST_NOW - 2000, 2), event('single', TEST_NOW - 1000)];

  const results = buildSearchResults(entries, '', { deduplicateSingles: false });

  assert.deepEqual(results.map((result) => result.event.id), ['group', 'single']);
  assert.deepEqual(results.map((result) => result.matchedTabCount), [2, 1]);
  assert.deepEqual(results.map((result) => result.totalTabCount), [2, 1]);
  assert.deepEqual(results.map((result) => result.matchedTabs), results.map((result) => result.event.tabs));
  assert.deepEqual(
    results.map((result) => result.matchRanges),
    [Object.create(null), Object.create(null)],
  );
});

test('deduplicates only single-tab URLs when requested and keeps the first recent item', () => {
  const entries = [
    event('new', TEST_NOW - 1000, 1, { tabs: [tab({ id: 'new-tab', url: 'https://same.example' })] }),
    event('old', TEST_NOW - 2000, 1, { tabs: [tab({ id: 'old-tab', url: 'HTTPS://SAME.EXAMPLE' })] }),
    event('group', TEST_NOW - 3000, 2, {
      tabs: [
        tab({ id: 'group-same', url: 'https://same.example', position: 0 }),
        tab({ id: 'group-other', url: 'https://other.example', position: 1 }),
      ],
    }),
  ];

  assert.deepEqual(
    buildSearchResults(entries, 'example', { deduplicateSingles: true })
      .map((result) => result.event.id),
    ['new', 'group'],
  );
  assert.deepEqual(
    buildSearchResults(entries, 'example', { deduplicateSingles: false })
      .map((result) => result.event.id),
    ['new', 'old', 'group'],
  );
});

test('skips invalid events and safely searches tabs with missing text or ids', () => {
  const entry = {
    id: 'partial',
    kind: 'group',
    tabs: [
      { id: null, title: 'Needle' },
      { id: 'url-only', url: 'https://needle.example' },
    ],
  };

  const results = buildSearchResults([null, entry], 'needle', { deduplicateSingles: false });

  assert.equal(results.length, 1);
  assert.deepEqual(results[0].matchedTabs, results[0].event.tabs);
  assert.equal(results[0].matchedTabCount, 2);
  assert.equal(results[0].totalTabCount, 2);
  assert.deepEqual(results[0].matchRanges, Object.assign(Object.create(null), {
    'index:0': { title: [[0, 6]], url: [] },
    'id:url-only': { title: [], url: [[8, 14]] },
  }));
  assert.equal(buildSearchResults([{
    id: 'title-only',
    kind: 'single',
    tabs: [{ id: 'title-only-tab', title: 'Needle' }],
  }], 'needle', { deduplicateSingles: true }).length, 1);
});

test('uses safe unique internal keys for missing, duplicate, numeric-looking, and special ids', () => {
  const entry = {
    id: 'keys',
    kind: 'group',
    tabs: [
      { id: '0', title: 'Hit' },
      { title: 'Hit' },
      { id: 'duplicate', title: 'Hit' },
      { id: 'duplicate', title: 'Hit' },
      { id: '__proto__', title: 'Hit' },
    ],
  };

  const [result] = buildSearchResults([entry], 'hit', { deduplicateSingles: false });

  assert.equal(Object.getPrototypeOf(result.matchRanges), null);
  assert.deepEqual(Object.keys(result.matchRanges), [
    'id:0',
    'index:1',
    'id:duplicate',
    'id:duplicate@3',
    'id:__proto__',
  ]);
  assert.equal(result.matchedTabs.length, 5);
  assert.equal(Object.keys(result.matchRanges).length, result.matchedTabCount);
});

test('suffixes a matched duplicate id even when the first occurrence does not match', () => {
  const [result] = buildSearchResults([{
    id: 'duplicate-before-match',
    kind: 'group',
    tabs: [
      { id: 'same', title: 'Miss' },
      { id: 'same', title: 'Hit' },
    ],
  }], 'hit', { deduplicateSingles: false });

  assert.deepEqual(Object.keys(result.matchRanges), ['id:same@1']);
});

test('keeps generated duplicate keys distinct from real ids that contain the same suffix', () => {
  const [result] = buildSearchResults([{
    id: 'suffix-collision',
    kind: 'group',
    tabs: [
      { id: 'same', title: 'Hit' },
      { id: 'same@2', title: 'Hit' },
      { id: 'same', title: 'Hit' },
    ],
  }], 'hit', { deduplicateSingles: false });

  assert.equal(Object.keys(result.matchRanges).length, 3);
});

test('prunes by age first, then oldest records over the count limit per mode', () => {
  const state = createEmptyHistoryState();
  const now = Date.parse('2026-07-27T12:00:00Z');

  addTestEvent(state, {
    id: 'too-old',
    mode: 'normal',
    kind: 'single',
    closedAt: now - 40 * 24 * 60 * 60 * 1000,
    tabs: [tab({ url: 'https://old.example' })],
  }, now);
  addTestEvent(state, {
    id: 'keep-1',
    mode: 'normal',
    kind: 'single',
    closedAt: now - 3000,
    tabs: [tab({ url: 'https://one.example' })],
  }, now);
  addTestEvent(state, {
    id: 'keep-2',
    mode: 'normal',
    kind: 'single',
    closedAt: now - 2000,
    tabs: [tab({ url: 'https://two.example' })],
  }, now);
  addTestEvent(state, {
    id: 'keep-3',
    mode: 'normal',
    kind: 'single',
    closedAt: now - 1000,
    tabs: [tab({ url: 'https://three.example' })],
  }, now);

  pruneHistory(state, { maxAgeDays: 30, maxRecords: 2 }, now);

  assert.deepEqual(state.events.normal.map((event) => event.id), ['keep-2', 'keep-3']);
});

test('deletes one event, clears one mode, and bulk-deletes current search results', () => {
  const state = createEmptyHistoryState();

  addTestEvent(state, {
    id: 'docs',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 3000,
    tabs: [tab({ title: 'Docs', url: 'https://docs.example' })],
  });
  addTestEvent(state, {
    id: 'blog',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 4000,
    tabs: [tab({ title: 'Blog', url: 'https://blog.example' })],
  });
  addTestEvent(state, {
    id: 'private-docs',
    mode: 'incognito',
    kind: 'single',
    closedAt: TEST_NOW - 5000,
    tabs: [tab({ title: 'Docs', url: 'https://private.example' })],
  });

  assert.equal(deleteEvent(state, 'normal', 'blog'), true);
  assert.deepEqual(state.events.normal.map((event) => event.id), ['docs']);

  addTestEvent(state, {
    id: 'search-hit',
    mode: 'normal',
    kind: 'single',
    closedAt: TEST_NOW - 1000,
    tabs: [tab({ title: 'Docs API', url: 'https://api.example' })],
  });
  const visibleSearchResults = searchEvents(state, 'normal', 'docs');
  assert.equal(bulkDeleteEvents(state, 'normal', visibleSearchResults.map((event) => event.id)), 2);
  assert.equal(state.events.normal.length, 0);

  clearMode(state, 'incognito');
  assert.equal(state.events.incognito.length, 0);
  assert.equal(DEFAULT_SETTINGS.maxRecords, 10000);
});

test('uses the version 2 settings defaults', () => {
  assert.deepEqual(normalizeSettings({}), {
    maxRecords: 10000,
    maxAgeDays: null,
    trashMaxAgeDays: 3,
    popupSize: 10,
    pageSize: 50,
    language: 'en',
    theme: 'system',
    excludedDomains: [],
    settingsVersion: 2,
  });
  assert.deepEqual(createEmptyHistoryState().settings, DEFAULT_SETTINGS);
});

test('normalizes valid persisted settings and preserves explicit unlimited values', () => {
  assert.deepEqual(normalizeSettings({
    maxRecords: 250,
    maxAgeDays: null,
    trashMaxAgeDays: '14',
    popupSize: 200,
    pageSize: 25,
    language: 'zh',
    theme: 'dark',
    excludedDomains: [],
    settingsVersion: 1,
  }), {
    maxRecords: 250,
    maxAgeDays: null,
    trashMaxAgeDays: 14,
    popupSize: 200,
    pageSize: 25,
    language: 'zh',
    theme: 'dark',
    excludedDomains: [],
    settingsVersion: 1,
  });

  assert.deepEqual(normalizeSettings({
    maxRecords: -1,
    maxAgeDays: 0,
    trashMaxAgeDays: 'NaN',
    pageSize: 3,
    language: 'fr',
    theme: 'solarized',
    settingsVersion: 0,
  }), {
    maxRecords: 10000,
    maxAgeDays: null,
    trashMaxAgeDays: 3,
    popupSize: 10,
    pageSize: 50,
    language: 'en',
    theme: 'system',
    excludedDomains: [],
    settingsVersion: 2,
  });
});

test('preserves persisted null limits but treats persisted blank strings as invalid defaults', () => {
  assert.deepEqual(normalizeSettings({
    maxRecords: null,
    trashMaxAgeDays: null,
  }), {
    ...DEFAULT_SETTINGS,
    maxRecords: null,
    trashMaxAgeDays: null,
  });
  assert.deepEqual(normalizeSettings({
    maxRecords: '',
    trashMaxAgeDays: '',
  }), DEFAULT_SETTINGS);
});

test('popup size defaults to 10 and accepts only integers from 1 to 200', () => {
  assert.equal(normalizeSettings({ popupSize: 1 }).popupSize, 1);
  assert.equal(normalizeSettings({ popupSize: 200 }).popupSize, 200);
  for (const value of [0, 201, 1.5, '', 'nope']) assert.equal(normalizeSettings({ popupSize: value }).popupSize, 10);
  assert.equal(validateSettingsInput({ ...DEFAULT_SETTINGS, popupSize: 200 }).valid, true);
  const invalid = validateSettingsInput({ ...DEFAULT_SETTINGS, popupSize: 201 });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors.popupSize, 'popupSize must be an integer from 1 to 200.');
});

test('parses blank optional limits as unlimited', () => {
  for (const value of ['', null, undefined]) {
    assert.deepEqual(parseOptionalPositiveInteger(value, 'maxRecords'), {
      value: null,
      error: null,
    });
  }
});

test('parses positive integer numbers and strings', () => {
  for (const value of [1, 42, '1', '42']) {
    assert.deepEqual(parseOptionalPositiveInteger(value, 'maxRecords'), {
      value: Number(value),
      error: null,
    });
  }
});

test('rejects zero, negative, fractional, and non-numeric optional limits', () => {
  const error = 'maxAgeDays must be a positive integer or blank.';
  for (const value of [0, -1, 1.5, '0', '-1', '1.5', 'NaN']) {
    assert.deepEqual(parseOptionalPositiveInteger(value, 'maxAgeDays'), {
      value: null,
      error,
    });
  }
});

test('validates settings input into UI-ready settings and field errors', () => {
  assert.deepEqual(validateSettingsInput({
    maxRecords: '',
    maxAgeDays: null,
    trashMaxAgeDays: '7',
    popupSize: '200',
    pageSize: '100',
    language: 'zh',
    theme: 'light',
  }), {
    settings: {
      maxRecords: null,
      maxAgeDays: null,
      trashMaxAgeDays: 7,
      popupSize: 200,
      pageSize: 100,
      language: 'zh',
      theme: 'light',
      excludedDomains: [],
      settingsVersion: 2,
    },
    errors: {},
    valid: true,
  });
});

test('reports every invalid settings field without replacing it with a default', () => {
  const result = validateSettingsInput({
    maxRecords: 0,
    maxAgeDays: '-2',
    trashMaxAgeDays: 'NaN',
    popupSize: 201,
    pageSize: 10,
    language: 'fr',
    theme: 'solarized',
  });

  assert.deepEqual(result.settings, {
    maxRecords: null,
    maxAgeDays: null,
    trashMaxAgeDays: null,
    popupSize: null,
    pageSize: null,
    language: null,
    theme: null,
    excludedDomains: [],
    settingsVersion: 2,
  });
  assert.deepEqual(result.errors, {
    maxRecords: 'maxRecords must be a positive integer or blank.',
    maxAgeDays: 'maxAgeDays must be a positive integer or blank.',
    trashMaxAgeDays: 'trashMaxAgeDays must be a positive integer or blank.',
    popupSize: 'popupSize must be an integer from 1 to 200.',
    pageSize: 'pageSize must be 25, 50, or 100.',
    language: 'language must be en or zh.',
    theme: 'theme must be light, dark, or system.',
  });
  assert.equal(result.valid, false);
});

test('does not prune history when both retention limits are unlimited', () => {
  const state = createEmptyHistoryState();
  const now = TEST_NOW;
  state.events.normal = [
    {
      id: 'old',
      mode: 'normal',
      kind: 'single',
      closedAt: now - 3650 * 24 * 60 * 60 * 1000,
      tabs: [tab({ url: 'https://old.example' })],
    },
  ];

  pruneHistory(state, { maxRecords: null, maxAgeDays: null }, now);

  assert.deepEqual(state.events.normal.map((event) => event.id), ['old']);
});

test('prunes history entries by restoredAt age before event count while preserving oldest-to-newest order', () => {
  const day = 24 * 60 * 60 * 1000;
  const events = [
    event('expired', TEST_NOW - 10 * day),
    event('restored', TEST_NOW - 10 * day, 1, { restoredAt: TEST_NOW - day }),
    event('middle', TEST_NOW - 2 * day),
    event('null-restored-at', TEST_NOW - 1500, 1, { restoredAt: null }),
    event('newest', TEST_NOW - 1000),
  ];
  const snapshot = structuredClone(events);

  const kept = pruneHistoryEntries(events, { maxAgeDays: 3, maxRecords: 2 }, TEST_NOW);

  assert.deepEqual(kept.map((item) => item.id), ['null-restored-at', 'newest']);
  assert.deepEqual(events, snapshot);
});

test('normalization does not turn null lifecycle timestamps into epoch timestamps', () => {
  const normalized = normalizeCloseEvent(event('null-lifecycle', TEST_NOW, 1, {
    restoredAt: null,
    deletedAt: null,
  }));

  assert.equal('restoredAt' in normalized, false);
  assert.equal('deletedAt' in normalized, false);
});

test('supports unlimited history age and count independently and counts a group as one record', () => {
  const oldGroup = event('old-group', TEST_NOW - 100000, 3);
  const newest = event('newest', TEST_NOW - 1000);

  assert.deepEqual(
    pruneHistoryEntries([newest, oldGroup], { maxAgeDays: null, maxRecords: null }, TEST_NOW)
      .map((item) => item.id),
    ['old-group', 'newest'],
  );
  assert.deepEqual(
    pruneHistoryEntries([oldGroup, newest], { maxAgeDays: null, maxRecords: 1 }, TEST_NOW)
      .map((item) => item.id),
    ['newest'],
  );
  assert.equal(countTabs([oldGroup, newest]), 4);
});

test('keeps history exactly at the age cutoff when record count is unlimited', () => {
  const day = 24 * 60 * 60 * 1000;
  const entries = [
    event('before-cutoff', TEST_NOW - 3 * day - 1),
    event('at-cutoff', TEST_NOW - 3 * day),
    event('after-cutoff', TEST_NOW - day),
  ];

  assert.deepEqual(
    pruneHistoryEntries(entries, { maxAgeDays: 3, maxRecords: null }, TEST_NOW)
      .map((item) => item.id),
    ['at-cutoff', 'after-cutoff'],
  );
});

test('keeps input order for history entries with equal retention timestamps', () => {
  const entries = [
    event('first', TEST_NOW - 1000),
    event('second', TEST_NOW - 1000),
    event('third', TEST_NOW - 1000),
  ];

  assert.deepEqual(
    pruneHistoryEntries(entries, { maxAgeDays: null, maxRecords: null }, TEST_NOW)
      .map((item) => item.id),
    ['first', 'second', 'third'],
  );
});

test('prunes trash only by deletedAt and keeps a stable oldest-to-newest order', () => {
  const day = 24 * 60 * 60 * 1000;
  const entries = [
    { ...event('new', TEST_NOW - 10000), deletedAt: TEST_NOW - 1000 },
    { ...event('expired', TEST_NOW - 1000), deletedAt: TEST_NOW - 4 * day },
    { ...event('old', TEST_NOW - 5000), deletedAt: TEST_NOW - day },
  ];
  const snapshot = structuredClone(entries);

  assert.deepEqual(
    pruneTrashEntries(entries, { trashMaxAgeDays: 3 }, TEST_NOW).map((item) => item.id),
    ['old', 'new'],
  );
  assert.deepEqual(
    pruneTrashEntries(entries, { trashMaxAgeDays: null }, TEST_NOW).map((item) => item.id),
    ['expired', 'old', 'new'],
  );
  assert.deepEqual(entries, snapshot);
});

test('keeps trash at the expiration cutoff and ignores history record limits', () => {
  const day = 24 * 60 * 60 * 1000;
  const entries = [
    { ...event('expired', TEST_NOW - 3000), deletedAt: TEST_NOW - 3 * day - 1 },
    { ...event('at-cutoff', TEST_NOW - 2000), deletedAt: TEST_NOW - 3 * day },
    { ...event('newest', TEST_NOW - 1000), deletedAt: TEST_NOW - day },
  ];

  assert.deepEqual(
    pruneTrashEntries(entries, { trashMaxAgeDays: 3, maxRecords: 1 }, TEST_NOW)
      .map((item) => item.id),
    ['at-cutoff', 'newest'],
  );
});

test('keeps input order for trash entries with equal deletion timestamps', () => {
  const entries = [
    { ...event('first', TEST_NOW - 3000), deletedAt: TEST_NOW - 1000 },
    { ...event('second', TEST_NOW - 2000), deletedAt: TEST_NOW - 1000 },
    { ...event('third', TEST_NOW - 1000), deletedAt: TEST_NOW - 1000 },
  ];

  assert.deepEqual(
    pruneTrashEntries(entries, { trashMaxAgeDays: null }, TEST_NOW).map((item) => item.id),
    ['first', 'second', 'third'],
  );
});

test('previews permanently removed history events, tabs, and expired trash without mutation', () => {
  const day = 24 * 60 * 60 * 1000;
  const history = [
    event('expired-group', TEST_NOW - 5 * day, 2),
    event('trimmed-group', TEST_NOW - 2000, 3),
    event('kept', TEST_NOW - 1000),
  ];
  const trash = [
    { ...event('trash-expired', TEST_NOW - 1000, 2), deletedAt: TEST_NOW - 4 * day },
    { ...event('trash-kept', TEST_NOW - 500, 4), deletedAt: TEST_NOW - day },
  ];
  const snapshot = structuredClone({ history, trash });

  assert.deepEqual(previewRetentionImpact(history, trash, {
    maxAgeDays: 3,
    maxRecords: 1,
    trashMaxAgeDays: 3,
  }, TEST_NOW), {
    historyEventCount: 2,
    historyTabCount: 5,
    trashEventCount: 1,
    trashTabCount: 2,
  });
  assert.deepEqual({ history, trash }, snapshot);
});

test('previews count-pruned duplicate references by occurrence instead of object identity', () => {
  const shared = event('duplicate-reference', TEST_NOW - 1000, 2);

  assert.deepEqual(previewRetentionImpact(
    [shared, shared],
    [],
    { maxAgeDays: null, maxRecords: 1, trashMaxAgeDays: null },
    TEST_NOW,
  ), {
    historyEventCount: 1,
    historyTabCount: 2,
    trashEventCount: 0,
    trashTabCount: 0,
  });
});

test('normalizes domain exclusions and matches the domain plus subdomains', () => {
  assert.deepEqual(normalizeExcludedDomains([' HTTPS://WWW.Example.com/path ', 'example.com', 'sub.test:8080', '', 'not a host']), [
    'example.com', 'sub.test',
  ]);
  const source = event('mixed', TEST_NOW, 3, { tabs: [
    tab({ id: 'a', url: 'https://example.com/a', position: 0 }),
    tab({ id: 'b', url: 'https://docs.example.com/b', position: 1 }),
    tab({ id: 'c', url: 'https://keep.test/c', position: 2 }),
  ] });
  const filtered = filterEventByExcludedDomains(source, ['example.com']);
  assert.deepEqual(filtered.tabs.map((item) => item.id), ['c']);
  assert.equal(filtered.kind, 'single');
  assert.equal(filtered.childCount, 1);
  assert.equal(source.tabs.length, 3);
  assert.equal(filterEventByExcludedDomains(event('gone', TEST_NOW, 1, { tabs: [tab({ url: 'https://private.test' })] }), ['private.test']), null);
});

test('settings validation rejects invalid excluded domains instead of silently dropping them', () => {
  const valid = validateSettingsInput({
    ...DEFAULT_SETTINGS,
    excludedDomains: ['example.com', 'HTTPS://WWW.Valid.test/path'],
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.settings.excludedDomains, ['example.com', 'valid.test']);

  const invalid = validateSettingsInput({
    ...DEFAULT_SETTINGS,
    excludedDomains: ['example.com', 'not a host'],
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.excludedDomains, /invalid hostname/);
});

test('previews and permanently deletes matching tabs without removing unrelated group tabs', () => {
  const history = [event('history-mixed', TEST_NOW, 2, { tabs: [
    tab({ id: 'h1', url: 'https://private.test/a', position: 0 }), tab({ id: 'h2', url: 'https://keep.test/b', position: 1 }),
  ] })];
  const trash = [{ ...event('trash-all', TEST_NOW, 2, { tabs: [
    tab({ id: 't1', url: 'https://a.private.test/a', position: 0 }), tab({ id: 't2', url: 'https://private.test/b', position: 1 }),
  ] }), deletedAt: TEST_NOW }];
  const snapshot = structuredClone({ history, trash });
  assert.deepEqual(previewExcludedDomainImpact(history, trash, ['private.test']), {
    historyEventCount: 1, historyTabCount: 1, trashEventCount: 1, trashTabCount: 2, totalEventCount: 2, totalTabCount: 3,
  });
  const result = deleteExcludedDomainMatches(history, trash, ['private.test']);
  assert.deepEqual(result.history[0].tabs.map((item) => item.id), ['h2']);
  assert.deepEqual(result.trash, []);
  assert.deepEqual(result.impact, previewExcludedDomainImpact(history, trash, ['private.test']));
  assert.deepEqual({ history, trash }, snapshot);
});

test('finds only newly added exclusions and previews de-duplicated settings impact', () => {
  assert.deepEqual(getAddedExcludedDomains(['old.test'], ['OLD.test', 'new.test']), ['new.test']);
  assert.deepEqual(getAddedExcludedDomains(['a.test', 'b.test'], ['b.test']), []);
  const old = event('old', TEST_NOW - 10 * 86400000, 1, { tabs: [tab({ id: 'old-tab', url: 'https://new.test/old' })] });
  const recent = event('recent', TEST_NOW - 1000, 2, { tabs: [
    tab({ id: 'remove', url: 'https://sub.new.test/a', position: 0 }),
    tab({ id: 'keep', url: 'https://keep.test/b', position: 1 }),
  ] });
  const trash = [{ ...event('trash', TEST_NOW - 1000, 1, { tabs: [tab({ id: 'trash-tab', url: 'https://new.test/t' })] }), deletedAt: TEST_NOW - 10 * 86400000 }];
  const current = { ...DEFAULT_SETTINGS, maxAgeDays: null, trashMaxAgeDays: null, excludedDomains: ['old.test'] };
  const next = { ...current, maxAgeDays: 5, trashMaxAgeDays: 5, excludedDomains: ['old.test', 'new.test'] };
  const impact = previewSettingsImpact([old, recent], trash, current, next, TEST_NOW);
  assert.deepEqual(impact.addedExcludedDomains, ['new.test']);
  assert.equal(impact.retention.historyEventCount, 1);
  assert.equal(impact.retention.trashEventCount, 1);
  assert.equal(impact.exclusions.historyTabCount, 1);
  assert.equal(impact.combined.totalEventCount, 3);
  assert.equal(impact.combined.totalTabCount, 3);
});

test('applies retention and optionally cleans only newly excluded domains', () => {
  const mixed = event('mixed', TEST_NOW - 1000, 3, { tabs: [
    tab({ id: 'old-rule', url: 'https://old.test/a', position: 0 }),
    tab({ id: 'new-rule', url: 'https://new.test/b', position: 1 }),
    tab({ id: 'keep', url: 'https://keep.test/c', position: 2 }),
  ] });
  const settings = { ...DEFAULT_SETTINGS, maxAgeDays: null, trashMaxAgeDays: null };
  const kept = applySettingsAndOptionalExclusionCleanup([mixed], [], settings, ['new.test'], false, TEST_NOW);
  assert.deepEqual(kept.history[0].tabs.map((item) => item.id), ['old-rule', 'new-rule', 'keep']);
  const cleaned = applySettingsAndOptionalExclusionCleanup([mixed], [], settings, ['new.test'], true, TEST_NOW);
  assert.deepEqual(cleaned.history[0].tabs.map((item) => item.id), ['old-rule', 'keep']);
});

test('moves explicitly selected complete events to trash without changing either input', () => {
  const history = [event('single', TEST_NOW - 2000), event('group', TEST_NOW - 1000, 3)];
  const trash = [{ ...event('existing', TEST_NOW - 3000), deletedAt: TEST_NOW - 500 }];
  const snapshot = structuredClone({ history, trash });

  const result = moveEventsToTrash(history, trash, ['group', 'missing'], TEST_NOW);

  assert.deepEqual(result.history.map((item) => item.id), ['single']);
  assert.deepEqual(result.trash.map((item) => item.id), ['existing', 'group']);
  assert.equal(result.trash[1].deletedAt, TEST_NOW);
  assert.equal(result.trash[1].tabs.length, 3);
  assert.deepEqual(result.moved.map((item) => item.id), ['group']);
  assert.deepEqual({ history, trash }, snapshot);
});

test('can express moving every history event by passing all ids', () => {
  const history = [event('one', TEST_NOW - 2000), event('two', TEST_NOW - 1000)];
  const result = moveEventsToTrash(history, [], history.map((item) => item.id), TEST_NOW);

  assert.deepEqual(result.history, []);
  assert.deepEqual(result.moved.map((item) => item.id), ['one', 'two']);
});

test('moves numeric event ids by string request id, ignoring null and duplicate selections', () => {
  const numeric = event(42, TEST_NOW - 1000, 2);

  const result = moveEventsToTrash([numeric], [], [null, '42', '42'], TEST_NOW);

  assert.deepEqual(result.history, []);
  assert.deepEqual(result.moved.map((item) => item.id), [42]);
});

test('deep-copies moved tabs so output mutations cannot affect history input', () => {
  const original = event('group', TEST_NOW - 1000, 2);
  const result = moveEventsToTrash([original], [], ['group'], TEST_NOW);

  result.moved[0].tabs[0].title = 'changed';
  result.moved[0].tabs.push(tab({ id: 'extra', url: 'https://extra.example' }));

  assert.notStrictEqual(result.moved[0].tabs, original.tabs);
  assert.notStrictEqual(result.moved[0].tabs[0], original.tabs[0]);
  assert.notEqual(original.tabs[0].title, 'changed');
  assert.equal(original.tabs.length, 2);
});

test('rejects an over-capacity trash restore atomically', () => {
  const history = [event('existing', TEST_NOW - 1000)];
  const trash = [
    { ...event('restore-one', TEST_NOW - 3000), deletedAt: TEST_NOW - 500 },
    { ...event('restore-group', TEST_NOW - 2000, 2), deletedAt: TEST_NOW - 400 },
  ];
  const snapshot = structuredClone({ history, trash });

  const result = restoreTrashEntries(
    history, trash, ['restore-one', 'restore-group'], { maxRecords: 2 }, TEST_NOW,
  );

  assert.equal(result.ok, false);
  assert.equal(result.requiredSlots, 1);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.history, history);
  assert.deepEqual(result.trash, trash);
  assert.deepEqual({ history, trash }, snapshot);
});

test('restores a complete group with a new retention timestamp and preserves closedAt', () => {
  const history = [event('existing', TEST_NOW - 1000)];
  const original = {
    ...event('group', TEST_NOW - 30 * 24 * 60 * 60 * 1000, 2),
    deletedAt: TEST_NOW - 1000,
  };
  const trash = [original];
  const snapshot = structuredClone({ history, trash });
  const result = restoreTrashEntries(history, trash, ['group'], {
    maxRecords: 2,
    maxAgeDays: 1,
  }, TEST_NOW);

  assert.equal(result.ok, true);
  assert.equal(result.requiredSlots, 0);
  assert.deepEqual(result.trash, []);
  assert.equal(result.restored[0].closedAt, original.closedAt);
  assert.equal(result.restored[0].restoredAt, TEST_NOW);
  assert.equal('deletedAt' in result.restored[0], false);
  assert.equal(result.restored[0].tabs.length, 2);
  assert.deepEqual(result.history.map((item) => item.id), ['existing', 'group']);
  assert.deepEqual({ history, trash }, snapshot);
});

test('restores multiple entries using normalized ids and deep-copies restored tabs', () => {
  const numeric = { ...event(7, TEST_NOW - 2000, 2), deletedAt: TEST_NOW - 500 };
  const text = { ...event('text', TEST_NOW - 1000), deletedAt: TEST_NOW - 400 };
  const trash = [numeric, text];

  const result = restoreTrashEntries([], trash, [null, '7', '7', 'text'], {
    maxRecords: 2,
  }, TEST_NOW);

  assert.equal(result.ok, true);
  assert.deepEqual(result.restored.map((item) => item.id), [7, 'text']);
  assert.deepEqual(result.trash, []);
  result.restored[0].tabs[0].title = 'changed';
  assert.notStrictEqual(result.restored[0].tabs, numeric.tabs);
  assert.notStrictEqual(result.restored[0].tabs[0], numeric.tabs[0]);
  assert.notEqual(numeric.tabs[0].title, 'changed');
});

test('restoring an empty selection is a successful no-op', () => {
  const history = [event('history', TEST_NOW - 1000)];
  const trash = [{ ...event('trash', TEST_NOW - 2000), deletedAt: TEST_NOW - 500 }];

  const result = restoreTrashEntries(history, trash, [null, null], { maxRecords: 1 }, TEST_NOW);

  assert.equal(result.ok, true);
  assert.equal(result.requiredSlots, 0);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.history, history);
  assert.deepEqual(result.trash, trash);
});

test('restoring unknown ids is a successful no-op even when history already exceeds the limit', () => {
  const history = [
    event('one', TEST_NOW - 2000),
    event('two', TEST_NOW - 1000),
  ];
  const trash = [{ ...event('trash', TEST_NOW - 3000), deletedAt: TEST_NOW - 500 }];

  const result = restoreTrashEntries(history, trash, ['missing'], { maxRecords: 1 }, TEST_NOW);

  assert.equal(result.ok, true);
  assert.equal(result.requiredSlots, 0);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.history, history);
  assert.deepEqual(result.trash, trash);
});

test('permanently deletes selected trash entries without mutating input', () => {
  const trash = [
    { ...event('one', TEST_NOW - 2000), deletedAt: TEST_NOW - 500 },
    { ...event('group', TEST_NOW - 1000, 2), deletedAt: TEST_NOW - 400 },
  ];
  const snapshot = structuredClone(trash);

  const result = permanentlyDeleteTrashEntries(trash, ['group', 'missing']);

  assert.deepEqual(result.trash.map((item) => item.id), ['one']);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(result.deleted.map((item) => item.id), ['group']);
  assert.deepEqual(trash, snapshot);
});

test('permanently deletes numeric ids by string value and ignores null and duplicates', () => {
  const trash = [
    { ...event(9, TEST_NOW - 2000), deletedAt: TEST_NOW - 500 },
    { ...event('keep', TEST_NOW - 1000), deletedAt: TEST_NOW - 400 },
  ];

  const result = permanentlyDeleteTrashEntries(trash, [null, '9', '9']);

  assert.deepEqual(result.trash.map((item) => item.id), ['keep']);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(result.deleted.map((item) => item.id), [9]);
});

test('deep-copies kept and deleted trash entries so output mutations cannot affect input', () => {
  const deleted = { ...event('delete', TEST_NOW - 2000, 2), deletedAt: TEST_NOW - 500 };
  const kept = { ...event('keep', TEST_NOW - 1000, 2), deletedAt: TEST_NOW - 400 };
  const trash = [deleted, kept];

  const result = permanentlyDeleteTrashEntries(trash, ['delete']);

  result.deleted[0].tabs[0].title = 'changed deleted';
  result.trash[0].tabs[0].title = 'changed kept';
  assert.notStrictEqual(result.deleted[0].tabs, deleted.tabs);
  assert.notStrictEqual(result.trash[0].tabs, kept.tabs);
  assert.notEqual(deleted.tabs[0].title, 'changed deleted');
  assert.notEqual(kept.tabs[0].title, 'changed kept');
});
