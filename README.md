# WatchParty 🎬

A modern, YouTube-inspired **watch party** web app built entirely on the
Cloudflare stack:

- **Cloudflare Workers** (Static Assets) — serves the frontend build from `dist/`
- **Cloudflare Durable Objects** — room state + WebSocket signaling (`WatchRoom`)
- **Zero Node server dependencies** — no `socket.io`, no Express; just the
  platform-native WebSocket pair + storage APIs.

Browse a full library of **movies, TV series and anime** (with hero banners and
poster rows, just like YouTube), then stream any title in lockstep with friends
while chatting live — powered by the **Bingr Embed API**. Every user gets a
deterministic **DiceBear avatar** from their handle, and every title you watch
is saved to your local **watch history** so you can jump back in.

## Architecture

```
Browser (static build in /dist)
   │  REST:  /api/rooms, /api/room/:id, /api/user/*, /api/search/users,
   │        /api/auth/*, /api/presence, /api/friends/*
   │  Proxy: /api/tmdb/*  ->  https://api.themoviedb.org/3/*
   │  WS:    /ws?room=<id>
   ▼
Worker (src/worker.ts)
   │  routes REST (profile/search/presence via src/router.ts), proxies the
   │  TMDB catalog API, upgrades WebSockets
   ├─► D1 (env.DB)            users, favorites, watch history, friendships
   ├─► KV (env.PRESENCE_KV)   presence:user:<user_id> keys, short TTL
   ▼
WatchRoom Durable Object (src/WatchRoom.js)
   ├─ per-room state: video, playback clock, chat history, peers
   ├─ authoritative playback clock (isPlaying + time + timestamp)
   ├─ writes/clears KV presence for signed-in peers (see below)
   └─ broadcasts play/pause/seek/videoChange/chat to every connected client
```

## The Bingr Embed API (player)

The video player is an `<iframe>` pointing at a Bingr watch URL:

| Type   | URL pattern                                   |
| ------ | --------------------------------------------- |
| Movie  | `https://bingr.one/watch/movie/{tmdbId}`      |
| Series | `https://bingr.one/watch/tv/{tmdbId}/{season}/{episode}` |
| Anime  | `https://bingr.one/watch/tv/{tmdbId}/{season}/{episode}` |

The player is driven with `postMessage` commands to the iframe's
`contentWindow`:

```js
iframe.contentWindow.postMessage({ command: "play"  }, "*");
iframe.contentWindow.postMessage({ command: "pause" }, "*");
iframe.contentWindow.postMessage({ command: "seek",  time: 120 }, "*");
iframe.contentWindow.postMessage({ command: "volume", level: 0.5 }, "*");
iframe.contentWindow.postMessage({ command: "mute",  muted: true }, "*");
iframe.contentWindow.postMessage({ command: "getStatus" }, "*");
```

Playback status is read back from the player's `PLAYER_EVENT` messages:

```js
window.addEventListener("message", ({ data }) => {
  if (data.type === "PLAYER_EVENT" && data.data.event === "playerstatus") {
    // data.data.currentTime, data.data.duration, data.data.playing
  }
});
```

> Note: remote control is only available on Bingr's own player; "Server 2"
> fallback embeds don't accept commands (the app shows a notice if so).

## The TMDB catalog API (library)

Browse data comes from **The Movie Database (TMDB)** — whose IDs are exactly
the IDs Bingr uses for watch URLs — so every title maps 1:1 to playback:

| Type   | TMDB item      | Bingr watch URL                                |
| ------ | -------------- | ---------------------------------------------- |
| Movie  | `/movie/{id}`  | `https://bingr.one/watch/movie/{tmdbId}`       |
| Series | `/tv/{id}`     | `https://bingr.one/watch/tv/{tmdbId}/{s}/{e}`  |
| Anime  | TMDB anime TV  | `https://bingr.one/watch/tv/{tmdbId}/{s}/{e}`  |

The Worker proxies `/api/tmdb/*` → `api.themoviedb.org/3/*`, injecting the
server-side `TMDB_API_KEY` so it never reaches the browser. Results are cached
in the browser (30 min) so a later outage never blanks the home.

**Setup:** get a free key at <https://www.themoviedb.org/settings/api>, then

```bash
# local dev
echo 'TMDB_API_KEY="your_key_here"' > .dev.vars

# production
npx wrangler secret put TMDB_API_KEY
```

> **Keeping the key safe across `git pull`** — your key is never stored in git,
> so pulling never resets it:
>
> - `.dev.vars` is gitignored (see `.gitignore`) — `git pull` leaves untracked,
>   ignored files alone.
> - The production value lives in Cloudflare as a Worker secret, not in the repo.
> - The `TMDB_API_KEY = ""` in `wrangler.toml` is just an empty placeholder;
>   `.dev.vars` (local) and the Worker secret (production) both take precedence
>   over `[vars]`, so it never overrides your real key.
>
> Just **don't paste your key into `wrangler.toml`** — keep it in `.dev.vars`
> (local) and `wrangler secret put TMDB_API_KEY` (production), and a plain
> `git pull` is always safe. If you've edited tracked files locally, `git pull`
> will ask you to commit or stash them first.

Endpoints used: `/trending/all/week`, `/movie/popular`, `/tv/popular`,
`/discover/tv?with_keywords=210024` (anime), `/search/multi`, `/movie/{id}`,
`/tv/{id}`, `/tv/{id}/season/{n}`, `/movie/{id}/videos`, `/tv/{id}/videos`.

## Profiles, global search & real-time presence

### Accounts: no passwords — unique access codes

Picking a display name **creates your profile instantly** (no registration
form). At that moment the server generates a unique **access code** (e.g.
`K7MF-9Q2X-P4TD-J8WE`, unambiguous alphabet, ~10^24 keyspace) and shows it
**exactly once** with a "save this" screen. Only its peppered SHA-256 hash is
stored, so it can never be re-displayed or leaked from the database.

- **Same browser:** the session token in `localStorage` resumes silently.
- **Any device:** paste your access code ("Have an access code? Sign in
  instead" in the name dialog, or `POST /api/auth/claim`) and the profile is
  yours — that code *is* the password.
- **Signup can never be blocked by a name:** display names are not unique
  (Steam-style). If a handle is taken, signup auto-suffixes it
  (`alice` → `alice-1`, `-2`, …) while keeping your display name; the
  original account stays protected and reachable only via its code.
- **Rotation:** "Regenerate code" in the profile editor (`POST
  /api/auth/code`) retires the old code and issues a new one.
- **Legacy accounts** (created before codes) upgrade transparently: the next
  username login generates their code — one transitional login is the only
  window where a legacy name could be claimed.

Tokens are HMAC-signed (`src/auth.ts`); swap that one file for real auth
later without touching the route handlers. Profiles power three features:

### Global people search (`/api/search/users?q=`)

The normal search box now searches **people and titles at once**. Candidate
users are narrowed in D1 with `LIKE` and then fuzzy-ranked in
`src/lib/fuzzy.js` (exact > prefix > word > substring > Damerau-Levenshtein
typo tolerance > subsequence). Live presence is batch-fetched from KV in a
single pass and merged into every hit — result cards show 🟢 “Watching:
Dune: Part Two · 01:14:20” with **[ View profile ]** and **[ Join room ]**
buttons.

### Steam-style profile pages (`/user/:username`)

Hero header (avatar + decorative frame, display name, bio, level + badges,
stats), a **real-time activity banner** with a single-click
`⏩ Join Watch Party`, a 4-slot **favorites showcase** (pins edited via
`PUT /api/user/profile`), and a **recently watched** column with time-ago
indicators. Own profile gets an **Edit profile** modal (display name, bio,
avatar frame, pinned titles searched from TMDB).

### Presence engine (`src/presence.ts`)

State lives in KV under `presence:user:<user_id>` with a **180 s TTL**
(deliberately generous — background tabs get timer-throttled and can miss
heartbeats; real exits still go offline instantly via disconnect
clearing):

```json
{
  "status": "WATCHING_PARTY" | "WATCHING_SOLO" | "IDLE" | "OFFLINE",
  "room_id": "...", "media_title": "...", "media_id": "...",
  "current_timestamp": "01:14:20",
  "is_host": false,
  "last_updated": 1789300737186
}
```

- **Room sockets are the authoritative writer.** Clients push a
  `presenceSync` message over the room WebSocket every 20 s and on
  play/pause/seek/videoChange; the `WatchRoom` DO verifies the session token,
  stamps the server-side room id + host flag, and writes KV
  (`WATCHING_PARTY` when 2+ peers, `WATCHING_SOLO` otherwise).
- **Disconnect cleanup.** The DO clears the user's key in
  `webSocketClose`/`webSocketError` — but only if it still points at *this*
  room (a second tab in another room wins) **and** no other live socket of
  the same user remains in the room (two tabs, one room). While a socket
  auto-reconnects after a blip, the client reports IDLE via REST so nobody
  flashes OFFLINE mid-reconnect; a fresh room socket's state also can't be
  downgraded by another tab's idle heartbeat.
- **Home surface.** While browsing (not in a room) the client sends a REST
  `PUT /api/presence {status:"IDLE"}` heartbeat every 60 s and a
  `sendBeacon` `DELETE /api/presence` on page unload.
- Readers synthesize `OFFLINE` for missing/expired keys, so “offline” needs
  no tombstones.

Watch history is also recorded server-side (`POST /api/user/history`, one row
per title+episode) so profiles survive cleared browsers, and friendships
(request / accept / remove) live in D1 with directional states
(`pending-in`, `pending-out`, `accepted`, `blocked`).

### Levels & badges

Deterministic, computed from stats on read (`src/lib/level.js`): level 1
costs 0 watches and each level costs 4 more than the last; badges include
First Watch, Binge Watcher, Social Butterfly, Showcase Curator, Party Host.

### Setup (one-time)

```bash
npx wrangler login
npm run setup:remote          # creates D1 + KV under your account and writes the ids into wrangler.toml
npm run db:migrate:remote     # create the profile tables
npx wrangler secret put SESSION_SECRET   # any long random string
npm run deploy
```

`npm run setup:remote` is idempotent — it finds (or creates) the
`watchparty-db` D1 database and the `watchparty-app-PRESENCE_KV` KV
namespace, then replaces the placeholder ids in `wrangler.toml`. Without it,
deploys fail with `KV namespace 'PRESENCE_KV_PLACEHOLDER' is not valid
[code: 10042]` (and the same class of error for the D1 `database_id`).

Prefer manual? `npx wrangler d1 create watchparty-db` and
`npx wrangler kv namespace create PRESENCE_KV`, then paste both ids into
`wrangler.toml` yourself.

Locally, `wrangler dev` provisions D1/KV automatically — copy
`.dev.vars.example` to `.dev.vars` and you're done: the worker
**self-provisions the profile tables** on first use (`src/schema.ts`), so a
fresh or unmigrated database can never wedge users into a broken anonymous
state. `npm run db:migrate:local|remote` remain the canonical way to apply
migrations.

## Discovery pages & the friends drawer

Every library entry in the side nav is a real page with infinite scroll —
`/discovery/<key>` renders one collection full-screen and keeps loading the
next TMDB page as you approach the bottom (IntersectionObserver sentinel,
600px prefetch). No backend change was needed: the `/api/tmdb` proxy already
forwards `?page=`.

| Route | Collection | TMDB source |
|---|---|---|
| `/discovery/movies` (alias `movie`) | Popular Movies | `/movie/popular` |
| `/discovery/series` | Popular TV Shows | `/tv/popular` |
| `/discovery/anime` | Popular Anime | `/discover/tv?with_keywords=<anime>` |
| `/discovery/trending` | Trending Now | `/trending/all/week` |
| `/discovery/top-movies` | Top Rated Movies | `/movie/top_rated` |
| `/discovery/top-tv` | Top Rated Series | `/tv/top_rated` |
| `/discovery/in-theaters` | In Theaters | `/movie/now_playing` |
| `/discovery/airing-today` | Airing Today | `/tv/airing_today` |

Clicks behave like the home feed: movies start a room directly, series/anime
open the detail preview first. The route map lives in `DISCOVERY_ROUTES`
(`dist/js/catalog.js`); `#discovery` is a flex child of `.app-shell__main`
with the same scroll-surface contract as `#profile` (guarded by
`tests/discovery-nav.test.mjs`).

The **friends panel is hybrid — one shared DOM node, two modes**: on the
home surface at desktop widths (>= 1100px) it docks into the home grid as
a sticky right column (`.home--with-rail`, the built-in layout, driven by
the saved `wp:friends-rail` preference); on every other surface
(`/discovery` pages, profiles, rooms) and on narrow screens the same node
is a body-level drawer that slides in right → left with a backdrop. The
side-nav "Friends" item toggles whichever mode applies; surface changes
arrive as `wp:view-changed` (dispatched by `routeCurrent`/boot). Polls
`/api/friends` every 30s while visible.

## Custom subtitles (auto-synced overlay)

The embedded player's built-in subs are frequently out of sync — and we
can't fix the embed's renderer. We CAN render our own: the Bingr player
reports its playback clock via postMessage (`PLAYER_EVENT` →
`playerstatus.currentTime`), so `dist/js/subs.js` draws a subtitle overlay
driven by that clock (interpolated between reports), with a per-title
offset you can nudge (±¼s / ±1s buttons or `[` / `]` keys) — the offset is
**persisted per movie/episode** (`wp:suboff:*`), so a fix stays fixed.

Sources:
- **Auto-load** (**Wyzie Subs primary** — free key at store.wyzie.io/redeem,
  1000 req/day, set via `wrangler secret put WYZIE_API_KEY`): the worker
  proxies sub.wyzie.io (search by TMDB id + season/episode, `format=srt`);
  the search fans out over exactly the source codes the key may use
  (discovered live via `GET /sources`, KV-cached 24h; `WYZIE_SOURCES` env
  overrides). The live API returns the SOURCE's raw download URLs — for the
  free `charlie` source these are GATED (`dl.opensubtitles.org/.../
  vrf-<hash>/file/<id>`, 401 unauthenticated) — and the shaper REWRITES them
  to Wyzie's own documented proxy path `sub.wyzie.io/c/<hash>/id/<id>
  ?format=srt&encoding=UTF-8`, which serves the same file publicly (verified
  live 2026-09-14, en + id). Underivable gated URLs drop to the authenticated
  OpenSubtitles fallback. Files are fetched server-side behind an explicit
  suffix allowlist and KV-cached as VTT. Search responses are KV-cached
  15 min (shared across viewers); TV-only sources are skipped for movies;
  upstream calls have hard timeouts; the file downloads exactly once; and
  the panel auto-loads on every player open unless opted out via the CC
  toggle. ROOM SYNC (api-2026-09-13.25): host pause/resume is logged in the
  chat history (`Host paused the movie`); what the HOST loads (`Host loaded
  subtitles: The Martian [Indonesian]`) and how they match it (offset)
  replicate to every client AND to late joiners (persisted in room state;
  guests keep local override freedom). The panel has a mini timing editor:
  every cue is a tick on a strip — click one to see its timestamp, hit
  `Align to playhead` to make that line start NOW (manual match, no mic).
  The strip is ZOOMED to a 5-minute window that follows the playhead
  (api-2026-09-13.28). Uploads now actually load the cues (they only
  counted before). PLAYBACK CONVERGENCE (api-2026-09-13.28): play/pause/
  seek broadcasts converge IMMEDIATELY (message-driven) instead of on the
  2.5s throttled poll — the pause/resume delay that read as play-pause
  looping is gone. ANIME: the AniList matcher is unicode-aware (native
  kana/kanji titles like ジョジョの奇妙な冒険 now resolve to an AniList id —
  the a-z0-9 filter used to erase them: "anime has no player"), the match
  searches AniList with the ORIGINAL title and pins en-US for the TMDB
  name, and the client cache prefix was bumped to v2 (old nulls poisoned).
  Anime/TV subtitle searches ALWAYS carry season+episode (S1 default;
  Wyzie requires them together, lima 400s without). ANIME CACHE-BUST
  (api-2026-09-13.28): pre-fix null AniList lookups were edge-cached for 7
  days (Cache-Control 604800) — the endpoint is now versioned
  (`/api/anilist/<id>?v=2`, client cache prefix v3) and unresolved lookups
  carry a 5-minute edge TTL (resolved: 1 day). TMDB 404 degrades to
  `{anime:false}` instead of a 502. Catalog titles/overviews pinned to
  English (en-US): geo locales made TMDB fall back to native script, so
  anime rendered as ジョジョの奇妙な冒険 instead of JoJo's Bizarre
  Adventure. LOGIC AUDIT (api-2026-09-13.29): sync refuses garbage — no
  clock yet or tapped after the final cue no longer writes a broken offset
  (it explained itself instead); panel Reset goes through the room-sync
  path (the host's reset now reaches guests); Align releases its pick so
  the zoom window resumes following the playhead. PRESENCE + PAUSE-LOOP
  (api-2026-09-13.30): presence TTL raised 180s → 900s — background tabs
  get timer-throttled to 1 beat/5min, so watching users showed OFFLINE
  (the DO's disconnect-clear remains the primary expiry). The play/pause
  LOOP: the controller's mirror adopted the embedded player's DELAYED
  status echo of a remote apply and broadcast the stale state back to the
  room — fixed with a remote-echo guard (1.5s adopt-quietly), fresh-window
  re-asserts (a pause swallowed mid-buffer re-posts within ~1s instead of
  the 2.5s throttle), room-state-trusted adoption, and no-force respected
  for paused-room position seeks. STILL-OFFLINE FIX (api-2026-09-13.34):
  the TTL raise alone couldn't help because presence was refreshed ONLY by
  client timers (hidden tabs throttle to 1/5min) — the room Durable Object
  now refreshes presence ITSELF via storage alarms (60s cadence, payloads
  persisted on the session so hibernation is survived). Client throttling
  can no longer expire a watching user, and home-surface IDLE beats are
  always rejected by the ROOM_FRESH guard because the DO keeps
  last_updated warm. STICKY-OFFLINE FIXES (api-2026-09-13.34): the alarm
  chain could die silently (sessions persisted before the payload field
  existed made `alarm()` find nobody and NOT reschedule — offline stuck
  until redeploy); the chain now re-arms on every beat and stays alive
  while any identified session remains. The pagehide beacon no longer
  clears presence for in-room users (mobile backgrounding / bfcache fired
  it and un-marked WATCHING users); the home heartbeat logs its first
  failure instead of swallowing it. IDLE SURFACE (api-2026-09-13.34):
  the home surface has no server-side refresher, so its TTL is 1h (watching
  stays 15min + DO alarms) and the pagehide DELETE beacon is GONE — mobile
  backgrounding/bfcache fired it constantly and erased idle users ("works
  in a room, offline when idle"). True exits expire via TTL; bfcache
  restores re-beat instantly via pageshow. GHOST-WATCHER FIX
  (api-2026-09-13.34): sockets that die WITHOUT a close frame (laptop
  sleep, app kill, network loss) left their session in the room DO — and
  the presence-refresh alarm then renewed that ghost's WATCHING status
  forever (the TTL could never expire it). Every alarm tick now checks
  the runtime's LIVE socket list: sessions without a live socket are
  pruned and their presence cleared within one minute of death. KV WRITE
  BUDGET (api-2026-09-13.37): the free tier allows 1,000 KV writes/DAY and
  per-beat presence writes burnt that before noon — all writes then failed
  (silent plaintext 500s) and everyone showed OFFLINE. Now: socket beats
  update only the DO session; KV is written on join/status-change or at
  most every 4 min; the DO alarm refreshes every 5 min; home beats every
  10 min; presence TTLs are 1h; and the room DO writes as the
  authoritative writer (bypasses the second-tab downgrade guard). Budget:
  ~12-20 writes/day/user instead of ~4,000. PEOPLE SEARCH (api-2026-09-13.38): 1-2 char queries take a strict
  relevance path (no 500-user widening; only start-of-word / exact-handle
  matches survive), so typing "e" no longer returns half the directory.
  The missing .avatar--lg/.avatar--xl size classes (used in JS, never
  defined - everything rendered at 40px) now exist; user cards are
  roomier. ASSET CACHE RULE: ANY change to dist/js/* or dist/css/* MUST
  bump the matching ?v= in dist/index.html in the same commit - CSS/JS
  are cached by the browser, and an unbumped version serves the stale
  file (this shipped vertical unstyled people cards once already).
  Asset cache is now 1h (was 24h) to shrink the blast radius. BRAND (ui-2026-09-13.30): logo mark is now the infinity symbol (inline
  SVG stroke path, white on the gradient tile) in topnav, room header and
  favicon - the play triangle remains ONLY on player controls (fallback
  icon, Play button, play/pause toggle). The subtitle language
  is decoupled from the audio language by
  design (English audio + Indonesian subs is the norm): the selector defaults
  to the geo UI language, the choice persists (`wp:subslang`), and switching
  reloads instantly. Sync is ONE PRESS ("Shazam-style"): hit ⚡ Sync (or `S`) exactly
  when a line starts being spoken and the next upcoming cue snaps to that
  instant — no arming, no reading a quoted line; repeat presses re-snap
  (ui-2026-09-13.21). Per-record drop diagnostics
  (`empty:array |dropped:65(host:65@dl.opensubtitles.org)`) make any
  remaining mismatch a one-probe answer. The panel's `fileId`
  is an opaque base64url token of the file URL — `/api/subs/file` can never
  act as an open proxy. **OpenSubtitles remains the automatic fallback**
  when Wyzie returns nothing (and vice-versa config-wise). The response
  names its `provider` and echoes the upstream `query` (key stripped):
- **Auto-load fallback** (OpenSubtitles v3 via the worker): `GET /api/subs/search`
  finds subtitles per the official API contract — `tmdb_id` for movies,
  **`parent_tmdb_id` + `season_number` + `episode_number` for series/anime**
  (tmdb_id + season/episode is an invalid combination there and returns
  empty/wrong results); best candidate auto-picked: real dialogue >
  machine-translated, popular releases, 23.976/24 fps. OpenSubtitles'
  July-2025 API change made an explicit `type` (movie|episode) mandatory —
  without it every search returns 0 results (confirmed by their admin);
  we always send it; `GET /api/subs/file?fileId=` downloads and converts
  SRT → WebVTT, cached in KV for 7 days (`subs:vtt:*`) so the API's tight
  daily download quota is amortized across all users. Needs the
  `OPENSUBTITLES_API_KEY` secret (`wrangler secret put
  OPENSUBTITLES_API_KEY` — free key at api.opensubtitles.com). The free
  tier's download quota is tiny (~10/day) — the KV cache converts that
  into "one download per subtitle, ever"; quota/key errors surface in
  plain language in the panel (406/429 quota, 401/403 key rejected).
- **Upload**: any `.srt`/`.vtt` file, no key needed.

**Tap-Sync** (the one-press exact sync): the panel shows the line that
should be spoken; tap the button (or SPACE) the instant you hear it and
the offset is computed precisely from the player clock
(`playerTime(atTap) − cueStart`) and persisted. Language fallback chain:
requested language → English → any (status shows which loaded) — "no
subs" almost always meant a thin language catalog, not a missing title.

The CC button in the room header toggles the panel. Caveats: custom subs
follow the **main Bingr player** only (Server-2 fallback embeds don't
report a clock — the panel says so); "auto-sync" here = exact-episode
auto-pick + clock-driven rendering + persistent nudge, not audio analysis.

## Geo language detection (country → language)

The site renders in the visitor's country language with **zero IP databases
and zero external APIs** — Cloudflare provides `request.cf.country` on every
request at the edge. Two layers localize:

1. **TMDB content** (worker, `src/geo.js`): the `/api/tmdb` proxy appends
   `language=<lang>-<COUNTRY>` per request, so movie titles and overviews
   come back localized for every mapped country — e.g. a German IP gets
   German titles even though the UI chrome has no German dictionary yet.
   The locale is part of the proxy cache key.
> **Deploy note:** the geo feature initially broke detail clicks with
> "Invalid API key" — appending `?language=..` before `api_key` corrupted
> parameter-less URLs (`/movie/{id}`) into `..?language=..?api_key=..`.
> TMDB URLs are now built exclusively by `buildTmdbUrl` (src/tmdburl.js),
> which re-serializes the query (one `?` guaranteed) and is pinned by
> `tests/tmdb-url.test.mjs`.

2. **UI chrome** (`dist/js/i18n.js`): the worker injects `window.WP_GEO`
   into every HTML response and the page applies dictionaries to
   `[data-i18n]` / `[data-i18n-placeholder]` elements. Shipped UI languages:
   **en, id, es, fr, pt, ar** (Arabic gets basic RTL via `<html dir>`).
   JS-created strings use `WP.I18N.t(key, fallback)`.

Resolution priority: `?lang=<code>` / saved override → IP country → browser
languages → `en`. The override persists to `localStorage['wp:lang']`;
`/api/geo` returns the resolved locale for debugging. `wrangler.toml` sets
`run_worker_first = true` — required so HTML responses (including `/`)
flow through the worker for injection; non-HTML assets pass through
untouched. A stale worker (no `WP_GEO`) degrades gracefully: browser
language, then English.

Add a language: append it in `SUPPORTED_UI_LANGS` (src/geo.js), add its
dictionary in `dist/js/i18n.js` (key sets must match English — enforced by
`tests/geo.test.mjs`), and map countries in `COUNTRY_LANG`.

## Avatars & watch history

- **Avatars** come from the free [DiceBear](https://www.dicebear.com/introduction/)
  HTTP API: `https://api.dicebear.com/10.x/critters/svg?seed=<name>`. The seed
  is the user's handle, so everyone keeps a consistent picture (chat + peer
  list + a live preview in the name dialog). If the API is unreachable, the app
  falls back to the colored initials.
- **Watch history** is stored locally (`localStorage` key `wp:history`, newest
  first, de-duplicated by title + season/episode, capped at 40). The home page
  shows a "Watch history" row of landscape thumbnails; click one to instantly
  start a room with that title (or exact episode). It never leaves the browser.

## Synchronization model

The room owns one authoritative playback clock. The host's (or a granted
guest's) explicit play/pause/seek commands update it; the Durable Object
broadcasts the new `(isPlaying, time, timestamp)` tuple. Every client —
including the controller — projects that tuple forward in wall-clock time and
nudges its local player whenever it drifts beyond a tolerance threshold,
giving sub-second sync without any clock negotiation.

Picking a title **autoplays**: `videoChange` (and the first video set by the
host on join) starts playback at `0` for the whole room, so nobody has to
press a play button to begin watching. Playback state is changed only by the
explicit controls — the player's own internal play/pause state is never
mirrored back to the room (that caused the host to pause itself), so guests
can never desync the room by clicking inside their own player.

**Controllers can use either seek bar.** The player's own play/pause is
mirrored for the controller (debounced), and since ui-2026-09-13.21 a seek
performed on the player's OWN seek bar is detected (an unexplained jump
beyond 1.2s of playback progress) and mirrored to the room as a normal
seek — no more snap-back, no need to scroll down to the in-app progress
row. Guests' native seeks are still re-converged (sync wins; only
controllers steer the room).

## Project layout

```
wrangler.toml        # Static Assets + DO + D1 + KV bindings, D1 migrations dir
package.json
tsconfig.json        # strict type check for src/ (wrangler bundles TS natively)
tsconfig.frontend.json  # strict checkJs for the new frontend modules
migrations/
  0001_profiles.sql  # users, user_favorites, watch_history, friendships
src/
  worker.ts          # entry: routing, room API, TMDB proxy, WS upgrade
  router.ts          # /api dispatch for profiles/search/presence/friends
  types.ts           # shared domain + Env types
  auth.ts            # HMAC session tokens (issue/verify)
  presence.ts        # KV presence engine (write/read/batch/clear)
  http.ts            # JSON response helpers
  routes/
    auth.ts          # POST /api/auth/session, GET /api/auth/me
    search.ts        # GET /api/search/users (fuzzy + batch presence)
    users.ts         # profile GET/PUT, history, friends
    presence.ts      # REST presence (IDLE heartbeat, unload beacon)
  lib/
    fuzzy.js         # pure fuzzy matching (unit-tested)
    format.js        # formatClock/timeAgo (unit-tested)
    level.js         # level curve + badges (unit-tested)
  WatchRoom.js       # Durable Object: state, chat, sync, presence forwarding
  anilist.js         # TMDB ⇄ AniList anime mapping (unchanged)
dist/                # static frontend (no build step required)
  index.html
  css/style.css      # room / chat / player chrome
  css/catalog.css    # browse, hero, rows, cards, hover preview, modals, seek bar
  css/social.css     # profiles, people cards, presence badges, avatar frames
  js/utils.js        # DOM helpers, formatting, DiceBear avatars, watch history, random names
  js/api.js          # REST + WebSocket client w/ auto-reconnect
  js/player.js       # PlaybackSyncManager (Bingr postMessage bridge)
  js/catalog.js      # TMDB library: browse, search, trailer hover, episode picker
  js/types.js        # JSDoc mirrors of the API contract (checked by tsc)
  js/social.js       # session, presence clients, search UI, profile UI, editor
  js/app.js          # home/room/profile flow, modals, chat, wiring
  favicon.svg
tests/               # node --test unit tests for the pure libs
```

## Run locally

```bash
npm install
npm run dev:local      # wrangler dev on 0.0.0.0:8787
```

Then open `http://localhost:8787`. Pick a title to start a room, and open the
invite link (or `/room/<id>`) in another tab to test sync + chat.

> Note: `wrangler dev` runs a local Durable Objects runtime, so WebSocket
> signaling and room persistence work offline. The Bingr catalog proxy requires
> network egress, which Cloudflare Workers have in production.

## Troubleshooting

**"Catalog not showing" / the home library is empty**
The browse feed is entirely TMDB-driven. Check, in order:

1. **No TMDB key configured** — `/api/tmdb/*` answers
   `503 {"error": "TMDB_API_KEY is not configured…"}`. Fix: put the key in
   `.dev.vars` (local) or `wrangler secret put TMDB_API_KEY` (production).
2. **No outbound internet** — sandboxed/air-gapped environments can't reach
   `api.themoviedb.org` at all; the app correctly shows
   "Could not load the library" while profiles/search/friends (D1 + KV, local
   simulation) keep working.
3. **Storage bindings missing** — profile routes answer 503 with setup
   instructions, but the catalog keeps working: `npm run setup:remote`.
4. **Stale browser cache** — a hard refresh (Cmd/Ctrl+Shift+R) re-fetches the
   versioned scripts.

## Checks & tests

```bash
npm run check   # tsc (worker + frontend JSDoc) + node --check on every script
npm test        # node --test unit tests for the pure libs (fuzzy, format, level)
npm run db:migrate:local   # apply migrations/ to the local D1
```

## Deploy

```bash
npm run deploy
```

`wrangler.toml` declares the `WATCH_ROOM` Durable Object binding (`v1`
`new_sqlite_classes` migration), the `DB` D1 database, and the
`PRESENCE_KV` KV namespace — create both with the one-time setup commands
above, then `npm run deploy` bundles the TypeScript entry directly (wrangler
compiles `src/worker.ts` with its built-in esbuild; no separate build step).

### Verifying a deploy took (do this before reporting bugs)

The #1 cause of "still broken" reports is a **split deployment**: the static
assets updated but the worker script didn't (or the browser cached old JS).
Every build fingerprinted itself, so a stale deploy is visible in seconds:

1. `GET /api/health` must return JSON:
   `{"ok":true,"build":"api-2026-09-13.28",...}`. If it returns the home page
   HTML, the deployed worker predates the API routes — run `npm run deploy`
   from the branch that has the change (fixes land on the PR branch, not
   `main`) and read its output for errors.
2. DevTools console must show both stamps after a hard refresh
   (Ctrl+Shift+R):
   `[WatchParty] UI build: ui-2026-09-13.21` and
   `[WatchParty] API build: api-2026-09-13.28`.
3. If any API surface ever answers HTML instead of JSON, the UI now says so
   explicitly (profile pages show **"Deployment out of date"** with the
   redeploy instructions) instead of failing silently.

## REST API

| Method | Path                       | Description                                        |
| ------ | -------------------------- | -------------------------------------------------- |
| GET    | `/api/rooms`               | Create a room → `{ id, url, ws }`                  |
| GET    | `/api/room/:id`            | Look up a room's current state                     |
| GET    | `/api/tmdb/*`              | Proxy to the TMDB catalog API                      |
| GET    | `/room/:id/health`         | Durable Object health (peers, playback)            |
| POST   | `/api/auth/session`        | Create profile → `{ token, user, accessCode }`     |
| GET    | `/api/auth/me`             | Current session user or `null`                     |
| POST   | `/api/auth/claim`          | Sign in with an access code → `{ token, user }`    |
| POST   | `/api/auth/code`           | Rotate your access code (auth) → `{ accessCode }`  |
| GET    | `/api/search/users?q=`     | Fuzzy user search + live presence                  |
| GET    | `/api/user/:username`      | Public profile (pins, last 5 watched, presence)    |
| PUT    | `/api/user/profile`        | Update bio / display name / frame / pins (auth)    |
| POST   | `/api/user/history`        | Record a watched title (auth)                      |
| GET    | `/api/friends`             | Friends + incoming requests, with presence (auth)  |
| POST   | `/api/friends/:username`   | Send friend request / auto-accept mutual (auth)    |
| PUT    | `/api/friends/:username`   | Accept an incoming request (auth)                  |
| DELETE | `/api/friends/:username`   | Remove / decline / cancel (auth)                   |
| PUT    | `/api/presence`            | IDLE heartbeat (auth; also accepts body token)     |
| DELETE | `/api/presence`            | Clear presence now — `sendBeacon` target (auth)    |
| GET    | `/api/presence/:userId`    | Read one user's presence                           |

## WebSocket protocol

Clients connect to `/ws?room=<id>` and exchange JSON messages:

- Client → server: `join`, `chat`, `videoChange`, `play`, `pause`, `seek`,
  `transfer`, `grant`, `revoke`, `ping`, `presenceSync`
- Server → client: `state`, `peers`, `system`, `chat`, `videoChange`,
  `play`, `pause`, `seek`, `pong`

`presenceSync` carries `{ token, userId, status, media_id, media_title,
current_timestamp_seconds, is_host }`. The DO verifies the token, overrides
`is_host`/`room_id` with server truth, and writes the KV presence key (90 s
TTL). On socket close the DO clears the user's presence.

The first connected client becomes the **host** (playback owner). The host can:

- **transfer** ownership to any guest (`{ type: "transfer", peerId }`) — the
  new host immediately takes over playback control;
- **grant** / **revoke** playback controls to/from a guest
  (`{ type: "grant" | "revoke", peerId }`) — granted guests can play, pause,
  seek, and change the movie/series/anime, but can't manage the roster.

Only the host or a granted guest may send `videoChange`, `play`, `pause`, or
`seek`; the server silently ignores those messages from anyone else. The
`peers` list marks each entry with `owner` and `allowed` flags so every client
can render the roster and gate its own controls. If the host leaves, ownership
transfers to the oldest remaining peer automatically. The shared `video` object
carries `{ type, id, src, title, poster, backdrop, year, season, episode }` so
every client can load the exact same title and episode.

## Admin monitoring (api-2026-09-13.39)

**@jeff is the deployment admin.** `users.is_admin` (self-provisioning
ALTER) is seeded idempotently by `ensureSchema` for username `jeff`.

- **Room registry:** `rooms_created` D1 table — `POST /api/rooms` records
  the creator + timestamp (`INSERT OR IGNORE`, best-effort, never blocks
  minting). Rooms live in non-enumerable Durable Objects, so this registry
  is the only server-side "who created what, when".
- **`GET /api/admin/overview`:** admin-only (401 anon / 403 otherwise).
  Returns user + room stats (total, last 24h, last 7d), the 50 most
  recent of each, and LIVE room occupancy parsed from presence KV
  (list + get, capped at 200 keys).
- **UI:** shield nav item — hidden unless `/api/auth/me` says `is_admin`
  — opens an admin drawer: stats chips (Users / New 24h / Rooms / Live
  now), live rooms with LIVE badges, rooms-created list, users list with
  joined/seen times.
- `is_admin` rides ONLY on `/api/auth/me`; public profile/search payloads
  never include it. All enforcement is server-side.

## Subtitles: language stays put + floating sync bar (api-2026-09-13.40)

**Language-flip fixes (subs v15):**
- `searchBest` now tries ALL ranked candidates (server caps at 12) instead
  of the top 5 — a run of dead hosts no longer reads as "no Indonesian
  subs" and silently flips the chain to English.
- **Room priority:** the host's loaded file outranks every guest's local
  auto-load (`roomSubsActive`); an arriving host load cancels in-flight
  local searches (generation counter) so a slower guest search can never
  override the room's language. Manual picks (language select / Auto-load
  button, `force`) still win.
- Per-step console logging: `[WatchParty] subs <lang>: N candidates…`.

**Mini-map thread sync (subs v20):** ONE-MINUTE window, playhead pinned
dead-center. Every caption is a BLOCK whose LENGTH equals its own
timestamp duration (`00:02:05,867 --> 00:02:08,221` = 2.4s = 24px on the
60s/600px scale), colored by the alternating user palette (#5003C0 /
#AB03A9 / #FF467A / #FFD51E - adjacent bars always differ). The whole
scale slides under the stationary head (one transform per frame); grab
anywhere and slide to sync (1px = 1px, live local, ONE room replication
on release). Head hidden until the player clock reports. Tap a block +
"Align to playhead" for exact matching; "Reset sync" returns to zero.

**IP LANGUAGE FIRST (subs v20 + i18n):** `WP.I18N.language` never existed
(the subs default silently fell to 'en'). i18n now exports the resolved
language, and the subtitle auto-load chain is: EXPLICIT user pick
(flagged 'wp:subslang:explicit', set only by changing the select) >
IP/geo language > 'en'. Stale unflagged saved values can never override
the IP language again - Indonesian subs are the default, impossible to
miss.

## Seek chat log + bar removed (api-2026-09-13.40)

- **Host seeks land in the chat**: `⏩ <name> seeked to 1:02:05`
  (h:mm:ss, or m:ss under an hour) as a PERSISTED system line, so late
  joiners see it too. Scrub bursts dedupe (rapid seeks within 1.5s AND
  within 2s of the same spot stay silent; a different target always
  logs). Guests cannot seek, so they cannot spam it.
- **The room seek bar is removed** from the player UI (markup, wiring,
  styles). The current/total time labels remain. Hosts still seek via
  the embedded player's own controls - the sync manager mirrors those
  clock jumps to the room exactly as before.

## Progress row removed + dual-mode mini-map, persisted (ui-2026-09-13.42)

- **The progress row under the player is GONE** (time labels included):
  markup, updateProgress/resetProgress plumbing, and all CSS. The sync
  'progress' event still drives the play/pause button and room presence.
- **Mini-map has two modes with a toggle (⤢ full / ⏱ 60s):**
  FULL (default) spans the whole subtitle file - every caption bar always
  visible, head travelling with the clock. ZOOM is the 60-second window
  with the head pinned mid-strip for precise sync work. The choice
  persists in localStorage ('wp:subsmap:zoom') and is restored on load.
  Both modes keep duration-sized bars, the alternating palette, the 2x
  offset fix, thread-drag sync and Align/Reset.

## Likes + For You suggestions (api-2026-09-13.41)

- **LIKE system** (uncapped; distinct from the pinned-4 favorites):
  heart button on every catalog card (optimistic toggle, sign-in gated),
  `POST /api/user/likes/toggle`, `GET /api/user/likes/ids`, profile
  "Liked (N)" grid + `likesCount` stat, `likes[]` in the profile payload.
- **For You row** on the home feed: TMDB `/{type}/{id}/recommendations`
  seeded by the user's 4 most recent likes, KV-cached 24h per seed,
  merged + deduped + ranked by seed overlap (`rankSuggestions`, unit
  tested), excluding seeds/liked/watched. Titled
  "For you · because you liked <seed>".

## Room episode switcher + subs panel declutter (ui-2026-09-13.44)

- **Episodes button in the room player** (hidden for movies): opens a
  compact season/episode modal (WP.Catalog.openEpisodes) with the current
  episode highlighted. Host picks apply room-wide via the normal
  videoChange path; guests send a request, same as Browse.
- **Subtitles panel: 5 button rows -> 3.** Row 1: On/Off, language,
  Auto-load, file upload (compact). Row 2: offset stepper + one-press
  Sync (hint is the tooltip). Row 3: mini-map, Align, Reset, 60s/full
  zoom, text Size. The duplicate "Reset offset" button was removed
  (Reset routes through the same room-sync path).

## First-load subtitles fix (api-2026-09-13.41)

Joiners inherited the host's subtitle fileId BEFORE knowing the download
would succeed: roomSubsActive was set optimistically and the joiner's own
auto-load was superseded - so a failed inherited download left the room
with NO subtitles at all. Now the room-priority flag is claimed only
after a successful parse; any failure falls back to the local auto-load
(force). A new video resets the priority and the DO now CLEARS this.subs
on videoChange (a new title/episode must never inherit the previous
file - fresh joiners auto-load fresh subs).

## Player like button + threaded episode rows (ui-2026-09-13.46)

- **Like button in the player controls**: same like system as the card
  hearts (optimistic toggle, sign-in gated, follows the current video's
  state). Liked = red ♥.
- **Threaded episodes for long seasons**: the >120-episode numeric-input
  shortcut is GONE. Seasons over 50 episodes render EVERY episode in
  collapsible thread rows of ~50 ("E1-50", "E51-100", ...) with lazy
  button materialization; the current episode's row auto-opens and
  scrolls into view. Applies to the detail picker, the anime flat picker
  and the room episode-switcher modal.

## One episode grid everywhere + Like button fixed (ui-2026-09-14.47)

- **Consistency**: `renderEpisodeGrid()` is now THE episode grid component.
  All three surfaces (detail picker, anime flat picker, room
  episode-switcher modal) route through it: flat grid <=50 episodes,
  collapsible thread rows >50 - one single `>50` decision in the code, so
  threading can never drift between surfaces again. Episode-name tooltips
  now enrich BOTH shapes (cached per show+season), including thread rows
  built lazily when opened.
- **Like button on the watching page actually works now**: the markup
  ships `#like-video` disabled and `updateVideoUI` never enabled it (its
  painter was also scoped inside `initRoomUI`, out of `updateVideoUI`'s
  reach). The painter is hoisted to module scope and `updateVideoUI` sets
  `likeBtn.disabled = !(v && v.id)` - Like sits between Browse and
  Episodes, is clickable whenever a video is loaded, and re-hydrates its
  ♡/♥ state on every video change. Sign-in gated with a toast.

Tests 130/130, tsc clean. app.js v30 / catalog.js v18 / ui-2026-09-14.47.

## Anime episode fix: absolute numbering in the room modal (ui-2026-09-14.48)

- **BUG**: the room episode-switcher fetched TMDB seasons for anime. TMDB
  splits long anime into many seasons whose numbers restart at 1 (One
  Piece "Season 14, E5"), but the anime player plays
  `/anime/<anilistId>/<episode>` with that number as the ABSOLUTE episode -
  so "S14 E5" replayed absolute episode 5 (Romance Dawn). Affected EVERY
  anime, worst for multi-season-on-TMDB shows; single-season anime were
  only accidentally correct.
- **FIX**: for anime the modal now resolves the AniList id (worker
  endpoint, then direct GraphQL fallback) and renders ONE flat absolute
  grid 1..N (AniList episodes; TMDB total when ongoing shows report null;
  falls back to the old grid only when no match exists). Picks build the
  anime video with `{ episode: n }` and never a season; the current
  episode highlights correctly; threading still applies past 50.

## Theme: system dark/light respected + profile toggle (ui-2026-09-14.49)

- **The app always respects your device dark/light mode now.** Light theme
  ships via CSS (`prefers-color-scheme` by default — zero JS, no flash);
  `color-scheme` is set per mode so scrollbars/inputs follow too, and the
  browser UI color (`theme-color` meta) adapts.
- **Profile editor → Theme**: System (auto) / Light / Dark segmented
  control. An explicit pick is saved device-locally
  (`wp:theme:explicit`, like the access code flow — NOT profile data) and
  applied instantly via `html[data-theme]`; a pre-paint inline script in
  index.html applies it before first paint so switching never flashes.
- Subtle translucent fills (ghost buttons, chat/up-next hovers, subs
  mini-map track) moved to semantic `--fill-*` vars that flip direction in
  light mode; header brand text follows the theme instead of staying white.
  Video surfaces stay black (players should).

## Light-theme contrast fix: no more same-on-same surfaces (ui-2026-09-14.50)

- The first light palette collapsed elevation steps (`--bg-elev` == page
  background): tiles, default buttons and active nav items literally
  blended into their surroundings. The light palette now mirrors the dark
  theme's shade steps: page #fff -> card #f7f7f7 -> tile #f1f1f1 ->
  hover #dddddd (inputs #f4f4f4, borders #e0e0e0) — in BOTH light blocks.
- Tile-style controls got real rims: avatar-frame + theme picker options
  (was `border: transparent`), poster fallback placeholders, and the
  peers "+N" avatar uses the raised tone with a visible ring.
- Audit + pins: a scanner asserts no rule pairs `var(--bg-elev)` with a
  transparent border outside hover/selected states, and the palette test
  pins the distinct steps in both light blocks. Tests 132/132.

## Stability audit: late-reply races + server error hardening (ui-2026-09-14.51)

Full code-and-logic audit for daily-use stability. Verified sound: all
localStorage `JSON.parse` sit in try blocks (corrupt storage degrades to
defaults), `ensureSession` always resolves (network failures return
`ok:false`, never throw), WS messages parse-guarded, room re-entry uses
property-assignment wiring (no duplicate handlers), every `$('id')`
reference resolves in the DOM, `getLikeIds` fails soft for guests.

Fixed (all found by the audit):
- **Stale-reply races on the like button** (4 paths): a slow
  `getLikeIds`/`toggleLike` response for a video (or card) the user
  already switched away from painted the WRONG heart onto the CURRENT
  video/card. Every reply is now validated against the current video
  before painting; detached catalog cards skip the paint.
- **Hover trailer preview**: fetch failure raised an unhandled rejection
  — now caught (preview just stays a poster).
- **Worker**: `routeApi` had no top-level catch — one thrown handler
  (D1 hiccup, edge case) took the request down as a raw error page. It
  now returns a parseable JSON 500 with CORS headers.

New tests/stability.test.mjs pins all three classes (4 guarded like
paths, detached-card guard, trailer catch, worker try/catch + JSON 500,
try-wrapped JSON.parse sweep). Tests 135/135, tsc + node --check clean.
app.js v31 / catalog.js v20 / social.js v43 / ui-2026-09-14.51.

## Theme: home top bar + player watch page verified/fixed (ui-2026-09-14.52)

- **Home top bar** (`.topnav`) was STILL hard-coded dark
  (`rgba(15,15,15,.92)`) - in light mode it stayed a dark bar under the
  now-themed near-black brand text. It now uses `--topnav-bg`
  (translucent white .92 in light, dark .92 in dark), keeping the blur.
- **Player watch page**: header/chat/chips were already var-driven; the
  over-video `sync-indicator` pill is PINNED light-on-dark (`#cccccc`) -
  it sits on the black player, so it must NOT follow the theme (it was
  `--text-dim`, which turns dark-grey-on-black in light mode). Video
  surfaces stay black by design.
- Pins: topnav var in :root + both light blocks, themed background,
  pinned overlay color. Tests 135/135. style.css v19 / catalog.css v13.

## Full color audit: root cause found + every hardcoded ink fixed (ui-2026-09-14.53)

ROOT CAUSE (why fixes "didn't take"): **catalog.css contained the entire
stylesheet TWICE** (~2250 lines; second copy won the cascade) - every
themed rule I patched in the first copy was silently overridden by the
stale hardcoded duplicate (topnav dark bar included). Deduplicated to
1217 lines; duplication now test-BANNED.

Exhaustive literal sweep (all 3 stylesheets inventoried, every color
classified):
- New theme vars: --on-accent (ink on accent fills: dark ink on bright
  blue in dark mode, WHITE ink on dark navy in light - the old
  `#0b0b0b`-on-blue buttons were unreadable in light), --amber (away
  status: pastel dark / deep amber light).
- Fixed inks: secondary + chat-send buttons, active chips (black-on-black
  in light -> var(--bg) inverse), spinner (currentColor), error toast,
  host chip, peer badges, chat owner/you markers, subs error, presence
  watching/idle, access-code reveal, code warning - all pastel/`#fff`
  literals -> var(--red)/var(--blue)/var(--green)/var(--amber)/var(--bg).
- Default .btn got a real border (was transparent on tinted surfaces).
- Remaining hardcoded literals are ALL intentional and exactly
  allowlisted: brand red/blue/green accents, on-video overlays (sync
  pill #cccccc/#f5d76a, scrims, hero gradients), on-accent #fff inks,
  avatar chip #444, IMDb yellow.
- tests/color-audit.test.mjs: banned-literal list, EXACT allowlist
  counts (any new hardcoded literal fails CI until reviewed), 16
  structural var pins, and the duplication detector.

Tests 139/139, check clean. style v20 / catalog v14 / social v16 / ui .53.

## Room focus: sidenav auto-collapses in rooms (ui-2026-09-14.54)

- Entering a room auto-collapses the guide rail to the 72px icon strip
  (video + chat get the space); leaving restores EXACTLY the pre-room
  state. The auto move is contextual only - it NEVER writes
  `wp:sidenav` (that stays the manual toggle's pref), and a manual
  expansion inside the room wins (leaving won't re-collapse behind the
  user's back). Mobile is unaffected (already icon-only ≤720px).
- Pinned in tests/stability.test.mjs (setter/reader singletons, restore
  conditional, manual-win rule, no-persistence). Tests 140/140.
  app.js v32 / ui-2026-09-14.54.

## Room focus II: the guide rail is now FULLY hidden in rooms (ui-2026-09-14.55)

- The 72px icon strip was still too much for the room: entering a room
  now HIDES the sidenav completely (`body.room-focus .sidenav { display:
  none }`); leaving the room restores exactly the pre-room state
  (unchanged restore rules: auto-collapse never persists, manual wins).
- Stranded-proof: the room header gains a Menu button (visible ONLY in
  rooms) that temporarily peeks the icon strip (`rail-peek` class,
  in-memory only) - toggle it away again or just leave the room.
  Brand-home link also stays for full navigation.
- Pins: room-focus add/remove, peek wiring + icon-strip, CSS rules,
  Menu button room-only. Tests 140/140, check clean.
  app.js v33 / catalog.css v15 / ui-2026-09-14.55.

## Dedicated watch-history page; removed from the home page (ui-2026-09-14.56)

- History is its own surface now: the sidenav "Watch history" item opens
  a real /history URL (back-button friendly, active nav state), instead
  of scroll-to-section-on-home (with a toast when empty).
- The home page no longer renders a history section at all.
- The page shows the same history cards as a WRAPPING GRID (not the home
  strip) and a friendly empty state instead of a blank page; Clear works
  in place. Leaving the page (home / discovery / profile / back) tears
  it down with the same symmetry as the other views.
- Pinned in stability tests. Tests 141/141, check clean.
  app.js v34 / catalog.css v16 / ui-2026-09-14.56.

## Jikan (MAL) integration + auto-advance data-correctness (ui/api-2026-09-14.60)

USER REPORTS FIXED:
- TWD S02E13 auto-advanced to a phantom E14: TMDB's season episode_count
  METADATA lies. TV auto-advance now uses the SEASON DETAIL episode list
  (specials skipped by episode_type), offers next-season E1 at a season
  finale, and refuses ghost episodes. Series finale = no offer.
- JoJo-class anime listing inaccuracies: the anime pipeline now runs on
  JIKAN (MyAnimeList) via /api/jikan - absolute numbering, TRUE episode
  counts and REAL titles for the anime detail picker, the room episode
  modal and auto-advance. Affected every anime with odd TMDB seasons,
  not just JoJo.

JIKAN INTEGRATION (per docs.api.jikan.moe, limits 3/s + 60/min):
- Worker proxy /api/jikan/anime/:malId/episodes?page=N: in-memory 6h
  edge cache + token bucket UNDER upstream limits (2/s, 50/min),
  fail-soft 429; client falls back to AniList/TMDB - zero regressions
  when Jikan is down. IP-damped 60/min. Mal ids come from the AniList
  resolve (idMal was already queried - now returned as malId) and flow
  through buildVideo -> history entries (survive restarts). Client
  caches lists 24h in localStorage.

Tests 153/153 (jikan route runtime-tested: normalization, cache hit,
422, throttle), tsc clean. catalog v21 / app v38 / utils v8 / ui+api .60.
