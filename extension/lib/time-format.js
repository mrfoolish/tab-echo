(function timeFormatModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabEchoTimeFormat = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const MONTH_THRESHOLD = 30 * DAY;

  function localeFor(language) {
    return String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function formatRelativeTime(timestamp, language = 'en', now = Date.now()) {
    const time = Number(timestamp);
    const current = Number(now);
    const elapsed = current - time;
    const locale = localeFor(language);
    if (!Number.isFinite(elapsed) || elapsed < MINUTE) return locale === 'zh' ? '刚刚' : 'just now';
    if (elapsed >= MONTH_THRESHOLD) {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(time));
    }

    let unit = 'minute';
    let divisor = MINUTE;
    if (elapsed >= DAY) { unit = 'day'; divisor = DAY; }
    else if (elapsed >= HOUR) { unit = 'hour'; divisor = HOUR; }
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-Math.floor(elapsed / divisor), unit);
  }

  function formatFullTime(timestamp, language = 'en') {
    return new Intl.DateTimeFormat(localeFor(language), { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(Number(timestamp)));
  }

  return { formatRelativeTime, formatFullTime };
}));
