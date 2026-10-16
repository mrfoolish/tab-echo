(function initDashboard(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.TabEchoDashboard = api;
  api.start();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDashboard(root) {
  const VIEWS = new Set(['history', 'trash', 'settings']);
  const PAGE_SIZES = new Set([25, 50, 100]);
  const UI_STATE_KEY = 'tabEcho:dashboard-ui:v1';
  const I18N = {
    en: {
      closedTabs: 'Closed tabs', trash: 'Trash', settings: 'Settings',
      dashboardLabel: 'Dashboard navigation', historyListLabel: 'Closed tabs', searchAriaLabel: 'Search closed tabs', paginationLabel: 'History pagination', retry: 'Retry',
      regularMode: 'Regular window', incognitoMode: 'Incognito window',
      searchLabel: 'Search closed tabs', searchPlaceholder: 'Search titles or URLs',
      defaultList: 'By close time', byDomain: 'By domain', historyLayoutLabel: 'History layout', domainIndexLabel: 'Domains',
      multipleDomains: 'Cross-domain groups', unknownDomain: 'Unknown domain', domainRecordCount: '{count} closed records', domainGroupCount: '{events} groups · {tabs} tabs',
      moveAllRecords: 'Move all records', moveSearchResults: 'Move {count} results', moveHistoryLabel: 'Move closed records to Trash',
      moveDomainRecords: 'Move {count} from {domain}', removeDomainRecords: 'Remove {count} from {domain}',
      removeAllRecords: 'Remove all', removeSearchResults: 'Remove {count} results',
      confirmRemoveHistory: 'Remove {events} closed records ({tabs} tabs) now? This cannot be undone.',
      confirmRemoveSearch: 'Remove all {events} matching records ({tabs} tabs) now? This cannot be undone.',
      confirmRemoveDomain: 'Remove {events} records ({tabs} tabs) from {domain} now? This cannot be undone.',
      confirmRemoval: 'Confirm removal', confirmEmptying: 'Confirm emptying',
      confirmEmptyTrash: 'Empty Trash containing {events} records ({tabs} tabs)? This cannot be undone.',
      perPage: 'Per page', previous: 'Previous', next: 'Next',
      pageSummary: 'Page {page} of {pages}', resultSummary: '{events} records (including Groups) · {tabs} tabs',
      searchSummary: '{events} matching entries · {tabs} matching tabs', loading: 'Loading closed tabs…',
      emptyTitle: 'No closed tabs yet', emptyBody: 'Close a tab and it will appear here.',
      noMatchTitle: 'No matching tabs', noMatchBody: 'Try a different title or URL.',
      groupTitle: 'Closed group', singleTitle: 'Closed tab', tabCount: '{count} tabs',
      reopen: 'Reopen', reopenAll: 'Reopen all ({count})', moveOne: 'Move to Trash',
      expand: 'Expand group', collapse: 'Collapse group',
      moved: 'Moved {count} closed-tab entry or entries to Trash.', reopened: 'Reopened {count} tab(s).',
      partialReopen: 'Reopened {count} tab(s); {failed} failed.', requestFailed: 'Operation failed. Please try again.',
      actionStale: 'Records changed after this preview. Nothing was removed; please review and confirm again.',
      storageWriteFailed: 'Could not save data to browser storage. Check available space and try again.',
      indexedDbUnavailable: 'Regular closed-tab storage is unavailable. Reload the extension and try again.',
      settingsReadOnlyIncognito: 'Shared settings can only be changed in a regular window.',
      invalidExcludedDomains: 'Enter valid hostnames only, one per line.',
      restoreEntry: 'Move back to Closed tabs', restoreResults: 'Move all back to Closed tabs', restoreSearchResults: 'Move back {count} results', deletePermanently: 'Remove now',
      emptyTrash: 'Empty Trash', trashListLabel: 'Trash entries', trashPaginationLabel: 'Trash pagination',
      trashLoading: 'Loading Trash…', trashEmptyTitle: 'Trash is empty', trashEmptyBody: 'Deleted entries appear here until they expire.',
      trashNoMatchTitle: 'No matching Trash entries', trashNoMatchBody: 'Try a different title or URL.',
      trashGroupTitle: 'Deleted group', trashSingleTitle: 'Deleted tab', restoredEntries: 'Restored {count} record(s).',
      permanentlyDeleted: 'Removed {count} record(s). This cannot be undone.', emptiedTrash: 'Permanently deleted {count} Trash record(s).',
      confirmEmptyOne: 'Empty Trash? This cannot be undone.', confirmEmptyTwo: 'Confirm permanent deletion of every Trash entry. This cannot be undone.',
      capacityError: 'Not enough history capacity. Free {count} more slot(s) before restoring.',
      settingsIntro: 'Manage retention, display, appearance, and exclusions.', settingsLoading: 'Loading settings…', settingsSaved: 'Settings saved.',
      settingsScope: 'Settings are shared. This preview counts regular-window data; incognito records apply the same rules later.',
      retentionSection: 'Storage and cleanup', displaySection: 'Toolbar popup', appearanceSection: 'Appearance and language', exclusionsSection: 'Excluded domains',
      storageHealthTitle: 'Storage pressure', regularStorageLabel: 'Regular closed records', localStorageLabel: 'Incognito closed records',
      storageNormal: 'Normal', storageElevated: 'Elevated', storageWarning: 'Running low', storageCritical: 'Almost full', storageUnknown: 'Unavailable',
      storageUnavailable: 'Capacity unavailable', storageUsage: '{percent} · {used} of {quota}', storageWriteWarning: 'A recent storage write failed. Free browser storage before adding more records.',
      settingsCleanupPending: 'Settings saved. Cleanup for this browsing context will finish on its next read or automatic cleanup.',
      settingsOtherPending: ' The other regular or incognito browsing context will apply these settings on its next start or read.',
      restoreRefreshFailed: 'Restored successfully, but refreshing the list failed. Please try again.',
      maxRecords: 'Maximum records', maxRecordsHelp: 'Blank means unlimited, and browser storage limits still apply.',
      maxAgeDays: 'History retention (days)', maxAgeHelp: 'Blank means kept indefinitely, and browser storage limits still apply.',
      trashMaxAgeDays: 'Trash retention (days)', trashAgeHelp: 'Blank means kept indefinitely, and browser storage limits still apply.',
      popupSize: 'Maximum records shown', popupSizeHelp: 'The maximum number of closed-tab entries shown when you open Tab Echo from the browser toolbar. Choose from 1 to 200. This does not affect the full list or how many records are saved.', defaultPageSize: 'Entries per page', language: 'Language', languageEnglish: 'English', languageChinese: 'Simplified Chinese',
      theme: 'Theme', themeSystem: 'System', themeLight: 'Light', themeDark: 'Dark', groupMatch: '{matched} of {total} tabs match',
      saveSettings: 'Save settings', unlimited: 'Unlimited', invalidOptional: 'Enter a positive integer or leave blank.', invalidPopupSize: 'Enter an integer from 1 to 200.',
      settingsImpactWarning: 'These settings will permanently delete {historyEvents} closed records ({historyTabs} tabs) and {trashEvents} Trash records ({trashTabs} tabs). This cannot be undone.',
      exclusionImpactWarning: 'New excluded domains match {events} existing records ({tabs} tabs). New rules normally affect future records only.',
      confirmAndSave: 'Confirm and save', saveRulesOnly: 'Save rules only', saveAndRemove: 'Save and remove', saveRetentionOnly: 'Save and apply retention', saveAndRemoveAll: 'Save and remove all previewed data', cancel: 'Cancel',
      excludedDomains: 'Excluded domains', excludedDomainsHelp: "Enter domains you don't want Tab Echo to record, one per line. For example, example.com also excludes all of its subdomains. By default, saved rules affect only new closed-tab entries; if existing entries match, you can choose whether to remove them when saving.",
      deleteExistingMatches: 'Remove existing matches', confirmPermanentDelete: 'Remove now',
      excludedCleanupImpact: '{events} existing records contain {tabs} matching tabs. They will be permanently deleted, not moved to Trash.',
      excludedCleanupEmpty: 'No existing history or Trash entries match the saved exclusions.', excludedCleanupDone: 'Permanently deleted {tabs} matching tabs.',
      closedTimePrefix: 'Closed', trashedTimePrefix: 'Moved to Trash',
    },
    zh: {
      closedTabs: '已关闭标签页', trash: '回收站', settings: '设置',
      dashboardLabel: '管理页面导航', historyListLabel: '已关闭标签页列表', searchAriaLabel: '搜索已关闭标签页', paginationLabel: '历史记录分页', retry: '重试',
      regularMode: '常规窗口', incognitoMode: '无痕窗口',
      searchLabel: '搜索已关闭标签页', searchPlaceholder: '搜索标题或网址',
      defaultList: '按关闭时间', byDomain: '按域名', historyLayoutLabel: '历史记录布局', domainIndexLabel: '域名',
      multipleDomains: '跨域标签组', unknownDomain: '未知域名', domainRecordCount: '{count} 条关闭记录', domainGroupCount: '{events} 组 · {tabs} 个标签页',
      moveAllRecords: '移入全部记录', moveSearchResults: '移入 {count} 条结果', moveHistoryLabel: '将关闭记录移至回收站',
      moveDomainRecords: '移入 {domain} 的 {count} 条', removeDomainRecords: '移除 {domain} 的 {count} 条',
      removeAllRecords: '全部移除', removeSearchResults: '移除 {count} 条搜索结果',
      confirmRemoveHistory: '将直接移除全部 {events} 条关闭记录（{tabs} 个标签页），无法恢复。',
      confirmRemoveSearch: '将直接移除当前搜索条件下的全部 {events} 条记录（{tabs} 个标签页），无法恢复。',
      confirmRemoveDomain: '将直接移除 {domain} 下的 {events} 条记录（{tabs} 个标签页），无法恢复。',
      confirmRemoval: '确认移除', confirmEmptying: '确认清空',
      confirmEmptyTrash: '将清空回收站中的 {events} 条记录（{tabs} 个标签页），无法恢复。',
      perPage: '每页', previous: '上一页', next: '下一页',
      pageSummary: '第 {page} / {pages} 页', resultSummary: '{events} 条记录（含标签组）· {tabs} 个标签页',
      searchSummary: '{events} 条匹配记录 · {tabs} 个匹配标签页', loading: '正在加载已关闭标签页…',
      emptyTitle: '暂无已关闭标签页', emptyBody: '关闭标签页后，它会出现在这里。',
      noMatchTitle: '没有匹配的标签页', noMatchBody: '请尝试其他标题或网址。',
      groupTitle: '已关闭标签页组', singleTitle: '已关闭标签页', tabCount: '{count} 个标签页',
      reopen: '重新打开', reopenAll: '全部重新打开（{count}）', moveOne: '移至回收站',
      expand: '展开标签页组', collapse: '折叠标签页组',
      moved: '已将 {count} 条关闭记录移至回收站。', reopened: '已重新打开 {count} 个标签页。',
      partialReopen: '已重新打开 {count} 个标签页；{failed} 个失败。', requestFailed: '操作失败，请重试。',
      actionStale: '预览后记录已发生变化，本次没有移除任何内容，请重新确认。',
      storageWriteFailed: '无法将数据保存到浏览器存储空间，请检查可用空间后重试。',
      indexedDbUnavailable: '常规关闭记录存储暂不可用，请重新加载扩展后重试。',
      settingsReadOnlyIncognito: '共享设置只能在常规窗口中修改。',
      invalidExcludedDomains: '请仅填写有效域名，每行一个。',
      restoreEntry: '移回关闭记录', restoreResults: '全部移回关闭记录', restoreSearchResults: '移回 {count} 条搜索结果', deletePermanently: '直接移除',
      emptyTrash: '清空回收站', trashListLabel: '回收站记录', trashPaginationLabel: '回收站分页',
      trashLoading: '正在加载回收站…', trashEmptyTitle: '回收站为空', trashEmptyBody: '删除的记录会保留在这里，直到到期。',
      trashNoMatchTitle: '回收站中没有匹配项', trashNoMatchBody: '请尝试其他标题或网址。',
      trashGroupTitle: '已删除标签页组', trashSingleTitle: '已删除标签页', restoredEntries: '已恢复 {count} 条记录。',
      permanentlyDeleted: '已直接移除 {count} 条记录，无法恢复。', emptiedTrash: '已永久删除回收站中的 {count} 条记录。',
      confirmEmptyOne: '确定清空回收站吗？此操作不可恢复。', confirmEmptyTwo: '再次确认：永久删除回收站中的全部记录，此操作不可恢复。',
      capacityError: '历史容量不足，还需腾出 {count} 个可用名额才能恢复。',
      settingsIntro: '管理保存规则、工具栏弹窗、外观和排除域名。', settingsLoading: '正在加载设置…', settingsSaved: '设置已保存。',
      settingsScope: '设置在常规与无痕上下文间共享；本次预览只统计常规窗口数据，无痕记录会在之后应用相同规则。',
      retentionSection: '保存与清理', displaySection: '工具栏弹窗', appearanceSection: '外观与语言', exclusionsSection: '排除域名',
      storageHealthTitle: '存储空间', regularStorageLabel: '常规关闭记录', localStorageLabel: '无痕关闭记录',
      storageNormal: '空间充足', storageElevated: '占用偏高', storageWarning: '空间紧张', storageCritical: '空间将满', storageUnknown: '暂不可用',
      storageUnavailable: '无法获取容量', storageUsage: '{percent} · 已用 {used} / 共 {quota}', storageWriteWarning: '最近一次写入存储失败，请释放浏览器存储空间后再添加记录。',
      settingsCleanupPending: '设置已保存。当前浏览上下文的数据清理将在下次读取或自动清理时完成。',
      settingsOtherPending: '常规/无痕的另一浏览上下文会在其下次启动或读取时应用。',
      restoreRefreshFailed: '恢复成功，但列表刷新失败，请重试。',
      maxRecords: '最多保留记录数', maxRecordsHelp: '留空表示不限制，且仍受浏览器存储空间限制。',
      maxAgeDays: '历史保留天数', maxAgeHelp: '留空表示永久保留，且仍受浏览器存储空间限制。',
      trashMaxAgeDays: '回收站保留天数', trashAgeHelp: '留空表示永久保留，且仍受浏览器存储空间限制。',
      popupSize: '最多显示记录数', popupSizeHelp: '打开浏览器工具栏中的 Tab Echo 弹窗时，最多显示多少条关闭记录。可设置 1–200 条，不影响完整列表和实际保存数量。', defaultPageSize: '每页显示条数', language: '语言', languageEnglish: 'English', languageChinese: '简体中文',
      theme: '主题', themeSystem: '跟随系统', themeLight: '浅色', themeDark: '深色', groupMatch: '命中 {matched} / {total} 个标签页',
      saveSettings: '保存设置', unlimited: '无限', invalidOptional: '请输入正整数或留空。', invalidPopupSize: '请输入 1–200 之间的整数。',
      settingsImpactWarning: '这些设置将永久删除 {historyEvents} 条关闭记录（{historyTabs} 个标签页），并清理 {trashEvents} 条回收站记录（{trashTabs} 个标签页）。此操作不可恢复。',
      exclusionImpactWarning: '新增排除域名命中已有 {events} 条记录（{tabs} 个标签页）。默认情况下，新规则只影响以后关闭的标签页。',
      confirmAndSave: '确认并保存', saveRulesOnly: '仅保存规则', saveAndRemove: '保存并移除', saveRetentionOnly: '保存并按保留规则清理', saveAndRemoveAll: '保存并移除全部预览数据', cancel: '取消',
      excludedDomains: '排除域名', excludedDomainsHelp: '填写不希望 Tab Echo 记录的网站域名，每行一个。例如填写 example.com，也会排除其所有子域名。保存后默认只影响新产生的关闭记录；如命中已有记录，保存时可选择是否一并移除。',
      deleteExistingMatches: '移除已有匹配记录', confirmPermanentDelete: '直接移除',
      excludedCleanupImpact: '现有历史和回收站中有 {events} 条记录包含 {tabs} 个匹配标签页。它们将被永久删除，不会移入回收站。',
      excludedCleanupEmpty: '现有历史和回收站中没有匹配已保存排除规则的记录。', excludedCleanupDone: '已永久删除 {tabs} 个匹配标签页。',
      closedTimePrefix: '关闭于', trashedTimePrefix: '移入回收站于',
    },
  };

  function parseUrlState(search) {
    const params = new URLSearchParams(search || '');
    const rawView = params.get('view');
    const view = VIEWS.has(rawView) ? rawView : 'history';
    const rawPage = Number(params.get('page'));
    const rawSize = Number(params.get('pageSize'));
    return {
      view,
      query: params.get('q') || '',
      page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
      pageSize: PAGE_SIZES.has(rawSize) ? rawSize : 50,
    };
  }

  function buildUrlState(input) {
    const params = new URLSearchParams();
    params.set('view', VIEWS.has(input.view) ? input.view : 'history');
    if (input.query) params.set('q', input.query);
    if (Number(input.page) > 1) params.set('page', String(input.page));
    if (PAGE_SIZES.has(Number(input.pageSize)) && Number(input.pageSize) !== 50) {
      params.set('pageSize', String(input.pageSize));
    }
    return `?${params.toString()}`;
  }

  function paginateResults(results, requestedPage, requestedSize) {
    const source = Array.isArray(results) ? results : [];
    const pageSize = PAGE_SIZES.has(Number(requestedSize)) ? Number(requestedSize) : 50;
    const pageCount = Math.max(1, Math.ceil(source.length / pageSize));
    const page = Math.min(pageCount, Math.max(1, Number(requestedPage) || 1));
    return { items: source.slice((page - 1) * pageSize, page * pageSize), page, pageCount, total: source.length };
  }

  function getResultSelection(results) {
    const source = Array.isArray(results) ? results : [];
    const eventIds = [];
    const seen = new Set();
    let tabCount = 0;
    for (const result of source) {
      const id = result && result.event && result.event.id;
      if (id === null || id === undefined || seen.has(String(id))) continue;
      seen.add(String(id));
      eventIds.push(id);
      tabCount += Number(result.totalTabCount) || 0;
    }
    return { eventIds, eventCount: eventIds.length, tabCount };
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
      revision: count(response && response.revision), totalRecords: count(response && response.totalEventCount),
      totalTabs: count(response && response.totalTabCount), matchingRecords: count(response && response.resultEventCount),
      matchingTabs: count(response && response.matchedTabCount),
      resultTabs: count(response && response.resultTabCount, getResultSelection(results).tabCount),
      displayedRecords: results.length,
    };
  }

  function sortTrashResults(results) {
    return (Array.isArray(results) ? results : []).slice().sort((left, right) =>
      (Number(right && right.event && right.event.deletedAt) || 0) - (Number(left && left.event && left.event.deletedAt) || 0));
  }

  function buildRetentionPatch(values) {
    const patch = {};
    for (const name of ['maxRecords', 'maxAgeDays', 'trashMaxAgeDays']) {
      const raw = String(values && values[name] !== undefined ? values[name] : '').trim();
      patch[name] = raw === '' ? null : (/^[1-9]\d*$/.test(raw) ? Number(raw) : raw);
    }
    return patch;
  }

  function parseExcludedDomainsInput(value) {
    return Array.from(new Set(String(value || '').split(/[\n,]+/).map((item) => item.trim()).filter(Boolean)));
  }

  function getImpactCounts(impact) {
    const source = (impact && (impact.combined || impact.retention)) || impact || {};
    const counts = {
      historyEvents: Number(source.historyEventCount) || 0, historyTabs: Number(source.historyTabCount) || 0,
      trashEvents: Number(source.trashEventCount) || 0, trashTabs: Number(source.trashTabCount) || 0,
    };
    return { ...counts, totalEvents: counts.historyEvents + counts.trashEvents };
  }

  function createResourceState(query = '') {
    return {
      results: [], resultEventCount: 0, matchedTabCount: 0, totalEventCount: 0,
      totalTabCount: 0, loading: true, loadedQuery: null, token: 0, query,
      serverPaged: false, domainGroups: [], domainEventIds: [],
      selectedDomainEventCount: 0, selectedDomainTabCount: 0,
    };
  }

  function isLoadedResultCurrent(resourceState) {
    return Boolean(resourceState && !resourceState.loading && resourceState.loadedQuery === resourceState.query);
  }

  function isGroupExpanded(expanded, eventId, query) {
    const key = String(eventId);
    return expanded.has(key) ? expanded.get(key) : Boolean(String(query || '').trim());
  }

  function resolveDomainSelection(groups, selectedKey) {
    const source = Array.isArray(groups) ? groups : [];
    if (source.some((group) => group && group.key === selectedKey)) return selectedKey;
    return source.length && source[0] ? source[0].key : null;
  }

  function resolveAdjacentIndex(currentIndex, length, direction) {
    const next = Number(currentIndex) + Number(direction);
    return Number.isSafeInteger(next) && next >= 0 && next < Number(length) ? next : null;
  }

  function resolveRenderPage(resourceState, resultCount, pageSize) {
    if (!isLoadedResultCurrent(resourceState)) return Math.max(1, Number(resourceState && resourceState.page) || 1);
    return paginateResults(Array.from({ length: Math.max(0, Number(resultCount) || 0) }), resourceState.page, pageSize).page;
  }

  function beginAction(pending, key) {
    if (pending.has(key)) return false;
    pending.add(key);
    return true;
  }

  function endAction(pending, key) { pending.delete(key); }

  // Must mirror history-store's private range-key algorithm so returned matchRanges stay authoritative.
  function buildTabRangeKeys(tabs) {
    const source = Array.isArray(tabs) ? tabs : [];
    const usedTabIds = new Set();
    const usedTabKeys = new Set();
    const naturalTabKeys = new Set(source
      .filter((item) => item && item.id !== null && item.id !== undefined)
      .map((item) => `id:${String(item.id)}`));
    return source.map((item, index) => {
      let tabKey;
      if (!item || item.id === null || item.id === undefined) {
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
      return tabKey;
    });
  }

  function normalizeRanges(ranges, textLength) {
    const source = Array.isArray(ranges) ? ranges : [];
    const normalized = source.map((range) => {
      if (!Array.isArray(range)) return null;
      const start = Math.max(0, Math.min(textLength, Number(range[0]) || 0));
      const end = Math.max(start, Math.min(textLength, Number(range[1]) || 0));
      return end > start ? [start, end] : null;
    }).filter(Boolean).sort((left, right) => left[0] - right[0]);
    const merged = [];
    for (const range of normalized) {
      const previous = merged[merged.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push(range.slice());
    }
    return merged;
  }

  function appendHighlightedText(doc, parent, value, ranges) {
    const text = String(value || '');
    let offset = 0;
    for (const [start, end] of normalizeRanges(ranges, text.length)) {
      if (start > offset) parent.append(doc.createTextNode(text.slice(offset, start)));
      const mark = doc.createElement('mark');
      mark.append(doc.createTextNode(text.slice(start, end)));
      parent.append(mark);
      offset = end;
    }
    if (offset < text.length || text.length === 0) parent.append(doc.createTextNode(text.slice(offset)));
  }

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

  function start() {
    const doc = root.document;
    if (!doc || !root.chrome || !root.chrome.runtime) return;
    const state = {
      ...parseUrlState(root.location.search), mode: 'normal', language: 'en', theme: 'system',
      historyLayout: 'list', selectedDomain: null,
      history: createResourceState(parseUrlState(root.location.search).query), trash: createResourceState(parseUrlState(root.location.search).query),
      expanded: new Map(), debounceTimer: null, settingsRequestToken: 0, storageHealthRequestToken: 0, storageHealth: null,
      loading: true, loadedQuery: null, actionPending: new Set(),
      pendingSettingsConfirmation: null, pendingDestructiveAction: null, statusTimer: null, statusError: false,
    };
    const elements = {
      nav: doc.getElementById('dashboardNav'), search: doc.getElementById('searchInput'),
      status: doc.getElementById('statusMessage'), historyView: doc.getElementById('historyView'),
      trashView: doc.getElementById('trashView'), settingsView: doc.getElementById('settingsView'),
      list: doc.getElementById('historyList'), resultSummary: doc.getElementById('resultSummary'),
      pageSummary: doc.getElementById('pageSummary'), pageSize: doc.getElementById('pageSizeSelect'),
      previous: doc.getElementById('prevPageButton'), next: doc.getElementById('nextPageButton'),
      moveHistory: doc.getElementById('moveHistoryButton'), moveHistoryLabel: doc.getElementById('moveHistoryLabel'),
      removeHistory: doc.getElementById('removeHistoryButton'), historyRemovePanel: doc.getElementById('historyRemovePanel'),
      historyRemoveMessage: doc.getElementById('historyRemoveMessage'), confirmHistoryRemove: doc.getElementById('confirmHistoryRemoveButton'),
      cancelHistoryRemove: doc.getElementById('cancelHistoryRemoveButton'),
      modeLabel: doc.getElementById('modeLabel'), settingsForm: doc.getElementById('settingsForm'),
      pagination: doc.getElementById('pagination'), retry: doc.getElementById('retryButton'),
      trashList: doc.getElementById('trashList'), trashSummary: doc.getElementById('trashResultSummary'),
      trashPagination: doc.getElementById('trashPagination'), trashPageSummary: doc.getElementById('trashPageSummary'),
      trashPageSize: doc.getElementById('trashPageSizeSelect'), trashPrevious: doc.getElementById('trashPrevPageButton'),
      trashNext: doc.getElementById('trashNextPageButton'), restoreResults: doc.getElementById('restoreTrashResultsButton'),
      emptyTrash: doc.getElementById('emptyTrashButton'), settingsSummary: doc.getElementById('settingsSummary'),
      trashEmptyPanel: doc.getElementById('trashEmptyPanel'), trashEmptyMessage: doc.getElementById('trashEmptyMessage'),
      confirmEmptyTrash: doc.getElementById('confirmEmptyTrashButton'), cancelEmptyTrash: doc.getElementById('cancelEmptyTrashButton'),
      saveSettings: doc.getElementById('saveSettingsButton'),
      settingsImpactPanel: doc.getElementById('settingsImpactPanel'), settingsImpactMessage: doc.getElementById('settingsImpactMessage'),
      confirmSettings: doc.getElementById('confirmSettingsButton'), confirmSettingsAndRemove: doc.getElementById('confirmSettingsAndRemoveButton'), cancelSettingsImpact: doc.getElementById('cancelSettingsImpactButton'),
      historyLayoutToggle: doc.getElementById('historyLayoutToggle'), domainHistoryView: doc.getElementById('domainHistoryView'),
      domainIndex: doc.getElementById('domainIndex'), domainList: doc.getElementById('domainHistoryList'),
      storageHealthPanel: doc.getElementById('storageHealthPanel'), storageHealthStatus: doc.getElementById('storageHealthStatus'),
      regularStorageValue: doc.getElementById('regularStorageValue'), regularStorageProgress: doc.getElementById('regularStorageProgress'),
      localStorageValue: doc.getElementById('localStorageValue'), localStorageProgress: doc.getElementById('localStorageProgress'),
      storageWriteWarning: doc.getElementById('storageWriteWarning'),
    };
    const timeFormat = root.TabEchoTimeFormat;

    function t(key, values = {}) {
      let value = (I18N[state.language] || I18N.en)[key] || I18N.en[key] || key;
      for (const [name, replacement] of Object.entries(values)) value = value.replace(`{${name}}`, String(replacement));
      return value;
    }

    function localize() {
      doc.documentElement.lang = state.language;
      doc.documentElement.dataset.theme = state.theme;
      doc.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
      doc.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
      elements.nav.setAttribute('aria-label', t('dashboardLabel'));
      elements.list.setAttribute('aria-label', t('historyListLabel'));
      elements.trashList.setAttribute('aria-label', t('trashListLabel'));
      elements.search.setAttribute('aria-label', t('searchAriaLabel'));
      elements.pagination.setAttribute('aria-label', t('paginationLabel'));
      elements.trashPagination.setAttribute('aria-label', t('trashPaginationLabel'));
      elements.moveHistory.setAttribute('aria-label', t('moveHistoryLabel'));
      elements.confirmHistoryRemove.textContent = t('confirmRemoval');
      elements.confirmEmptyTrash.textContent = t('confirmEmptying');
      elements.cancelHistoryRemove.textContent = t('cancel');
      elements.cancelEmptyTrash.textContent = t('cancel');
      elements.historyLayoutToggle.setAttribute('aria-label', t('historyLayoutLabel'));
      elements.domainIndex.setAttribute('aria-label', t('domainIndexLabel'));
      elements.retry.textContent = t('retry');
      if (state.view === 'settings') renderStorageHealth(state.storageHealth);
      const viewLabel = t(state.view === 'history' ? 'closedTabs' : state.view);
      elements.modeLabel.textContent = `${t(state.mode === 'incognito' ? 'incognitoMode' : 'regularMode')} · ${t('closedTabs')}`;
      doc.title = `Tab Echo - ${viewLabel}`;
    }

    function showStatus(message, isError = false) {
      root.clearTimeout(state.statusTimer);
      state.statusError = Boolean(message && isError);
      elements.status.setAttribute('role', isError ? 'alert' : 'status');
      elements.status.setAttribute('aria-live', isError ? 'assertive' : 'polite');
      elements.status.textContent = message || '';
      elements.status.classList.toggle('is-error', isError);
      if (message && !isError) state.statusTimer = root.setTimeout(() => { elements.status.textContent = ''; }, 5000);
    }

    function errorMessage(error) {
      if (error && ['ACTION_STALE', 'ACTION_TOKEN_INVALID', 'ACTION_TOKEN_EXPIRED'].includes(error.code)) return t('actionStale');
      if (error && error.code === 'STORAGE_WRITE_FAILED') return t('storageWriteFailed');
      if (error && error.code === 'INDEXEDDB_UNAVAILABLE') return t('indexedDbUnavailable');
      if (error && error.code === 'SETTINGS_READ_ONLY_INCOGNITO') return t('settingsReadOnlyIncognito');
      return t('requestFailed');
    }

    function showError(error) {
      const message = errorMessage(error);
      showStatus(message, true);
      elements.list.setAttribute('aria-busy', 'false');
      elements.list.replaceChildren(makeStateNode('error-state', t('requestFailed'), message));
      elements.retry.hidden = false;
    }

    async function sendMessage(message) {
      const response = await root.chrome.runtime.sendMessage(message);
      if (!response || response.ok === false) {
        const error = response && response.error;
        const failure = new Error((error && error.message) || String(error || t('requestFailed')));
        if (response) Object.assign(failure, { code: error && error.code, requiredSlots: response.requiredSlots, fields: error && error.fields });
        throw failure;
      }
      return response;
    }

    function updateUrl(method = 'pushState') {
      const next = buildUrlState(state);
      root.history[method]({}, '', `${root.location.pathname}${next}`);
    }

    function persistView() {
      if (root.chrome.storage && root.chrome.storage.session) {
        root.chrome.storage.session.set({ [`${UI_STATE_KEY}:${state.mode}`]: { view: state.view, historyLayout: state.historyLayout } }).catch(() => undefined);
      }
    }

    function switchView(view, options = {}) {
      const nextView = VIEWS.has(view) ? view : 'history';
      clearDestructiveConfirmation();
      if (nextView !== 'settings') { state.settingsRequestToken += 1; state.storageHealthRequestToken += 1; clearSettingsImpact(); }
      state.view = nextView;
      if (options.resetPage !== false) state.page = 1;
      elements.historyView.hidden = state.view !== 'history';
      elements.trashView.hidden = state.view !== 'trash';
      elements.settingsView.hidden = state.view !== 'settings';
      elements.nav.querySelectorAll('[data-view]').forEach((button) => {
        if (button.dataset.view === state.view) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      elements.search.closest('.search-field').hidden = state.view === 'settings';
      localize();
      if (options.persist !== false) persistView();
      if (options.history !== false) updateUrl(options.replace ? 'replaceState' : 'pushState');
      if (options.refresh !== false) {
        if (state.view === 'history') return refreshHistory();
        if (state.view === 'trash') return refreshTrash();
        return refreshSettings();
      }
      return undefined;
    }

    function makeStateNode(className, title, body) {
      const panel = doc.createElement('div'); panel.className = className; panel.setAttribute('role', 'listitem');
      const strong = doc.createElement('strong'); strong.textContent = title;
      const copy = doc.createElement('span'); copy.textContent = body;
      panel.append(strong, copy); return panel;
    }

    function visibleTabs(result) {
      const tabs = Array.isArray(result.event && result.event.tabs) ? result.event.tabs : [];
      if (!state.query.trim()) return tabs.map((tab, index) => ({ tab, key: buildTabRangeKeys(tabs)[index] }));
      const keys = buildTabRangeKeys(tabs);
      return tabs.map((tab, index) => ({ tab, key: keys[index] }))
        .filter(({ key }) => Object.hasOwn(result.matchRanges || {}, key));
    }

    function resource(name) { return state[name]; }
    function currentResource(name) { const value = resource(name); return isLoadedResultCurrent({ ...value, query: state.query }); }

    function makeButton(label, action, data = {}, className = 'text-button') {
      const button = doc.createElement('button'); button.type = 'button'; button.className = className;
      button.textContent = label; button.dataset.action = action;
      for (const [key, value] of Object.entries(data)) button.dataset[key] = String(value);
      return button;
    }

    function formatTime(timestamp) {
      if (timeFormat && typeof timeFormat.formatRelativeTime === 'function') {
        return {
          relative: timeFormat.formatRelativeTime(timestamp, state.language),
          full: timeFormat.formatFullTime(timestamp, state.language),
        };
      }
      const full = new Date(timestamp).toLocaleString(state.language === 'zh' ? 'zh-CN' : 'en');
      return { relative: full, full };
    }

    function setTime(node, timestamp, prefix = '') {
      const formatted = formatTime(timestamp);
      node.className = `${node.className || ''} event-time`.trim();
      node.textContent = prefix ? `${prefix} ${formatted.relative}` : formatted.relative;
      node.tabIndex = 0; node.dataset.fullTime = prefix ? `${prefix} ${formatted.full}` : formatted.full;
      node.setAttribute('aria-label', prefix ? `${prefix} ${formatted.full}` : formatted.full);
    }

    function renderTab(result, tab, key) {
      const row = doc.createElement('div'); row.className = 'tab-row'; row.setAttribute('role', 'listitem');
      const copy = doc.createElement('div'); copy.className = 'tab-copy';
      const title = doc.createElement('strong');
      const url = doc.createElement('span');
      const ranges = (result.matchRanges && result.matchRanges[key]) || {};
      appendHighlightedText(doc, title, tab.title || tab.url, ranges.title);
      appendHighlightedText(doc, url, tab.url, ranges.url);
      copy.append(title, url);
      const actions = doc.createElement('div'); actions.className = 'tab-actions';
      actions.append(makeButton(t('reopen'), 'reopen-tab', { eventId: result.event.id, tabId: tab.id }));
      row.append(copy, actions); return row;
    }

    function renderEvent(result) {
      const event = result.event;
      const isGroup = event.kind === 'group' || result.totalTabCount > 1;
      const expanded = isGroupExpanded(state.expanded, event.id, state.query);
      const card = doc.createElement('article'); card.className = `event-card ${isGroup ? `is-group ${expanded ? 'is-expanded' : 'is-collapsed'}` : 'is-single'}`; card.setAttribute('role', 'listitem');
      const header = doc.createElement('div'); header.className = 'event-header';
      let toggle;
      if (isGroup) {
        toggle = makeButton(expanded ? '⌄' : '›', 'toggle', { eventId: event.id }, 'chevron');
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-controls', `history-tabs-${encodeURIComponent(String(event.id))}`);
        toggle.setAttribute('aria-label', t(expanded ? 'collapse' : 'expand'));
      } else {
        toggle = null;
      }
      const summary = doc.createElement('div'); summary.className = 'event-summary';
      const title = doc.createElement('strong');
      const meta = doc.createElement('span');
      if (isGroup) {
        summary.className = 'event-summary group-summary';
        const identity = doc.createElement('span'); identity.className = 'group-identity';
        title.textContent = t('groupTitle');
        const countText = state.query
          ? t('groupMatch', { matched: result.matchedTabCount, total: result.totalTabCount })
          : t('tabCount', { count: result.totalTabCount });
        const groupBadge = doc.createElement('span'); groupBadge.className = 'group-badge'; groupBadge.textContent = countText;
        identity.append(title, groupBadge);
        setTime(meta, event.closedAt);
        summary.append(identity, meta);
      } else {
        const [{ tab = {}, key } = {}] = visibleTabs(result);
        const ranges = (result.matchRanges && result.matchRanges[key]) || {};
        appendHighlightedText(doc, title, tab.title || tab.url, ranges.title);
        const details = doc.createElement('span'); details.className = 'event-details-inline';
        meta.className = 'event-address'; appendHighlightedText(doc, meta, tab.url, ranges.url);
        const time = doc.createElement('time'); setTime(time, event.closedAt, t('closedTimePrefix'));
        details.append(meta, time);
        summary.append(title, details);
      }
      const actions = doc.createElement('div'); actions.className = 'event-actions';
      actions.append(
        makeButton(isGroup ? t('reopenAll', { count: result.totalTabCount }) : t('reopen'), 'reopen-event', { eventId: event.id }),
        makeButton(t('moveOne'), 'move-event', { eventId: event.id }, 'text-button move'),
        makeButton(t('deletePermanently'), 'delete-history', { eventId: event.id }, 'text-button permanent-delete'),
      );
      if (toggle) header.append(toggle);
      header.append(summary, actions); card.append(header);
      if (isGroup) {
        const list = doc.createElement('div'); list.className = 'tabs-list'; list.id = `history-tabs-${encodeURIComponent(String(event.id))}`; list.setAttribute('role', 'list'); list.hidden = !expanded;
        if (expanded) for (const { tab, key } of visibleTabs(result)) list.append(renderTab(result, tab, key));
        card.append(list);
      }
      if (!currentResource('history') || state.actionPending.size > 0) {
        card.querySelectorAll('button[data-action]').forEach((button) => { button.disabled = true; });
      }
      return card;
    }

    function renderTrashEvent(result) {
      const event = result.event;
      const isGroup = event.kind === 'group' || result.totalTabCount > 1;
      const expanded = isGroupExpanded(state.expanded, event.id, state.query);
      const card = doc.createElement('article'); card.className = `event-card ${isGroup ? `is-group ${expanded ? 'is-expanded' : 'is-collapsed'}` : 'is-single'}`; card.setAttribute('role', 'listitem');
      const header = doc.createElement('div'); header.className = 'event-header';
      let toggle;
      if (isGroup) {
        toggle = makeButton(expanded ? '⌄' : '›', 'toggle-trash', { eventId: event.id }, 'chevron');
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-controls', `trash-tabs-${encodeURIComponent(String(event.id))}`);
        toggle.setAttribute('aria-label', t(expanded ? 'collapse' : 'expand'));
      } else { toggle = null; }
      const summary = doc.createElement('div'); summary.className = 'event-summary';
      const title = doc.createElement('strong');
      const meta = doc.createElement('span');
      const closedTime = formatTime(event.closedAt);
      const deletedTime = formatTime(event.deletedAt);
      const trashTiming = `${t('closedTimePrefix')} ${closedTime.relative} · ${t('trashedTimePrefix')} ${deletedTime.relative}`;
      const trashTimingTitle = `${t('closedTimePrefix')} ${closedTime.full} · ${t('trashedTimePrefix')} ${deletedTime.full}`;
      if (isGroup) {
        summary.className = 'event-summary group-summary';
        const identity = doc.createElement('span'); identity.className = 'group-identity';
        title.textContent = t('trashGroupTitle');
        const countText = state.query
          ? t('groupMatch', { matched: result.matchedTabCount, total: result.totalTabCount })
          : t('tabCount', { count: result.totalTabCount });
        const groupBadge = doc.createElement('span'); groupBadge.className = 'group-badge'; groupBadge.textContent = countText;
        identity.append(title, groupBadge);
        meta.className = 'event-time'; meta.textContent = trashTiming; meta.tabIndex = 0; meta.dataset.fullTime = trashTimingTitle; meta.setAttribute('aria-label', trashTimingTitle);
        summary.append(identity, meta);
      } else {
        const [{ tab = {}, key } = {}] = visibleTabs(result);
        const ranges = (result.matchRanges && result.matchRanges[key]) || {};
        appendHighlightedText(doc, title, tab.title || tab.url, ranges.title);
        const details = doc.createElement('span'); details.className = 'event-details-inline';
        meta.className = 'event-address'; appendHighlightedText(doc, meta, tab.url, ranges.url);
        const time = doc.createElement('time'); time.className = 'event-time'; time.textContent = trashTiming; time.tabIndex = 0; time.dataset.fullTime = trashTimingTitle; time.setAttribute('aria-label', trashTimingTitle);
        details.append(meta, time); summary.append(title, details);
      }
      const actions = doc.createElement('div'); actions.className = 'event-actions';
      actions.append(
        makeButton(t('restoreEntry'), 'restore-trash', { eventId: event.id }),
        makeButton(t('deletePermanently'), 'delete-trash', { eventId: event.id }, 'text-button permanent-delete'),
      );
      if (toggle) header.append(toggle);
      header.append(summary, actions); card.append(header);
      if (isGroup) {
        const list = doc.createElement('div'); list.className = 'tabs-list'; list.id = `trash-tabs-${encodeURIComponent(String(event.id))}`; list.setAttribute('role', 'list'); list.hidden = !expanded;
        if (expanded) for (const { tab, key } of visibleTabs(result)) list.append(renderTrashTab(result, tab, key));
        card.append(list);
      }
      if (!currentResource('trash') || state.actionPending.size > 0) card.querySelectorAll('button[data-action]').forEach((button) => { button.disabled = true; });
      return card;
    }

    function renderTrashTab(result, tab, key) {
      const row = doc.createElement('div'); row.className = 'tab-row'; row.setAttribute('role', 'listitem');
      const copy = doc.createElement('div'); copy.className = 'tab-copy';
      const title = doc.createElement('strong'); const url = doc.createElement('span');
      const ranges = (result.matchRanges && result.matchRanges[key]) || {};
      appendHighlightedText(doc, title, tab.title || tab.url, ranges.title);
      appendHighlightedText(doc, url, tab.url, ranges.url); copy.append(title, url); row.append(copy); return row;
    }

    function renderHistory() {
      const data = state.history;
      if (!currentResource('history')) {
        elements.list.setAttribute('aria-busy', 'true');
        elements.previous.disabled = true; elements.next.disabled = true; elements.pageSize.disabled = true;
        elements.moveHistory.disabled = true; elements.removeHistory.disabled = true;
        return;
      }
      const groups = state.historyLayout === 'domain' ? data.domainGroups : [];
      state.selectedDomain = resolveDomainSelection(groups, state.selectedDomain);
      const selectedGroup = groups.find((group) => group.key === state.selectedDomain);
      const selectedDomainLabel = selectedGroup ? (selectedGroup.key === '__multiple_domains__' ? t('multipleDomains') : (selectedGroup.key === '__unknown_domain__' ? t('unknownDomain') : selectedGroup.label)) : '';
      const renderResults = data.results;
      const scopedSelection = state.historyLayout === 'domain'
        ? {
          eventIds: data.domainEventIds,
          eventCount: data.selectedDomainEventCount,
          tabCount: data.selectedDomainTabCount,
        }
        : getResultSelection(renderResults);
      const serverTotal = state.historyLayout === 'domain'
        ? data.selectedDomainEventCount
        : (state.query ? data.resultEventCount : data.totalEventCount);
      const paged = data.serverPaged
        ? { items: renderResults, page: state.page, pageCount: Math.max(1, Math.ceil(serverTotal / state.pageSize)), total: serverTotal }
        : paginateResults(renderResults, state.page, state.pageSize);
      state.page = data.serverPaged
        ? Math.min(paged.pageCount, Math.max(1, state.page))
        : resolveRenderPage({ ...data, query: state.query, page: state.page }, renderResults.length, state.pageSize); elements.pageSize.value = String(state.pageSize);
      elements.list.hidden = state.historyLayout !== 'list'; elements.domainHistoryView.hidden = state.historyLayout !== 'domain';
      elements.historyLayoutToggle.querySelectorAll('[data-history-layout]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.historyLayout === state.historyLayout)));
      const targetList = state.historyLayout === 'domain' ? elements.domainList : elements.list;
      targetList.replaceChildren(); targetList.setAttribute('aria-busy', String(data.loading));
      elements.domainIndex.replaceChildren();
      if (state.historyLayout === 'domain') {
        const indexList = doc.createElement('div'); indexList.className = 'domain-index-list';
        for (const group of groups) {
          const localizedLabel = group.key === '__multiple_domains__' ? t('multipleDomains')
            : (group.key === '__unknown_domain__' ? t('unknownDomain') : group.label);
          const button = makeButton(localizedLabel, 'select-domain', { domainKey: group.key }, 'domain-button');
          button.tabIndex = group.key === state.selectedDomain ? 0 : -1;
          button.setAttribute('aria-label', `${localizedLabel}, ${t('domainRecordCount', { count: group.eventCount })}`);
          const label = doc.createElement('span'); label.className = 'domain-label'; label.textContent = localizedLabel;
          const count = doc.createElement('span'); count.className = 'domain-count'; count.textContent = group.key === '__multiple_domains__'
            ? t('domainGroupCount', { events: group.eventCount, tabs: group.tabCount }) : String(group.eventCount);
          button.textContent = ''; button.append(label, count);
          if (group.key === state.selectedDomain) button.setAttribute('aria-current', 'true');
          indexList.append(button);
        }
        elements.domainIndex.append(indexList);
      }
      if (paged.total === 0) {
        targetList.append(makeStateNode('empty-state', t(state.query ? 'noMatchTitle' : 'emptyTitle'), t(state.query ? 'noMatchBody' : 'emptyBody')));
      } else {
        for (const result of paged.items) targetList.append(renderEvent(result));
      }
      elements.resultSummary.textContent = t(state.query ? 'searchSummary' : 'resultSummary', {
        events: state.historyLayout === 'domain' ? scopedSelection.eventCount : (state.query ? data.resultEventCount : data.totalEventCount),
        tabs: state.historyLayout === 'domain' ? scopedSelection.tabCount : (state.query ? data.matchedTabCount : data.totalTabCount),
      });
      elements.pageSummary.textContent = t('pageSummary', { page: paged.page, pages: paged.pageCount });
      const current = currentResource('history');
      const pending = state.actionPending.size > 0;
      elements.previous.disabled = !current || pending || paged.page <= 1; elements.next.disabled = !current || pending || paged.page >= paged.pageCount;
      elements.pageSize.disabled = !current || pending;
      const hasSearchQuery = Boolean(state.query.trim());
      elements.moveHistoryLabel.textContent = hasSearchQuery
        ? (state.historyLayout === 'domain' ? t('moveDomainRecords', { count: scopedSelection.eventCount, domain: selectedDomainLabel }) : t('moveSearchResults', { count: data.resultEventCount }))
        : (state.historyLayout === 'domain' ? t('moveDomainRecords', { count: scopedSelection.eventCount, domain: selectedDomainLabel }) : t('moveAllRecords'));
      elements.moveHistory.disabled = !current || pending || (state.historyLayout === 'domain' ? !scopedSelection.eventCount : (hasSearchQuery ? data.resultEventCount === 0 : data.totalEventCount === 0));
      elements.removeHistory.textContent = state.historyLayout === 'domain'
        ? t('removeDomainRecords', { count: scopedSelection.eventCount, domain: selectedDomainLabel })
        : (hasSearchQuery ? t('removeSearchResults', { count: data.resultEventCount }) : t('removeAllRecords'));
      elements.removeHistory.disabled = !current || pending || (state.historyLayout === 'domain' ? !scopedSelection.eventCount : (hasSearchQuery ? data.resultEventCount === 0 : data.totalEventCount === 0));
      if (Number(new URLSearchParams(root.location.search).get('page') || 1) !== state.page) updateUrl('replaceState');
    }

    function renderTrash() {
      const data = state.trash;
      if (!currentResource('trash')) {
        elements.trashList.setAttribute('aria-busy', 'true');
        for (const control of [elements.trashPrevious, elements.trashNext, elements.trashPageSize, elements.restoreResults, elements.emptyTrash]) control.disabled = true;
        return;
      }
      const serverTotal = state.query ? data.resultEventCount : data.totalEventCount;
      const paged = data.serverPaged
        ? { items: data.results, page: state.page, pageCount: Math.max(1, Math.ceil(serverTotal / state.pageSize)), total: serverTotal }
        : paginateResults(data.results, state.page, state.pageSize);
      state.page = data.serverPaged ? Math.min(paged.pageCount, Math.max(1, state.page))
        : resolveRenderPage({ ...data, query: state.query, page: state.page }, data.results.length, state.pageSize); elements.trashPageSize.value = String(state.pageSize);
      elements.trashList.replaceChildren(); elements.trashList.setAttribute('aria-busy', 'false');
      if (!paged.total) elements.trashList.append(makeStateNode('empty-state', t(state.query ? 'trashNoMatchTitle' : 'trashEmptyTitle'), t(state.query ? 'trashNoMatchBody' : 'trashEmptyBody')));
      else for (const result of paged.items) elements.trashList.append(renderTrashEvent(result));
      elements.trashSummary.textContent = t(state.query ? 'searchSummary' : 'resultSummary', {
        events: state.query ? data.resultEventCount : data.totalEventCount, tabs: state.query ? getResultSelection(data.results).tabCount : data.totalTabCount,
      });
      elements.restoreResults.textContent = state.query.trim()
        ? t('restoreSearchResults', { count: data.resultEventCount })
        : t('restoreResults');
      elements.trashPageSummary.textContent = t('pageSummary', { page: paged.page, pages: paged.pageCount });
      const pending = state.actionPending.size > 0;
      elements.trashPrevious.disabled = pending || paged.page <= 1; elements.trashNext.disabled = pending || paged.page >= paged.pageCount;
      elements.trashPageSize.disabled = pending; elements.restoreResults.disabled = pending || !data.resultEventCount; elements.emptyTrash.disabled = pending || !data.totalEventCount;
    }

    function clearDestructiveConfirmation(options = {}) {
      const pending = state.pendingDestructiveAction;
      state.pendingDestructiveAction = null;
      elements.historyRemovePanel.hidden = true; elements.trashEmptyPanel.hidden = true;
      if (options.restoreFocus && pending) (pending.kind === 'history' ? elements.removeHistory : elements.emptyTrash).focus();
    }

    async function showHistoryRemovalConfirmation() {
      if (!currentResource('history')) return;
      const data = state.history; const query = state.query.trim();
      const groups = state.historyLayout === 'domain' ? data.domainGroups : [];
      const selected = groups.find((group) => group.key === state.selectedDomain);
      const scoped = selected ? {
        eventIds: data.domainEventIds,
        eventCount: data.selectedDomainEventCount,
        tabCount: data.selectedDomainTabCount,
      } : null;
      const domainLabel = selected ? (selected.key === '__multiple_domains__' ? t('multipleDomains') : (selected.key === '__unknown_domain__' ? t('unknownDomain') : selected.label)) : '';
      const eventCount = scoped ? scoped.eventCount : (query ? data.resultEventCount : data.totalEventCount);
      if (!eventCount) return;
      const requestToken = data.token;
      const request = scoped
        ? { type: 'prepare-destructive-action', operation: 'delete-history', eventIds: scoped.eventIds }
        : { type: 'prepare-destructive-action', operation: 'delete-history', all: true, query };
      if (!beginAction(state.actionPending, 'prepare:history-removal')) return;
      clearDestructiveConfirmation(); renderHistory();
      try {
        const prepared = await sendMessage(request);
        if (!currentResource('history') || requestToken !== data.token || query !== state.query.trim()) return;
        state.pendingDestructiveAction = { kind: 'history', token: prepared.token };
        elements.historyRemoveMessage.textContent = t(scoped ? 'confirmRemoveDomain' : (query ? 'confirmRemoveSearch' : 'confirmRemoveHistory'), {
          events: prepared.eventCount, tabs: prepared.tabCount, domain: domainLabel,
        });
        elements.historyRemovePanel.hidden = false; elements.confirmHistoryRemove.focus();
      } catch (error) {
        showStatus(errorMessage(error), true);
      } finally {
        endAction(state.actionPending, 'prepare:history-removal');
        if (state.view === 'history') renderHistory();
      }
    }

    async function showTrashEmptyConfirmation() {
      if (!currentResource('trash') || !state.trash.totalEventCount) return;
      const requestToken = state.trash.token;
      if (!beginAction(state.actionPending, 'prepare:empty-trash')) return;
      clearDestructiveConfirmation(); renderTrash();
      try {
        const prepared = await sendMessage({ type: 'prepare-destructive-action', operation: 'empty-trash' });
        if (!currentResource('trash') || requestToken !== state.trash.token) return;
        state.pendingDestructiveAction = { kind: 'trash', token: prepared.token };
        elements.trashEmptyMessage.textContent = t('confirmEmptyTrash', { events: prepared.eventCount, tabs: prepared.tabCount });
        elements.trashEmptyPanel.hidden = false; elements.confirmEmptyTrash.focus();
      } catch (error) {
        showStatus(errorMessage(error), true);
      } finally {
        endAction(state.actionPending, 'prepare:empty-trash');
        if (state.view === 'trash') renderTrash();
      }
    }

    function syncSettings(settings) {
      if (!settings) return;
      state.language = settings.language === 'zh' ? 'zh' : 'en';
      state.theme = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
      for (const name of ['maxRecords', 'maxAgeDays', 'trashMaxAgeDays']) {
        const input = elements.settingsForm.elements[name];
        if (input) input.value = settings[name] === null || settings[name] === undefined ? '' : String(settings[name]);
      }
      for (const name of ['popupSize', 'language', 'theme']) {
        const input = elements.settingsForm.elements[name];
        if (input) input.value = String(name === 'popupSize' && settings[name] === undefined ? 10 : settings[name]);
      }
      const excludedInput = elements.settingsForm.elements.excludedDomains;
      if (excludedInput) excludedInput.value = Array.isArray(settings.excludedDomains) ? settings.excludedDomains.join('\n') : '';
      localize();
    }

    function applySettingsWriteAccess() {
      const readOnly = state.mode === 'incognito';
      if (readOnly) {
        elements.settingsForm.querySelectorAll('input, select, textarea, button')
          .forEach((control) => { control.disabled = true; });
        clearSettingsImpact();
      } else {
        elements.settingsForm.querySelectorAll('input, select, textarea')
          .forEach((control) => { control.disabled = false; });
      }
      elements.saveSettings.disabled = readOnly;
      return readOnly;
    }

    async function refreshHistory() {
      const data = state.history; const token = ++data.token;
      const requestedQuery = state.query;
      data.loading = true; data.loadedQuery = null; data.query = requestedQuery;
      elements.retry.hidden = true;
      elements.list.setAttribute('aria-busy', 'true');
      renderHistory();
      try {
        const requestOffset = (state.page - 1) * state.pageSize;
        const request = state.historyLayout === 'domain'
          ? {
            type: 'get-history-by-domain', query: requestedQuery,
            domain: state.selectedDomain, offset: requestOffset, limit: state.pageSize,
          }
          : { type: 'get-history', query: requestedQuery, offset: requestOffset, limit: state.pageSize };
        const response = await sendMessage(request);
        if (token !== data.token) return { ok: false, stale: true };
        data.loading = false; data.loadedQuery = requestedQuery; state.expanded = new Map();
        state.mode = response.mode === 'incognito' ? 'incognito' : 'normal';
        data.results = Array.isArray(response.results) ? response.results : [];
        data.serverPaged = Boolean(response.pagination);
        data.domainGroups = Array.isArray(response.groups) ? response.groups : [];
        data.domainEventIds = Array.isArray(response.eventIds) ? response.eventIds : [];
        if (state.historyLayout === 'domain') state.selectedDomain = response.selectedDomain || null;
        const counts = readStatistics(response, data.results);
        data.resultEventCount = counts.matchingRecords; data.matchedTabCount = counts.matchingTabs;
        data.resultTabCount = counts.resultTabs; data.totalEventCount = counts.totalRecords;
        data.totalTabCount = counts.totalTabs; data.displayedRecords = counts.displayedRecords; data.revision = counts.revision;
        data.selectedDomainEventCount = Math.max(0, Number(response.statistics && response.statistics.selectedRecords) || 0);
        data.selectedDomainTabCount = Math.max(0, Number(response.statistics && response.statistics.selectedTabs) || 0);
        const matchingTotal = state.historyLayout === 'domain'
          ? data.selectedDomainEventCount
          : (requestedQuery.trim() ? data.resultEventCount : data.totalEventCount);
        const maxPage = Math.max(1, Math.ceil(matchingTotal / state.pageSize));
        if (data.serverPaged && state.page > maxPage) {
          state.page = maxPage; updateUrl('replaceState'); return refreshHistory();
        }
        syncSettings(response.settings); if (state.view === 'history') { if (state.statusError) showStatus(''); renderHistory(); } return { ok: true };
      } catch (error) {
        if (token === data.token) { data.loading = false; data.loadedQuery = null; if (state.view === 'history') showError(error); }
        return { ok: false, error };
      }
    }

    async function refreshTrash() {
      const data = state.trash; const token = ++data.token; const requestedQuery = state.query;
      data.loading = true; data.loadedQuery = null; data.query = requestedQuery; elements.retry.hidden = true; renderTrash();
      try {
        const response = await sendMessage({
          type: 'get-trash', query: requestedQuery,
          offset: (state.page - 1) * state.pageSize, limit: state.pageSize,
        });
        if (token !== data.token) return { ok: false, stale: true };
        data.loading = false; data.loadedQuery = requestedQuery; data.serverPaged = Boolean(response.pagination); state.expanded = new Map();
        state.mode = response.mode === 'incognito' ? 'incognito' : 'normal'; data.results = sortTrashResults(response.results);
        const counts = readStatistics(response, data.results);
        data.resultEventCount = counts.matchingRecords; data.matchedTabCount = counts.matchingTabs;
        data.resultTabCount = counts.resultTabs; data.totalEventCount = counts.totalRecords;
        data.totalTabCount = counts.totalTabs; data.displayedRecords = counts.displayedRecords; data.revision = counts.revision;
        const matchingTotal = requestedQuery.trim() ? data.resultEventCount : data.totalEventCount;
        const maxPage = Math.max(1, Math.ceil(matchingTotal / state.pageSize));
        if (data.serverPaged && state.page > maxPage) {
          state.page = maxPage; updateUrl('replaceState'); return refreshTrash();
        }
        syncSettings(response.settings); if (state.view === 'trash') { if (state.statusError) showStatus(''); renderTrash(); } return { ok: true };
      } catch (error) {
        if (token === data.token) { data.loading = false; data.loadedQuery = null; if (state.view === 'trash') { const message = errorMessage(error); showStatus(message, true); elements.retry.hidden = false; elements.trashList.replaceChildren(makeStateNode('error-state', message, message)); } }
        return { ok: false, error };
      }
    }

    function clearSettingsErrors() {
      for (const name of ['maxRecords', 'maxAgeDays', 'trashMaxAgeDays', 'popupSize', 'excludedDomains']) {
        const input = elements.settingsForm.elements[name]; const error = doc.getElementById(`${name}Error`);
        if (input) {
          input.removeAttribute('aria-invalid');
          if (typeof input.setCustomValidity === 'function') input.setCustomValidity('');
        }
        if (error) error.textContent = '';
      }
    }

    function clearSettingsFieldError(event) {
      const input = event && event.target;
      if (!input || !input.name) return;
      const error = doc.getElementById(`${input.name}Error`);
      input.removeAttribute('aria-invalid');
      if (typeof input.setCustomValidity === 'function') input.setCustomValidity('');
      if (error) error.textContent = '';
    }

    function clearSettingsImpact() {
      state.pendingSettingsConfirmation = null;
      elements.settingsImpactPanel.hidden = true;
      elements.saveSettings.hidden = false;
      elements.settingsImpactMessage.textContent = '';
      elements.confirmSettings.disabled = true;
      elements.confirmSettingsAndRemove.hidden = true;
    }

    function showSettingsImpact(settings, impact, token) {
      const counts = getImpactCounts(impact);
      const retention = getImpactCounts(impact && (impact.retention || impact));
      const exclusions = getImpactCounts(impact && impact.exclusions);
      const hasRetention = retention.totalEvents > 0; const hasExclusions = exclusions.totalEvents > 0;
      state.pendingSettingsConfirmation = { settings: { ...settings }, impact, hasRetention, hasExclusions, token };
      const messages = [];
      messages.push(t('settingsScope'));
      if (hasRetention) messages.push(t('settingsImpactWarning', retention));
      if (hasExclusions) messages.push(t('exclusionImpactWarning', { events: exclusions.totalEvents, tabs: exclusions.historyTabs + exclusions.trashTabs }));
      elements.settingsImpactMessage.textContent = messages.join(' ');
      elements.settingsImpactPanel.hidden = false;
      elements.saveSettings.hidden = true;
      elements.confirmSettings.textContent = t(hasExclusions ? (hasRetention ? 'saveRetentionOnly' : 'saveRulesOnly') : 'confirmAndSave');
      elements.confirmSettings.disabled = false; elements.confirmSettingsAndRemove.hidden = !hasExclusions;
      if (hasExclusions) elements.confirmSettingsAndRemove.textContent = t(hasRetention ? 'saveAndRemoveAll' : 'saveAndRemove');
    }

    function showSettingsErrors(fields) {
      clearSettingsErrors(); let first = null;
      for (const [name, message] of Object.entries(fields || {})) {
        const input = elements.settingsForm.elements[name]; const error = doc.getElementById(`${name}Error`);
        if (!input || !error) continue;
        const localizedMessage = t(name === 'popupSize' ? 'invalidPopupSize' : (name === 'excludedDomains' ? 'invalidExcludedDomains' : 'invalidOptional'));
        input.setAttribute('aria-invalid', 'true');
        if (typeof input.setCustomValidity === 'function') input.setCustomValidity(localizedMessage);
        error.textContent = localizedMessage;
        if (!first) first = input;
      }
      if (first) first.focus();
    }

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
      progressNode.value = Math.min(1, Math.max(0, Number(pool.usageRatio) || 0));
    }

    function renderStorageHealth(health) {
      state.storageHealth = health && typeof health === 'object' ? health : null;
      const level = state.storageHealth && ['normal', 'elevated', 'warning', 'critical'].includes(state.storageHealth.level)
        ? state.storageHealth.level : 'unknown';
      elements.storageHealthPanel.dataset.level = level;
      elements.storageHealthStatus.textContent = t(`storage${level.charAt(0).toUpperCase()}${level.slice(1)}`);
      const pools = (state.storageHealth && state.storageHealth.pools) || {};
      renderStoragePool(pools.regularRecords, elements.regularStorageValue, elements.regularStorageProgress);
      renderStoragePool(pools.localData, elements.localStorageValue, elements.localStorageProgress);
      elements.storageWriteWarning.hidden = !(state.storageHealth && state.storageHealth.lastWriteFailure);
      elements.storageWriteWarning.textContent = t('storageWriteWarning');
    }

    async function refreshStorageHealth() {
      const token = ++state.storageHealthRequestToken;
      try {
        const health = await sendMessage({ type: 'get-storage-health' });
        if (token === state.storageHealthRequestToken && state.view === 'settings') renderStorageHealth(health);
      } catch (_) {
        if (token === state.storageHealthRequestToken && state.view === 'settings') renderStorageHealth(null);
      }
    }

    async function refreshSettings() {
      const token = ++state.settingsRequestToken; clearSettingsImpact(); elements.settingsForm.setAttribute('aria-busy', 'true'); elements.saveSettings.disabled = true;
      elements.settingsSummary.textContent = t('settingsLoading');
      refreshStorageHealth();
      try {
        const response = await sendMessage({ type: 'get-settings' }); if (token !== state.settingsRequestToken || state.view !== 'settings') return;
        state.mode = response.mode === 'incognito' ? 'incognito' : 'normal'; syncSettings(response.settings); clearSettingsErrors();
        elements.settingsForm.setAttribute('aria-busy', 'false');
        const readOnly = applySettingsWriteAccess();
        elements.settingsSummary.textContent = t(readOnly ? 'settingsReadOnlyIncognito' : 'settingsIntro');
      } catch (error) { if (token === state.settingsRequestToken && state.view === 'settings') { const message = errorMessage(error); elements.settingsForm.setAttribute('aria-busy', 'false'); elements.settingsSummary.textContent = message; showStatus(message, true); } }
    }

    async function mutateTrash(message, successKey, actionKey, switchToHistory = false) {
      if (!currentResource('trash') || !beginAction(state.actionPending, actionKey)) return; renderTrash();
      try {
        const response = await sendMessage(message); const success = t(successKey, { count: response.restored || response.deleted || 0 });
        if (switchToHistory) {
          switchView('history', { refresh: false }); const refreshed = await refreshHistory();
          if (!refreshed.ok) { showStatus(t('restoreRefreshFailed'), true); elements.retry.hidden = false; } else showStatus(success);
        } else if (state.view === 'trash') { await refreshTrash(); showStatus(success); } else { state.trash.loadedQuery = null; }
      } catch (error) {
        if (state.view === 'trash' || switchToHistory) showStatus(error.code === 'INSUFFICIENT_CAPACITY' ? t('capacityError', { count: error.requiredSlots || 0 }) : errorMessage(error), true);
      } finally { endAction(state.actionPending, actionKey); if (state.view === 'trash') renderTrash(); else if (state.view === 'history') renderHistory(); }
    }

    async function mutate(message, successKey, actionKey) {
      if (!currentResource('history') || !beginAction(state.actionPending, actionKey)) return;
      renderHistory();
      try {
        const response = await sendMessage(message);
        const failures = Array.isArray(response.failures) ? response.failures.length : 0;
        const statusKey = successKey === 'reopened' && failures > 0 ? 'partialReopen' : successKey;
        if (state.view === 'history') {
          const feedback = t(statusKey, { count: response.moved || response.reopened || response.deleted || 0, failed: failures });
          if (['move-to-trash', 'permanently-delete-history', 'commit-destructive-action'].includes(message.type)) await refreshHistory();
          if (state.view === 'history') showStatus(feedback);
        }
        else if (['move-to-trash', 'permanently-delete-history', 'commit-destructive-action'].includes(message.type)) state.history.loadedQuery = null;
      } catch (error) { if (state.view === 'history') showStatus(errorMessage(error), true); }
      finally { endAction(state.actionPending, actionKey); if (state.view === 'history') renderHistory(); else if (state.view === 'trash') renderTrash(); }
    }

    elements.nav.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-view]');
      if (button) switchView(button.dataset.view);
    });
    elements.historyLayoutToggle.addEventListener('click', (event) => {
      const button = event.target.closest('[data-history-layout]');
      if (!button || !['list', 'domain'].includes(button.dataset.historyLayout)) return;
      clearDestructiveConfirmation();
      state.historyLayout = button.dataset.historyLayout; state.page = 1; persistView();
      refreshHistory().then((result) => {
        if (state.historyLayout === 'domain' && result && result.ok) focusSelectedDomain();
      });
    });
    function focusSelectedDomain() {
      const buttons = Array.from(elements.domainIndex.querySelectorAll('[data-action="select-domain"]'));
      const selected = buttons.find((button) => button.dataset.domainKey === state.selectedDomain);
      if (!selected) return;
      selected.focus();
      selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function selectDomain(domainKey, options = {}) {
      if (!domainKey || domainKey === state.selectedDomain) return;
      clearDestructiveConfirmation(); state.selectedDomain = domainKey; state.page = 1;
      const buttons = Array.from(elements.domainIndex.querySelectorAll('[data-action="select-domain"]'));
      buttons.forEach((button) => { button.tabIndex = button.dataset.domainKey === domainKey ? 0 : -1; });
      const selected = buttons.find((button) => button.dataset.domainKey === domainKey);
      if (options.focus && selected) {
        selected.focus();
        selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      updateUrl();
      refreshHistory().then((result) => {
        if (options.focus && result && result.ok) focusSelectedDomain();
      });
    }
    elements.domainIndex.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="select-domain"]');
      if (button) selectDomain(button.dataset.domainKey);
    });
    elements.domainIndex.addEventListener('keydown', (event) => {
      const direction = event.key === 'ArrowDown' ? 1 : (event.key === 'ArrowUp' ? -1 : 0);
      if (!direction) return;
      const button = event.target.closest('[data-action="select-domain"]');
      if (!button) return;
      const buttons = Array.from(elements.domainIndex.querySelectorAll('[data-action="select-domain"]'));
      const nextIndex = resolveAdjacentIndex(
        buttons.indexOf(button), buttons.length, direction,
      );
      if (nextIndex === null) return;
      event.preventDefault();
      selectDomain(buttons[nextIndex].dataset.domainKey, { focus: true });
    });
    elements.search.addEventListener('input', () => {
      clearDestructiveConfirmation();
      state.query = elements.search.value; state.page = 1; const data = state.view === 'trash' ? state.trash : state.history;
      data.token += 1; data.loading = true; data.loadedQuery = null; data.query = state.query; updateUrl('replaceState');
      if (state.view === 'history') renderHistory(); else if (state.view === 'trash') renderTrash();
      root.clearTimeout(state.debounceTimer);
      state.debounceTimer = root.setTimeout(() => { if (state.view === 'history') refreshHistory(); else if (state.view === 'trash') refreshTrash(); }, 180);
    });
    elements.pageSize.addEventListener('change', () => { state.pageSize = Number(elements.pageSize.value); state.page = 1; updateUrl(); refreshHistory(); });
    elements.previous.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; updateUrl(); refreshHistory(); } });
    elements.next.addEventListener('click', () => {
      if (state.history.serverPaged) {
        const total = state.historyLayout === 'domain'
          ? state.history.selectedDomainEventCount
          : (state.query ? state.history.resultEventCount : state.history.totalEventCount);
        if (state.page < Math.max(1, Math.ceil(total / state.pageSize))) { state.page += 1; updateUrl(); refreshHistory(); }
        return;
      }
      const max = paginateResults(state.history.results, state.page, state.pageSize).pageCount;
      if (state.page < max) { state.page += 1; updateUrl(); renderHistory(); }
    });
    function handleHistoryListClick(event) {
      const button = event.target.closest('button[data-action]'); if (!button) return;
      const eventId = button.dataset.eventId;
      if (button.dataset.action === 'toggle') {
        state.expanded.set(eventId, !isGroupExpanded(state.expanded, eventId, state.query)); renderHistory();
      } else if (button.dataset.action === 'reopen-event') {
        if (!currentResource('history')) return;
        mutate({ type: 'reopen-event', eventId }, 'reopened', `reopen:${eventId}`);
      } else if (button.dataset.action === 'reopen-tab') {
        if (!currentResource('history')) return;
        mutate({ type: 'reopen-tab', eventId, tabId: button.dataset.tabId }, 'reopened', `reopen:${eventId}:${button.dataset.tabId}`);
      } else if (button.dataset.action === 'move-event') {
        if (!currentResource('history')) return;
        mutate({ type: 'move-to-trash', eventIds: [eventId] }, 'moved', `move:${eventId}`);
      } else if (button.dataset.action === 'delete-history') {
        if (!currentResource('history')) return;
        mutate({ type: 'permanently-delete-history', eventIds: [eventId] }, 'permanentlyDeleted', `delete-history:${eventId}`);
      }
    }
    elements.list.addEventListener('click', handleHistoryListClick);
    elements.domainList.addEventListener('click', handleHistoryListClick);
    elements.trashList.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]'); if (!button) return; const eventId = button.dataset.eventId;
      if (button.dataset.action === 'toggle-trash') { state.expanded.set(eventId, !isGroupExpanded(state.expanded, eventId, state.query)); renderTrash(); }
      else if (button.dataset.action === 'restore-trash') mutateTrash({ type: 'restore-trash', trashIds: [eventId] }, 'restoredEntries', `restore:${eventId}`, true);
      else if (button.dataset.action === 'delete-trash') { elements.trashList.focus(); mutateTrash({ type: 'permanently-delete-trash', trashIds: [eventId] }, 'permanentlyDeleted', `delete:${eventId}`); }
    });
    elements.restoreResults.addEventListener('click', () => {
      if (!currentResource('trash') || !state.trash.resultEventCount) return;
      mutateTrash({ type: 'restore-trash-results', query: state.query }, 'restoredEntries', 'restore:results', true);
    });
    elements.emptyTrash.addEventListener('click', showTrashEmptyConfirmation);
    elements.confirmEmptyTrash.addEventListener('click', () => {
      const pending = state.pendingDestructiveAction;
      if (!pending || pending.kind !== 'trash') return;
      clearDestructiveConfirmation(); mutateTrash({ type: 'commit-destructive-action', token: pending.token }, 'emptiedTrash', 'empty:trash');
    });
    elements.cancelEmptyTrash.addEventListener('click', () => clearDestructiveConfirmation({ restoreFocus: true }));
    elements.trashPageSize.addEventListener('change', () => { state.pageSize = Number(elements.trashPageSize.value); state.page = 1; updateUrl(); refreshTrash(); });
    elements.trashPrevious.addEventListener('click', () => { if (state.page > 1) { state.page -= 1; updateUrl(); refreshTrash(); } });
    elements.trashNext.addEventListener('click', () => { const total = state.query ? state.trash.resultEventCount : state.trash.totalEventCount; const max = Math.max(1, Math.ceil(total / state.pageSize)); if (state.page < max) { state.page += 1; updateUrl(); refreshTrash(); } });
    elements.moveHistory.addEventListener('click', () => {
      if (!currentResource('history')) return;
      if (state.historyLayout === 'domain') {
        const selection = { eventIds: state.history.domainEventIds };
        if (selection.eventIds.length) mutate({ type: 'move-to-trash', eventIds: selection.eventIds }, 'moved', 'move:domain');
        return;
      }
      if (!state.query.trim()) {
        mutate({ type: 'move-to-trash', all: true }, 'moved', 'move:all');
        return;
      }
      mutate({ type: 'move-to-trash', all: true, query: state.query }, 'moved', 'move:results');
    });
    elements.removeHistory.addEventListener('click', showHistoryRemovalConfirmation);
    elements.confirmHistoryRemove.addEventListener('click', () => {
      const pending = state.pendingDestructiveAction; if (!pending || pending.kind !== 'history') return;
      clearDestructiveConfirmation();
      mutate({ type: 'commit-destructive-action', token: pending.token }, 'permanentlyDeleted', 'remove:results');
    });
    elements.cancelHistoryRemove.addEventListener('click', () => clearDestructiveConfirmation({ restoreFocus: true }));
    async function saveSettings(settings, options = {}) {
      if (!beginAction(state.actionPending, 'save:settings')) return; const token = ++state.settingsRequestToken;
      elements.saveSettings.disabled = true; elements.confirmSettings.disabled = true; clearSettingsErrors();
      try {
        const saved = options.token
          ? await sendMessage({ type: 'commit-destructive-action', token: options.token, removeExistingExcludedMatches: options.removeExistingExcludedMatches === true })
          : await sendMessage({ type: 'save-settings', settings });
        if (token !== state.settingsRequestToken || state.view !== 'settings') return; clearSettingsImpact(); syncSettings(saved.settings);
        let message = t(saved.cleanupPending ? 'settingsCleanupPending' : 'settingsSaved'); if (saved.otherContextPending) message += t('settingsOtherPending');
        elements.settingsSummary.textContent = message; showStatus(message); refreshStorageHealth();
      } catch (error) {
        if (token === state.settingsRequestToken && state.view === 'settings') { if (error.code === 'INVALID_SETTINGS' && error.fields) showSettingsErrors(error.fields); else showStatus(errorMessage(error), true); }
      } finally { endAction(state.actionPending, 'save:settings'); if (token === state.settingsRequestToken && state.view === 'settings') { elements.saveSettings.disabled = false; elements.confirmSettings.disabled = !state.pendingSettingsConfirmation; } }
    }

    elements.settingsForm.addEventListener('submit', async (event) => {
      event.preventDefault(); if (!beginAction(state.actionPending, 'preview:settings')) return; const token = ++state.settingsRequestToken;
      elements.saveSettings.disabled = true; clearSettingsImpact(); clearSettingsErrors();
      const values = {}; for (const name of ['maxRecords', 'maxAgeDays', 'trashMaxAgeDays']) values[name] = elements.settingsForm.elements[name].value;
      const settings = buildRetentionPatch(values);
      for (const name of ['popupSize', 'language', 'theme']) {
        const input = elements.settingsForm.elements[name];
        if (input) settings[name] = name === 'popupSize' ? Number(input.value) : input.value;
      }
      const excludedInput = elements.settingsForm.elements.excludedDomains;
      if (excludedInput) settings.excludedDomains = parseExcludedDomainsInput(excludedInput.value);
      try {
        const preview = await sendMessage({ type: 'preview-settings-impact', settings });
        if (token !== state.settingsRequestToken || state.view !== 'settings') return;
        const normalizedSettings = preview.settings || settings;
        if (getImpactCounts(preview.impact).totalEvents > 0) {
          if (!preview.token) throw Object.assign(new Error('Missing destructive settings token.'), { code: 'ACTION_TOKEN_INVALID' });
          showSettingsImpact(normalizedSettings, preview.impact, preview.token);
        }
        else await saveSettings(normalizedSettings);
      } catch (error) {
        if (token === state.settingsRequestToken && state.view === 'settings') { if (error.code === 'INVALID_SETTINGS' && error.fields) showSettingsErrors(error.fields); else showStatus(errorMessage(error), true); }
      } finally { endAction(state.actionPending, 'preview:settings'); if (token === state.settingsRequestToken && state.view === 'settings') elements.saveSettings.disabled = false; }
    });
    elements.settingsForm.addEventListener('input', (event) => { clearSettingsImpact(); clearSettingsFieldError(event); });
    elements.settingsForm.addEventListener('change', clearSettingsImpact);
    elements.confirmSettings.addEventListener('click', async () => {
      const pending = state.pendingSettingsConfirmation; if (!pending) return; await saveSettings(pending.settings, { token: pending.token, removeExistingExcludedMatches: false });
    });
    elements.confirmSettingsAndRemove.addEventListener('click', async () => {
      const pending = state.pendingSettingsConfirmation; if (!pending || !pending.hasExclusions) return; await saveSettings(pending.settings, { token: pending.token, removeExistingExcludedMatches: true });
    });
    elements.cancelSettingsImpact.addEventListener('click', clearSettingsImpact);
    elements.retry.addEventListener('click', () => { if (state.view === 'history') refreshHistory(); else if (state.view === 'trash') refreshTrash(); else refreshSettings(); });
    doc.addEventListener('keydown', (event) => {
      if (event.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) { event.preventDefault(); elements.search.focus(); }
      if (event.key === 'Escape' && state.pendingDestructiveAction) { clearDestructiveConfirmation({ restoreFocus: true }); return; }
      if (event.key === 'Escape' && elements.search.value) { elements.search.value = ''; elements.search.dispatchEvent(new Event('input')); }
    });
    root.addEventListener('popstate', () => {
      const next = parseUrlState(root.location.search); Object.assign(state, next); elements.search.value = state.query; switchView(state.view, { history: false, persist: false, resetPage: false });
    });
    if (typeof root.setInterval === 'function') {
      root.setInterval(() => {
        if (doc.visibilityState !== undefined && doc.visibilityState !== 'visible') return;
        if (state.view === 'history' && currentResource('history')) renderHistory();
        else if (state.view === 'trash' && currentResource('trash')) renderTrash();
      }, 60 * 1000);
    }

    async function initialize() {
      const params = new URLSearchParams(root.location.search);
      const settingsRequest = sendMessage({ type: 'get-settings' }).catch(() => null);
      try {
        const modeResponse = await sendMessage({ type: 'get-current-mode' });
        state.mode = modeResponse.mode === 'incognito' ? 'incognito' : 'normal';
      } catch (_) { /* The history response will retry mode discovery. */ }
      if (root.chrome.storage && root.chrome.storage.session) {
        try {
          const contextKey = `${UI_STATE_KEY}:${state.mode}`;
          const stored = await root.chrome.storage.session.get(contextKey);
          const savedState = stored && stored[contextKey];
          const savedView = savedState && savedState.view;
          if (!params.has('view') && VIEWS.has(savedView)) state.view = savedView;
          if (savedState && ['list', 'domain'].includes(savedState.historyLayout)) state.historyLayout = savedState.historyLayout;
        } catch (_) { /* UI continuity is optional. */ }
      }
      elements.search.value = state.query; elements.pageSize.value = String(state.pageSize);
      await switchView(state.view, { replace: true, resetPage: false });
      const settingsResponse = await settingsRequest;
      if (!settingsResponse || !settingsResponse.settings) return;
      syncSettings(settingsResponse.settings);
    }
    initialize();
  }

  return {
    appendHighlightedText, beginAction, buildRetentionPatch, buildTabRangeKeys, buildUrlState, endAction, formatStorageBytes, formatStoragePercent, getImpactCounts, getResultSelection,
    isGroupExpanded, isLoadedResultCurrent, paginateResults, parseExcludedDomainsInput, parseUrlState, readStatistics, resolveAdjacentIndex, resolveDomainSelection, resolveRenderPage, start,
    sortTrashResults,
  };
});
