(function popupModule(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabEchoPopup = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const DEFAULT_POPUP_SIZE = 100;
  const MAX_POPUP_SIZE = 200;
  const I18N = {
    en: {
      modeRegular: 'Regular window · Closed tabs', modeIncognito: 'Incognito window · Closed tabs',
      searchLabel: 'Search closed tabs', searchPlaceholder: 'Search title or web address',
      settings: 'Settings', trash: 'Trash', openTrash: 'Open Trash', historyList: 'Closed tabs', loading: 'Loading closed tabs',
      results: '{count} records (including Groups)', resultsLimited: '{total} records · showing {shown}', matches: '{count} matching entries', matchesLimited: '{total} matching entries · showing {shown}', openFullList: 'Open full list', viewAll: 'View all {count} results',
      moveShown: 'Move to Trash ({count})', moveShownLabel: 'Move the {count} shown entries to Trash', moveOne: 'Move to Trash', reopen: 'Reopen', reopenAll: 'Reopen all',
      removeNow: 'Remove now', removeShown: 'Remove shown ({count})', removeAll: 'Remove all ({count})', removeAllResults: 'Remove all results ({count})', confirmRemoval: 'Confirm removal', cancel: 'Cancel',
      removeWarning: 'Remove all {count} matching closed records ({tabs} tabs)? This cannot be undone.', removeShownWarning: 'Remove the {count} shown closed records ({tabs} tabs)? This cannot be undone.', removed: 'Removed {count} record(s). This cannot be undone.',
      group: '{count} tabs closed together', emptyTitle: 'No closed tabs yet', emptyBody: 'Close a tab and it will appear here.',
      noMatchTitle: 'No matching tabs', noMatchBody: 'Try another title or web address.', requestFailed: 'Operation failed. Please try again.',
      actionStale: 'Closed-tab records changed. Nothing was removed; please review and confirm again.',
      moved: 'Moved {count} to Trash.', reopened: 'Reopened {count} tab(s).', partial: 'Reopened {count}; {failed} failed.',
      trashUnavailable: 'Trash count unavailable',
      groupMatch: '{matched} of {total} tabs match', storageWriteFailed: 'Could not save data to browser storage. Check available space and try again.',
      indexedDbUnavailable: 'Regular closed-tab storage is unavailable. Reload the extension and try again.',
    },
    zh: {
      modeRegular: '常规窗口 · 已关闭标签页', modeIncognito: '无痕窗口 · 已关闭标签页',
      searchLabel: '搜索已关闭标签页', searchPlaceholder: '搜索标题或网址',
      settings: '设置', trash: '回收站', openTrash: '打开回收站', historyList: '已关闭标签页', loading: '正在加载关闭记录',
      results: '{count} 条记录（含标签组）', resultsLimited: '{total} 条记录 · 显示 {shown} 条', matches: '{count} 条匹配记录', matchesLimited: '{total} 条匹配 · 显示 {shown} 条', openFullList: '打开完整列表', viewAll: '查看全部 {count} 条结果',
      moveShown: '移入回收站（{count}）', moveShownLabel: '将当前显示的 {count} 条记录移至回收站', moveOne: '移至回收站', reopen: '重新打开', reopenAll: '全部重新打开',
      removeNow: '直接移除', removeShown: '移除当前显示的 {count} 条', removeAll: '全部移除（{count}）', removeAllResults: '移除全部搜索结果（{count}）', confirmRemoval: '确认移除', cancel: '取消',
      removeWarning: '将直接移除当前条件下的全部 {count} 条关闭记录（{tabs} 个标签页），无法恢复。', removeShownWarning: '将直接移除当前显示的 {count} 条关闭记录（{tabs} 个标签页），无法恢复。', removed: '已直接移除 {count} 条记录，无法恢复。',
      group: '同时关闭的 {count} 个标签页', emptyTitle: '暂无关闭记录', emptyBody: '关闭标签页后，可在这里快速重新打开。',
      noMatchTitle: '未找到匹配的标签页', noMatchBody: '试试其他页面标题或部分网址。', requestFailed: '操作失败，请重试。',
      actionStale: '关闭记录已发生变化，本次没有移除任何内容，请重新确认。',
      moved: '已将 {count} 条移至回收站。', reopened: '已重新打开 {count} 个标签页。', partial: '已重新打开 {count} 个；{failed} 个失败。',
      trashUnavailable: '回收站数量不可用',
      groupMatch: '命中 {matched} / {total} 个标签页', storageWriteFailed: '无法将数据保存到浏览器存储空间，请检查可用空间后重试。',
      indexedDbUnavailable: '常规关闭记录存储暂不可用，请重新加载扩展后重试。',
    },
  };

  const state = { query: '', loadedQuery: null, loading: true, results: [], totalRecords: 0, totalTabs: 0, totalResults: 0, totalResultTabs: 0, trashCount: 0,
    trashAvailable: true, mode: 'normal', settings: null, requestToken: 0, pending: new Set(), groupExpansion: new Map(), debounceTimer: null, statusTimer: null, removeMenuTimer: null, pendingRemoval: null };
  let elements;

  function t(key, values = {}) {
    const language = state.settings && state.settings.language === 'zh' ? 'zh' : 'en';
    const template = I18N[language][key] || I18N.en[key] || key;
    return Object.entries(values).reduce((text, [name, value]) => text.replaceAll('{' + name + '}', String(value)), template);
  }

  function errorMessage(error) {
    if (error && ['ACTION_STALE', 'ACTION_TOKEN_INVALID', 'ACTION_TOKEN_EXPIRED'].includes(error.code)) return t('actionStale');
    if (error && error.code === 'STORAGE_WRITE_FAILED') return t('storageWriteFailed');
    if (error && error.code === 'INDEXEDDB_UNAVAILABLE') return t('indexedDbUnavailable');
    return t('requestFailed');
  }

  function popupSize(settings = state.settings) {
    const value = Number(settings && settings.popupSize);
    return Number.isSafeInteger(value) && value >= 1 && value <= MAX_POPUP_SIZE ? value : DEFAULT_POPUP_SIZE;
  }

  function readStatistics(response, results = []) {
    const source = response && response.statistics;
    const count = (value, fallback = 0) => {
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
    };
    if (source && typeof source === 'object') {
      return {
        revision: count(source.revision), totalRecords: count(source.totalRecords), totalTabs: count(source.totalTabs),
        matchingRecords: count(source.matchingRecords), matchingTabs: count(source.matchingTabs),
        resultTabs: count(source.resultTabs), displayedRecords: count(source.displayedRecords),
      };
    }
    return {
      revision: count(response && response.revision), totalRecords: count(response && response.totalEventCount, count(response && response.resultEventCount)),
      totalTabs: count(response && response.totalTabCount, count(response && response.resultTabCount)), matchingRecords: count(response && response.resultEventCount),
      matchingTabs: count(response && response.matchedTabCount),
      resultTabs: count(response && response.resultTabCount, results.reduce((sum, result) => sum + count(result && result.totalTabCount), 0)),
      displayedRecords: results.length,
    };
  }

  function collectElements(doc) {
    return Object.fromEntries(['actionTooltip', 'bulkMoveButton', 'bulkMoveLabel', 'bulkRemoveButton', 'bulkRemoveMenu', 'bulkRemoveMenuWrap', 'removeShownButton', 'removeAllButton', 'bulkRemovePanel', 'bulkRemoveMessage', 'confirmBulkRemoveButton', 'cancelBulkRemoveButton', 'historyList', 'modeLabel', 'resultSummary', 'searchInput',
      'settingsButton', 'statusMessage', 'trashButton', 'trashCount', 'viewAllButton'].map((id) => [id, doc.getElementById(id)]));
  }

  async function start() {
    elements = collectElements(root.document);
    clearRemovalConfirmation();
    bindEvents();
    elements.searchInput.focus();
    const settingsResponse = await sendMessage({ type: 'get-settings' }).catch(() => null);
    if (settingsResponse && settingsResponse.settings) {
      state.settings = settingsResponse.settings;
      applyPreferences();
    }
    await refresh('');
  }

  function bindEvents() {
    elements.searchInput.addEventListener('input', () => {
      clearRemovalConfirmation();
      state.query = elements.searchInput.value;
      state.groupExpansion.clear();
      state.requestToken += 1;
      state.loading = true;
      state.loadedQuery = null;
      render();
      clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => refresh(state.query), 180);
    });
    elements.viewAllButton.addEventListener('click', () => {
      if (!resultsCurrent()) return;
      return openDashboard({ type: 'open-dashboard', view: 'history', q: elements.searchInput.value });
    });
    elements.trashButton.addEventListener('click', () => openDashboard({ type: 'open-dashboard', view: 'trash' }));
    elements.settingsButton.addEventListener('click', () => openDashboard({ type: 'open-dashboard', view: 'settings' }));
    elements.bulkMoveButton.addEventListener('click', () => moveVisible());
    elements.bulkRemoveButton.addEventListener('click', toggleRemoveMenu);
    elements.bulkRemoveMenuWrap.addEventListener('pointerleave', scheduleRemoveMenuClose);
    elements.bulkRemoveMenuWrap.addEventListener('pointerenter', cancelRemoveMenuClose);
    elements.removeShownButton.addEventListener('click', () => showRemovalConfirmation('shown'));
    elements.removeAllButton.addEventListener('click', () => showRemovalConfirmation('all'));
    elements.confirmBulkRemoveButton.addEventListener('click', confirmRemoval);
    elements.cancelBulkRemoveButton.addEventListener('click', () => clearRemovalConfirmation(true));
    elements.bulkMoveButton.addEventListener('pointerenter', showActionTooltip);
    elements.bulkMoveButton.addEventListener('pointerleave', hideActionTooltip);
    elements.bulkMoveButton.addEventListener('focus', showActionTooltip);
    elements.bulkMoveButton.addEventListener('blur', hideActionTooltip);
    elements.historyList.addEventListener('click', handleListClick);
    elements.historyList.addEventListener('pointerover', showActionTooltip);
    elements.historyList.addEventListener('pointerout', hideActionTooltip);
    elements.historyList.addEventListener('focusin', showActionTooltip);
    elements.historyList.addEventListener('focusout', hideActionTooltip);
    elements.historyList.addEventListener('scroll', hideActionTooltip);
    root.document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !isFormControl(event.target)) { event.preventDefault(); elements.searchInput.focus(); elements.searchInput.select(); }
      if (event.key === 'Escape' && state.pendingRemoval) { clearRemovalConfirmation(true); return; }
      if (event.key === 'Escape' && !elements.bulkRemoveMenu.hidden) { closeRemoveMenu(); elements.bulkRemoveButton.focus(); return; }
      if (event.key === 'Escape' && elements.searchInput.value) { elements.searchInput.value = ''; state.query = ''; state.groupExpansion.clear(); refresh(''); }
    });
  }

  async function refresh(query = state.query) {
    state.query = String(query || '');
    const token = ++state.requestToken;
    state.loading = true;
    state.loadedQuery = null;
    setBusy(true);
    const requestedQuery = state.query;
    const [historyResult, trashResult] = await Promise.allSettled([
      sendMessage({ type: 'get-history', query: requestedQuery, offset: 0, limit: popupSize() }),
      sendMessage({ type: 'get-trash', query: '', offset: 0, limit: 1 }),
    ]);
    if (token !== state.requestToken) return;
    if (historyResult.status === 'fulfilled') {
      const history = historyResult.value;
      state.mode = history.mode || state.mode;
      if (!state.settings) state.settings = history.settings || null;
      state.results = (Array.isArray(history.results) ? history.results : []).slice(0, popupSize());
      const counts = readStatistics(history, state.results);
      state.totalRecords = counts.totalRecords;
      state.totalTabs = counts.totalTabs;
      state.totalResults = counts.matchingRecords;
      state.totalResultTabs = counts.resultTabs;
      state.loadedQuery = requestedQuery;
      applyPreferences();
      showStatus('');
    } else {
      state.results = [];
      state.totalRecords = 0;
      state.totalTabs = 0;
      state.totalResults = 0;
      state.totalResultTabs = 0;
      state.loadedQuery = null;
    }
    if (trashResult.status === 'fulfilled') {
      state.trashCount = readStatistics(trashResult.value, trashResult.value.results).matchingRecords;
      state.trashAvailable = true;
    } else {
      state.trashAvailable = false;
    }
    state.loading = false;
    render();
    if (historyResult.status === 'rejected') {
      showStatus(errorMessage(historyResult.reason), true);
    }
  }

  function render() {
    const shown = state.results.length;
    elements.modeLabel.textContent = t(state.mode === 'incognito' ? 'modeIncognito' : 'modeRegular');
    const total = state.query.trim() ? state.totalResults : state.totalRecords;
    const summaryKey = state.query.trim()
      ? (shown < total ? 'matchesLimited' : 'matches')
      : (shown < total ? 'resultsLimited' : 'results');
    elements.resultSummary.textContent = t(summaryKey, { count: total, total, shown });
    elements.trashCount.textContent = state.trashAvailable ? String(state.trashCount) : '—';
    elements.trashButton.title = state.trashAvailable ? t('trash') : t('trashUnavailable');
    elements.trashButton.setAttribute('aria-label', state.trashAvailable ? t('openTrash') : t('trashUnavailable'));
    elements.viewAllButton.textContent = state.query.trim() ? t('viewAll', { count: state.totalResults }) : t('openFullList');
    elements.viewAllButton.hidden = Boolean(state.query.trim()) && state.totalResults <= popupSize();
    elements.bulkMoveLabel.textContent = t('moveShown', { count: shown });
    elements.bulkMoveButton.setAttribute('aria-label', t('moveShownLabel', { count: shown }));
    elements.bulkMoveButton.dataset.tooltip = t('moveShownLabel', { count: shown });
    elements.bulkMoveButton.disabled = shown === 0 || !resultsCurrent() || state.pending.size > 0;
    elements.bulkRemoveButton.textContent = t('removeNow');
    elements.removeShownButton.textContent = t('removeShown', { count: shown });
    elements.removeAllButton.textContent = t(state.query.trim() ? 'removeAllResults' : 'removeAll', { count: state.query.trim() ? state.totalResults : state.totalRecords });
    elements.bulkRemoveButton.disabled = (state.query.trim() ? state.totalResults : state.totalRecords) === 0 || !resultsCurrent() || state.pending.size > 0;
    elements.viewAllButton.disabled = !resultsCurrent() || state.pending.size > 0;
    elements.historyList.replaceChildren();
    if (shown === 0) { elements.historyList.appendChild(renderEmpty()); return; }
    const fragment = root.document.createDocumentFragment();
    for (const result of state.results) fragment.appendChild(renderEvent(result));
    elements.historyList.appendChild(fragment);
  }

  function renderEvent(result) {
    const closeEvent = result.event || {};
    const tabs = state.query.trim() ? (result.matchedTabs || []) : (closeEvent.tabs || []);
    const isGroup = closeEvent.kind === 'group';
    const groupKey = String(closeEvent.id);
    const expanded = isGroup
      ? (state.groupExpansion.has(groupKey) ? state.groupExpansion.get(groupKey) : Boolean(state.query.trim()))
      : false;
    const row = root.document.createElement('article'); row.className = 'event-row'; row.setAttribute('role', 'listitem');
    const copy = root.document.createElement('div'); copy.className = 'event-copy';
    const heading = root.document.createElement('div'); heading.className = 'event-heading';
    const title = isGroup
      ? makeButton(t('group', { count: result.totalTabCount || (closeEvent.tabs || []).length }), 'toggle-group', { eventId: closeEvent.id }, 'event-title group-toggle')
      : root.document.createElement('strong');
    title.className = isGroup ? 'event-title group-toggle' : 'event-title';
    if (isGroup) {
      title.setAttribute('aria-expanded', String(expanded));
      title.setAttribute('aria-controls', `popup-group-${encodeURIComponent(groupKey)}`);
    } else {
      title.textContent = tabTitle(tabs[0] || (closeEvent.tabs || [])[0]);
    }
    heading.append(title, renderEventTime(closeEvent.closedAt));
    const details = root.document.createElement('div'); details.className = 'event-details';
    if (isGroup) {
      details.id = `popup-group-${encodeURIComponent(groupKey)}`;
      details.hidden = !expanded;
      if (state.query.trim()) { const match = root.document.createElement('span'); match.textContent = t('groupMatch', { matched: result.matchedTabCount, total: result.totalTabCount }); details.appendChild(match); }
      for (const tab of tabs) details.appendChild(renderTab(closeEvent.id, tab));
    } else {
      const address = root.document.createElement('span'); address.className = 'tab-address';
      address.textContent = hostname((tabs[0] || (closeEvent.tabs || [])[0] || {}).url);
      details.appendChild(address);
    }
    copy.append(heading, details);
    const actions = root.document.createElement('div'); actions.className = 'event-actions';
    const primaryTab = (closeEvent.tabs || [])[0] || {};
    actions.append(isGroup
      ? makeButton(t('reopenAll'), 'reopen-event', { eventId: closeEvent.id }, 'reopen-button')
      : makeButton(t('reopen'), 'reopen-tab', { eventId: closeEvent.id, tabId: primaryTab.id }, 'reopen-button'));
    actions.append(makeButton(t('moveOne'), 'move-event', { eventId: closeEvent.id }, 'icon-action', '×'));
    row.append(copy, actions); return row;
  }

  function renderEventTime(closedAt) {
    const language = state.settings && state.settings.language === 'zh' ? 'zh' : 'en';
    const fullTime = root.TabEchoTimeFormat.formatFullTime(closedAt, language);
    const time = root.document.createElement('time'); time.className = 'event-time';
    time.textContent = root.TabEchoTimeFormat.formatRelativeTime(closedAt, language);
    time.setAttribute('datetime', new Date(Number(closedAt)).toISOString()); time.tabIndex = 0; time.dataset.fullTime = fullTime;
    time.dataset.tooltip = fullTime;
    time.setAttribute('aria-label', fullTime);
    return time;
  }

  function renderTab(eventId, tab) {
    const line = root.document.createElement('div'); line.className = 'tab-line';
    const text = root.document.createElement('span'); text.className = 'tab-copy';
    const title = root.document.createElement('span'); title.className = 'tab-title'; title.textContent = tabTitle(tab);
    const address = root.document.createElement('span'); address.className = 'tab-address'; address.textContent = hostname(tab && tab.url);
    text.append(title, address);
    const reopen = makeButton(t('reopen'), 'reopen-tab', { eventId, tabId: tab && tab.id }, 'tab-reopen');
    line.append(text, reopen); return line;
  }

  function makeButton(label, action, data, className, visibleText) {
    const button = root.document.createElement('button'); button.type = 'button'; button.className = className;
    button.textContent = visibleText || label; button.setAttribute('aria-label', label); button.dataset.action = action;
    if (visibleText) button.dataset.tooltip = label;
    for (const [key, value] of Object.entries(data || {})) button.dataset[key] = String(value);
    button.disabled = !resultsCurrent() || state.pending.size > 0; return button;
  }

  function showActionTooltip(event) {
    const target = event.target.closest && event.target.closest('[data-tooltip]');
    if (!target || target.disabled) return;
    const tooltip = elements.actionTooltip;
    const rect = target.getBoundingClientRect();
    tooltip.textContent = target.dataset.tooltip;
    tooltip.hidden = false;
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const centeredLeft = rect.left + rect.width / 2 - tooltipRect.width / 2;
    const maxLeft = Math.max(margin, root.innerWidth - tooltipRect.width - margin);
    const left = Math.min(maxLeft, Math.max(margin, centeredLeft));
    const above = rect.top - tooltipRect.height - gap;
    const below = rect.bottom + gap;
    const maxTop = Math.max(margin, root.innerHeight - tooltipRect.height - margin);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.min(maxTop, Math.max(margin, above >= margin ? above : below))}px`;
    target.setAttribute('aria-describedby', 'actionTooltip');
  }

  function hideActionTooltip(event) {
    const target = event && event.target && event.target.closest && event.target.closest('[data-tooltip]');
    if (target && event.relatedTarget && target.contains && target.contains(event.relatedTarget)) return;
    if (target) target.removeAttribute('aria-describedby');
    elements.actionTooltip.hidden = true;
  }

  function renderEmpty() {
    const empty = root.document.createElement('div'); empty.className = 'empty-state'; empty.setAttribute('role', 'listitem');
    const title = root.document.createElement('strong'); title.textContent = t(state.query ? 'noMatchTitle' : 'emptyTitle');
    const body = root.document.createElement('span'); body.textContent = t(state.query ? 'noMatchBody' : 'emptyBody');
    empty.append(title, body); return empty;
  }

  async function handleListClick(event) {
    const button = event.target.closest && event.target.closest('button[data-action]');
    if (!button || !resultsCurrent() || button.disabled) return;
    const { action, eventId, tabId } = button.dataset;
    if (action === 'toggle-group') {
      const current = typeof button.getAttribute === 'function'
        ? button.getAttribute('aria-expanded') === 'true' : button['aria-expanded'] === 'true';
      state.groupExpansion.set(String(eventId), !current);
      render();
      if (typeof elements.historyList.querySelectorAll === 'function') {
        const replacement = Array.from(elements.historyList.querySelectorAll('[data-action="toggle-group"]'))
          .find((candidate) => candidate.dataset.eventId === String(eventId));
        if (replacement) replacement.focus();
      }
      return;
    }
    if (action === 'reopen-tab') await mutate({ type: 'reopen-tab', eventId, tabId }, 'reopen-tab:' + eventId + ':' + tabId, 'reopened');
    if (action === 'reopen-event') await mutate({ type: 'reopen-event', eventId }, 'reopen-event:' + eventId, 'reopened');
    if (action === 'move-event') await mutate({ type: 'move-to-trash', eventIds: [eventId] }, 'move:' + eventId, 'moved');
  }

  async function moveVisible() {
    if (!resultsCurrent()) return;
    const eventIds = state.results.map((result) => result.event.id);
    if (!eventIds.length) return;
    await mutate({ type: 'move-to-trash', eventIds }, 'move-visible', 'moved');
  }

  function cancelRemoveMenuClose() {
    root.clearTimeout(state.removeMenuTimer); state.removeMenuTimer = null;
  }

  function scheduleRemoveMenuClose() {
    cancelRemoveMenuClose();
    if (elements.bulkRemoveMenu.hidden) return;
    state.removeMenuTimer = root.setTimeout(closeRemoveMenu, 300);
  }

  function closeRemoveMenu() {
    cancelRemoveMenuClose(); elements.bulkRemoveMenu.hidden = true; elements.bulkRemoveButton.setAttribute('aria-expanded', 'false');
  }

  function toggleRemoveMenu() {
    cancelRemoveMenuClose();
    const opening = elements.bulkRemoveMenu.hidden;
    elements.bulkRemoveMenu.hidden = !opening; elements.bulkRemoveButton.setAttribute('aria-expanded', String(opening));
    if (opening) elements.removeShownButton.focus();
  }

  function clearRemovalConfirmation(restoreFocus = false) {
    state.pendingRemoval = null; elements.bulkRemovePanel.hidden = true; closeRemoveMenu();
    if (restoreFocus) elements.bulkRemoveButton.focus();
  }

  async function showRemovalConfirmation(scope = 'all') {
    const query = state.query.trim();
    const selection = state.results;
    const expectedCount = scope === 'shown' ? selection.length : (query ? state.totalResults : state.totalRecords);
    if (!resultsCurrent() || !expectedCount || state.pending.has('prepare-removal')) return;
    closeRemoveMenu();
    const requestToken = state.requestToken;
    const request = scope === 'shown'
      ? { type: 'prepare-destructive-action', operation: 'delete-history', eventIds: selection.map((result) => result.event.id) }
      : { type: 'prepare-destructive-action', operation: 'delete-history', all: true, query };
    state.pending.add('prepare-removal'); render();
    try {
      const prepared = await sendMessage(request);
      if (!resultsCurrent() || requestToken !== state.requestToken || query !== state.query.trim()) return;
      state.pendingRemoval = { token: prepared.token, count: prepared.eventCount, tabCount: prepared.tabCount, scope };
      elements.bulkRemoveMessage.textContent = t(scope === 'shown' ? 'removeShownWarning' : 'removeWarning', {
        count: prepared.eventCount, tabs: prepared.tabCount,
      });
      elements.confirmBulkRemoveButton.textContent = t('confirmRemoval'); elements.cancelBulkRemoveButton.textContent = t('cancel');
      elements.bulkRemovePanel.hidden = false; elements.confirmBulkRemoveButton.focus();
    } catch (error) {
      showStatus(errorMessage(error), true);
    } finally {
      state.pending.delete('prepare-removal'); render();
    }
  }

  async function confirmRemoval() {
    const pending = state.pendingRemoval; if (!pending || !resultsCurrent()) return;
    clearRemovalConfirmation();
    await mutate({ type: 'commit-destructive-action', token: pending.token }, 'remove-results', 'deleted');
  }

  async function mutate(message, key, countField) {
    if (!resultsCurrent() || state.pending.has(key)) return;
    state.pending.add(key); render();
    try {
      const response = await sendMessage(message);
      const failures = Array.isArray(response.failures) ? response.failures.length : 0;
      const feedback = failures ? t('partial', { count: response[countField] || 0, failed: failures })
        : t(countField === 'moved' ? 'moved' : countField === 'deleted' ? 'removed' : 'reopened', { count: response[countField] || 0 });
      await refresh(state.query);
      showStatus(feedback, failures > 0);
    } catch (error) { showStatus(errorMessage(error), true); }
    finally { state.pending.delete(key); render(); }
  }

  async function openDashboard(message) {
    if (state.pending.has('navigate')) return;
    state.pending.add('navigate');
    try { await sendMessage(message); if (root.window && typeof root.window.close === 'function') root.window.close(); }
    catch (error) { showStatus(errorMessage(error), true); }
    finally { state.pending.delete('navigate'); }
  }

  function applyPreferences() {
    const language = state.settings && state.settings.language === 'zh' ? 'zh' : 'en';
    root.document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    const theme = state.settings && state.settings.theme;
    if (theme === 'light' || theme === 'dark') root.document.documentElement.dataset.theme = theme;
    else delete root.document.documentElement.dataset.theme;
    root.document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
    root.document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
    root.document.querySelectorAll('[data-i18n-title]').forEach((node) => { node.title = t(node.dataset.i18nTitle); });
    root.document.querySelectorAll('[data-i18n-aria]').forEach((node) => { node.setAttribute('aria-label', t(node.dataset.i18nAria)); });
  }

  function resultsCurrent() { return !state.loading && state.loadedQuery === state.query; }
  function setBusy(busy) {
    if (!elements) return;
    state.loading = busy;
    elements.historyList.setAttribute('aria-busy', String(busy));
    if (busy) render();
  }
  function showStatus(message, error = false) {
    clearTimeout(state.statusTimer); state.statusError = Boolean(error);
    elements.statusMessage.setAttribute('role', error ? 'alert' : 'status');
    elements.statusMessage.setAttribute('aria-live', error ? 'assertive' : 'polite');
    elements.statusMessage.textContent = message; elements.statusMessage.classList.toggle('is-error', error);
    if (message && !error) state.statusTimer = setTimeout(() => { elements.statusMessage.textContent = ''; }, 5000);
  }
  function tabTitle(tab) { return (tab && (tab.title || tab.url)) || ''; }
  function hostname(url) { try { return new URL(url).hostname; } catch { return String(url || ''); } }
  function isFormControl(target) { return target && typeof target.closest === 'function' && Boolean(target.closest('input, button')); }
  async function sendMessage(message) {
    const response = await root.chrome.runtime.sendMessage(message);
    if (!response || !response.ok) { const details = response && response.error; const error = new Error(details ? (details.message || String(details)) : t('requestFailed')); error.code = details && details.code; throw error; }
    return response;
  }

  if (root.document) root.document.addEventListener('DOMContentLoaded', () => start().catch((error) => showStatus(errorMessage(error), true)));
  return { popupSize, readStatistics, start, refresh, state };
}));
