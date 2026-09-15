// fuzzy.js — dependency-free fuzzy user matching + ranking.
//
// Pure functions only (no Workers/DOM APIs) so `node --test` can exercise
// them directly. Candidates are narrowed in D1 with LIKE and then scored
// here: exact > prefix > word-prefix > substring > subsequence (typos).

'use strict';

/**
 * Normalize a string for matching: lowercase, strip diacritics/diacritic
 * marks, collapse non-alphanumerics to spaces, trim.
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Is `needle` a case-insensitive in-order subsequence of `haystack`?
 * Tolerates skipped letters ("dvie" ~ "dave").
 * @param {string} needle normalized needle
 * @param {string} haystack normalized haystack
 * @returns {boolean}
 */
function isSubsequence(needle, haystack) {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Bounded Damerau-Levenshtein (optimal string alignment): insert, delete,
 * substitute AND adjacent transpositions count as one edit, so "dvae" is
 * one keystroke away from "dave". Early exit when the budget is blown.
 * @param {string} a
 * @param {string} b
 * @param {number} max distance budget
 * @returns {number} distance, or max + 1 when exceeded
 */
function levenshtein(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0); // row i-2
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1); // transposition
      }
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/**
 * Score how well a normalized query matches a normalized field.
 * Higher is better; 0 means no match.
 * @param {string} q normalized query
 * @param {string} field normalized field
 * @returns {number} 0..100
 */
function scoreMatch(q, field) {
  if (!q || !field) return 0;
  if (q === field) return 100;
  if (field.startsWith(q)) return 90 - Math.min(10, field.length - q.length);
  const words = field.split(' ');
  if (words.some((w) => w.startsWith(q))) return 80;
  if (field.includes(q)) return 70;

  // Tolerate small typos: swap, insert, delete for short queries.
  const budget = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
  const dist = levenshtein(q, field, budget);
  if (dist <= budget) return 60 - dist * 5;

  // Token-level fuzzy: "dave" ~ "davey jones" (whole word close to query).
  for (const w of words) {
    if (Math.abs(w.length - q.length) <= budget && levenshtein(q, w, budget) <= budget) {
      return 50;
    }
  }

  // In-order subsequence ("dvie" ~ "dave"), weakest signal.
  if (q.length >= 3 && isSubsequence(q, field)) return 20;
  return 0;
}

/**
 * A searchable candidate: the two fields we index.
 * @typedef {Object} FuzzyCandidate
 * @property {string} username
 * @property {string} displayName
 */

/**
 * Rank candidates against a raw (un-normalized) query. Returns only
 * candidates with a positive score, best first. Ties keep the input order.
 * @param {string} query raw user input
 * @param {FuzzyCandidate[]} candidates
 * @returns {number[]} matching indices into `candidates`, best first
 */
function rankCandidates(query, candidates) {
  const q = normalize(query);
  if (!q) return [];
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] || {};
    const username = normalize(c.username);
    const display = normalize(c.displayName);
    const s = Math.max(scoreMatch(q, username), scoreMatch(q, display) - 2);
    if (s > 0) scored.push({ i, s });
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.i);
}

export { normalize, scoreMatch, rankCandidates, levenshtein, isSubsequence };
