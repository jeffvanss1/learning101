import test from 'node:test';
import assert from 'node:assert/strict';
import { levelFor, levelTitle, badgesFor } from '../src/lib/level.js';

test('levelFor follows the 0/4/12/24 curve', () => {
  assert.equal(levelFor(0).level, 1);
  assert.equal(levelFor(3).level, 1);
  assert.equal(levelFor(4).level, 2);
  assert.equal(levelFor(11).level, 2);
  assert.equal(levelFor(12).level, 3);
  assert.equal(levelFor(24).level, 4);
  assert.equal(levelFor(1000).level > 10, true);
  // never regresses with junk input
  assert.equal(levelFor(-5).level, 1);
  assert.equal(levelFor(NaN).level, 1);
});

test('levelFor reports progress into the current span', () => {
  const { level, into, span } = levelFor(6); // 4 spent on L1->L2, 2 into L2's 8
  assert.equal(level, 2);
  assert.equal(into, 2);
  assert.equal(span, 8);
});

test('levelTitle climbs', () => {
  assert.equal(levelTitle(1), 'Newcomer');
  assert.equal(levelTitle(7), 'Couch Regular');
  assert.equal(levelTitle(30), 'Legendary Cinephile');
});

test('badgesFor awards from stats', () => {
  const none = badgesFor({ watchCount: 0, friendCount: 0, favoritesCount: 0 });
  assert.deepEqual(none, []);

  const some = badgesFor({ watchCount: 12, friendCount: 2, favoritesCount: 4 });
  const ids = some.map((b) => b.id);
  assert.ok(ids.includes('first-watch'));
  assert.ok(ids.includes('binge-10'));
  assert.ok(ids.includes('social'));
  assert.ok(ids.includes('curator'));
  assert.ok(!ids.includes('binge-50'));

  const host = badgesFor({ watchCount: 1, friendCount: 0, favoritesCount: 0, isHosting: true });
  assert.ok(host.some((b) => b.id === 'host'));
});
