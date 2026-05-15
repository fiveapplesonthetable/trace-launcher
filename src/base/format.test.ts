import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  formatDuration,
  formatRelativeTime,
  formatSize,
  formatUsage,
  usagePercent,
} from './format';

test('formatSize scales bytes through binary units', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1024), '1.0 KiB');
  assert.equal(formatSize(1536), '1.5 KiB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MiB');
  assert.equal(formatSize(3 * 1024 ** 3), '3.0 GiB');
  assert.equal(formatSize(-10), '0 B');
});

test('formatDuration is compact across scales', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(5000), '5s');
  assert.equal(formatDuration(90_000), '1.5m');
  assert.equal(formatDuration(3_600_000), '1.0h');
});

test('formatRelativeTime buckets ages into readable spans', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelativeTime(0), 'unknown');
  assert.equal(formatRelativeTime(now - 1000, now), 'just now');
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), '3h ago');
  assert.equal(formatRelativeTime(now - 2 * 86_400_000, now), '2d ago');
});

test('formatUsage and usagePercent agree, and tolerate zero totals', () => {
  assert.equal(formatUsage(25, 100), '25 B / 100 B (25%)');
  assert.equal(formatUsage(1, 0), 'unknown');
  assert.equal(usagePercent(25, 100), 25);
  assert.equal(usagePercent(1, 0), 0);
  assert.equal(usagePercent(200, 100), 100); // clamped
});
