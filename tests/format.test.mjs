import test from 'node:test';
import assert from 'node:assert/strict';
import { formatClock, timeAgo } from '../src/lib/format.js';

test('formatClock renders the presence timestamp format', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(74), '01:14');
  assert.equal(formatClock(80 * 60 + 20), '01:20:20');
  assert.equal(formatClock(1 * 3600 + 14 * 60 + 20), '01:14:20');
  assert.equal(formatClock(-5), '00:00');
  assert.equal(formatClock(NaN), '00:00');
  assert.equal(formatClock(3.9), '00:03'); // floors
});

test('timeAgo buckets sensibly', () => {
  const now = 1_000_000_000_000;
  assert.equal(timeAgo(now - 30 * 1000, now), 'just now');
  assert.equal(timeAgo(now - 5 * 60 * 1000, now), '5m ago');
  assert.equal(timeAgo(now - 3 * 3600 * 1000, now), '3h ago');
  assert.equal(timeAgo(now - 2 * 24 * 3600 * 1000, now), '2d ago');
  assert.equal(timeAgo(now - 3 * 30 * 24 * 3600 * 1000, now), '3mo ago');
  assert.equal(timeAgo(now - 2 * 365 * 24 * 3600 * 1000, now), '2y ago');
});
