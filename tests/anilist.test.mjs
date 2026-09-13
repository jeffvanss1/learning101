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
