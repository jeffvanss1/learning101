import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, scoreMatch, rankCandidates, levenshtein } from '../src/lib/fuzzy.js';

test('normalize strips case, accents and punctuation', () => {
  assert.equal(normalize('  Davé_Jones! '), 'dave jones');
  assert.equal(normalize('XXX-42'), 'xxx 42');
  assert.equal(normalize(''), '');
});

test('scoreMatch ranks exact > prefix > word > substring > typo', () => {
  const q = 'dave';
  assert.ok(scoreMatch(q, 'dave') > scoreMatch(q, 'daveyjones'));
  assert.ok(scoreMatch(q, 'daveyjones') > scoreMatch(q, 'dave joneslon'));
  assert.ok(scoreMatch(q, 'cool dave guy') > 0);
  assert.ok(scoreMatch(q, 'dave') > scoreMatch(q, 'davs')); // typo beats prefix of other
  assert.equal(scoreMatch('zzz', 'dave'), 0);
});

test('scoreMatch tolerates single-character typos', () => {
  assert.ok(scoreMatch('dafne', 'daphne') > 0);
  assert.ok(scoreMatch('jie', 'julie') > 0); // subsequence
  assert.ok(scoreMatch('dve', 'dave') > 0); // 1 substitution
});

test('adjacent transpositions count as one edit (Damerau)', () => {
  assert.equal(levenshtein('dvae', 'dave', 1), 1);
  assert.ok(scoreMatch('dvae', 'dave') > 0);
});

test('levenshtein honors the budget', () => {
  assert.equal(levenshtein('dave', 'dave', 1), 0);
  assert.equal(levenshtein('dave', 'davs', 1), 1);
  assert.equal(levenshtein('dave', 'davour', 1), 2); // over budget
  assert.ok(levenshtein('abc', 'xyz', 2) > 2);
});

test('rankCandidates orders best matches first and drops non-matches', () => {
  const candidates = [
    { username: 'wine_lover', displayName: 'Wine Lover' },
    { username: 'dave', displayName: 'Dave' },
    { username: 'davey', displayName: 'Davey Jones' },
    { username: 'nobody', displayName: 'Nobody Atall' },
  ];
  const order = rankCandidates('dave', candidates);
  assert.deepEqual(order, [1, 2]); // exact 'dave' then prefix 'davey'
  assert.deepEqual(rankCandidates('', candidates), []);
  assert.deepEqual(rankCandidates('zzzzzzz', candidates), []);
});

test('rankCandidates matches on display name too', () => {
  const order = rankCandidates('jones', [
    { username: 'a', displayName: 'AAA' },
    { username: 'dj', displayName: 'Davey Jones' },
  ]);
  assert.deepEqual(order, [1]);
});
