(function initIndexedDbStorageRepository(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./history-store.js'),
      require('./storage-repository.js'),
      require('./domain-groups.js'),
    );
    return;
  }
  root.TabEchoIndexedDbStorageRepository = factory(
    root.TabEchoHistoryStore,
    root.TabEchoStorageRepository,
    root.TabEchoDomainGroups,
  );
})(typeof globalThis !== 'undefined' ? globalThis : this,
  function createModule(historyStore, storageModule, domainGroups) {
    if (!historyStore || !storageModule || !domainGroups) {
      throw new Error('IndexedDB repository dependencies are required.');
    }

    const MODES = ['normal', 'incognito'];
    const { STORAGE_KEYS, StorageWriteError, createStorageRepository } = storageModule;
    const INDEXEDDB_KEYS = Object.freeze({
      generation: Object.freeze({
        normal: 'tabEcho:indexeddb-generation:normal:v1',
        incognito: 'tabEcho:indexeddb-generation:incognito:v1',
      }),
    });

    function createYieldControl(environment = globalThis) {
      return async function yieldControl() {
        if (environment.scheduler && typeof environment.scheduler.yield === 'function') {
          await environment.scheduler.yield();
          return;
        }
        await new Promise((resolve) => environment.setTimeout(resolve, 0));
      };
    }

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
      const localRepository = options.localRepository || createStorageRepository(storageArea, options);
      const indexedModes = new Set(Array.isArray(options.indexedModes)
        ? options.indexedModes.filter((mode) => MODES.includes(mode)) : MODES);
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

      function wrapIndexedDbWriteError(operation, error) {
        if (error && error.code === 'REVISION_CONFLICT') return error;
        const wrapped = new StorageWriteError(operation, 1, error);
        wrapped.code = 'STORAGE_WRITE_FAILED';
        wrapped.causeName = error && typeof error.name === 'string' ? error.name : 'Error';
        wrapped.retryable = wrapped.causeName !== 'QuotaExceededError';
        return wrapped;
      }

      async function readMetadata(mode) {
        const result = await storageArea.get([
          STORAGE_KEYS.settings,
          STORAGE_KEYS.settingsRevision,
          STORAGE_KEYS.revision[mode],
          INDEXEDDB_KEYS.generation[mode],
        ]);
        const generation = readValue(result, INDEXEDDB_KEYS.generation[mode]);
        const managed = indexedModes.has(mode);
        const indexed = managed && typeof generation === 'string' && Boolean(generation);
        let revision = normalizeRevision(readValue(result, STORAGE_KEYS.revision[mode]));
        if (indexed && typeof recordStore.readGenerationRevision === 'function') {
          const indexedRevision = await recordStore.readGenerationRevision(mode, generation);
          if (indexedRevision !== null && indexedRevision !== undefined) {
            revision = normalizeRevision(indexedRevision);
          }
        }
        return {
          managed,
          indexed: Boolean(indexed),
          generation: indexed ? generation : null,
          settings: historyStore.normalizeSettings(readValue(result, STORAGE_KEYS.settings)),
          revision,
          settingsRevision: normalizeRevision(readValue(result, STORAGE_KEYS.settingsRevision)),
        };
      }

      function sameSnapshot(left, right) {
        return left.indexed === right.indexed
          && left.generation === right.generation
          && left.revision === right.revision
          && left.settingsRevision === right.settingsRevision;
      }

      async function readStable(mode, operation) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const metadata = await readMetadata(mode);
          const value = await operation(metadata);
          if (!metadata.indexed) return value;
          const latest = await readMetadata(mode);
          if (sameSnapshot(metadata, latest)) return value;
        }
        const error = new Error('IndexedDB collection changed while it was being read.');
        error.code = 'READ_CONFLICT';
        throw error;
      }

      async function readContext(mode) {
        const activeMode = assertMode(mode);
        return readStable(activeMode, async (metadata) => {
          if (!metadata.managed) return localRepository.readContext(activeMode);
          if (!metadata.indexed) {
            return {
              settings: metadata.settings,
              history: [],
              trash: [],
              revision: metadata.revision,
              settingsRevision: metadata.settingsRevision,
            };
          }
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
        });
      }

      async function readCollection(storeName, mode) {
        const activeMode = assertMode(mode);
        return readStable(activeMode, async (metadata) => {
          if (!metadata.managed) {
            return storeName === 'history'
              ? localRepository.readHistory(activeMode) : localRepository.readTrash(activeMode);
          }
          if (!metadata.indexed) return [];
          const records = await recordStore.readGeneration(storeName, activeMode, metadata.generation);
          return storeName === 'history'
            ? normalizeHistory(records, activeMode) : normalizeTrash(records, activeMode);
        });
      }

      async function queryCollection(storeName, mode, query, options = {}) {
        const activeMode = assertMode(mode);
        const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
        const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
        return readStable(activeMode, async (metadata) => {
          if (!metadata.managed || !metadata.indexed
            || typeof recordStore.scanGenerationPage !== 'function') {
            const localContext = metadata.managed
              ? null : await localRepository.readContext(activeMode);
            const stored = !metadata.managed
              ? localContext[storeName]
              : metadata.indexed
                ? await recordStore.readGeneration(storeName, activeMode, metadata.generation)
                : [];
            const source = stored
              .slice().sort(storeName === 'history'
                ? (left, right) => right.closedAt - left.closedAt
                : (left, right) => right.deletedAt - left.deletedAt);
            const results = historyStore.buildSearchResults(source, query, { deduplicateSingles: false });
            const totalTabs = historyStore.countTabs(source);
            return {
              settings: localContext ? localContext.settings : metadata.settings,
              revision: localContext ? localContext.revision : metadata.revision,
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
        });
      }

      async function queryHistoryByDomain(mode, query, options = {}) {
        const activeMode = assertMode(mode);
        const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
        const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
        return readStable(activeMode, async (metadata) => {
          const domainQuery = domainGroups.createDomainQuery({
            domain: options.domain, offset, limit,
          });
          const statistics = {
            totalRecords: 0, totalTabs: 0, matchingRecords: 0, matchingTabs: 0, resultTabs: 0,
          };
          const visit = (candidate) => {
            const normalized = normalizeHistory([candidate], activeMode)[0];
            if (!normalized) return;
            statistics.totalRecords += 1;
            statistics.totalTabs += normalized.tabs.length;
            const result = historyStore.buildSearchResults(
              [normalized], query, { deduplicateSingles: false },
            )[0];
            if (!result) return;
            statistics.matchingRecords += 1;
            statistics.matchingTabs += Number(result.matchedTabCount) || 0;
            statistics.resultTabs += Number(result.totalTabCount) || normalized.tabs.length;
            domainQuery.add(result);
          };

          if (metadata.indexed && typeof recordStore.scanGeneration === 'function') {
            await recordStore.scanGeneration('history', activeMode, metadata.generation, visit);
          } else {
            const localContext = metadata.managed
              ? null : await localRepository.readContext(activeMode);
            const stored = !metadata.managed
              ? localContext.history
              : metadata.indexed
                ? await recordStore.readGeneration('history', activeMode, metadata.generation)
                : [];
            stored.slice().sort((left, right) => right.closedAt - left.closedAt).forEach(visit);
            if (localContext) {
              metadata.settings = localContext.settings;
              metadata.revision = localContext.revision;
            }
          }
          const domainPage = domainQuery.finish();
          return {
            settings: metadata.settings,
            revision: metadata.revision,
            ...domainPage,
            statistics: {
              ...statistics,
              selectedRecords: domainPage.selectedRecords,
              selectedTabs: domainPage.selectedTabs,
            },
          };
        });
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
          try {
            await recordStore.applyGenerationChanges(
              mode, oldMetadata.generation, changes, current.revision, revision,
            );
          } catch (error) {
            throw wrapIndexedDbWriteError(`indexedDB.updateContext(${mode})`, error);
          }
          return result;
        }

        const generation = nextGeneration(mode, revision);
        try {
          await stageGeneration(mode, generation, history, trash, revision);
        } catch (error) {
          throw wrapIndexedDbWriteError(
            `indexedDB.${includeSettings ? 'updateSettingsAndContext' : 'updateContext'}(${mode})`,
            error,
          );
        }
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

      return {
        getSettings: (...args) => localRepository.getSettings(...args),
        readContext,
        readHistory: (mode) => readCollection('history', mode),
        readTrash: (mode) => readCollection('trash', mode),
        queryCollection,
        queryHistoryByDomain,
        saveSettings: (...args) => localRepository.saveSettings(...args),
        updateContext: (mode, mutator) => indexedModes.has(assertMode(mode))
          ? enqueue(mode, () => performUpdate(mode, mutator, false))
          : localRepository.updateContext(mode, mutator),
        updateSettingsAndContext: (mode, mutator) => indexedModes.has(assertMode(mode))
          ? enqueue(mode, () => performUpdate(mode, mutator, true))
          : localRepository.updateSettingsAndContext(mode, mutator),
      };
    }

    return { INDEXEDDB_KEYS, createIndexedDbStorageRepository, createYieldControl };
  });
