function indexedDbModuleStubs() {
  return {
    indexedDB: {},
    TabEchoIndexedDbRepository: {
      createIndexedDbRecordStore() { return {}; },
    },
    TabEchoIndexedDbStorageRepository: {
      createIndexedDbStorageRepository(storageArea, recordStore, options) {
        return options.localRepository;
      },
    },
  };
}

module.exports = { indexedDbModuleStubs };
