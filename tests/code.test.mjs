import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAccessCode,
  normalizeCode,
  formatCode,
  isValidNormalizedCode,
  CODE_ALPHABET,
  CODE_CHARS,
} from '../src/lib/code.js';

test('generateAccessCode produces the documented shape', () => {
  const code = generateAccessCode();
  assert.match(code, /^[^-]{4}(-[^-]{4}){3}$/); // XXXX-XXXX-XXXX-XXXX
  const normalized = normalizeCode(code);
  assert.equal(normalized.length, CODE_CHARS);
  for (const c of normalized) assert.ok(CODE_ALPHABET.includes(c), 'char ' + c);
});

test('generateAccessCode is random (no repeats in 500 draws)', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generateAccessCode());
  assert.equal(seen.size, 500);
});

test('normalizeCode strips separators and casing', () => {
  assert.equal(normalizeCode('k7mf-9q2x-p4td-j8we'), 'K7MF9Q2XP4TDJ8WE');
  assert.equal(normalizeCode('k7mf 9q2x  p4td\nj8we'), 'K7MF9Q2XP4TDJ8WE');
  assert.equal(normalizeCode(''), '');
});

test('formatCode groups and normalizes', () => {
  assert.equal(formatCode('K7MF9Q2XP4TDJ8WE'), 'K7MF-9Q2X-P4TD-J8WE');
  assert.equal(formatCode('k7mf9q2xp4tdj8we'), 'K7MF-9Q2X-P4TD-J8WE');
  assert.equal(formatCode('AB'), 'AB');
});

test('isValidNormalizedCode gates length + alphabet', () => {
  assert.ok(isValidNormalizedCode('K7MF9Q2XP4TDJ8WE'));
  assert.ok(!isValidNormalizedCode('K7MF9Q2XP4TDJ8W')); // short
  assert.ok(!isValidNormalizedCode('K7MF9Q2XP4TDJ8WE0')); // 0 not in alphabet + long
  assert.ok(!isValidNormalizedCode('K7MF9Q2XP4TDJ8OL')); // O and L excluded
});
