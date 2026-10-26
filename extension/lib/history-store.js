(function initHistoryStore(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.TabEchoHistoryStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createHistoryStore() {
  const MODE_NORMAL = 'normal';
  const MODE_INCOGNITO = 'incognito';
  const DEFAULT_SETTINGS = Object.freeze({
    maxRecords: 10000,
    maxAgeDays: null,
    trashMaxAgeDays: 3,
    popupSize: 100,
    pageSize: 50,
    language: 'en',
    theme: 'system',
    excludedDomains: [],
    settingsVersion: 2,
  });
  const PAGE_SIZES = [25, 50, 100];

  function createEmptyHistoryState() {
    return {
      events: {
        [MODE_NORMAL]: [],
        [MODE_INCOGNITO]: [],
      },
      settings: { ...DEFAULT_SETTINGS },
    };
  }

  function normalizeMode(mode) {
    return mode === MODE_INCOGNITO ? MODE_INCOGNITO : MODE_NORMAL;
  }

  function parseOptionalPositiveInteger(value, field) {
    if (value === '' || value === null || value === undefined) {
      return { value: null, error: null };
    }

    const isStrictInteger = typeof value === 'number'
      ? Number.isInteger(value) && value > 0
      : typeof value === 'string' && /^[1-9]\d*$/.test(value);
    const parsed = Number(value);
    if (!isStrictInteger || !Number.isSafeInteger(parsed)) {
      return {
        value: null,
        error: `${field} must be a positive integer or blank.`,
      };
    }
    return { value: parsed, error: null };
  }

  function validateSettingsInput(input) {
    const source = input && typeof input === 'object' ? input : {};
    const errors = {};
    const settings = { settingsVersion: DEFAULT_SETTINGS.settingsVersion };

    for (const field of ['maxRecords', 'maxAgeDays', 'trashMaxAgeDays']) {
      const parsed = parseOptionalPositiveInteger(source[field], field);
      settings[field] = parsed.value;
      if (parsed.error) {
        errors[field] = parsed.error;
      }
    }

    const pageSize = Number(source.pageSize);
    settings.pageSize = PAGE_SIZES.includes(pageSize) ? pageSize : null;
    if (settings.pageSize === null) {
      errors.pageSize = 'pageSize must be 25, 50, or 100.';
    }

    const popupSizeSource = source.popupSize === undefined ? DEFAULT_SETTINGS.popupSize : source.popupSize;
    const popupSize = Number(popupSizeSource);
    const popupSizeValid = ((typeof popupSizeSource === 'number' && Number.isInteger(popupSizeSource))
      || (typeof popupSizeSource === 'string' && /^[1-9]\d*$/.test(popupSizeSource)))
      && Number.isSafeInteger(popupSize) && popupSize >= 1 && popupSize <= 200;
    settings.popupSize = popupSizeValid ? popupSize : null;
    if (settings.popupSize === null) errors.popupSize = 'popupSize must be an integer from 1 to 200.';

    settings.language = ['en', 'zh'].includes(source.language) ? source.language : null;
    if (settings.language === null) {
      errors.language = 'language must be en or zh.';
    }

    settings.theme = ['light', 'dark', 'system'].includes(source.theme) ? source.theme : null;
    if (settings.theme === null) {
      errors.theme = 'theme must be light, dark, or system.';
    }

    settings.excludedDomains = normalizeExcludedDomains(source.excludedDomains);
    if (source.excludedDomains !== undefined && !Array.isArray(source.excludedDomains)) {
      errors.excludedDomains = 'excludedDomains must be an array of hostnames.';
    } else if (Array.isArray(source.excludedDomains)) {
      const invalid = source.excludedDomains.filter((value) => String(value || '').trim()
        && !normalizeExcludedDomain(value));
      if (invalid.length > 0) {
        errors.excludedDomains = 'excludedDomains contains an invalid hostname.';
      }
    }

    return {
      settings,
      errors,
      valid: Object.keys(errors).length === 0,
    };
  }

  function normalizeOptionalPositiveInteger(value, fallback) {
    if (value === null) {
      return null;
    }
    const parsed = parseOptionalPositiveInteger(value, 'value');
    return parsed.error || parsed.value === null ? fallback : parsed.value;
  }

  function normalizeSettings(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const pageSize = Number(source.pageSize);
    const popupSize = Number(source.popupSize);
    const settingsVersion = Number(source.settingsVersion);
    const language = ['en', 'zh'].includes(source.language) ? source.language : DEFAULT_SETTINGS.language;
    const theme = ['light', 'dark', 'system'].includes(source.theme)
      ? source.theme
      : DEFAULT_SETTINGS.theme;
    return {
      maxRecords: normalizeOptionalPositiveInteger(source.maxRecords, DEFAULT_SETTINGS.maxRecords),
      maxAgeDays: normalizeOptionalPositiveInteger(source.maxAgeDays, DEFAULT_SETTINGS.maxAgeDays),
      trashMaxAgeDays: normalizeOptionalPositiveInteger(source.trashMaxAgeDays, DEFAULT_SETTINGS.trashMaxAgeDays),
      popupSize: Number.isSafeInteger(popupSize) && popupSize >= 1 && popupSize <= 200 ? popupSize : DEFAULT_SETTINGS.popupSize,
      pageSize: PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_SETTINGS.pageSize,
      language,
      theme,
      excludedDomains: normalizeExcludedDomains(source.excludedDomains),
      settingsVersion: Number.isSafeInteger(settingsVersion) && settingsVersion > 0
        ? settingsVersion
        : DEFAULT_SETTINGS.settingsVersion,
    };
  }

  function normalizeHistoryState(input) {
    const state = createEmptyHistoryState();
    if (!input || typeof input !== 'object') {
      return state;
    }

    state.settings = normalizeSettings(input.settings);
    const events = input.events && typeof input.events === 'object' ? input.events : {};
    for (const mode of [MODE_NORMAL, MODE_INCOGNITO]) {
      state.events[mode] = Array.isArray(events[mode])
        ? events[mode].map((event) => normalizeCloseEvent(event, mode)).filter(Boolean)
        : [];
      state.events[mode].sort((a, b) => a.closedAt - b.closedAt);
    }
    return state;
  }

  function normalizeCloseEvent(event, fallbackMode) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const tabs = Array.isArray(event.tabs)
      ? event.tabs.map((item, index) => normalizeTab(item, index)).filter((item) => item.url)
      : [];
    if (tabs.length === 0) {
      return null;
    }

    const id = String(event.id || event.batchId || createId('event'));
    const kind = event.kind === 'group' || tabs.length > 1 ? 'group' : 'single';
    const closedAt = Number.isFinite(Number(event.closedAt)) ? Number(event.closedAt) : Date.now();
    const normalized = {
      id,
      batchId: String(event.batchId || id),
      mode: normalizeMode(event.mode || fallbackMode),
      kind,
      closedAt,
      sourceWindowId: event.sourceWindowId ?? null,
      childCount: tabs.length,
      tabs: tabs.map((item, index) => ({
        ...item,
        batchId: String(item.batchId || event.batchId || id),
        position: Number.isFinite(Number(item.position)) ? Number(item.position) : index,
      })).sort((a, b) => a.position - b.position),
    };
    if (event.restoredAt !== null && event.restoredAt !== undefined
      && Number.isFinite(Number(event.restoredAt))) {
      normalized.restoredAt = Number(event.restoredAt);
    }
    if (event.deletedAt !== null && event.deletedAt !== undefined
      && Number.isFinite(Number(event.deletedAt))) {
      normalized.deletedAt = Number(event.deletedAt);
    }
    return normalized;
  }

  function normalizeTab(tab, index) {
    if (!tab || typeof tab !== 'object') {
      return null;
    }
    const url = String(tab.url || '').trim();
    if (!url) {
      return null;
    }
    return {
      id: String(tab.id || createId('tab')),
      title: String(tab.title || url),
      url,
      faviconUrl: String(tab.faviconUrl || tab.favIconUrl || ''),
      position: Number.isFinite(Number(tab.position)) ? Number(tab.position) : index,
      sourceWindowId: tab.sourceWindowId ?? null,
      batchId: tab.batchId ? String(tab.batchId) : '',
    };
  }

  function createId(prefix) {
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function addCloseEvent(state, event, now = Date.now()) {
    const normalizedState = normalizeHistoryState(state);
    Object.assign(state, normalizedState);
    const normalized = normalizeCloseEvent(event);
    if (!normalized) {
      return null;
    }
    const mode = normalizeMode(normalized.mode);
    state.events[mode].push(normalized);
    pruneHistory(state, state.settings, now);
    return normalized;
  }

  function pruneHistory(state, settings, now = Date.now()) {
    const activeSettings = normalizeSettings(settings || state.settings);
    state.settings = activeSettings;

    for (const mode of [MODE_NORMAL, MODE_INCOGNITO]) {
      const events = Array.isArray(state.events[mode]) ? state.events[mode] : [];
      state.events[mode] = pruneHistoryEntries(events, activeSettings, now);
    }
    return state;
  }

  function stableSortByTimestamp(entries, getTimestamp) {
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((left, right) => {
        const difference = getTimestamp(left.entry) - getTimestamp(right.entry);
        return difference || left.index - right.index;
      })
      .map(({ entry }) => entry);
  }

  function historyRetentionTimestamp(event) {
    const retentionTimestamp = event && (event.restoredAt ?? event.closedAt);
    return Number(retentionTimestamp);
  }

  function pruneHistoryEntries(events, settings, now = Date.now()) {
    const activeSettings = normalizeSettings(settings);
    const source = Array.isArray(events) ? events : [];
    const cutoff = activeSettings.maxAgeDays === null
      ? null
      : now - activeSettings.maxAgeDays * 24 * 60 * 60 * 1000;
    let kept = cutoff === null
      ? source.slice()
      : source.filter((event) => historyRetentionTimestamp(event) >= cutoff);
    kept = stableSortByTimestamp(kept, historyRetentionTimestamp);
    if (activeSettings.maxRecords !== null && kept.length > activeSettings.maxRecords) {
      kept = kept.slice(kept.length - activeSettings.maxRecords);
    }
    return kept;
  }

  function pruneTrashEntries(entries, settings, now = Date.now()) {
    const activeSettings = normalizeSettings(settings);
    const source = Array.isArray(entries) ? entries : [];
    const cutoff = activeSettings.trashMaxAgeDays === null
      ? null
      : now - activeSettings.trashMaxAgeDays * 24 * 60 * 60 * 1000;
    const kept = cutoff === null
      ? source.slice()
      : source.filter((entry) => Number(entry && entry.deletedAt) >= cutoff);
    return stableSortByTimestamp(kept, (entry) => Number(entry && entry.deletedAt));
  }

  function countTabs(events) {
    return (Array.isArray(events) ? events : []).reduce((total, event) => {
      return total + (Array.isArray(event && event.tabs) ? event.tabs.length : 0);
    }, 0);
  }

  function normalizeExcludedDomain(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || /\s/.test(raw)) return null;
    try {
      const candidate = raw.includes('://') ? raw : `https://${raw}`;
      const parsed = new URL(candidate);
      if (!parsed.hostname || (parsed.pathname !== '/' && !raw.includes('://'))) return null;
      return parsed.hostname.replace(/^www\./, '').replace(/\.$/, '') || null;
    } catch (_) { return null; }
  }

  function normalizeExcludedDomains(values) {
    return Array.from(new Set((Array.isArray(values) ? values : [])
      .map(normalizeExcludedDomain).filter(Boolean))).sort();
  }

  function getAddedExcludedDomains(currentDomains, nextDomains) {
    const current = new Set(normalizeExcludedDomains(currentDomains));
    return normalizeExcludedDomains(nextDomains).filter((domain) => !current.has(domain));
  }

  function isExcludedUrl(url, excludedDomains) {
    let hostname;
    try { hostname = new URL(String(url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch (_) { return false; }
    return normalizeExcludedDomains(excludedDomains).some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  }

  function filterEventByExcludedDomains(event, excludedDomains) {
    const tabs = (Array.isArray(event && event.tabs) ? event.tabs : []).filter((item) => !isExcludedUrl(item.url, excludedDomains));
    if (!tabs.length) return null;
    const cloned = cloneEvent(event);
    cloned.tabs = tabs.map((item, index) => ({ ...item, position: index }));
    cloned.childCount = cloned.tabs.length;
    cloned.kind = cloned.tabs.length > 1 ? 'group' : 'single';
    return cloned;
  }

  function deleteExcludedDomainMatches(history, trash, excludedDomains) {
    const filter = (events) => (Array.isArray(events) ? events : []).map((event) => filterEventByExcludedDomains(event, excludedDomains)).filter(Boolean);
    const nextHistory = filter(history); const nextTrash = filter(trash);
    const impact = {
      historyEventCount: (history || []).filter((event) => (event.tabs || []).some((tab) => isExcludedUrl(tab.url, excludedDomains))).length,
      historyTabCount: countTabs(history) - countTabs(nextHistory),
      trashEventCount: (trash || []).filter((event) => (event.tabs || []).some((tab) => isExcludedUrl(tab.url, excludedDomains))).length,
      trashTabCount: countTabs(trash) - countTabs(nextTrash),
    };
    impact.totalEventCount = impact.historyEventCount + impact.trashEventCount;
    impact.totalTabCount = impact.historyTabCount + impact.trashTabCount;
    return { history: nextHistory, trash: nextTrash, impact };
  }

  function previewExcludedDomainImpact(history, trash, excludedDomains) {
    return deleteExcludedDomainMatches(history, trash, excludedDomains).impact;
  }

  function previewRetentionImpact(events, trash, nextSettings, now = Date.now()) {
    const historySource = Array.isArray(events) ? events : [];
    const trashSource = Array.isArray(trash) ? trash : [];
    const keptHistory = pruneHistoryEntries(historySource, nextSettings, now);
    const keptTrash = pruneTrashEntries(trashSource, nextSettings, now);
    return {
      historyEventCount: historySource.length - keptHistory.length,
      historyTabCount: countTabs(historySource) - countTabs(keptHistory),
      trashEventCount: trashSource.length - keptTrash.length,
      trashTabCount: countTabs(trashSource) - countTabs(keptTrash),
    };
  }

  function applySettingsAndOptionalExclusionCleanup(history, trash, settings, addedDomains, removeExisting, now = Date.now()) {
    const retainedHistory = pruneHistoryEntries(history, settings, now);
    const retainedTrash = pruneTrashEntries(trash, settings, now);
    if (!removeExisting || !normalizeExcludedDomains(addedDomains).length) {
      return { history: retainedHistory.map(cloneEvent), trash: retainedTrash.map(cloneEvent) };
    }
    const cleaned = deleteExcludedDomainMatches(retainedHistory, retainedTrash, addedDomains);
    return { history: cleaned.history, trash: cleaned.trash };
  }

  function previewSettingsImpact(history, trash, currentSettings, nextSettings, now = Date.now()) {
    const historySource = Array.isArray(history) ? history : [];
    const trashSource = Array.isArray(trash) ? trash : [];
    const addedExcludedDomains = getAddedExcludedDomains(
      currentSettings && currentSettings.excludedDomains,
      nextSettings && nextSettings.excludedDomains,
    );
    const retainedHistory = pruneHistoryEntries(historySource, nextSettings, now);
    const retainedTrash = pruneTrashEntries(trashSource, nextSettings, now);
    const retention = previewRetentionImpact(historySource, trashSource, nextSettings, now);
    retention.totalEventCount = retention.historyEventCount + retention.trashEventCount;
    retention.totalTabCount = retention.historyTabCount + retention.trashTabCount;
    const exclusions = previewExcludedDomainImpact(retainedHistory, retainedTrash, addedExcludedDomains);
    const final = deleteExcludedDomainMatches(retainedHistory, retainedTrash, addedExcludedDomains);
    const combined = {
      historyEventCount: retention.historyEventCount + exclusions.historyEventCount,
      historyTabCount: countTabs(historySource) - countTabs(final.history),
      trashEventCount: retention.trashEventCount + exclusions.trashEventCount,
      trashTabCount: countTabs(trashSource) - countTabs(final.trash),
    };
    combined.totalEventCount = combined.historyEventCount + combined.trashEventCount;
    combined.totalTabCount = combined.historyTabCount + combined.trashTabCount;
    return { addedExcludedDomains, retention, exclusions, combined };
  }

  function normalizeSelectedIds(eventIds) {
    return new Set((Array.isArray(eventIds) ? eventIds : [])
      .filter((id) => id !== null && id !== undefined)
      .map((id) => String(id)));
  }

  function isSelectedEvent(event, ids) {
    return event && event.id !== null && event.id !== undefined && ids.has(String(event.id));
  }

  function cloneEvent(event) {
    return {
      ...event,
      tabs: Array.isArray(event && event.tabs)
        ? event.tabs.map((item) => ({ ...item }))
        : [],
    };
  }

  function moveEventsToTrash(history, trash, eventIds, deletedAt = Date.now()) {
    const sourceHistory = Array.isArray(history) ? history : [];
    const sourceTrash = Array.isArray(trash) ? trash : [];
    const ids = normalizeSelectedIds(eventIds);
    const moved = sourceHistory
      .filter((event) => isSelectedEvent(event, ids))
      .map((event) => ({ ...cloneEvent(event), deletedAt }));
    return {
      history: sourceHistory.filter((event) => !isSelectedEvent(event, ids)).map(cloneEvent),
      trash: sourceTrash.map(cloneEvent).concat(moved),
      moved,
    };
  }

  function restoreTrashEntries(history, trash, trashIds, settings, restoredAt = Date.now()) {
    const sourceHistory = Array.isArray(history) ? history : [];
    const sourceTrash = Array.isArray(trash) ? trash : [];
    const ids = normalizeSelectedIds(trashIds);
    const selected = sourceTrash.filter((entry) => isSelectedEvent(entry, ids));
    if (selected.length === 0) {
      return {
        ok: true,
        requiredSlots: 0,
        history: sourceHistory.map(cloneEvent),
        trash: sourceTrash.map(cloneEvent),
        restored: [],
      };
    }
    const maxRecords = normalizeSettings(settings).maxRecords;
    const overflow = maxRecords === null
      ? 0
      : Math.max(0, sourceHistory.length + selected.length - maxRecords);
    if (overflow > 0) {
      return {
        ok: false,
        requiredSlots: overflow,
        history: sourceHistory.map(cloneEvent),
        trash: sourceTrash.map(cloneEvent),
        restored: [],
      };
    }

    const restored = selected.map((entry) => {
      const restoredEntry = { ...cloneEvent(entry), restoredAt };
      delete restoredEntry.deletedAt;
      return restoredEntry;
    });
    return {
      ok: true,
      requiredSlots: 0,
      history: sourceHistory.map(cloneEvent).concat(restored),
      trash: sourceTrash.filter((entry) => !isSelectedEvent(entry, ids)).map(cloneEvent),
      restored,
    };
  }

  function permanentlyDeleteTrashEntries(trash, trashIds) {
    const source = Array.isArray(trash) ? trash : [];
    const ids = normalizeSelectedIds(trashIds);
    const deleted = source.filter((entry) => isSelectedEvent(entry, ids)).map(cloneEvent);
    return {
      trash: source.filter((entry) => !isSelectedEvent(entry, ids)).map(cloneEvent),
      deletedCount: deleted.length,
      deleted,
    };
  }

  function getVisibleEvents(state, mode) {
    const activeMode = normalizeMode(mode);
    const events = ((state && state.events && state.events[activeMode]) || [])
      .map((event) => normalizeCloseEvent(event, activeMode))
      .filter(Boolean)
      .sort((a, b) => b.closedAt - a.closedAt);
    const seenSingleUrls = new Set();
    const visible = [];

    for (const event of events) {
      if (event.kind === 'single') {
        const url = normalizeUrlKey(event.tabs[0] && event.tabs[0].url);
        if (!url || seenSingleUrls.has(url)) {
          continue;
        }
        seenSingleUrls.add(url);
      }
      visible.push(event);
    }
    return visible;
  }

  function findMatchRanges(text, query) {
    if (text === null || text === undefined || query === null || query === undefined) {
      return [];
    }
    const source = String(text);
    const needle = String(query);
    if (!needle) {
      return [];
    }

    const foldedSource = [];
    const originalStarts = [];
    const originalEnds = [];
    let originalOffset = 0;
    for (const codePoint of source) {
      const foldedCodePoint = codePoint.toLowerCase();
      const originalEnd = originalOffset + codePoint.length;
      for (let index = 0; index < foldedCodePoint.length; index += 1) {
        foldedSource.push(foldedCodePoint[index]);
        originalStarts.push(originalOffset);
        originalEnds.push(originalEnd);
      }
      originalOffset = originalEnd;
    }
    const normalizedSource = foldedSource.join('');
    const normalizedNeedle = Array.from(needle, (codePoint) => codePoint.toLowerCase()).join('');
    if (!normalizedNeedle) {
      return [];
    }
    const ranges = [];
    let offset = 0;
    while (offset <= normalizedSource.length - normalizedNeedle.length) {
      const start = normalizedSource.indexOf(normalizedNeedle, offset);
      if (start === -1) {
        break;
      }
      const end = start + normalizedNeedle.length;
      ranges.push([originalStarts[start], originalEnds[end - 1]]);
      offset = end;
    }
    return ranges;
  }

  function buildSearchResults(events, query, options = {}) {
    const source = Array.isArray(events) ? events : [];
    const normalizedQuery = query === null || query === undefined ? '' : String(query).trim();
    const seenSingleUrls = new Set();
    const results = [];

    for (const event of source) {
      if (!event || typeof event !== 'object' || !Array.isArray(event.tabs)) {
        continue;
      }
      const resultEvent = cloneEvent(event);
      const tabs = resultEvent.tabs.filter((item) => item && typeof item === 'object');
      if (options.deduplicateSingles && event.kind === 'single') {
        const url = normalizeUrlKey(tabs[0] && tabs[0].url);
        if (url && seenSingleUrls.has(url)) {
          continue;
        }
        if (url) {
          seenSingleUrls.add(url);
        }
      }

      const matchedTabs = [];
      const matchRanges = Object.create(null);
      const usedTabIds = new Set();
      const usedTabKeys = new Set();
      const naturalTabKeys = new Set(tabs
        .filter((item) => item.id !== null && item.id !== undefined)
        .map((item) => `id:${String(item.id)}`));
      tabs.forEach((item, index) => {
        let tabKey;
        if (item.id === null || item.id === undefined) {
          tabKey = `index:${index}`;
        } else {
          const baseKey = `id:${String(item.id)}`;
          tabKey = usedTabIds.has(baseKey) ? `${baseKey}@${index}` : baseKey;
          usedTabIds.add(baseKey);
          while (usedTabKeys.has(tabKey) || (tabKey !== baseKey && naturalTabKeys.has(tabKey))) {
            tabKey = `${tabKey}@${index}`;
          }
        }
        usedTabKeys.add(tabKey);
        if (!normalizedQuery) {
          matchedTabs.push(item);
          return;
        }
        const title = findMatchRanges(item.title, normalizedQuery);
        const url = findMatchRanges(item.url, normalizedQuery);
        if (title.length === 0 && url.length === 0) {
          return;
        }
        matchedTabs.push(item);
        matchRanges[tabKey] = { title, url };
      });

      if (normalizedQuery && matchedTabs.length === 0) {
        continue;
      }
      results.push({
        event: resultEvent,
        matchedTabs,
        matchedTabCount: matchedTabs.length,
        totalTabCount: tabs.length,
        matchRanges,
      });
    }
    return results;
  }

  function searchEvents(state, mode, query) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const visible = getVisibleEvents(state, mode);
    if (!normalizedQuery) {
      return visible;
    }
    return visible.filter((event) => event.tabs.some((item) => {
      return item.title.toLowerCase().includes(normalizedQuery)
        || item.url.toLowerCase().includes(normalizedQuery);
    }));
  }

  function deleteEvent(state, mode, eventId) {
    const activeMode = normalizeMode(mode);
    const before = state.events[activeMode].length;
    state.events[activeMode] = state.events[activeMode].filter((event) => event.id !== eventId);
    return state.events[activeMode].length !== before;
  }

  function bulkDeleteEvents(state, mode, eventIds) {
    const activeMode = normalizeMode(mode);
    const ids = new Set(eventIds);
    const before = state.events[activeMode].length;
    state.events[activeMode] = state.events[activeMode].filter((event) => !ids.has(event.id));
    return before - state.events[activeMode].length;
  }

  function clearMode(state, mode) {
    state.events[normalizeMode(mode)] = [];
  }

  function getRestoreUrls(event) {
    const normalized = normalizeCloseEvent(event);
    if (!normalized) {
      return [];
    }
    return normalized.tabs
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((item) => item.url)
      .filter(Boolean);
  }

  function normalizeUrlKey(url) {
    return String(url || '').trim().toLowerCase();
  }

  function formatRelativeTime(timestamp, now = Date.now()) {
    const elapsed = Math.max(0, now - Number(timestamp || 0));
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (elapsed < minute) {
      return 'just now';
    }
    if (elapsed < hour) {
      return `${Math.floor(elapsed / minute)}m ago`;
    }
    if (elapsed < day) {
      return `${Math.floor(elapsed / hour)}h ago`;
    }
    return `${Math.floor(elapsed / day)}d ago`;
  }

  return {
    DEFAULT_SETTINGS,
    MODE_INCOGNITO,
    MODE_NORMAL,
    addCloseEvent,
    buildSearchResults,
    bulkDeleteEvents,
    clearMode,
    countTabs,
    createEmptyHistoryState,
    createId,
    deleteEvent,
    findMatchRanges,
    formatRelativeTime,
    getRestoreUrls,
    getVisibleEvents,
    moveEventsToTrash,
    normalizeCloseEvent,
    normalizeHistoryState,
    normalizeMode,
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
    isExcludedUrl,
    filterEventByExcludedDomains,
    previewExcludedDomainImpact,
    deleteExcludedDomainMatches,
    getAddedExcludedDomains,
    previewSettingsImpact,
    applySettingsAndOptionalExclusionCleanup,
  };
});
