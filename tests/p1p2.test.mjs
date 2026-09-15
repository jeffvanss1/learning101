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
  assert.match(a, /function tryResume\(\)/, 'resume is a RETRYING helper');
  assert.match(a, /state\._pendingResume = null; \/\/ consumed exactly once, successfully/, 'consumed only when the room is drivable');
  assert.match(a, /if \(state\.isOwner \|\| state\.amAllowed\) tryResume\(\);/, 'late host ack re-triggers resume');
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
  assert.match(a, /SERVER-FIRST \(user directive\)/, 'account history is the source of truth (server-first)');
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
  assert.match(routerSrc(), /WORKER_BUILD = 'api-2026-09-14\.71';/, 'api stamp bumped');
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

test('auto next: toggle in the player bar (device pref), honored as the FIRST gate', () => {
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  assert.match(html, /id="auto-next"/, 'toggle exists in video-actions');
  assert.match(html, /id="auto-next-label"/, 'stateful label');
  assert.match(a, /const AUTO_NEXT_KEY = 'wp:autonext';/, 'device-persisted pref');
  assert.match(a, /function autoNextOn\(\)/, 'reader (default ON)');
  assert.match(a, /function setAutoNext\(on\)/, 'writer');
  assert.match(a, /autoBtn\.onclick = \(\) => setAutoNext\(!autoNextOn\(\)\);/, 'wired in initRoomUI');
  assert.match(a, /if \(!autoNextOn\(\)\) \{\s*clearUpNext\(\);\s*return;/, 'OFF = the ended episode just stops (first gate)');
  assert.match(a, /function paintAutoNext\(\)/, 'label/paint kept in sync');
  assert.match(style, /#auto-next\.is-on \{/, 'visual on-state');
});

test('derived end: poll-based detection with once-per-load dedupe', () => {
  const p = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  assert.match(p, /_endedFired = false; \/\/ fresh video: end detection re-arms/, 're-armed on load');
  assert.match(p, /DERIVED END: some embeds never post an 'ended' event/, 'derived detector present');
  assert.match(p, /this\.duration - d\.currentTime <= 2\.5/, 'within 2.5s of the end');
  assert.match(p, /if \(!this\._endedFired\) \{\s*this\._endedFired = true;\s*this\.emit\('ended'/, 'explicit event deduped against the derived one');
});

test('seek-war guards: convergence self-suppression + DO log dedupe window', () => {
  const p = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  assert.match(p, /HOST SOVEREIGNTY \(user directive\)/, 'sovereignty gate precedes the war guard');
  assert.match(p, /if \(Date\.now\(\) - this\._suppressed < 1500\) return;/, 'controller skips corrections within 1.5s of its own command (fresh-load path)');
  const wr = readFileSync(join(ROOT, 'src/WatchRoom.js'), 'utf8');
  assert.match(wr, /now\(\) - lastSeek\.at > 4000/, 'seek-log dedupe window 4s (the 1.5s window let wars flood the chat)');
});

test('phantom-pause kill chain: start latch + 2-observation pause mirror + buffering quiet', () => {
  const p = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  assert.match(p, /MIRROR_PAUSE_CONFIRMATIONS = 2/, 'a pause needs 2 independent observations');
  assert.match(p, /MIRROR_PAUSE_MIN_AGE_MS = 500/, 'and must persist past the min age');
  assert.match(p, /START_LATCH_MS = 8000/, 'start latch is bounded');
  assert.match(p, /MIRROR_BUFFERING_QUIET_MS = 1500/, 'pause mirror needs a buffering-free runway');
  assert.match(p, /!playing && this\._awaitingStart && now - this\._playCmdAt < START_LATCH_MS/, 'boot lag never mirrors a pause');
  assert.match(p, /this\._awaitingStart = true; \/\/ until the embed confirms playing/, 'latch armed on our play command');
  assert.match(p, /this\._awaitingStart = false; \/\/ the embed confirmed play/, 'latch cleared on the first playing confirmation');
  assert.match(p, /if \(!playing\) this\._requestStatus\(\);/, 'pause candidate fetches fresh evidence immediately');
  assert.match(p, /if \(newEvidence\) this\._mirrorCandidate\.confirmations\+\+/, 'only real status arrivals accumulate evidence');
  assert.match(p, /this\._lastBufferingAt = Date\.now\(\);/, 'buffering recency recorded');
  assert.match(p, /this\._lastStatus = \{ time: -1, at: 0 \}; \/\/ stale baseline = bogus native-seek/, 'loadVideo resets the native-seek baseline');
  assert.match(p, /this\._syncToTarget\(\); \/\/ discrete events bypassed convergence entirely/, 'discrete play events converge');
});

test('DO hardening: play/pause/seek without a usable time keep the current position (never snap to 0)', () => {
  const wr = readFileSync(join(ROOT, 'src/WatchRoom.js'), 'utf8');
  assert.equal(wr.match(/Number\.isFinite\(rawT\) \? this\.clampTime\(rawT\) : this\.playback\.time/g)?.length, 3, 'guard on all three: PLAY, PAUSE, SEEK');
});

test('minimal shape pass: no oval buttons — flat radii, circles only where they mean circle', () => {
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  const catalog = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  const social = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  const btn = style.slice(style.indexOf('.btn {'), style.indexOf('.btn:active'));
  assert.match(btn, /border-radius: 8px;/, '.btn is flat 8px (the pill/oval is gone)');
  assert.match(catalog.slice(catalog.indexOf('.chip {')), /border-radius: 8px;/, 'catalog chips flat');
  assert.match(style.slice(style.indexOf('.room-chip {')), /border-radius: 8px;/, 'room chip flat');
  const remaining = [...style.matchAll(/border-radius: 999px/g)].length;
  assert.equal(remaining, 1, 'style.css keeps exactly one 999px: the scrollbar thumb');
  assert.doesNotMatch(catalog + social, /border-radius: 999px/, 'catalog/social have no pills left');
  assert.match(social, /\.avatar-frame \{[^}]*border-radius: 50%;/, 'avatars stay circular');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /css\/style\.css\?v=27/, 'style cache-bumped');
  assert.match(html, /css\/catalog\.css\?v=36/, 'catalog cache-bumped');
  assert.match(html, /css\/social\.css\?v=19/, 'social cache-bumped');
});

test('cover survives episode switch + season covers in both modals', () => {
  const c = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  // The episode switcher spreads the room video (poster/backdrop/overview ride along).
  assert.match(c, /onPick\(buildVideo\(\{ \.\.\.video, type: 'anime', isAnime: true, anilistId: anilistId, malId: malId \}, \{ episode: n \}\)\)/, 'anime pick preserves artwork');
  assert.match(c, /onPick\(buildVideo\(\{ \.\.\.video, type: isAnime \? 'anime' : 'tv', isAnime: isAnime, anilistId: video\.anilistId \}, \{ season: s\.season, episode: n \}\)\)/, 'tv pick preserves artwork');
  // Detail modal: season cover swap + revert-to-show onerror (never remove-on-error).
  assert.match(c, /poster: \(s\.poster_path \? img\(s\.poster_path, 'w500'\) : ''\) \|\| showPosterSrc/, 'detail seasons carry their poster');
  assert.match(c, /if \(s\.poster && poster\.parentNode && poster\.src !== s\.poster\) poster\.src = s\.poster;/, 'season switch swaps the detail cover');
  assert.match(c, /if \(poster\.src !== showPosterSrc && showPosterSrc\) \{\s*poster\.src = showPosterSrc;/, 'broken season art reverts to the show poster');
  // Episodes modal: cover row (show art -> season art) for tv AND anime paths.
  assert.match(c, /episodes-modal__cover/, 'episodes modal shows a cover');
  assert.match(c, /if \(s\.poster && cov\.parentNode && cov\.src !== s\.poster\) cov\.src = s\.poster;/, 'modal cover follows the season chip');
  assert.match(c, /episodes-modal__season', 'Season ' \+ curSeason/, 'season label initial');
  assert.match(c, /episodes-modal__season', episodes \+ ' episodes'/, 'anime modal shows the episode count');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/catalog\.js\?v=35/, 'catalog cache-bumped');
  assert.match(html, /css\/catalog\.css\?v=36/, 'catalog css cache-bumped');
});

test('room cover broken-art guard + profile showcase has no empty poster-height holes', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /img\.onerror = \(\) => img\.remove\(\); \/\/ broken art must never show as a torn frame/, 'room cover guard');
  const s = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(s, /if \(!fav && !own\) continue;/, 'no empty slots on other people profiles');
  const css = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  assert.match(css, /\.showcase__card--empty \{[^}]*aspect-ratio: auto;/, 'empty slots are compact');
  assert.match(css, /\.showcase__grid \{[^}]*align-items: start;/, 'grid rows no longer stretch empty slots');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /css\/social\.css\?v=19/, 'social css cache-bumped');
});

test('server watch memory: positions stored + served by the worker', () => {
  const schema = readFileSync(join(ROOT, 'src/schema.ts'), 'utf8');
  assert.match(schema, /position_seconds INTEGER NOT NULL DEFAULT 0/, 'DDL carries position');
  assert.match(schema, /duration_seconds INTEGER NOT NULL DEFAULT 0/, 'DDL carries duration');
  assert.match(schema, /needsProgressColumns/, 'self-provisioning ALTER for old DBs');
  const migration = readFileSync(join(ROOT, 'migrations/0003_watch_history_progress.sql'), 'utf8');
  assert.match(migration, /ALTER TABLE watch_history ADD COLUMN position_seconds/, 'canonical migration');
  const users = readFileSync(join(ROOT, 'src/routes/users.ts'), 'utf8');
  assert.match(users, /position_seconds = excluded\.position_seconds/, 'upsert stores the position');
  assert.match(users, /duration_seconds = excluded\.duration_seconds/, 'upsert stores the duration');
  assert.match(users, /positionSeconds: Number\(r\.position_seconds\) \|\| 0/, 'GET returns the position');
  assert.match(users, /Math\.min\(Math\.floor\(Number\(body\.positionSeconds\) \|\| 0\), 86400\)/, 'position clamped');
});

test('server watch memory: client pings progress, resumes across devices', () => {
  const s = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(s, /function recordProgressFor\(video, positionSeconds, durationSeconds\)/, 'progress ping helper');
  assert.match(s, /completed: dur > 0 && pos >= dur - 30/, 'episode completion derived client-side');
  assert.match(s, /async function getServerEntry\(mediaId, season, episode\)/, 'per-title server lookup');
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /WP\.Social\.recordProgressFor\(v, p\.time, p\.duration \|\| 0\)/, 'progress pings ride the 8s throttle');
  assert.match(a, /WP\.Social\.recordProgressFor\(v, dur \|\| 1, dur \|\| 0\)/, 'episode end marks completed server-side');
  assert.match(a, /if \(state\._pendingResume == null \|\| pos > state\._pendingResume \+ 30\)/, 'server upgrades resume, never downgrades');
  assert.match(a, /if \(dur && pos >= dur - 30\) return; \/\/ already finished/, 'finished episodes start fresh');
  assert.match(a, /position: Number\(h\.positionSeconds\) \|\| 0/, 'history cards carry server positions');
  assert.match(a, /card\.addEventListener\('click', \(\) => startRoomWithVideo\(v\)\);/, 'single click path: server cards rebuilt playable, position rides along');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});

test('history page renders (dead-guard regression) + watched fade bar', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.doesNotMatch(a, /const sec = \$\('history'\);/, "no phantom $('history') guard (it blanked the whole page)");
  assert.match(a, /if \(!scroller\) return;/, 'renderHistory requires only the scroller');
  assert.match(a, /history-card__progress-fill--done/, 'watched entries get the faded full bar');
  assert.match(a, /const finished = !!v\.completed \|\| \(v\.duration > 0 && v\.position > 0 && v\.position >= v\.duration - 30\);/, 'finished = completed flag OR watched past dur-30');
  const css = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  assert.match(css, /\.history-card__progress-fill--done \{[^}]*opacity: 0\.45;/, 'faded done-bar styled');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
  assert.match(html, /css\/catalog\.css\?v=36/, 'catalog css cache-bumped');
});

test('episode selector watched fade: local + server watched states on every grid', () => {
  const c = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  assert.match(c, /const watchedServerCache = new Map\(\);/, 'server watched view cached per show');
  assert.match(c, /function watchedEpisodesFor\(showId, season\)/, 'watched-state source (local sync + server)');
  assert.match(c, /function paintWatched\(root, byEp, currentEp\)/, 'deep painter (flat + threaded rows)');
  assert.match(c, /if \(!n \|\| n === currentEp \|\| b\.classList\.contains\('ep-btn--watched'\)/, 'idempotent; the current episode keeps its highlight');
  assert.match(c, /buildThreadedEpisodes\(epGrid, o\.count, o\.pick, o\.currentEp \|\| 0, decorate\)/, 'threaded rows decorate too');
  assert.match(c, /if \(byEp && byEp\.size && epGrid\.isConnected\) paintWatched\(epGrid, byEp, o\.currentEp \|\| 0\);/, 'server view repaints when it arrives');
  const css = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  assert.match(css, /\.ep-btn--watched \{[^}]*opacity: 0\.45;/, 'watched = faded');
  assert.match(css, /\.ep-btn--watched::after \{[^}]*content: '\\2713';/s, 'check badge');
  assert.match(css, /\.ep-btn--watched::after \{[^}]*color: var\(--on-accent\);/s, 'badge ink is theme-driven (color audit)');
  assert.match(css, /\.ep-btn--partial::after \{[^}]*width: var\(--wp, 0%\);/s, 'partial = mini progress bar');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/catalog\.js\?v=35/, 'catalog cache-bumped');
  assert.match(html, /css\/catalog\.css\?v=36/, 'catalog css cache-bumped');
});

test('/history never-silent guarantees: error surface + self-explanatory empty', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /console\.error\('\[history\] render failed', e\);/, 'render failures are logged AND shown');
  assert.match(a, /'History failed to load: ' \+ \(\(e && e\.message\) \|\| e\)/, 'the error lands in the page');
  assert.match(a, /Sign in and your watch history follows you across every device/, 'signed-out hint');
  assert.match(a, /Nothing watched on your account yet/, 'account-empty hint');
});

test('history nav dead-end fixed + never-blank view setup + global error surface', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /!\$\('history-page'\)\.hidden \/\/ DEAD END FIX/, 'Home nav handles /history (previously no branch = stuck)');
  assert.match(a, /NEVER-BLANK GUARANTEE/, 'showHistoryView isolates teardown steps');
  assert.match(a, /console\.error\('\[history\] view setup step failed', e\);/, 'setup failures logged, page still renders');
  assert.match(a, /window\.addEventListener\('error', \(ev\) =>/, 'uncaught errors surface as a visible toast');
  assert.match(a, /window\.addEventListener\('unhandledrejection', \(ev\) =>/, 'rejections surface too');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});

test('history is SERVER-FIRST with an on-page status line', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /SERVER-FIRST \(user directive\)/, 'account history is the source of truth');
  assert.match(a, /WP\.Catalog\.buildVideo[\s\S]*?\.src/, 'server rows rebuilt into playable cards');
  assert.match(a, /paintHistoryStatus\(items\);/, 'status line painted every render');
  assert.match(a, /'All Titles: ' \+ \(items \? items\.length : 0\)/, 'clean breakdown: All + Movies + Series + Anime');
  assert.match(a, /Account history unavailable: ' \+ state\._historyStatusError/, 'server failures are VISIBLE');
  assert.match(a, /card\.addEventListener\('click', \(\) => startRoomWithVideo\(v\)\);/, 'single click path - every card has src');
  assert.doesNotMatch(a, /startRoomWithVideo\(\{ \.\.\.v, src: undefined \}\)/, 'old discard-position path gone');
  const s = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(s, /function getServerHistoryStatus\(\)/, 'status-bearing fetch');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /id="history-status"/, 'status element exists');
  assert.match(html, /js\/social\.js\?v=58/, 'social cache-bumped');
  const css = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  assert.match(css, /\.history__status--err \{/, 'error status styled');
});

test('history self-diagnosis: card counts in the status line + empty-scroller canary', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /console\.log\('\[history\] rendered', items\.length/, 'render counts live in the console, not the status line');
  assert.match(a, /console\.log\('\[history\] rendered', items\.length/, 'console breadcrumb');
  const css = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  assert.match(css, /#history-scroller:empty::after/, 'empty scroller prints the red canary');
  assert.match(css, /\.history-card \{[^}]*display: block;/, 'cards are guaranteed opaque boxes');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
  assert.match(html, /css\/catalog\.css\?v=36/, 'catalog css cache-bumped');
});

test('history poster self-heal: bounded TMDB lookup paints cards and patches the DB rows', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /function healHistoryPosters\(items\)/, 'healer present');
  assert.match(a, /data-poster-queued/, 'queue marker');
  assert.match(a, /card\.dataset\.mediakey = v\.type \+ ':' \+ v\.id/, 'cards carry a lookup key');
  assert.match(a, /setTimeout\(run, 150\);/, 'staggered queue (no fan-out burst - rate-limit rule)');
  assert.match(a, /WP\.Social\.recordHistoryFor\(\{[\s\S]*?backdrop: art\.backdrop \|\| ''/, 'resolved art (poster+backdrop) patches the server row permanently');
  assert.match(a, /console\.log\('\[history\] healing posters:', missing\.length\)/, 'heal feedback is console-only (clean status line)');
  assert.match(a, /'https:\/\/image\.tmdb\.org\/t\/p\/w500' \+ d\.poster_path/, 'TMDB art resolved from the id');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});

test('history cards carry CONTENT (empty-box regression - appends were lost)', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /card\.appendChild\(poster\);/, 'poster attached to the card');
  assert.match(a, /card\.appendChild\(body\);/, 'body attached to the card');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});

test('landscape history art: backdrop column end-to-end + healer prefers it', () => {
  const schema = readFileSync(join(ROOT, 'src/schema.ts'), 'utf8');
  assert.match(schema, /backdrop_url TEXT NOT NULL DEFAULT ''/, 'DDL carries backdrop');
  assert.match(schema, /needsBackdropColumn/, 'self-provisioning ALTER');
  assert.match(readFileSync(join(ROOT, 'migrations/0004_watch_history_backdrop.sql'), 'utf8'), /ADD COLUMN backdrop_url/, 'migration 0004');
  const users = readFileSync(join(ROOT, 'src/routes/users.ts'), 'utf8');
  assert.match(users, /backdrop_url = excluded\.backdrop_url/, 'upsert stores backdrop');
  assert.match(users, /backdropUrl: r\.backdrop_url/, 'GET returns backdrop');
  const s = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.equal((s.match(/backdropUrl: video\.backdrop \|\| ''/g) || []).length, 2, 'both record paths send backdrop');
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /backdrop: h\.backdropUrl \|\| ''/, 'server merge carries the landscape art');
  assert.match(a, /const url = art\.backdrop \|\| art\.poster;/, 'healer paints landscape first');
  assert.match(a, /!v\.backdrop && v\.id/, 'rows missing a backdrop get healed');
  assert.match(a, /w780' \+ d\.backdrop_path/, 'TMDB backdrop at w780');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/social\.js\?v=58/, 'social cache-bumped');
});

test('host sovereignty: only external controller commands drive the host + explicit CSP', () => {
  const p = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  assert.match(p, /HOST SOVEREIGNTY \(user directive\)/, 'sovereign gate');
  assert.match(p, /msg\.by && this\.selfName && msg\.by !== this\.selfName/, 'external = by !== selfName');
  assert.match(p, /this\._externalUntil = Date\.now\(\) \+ 4000/, 'external compliance window');
  assert.match(p, /if \(this\._hasPlayed\) return; \/\/ SOVEREIGN/, 'fresh loads still follow the room; played = sovereign');
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /sync\.selfName = state\.name;/, 'selfName wired');
  const w = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  assert.match(w, /style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline';/, 'CSP explicit elem/attr');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/player\.js\?v=16/, 'player cache-bumped');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});

test('auto-advance stays sequential for anime started from history cards', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /ANIME FROM A HISTORY CARD/, 'anilistId resolved at history start (bounded 4s)');
  assert.match(a, /video\.src = WP\.Catalog\.buildVideo\(video, \{ episode: video\.episode \|\| 1 \}\)\.src;/, 'src rebuilt with the real anilist id');
  assert.match(a, /return tvAdvance\(v\); \/\/ unmatched anime: TMDB walk still advances sequentially/, 'anime dead-end removed: TMDB fallback');
  assert.match(a, /function tvAdvance\(v\)/, 'shared sequential walker');
  assert.doesNotMatch(a, /if \(v\.anilistId == null\) return Promise\.resolve\(null\);/, 'the old anime null dead-end is gone');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});

test('room swap hides the history page too (the /history split-UI regression)', () => {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(a, /teardownDiscoveryView\(\);\s*\n\s*teardownHistoryView\(\);\s*\n\s*\$\('room'\)\.hidden = false;/, 'enterRoom tears down BOTH discovery and history before revealing the room');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/app\.js\?v=57/, 'app cache-bumped');
});
