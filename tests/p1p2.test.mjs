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
  assert.equal((r.match(/await kvRateLimit\(env, '/g) || []).length, 5, 'applied to session + claim + code + admin + jikan');
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
  assert.match(routerSrc(), /WORKER_BUILD = 'api-2026-09-14\.60';/, 'api stamp bumped');
});

// ---- Jikan (MAL) integration: accurate anime episodes + true next-episode ----

test('jikan: worker proxy throttles, caches, normalizes; anilist returns malId', async () => {
  const w = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  assert.match(w, /malId = best\.idMal \|\| null;/, 'anilist match carries the MAL id');
  assert.match(w, /return \{ anime: true, anilistId, malId, episodes, title \};/, 'resolve payload includes malId');
  const jikan = readFileSync(join(ROOT, 'src/routes/jikan.ts'), 'utf8');
  assert.match(jikan, /\$\{JIKAN_ORIGIN\}\/anime\/\$\{malId\}\/episodes\?page=\$\{page\}/, 'official v4 episodes endpoint');
  assert.match(jikan, /secCount >= 2 \|\| minCount >= 50/, 'token bucket UNDER the 3/s + 60/min upstream limits');
  assert.match(jikan, /errorJson\(429, 'Jikan rate budget spent/, 'fail-soft 429 (client falls back, never breaks)');
  assert.match(jikan, /'Cache-Control': 'public, max-age=21600'/, 'edge cache 6h');
  const r = routerSrc();
  assert.match(r, /\/api\\\/jikan\\\/anime\\\/\(\[\^\/\]\+\)\\\/episodes/, 'routed');
  assert.match(r, /'jikan:' \+ clientIp\(request\), 60, 60/, 'IP-damped');
});

test('jikan route: normalization + cache + throttle + validation (runtime)', async () => {
  const { handleJikanEpisodes } = await import(
    pathToFileURL(join(ROOT, 'src/routes/jikan.ts')).href + '?v=' + Date.now()
  );
  const calls = [];
  const realFetch = globalThis.fetch;
  // @ts-ignore - test stub
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        data: [
          { mal_id: 1, title: 'Romance Dawn', filler: false, recap: false, aired: '1999-10-20' },
          { mal_id: 2, title: 'Appear! Zoro the Swordsman' },
          { mal_id: 3, title: null },
        ],
        pagination: { last_visible_page: 7 },
      }),
      { status: 200 }
    );
  };
  try {
    const env = /** @type {any} */ ({});
    const r1 = await handleJikanEpisodes(new Request('https://x/'), env, '21', '1');
    assert.equal(r1.status, 200);
    const d1 = await r1.json();
    assert.equal(d1.episodes.length, 3);
    assert.equal(d1.episodes[0].number, 1);
    assert.equal(d1.episodes[0].title, 'Romance Dawn');
    assert.equal(d1.episodes[2].title, '');
    assert.equal(d1.lastPage, 7);
    assert.equal(calls.length, 1, 'one upstream call');
    await handleJikanEpisodes(new Request('https://x/'), env, '21', '1');
    assert.equal(calls.length, 1, 'SERVED FROM CACHE (second call hits nothing upstream)');
    const bad = await handleJikanEpisodes(new Request('https://x/'), env, 'abc', '1');
    assert.equal(bad.status, 422, 'invalid MAL id rejected');
    // throttle: burn the per-second budget (2) then expect 429, not an upstream call
    calls.length = 0;
    let throttled = false;
    for (let i = 0; i < 6; i++) {
      const r = await handleJikanEpisodes(new Request('https://x/'), env, '9000' + i, '1');
      if (r.status === 429) throttled = true;
    }
    assert.ok(throttled, 'budget exhausts to a soft 429 (never hammers Jikan)');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('anime pipeline: jikan helpers, MAL ids flow through history + picks', async () => {
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  const u = readFileSync(join(ROOT, 'dist/js/utils.js'), 'utf8');
  assert.match(cat, /async function jikanEpisodes\(malId\)/, 'full episode list helper');
  assert.match(cat, /async function jikanCount\(malId\)/, 'cheap count helper');
  assert.match(cat, /wp:jikan:/, 'localStorage cache (24h)');
  assert.match(cat, /function applyJikanNames\(/, 'MAL titles patched onto .ep-btn nodes');
  assert.match(cat, /malId: item\.malId != null \? String\(item\.malId\) : null/, 'buildVideo carries malId');
  assert.match(cat, /if \(jikanEps && jikanEps\.length\) episodes = jikanEps\.length;/, 'room modal uses the TRUE MAL count (JoJo-class bugs)');
  assert.match(cat, /renderAnimeBody\(body, item, extra, \{ episodes: episodes, malId: malId \}/, 'detail page gets malId for enrichment');
  assert.match(u, /malId: video\.malId != null \? video\.malId : null/, 'history keeps malId (auto-advance after restart)');
  // Auto-advance data-correctness:
  assert.match(a, /\/season\/' \+ curSeason\)\s*\.then/, 'TV next-ep uses the SEASON DETAIL list (episode_count metadata lies - TWD E14 bug)');
  assert.match(a, /e\.episode_type !== 'special'/, 'specials skipped');
  assert.match(a, /episode: 1 \};/, 'season finale -> next season E1');
  assert.match(a, /WP\.Catalog\.jikanCount\(v\.malId\)/, 'anime next-ep from MAL');
  assert.match(a, /series finale|series finale/, 'no ghost advance at the end');
});
