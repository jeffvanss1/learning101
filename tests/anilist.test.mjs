// Anime pipeline: TMDB ⇄ AniList matching must survive non-Latin titles.
// Regression (2026-09-14): normalizeTitle erased kana/kanji ([^a-z0-9]), so a
// Japanese-locale TMDB title (ジョジョの奇妙な冒険) could never match AniList's
// title.native -> anilistId:null -> the anime page said it has no movie.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, matchAnilist, classifyIsAnime } from '../src/anilist.js';
import { ROOT } from './dompath.mjs';

test('normalizeTitle keeps CJK/kana (unicode letters, not a-z0-9)', () => {
  // Voiced kana folds deterministically (NFKD + combining-mark strip) —
  // the SAME fold runs on both sides of every comparison, so identity holds.
  assert.equal(normalizeTitle('ジョジョの奇妙な冒険'), 'ショショの奇妙な冒険');
  assert.equal(normalizeTitle('  Attack on Titan!  '), 'attack on titan');
  assert.equal(normalizeTitle('Café'), 'cafe');
  assert.equal(normalizeTitle(''), '');
});

test('matchAnilist: Japanese-native TMDB title matches AniList native title (JoJo)', () => {
  const show = {
    id: 31918,
    name: "JoJo's Bizarre Adventure",
    original_name: 'ジョジョの奇妙な冒険',
    first_air_date: '2012-10-05',
    genres: [{ id: 16, name: 'Animation' }],
    origin_country: ['JP'],
  };
  const media = [
    { id: 14719, title: { romaji: 'JoJo\u2019s Bizarre Adventure (TV)', english: 'JoJo\u2019s Bizarre Adventure', native: 'ジョジョの奇妙な冒険', }, episodes: 26 },
    { id: 66, title: { romaji: 'Naruto', english: 'Naruto', native: 'NARUTO' }, episodes: 220 },
  ];
  const best = matchAnilist(show, media);
  assert.ok(best, 'must find a match');
  assert.equal(best.id, 14719, 'matched the JoJo entry');
  assert.equal(best.episodes, 26);
});

test('matchAnilist: native-script TMDB titles still lose to nothing (matching works when ONLY native exists)', () => {
  const show = { id: 1, name: 'ワンピース', original_name: 'ワンピース', first_air_date: '1999-10-20' };
  const media = [{ id: 21, title: { romaji: 'One Piece', english: 'One Piece', native: 'ワンピース' }, episodes: null }];
  const best = matchAnilist(show, media);
  assert.ok(best && best.id === 21, 'native==native exact match wins');
});

test('classifyIsAnime: animation + JP still classifies (sanity)', () => {
  const show = { genres: [{ name: 'Animation' }], origin_country: ['JP'] };
  assert.equal(classifyIsAnime(show, { results: [] }), true);
});

test('anime fix wiring: versioned endpoint (edge-bust), v3 cache, English catalog titles', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  assert.ok(cat.includes("wp:anilist:v3:"), 'localStorage prefix v3 (busts poisoned entries)');
  assert.ok(cat.includes("'?v=2'"), 'endpoint query ?v=2 (never-hit URL: the edge cached the old nulls for 7 days)');
  const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  assert.ok(worker.includes("proxyTmdb(rest, url.search, apiKey, 'en-US')"), 'catalog titles pinned to English');
  assert.ok(worker.includes("public, max-age=300"), 'unresolved lookups get a SHORT edge TTL (fixes propagate)');
});

test('presence wiring: no pagehide DELETE beacon (mobile backgrounding erased users)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const soc = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.equal(/addEventListener\('pagehide'/.test(soc), false, 'pagehide beacon removed');
  assert.equal(/pageshow/.test(soc), true, 'pageshow re-beat kept (bfcache restores re-appear online)');
  const presence = readFileSync(join(ROOT, 'src/presence.ts'), 'utf8');
  assert.equal(/IDLE_PRESENCE_TTL_S = 3600/.test(presence), true, 'idle TTL 1h');
});
