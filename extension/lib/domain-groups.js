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
    return key.replace(/^www\./, '');
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

  return {
    MULTIPLE_DOMAINS_KEY,
    UNKNOWN_DOMAIN_KEY,
    buildDomainGroups,
  };
});
