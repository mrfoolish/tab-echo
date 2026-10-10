importScripts(
  'lib/history-store.js',
  'lib/storage-repository.js',
  'lib/indexeddb-repository.js',
  'lib/indexeddb-migration.js',
  'lib/indexeddb-storage-repository.js',
  'lib/close-tracker.js'
);

const {
  buildSearchResults,
  countTabs,
  getRestoreUrls,
  moveEventsToTrash,
  permanentlyDeleteTrashEntries,
  pruneHistoryEntries,
  pruneTrashEntries,
  previewRetentionImpact,
  previewSettingsImpact,
  previewExcludedDomainImpact,
  deleteExcludedDomainMatches,
  getAddedExcludedDomains,
  applySettingsAndOptionalExclusionCleanup,
  filterEventByExcludedDomains,
  restoreTrashEntries,
  searchEvents,
  validateSettingsInput,
} = self.TabEchoHistoryStore;
const { createStorageRepository } = self.TabEchoStorageRepository;
const { createCloseTracker, createTrackerPersistence, isHttpUrl } = self.TabEchoCloseTracker;

const CLOSE_BATCH_DELAY_MS = 450;
const CLEANUP_ALARM_NAME = 'tab-echo-daily-cleanup';
const ACTION_TOKEN_TTL_MS = 5 * 60 * 1000;
const ACTION_TOKEN_LIMIT = 32;
const activeMode = chrome.extension.inIncognitoContext ? 'incognito' : 'normal';
const TRACKER_SESSION_KEY = `tabEcho:close-tracker:${activeMode}:v1`;
const ACTION_TOKENS_KEY = `tabEcho:action-tokens:${activeMode}:v1`;
const STORAGE_FAILURE_KEY = `tabEcho:storage-failure:${activeMode}:v1`;
const localRepository = createStorageRepository(chrome.storage.local);
const indexedDbAvailable = typeof self.indexedDB === 'object'
  && self.TabEchoIndexedDbRepository
  && self.TabEchoIndexedDbStorageRepository;
const indexedDbRecordStore = indexedDbAvailable
  ? self.TabEchoIndexedDbRepository.createIndexedDbRecordStore({
    indexedDB: self.indexedDB,
    IDBKeyRange: self.IDBKeyRange,
  })
  : null;
const repository = indexedDbRecordStore
  ? self.TabEchoIndexedDbStorageRepository.createIndexedDbStorageRepository(
    chrome.storage.local,
    indexedDbRecordStore,
    { legacyRepository: localRepository },
  )
  : localRepository;
const trackerPersistence = createTrackerPersistence(
  chrome.storage.session,
  chrome.storage.local,
  TRACKER_SESSION_KEY,
);
const flushTimers = new Map();
let tracker;
let trackerQueue = Promise.resolve();
let readyPromise = null;

// Initialization starts at module load. Every listener awaits this promise before touching state.
ensureReady().then(ensureCleanupAlarm).catch(reportError);

chrome.runtime.onInstalled.addListener(() => {
  return ensureReady().then(ensureCleanupAlarm).catch(reportError);
});

chrome.runtime.onStartup.addListener(() => {
  return ensureReady().then(ensureCleanupAlarm).catch(reportError);
});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === CLEANUP_ALARM_NAME) {
      return ensureReady().then(cleanupActiveContext).catch(reportError);
    }
    return undefined;
  });
}

chrome.tabs.onCreated.addListener((tab) => {
  enqueueTrackerMutation(async () => {
    tracker.upsertTab(tab);
    await persistTrackerState();
    await commitAllPendingEvents();
  }).catch(reportError);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status || changeInfo.title || changeInfo.url) {
    enqueueTrackerMutation(async () => {
      tracker.upsertTab(tab);
      await persistTrackerState();
      await commitAllPendingEvents();
    }).catch(reportError);
  }
});

chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  enqueueTrackerMutation(async () => {
    tracker.moveTab(tabId, moveInfo);
    await persistTrackerState();
    await commitAllPendingEvents();
  }).catch(reportError);
});

chrome.tabs.onDetached.addListener((tabId, detachInfo) => {
  enqueueTrackerMutation(async () => {
    tracker.detachTab(tabId, detachInfo);
    await persistTrackerState();
    await commitAllPendingEvents();
  }).catch(reportError);
});

chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
  enqueueTrackerMutation(async () => {
    tracker.attachTab(tabId, attachInfo);
    await persistTrackerState();
    await commitAllPendingEvents();
  }).catch(reportError);
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  enqueueTrackerMutation(async () => {
    const result = tracker.removeTab(tabId, removeInfo);
    // Durability boundary: the pending close is in session before a timer is scheduled.
    await persistTrackerState();
    if (!result.ignored && !result.windowClosing) {
      scheduleBatchFlush(result.windowId);
    }
    await commitAllPendingEvents();
  }).catch(reportError);
});

chrome.windows.onRemoved.addListener((windowId) => {
  enqueueTrackerMutation(async () => {
    cancelBatchFlush(windowId);
    const result = tracker.removeWindow(windowId);
    // The full last window snapshot and event outbox are durable before history is touched.
    await persistTrackerState();
    await commitAllPendingEvents();
  }).catch(reportError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((payload) => {
      if (payload && payload.responseOk === false) {
        const { responseOk, ...details } = payload;
        sendResponse({ ok: false, ...details });
        return;
      }
      sendResponse({ ok: true, ...payload });
    })
    .catch(async (error) => {
      await recordStorageWriteFailure(error);
      sendResponse({ ok: false, error: publicError(error) });
    });
  return true;
});

async function initialize() {
  await repository.migrateLegacyState(activeMode);
  const stored = await trackerPersistence.load();
  tracker = createCloseTracker({
    mode: activeMode,
    createId: self.TabEchoHistoryStore.createId,
  }, stored);
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll();
  const liveWindowIds = windows.map((window) => window.id);
  if (trackerPersistence.recoveredAfterSessionLoss()) {
    // A missing session mirror can mean a browser exit or an extension reload.
    // Reconcile individual durable snapshots before live ids can overwrite them.
    tracker.reconcileRecoveredSession(tabs);
  } else {
    tracker.hydrate(tabs);
    tracker.recoverClosedWindows(liveWindowIds);
    tracker.recoverMissingWindows(liveWindowIds);
  }
  await persistTrackerState();

  await commitAllPendingEvents();
  await cleanupActiveContext();
  for (const pending of tracker.getPendingBatches()) {
    if (!pending.windowClosing) {
      scheduleBatchFlush(pending.windowId);
    }
  }
}

async function ensureCleanupAlarm() {
  if (!chrome.alarms || typeof chrome.alarms.create !== 'function') return;
  let alarm = null;
  if (typeof chrome.alarms.get === 'function') {
    try { alarm = await chrome.alarms.get(CLEANUP_ALARM_NAME); } catch (_) { alarm = null; }
  }
  if (!alarm || Number(alarm.periodInMinutes) !== 1440) {
    await chrome.alarms.create(CLEANUP_ALARM_NAME, { periodInMinutes: 1440 });
  }
}

function sameEntries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function finalizeContext(history, trash, settings) {
  return {
    history: pruneHistoryEntries(history, settings),
    trash: pruneTrashEntries(trash, settings),
  };
}

async function cleanupActiveContext() {
  const context = await readRepositoryContext();
  const { history, trash } = finalizeContext(context.history, context.trash, context.settings);
  if (sameEntries(history, context.history) && sameEntries(trash, context.trash)) {
    return { context: { ...context, history, trash }, changed: false };
  }
  const committed = await repository.updateContext(activeMode, (latest) => {
    const finalized = finalizeContext(latest.history, latest.trash, latest.settings);
    return { ...finalized, result: { settings: latest.settings, ...finalized } };
  });
  return { context: committed, changed: true };
}

async function readRepositoryContext() {
  if (typeof repository.readContext === 'function') return repository.readContext(activeMode);
  const [settings, history, trash] = await Promise.all([
    repository.getSettings(), repository.readHistory(activeMode), repository.readTrash(activeMode),
  ]);
  return { settings, history, trash };
}

function enqueueTrackerMutation(operation) {
  const run = trackerQueue.then(async () => {
    await ensureReady();
    return operation();
  });
  trackerQueue = run.catch(() => undefined);
  return run;
}

function ensureReady() {
  if (!readyPromise) {
    const attempt = initialize();
    const guardedAttempt = attempt.catch((error) => {
      if (readyPromise === guardedAttempt) {
        readyPromise = null;
      }
      throw error;
    });
    readyPromise = guardedAttempt;
  }
  return readyPromise;
}

async function persistTrackerState() {
  await trackerPersistence.save(tracker.getState());
}

function scheduleBatchFlush(windowId) {
  cancelBatchFlush(windowId);
  const timer = setTimeout(() => {
    flushTimers.delete(String(windowId));
    enqueueTrackerMutation(() => flushBatch(windowId)).catch(reportError);
  }, CLOSE_BATCH_DELAY_MS);
  flushTimers.set(String(windowId), timer);
}

function cancelBatchFlush(windowId) {
  const key = String(windowId);
  const timer = flushTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(key);
  }
}

async function flushBatch(windowId) {
  const result = tracker.flushBatch(windowId);
  // Persist the removal of the batch and addition to the event outbox atomically.
  await persistTrackerState();
  if (result.event) {
    await commitAllPendingEvents();
  }
}

async function commitAllPendingEvents() {
  for (const entry of tracker.pendingEvents()) {
    await commitPendingEvent(entry);
  }
}

async function commitPendingEvent(entry) {
  if (!entry || !entry.event || entry.event.mode !== activeMode) {
    return;
  }
  const { commitKey, event } = entry;
  await repository.updateContext(activeMode, (context) => {
    const exists = context.history.some((item) => item.batchId === commitKey);
    const filteredEvent = filterEventByExcludedDomains(event, context.settings.excludedDomains);
    const history = exists || !filteredEvent ? context.history : context.history.concat(filteredEvent);
    return finalizeContext(history, context.trash, context.settings);
  });
  tracker.acknowledgeEvent(commitKey);
  await persistTrackerState();
}

async function handleMessage(message) {
  await ensureReady();
  const action = message && (message.type || message.action);
  if (action === 'get-current-mode') {
    return { mode: activeMode };
  }
  if (action === 'get-migration-notice') {
    return { notice: await repository.getMigrationNotice() };
  }
  if (action === 'acknowledge-migration-notice') {
    return { acknowledged: await repository.acknowledgeMigrationNotice(message.id) };
  }
  if (action === 'get-settings') {
    const settings = await repository.getSettings();
    return { mode: activeMode, settings };
  }
  if (action === 'get-storage-health') {
    return getStorageHealth();
  }
  if (action === 'get-state') {
    const context = await readPrunedContext();
    const compatibilityState = { settings: context.settings, events: { [activeMode]: context.history } };
    return {
      mode: activeMode,
      settings: context.settings,
      events: searchEvents(compatibilityState, activeMode, message.query || ''),
    };
  }
  if (action === 'get-history' || action === 'get-trash') {
    if (message.limit !== undefined && typeof repository.queryCollection === 'function') {
      const pagination = normalizeListPagination(message, 1);
      const storeName = action === 'get-history' ? 'history' : 'trash';
      const page = await repository.queryCollection(
        storeName, activeMode, message.query || '', pagination,
      );
      const statistics = {
        revision: page.revision,
        ...page.statistics,
        displayedRecords: page.results.length,
      };
      return {
        mode: activeMode, settings: page.settings, revision: page.revision, statistics,
        totalEventCount: statistics.totalRecords,
        totalTabCount: statistics.totalTabs,
        resultEventCount: statistics.matchingRecords,
        matchedTabCount: statistics.matchingTabs,
        resultTabCount: statistics.resultTabs,
        pagination: {
          offset: pagination.offset,
          limit: pagination.limit,
          hasMore: pagination.offset + page.results.length < statistics.matchingRecords,
        },
        results: page.results,
      };
    }
    const context = await readPrunedContext();
    const source = action === 'get-history'
      ? context.history.slice().sort((a, b) => b.closedAt - a.closedAt)
      : context.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
    const results = buildSearchResults(source, message.query, { deduplicateSingles: false });
    const pagination = normalizeListPagination(message, results.length);
    const displayedResults = results.slice(pagination.offset, pagination.offset + pagination.limit);
    const totalTabCount = countTabs(source);
    const matchedTabCount = results.reduce((sum, item) => sum + item.matchedTabCount, 0);
    const resultTabCount = results.reduce((sum, item) => sum + item.totalTabCount, 0);
    const statistics = {
      revision: context.revision,
      totalRecords: source.length,
      totalTabs: totalTabCount,
      matchingRecords: results.length,
      matchingTabs: matchedTabCount,
      resultTabs: resultTabCount,
      displayedRecords: displayedResults.length,
    };
    return {
      mode: activeMode, settings: context.settings, revision: context.revision, statistics,
      totalEventCount: statistics.totalRecords,
      totalTabCount: statistics.totalTabs,
      resultEventCount: statistics.matchingRecords,
      matchedTabCount: statistics.matchingTabs,
      resultTabCount: statistics.resultTabs,
      pagination: {
        offset: pagination.offset,
        limit: pagination.limit,
        hasMore: pagination.offset + displayedResults.length < results.length,
      },
      results: displayedResults,
    };
  }
  if (action === 'prepare-destructive-action') {
    return prepareDestructiveAction(message);
  }
  if (action === 'commit-destructive-action') {
    return commitDestructiveAction(message);
  }
  if (action === 'move-to-trash') {
    return mutateMoveToTrash(message);
  }
  if (action === 'permanently-delete-history') {
    return repository.updateContext(activeMode, (context) => {
      const current = finalizeContext(context.history, context.trash, context.settings);
      const ids = new Set(selectedEventIds(current.history, message, 'eventIds', false).map(String));
      const history = current.history.filter((event) => !ids.has(String(event.id)));
      return { ...finalizeContext(history, current.trash, context.settings), result: { deleted: current.history.length - history.length } };
    });
  }
  if (action === 'restore-trash' || action === 'restore-trash-results') {
    return mutateRestoreTrash(message, action === 'restore-trash-results');
  }
  if (action === 'permanently-delete-trash') {
    return mutatePermanentDelete(message);
  }
  if (action === 'empty-trash') {
    return repository.updateContext(activeMode, (context) => {
      const current = finalizeContext(context.history, context.trash, context.settings);
      return { ...finalizeContext(current.history, [], context.settings), result: { deleted: current.trash.length } };
    });
  }
  if (action === 'preview-settings-impact') {
    const context = await readRepositoryContext();
    const validation = validateSettingsInput(mergeSettingsPatch(context.settings, message.settings));
    if (!validation.valid) throw protocolError('INVALID_SETTINGS', 'Settings validation failed.', validation.errors);
    const impact = previewSettingsImpact(context.history, context.trash, context.settings, validation.settings);
    const response = { settings: validation.settings, impact };
    if (settingsImpactEventCount(impact) > 0) {
      const prepared = await createActionToken({
        operation: 'save-settings',
        revision: context.revision,
        settingsRevision: context.settingsRevision,
        settings: validation.settings,
      });
      response.token = prepared.token;
      response.expiresAt = prepared.expiresAt;
    }
    return response;
  }
  if (action === 'restore-event') {
    requireScalarId(message.eventId, 'eventId');
    return restoreEvent(message.eventId);
  }
  if (action === 'delete-event' || action === 'delete-events' || action === 'bulk-delete') {
    const ids = action === 'delete-event'
      ? [requireScalarId(message.eventId, 'eventId')]
      : requireNonEmptyIds(message.eventIds, 'eventIds');
    const idSet = new Set(ids.map(String));
    return repository.updateContext(activeMode, (context) => {
      const current = finalizeContext(context.history, context.trash, context.settings);
      const moved = moveEventsToTrash(current.history, current.trash, Array.from(idSet));
      return { ...finalizeContext(moved.history, moved.trash, context.settings), result: { deleted: moved.moved.length } };
    });
  }
  if (action === 'clear-mode') {
    return repository.updateContext(activeMode, (context) => {
      const current = finalizeContext(context.history, context.trash, context.settings);
      const ids = current.history.map((event) => event.id);
      const moved = moveEventsToTrash(current.history, current.trash, ids);
      return { ...finalizeContext(moved.history, moved.trash, context.settings), result: { deleted: moved.moved.length } };
    });
  }
  if (action === 'save-settings') {
    if (message.removeExistingExcludedMatches !== undefined && typeof message.removeExistingExcludedMatches !== 'boolean') {
      throw protocolError('INVALID_REQUEST', 'removeExistingExcludedMatches must be a boolean.');
    }
    const before = await readRepositoryContext();
    const validation = validateSettingsInput(mergeSettingsPatch(before.settings, message.settings));
    if (!validation.valid) throw protocolError('INVALID_SETTINGS', 'Settings validation failed.', validation.errors);
    const impact = previewSettingsImpact(before.history, before.trash, before.settings, validation.settings);
    if (settingsImpactEventCount(impact) > 0) {
      throw protocolError('DESTRUCTIVE_PREVIEW_REQUIRED', 'Preview and confirm this settings change before saving.');
    }
    const settings = await saveSettingsPatchWithRetry(message.settings);
    return { settings, settingsSaved: true, cleanupPending: false, appliedContext: activeMode, otherContextPending: true, removedExcludedTabs: 0 };
  }
  if (action === 'reopen-event') return reopenEvent(message.eventId);
  if (action === 'reopen-tab') return reopenTab(message.eventId, message.tabId);
  if (action === 'open-dashboard') return openDashboard(message);
  throw protocolError('UNKNOWN_MESSAGE', `Unsupported message type: ${String(action || '')}`);
}

function normalizeListPagination(message, resultCount) {
  const source = message && typeof message === 'object' ? message : {};
  const offset = source.offset === undefined ? 0 : Number(source.offset);
  const fallbackLimit = Math.max(1, Number(resultCount) || 0);
  const limit = source.limit === undefined ? fallbackLimit : Number(source.limit);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw protocolError('INVALID_REQUEST', 'offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw protocolError('INVALID_REQUEST', 'limit must be an integer between 1 and 500.');
  }
  return { offset, limit };
}

async function getStorageHealth() {
  const storageArea = chrome.storage && chrome.storage.local;
  const lastWriteFailure = await readLastStorageWriteFailure();
  const localQuotaBytes = Number(storageArea && storageArea.QUOTA_BYTES);
  let localBytesUsed = null;
  if (storageArea && typeof storageArea.getBytesInUse === 'function') {
    try {
      const measured = Number(await storageArea.getBytesInUse(null));
      if (Number.isFinite(measured) && measured >= 0) localBytesUsed = Math.round(measured);
    } catch (_) { /* Fall through to the origin estimate when available. */ }
  }
  let originEstimate = null;
  if (typeof navigator === 'object' && navigator.storage
    && typeof navigator.storage.estimate === 'function') {
    try {
      const estimate = await navigator.storage.estimate();
      const usage = Number(estimate && estimate.usage);
      const quota = Number(estimate && estimate.quota);
      if (Number.isFinite(usage) && usage >= 0 && Number.isFinite(quota) && quota > 0) {
        originEstimate = { usage: Math.round(usage), quota, usageDetails: estimate.usageDetails };
      }
    } catch (_) { /* chrome.storage.local accounting remains a valid fallback. */ }
  }
  const localSupported = localBytesUsed !== null
    && Number.isFinite(localQuotaBytes) && localQuotaBytes > 0;
  if (!originEstimate && !localSupported) {
    return {
      supported: false,
      bytesUsed: null,
      quotaBytes: null,
      usageRatio: null,
      level: 'unknown',
      lastWriteFailure,
    };
  }
  const bytesUsed = originEstimate ? originEstimate.usage : localBytesUsed;
  const quotaBytes = originEstimate ? originEstimate.quota : localQuotaBytes;
  const usageRatio = bytesUsed / quotaBytes;
  const localUsageRatio = localSupported ? localBytesUsed / localQuotaBytes : null;
  const pressureRatio = Math.max(usageRatio, localUsageRatio === null ? 0 : localUsageRatio);
  const level = storagePressureLevel(pressureRatio);
  return {
    supported: true,
    bytesUsed,
    quotaBytes,
    usageRatio,
    level,
    ...(originEstimate ? {
      indexedDbBytes: Number(originEstimate.usageDetails && originEstimate.usageDetails.indexedDB) || 0,
      localBytesUsed,
      localQuotaBytes: localSupported ? localQuotaBytes : null,
      localUsageRatio,
    } : {}),
    lastWriteFailure,
  };
}

function storagePressureLevel(usageRatio) {
  return usageRatio >= 0.95 ? 'critical'
    : usageRatio >= 0.85 ? 'warning'
      : usageRatio >= 0.70 ? 'elevated' : 'normal';
}

async function readLastStorageWriteFailure() {
  const sessionArea = chrome.storage && chrome.storage.session;
  if (!sessionArea || typeof sessionArea.get !== 'function') return null;
  try {
    const stored = await sessionArea.get(STORAGE_FAILURE_KEY);
    const failure = stored && stored[STORAGE_FAILURE_KEY];
    return failure && typeof failure === 'object' && !Array.isArray(failure) ? failure : null;
  } catch (_) {
    return null;
  }
}

async function recordStorageWriteFailure(error) {
  const isWriteFailure = error && (error.code === 'STORAGE_WRITE_FAILED'
    || error.name === 'StorageWriteError');
  const sessionArea = chrome.storage && chrome.storage.session;
  if (!isWriteFailure || !sessionArea || typeof sessionArea.set !== 'function') return;
  const failure = {
    code: 'STORAGE_WRITE_FAILED',
    operation: typeof error.operation === 'string' ? error.operation : null,
    occurredAt: Date.now(),
  };
  try {
    await sessionArea.set({ [STORAGE_FAILURE_KEY]: failure });
  } catch (_) { /* Health reporting must never replace the original storage error. */ }
}

async function readActionTokens(now = Date.now()) {
  const stored = await chrome.storage.session.get(ACTION_TOKENS_KEY);
  const source = stored && stored[ACTION_TOKENS_KEY];
  const entries = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const active = {};
  for (const [token, entry] of Object.entries(entries)) {
    if (entry && typeof entry === 'object' && Number(entry.expiresAt) > now) active[token] = entry;
  }
  return active;
}

async function writeActionTokens(entries) {
  await chrome.storage.session.set({ [ACTION_TOKENS_KEY]: entries });
}

async function createActionToken(entry) {
  const now = Date.now();
  const entries = await readActionTokens(now);
  const token = self.TabEchoHistoryStore.createId('action');
  entries[token] = { ...entry, createdAt: now, expiresAt: now + ACTION_TOKEN_TTL_MS };
  const kept = Object.entries(entries)
    .sort((left, right) => Number(right[1].createdAt) - Number(left[1].createdAt))
    .slice(0, ACTION_TOKEN_LIMIT);
  await writeActionTokens(Object.fromEntries(kept));
  return { token, expiresAt: entries[token].expiresAt };
}

async function consumeActionToken(rawToken) {
  const token = requireScalarId(rawToken, 'token');
  const now = Date.now();
  const stored = await chrome.storage.session.get(ACTION_TOKENS_KEY);
  const source = stored && stored[ACTION_TOKENS_KEY];
  const entries = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const entry = entries[token];
  if (!entry) throw protocolError('ACTION_TOKEN_INVALID', 'This confirmation is no longer valid.');
  delete entries[token];
  const active = {};
  for (const [candidate, value] of Object.entries(entries)) {
    if (value && typeof value === 'object' && Number(value.expiresAt) > now) active[candidate] = value;
  }
  await writeActionTokens(active);
  if (Number(entry.expiresAt) <= now) {
    throw protocolError('ACTION_TOKEN_EXPIRED', 'This confirmation has expired.');
  }
  return entry;
}

async function prepareDestructiveAction(message) {
  await cleanupActiveContext();
  const context = await readRepositoryContext();
  const operation = String(message.operation || '');
  let selected;
  if (operation === 'delete-history') {
    const ids = new Set(selectedEventIds(context.history, message, 'eventIds', false).map(String));
    selected = context.history.filter((event) => ids.has(String(event.id)));
  } else if (operation === 'empty-trash') {
    if (message.eventIds !== undefined || message.all !== undefined || message.query !== undefined) {
      throw protocolError('INVALID_REQUEST', 'Empty Trash does not accept a client-side selection.');
    }
    selected = context.trash.slice();
  } else {
    throw protocolError('INVALID_REQUEST', 'Unsupported destructive operation.');
  }
  if (selected.length === 0) {
    throw protocolError('ACTION_EMPTY', 'There are no records in this action scope.');
  }
  const { token, expiresAt } = await createActionToken({
    operation,
    revision: context.revision,
    eventIds: selected.map((event) => String(event.id)),
  });
  return { token, operation, eventCount: selected.length, tabCount: countTabs(selected), expiresAt };
}

async function commitDestructiveAction(message) {
  if (message.removeExistingExcludedMatches !== undefined
    && typeof message.removeExistingExcludedMatches !== 'boolean') {
    throw protocolError('INVALID_REQUEST', 'removeExistingExcludedMatches must be a boolean.');
  }
  const prepared = await consumeActionToken(message.token);
  if (prepared.operation === 'save-settings') {
    return repository.updateSettingsAndContext(activeMode, (context) => {
      if (context.revision !== prepared.revision || context.settingsRevision !== prepared.settingsRevision) {
        throw protocolError('ACTION_STALE', 'Records or settings changed after confirmation. Nothing was saved or removed.');
      }
      const addedDomains = getAddedExcludedDomains(
        context.settings.excludedDomains,
        prepared.settings.excludedDomains,
      );
      const removeExisting = message.removeExistingExcludedMatches === true;
      const retainedHistory = pruneHistoryEntries(context.history, prepared.settings);
      const retainedTrash = pruneTrashEntries(context.trash, prepared.settings);
      const excludedImpact = removeExisting
        ? previewExcludedDomainImpact(retainedHistory, retainedTrash, addedDomains)
        : { totalTabCount: 0 };
      const cleaned = applySettingsAndOptionalExclusionCleanup(
        context.history,
        context.trash,
        prepared.settings,
        addedDomains,
        removeExisting,
      );
      return {
        settings: prepared.settings,
        ...cleaned,
        result: {
          settings: prepared.settings,
          settingsSaved: true,
          cleanupPending: false,
          appliedContext: activeMode,
          otherContextPending: true,
          removedExcludedTabs: excludedImpact.totalTabCount || 0,
        },
      };
    });
  }
  return repository.updateContext(activeMode, (context) => {
    if (context.revision !== prepared.revision) {
      throw protocolError('ACTION_STALE', 'Records changed after confirmation. Nothing was removed.');
    }
    const ids = new Set(prepared.eventIds.map(String));
    if (prepared.operation === 'delete-history') {
      const history = context.history.filter((event) => !ids.has(String(event.id)));
      return { history, trash: context.trash, result: { deleted: context.history.length - history.length } };
    }
    if (prepared.operation === 'empty-trash') {
      const trash = context.trash.filter((event) => !ids.has(String(event.id)));
      return { history: context.history, trash, result: { deleted: context.trash.length - trash.length } };
    }
    throw protocolError('ACTION_TOKEN_INVALID', 'This confirmation has an unsupported operation.');
  });
}

function settingsImpactEventCount(impact) {
  if (!impact || typeof impact !== 'object') return 0;
  const combined = impact.combined && typeof impact.combined === 'object' ? impact.combined : impact;
  const explicit = Number(combined.totalEventCount);
  if (Number.isFinite(explicit)) return explicit;
  return (Number(combined.historyEventCount) || 0) + (Number(combined.trashEventCount) || 0);
}

async function readPrunedContext() {
  return (await cleanupActiveContext()).context;
}

function selectedEventIds(source, message, idField, deduplicateSingles = false) {
  if (message.all === true) {
    if (message[idField] !== undefined) {
      throw protocolError('INVALID_REQUEST', `Use either ${idField} or all:true, not both.`);
    }
    if (!String(message.query || '').trim()) return source.map((item) => item.id);
    return buildSearchResults(source, message.query, { deduplicateSingles })
      .map((item) => item.event.id);
  }
  if (message.all !== undefined) throw protocolError('INVALID_REQUEST', 'all must be true when provided.');
  return requireNonEmptyIds(message[idField], idField);
}

function mutateMoveToTrash(message) {
  return repository.updateContext(activeMode, (context) => {
    const current = finalizeContext(context.history, context.trash, context.settings);
    const ids = selectedEventIds(current.history, message, 'eventIds', false);
    const moved = moveEventsToTrash(current.history, current.trash, ids);
    return { ...finalizeContext(moved.history, moved.trash, context.settings), result: { moved: moved.moved.length } };
  });
}

async function mutateRestoreTrash(message, queryResults) {
  const snapshot = await readRepositoryContext();
  const current = finalizeContext(snapshot.history, snapshot.trash, snapshot.settings);
  const request = queryResults ? { ...message, all: true } : message;
  const ids = selectedEventIds(current.trash, request, 'trashIds', false);
  const preview = restoreTrashEntries(current.history, current.trash, ids, snapshot.settings);
  if (!preview.ok) return { responseOk: false, error: {
    code: 'INSUFFICIENT_CAPACITY', message: 'Not enough history capacity to restore these entries.',
  }, requiredSlots: preview.requiredSlots };
  try {
    return await repository.updateContext(activeMode, (context) => {
      const latest = finalizeContext(context.history, context.trash, context.settings);
      const latestIds = selectedEventIds(latest.trash, request, 'trashIds', false);
      const restored = restoreTrashEntries(latest.history, latest.trash, latestIds, context.settings);
      if (!restored.ok) throw protocolError('INSUFFICIENT_CAPACITY',
        'Not enough history capacity to restore these entries.', { requiredSlots: restored.requiredSlots });
      const finalized = finalizeContext(restored.history, restored.trash, context.settings);
      return { ...finalized, result: { restored: restored.restored.length, requiredSlots: 0 } };
    });
  } catch (error) {
    if (error && error.code === 'INSUFFICIENT_CAPACITY') return { responseOk: false, error: {
      code: error.code, message: error.message,
    }, requiredSlots: error.fields.requiredSlots };
    throw error;
  }
}

function mutatePermanentDelete(message) {
  return repository.updateContext(activeMode, (context) => {
    const current = finalizeContext(context.history, context.trash, context.settings);
    const ids = selectedEventIds(current.trash, message, 'trashIds', false);
    const deleted = permanentlyDeleteTrashEntries(current.trash, ids);
    return { ...finalizeContext(current.history, deleted.trash, context.settings), result: { deleted: deleted.deletedCount } };
  });
}

function mergeSettingsPatch(current, patch) {
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  return Object.assign({}, current, source);
}

async function saveSettingsPatchWithRetry(patch, attempts = 3) {
  const requested = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const requestedKeys = Object.keys(requested);
  // chrome.storage has no compare-and-swap. Re-read/merge/verify closes typical split-worker
  // interleavings, but another worker can still overwrite settings after this verification.
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const base = await repository.getSettings();
    const validation = validateSettingsInput(mergeSettingsPatch(base, requested));
    if (!validation.valid) throw protocolError('INVALID_SETTINGS', 'Settings validation failed.', validation.errors);
    await repository.saveSettings(validation.settings);
    const verified = await repository.getSettings();
    const stable = Object.keys(base).every((key) => requestedKeys.includes(key)
      ? sameEntries(verified[key], validation.settings[key])
      : sameEntries(verified[key], base[key]));
    if (stable) return verified;
  }
  throw protocolError('SETTINGS_CONFLICT', 'Settings changed concurrently. Please try again.');
}

function requireScalarId(value, field) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw protocolError('INVALID_REQUEST', `${field} is required.`);
  }
  return value;
}

function requireNonEmptyIds(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw protocolError('INVALID_REQUEST', `${field} must be a non-empty array.`);
  }
  for (const id of value) requireScalarId(id, field);
  return value;
}

async function restoreEvent(eventId) {
  const context = await readRepositoryContext();
  const event = context.history.find((item) => item.id === eventId);
  if (!event) {
    throw new Error('Record no longer exists.');
  }
  const urls = getRestoreUrls(event).filter(isHttpUrl);
  if (urls.length === 0) {
    throw new Error('No restorable URLs in this record.');
  }

  const failures = [];
  if (event.kind === 'group') {
    try {
      const createdWindow = await chrome.windows.create({
        url: urls[0],
        incognito: activeMode === 'incognito',
        focused: true,
      });
      for (const url of urls.slice(1)) {
        try {
          await chrome.tabs.create({ url, windowId: createdWindow && createdWindow.id, active: false });
        } catch (error) {
          failures.push(`${url}: ${error.message || String(error)}`);
        }
      }
    } catch (error) {
      for (const url of urls) failures.push(`${url}: ${error.message || String(error)}`);
    }
  } else {
    for (const url of urls) {
      try {
        await chrome.tabs.create({ url, active: true });
      } catch (error) {
        failures.push(`${url}: ${error.message || String(error)}`);
      }
    }
  }
  return { restored: Math.max(0, urls.length - failures.length), failures };
}

async function reopenEvent(eventId) {
  const context = await readRepositoryContext();
  const event = context.history.find((item) => String(item.id) === String(eventId));
  if (!event) throw protocolError('NOT_FOUND', 'Closed-tab entry no longer exists.');
  const urls = getRestoreUrls(event).filter(isHttpUrl);
  if (urls.length === 0) throw protocolError('NO_RESTORABLE_URL', 'No restorable URLs in this entry.');
  if (event.kind !== 'group') return openUrls(urls);
  const opened = [];
  const failures = [];
  let createdWindow;
  try {
    createdWindow = await chrome.windows.create({ url: urls[0], incognito: activeMode === 'incognito', focused: true });
    opened.push({ url: urls[0], windowId: createdWindow && createdWindow.id });
  } catch (error) {
    return { reopened: 0, opened, failures: urls.map((url) => ({ url, message: error && error.message ? error.message : 'Failed to open window.' })), complete: false };
  }
  for (const url of urls.slice(1)) {
    try {
      const tab = await chrome.tabs.create({ url, windowId: createdWindow && createdWindow.id, active: false });
      opened.push({ url, tabId: tab && tab.id });
    } catch (error) {
      failures.push({ url, message: error && error.message ? error.message : 'Failed to open tab.' });
    }
  }
  return { reopened: opened.length, opened, failures, complete: failures.length === 0 };
}

async function reopenTab(eventId, tabId) {
  const context = await readRepositoryContext();
  const event = context.history.find((item) => String(item.id) === String(eventId));
  if (!event) throw protocolError('NOT_FOUND', 'Closed-tab entry no longer exists.');
  const tab = event.tabs.find((item) => String(item.id) === String(tabId));
  if (!tab) throw protocolError('NOT_FOUND', 'Tab no longer exists in this entry.');
  if (!isHttpUrl(tab.url)) throw protocolError('NO_RESTORABLE_URL', 'This tab URL cannot be reopened.');
  return openUrls([tab.url]);
}

async function openUrls(urls) {
  const opened = [];
  const failures = [];
  for (const url of urls) {
    try {
      const tab = await chrome.tabs.create({ url, active: opened.length === 0 });
      opened.push({ url, tabId: tab && tab.id });
    } catch (error) {
      failures.push({ url, message: error && error.message ? error.message : 'Failed to open tab.' });
    }
  }
  return { reopened: opened.length, opened, failures, complete: failures.length === 0 };
}

async function openDashboard(message = {}) {
  const baseUrl = chrome.runtime.getURL('dashboard.html');
  const url = new URL(baseUrl);
  let requestedView = message.view;
  let requestedQuery = message.q !== undefined ? message.q : message.query;
  if (message.url !== undefined) {
    try {
      const requestedUrl = new URL(String(message.url), baseUrl);
      if (requestedView === undefined) requestedView = requestedUrl.searchParams.get('view');
      if (requestedQuery === undefined) requestedQuery = requestedUrl.searchParams.get('q');
    } catch (_) { /* Ignore malformed URL input; target always remains extension-owned. */ }
  }
  if (requestedView !== undefined && requestedView !== null) url.searchParams.set('view', String(requestedView));
  if (requestedQuery !== undefined && requestedQuery !== null) url.searchParams.set('q', String(requestedQuery));
  const target = url.href;
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => {
    if (Boolean(tab.incognito) !== (activeMode === 'incognito')) return false;
    try {
      const candidate = new URL(tab.url);
      return candidate.protocol === url.protocol && candidate.host === url.host && candidate.pathname === url.pathname;
    }
    catch (_) { return false; }
  });
  if (existing) {
    if (typeof chrome.tabs.update === 'function') await chrome.tabs.update(existing.id, { url: target, active: true });
    if (existing.windowId !== undefined && chrome.windows && typeof chrome.windows.update === 'function') {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return { reused: true, tabId: existing.id };
  }
  const created = await chrome.tabs.create({ url: target, active: true });
  return { reused: false, tabId: created && created.id };
}

function protocolError(code, message, fields) {
  const error = new Error(message);
  error.code = code;
  if (fields) error.fields = fields;
  return error;
}

function publicError(error) {
  return {
    code: error && error.code ? error.code : (error && error.name === 'StorageWriteError' ? 'STORAGE_WRITE_FAILED' : 'INTERNAL_ERROR'),
    message: error && error.message ? error.message : 'The operation failed.',
    ...(error && error.fields ? { fields: error.fields } : {}),
  };
}

function reportError(error) {
  void recordStorageWriteFailure(error);
  console.error(error);
}
