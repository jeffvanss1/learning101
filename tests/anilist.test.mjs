// Anime pipeline: TMDB ⇄ AniList matching must survive non-Latin titles.
// Regression (2026-09-14): normalizeTitle erased kana/kanji ([^a-z0-9]), so a
// Japanese-locale TMDB title (ジョジョの奇妙な冒険) could never match AniList's
// title.native -> anilistId:null -> the anime page said it has no movie.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, matchAnilist, classifyIsAnime } from '../src/anilist.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
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
  assert.ok(cat.includes("wp:anilist:v4:"), 'localStorage prefix v4 (v3 held 7-day nulls)');
  assert.ok(cat.includes("'?v=3'"), 'endpoint query ?v=3 (v2 responses may hold stale misses)');
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

test('presence PUT never throws raw - KV failures become named 500 json', async () => {
  const { register } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  register(new URL('./tsresolve.mjs', import.meta.url));
  const mod = await import(pathToFileURL(ROOT + '/src/routes/presence.ts').href + '?v=' + Math.random());
  const auth = await import(pathToFileURL(ROOT + '/src/auth.ts').href + '?v=' + Math.random());
  const env = {
    SESSION_SECRET: 's',
    PRESENCE_KV: {
      get: async () => null,
      put: async () => {
        throw new Error('KV namespace not found (simulated)');
      },
      delete: async () => {},
    },
  };
  const token = await auth.issueToken(env, { id: 'u-9', username: 'x' });
  const req = new Request('https://x/api/presence', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ status: 'IDLE' }),
  });
  const res = await mod.handlePresencePut(req, env);
  const body = await res.json();
  assert.equal(res.status, 500, 'named 500, not a raw throw');
  assert.equal(body.error, 'presence beat failed');
  assert.ok(/KV namespace not found/.test(body.detail), 'detail names the cause: ' + body.detail);

  // The self-check reports the broken step instead of dying.
  const self = await mod.handlePresenceSelf(
    new Request('https://x/api/presence/self', { headers: { Authorization: 'Bearer ' + token } }),
    env
  );
  const selfBody = await self.json();
  assert.equal(selfBody.ok, false);
  assert.ok(/FAILED/.test(selfBody.steps.kvPut), 'self-check names the step: ' + JSON.stringify(selfBody.steps));
});

test('people search: short-query gate + avatar size classes exist', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const search = readFileSync(join(ROOT, 'src/routes/search.ts'), 'utf8');
  assert.equal(/q\.length <= 2/.test(search), true, '1-2 char queries take the relevance-gated path');
  assert.equal(/NO widening scan/.test(search), true, 'short queries skip the 500-user widening');
  const soc = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  assert.equal(/\.avatar--lg\s*{/.test(soc), true, 'avatar--lg is actually defined (was silently 40px)');
  assert.equal(/\.avatar--xl\s*{/.test(soc), true, 'avatar--xl is actually defined (profile hero was small too)');
});

test('people results section fills the browse row (horizontal grid on desktop)', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const css = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  // .people-results is a flex child of .browse__rows (column flex); its auto
  // margins defeat stretch, so it MUST carry an explicit width or the grid
  // collapses to a single ~340px vertical column.
  const block = css.slice(css.indexOf('.people-results {'), css.indexOf('.people-results__title'));
  assert.equal(/width:\s*100%/.test(block), true, '.people-results must be width:100% inside the flex column');
  const list = css.slice(css.indexOf('.people-results__list {'), css.indexOf('.people-results__hint'));
  assert.equal(/repeat\(auto-fill,\s*minmax\(340px,\s*1fr\)\)/.test(list), true, 'grid columns must be auto-fill');
});

test('brand mark is the infinity logo; player play controls untouched', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  const favicon = readFileSync(join(ROOT, 'dist/favicon.svg'), 'utf8');
  const brandCount = (html.match(/M12 12C10 7\.5 4 7\.5 4 12S10 16\.5 12 12/g) || []).length;
  assert.equal(brandCount, 2, 'topnav + room brand marks carry the infinity path');
  assert.equal(/M12 12C10 7\.5/.test(favicon), true, 'favicon carries the infinity path');
  assert.equal(/5 3 19 12 5 21/.test(favicon), false, 'favicon no longer has the play triangle');
  // The PLAY CONTROLS must keep their triangle (2 in html + 1 in app.js).
  assert.equal((html.match(/5 3 19 12 5 21/g) || []).length, 2, 'player play icons untouched in html');
  const app = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.equal(/5 3 19 12 5 21/.test(app), true, 'play/pause toggle untouched in app.js');
});

// ---- Boruto regression (2026-09-14): "couldn't match on AniList" ----
// REAL TMDB record (verified live on themoviedb.org/tv/70881):
//   name "Boruto: Naruto Next Generations",
//   original_name "BORUTO-ボルト- NARUTO NEXT GENERATIONS", first aired 2017-04-05.
// Two stacked bugs: (1) the worker searched ONLY original_name - AniList's
// SEARCH_MATCH handles the mixed-script string worse than the romaji name;
// (2) BOTH client caches stored UNRESOLVED results for 7 DAYS, so one
// transient blip poisoned the title for a week. Fix: dual-variant search +
// misses live 5 minutes. (The AniList-side behavior can be eyeballed in the
// graph.anilist.co playground with the query in README.)

test('matchAnilist: Boruto (real TMDB 70881 record) matches AniList romaji/native + year', () => {
  const show = {
    id: 70881,
    name: 'Boruto: Naruto Next Generations',
    original_name: 'BORUTO-ボルト- NARUTO NEXT GENERATIONS',
    first_air_date: '2017-04-05',
    genres: [{ id: 16, name: 'Animation' }],
    origin_country: ['JP'],
  };
  // AniList-shaped candidates: Boruto + the decoys a search could plausibly return.
  const media = [
    { id: 20, title: { romaji: 'Naruto', english: 'Naruto', native: 'NARUTO' }, episodes: 220, startDate: { year: 2002 } },
    { id: 1735, title: { romaji: 'Naruto: Shippuuden', english: 'Naruto: Shippuden', native: 'NARUTO-ナルト- 疾風伝' }, episodes: 500, startDate: { year: 2007 } },
    { id: 131573, title: { romaji: 'Boruto: Naruto Next Generations', english: 'Boruto: Naruto Next Generations', native: 'BORUTO-ボルト- NARUTO NEXT GENERATIONS' }, episodes: 293, startDate: { year: 2017 } },
  ];
  const best = matchAnilist(show, media);
  assert.ok(best, 'Boruto must match');
  assert.equal(best.id, 131573, 'matched Boruto, not a Naruto decoy');
  assert.equal(best.episodes, 293);
  // And with the native title alone as the only candidate (worst case the
  // original_name search returns ONLY the native-scripted entry):
  const best2 = matchAnilist(show, [media[2]]);
  assert.ok(best2 && best2.id === 131573, 'native-only candidate still matches');
});

test('boruto fix wiring: dual-variant search + short-lived misses (both caches)', () => {
  const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  assert.match(worker, /variants = Array\.from\(new Set\(\[show\.name, show\.original_name\]/, 'BOTH variants, name first, SEQUENTIAL (parallel 2x load rate-limited the feed)');
  assert.match(worker, /for \(const s of variants\) \{\s*if \(best\) break;/, 'second variant fires only on a miss');
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  assert.match(cat, /wp:anilist:v4:/, 'cache prefix bumped (v3 entries hold 7-day nulls)');
  assert.match(cat, /\/api\/anilist\/' \+ encodeURIComponent\(tmdbId\) \+ '\?v=3'/, 'endpoint buster bumped');
  assert.match(cat, /ANILIST_NULL_TTL_MS = 5 \* 60 \* 1000/, 'misses TTL = 5 minutes');
  assert.match(cat, /o\.data && o\.data\.anilistId != null \? ANILIST_CACHE_TTL_MS : ANILIST_NULL_TTL_MS/, 'worker-path cache picks TTL by resolved-ness');
  assert.match(cat, /o\.data && o\.data\.id != null \? ANILIST_CACHE_TTL_MS : ANILIST_NULL_TTL_MS/, 'direct fallback cache picks TTL by resolved-ness');
});

test('unmatched anime degrades to TMDB seasons (tv path) - the dead end is GONE', () => {
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  assert.equal(cat.includes("couldn't match it on AniList"), false, 'dead-end message deleted');
  assert.equal(/renderAnimeUnresolved/.test(cat), false, 'dead-end renderer deleted');
  assert.match(cat, /item\.isAnime = false;\s*item\.type = 'tv';\s*renderDetailBody\(body, item, extra, extra\.seasons \|\| \[\], onPick, close\);/, 'unmatched anime renders the REAL TMDB season picker (chips + grids, tv path)');
  // matched anime still uses the absolute AniList grid:
  assert.match(cat, /renderAnimeBody\(body, item, extra, \{ episodes: episodes, malId: malId \}/, 'matched anime unchanged');
  const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  assert.match(worker, /ANIME_TTL_MS : 15 \* 1000/, 'worker caches FAILURES only 15 seconds');
  assert.equal((worker.match(/max-age=15'/g) || []).length, 2, 'failure Cache-Control 15s (both sites)');
});
