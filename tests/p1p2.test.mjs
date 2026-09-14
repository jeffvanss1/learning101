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
  assert.match(a, /curEp \+ 1 > Number\(s\.episode_count \|\| 0\)/, 'next episode verified against the TMDB season count (no ghost episodes)');
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
  assert.match(routerSrc(), /WORKER_BUILD = 'api-2026-09-14\.57';/, 'api stamp bumped');
});
