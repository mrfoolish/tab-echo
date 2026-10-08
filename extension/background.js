importScripts(
  'lib/history-store.js',
  'lib/storage-repository.js',
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
const activeMode = chrome.extension.inIncognitoContext ? 'incognito' : 'normal';
const TRACKER_SESSION_KEY = `tabEcho:close-tracker:${activeMode}:v1`;
const repository = createStorageRepository(chrome.storage.local);
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
  if (changeInfo.status || changeInfo.title || changeInfo.url || changeInfo.favIconUrl) {
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
    .catch((error) => sendResponse({ ok: false, error: publicError(error) }));
  return true;
});

async function initialize() {
  await repository.migrateLegacyState();
  const stored = await trackerPersistence.load();
  tracker = createCloseTracker({
    mode: activeMode,
    createId: self.TabEchoHistoryStore.createId,
  }, stored);
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll();
  const liveWindowIds = windows.map((window) => window.id);
  if (trackerPersistence.recoveredAfterSessionLoss()) {
    // A missing session mirror means Chrome itself exited. Archive the prior
    // browser session before current windows can reuse its window or tab IDs.
    tracker.recoverClosedWindows([]);
    tracker.recoverMissingWindows([]);
    tracker.hydrate(tabs);
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
    const context = await readPrunedContext();
    const source = action === 'get-history'
      ? context.history.slice().sort((a, b) => b.closedAt - a.closedAt)
      : context.trash.slice().sort((a, b) => b.deletedAt - a.deletedAt);
    const results = buildSearchResults(source, message.query, {
      deduplicateSingles: action === 'get-history' ? message.deduplicateSingles !== false : false,
    });
    return {
      mode: activeMode, settings: context.settings, totalEventCount: source.length,
      totalTabCount: countTabs(source), resultEventCount: results.length,
      matchedTabCount: results.reduce((sum, item) => sum + item.matchedTabCount, 0),
      resultTabCount: results.reduce((sum, item) => sum + item.totalTabCount, 0), results,
    };
  }
  if (action === 'move-to-trash') {
    return mutateMoveToTrash(message);
  }
  if (action === 'permanently-delete-history') {
    return repository.updateContext(activeMode, (context) => {
      const current = finalizeContext(context.history, context.trash, context.settings);
      const ids = new Set(selectedEventIds(current.history, message, 'eventIds', true).map(String));
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
    return { settings: validation.settings, impact: previewSettingsImpact(context.history, context.trash, context.settings, validation.settings) };
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
    const settings = await saveSettingsPatchWithRetry(message.settings);
    const addedDomains = getAddedExcludedDomains(before.settings.excludedDomains, settings.excludedDomains);
    try {
      const applied = await repository.updateContext(activeMode, (context) => {
        const cleaned = applySettingsAndOptionalExclusionCleanup(
          context.history, context.trash, settings, addedDomains, message.removeExistingExcludedMatches === true,
        );
        const excludedImpact = message.removeExistingExcludedMatches === true
          ? previewExcludedDomainImpact(pruneHistoryEntries(context.history, settings), pruneTrashEntries(context.trash, settings), addedDomains)
          : { totalTabCount: 0 };
        return { ...cleaned, result: { removedExcludedTabs: excludedImpact.totalTabCount || 0 } };
      });
      return { settings, settingsSaved: true, cleanupPending: false, appliedContext: activeMode, otherContextPending: true, removedExcludedTabs: applied.removedExcludedTabs };
    } catch (error) {
      reportError(error);
      return { settings, settingsSaved: true, cleanupPending: true, appliedContext: activeMode, otherContextPending: true };
    }
  }
  if (action === 'reopen-event') return reopenEvent(message.eventId);
  if (action === 'reopen-tab') return reopenTab(message.eventId, message.tabId);
  if (action === 'open-dashboard') return openDashboard(message);
  throw protocolError('UNKNOWN_MESSAGE', `Unsupported message type: ${String(action || '')}`);
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
  console.error(error);
}
