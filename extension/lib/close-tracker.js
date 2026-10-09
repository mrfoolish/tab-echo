(function initCloseTracker(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.TabEchoCloseTracker = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  function clone(value) {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function emptyState() {
    return {
      tabSnapshotsById: {},
      windowSnapshotsById: {},
      pendingBatches: {},
      consumedWindowIds: {},
      pendingEventsById: {},
      nextCommitSequence: 1,
    };
  }

  function normalizeState(input) {
    const source = input && typeof input === 'object' ? input : {};
    return {
      tabSnapshotsById: objectCopy(source.tabSnapshotsById),
      windowSnapshotsById: objectCopy(source.windowSnapshotsById),
      pendingBatches: objectCopy(source.pendingBatches),
      consumedWindowIds: objectCopy(source.consumedWindowIds),
      pendingEventsById: objectCopy(source.pendingEventsById),
      nextCommitSequence: Number.isSafeInteger(source.nextCommitSequence)
        ? source.nextCommitSequence
        : 1,
    };
  }

  function objectCopy(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : {};
  }

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || ''));
  }

  function createTrackerPersistence(sessionArea, localArea, key) {
    if (!localArea || typeof localArea.get !== 'function' || typeof localArea.set !== 'function') {
      throw new TypeError('localArea.get and localArea.set are required.');
    }
    let useLocal = !sessionArea
      || typeof sessionArea.get !== 'function'
      || typeof sessionArea.set !== 'function';
    let revision = 0;
    let sessionLossRecovered = false;

    async function read(area) {
      const result = await area.get(key);
      return result && Object.hasOwn(result, key) ? result[key] : undefined;
    }

    async function load() {
      const sessionRead = useLocal
        ? { status: 'rejected', reason: new Error('Session unavailable.') }
        : await Promise.resolve(read(sessionArea)).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason }),
        );
      const localRead = await Promise.resolve(read(localArea)).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      );
      if (sessionRead.status === 'rejected' && localRead.status === 'rejected') {
        throw localRead.reason;
      }
      const sessionValue = sessionRead.status === 'fulfilled' ? sessionRead.value : undefined;
      const localValue = localRead.status === 'fulfilled' ? localRead.value : undefined;
      const sessionRevision = Number.isSafeInteger(sessionValue && sessionValue.revision)
        ? sessionValue.revision : 0;
      const localRevision = Number.isSafeInteger(localValue && localValue.revision)
        ? localValue.revision : 0;
      const chooseLocal = localValue !== undefined
        && (sessionValue === undefined || localRevision > sessionRevision);
      sessionLossRecovered = sessionRead.status === 'fulfilled'
        && sessionValue === undefined
        && localValue !== undefined;
      useLocal = useLocal || sessionRead.status === 'rejected';
      const selected = chooseLocal || useLocal ? localValue : sessionValue;
      revision = Math.max(sessionRevision, localRevision);
      return clone(selected);
    }

    function recoveredAfterSessionLoss() {
      return sessionLossRecovered;
    }

    async function save(value) {
      revision += 1;
      const payload = { [key]: { ...clone(value), revision } };
      // chrome.storage.session is cleared when Chrome exits. Keep the same revision in
      // local storage so a forced exit can recover the last live window snapshots.
      await localArea.set(payload);
      if (!useLocal) {
        try {
          await sessionArea.set(payload);
          return;
        } catch (error) {
          useLocal = true;
        }
      }
      if (sessionArea && typeof sessionArea.remove === 'function') {
        await Promise.resolve(sessionArea.remove(key)).catch(() => undefined);
      }
    }

    return { load, recoveredAfterSessionLoss, save };
  }

  function createCloseTracker(options = {}, initialState) {
    const mode = options.mode === 'incognito' ? 'incognito' : 'normal';
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const consumedWindowTtlMs = Number.isFinite(options.consumedWindowTtlMs)
      ? options.consumedWindowTtlMs
      : 5 * 60 * 1000;
    const createId = typeof options.createId === 'function'
      ? options.createId
      : (prefix) => `${prefix}-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const state = normalizeState(initialState || emptyState());

    function pruneConsumedWindows() {
      const cutoff = now() - consumedWindowTtlMs;
      for (const [windowId, consumedAt] of Object.entries(state.consumedWindowIds)) {
        if (!Number.isFinite(Number(consumedAt)) || Number(consumedAt) < cutoff) {
          delete state.consumedWindowIds[windowId];
        }
      }
    }

    pruneConsumedWindows();

    function getState() {
      pruneConsumedWindows();
      return clone(state);
    }

    function snapshotTab(tab) {
      if (!tab || !Number.isInteger(tab.id) || !isHttpUrl(tab.url)) {
        return null;
      }
      const tabMode = tab.incognito ? 'incognito' : 'normal';
      if (tabMode !== mode) {
        return null;
      }
      return {
        id: String(tab.id),
        title: String(tab.title || tab.url),
        url: String(tab.url),
        position: Number.isInteger(tab.index) ? tab.index : 0,
        sourceWindowId: tab.windowId ?? null,
        mode,
      };
    }

    function ensureWindow(windowId) {
      const key = String(windowId);
      if (!state.windowSnapshotsById[key]) {
        state.windowSnapshotsById[key] = { windowId, mode, tabIds: [], updatedAt: now() };
      }
      return state.windowSnapshotsById[key];
    }

    function sortWindow(windowSnapshot) {
      windowSnapshot.tabIds = Array.from(new Set(windowSnapshot.tabIds.map(String)))
        .filter((id) => state.tabSnapshotsById[id])
        .sort((left, right) => {
          return state.tabSnapshotsById[left].position - state.tabSnapshotsById[right].position;
        });
      windowSnapshot.updatedAt = now();
    }

    function insertIntoWindow(tabId, windowId, position) {
      const windowSnapshot = ensureWindow(windowId);
      windowSnapshot.tabIds = windowSnapshot.tabIds
        .filter((id) => String(id) !== String(tabId) && state.tabSnapshotsById[String(id)]);
      const insertionIndex = Math.max(0, Math.min(
        Number.isInteger(position) ? position : windowSnapshot.tabIds.length,
        windowSnapshot.tabIds.length,
      ));
      windowSnapshot.tabIds.splice(insertionIndex, 0, String(tabId));
      windowSnapshot.tabIds.forEach((id, index) => {
        state.tabSnapshotsById[id].position = index;
      });
      windowSnapshot.updatedAt = now();
    }

    function removeFromWindow(tabId, windowId) {
      const windowSnapshot = state.windowSnapshotsById[String(windowId)];
      if (!windowSnapshot) {
        return;
      }
      windowSnapshot.tabIds = windowSnapshot.tabIds.filter((id) => String(id) !== String(tabId));
      windowSnapshot.tabIds.forEach((id, index) => {
        if (state.tabSnapshotsById[id]) {
          state.tabSnapshotsById[id].position = index;
        }
      });
      windowSnapshot.updatedAt = now();
    }

    function upsertTab(tab) {
      pruneConsumedWindows();
      const snapshot = snapshotTab(tab);
      if (!snapshot) {
        if (tab && Number.isInteger(tab.id)) {
          const previous = state.tabSnapshotsById[String(tab.id)];
          if (previous) {
            removeFromWindow(tab.id, previous.sourceWindowId);
            delete state.tabSnapshotsById[String(tab.id)];
          }
        }
        return { accepted: false, state: getState() };
      }
      const previous = state.tabSnapshotsById[snapshot.id];
      if (previous && previous.sourceWindowId !== snapshot.sourceWindowId) {
        removeFromWindow(snapshot.id, previous.sourceWindowId);
      }
      const existingPosition = previous && previous.sourceWindowId === snapshot.sourceWindowId
        ? previous.position
        : null;
      state.tabSnapshotsById[snapshot.id] = {
        ...snapshot,
        position: existingPosition === null ? snapshot.position : existingPosition,
      };
      if (!previous || previous.sourceWindowId !== snapshot.sourceWindowId) {
        insertIntoWindow(snapshot.id, snapshot.sourceWindowId, snapshot.position);
      }
      delete state.consumedWindowIds[String(snapshot.sourceWindowId)];
      return { accepted: true, state: getState() };
    }

    function hydrate(tabs) {
      pruneConsumedWindows();
      const accepted = [];
      for (const tab of Array.isArray(tabs) ? tabs : []) {
        const snapshot = snapshotTab(tab);
        if (snapshot) {
          accepted.push(snapshot);
        }
        upsertTab(tab);
      }
      const liveIdsByWindow = {};
      for (const snapshot of accepted) {
        const key = String(snapshot.sourceWindowId);
        liveIdsByWindow[key] = liveIdsByWindow[key] || new Set();
        liveIdsByWindow[key].add(snapshot.id);
      }
      const protectedIds = new Set(Object.values(state.pendingBatches)
        .flatMap((batch) => Array.isArray(batch.tabIds) ? batch.tabIds.map(String) : []));
      // Only reconcile windows proven live by tabs.query. A wholly absent window may have
      // closed immediately before startup, so its durable snapshot must await onRemoved/recovery.
      for (const [windowKey, liveIds] of Object.entries(liveIdsByWindow)) {
        const windowSnapshot = state.windowSnapshotsById[windowKey];
        if (!windowSnapshot) {
          continue;
        }
        for (const id of windowSnapshot.tabIds) {
          if (!liveIds.has(String(id)) && !protectedIds.has(String(id))) {
            delete state.tabSnapshotsById[String(id)];
          }
        }
        const liveSnapshots = accepted
          .filter((snapshot) => String(snapshot.sourceWindowId) === windowKey)
          .sort((left, right) => left.position - right.position);
        const protectedMissingIds = windowSnapshot.tabIds.filter((id) => {
          return !liveIds.has(String(id)) && protectedIds.has(String(id));
        });
        windowSnapshot.tabIds = liveSnapshots.map((snapshot) => snapshot.id)
          .concat(protectedMissingIds);
        liveSnapshots.forEach((snapshot, index) => {
          state.tabSnapshotsById[snapshot.id] = { ...snapshot, position: index };
        });
        windowSnapshot.updatedAt = now();
      }
      return { state: getState() };
    }

    function moveTab(tabId, moveInfo) {
      const snapshot = state.tabSnapshotsById[String(tabId)];
      if (!snapshot) {
        return { accepted: false, state: getState() };
      }
      insertIntoWindow(tabId, snapshot.sourceWindowId, moveInfo.toIndex);
      return { accepted: true, state: getState() };
    }

    function detachTab(tabId, detachInfo = {}) {
      const snapshot = state.tabSnapshotsById[String(tabId)];
      if (!snapshot) {
        return { accepted: false, state: getState() };
      }
      removeFromWindow(tabId, detachInfo.oldWindowId ?? snapshot.sourceWindowId);
      snapshot.sourceWindowId = null;
      return { accepted: true, state: getState() };
    }

    function attachTab(tabId, attachInfo = {}) {
      const snapshot = state.tabSnapshotsById[String(tabId)];
      if (!snapshot) {
        return { accepted: false, state: getState() };
      }
      snapshot.sourceWindowId = attachInfo.newWindowId;
      insertIntoWindow(tabId, attachInfo.newWindowId, attachInfo.newPosition);
      delete state.consumedWindowIds[String(attachInfo.newWindowId)];
      return { accepted: true, state: getState() };
    }

    function removeTab(tabId, removeInfo = {}) {
      const id = String(tabId);
      const snapshot = state.tabSnapshotsById[id];
      const windowId = removeInfo.windowId ?? (snapshot && snapshot.sourceWindowId);
      const windowKey = String(windowId);
      if (state.consumedWindowIds[windowKey]) {
        delete state.tabSnapshotsById[id];
        return { ignored: true, state: getState() };
      }
      if (!snapshot || snapshot.mode !== mode || !isHttpUrl(snapshot.url)) {
        return { ignored: true, state: getState() };
      }
      const pending = state.pendingBatches[windowKey] || {
        windowId,
        mode,
        tabIds: [],
        closedAt: now(),
        windowClosing: false,
      };
      pending.tabIds.push(id);
      pending.tabIds = Array.from(new Set(pending.tabIds));
      pending.closedAt = now();
      pending.windowClosing = pending.windowClosing || Boolean(removeInfo.isWindowClosing);
      state.pendingBatches[windowKey] = pending;
      return {
        ignored: false,
        windowId,
        windowClosing: pending.windowClosing,
        state: getState(),
      };
    }

    function buildEvent(tabIds, windowId, closedAt, forcedKind) {
      const tabs = Array.from(new Set(tabIds.map(String)))
        .map((id) => state.tabSnapshotsById[id])
        .filter((snapshot) => snapshot && snapshot.mode === mode && isHttpUrl(snapshot.url))
        .sort((left, right) => left.position - right.position)
        .map((snapshot, index) => ({
          id: snapshot.id,
          title: snapshot.title || snapshot.url,
          url: snapshot.url,
          position: index,
          sourceWindowId: windowId,
        }));
      if (tabs.length === 0) {
        return null;
      }
      const kind = forcedKind || (tabs.length > 1 ? 'group' : 'single');
      const id = createId(kind);
      return {
        id,
        batchId: id,
        mode,
        kind,
        closedAt: Number(closedAt) || now(),
        sourceWindowId: windowId,
        windowId,
        tabs,
      };
    }

    function hashString(value) {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function putInOutbox(event) {
      if (!event) {
        return null;
      }
      const sequence = state.nextCommitSequence++;
      const stableFields = JSON.stringify({
        mode: event.mode,
        kind: event.kind,
        closedAt: event.closedAt,
        sourceWindowId: event.sourceWindowId,
        tabs: event.tabs,
        sequence,
      });
      const commitKey = `close-${hashString(stableFields)}-${sequence.toString(36)}`;
      event.id = commitKey;
      event.batchId = commitKey;
      for (const tab of event.tabs) {
        tab.batchId = commitKey;
      }
      state.pendingEventsById[commitKey] = { commitKey, event };
      return event;
    }

    function cleanupTabIds(tabIds) {
      for (const id of tabIds) {
        delete state.tabSnapshotsById[String(id)];
      }
    }

    function flushBatch(windowId) {
      const key = String(windowId);
      if (state.consumedWindowIds[key]) {
        delete state.pendingBatches[key];
        return { event: null, state: getState() };
      }
      const pending = state.pendingBatches[key];
      if (!pending) {
        return { event: null, state: getState() };
      }
      const event = buildEvent(pending.tabIds, pending.windowId, pending.closedAt);
      putInOutbox(event);
      delete state.pendingBatches[key];
      cleanupTabIds(pending.tabIds);
      const windowSnapshot = state.windowSnapshotsById[key];
      if (windowSnapshot) {
        windowSnapshot.tabIds = windowSnapshot.tabIds
          .filter((id) => !pending.tabIds.includes(String(id)));
        if (windowSnapshot.tabIds.length === 0) {
          delete state.windowSnapshotsById[key];
        }
      }
      return { event: clone(event), state: getState() };
    }

    function removeWindow(windowId) {
      const key = String(windowId);
      if (state.consumedWindowIds[key]) {
        return { event: null, ignored: true, state: getState() };
      }
      const windowSnapshot = state.windowSnapshotsById[key];
      const pending = state.pendingBatches[key];
      const tabIds = windowSnapshot && Array.isArray(windowSnapshot.tabIds)
        ? windowSnapshot.tabIds
        : pending && Array.isArray(pending.tabIds) ? pending.tabIds : [];
      const event = buildEvent(tabIds, windowId, pending && pending.closedAt, 'group');
      putInOutbox(event);
      state.consumedWindowIds[key] = now();
      delete state.pendingBatches[key];
      delete state.windowSnapshotsById[key];
      cleanupTabIds(tabIds);
      return { event: clone(event), ignored: false, state: getState() };
    }

    function pendingWindowIds() {
      return Object.keys(state.pendingBatches).map((id) => Number(id));
    }

    function getPendingBatches() {
      return Object.values(state.pendingBatches).map(clone);
    }

    function pendingEvents() {
      return Object.values(state.pendingEventsById).map(clone);
    }

    function acknowledgeEvent(commitKey) {
      delete state.pendingEventsById[String(commitKey)];
      return { state: getState() };
    }

    function recoverClosedWindows(liveWindowIds) {
      const live = new Set((Array.isArray(liveWindowIds) ? liveWindowIds : []).map(String));
      const events = [];
      for (const pending of getPendingBatches()) {
        if (pending.windowClosing && !live.has(String(pending.windowId))) {
          const result = removeWindow(pending.windowId);
          if (result.event) {
            events.push(result.event);
          }
        }
      }
      return { events, state: getState() };
    }

    function recoverMissingWindows(liveWindowIds) {
      const live = new Set((Array.isArray(liveWindowIds) ? liveWindowIds : []).map(String));
      const events = [];
      for (const [windowKey, snapshot] of Object.entries(state.windowSnapshotsById)) {
        if (live.has(windowKey) || state.consumedWindowIds[windowKey]) {
          continue;
        }
        const windowId = snapshot && snapshot.windowId !== undefined
          ? snapshot.windowId
          : Number(windowKey);
        const result = removeWindow(windowId);
        if (result.event) {
          events.push(result.event);
        }
      }
      return { events, state: getState() };
    }

    function reconcileRecoveredSession(tabs) {
      const liveSnapshots = (Array.isArray(tabs) ? tabs : [])
        .map(snapshotTab)
        .filter(Boolean);
      const liveById = new Map(liveSnapshots.map((snapshot) => [snapshot.id, snapshot]));
      const events = [];

      for (const [windowKey, windowSnapshot] of Object.entries(state.windowSnapshotsById)) {
        const priorIds = Array.isArray(windowSnapshot.tabIds)
          ? windowSnapshot.tabIds.map(String)
          : [];
        const missingIds = priorIds.filter((id) => {
          const prior = state.tabSnapshotsById[id];
          const live = liveById.get(id);
          return !prior || !live
            || String(prior.sourceWindowId) !== String(live.sourceWindowId)
            || String(prior.url) !== String(live.url);
        });
        if (missingIds.length > 0) {
          const windowId = windowSnapshot.windowId !== undefined
            ? windowSnapshot.windowId
            : Number(windowKey);
          const forcedKind = missingIds.length === priorIds.length ? 'group' : undefined;
          const event = buildEvent(missingIds, windowId, now(), forcedKind);
          putInOutbox(event);
          if (event) events.push(clone(event));
          cleanupTabIds(missingIds);
          windowSnapshot.tabIds = priorIds.filter((id) => !missingIds.includes(id));
          if (windowSnapshot.tabIds.length === 0) delete state.windowSnapshotsById[windowKey];
        }
      }

      // A lost browser session also loses ordinary close timers. Missing snapshots were
      // materialized above; snapshots that still match live tabs were never closed.
      state.pendingBatches = {};
      hydrate(tabs);
      return { events, state: getState() };
    }

    return {
      acknowledgeEvent,
      attachTab,
      detachTab,
      flushBatch,
      getPendingBatches,
      getState,
      hydrate,
      moveTab,
      pendingEvents,
      pendingWindowIds,
      removeTab,
      removeWindow,
      reconcileRecoveredSession,
      recoverClosedWindows,
      recoverMissingWindows,
      upsertTab,
    };
  }

  return { createCloseTracker, createTrackerPersistence, emptyState, isHttpUrl };
});
