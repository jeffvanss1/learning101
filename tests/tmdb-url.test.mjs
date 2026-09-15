// Regression tests for the "Invalid API key" detail-click bug (2026-09-13).
//
// The geo-localization change appended ?language=xx-CC before api_key was
// added, with the api_key separator derived from the incoming search only.
// Parameter-less requests (openDetail's /movie/{id}, /tv/{id}, seasons)
// produced `...?language=id-ID?api_key=...`; TMDB read the parameter NAME
// as "?api_key" and rejected every detail click with
// "Invalid API key: You must be granted a valid key" — while feed rows
// (?page=…) kept working, hiding the bug from casual browsing.
//
// buildTmdbUrl (src/tmdburl.js) re-parses + re-serializes the query so
// exactly one '?' ever reaches upstream. These tests pin that contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTmdbUrl, looksLikeToken } from '../src/tmdburl.js';

const ORIGIN = 'https://api.themoviedb.org/3';
const V3 = 'abc123def456'; // plain v3 key
const V4 = 'ey' + 'a'.repeat(80) + '.ey' + 'b'.repeat(80) + '.sig';

test('looksLikeToken distinguishes v3 keys from v4 bearer tokens', () => {
  assert.equal(looksLikeToken(V3), false);
  assert.equal(looksLikeToken(V4), true);
});

test('REGRESSION: parameter-less detail URLs carry api_key and language with one "?"', () => {
  // What openDetail clicks: /movie/{id} with NO query.
  const url = buildTmdbUrl(ORIGIN, '/movie/420818', '', V3, 'id-ID');
  assert.ok(!url.includes('??'), 'double ? must never appear: ' + url);
  assert.equal(url.split('?').length, 2, 'exactly one ? allowed');
  const params = new URL(url).searchParams;
  assert.equal(params.get('api_key'), V3, 'api_key must survive as a real parameter');
  assert.equal(params.get('language'), 'id-ID');
});

test('REGRESSION: the broken pre-fix shape can never be produced', () => {
  const url = buildTmdbUrl(ORIGIN, '/movie/1', '', V3, 'de-DE');
  assert.ok(!url.includes('?language=..?api_key') && !/\?[a-z_]+=\S*\?api_key/.test(url));
  assert.ok(!/\?[^\s]*\?/.test(url.split('?').slice(1).join('?').slice(1)), 'no stray ? inside the query');
});

test('existing queries keep their parameters (feed rows still work)', () => {
  const url = buildTmdbUrl(ORIGIN, '/movie/popular', '?page=2', V3, 'id-ID');
  const params = new URL(url).searchParams;
  assert.equal(params.get('page'), '2');
  assert.equal(params.get('api_key'), V3);
  assert.equal(params.get('language'), 'id-ID');
  assert.ok(url.startsWith(ORIGIN + '/movie/popular?'));
});

test('v4 bearer tokens are NOT embedded (they go in the Authorization header)', () => {
  const url = buildTmdbUrl(ORIGIN, '/movie/420818', '', V4, 'en-US');
  const params = new URL(url).searchParams;
  assert.equal(params.get('api_key'), null);
  assert.equal(params.get('language'), 'en-US');
});

test('no language requested -> no language parameter (anime resolution path)', () => {
  const url = buildTmdbUrl(ORIGIN, '/tv/1234', '', V3);
  assert.equal(new URL(url).searchParams.get('language'), null);
  assert.equal(new URL(url).searchParams.get('api_key'), V3);
});
