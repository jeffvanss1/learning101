// P1 + P2: resume/auto-advance/history-unification + reconnect surfacing,
// rate limits, security headers, per-item history remove + filters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { ROOT } from './dompath.mjs';

register(new URL('./tsresolve.mjs', import.meta.url));

const app = () => readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
const utilsSrc = () => readFileSync(join(ROOT, 'dist/js/utils.js'), 'utf8');
const workerSrc = () => readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
const routerSrc = () => readFileSync(join(ROOT, 'src/router.ts'), 'utf8');

test('resume: playback position saved, history card resumes, red progress bar', async () => {
  const a = app();
  assert.match(a, /function saveWatchProgress\(/, 'progress saver exists');
  assert.match(a, /sync\.on\('progress', \(\{ time, playing, duration \}\) => \{\s*updatePlayerControls\(playing\);\s*if \(state\.presence\) state\.presence\.syncProgress\(time\);\s*saveWatchProgress\(/, 'progress wiring feeds the saver');
  assert.match(a, /if \(now - \(state\._lastProgAt \|\| 0\) < 8000\) return;/, 'progress save is throttled (~8s)');
  assert.match(utilsSrc(), /function historySetProgress\(/, 'utils: progress writer');
  assert.match(a, /state\._pendingResume = video && Number\(video\.position\) > 60 \? Number\(video\.position\) : null;/, 'history click arms resume (>60s in only)');
  assert.match(a, /if \(resumeAt && canControl\(\)\) \{\s*setTimeout\(\(\) => \{\s*if \(state\.sync\) state\.sync\.localPlay\(resumeAt\);/, 'resume = seek+play+adopt+broadcast (localPlay)');
  assert.doesNotMatch(a, /state\.sync\.seek\(/, 'RAW seek() is BANNED in app.js - it never tells the room (endless-pause-cycle bug)');
  assert.match(readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8'), /\.history-card__progress-fill \{[^}]*background: var\(--red\)/, 'YouTube-style red progress bar');
});

test('auto-advance: real ended signal, next-episode offer with cancel, guests get a hint', async () => {
  const a = app();
  const p = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  assert.match(p, /this\.emit\('ended', \{ time: this\.localTime, duration: this\.duration \}\);/, "player emits an unambiguous 'ended'");
  assert.match(a, /sync\.on\('ended', \(\) => onEpisodeEnded\(\)\);/, 'app reacts to ended');
  assert.match(a, /function showUpNext\(/, 'up-next overlay');
  assert.match(a, /Play now/, 'Play now button');
  assert.match(a, /function clearUpNext\(\)/, 'cancel/cleanup path');
  assert.match(a, /if \(!canControl\(\)\) \{\s*if \(!state\._endedToasted\) \{\s*state\._endedToasted = true;\s*toast\('Episode ended/, 'guests get a one-time hint instead of the overlay');
  assert.match(a, /function resolveNextEpisode\(/, 'next-episode resolver (REAL season list for tv, jikan/MAL for anime)');
  assert.match(a, /clearUpNext\(\);\s*state\._lastProgAt = 0;/, 'video changes reset the up-next state');
});

test('history unification: server list merges in, local wins; filters + per-item remove', async () => {
  const a = app();
  const s = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(s, /function getServerHistory\(\)/, 'server history reader');
  assert.match(s, /global\.WP\.Social = \{[\s\S]*?getServerHistory,/, 'exported');
  assert.match(a, /const extras = server\s*\.filter\(\(h\) => !seen\.has\(/, 'server entries only fill gaps (local wins)');
  assert.match(a, /state\._historyServerTried = true;/, 'one fetch per page visit');
  assert.match(a, /function renderHistoryChips\(/, 'filter chips');
  assert.match(a, /'movie', 'Movies'/, 'Movies filter');
  assert.match(a, /WP\.historyRemove\(WP\.historyKey\(v\)\)/, 'per-item remove');
  assert.match(utilsSrc(), /function historyRemove\(/, 'utils: remove');
  assert.match(utilsSrc(), /historyKey,/, 'historyKey exported');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /id="history-filters"/, 'filter chip host exists');
});

test('reconnect: drops are surfaced with toasts, recovery confirmed', async () => {
  const a = app();
  assert.match(a, /client\.on\('reconnecting', \(\) => \{[\s\S]*?toast\('Connection lost/, 'drop toast');
  assert.match(a, /if \(state\._connDropped\) \{\s*state\._connDropped = false;\s*toast\('Connection restored\.'\);/, 'recovery toast');
  assert.match(a, /state\._connDropped = false;\s*if \(state\._sidenavAuto/, 'state resets on teardown');
});

test('rate limits: auth/claim/code/admin are KV-damped and fail open', async () => {
  const r = routerSrc();
  assert.equal((r.match(/await kvRateLimit\(env, '/g) || []).length, 4, 'applied to session + claim + code + admin');
  assert.match(r, /'claim:' \+ clientIp\(request\), 20, 300/, 'claim: 20/5min (code-guessing damper)');
  assert.match(r, /return true; \/\/ fail open, always/, 'KV failure never takes the API down');
  const { kvRateLimit } = await import(
    pathToFileURL(join(ROOT, 'src/router.ts')).href + '?v=' + Date.now()
  );
  const store = new Map();
  const kv = {
    async get(k) { return store.get(k) ?? null; },
    async put(k, v) { store.set(k, v); },
  };
  const env = /** @type {any} */ ({ PRESENCE_KV: kv });
  for (let i = 0; i < 5; i++) {
    assert.equal(await kvRateLimit(env, 't1', 5, 60), true, 'hit ' + (i + 1) + ' allowed');
  }
  assert.equal(await kvRateLimit(env, 't1', 5, 60), false, 'hit 6 blocked');
  assert.equal(await kvRateLimit(env, 't2', 5, 60), true, 'other keys unaffected');
  assert.equal(await kvRateLimit(/** @type {any} */ ({}), 't3', 1, 60), true, 'missing KV fails open');
});

test('server history endpoint: GET returns the signed-in user list', async () => {
  const { handleGetHistory } = await import(
    pathToFileURL(join(ROOT, 'src/routes/users.ts')).href + '?v=' + Date.now()
  );
  const rows = [
    { media_id: '123', media_type: 'tv', media_title: 'One Piece', poster_url: '/p.jpg', season: 14, episode: 5, completed: 0, watched_at: 111 },
  ];
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() { return { results: rows }; },
          };
        },
      };
    },
  };
  const res = await handleGetHistory(new Request('https://x/api/user/history'), /** @type {any} */ ({ DB: db }), /** @type {any} */ ({ id: 'u1' }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].mediaId, '123');
  assert.equal(data.items[0].mediaType, 'tv');
  assert.equal(data.items[0].season, 14);
  assert.equal(data.items[0].completed, false);
});

test('security headers: every page and API response is hardened', async () => {
  const w = workerSrc();
  assert.match(w, /'X-Content-Type-Options': 'nosniff'/, 'nosniff');
  assert.match(w, /'Referrer-Policy': 'strict-origin-when-cross-origin'/, 'referrer policy');
  assert.match(w, /microphone=\(\)/, 'permissions policy (mic explicitly off)');
  assert.match(w, /frame-src https:\/\/bingr\.one https:\/\/www\.youtube\.com/, 'player + trailer frames allowlisted');
  assert.match(w, /connect-src 'self' wss: https:\/\/graph\.anilist\.org/, 'WS + AniList fallback allowed');
  assert.match(w, /frame-ancestors 'self'/, 'no third-party framing');
  assert.match(w, /\.\.\.securityHeaders\(\),/, 'json() inherits them');
  assert.match(w, /for \(const \[k, v\] of Object\.entries\(securityHeaders\(\)\)\) res\.headers\.set\(k, v\);/, 'static assets are wrapped');
  assert.match(routerSrc(), /WORKER_BUILD = 'api-2026-09-14\.64';/, 'api stamp bumped');
});


// ---- AniList-native anime data (Jikan removed: API is being discontinued) ----

test('anilist-native: no jikan remnants; anime counts + auto-advance run on AniList', async () => {
  const fs = await import('node:fs');
  for (const f of ['src/router.ts', 'dist/js/catalog.js', 'dist/js/app.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.equal((src.match(/jikan/gi) || []).length, 0, f + ': zero jikan references');
  }
  assert.ok(!fs.existsSync(join(ROOT, 'src/routes/jikan.ts')), 'jikan route file deleted');
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  // AniList-native contracts that replaced it:
  assert.match(cat, /async function anilistApi\(tmdbId\)/, 'worker AniList resolve (battle-tested)');
  assert.match(a, /WP\.Catalog\.anilistApi\(v\.id\)/, 'auto-advance uses the AniList resolve');
  assert.match(a, /info && info\.episodes != null \? Number\(info\.episodes\) : null/, 'canonical AniList count');
  assert.match(a, /unknown total - never offer a ghost episode/, 'unknown totals refuse to advance');
  // The data-correctness fixes from the Jikan round SURVIVE on AniList:
  assert.match(cat, /Episode list unavailable right now/, 'broken TMDB anime grid never renders with an AniList id');
  assert.match(a, /e\.episode_type !== 'special'/, 'TV specials skipped');
  assert.match(a, /episode: 1 \};/, 'season finale -> next season E1');
});

test('mobile/desktop readiness: dvh viewports, touch-visible controls, responsive overlays', () => {
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  const catalog = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  const social = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  assert.equal((style.match(/min-height: 100dvh;/g) || []).length, 1, 'dvh page height (iOS toolbar-safe)');
  assert.match(style, /height: 100dvh;/, 'dvh room height');
  assert.match(catalog, /min-height: 100dvh;/, 'dvh browse height');
  assert.match(social, /calc\(100dvh - var\(--topnav-h\)/, 'dvh friends rail');
  assert.match(catalog, /@media \(hover: none\) \{[\s\S]*\.history-card__remove \{\s*opacity: 1;/, 'per-item remove visible on touch');
  assert.match(catalog, /@media \(hover: none\) \{[\s\S]*\.card-item__like \{\s*opacity: 1 !important;/, 'card hearts visible on touch');
  assert.match(catalog, /@media \(hover: none\) \{[\s\S]*\.btn--sm \{\s*min-height: 38px;/, 'touch targets >= 38px');
  assert.match(style, /@media \(max-width: 560px\) \{\s*\.up-next \{/, 'up-next overlay fits small screens');
});

test('anilist burst control: feed classification is bounded (no mass rate-limit)', () => {
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  const block = cat.match(/async function classifyAnime\([\s\S]*?\n  \}/);
  assert.ok(block, 'classifyAnime exists');
  assert.doesNotMatch(block[0], /await Promise\.all\(\s*tvs\.map/, 'NO parallel fan-out over all titles');
  assert.match(block[0], /Promise\.all\(\[run\(\), run\(\), run\(\)\]\)/, 'exactly 3 concurrent resolvers');
  assert.match(block[0], /await sleep\(150\)/, 'staggered requests');
});
