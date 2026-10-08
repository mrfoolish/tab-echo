'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const timeFormat = require('../lib/time-format.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

test('formatRelativeTime uses localized just-now copy for recent and future times', () => {
  assert.equal(timeFormat.formatRelativeTime(NOW - 59 * 1000, 'en', NOW), 'just now');
  assert.equal(timeFormat.formatRelativeTime(NOW - 59 * 1000, 'zh', NOW), '刚刚');
  assert.equal(timeFormat.formatRelativeTime(NOW + HOUR, 'en', NOW), 'just now');
  assert.equal(timeFormat.formatRelativeTime(NOW + HOUR, 'zh', NOW), '刚刚');
});

test('formatRelativeTime chooses minutes, hours, and days at the specified boundaries', () => {
  assert.equal(timeFormat.formatRelativeTime(NOW - MINUTE, 'en', NOW), '1 minute ago');
  assert.equal(timeFormat.formatRelativeTime(NOW - 59 * MINUTE, 'zh', NOW), '59分钟前');
  assert.equal(timeFormat.formatRelativeTime(NOW - HOUR, 'en', NOW), '1 hour ago');
  assert.equal(timeFormat.formatRelativeTime(NOW - 23 * HOUR, 'zh', NOW), '23小时前');
  assert.equal(timeFormat.formatRelativeTime(NOW - DAY, 'en', NOW), '1 day ago');
  assert.equal(timeFormat.formatRelativeTime(NOW - 29 * DAY, 'zh', NOW), '29天前');
});

test('formatRelativeTime falls back to a localized short date at 30 days', () => {
  const timestamp = NOW - 30 * DAY;
  assert.equal(timeFormat.formatRelativeTime(timestamp, 'en', NOW),
    new Intl.DateTimeFormat('en', { dateStyle: 'short' }).format(timestamp));
  assert.equal(timeFormat.formatRelativeTime(timestamp, 'zh', NOW),
    new Intl.DateTimeFormat('zh', { dateStyle: 'short' }).format(timestamp));
});

test('formatFullTime provides a localized date and time for disclosure text', () => {
  const timestamp = Date.UTC(2026, 8, 21, 4, 5, 6);
  assert.equal(timeFormat.formatFullTime(timestamp, 'en'),
    new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' }).format(timestamp));
  assert.equal(timeFormat.formatFullTime(timestamp, 'zh'),
    new Intl.DateTimeFormat('zh', { dateStyle: 'medium', timeStyle: 'medium' }).format(timestamp));
});
