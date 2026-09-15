// code.js — human-friendly unique access codes ("seeds").
//
// Format: XXXX-XXXX-XXXX-XXXX over an unambiguous alphabet (no 0/O/1/I/L),
// 32^16 ≈ 1.2e24 possibilities — brute force is not a concern, and the
// alphabet reads cleanly over voice or chat.
//
// Pure module (node --test-able; Workers + Node 22 both ship globalThis.crypto).

'use strict';

/** Unambiguous alphabet: no 0/O, 1/I/L, U (avoids hand-writing confusion). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const CODE_CHARS = 16; // 4 groups of 4

/**
 * Generate a fresh code like "K7MF-9Q2X-P4TD-J8WE".
 * 32 divides 256, so `% alphabet.length` has no modulo bias.
 * @returns {string}
 */
export function generateAccessCode() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || !cryptoObj.getRandomValues) {
    throw new Error('Web Crypto unavailable');
  }
  const bytes = new Uint8Array(CODE_CHARS);
  cryptoObj.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return formatCode(s);
}

/**
 * Normalize any user-typed code: uppercase, strip separators/spaces.
 * "k7mf 9q2x p4td j8we" → "K7MF9Q2XP4TDJ8WE"
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Group a normalized code into display form (XXXX-XXXX-XXXX-XXXX).
 * @param {string} normalized
 * @returns {string}
 */
export function formatCode(normalized) {
  const s = normalizeCode(normalized);
  return (s.match(/.{1,4}/g) || []).join('-');
}

/**
 * Is a normalized code well-formed (right length, valid alphabet)?
 * @param {string} normalized
 * @returns {boolean}
 */
export function isValidNormalizedCode(normalized) {
  return (
    normalized.length === CODE_CHARS &&
    [...normalized].every((c) => CODE_ALPHABET.includes(c))
  );
}
