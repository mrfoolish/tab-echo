(function initDomainGroups(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.TabEchoDomainGroups = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDomainGroups() {
  'use strict';

  const MULTIPLE_DOMAINS_KEY = '__multiple_domains__';
  const UNKNOWN_DOMAIN_KEY = '__unknown_domain__';
  const SPECIAL_LABELS = Object.freeze({
    [MULTIPLE_DOMAINS_KEY]: 'Multiple domains',
    [UNKNOWN_DOMAIN_KEY]: 'Unknown domain',
  });

  function getHostname(url) {
    try {
      const hostname = new URL(String(url || '')).hostname.toLowerCase();
      return hostname || null;
    } catch {
      return null;
    }
  }

  function getResultDomainKey(result) {
    const tabs = result && result.event && Array.isArray(result.event.tabs)
      ? result.event.tabs
      : [];
    const hostnames = new Set();

    for (const tab of tabs) {
      const hostname = getHostname(tab && tab.url);
      if (!hostname) return UNKNOWN_DOMAIN_KEY;
      hostnames.add(hostname);
    }

    if (hostnames.size === 0) return UNKNOWN_DOMAIN_KEY;
    if (hostnames.size > 1) return MULTIPLE_DOMAINS_KEY;
    return hostnames.values().next().value;
  }

  function getLabel(key) {
    if (SPECIAL_LABELS[key]) return SPECIAL_LABELS[key];
    return key;
  }

  function getTabCount(result) {
    const tabs = result && result.event && result.event.tabs;
    return Array.isArray(tabs) ? tabs.length : 0;
  }

  function buildDomainGroups(results) {
    const source = Array.isArray(results) ? results : [];
    const groupsByKey = new Map();

    for (const result of source) {
      const key = getResultDomainKey(result);
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          key,
          domain: key,
          label: getLabel(key),
          results: [],
          eventCount: 0,
          tabCount: 0,
        };
        groupsByKey.set(key, group);
      }
      group.results.push(result);
      group.eventCount += 1;
      group.tabCount += getTabCount(result);
    }

    return Array.from(groupsByKey.values()).sort((left, right) => {
      const countDifference = right.eventCount - left.eventCount;
      if (countDifference !== 0) return countDifference;
      const labelDifference = left.label.localeCompare(right.label);
      if (labelDifference !== 0) return labelDifference;
      return left.key.localeCompare(right.key);
    });
  }

  function sortDomainGroups(groups) {
    return groups.sort((left, right) => {
      const countDifference = right.eventCount - left.eventCount;
      if (countDifference !== 0) return countDifference;
      const labelDifference = left.label.localeCompare(right.label);
      if (labelDifference !== 0) return labelDifference;
      return left.key.localeCompare(right.key);
    });
  }

  function createDomainQuery(options = {}) {
    const offset = Number.isSafeInteger(options.offset) && options.offset > 0 ? options.offset : 0;
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 50;
    const requestedDomain = typeof options.domain === 'string' ? options.domain : null;
    const groupsByKey = new Map();

    function add(result) {
      const key = getResultDomainKey(result);
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          key, domain: key, label: getLabel(key), eventCount: 0, tabCount: 0,
          eventIds: [], results: [],
        };
        groupsByKey.set(key, group);
      }
      const index = group.eventCount;
      group.eventCount += 1;
      group.tabCount += getTabCount(result);
      if (result && result.event && result.event.id !== undefined && result.event.id !== null) {
        group.eventIds.push(String(result.event.id));
      }
      if (index >= offset && group.results.length < limit) group.results.push(result);
    }

    function finish() {
      const groups = sortDomainGroups(Array.from(groupsByKey.values()));
      const selected = groups.find((group) => group.key === requestedDomain) || groups[0] || null;
      return {
        groups: groups.map(({ key, domain, label, eventCount, tabCount }) => (
          { key, domain, label, eventCount, tabCount }
        )),
        selectedDomain: selected ? selected.key : null,
        results: selected ? selected.results : [],
        eventIds: selected ? selected.eventIds : [],
        selectedRecords: selected ? selected.eventCount : 0,
        selectedTabs: selected ? selected.tabCount : 0,
      };
    }

    return { add, finish };
  }

  return {
    MULTIPLE_DOMAINS_KEY,
    UNKNOWN_DOMAIN_KEY,
    buildDomainGroups,
    createDomainQuery,
    getResultDomainKey,
  };
});
