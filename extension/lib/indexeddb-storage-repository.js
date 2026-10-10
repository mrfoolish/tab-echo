(function initIndexedDbStorageRepository(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./history-store.js'),
      require('./storage-repository.js'),
      require('./indexeddb-migration.js'),
    );
    return;
  }
  root.TabEchoIndexedDbStorageRepository = factory(
    root.TabEchoHistoryStore,
    root.TabEchoStorageRepository,
    root.TabEchoIndexedDbMigration,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this,
  function createModule(historyStore, storageModule, migrationModule) {
    if (!historyStore || !storageModule || !migrationModule) {
      throw new Error('IndexedDB repository dependencies are required.');
    }

    const MODES = ['normal', 'incognito'];
    const { STORAGE_KEYS, StorageWriteError, createStorageRepository } = storageModule;
    const { KEYS: INDEXEDDB_KEYS, createIndexedDbMigration, createYieldControl } = migrationModule;

    function clone(value) {
      if (value === undefined) return undefined;
      if (typeof structuredClone === 'function') return structuredClone(value);
      return JSON.parse(JSON.stringify(value));
    }

    function assertMode(mode) {
      if (!MODES.includes(mode)) throw new TypeError('mode must be normal or incognito.');
      return mode;
    }

    function readValue(result, key) {
      return result && typeof result === 'object' && Object.hasOwn(result, key)
        ? result[key] : undefined;
    }

    function normalizeRevision(value) {
      const revision = Number(value);
      return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
    }

    function normalizeHistory(input, mode) {
      if (!Array.isArray(input)) return [];
      return input.map((event) => historyStore.normalizeCloseEvent(
        event && typeof event === 'object' ? { ...event, mode } : event,
        mode,
      )).filter(Boolean);
    }

    function normalizeTrash(input, mode) {
      if (!Array.isArray(input)) return [];
      return input.map((source) => {
        const event = historyStore.normalizeCloseEvent(
          source && typeof source === 'object' ? { ...source, mode } : source,
          mode,
        );
        if (!event) return null;
        const deletedAt = Number(source && source.deletedAt);
        return Number.isFinite(deletedAt) ? { ...event, deletedAt } : event;
      }).filter(Boolean);
    }

    function equivalent(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    function collectionChanges(current, next) {
      const before = new Map(current.map((event) => [String(event.id), event]));
      const after = new Map(next.map((event) => [String(event.id), event]));
      const deleteIds = [];
      const put = [];
      for (const id of before.keys()) if (!after.has(id)) deleteIds.push(id);
      for (const [id, event] of after) {
        if (!before.has(id) || !equivalent(before.get(id), event)) put.push(event);
      }
      return { deleteIds, put };
    }

    function createIndexedDbStorageRepository(storageArea, recordStore, options = {}) {
      const legacyRepository = options.legacyRepository || createStorageRepository(storageArea, options);
      const migration = options.migration || createIndexedDbMigration({
        storageArea,
        recordStore,
        batchSize: options.batchSize,
        timeBudgetMs: options.timeBudgetMs,
        performanceNow: options.performanceNow,
        yieldControl: options.yieldControl,
        now: options.now,
      });
      const retryLimit = Number.isSafeInteger(options.retryLimit) && options.retryLimit >= 0
        ? options.retryLimit : 3;
      const maxAttempts = retryLimit + 1;
      const batchSize = Number.isSafeInteger(options.batchSize) && options.batchSize > 0
        ? options.batchSize : 250;
      const timeBudgetMs = Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs > 0
        ? options.timeBudgetMs : 50;
      const performanceNow = typeof options.performanceNow === 'function'
        ? options.performanceNow
        : () => (globalThis.performance && typeof globalThis.performance.now === 'function'
          ? globalThis.performance.now() : Date.now());
      const yieldControl = typeof options.yieldControl === 'function'
        ? options.yieldControl : createYieldControl();
      const now = typeof options.now === 'function' ? options.now : Date.now;
      const queues = { normal: Promise.resolve(), incognito: Promise.resolve() };
      let generationSequence = 0;

      async function readMetadata(mode) {
        const result = await storageArea.get([
          STORAGE_KEYS.settings,
          STORAGE_KEYS.settingsRevision,
          STORAGE_KEYS.revision[mode],
          INDEXEDDB_KEYS.generation[mode],
          INDEXEDDB_KEYS.marker[mode],
        ]);
        const generation = readValue(result, INDEXEDDB_KEYS.generation[mode]);
        const marker = readValue(result, INDEXEDDB_KEYS.marker[mode]);
        const indexed = typeof generation === 'string' && generation
          && marker && marker.status === 'complete';
        let revision = normalizeRevision(readValue(result, STORAGE_KEYS.revision[mode]));
        if (indexed && typeof recordStore.readGenerationRevision === 'function') {
          const indexedRevision = await recordStore.readGenerationRevision(mode, generation);
          if (indexedRevision !== null && indexedRevision !== undefined) {
            revision = normalizeRevision(indexedRevision);
          }
        }
        return {
          indexed: Boolean(indexed),
          generation: indexed ? generation : null,
          settings: historyStore.normalizeSettings(readValue(result, STORAGE_KEYS.settings)),
          revision,
          settingsRevision: normalizeRevision(readValue(result, STORAGE_KEYS.settingsRevision)),
        };
      }

      async function readContext(mode) {
        const activeMode = assertMode(mode);
        const metadata = await readMetadata(activeMode);
        if (!metadata.indexed) return legacyRepository.readContext(activeMode);
        const [history, trash] = await Promise.all([
          recordStore.readGeneration('history', activeMode, metadata.generation),
          recordStore.readGeneration('trash', activeMode, metadata.generation),
        ]);
        return {
          settings: metadata.settings,
          history: normalizeHistory(history, activeMode),
          trash: normalizeTrash(trash, activeMode),
          revision: metadata.revision,
          settingsRevision: metadata.settingsRevision,
        };
      }

      async function readCollection(storeName, mode) {
        const activeMode = assertMode(mode);
        const metadata = await readMetadata(activeMode);
        if (!metadata.indexed) {
          return storeName === 'history'
            ? legacyRepository.readHistory(activeMode) : legacyRepository.readTrash(activeMode);
        }
        const records = await recordStore.readGeneration(storeName, activeMode, metadata.generation);
        return storeName === 'history'
          ? normalizeHistory(records, activeMode) : normalizeTrash(records, activeMode);
      }

      async function queryCollection(storeName, mode, query, options = {}) {
        const activeMode = assertMode(mode);
        const metadata = await readMetadata(activeMode);
        const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
        const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
        if (!metadata.indexed || typeof recordStore.scanGenerationPage !== 'function') {
          const stored = metadata.indexed
            ? await recordStore.readGeneration(storeName, activeMode, metadata.generation)
            : (storeName === 'history'
              ? await legacyRepository.readHistory(activeMode) : await legacyRepository.readTrash(activeMode));
          const source = stored
            .slice().sort(storeName === 'history'
              ? (left, right) => right.closedAt - left.closedAt
              : (left, right) => right.deletedAt - left.deletedAt);
          const results = historyStore.buildSearchResults(source, query, { deduplicateSingles: false });
          const totalTabs = historyStore.countTabs(source);
          return {
            settings: metadata.settings, revision: metadata.revision,
            results: results.slice(offset, offset + limit),
            statistics: {
              totalRecords: source.length,
              totalTabs,
              matchingRecords: results.length,
              matchingTabs: results.reduce((sum, item) => sum + item.matchedTabCount, 0),
              resultTabs: results.reduce((sum, item) => sum + item.totalTabCount, 0),
            },
          };
        }
        const page = await recordStore.scanGenerationPage(
          storeName, activeMode, metadata.generation, { offset, limit },
          (candidate) => {
            const normalized = storeName === 'history'
              ? normalizeHistory([candidate], activeMode)[0]
              : normalizeTrash([candidate], activeMode)[0];
            if (!normalized) return null;
            return historyStore.buildSearchResults(
              [normalized], query, { deduplicateSingles: false },
            )[0] || null;
          },
        );
        return {
          settings: metadata.settings,
          revision: metadata.revision,
          results: page.records,
          statistics: page.statistics,
        };
      }

      async function writeBatches(storeName, mode, generation, records) {
        let deadline = performanceNow() + timeBudgetMs;
        for (let offset = 0; offset < records.length; offset += batchSize) {
          await recordStore.putBatch(storeName, mode, generation,
            records.slice(offset, offset + batchSize), offset);
          if (offset + batchSize < records.length && performanceNow() >= deadline) {
            await yieldControl();
            deadline = performanceNow() + timeBudgetMs;
          }
        }
      }

      async function stageGeneration(mode, generation, history, trash, revision) {
        await recordStore.resetGeneration(mode, generation);
        await writeBatches('history', mode, generation, history);
        await writeBatches('trash', mode, generation, trash);
        const [historyCount, trashCount] = await Promise.all([
          recordStore.countGeneration('history', mode, generation),
          recordStore.countGeneration('trash', mode, generation),
        ]);
        if (historyCount !== history.length || trashCount !== trash.length) {
          throw new Error('IndexedDB generation verification failed.');
        }
        if (typeof recordStore.setGenerationRevision === 'function') {
          await recordStore.setGenerationRevision(mode, generation, revision);
        }
      }

      function nextGeneration(mode, revision) {
        generationSequence += 1;
        return `g-${mode}-${revision}-${now().toString(36)}-${generationSequence.toString(36)}`;
      }

      async function writeMetadata(operation, payload) {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await storageArea.set(clone(payload));
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw new StorageWriteError(operation, maxAttempts, lastError);
      }

      async function discardOldGeneration(mode, generation, replacement) {
        if (!generation || generation === replacement || typeof recordStore.deleteGeneration !== 'function') return;
        try { await recordStore.deleteGeneration(mode, generation); } catch (_) { /* Orphans are invisible. */ }
      }

      async function performUpdate(mode, mutator, includeSettings) {
        if (typeof mutator !== 'function') throw new TypeError('mutator must be a function.');
        const current = await readContext(mode);
        const mutation = await mutator(clone(current));
        if (!mutation || typeof mutation !== 'object') throw new TypeError('mutator must return an object.');
        const settingsInput = includeSettings && Object.hasOwn(mutation, 'settings')
          ? mutation.settings : current.settings;
        const validation = historyStore.validateSettingsInput(settingsInput);
        if (!validation.valid) throw new storageModule.SettingsValidationError(validation.errors);
        const settings = historyStore.normalizeSettings(validation.settings);
        const history = normalizeHistory(Object.hasOwn(mutation, 'history')
          ? mutation.history : current.history, mode);
        const trash = normalizeTrash(Object.hasOwn(mutation, 'trash')
          ? mutation.trash : current.trash, mode);
        const contextChanged = !equivalent(history, current.history) || !equivalent(trash, current.trash);
        const settingsChanged = includeSettings && !equivalent(settings, current.settings);
        const revision = current.revision + (includeSettings ? (contextChanged ? 1 : 0) : 1);
        const settingsRevision = current.settingsRevision + (settingsChanged ? 1 : 0);
        const result = clone(Object.hasOwn(mutation, 'result') ? mutation.result
          : { settings, history, trash, revision, settingsRevision });
        const oldMetadata = await readMetadata(mode);

        if (!includeSettings && oldMetadata.indexed
          && typeof recordStore.applyGenerationChanges === 'function') {
          const changes = {
            history: collectionChanges(current.history, history),
            trash: collectionChanges(current.trash, trash),
          };
          await recordStore.applyGenerationChanges(
            mode, oldMetadata.generation, changes, current.revision, revision,
          );
          return result;
        }

        const generation = nextGeneration(mode, revision);
        await stageGeneration(mode, generation, history, trash, revision);
        const payload = {
          [INDEXEDDB_KEYS.generation[mode]]: generation,
          [STORAGE_KEYS.revision[mode]]: revision,
        };
        if (includeSettings) {
          payload[STORAGE_KEYS.settings] = settings;
          payload[STORAGE_KEYS.settingsRevision] = settingsRevision;
        }
        try {
          await writeMetadata(includeSettings
            ? `updateSettingsAndContext(${mode})` : `updateContext(${mode})`, payload);
        } catch (error) {
          if (typeof recordStore.deleteGeneration === 'function') {
            try { await recordStore.deleteGeneration(mode, generation); } catch (_) { /* Invisible orphan. */ }
          }
          throw error;
        }
        await discardOldGeneration(mode, oldMetadata.generation, generation);
        return result;
      }

      function enqueue(mode, operation) {
        const activeMode = assertMode(mode);
        const run = queues[activeMode].then(operation);
        queues[activeMode] = run.catch(() => undefined);
        return run;
      }

      async function migrateLegacyState(mode) {
        const activeMode = assertMode(mode);
        const legacyResult = await legacyRepository.migrateLegacyState();
        const indexedDbResult = await migration.migrateMode(activeMode);
        return { ...legacyResult, indexedDb: indexedDbResult };
      }

      return {
        acknowledgeMigrationNotice: (...args) => legacyRepository.acknowledgeMigrationNotice(...args),
        getMigrationNotice: (...args) => legacyRepository.getMigrationNotice(...args),
        getSettings: (...args) => legacyRepository.getSettings(...args),
        migrateLegacyState,
        readContext,
        readHistory: (mode) => readCollection('history', mode),
        readTrash: (mode) => readCollection('trash', mode),
        queryCollection,
        saveSettings: (...args) => legacyRepository.saveSettings(...args),
        updateContext: (mode, mutator) => enqueue(mode, () => performUpdate(mode, mutator, false)),
        updateSettingsAndContext: (mode, mutator) => enqueue(mode,
          () => performUpdate(mode, mutator, true)),
      };
    }

    return { createIndexedDbStorageRepository };
  });
