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

## Jikan rolled back -> AniList-native + mobile/desktop readiness (ui/api-2026-09-14.62)

- JIKAN REMOVED entirely (route, proxy, client helpers, caches): the API
  is being discontinued. Anime data runs on the ANILIST-NATIVE pipeline
  we already battle-test: canonical `episodes` count via the worker
  resolve (direct GraphQL fallback), absolute numbering, and the
  data-correctness rules survive - broken TMDB anime grids never render
  when an AniList id exists ("unavailable" note instead), auto-advance
  refuses ghost episodes, TV still uses real season lists (specials
  skipped, season finale -> next season E1), and `malId` (AniList's own
  idMal) stays plumbed through buildVideo/history for future needs.
- MOBILE/DESKTOP readiness: viewport heights use 100dvh (iOS toolbar-
  safe, vh fallback first); touch devices (hover: none) always show the
  per-item history remove + card hearts (no hover to reveal them) and
  get >=38px small-button targets; the up-next overlay wraps on small
  screens. Zero jikan references remain (test-pinned).
- Tests 152/152, tsc clean. catalog v22 / app v39 / style v22 /
  catalog v18 / social v17 / ui+api-2026-09-14.62.

## Boruto fix: dual-variant AniList search + cache misses live 5 min (ui-2026-09-14.63)

REAL-DATA DEBUG (themoviedb.org/tv/70881, fetched live): TMDB's Boruto is
name "Boruto: Naruto Next Generations", original_name
"BORUTO-ボルト- NARUTO NEXT GENERATIONS" (2017). Two stacked bugs:
1. The worker searched ONLY original_name - AniList's SEARCH_MATCH handles
   the mixed-script string worse than the romaji `name`, so the candidate
   page could miss Boruto entirely. The worker now searches BOTH variants,
   merges candidates by id, and scores them all.
2. BOTH client caches (worker path + direct GraphQL fallback) stored
   UNRESOLVED results for 7 DAYS - one transient blip poisoned a title for
   a week (the actual "we couldn't match it" the user kept seeing).
   Resolved matches still cache 7 days; misses now live 5 MINUTES.
   Cache prefix v3->v4 + endpoint ?v=2->v=3 clear everyone's poisoned
   entries on first load.
Pinned with the REAL TMDB fixture (70881) against AniList-shaped
candidates incl. Naruto decoys. Playground query to eyeball the raw API:
{"query":"{Page(page:1,perPage:5){media(search:\"Boruto: Naruto Next Generations\",type:ANIME,isAdult:false,sort:[SEARCH_MATCH]){id title{romaji english native} episodes startDate{year}}}}"}
(graph.anilist.co - POST). Tests 154/154, check clean. catalog v23 / ui .63.

## HOTFIX: anime feed empty (rate-limit burst) - sequential + bounded (ui/api-2026-09-14.64)

The Boruto dual-search ran BOTH title variants IN PARALLEL, and the anime
feed classifies 20-40 titles per view with an UNBOUNDED Promise.all - so a
single view fired up to ~80 concurrent AniList POSTs, got rate-limited,
and every classification failed: the anime feed went EMPTY and the strict
no-TMDB-fallback rule turned the rest into "couldn't match". This broke
everything anime after the previous fix deployed.

Fix: (1) title variants now try SEQUENTIALLY (name first, then
original_name only on a miss) - the Boruto fix keeps working at 1x
steady-state cost; (2) classifyAnime resolves with bounded concurrency
(3 workers, 150ms stagger) - the worker's day-long cache absorbs repeat
views. Pins for both. Tests 155/155, check clean.
catalog v24 / ui+api-2026-09-14.64.

## Anime dead-end removed: unmatched -> real TMDB seasons (ui/api-2026-09-14.65)

USER DIRECTED (after the rate-limit hotfix still showed the wall): TMDB
anime entries carry proper /season structure (JoJo-class catalogs) - an
anime that fails to resolve on AniList must degrade to that REAL season
picker (chips + per-season grids on the tv path), not a dead end.

- renderAnimeUnresolved ("couldn't match it on AniList") DELETED. The
  unmatched branch renders renderDetailBody with the item's own TMDB
  seasons as a normal series (isAnime/type unset so buildVideo makes tv
  videos). If a later resolve matches, the absolute AniList grid takes
  over again. Matched anime: unchanged.
- Worker failure-cache 5min -> 15 SECONDS (+ Cache-Control max-age=15,
  both sites): a rate-limit window now recovers in seconds instead of
  compounding into minutes of unresolved titles.
- Pins: dead-end message + renderer gone, fallback wiring, matched path
  unchanged, worker 15s failure TTL. Tests 156/156, check clean.
  catalog v25 / ui+api-2026-09-14.65.

## Auto-advance hotfix: derived end detection + Auto next toggle (ui-2026-09-14.66)

WHY IT STILL LOOKED BROKEN: auto-advance relied on the embed posting an
explicit 'ended' playerstatus - if the embed never sends one (unknowable
from outside the iframe), nothing ever triggered. Now the end is ALSO
DERIVED from the status poll: paused within 2.5s of a >30s duration after
having actually played = the end. Fire-once-per-load (re-armed on every
video load); the explicit 'ended' event dedupes against it, and
mid-video pauses never count.

AUTO NEXT TOGGLE: new button in the room player bar (Between Like and
Episodes): "Auto next: on/off", device-persisted (wp:autonext, default
ON, red accent while on). It is the FIRST gate in the ended-path: OFF =
the episode simply stops (no overlay, no countdown, no guest hint).
Each viewer controls their own preference; only the controller's
decision can actually change the room's video.

Behavior-tested with the real sync manager (derived fire-once, no dupes
on later polls, mid-video pause != end) + structural pins. Tests
159/159, check clean. player v12 / app v40 / style v23 / ui-2026-09-14.66.

## Seek-war hotfix: resume races the host ack; chat dedupe widened (ui/api-2026-09-14.67)

USER EVIDENCE: resuming flooded the chat with 1-second seeks (0:03, 0:04,
... 0:12) while the player snapped back. Root cause chain:
1. The resume fired on player-ready and consumed the pending position
   BEFORE knowing it could drive the room - on a slow host ack the
   broadcast was silently dropped, the room stayed at ~0, and the
   convergence loop fought the host forever (a seek WAR). The lines in
   the chat were the host's own mirrored drags against the snap-back.
2. The convergence loop re-"corrected" toward the room's stale projection
   while the embed was still catching up to our own command.
3. The DO's seek-log dedupe window (1.5s) was narrower than the war's
   re-seek cadence, so the persisted chat flooded.

Fix: resume is now a RETRYING helper (tryResume) - consumed exactly once,
only when sync + video + canControl() are all true (re-armed by the late
host ack too); the controller skips position corrections within 1.5s of
its own command (WAR GUARD); the DO dedupe window is 4s. Pins for all
three. Tests 160/160, check clean. player v13 / app v41 / ui+api .67.

## Phantom-pause audit: root cause + 10-defect kill chain (ui/api-2026-09-14.68)

USER REPORT: "resume -> it auto-pauses; the pause banner comes after the
video plays but the player still runs (sound on)". Full audit of the sync
manager found the chain and killed it:

| # | Defect | Fix |
|---|--------|-----|
| 1 | Mirror broadcast a PAUSE off ONE stale status (400ms debounce re-read the same observation — no new evidence) | A pause now needs 2 independent status observations + 500ms persistence |
| 2 | No startup grace: after OUR play command, boot/seek lag reports "paused" -> instant phantom pause + banner while the embed then plays (split-brain: banner says paused, sound continues) | START LATCH: no pause mirror until the embed confirms playing (bounded 8s) |
| 3 | Buffering stall treated as a user pause | Pause mirror needs 1.5s buffering-free runway (_lastBufferingAt) |
| 4 | Pause candidate waited for the next 3s poll to confirm | New pause candidate requests fresh status IMMEDIATELY; fast recheck when the age gate opens |
| 5 | loadVideo kept the PREVIOUS title's native-seek baseline -> bogus seek mirror on a new load | _lastStatus (+_freshUntil/_remoteAppliedAt/_lastPauseAssert/latch) reset per load |
| 6 | Discrete play/pause embed events bypassed convergence entirely | _syncToTarget() on play/playing/pause/paused events |
| 7 | DO PLAY/PAUSE/SEEK with a non-finite time snapped the room to 0 | keep the CURRENT position instead (all three handlers) |
| 8 | Echo-guard reset dropped the confirmations counter (pause confirmation could never recover) | shape kept consistent |
| 9 | Duplicate _endedFired declaration (.66 sloppiness) | removed |
| 10 | localPause(localTime) passed a pointless arg | cosmetic |

Behavior-tested against the real manager: boot-lag resume never pauses
(#1/#2), a single stalled status cannot pause (#3/#4), buffering blocks
the mirror, a REAL persistent pause still lands (exactly once), new-load
hygiene. Tests 166/166, check clean. player v14 / ui+api-2026-09-14.68.

## Minimal shape pass: the ovals are gone (ui-2026-09-14.69)

User direction: minimalism — "remove the oval on the button". The pill
radius (999px) was applied to 21 button/chip/input/badge surfaces across
style.css, catalog.css and social.css. Flattened to a consistent scale:
8px for buttons, chips, search/chat inputs, toasts, presence pills;
6px for small count badges; 10px for the large up-next overlay.
Circles kept where a circle MEANS circle: avatars (50%), scrollbar
thumb. Focus rings kept (a11y). Skeleton shimmer / avatar-cosmetics
gradients untouched (functional or paid features). style.css v24 /
catalog.css v19 / social.css v18. Tests 167/167 (shape pinned: no
999px outside the scrollbar, .btn flat 8px).

## Cover fixes (#11) + profile gap (#12) (ui-2026-09-14.70)

#11 COVER GONE ON EPISODE SWITCH: the room episode switcher rebuilt the
video from {id,type,title} only — poster/backdrop/overview were dropped,
so updateVideoUI removed the cover. Both pick paths now SPREAD the room
video (...video), keeping the artwork. Detail modal: the cover now
FOLLOWS the selected season (TMDB ships poster_path per season; broken
season art reverts to the show poster, never a torn frame). Episodes
modal: new compact cover row (64px, 8px radius) — show title + season
label that follows the chips; anime path shows the show art + episode
count. Room cover also gains a broken-art guard. catalog v26 /
catalog css v20.

#12 PROFILE GAP: the favorites showcase always rendered 4 poster-height
slots; empty ones were huge dashed holes above Friends. Visitors now see
only real favorites; your own profile gets compact add-affordances
(aspect-ratio released, grid no longer stretches them). social css v19.

Tests 169/169 (pins updated: absolute-episode contract kept — season is
still never passed for anime picks). ui-2026-09-14.70.

## Server-side watch memory: history + episode + position in D1 (ui/api-2026-09-14.71)

USER ASK: "lets make it history watch and episode save in server
database, so it always remembers the episode that been watched".

Before: watch_history rows existed per (user, media, season, episode)
but carried NO position, and the client POSTed only at video start —
progress lived (and died) in localStorage. Another device = amnesia.

Now:
- D1: watch_history gains position_seconds/duration_seconds (fresh DDL +
  self-provisioning ALTER for existing DBs + migrations/0003).
- POST /api/user/history upserts the position (clamped, single row per
  episode); GET returns positionSeconds/durationSeconds.
- Client: saveWatchProgress now also pings the server every ~8s
  (fire-and-forget, signed-in only); episode end marks completed
  (position = duration); recordHistoryFor carries a resume position.
- RESUME ACROSS DEVICES: startRoomWithVideo looks up the server entry —
  upgrades the pending resume when the server is 30s+ ahead, never
  downgrades, and finished episodes (>= dur-30) start fresh.
- /history page: server-only cards now render the red progress bar AND
  keep their position on click (previously discarded).

Deploy note: the D1 columns self-provision on the first profile-route
request; `npm run db:migrate:remote` applies migration 0003 explicitly.
Tests 171/171, check clean. app v42 / ui+api-2026-09-14.71.

## /history blank-page regression + watched fade (ui-2026-09-14.72)

USER: "/history doesn't showing, also where the faded after the movie
being watched". ROOT CAUSE: renderHistory() guarded on $('history') —
an element removed from the DOM long ago — so the function returned
before rendering a single card. The page was (silently) always blank:
no cards, no server merge visible, no progress bars. Guard now requires
only #history-scroller.

WATCHED FADE: a finished movie/episode (completed flag, or watched past
duration-30s) now shows a FULL faded red bar (opacity .45, YouTube
"already watched" style) instead of disappearing. Partial watches keep
the percent bar. catalog css v21.

Tests 172/172 (dead-guard pinned absent + fade pinned). app v43 /
ui-2026-09-14.72.

## Watched-episode fade in the episode selectors (ui-2026-09-14.73)

USER: "the episode on the details / episode selector [should show] the
watched episode faded". Every episode grid (detail modal tv seasons,
anime absolute grid, and the room episodes modal — flat AND threaded
>50 rows) now marks:

- WATCHED (completed, or >= duration-30s): faded (opacity .45) + a
  red check badge (ink var(--on-accent), color-audit clean) + tooltip.
- IN PROGRESS (>15s): a mini red progress bar sized --wp inside the
  tile + "In progress" tooltip.
- The CURRENT episode keeps its highlight (never faded).

Sources: local history paints instantly; the server history (cached
per show, one fetch) re-paints cross-device when it arrives. Painter is
deep + idempotent so lazily-materialized thread rows decorate too.
catalog v27 / catalog css v22 / ui-2026-09-14.73. Tests 173/173.

## /history empty: evidence-based diagnosis + never-silent render (ui-2026-09-14.74)

USER: "history broken, it's just empty". Instead of another theory, the
render path was EXECUTED: renderHistory + renderHistoryChips were sliced
out of the shipped app.js and run against a stub DOM — HEAD renders
cards, chips, hides the empty state, zero exceptions (now a permanent
test file: tests/history-render.test.mjs, 4 execution cases).

Verdict: an empty page at HEAD can only be (a) a stale client still
running the pre-.72 dead-guard build, or (b) genuinely no data on that
browser (empty local storage + signed out — server memory needs the
account). Shipped hardening so neither can ever look like a silent
blank again:
- renderHistory is wrapped: a failure now logs '[history] render failed'
  AND surfaces "History failed to load: <cause>" IN the page.
- The empty state is self-explanatory: signed-out users see "Sign in and
  your watch history follows you across every device"; signed-in users
  see the account-empty hint.
app v44 / ui-2026-09-14.74. Tests 178/178, check clean.

## /history round 3: nav dead-end fixed + never-blank setup + global error surface (ui-2026-09-14.75)

User at stamp .74: still blank + "cannot redirect to homepage after
clicking history". Full route chain (routeCurrent → showHistoryView →
teardowns → render, signed-in, server payload) EXECUTES clean in the
harness — so the blank lives in their runtime. Shipped:

- PROVEN NAV BUG: the Home nav branch handled room/profile/discovery
  but had NO /history case — from /history, Home did nothing. Fixed
  (push '/' + routeCurrent).
- NEVER-BLANK SETUP: showHistoryView now isolates every teardown step;
  a throw can no longer leave home hidden + history hidden (blank +
  stuck). The page always unhides and renders; failures log.
- GLOBAL ERROR SURFACE: uncaught errors/rejections now toast on screen
  for 10s with the cause — "it's blank" reports come with evidence.
app v45 / ui-2026-09-14.75. Tests 179/179, check clean.

## /history is now SERVER-FIRST with an on-page status line (ui-2026-09-14.76)

USER DIRECTIVE: "just doing it from server db, and its better" — done:
- Signed in: the ACCOUNT history (D1) is the source of truth. Server rows
  become FULLY PLAYABLE cards (src rebuilt via Catalog.buildVideo from the
  id) carrying their resume positions; local entries only fill gaps.
  Signed out: local history as before.
- NEW STATUS LINE on the page (#history-status): "Account: N titles ·
  This device: M" — or "Account history unavailable: <reason> - showing
  this device only" in red. Which side has the data is now VISIBLE, no
  console needed. This ends the blank-page debugging loop for good.
- Single click path: every card has src + position; the old
  discard-position fallback is gone.
- social.js: getServerHistoryStatus() (failure reason surfaces instead
  of the silent catch-and-null).
Execution-tested: server rows render with src + status counts; a server
failure shows in-page while local still renders. Tests 182/182.
app v46 / social v45 / catalog css v23 / ui-2026-09-14.76.

## /history self-diagnosis build (ui-2026-09-14.77)

The full app was reproduced END-TO-END in jsdom (real index.html, all 8
scripts executed, signed-in session, 62 server rows + 13 local, booted
straight to /history through the real route chain): 75 cards render in
the DOM with the exact status line the user quoted. Code + DOM + data
are proven; the user-side blank must come from the rendering
environment. Shipped so the next look is DEFINITIVE:

- Status line now self-diagnoses: "Account: N · Device: M · Cards: X
  (DOM: Y)" — built-vs-in-DOM counts pinpoint the failing layer.
- CSS canary: an EMPTY #history-scroller prints a red warning line.
- Defensive: .history-card is a guaranteed opaque box (display/min-
  height/bg/border) — cards cannot be silently invisible.
- Console breadcrumb: '[history] rendered N cards, M in DOM'.
catalog.css compacted back under the 1400-line dedup ceiling.
app v47 / catalog css v24 / ui-2026-09-14.77. Tests 183/183.

## History poster self-heal (ui-2026-09-14.78)

USER: cards show, posters don't. Cause: rows recorded without artwork
(posterUrl empty at record time - e.g. room flows / replays of earlier
poster-less rows). Instead of a migration, /history now HEALS:
- Cards without artwork get a TMDB lookup (/movie/:id or /tv/:id ->
  poster_path), painted in place, and the server row is PATCHED via
  recordHistoryFor - the D1 poster_urls fill in permanently over one
  page visit.
- Bounded queue: one lookup per title per session, 150ms stagger (no
  fan-out bursts - the rate-limit rule).
- Status line appends "healing posters: N".
- The healer is cosmetic-only: wrapped so it can never nuke the render
  (proven by the execution tests - a healer TypeError once wiped the
  freshly rendered cards; now impossible).
app v48 / ui-2026-09-14.78. Tests 184/184, check clean.

## THE empty-box bug: poster+body were never attached (ui-2026-09-14.79)

USER'S SCREENSHOT finally showed it: cards render as empty rounded
boxes. Root cause found by READING the deployed card-builder: the poster
div and body div were CREATED but `card.appendChild(poster/body)` was
missing - only the remove X was attached. Lost somewhere before .71
(git -S: the append string last touched in fdcfcf5); every verification
since only COUNTED cards, never their contents, so it shipped
"working" through .71-.78.

Fix: the two appends restored. Test gap closed: the execution harness
now asserts CONTENT (each card >= 3 children: poster, body with real
title text, remove control) - counting alone is banned by this pin.
Status "healing posters: 1" confirmed 62 rows already carry poster URLs
- with the appends restored those images finally display.
app v49 / ui-2026-09-14.79. Tests 185/185, check clean.

## Clean status line: type breakdown (ui-2026-09-14.80)

USER: replace "Account: N · Device: M · healing: K · Cards: X (DOM: Y)"
with a clean breakdown. The status line now reads:
"All Titles: 63 · Movies: 20 · Series: 30 · Anime: 13".
Debug counts (cards/DOM/healing) moved to the console only; the red
account-error and loading variants remain. app v50 / ui-2026-09-14.80.
Tests 185/185.

## Landscape history art (ui-2026-09-14.81)

USER: "better to use horizontal poster for the history". The card box is
16:9 but rows only carried vertical posters (center-cropped). Now:
- D1 gains watch_history.backdrop_url (DDL + self-provisioning ALTER +
  migration 0004); POST upserts it, GET returns backdropUrl.
- Both client record paths (recordHistoryFor + recordProgressFor) send
  backdropUrl.
- The self-heal now resolves BOTH TMDB arts (poster w500 + backdrop
  w780), paints the BACKDROP first (native 16:9, pixel-perfect in the
  card box), falls back to the poster, and patches the row with both —
  one visit heals all rows permanently (existing poster-only rows are
  re-resolved once: "!v.backdrop" targeting).
app v51 / social v46 / ui-2026-09-14.81. Tests 186/186, check clean.

## Host sovereignty + explicit CSP style directives (ui/api-2026-09-14.82)

USER: "don't seek the host or pause with authoritative, just ignore it
for the host, unless there's another user that has control permission."

HOST SOVEREIGNTY (player v15 + app v52):
- Once the host's player has started playing, the room NEVER seeks or
  pauses it: echoes, state snapshots and status polls are all ignored —
  the host IS the clock (their actions drive the room, never the
  reverse).
- Two exceptions, both intended: a FRESH load still follows the room
  (initial autoplay at the right spot, next-episode advance), and an
  EXPLICIT play/pause/seek broadcast from ANOTHER user with control
  permission (by !== selfName) always complies — through a dedicated
  path that skips the own-command war guard (a host's own seek must
  never eat another controller's follow-up pause).
- app.js wires sync.selfName = state.name.
Behavior-tested: snapshots don't yank, own echoes ignored, external
seek+pause comply instantly. Worker CSP: style-src-elem/style-src-attr
now explicit (the "style-src-elem was not explicitly set" fallback
note is gone; our page never relied on external styles/fonts — the
reported font block originates inside the bingr embed's own CSP).
190/190, check clean. app v52 / player v15 / ui+api-2026-09-14.82.

## Auto-advance sequential fix for history-started anime (ui-2026-09-14.83)

Sandbox reset #6 mid-investigation (recovered: stash snapshot 6 ->
reset to FETCH_HEAD f281fd5 -> npm ci -> suite green 190/190 before
any patch).

USER: "auto advance doesn't advance sequentially". The resolver itself
was execution-proven sequential (TV E5->E6, specials skipped, season
rollover S1E3->S2E1, anime absolute E99->E100). The REAL break: anime
started from a SERVER-FIRST HISTORY CARD has no anilistId (the D1 row
doesn't carry it) and the anime branch dead-ended (null = "nothing to
advance to") AND its src used the TMDB id in place of the AniList id.

Fix (app v53):
- startRoomWithVideo: anime-from-history resolves its anilistId (+
  malId) once, bounded 4s, and rebuilds the src with the REAL id before
  the room starts (same object flows into state.video).
- resolveNextEpisode: the anime null dead-end is GONE - a missing
  anilistId is resolved in place (bounded), and if AniList has nothing
  the TMDB season walk (tvAdvance) still advances sequentially.
Harness-proven: anime-from-history E99 -> E100 (+id attached),
unmatched anime E3 -> S1E4, TV finale -> S2E1. Tests 191/191, check
clean. app v53 / ui-2026-09-14.83.

## The /history split-UI: the room swap forgot the history page (ui-2026-09-14.84)

USER: "watching from history its broken the ui is splitting". Root
cause, byte-verified: enterRoom's view swap hid home-nav/home/profile
and tore down #discovery (with a comment documenting the EXACT failure
mode: "leaving it visible stacks the player and the grid on top of each
other") — but #history-page, which shares the same fixed-height column,
was never added. Entering a room from /history (the only path where
that page is visible) stacked the history grid and the player = the
split UI.

Fix: teardownHistoryView() joins the swap (discovery -> history ->
room). Pins updated: stability now counts 4 teardown sites; the
discovery no-stacking regex accepts the history teardown in sequence.
(Sandbox reset #7 recovered before patching; suite green on ad8927f
first.) app v54 / ui-2026-09-14.84. Tests 192/192, check clean.

## Full-system audit: episode-modal TDZ, room ownership recovery, /history reload (ui/api-2026-09-15.85)

Three defects found in a full read of the worker, the Durable Object, the
D1/KV routes and every shipped bundle; each one is now pinned by a test that
EXECUTES the shipped code (or the DO harness) and fails on the pre-fix build.

1. EPISODE SWITCHER DIED FOR MANY SERIES (dist/js/catalog.js). The season
   list is built with a `.map()` whose poster falls back to the show's own
   art (`... || showPoster`), and `const showPoster` was declared BELOW that
   map. `.map()` runs eagerly, so a season with no `poster_path` of its own
   read the const inside its temporal dead zone: ReferenceError -> the
   modal's catch -> "Could not load episodes — try again." for the whole
   show. A truthy season poster short-circuits `||`, which is why it looked
   intermittent. Declaration hoisted above the map.
   New tests/episodes-modal.test.mjs executes the real bundle in a stub DOM:
   red before the hoist, green after.

2. A ROOM COULD LOSE ITS HOST FOREVER (src/WatchRoom.js). `join` promoted a
   newcomer only when `!meta.ownerId`, so its `&& !hasLiveOwner()` guard was
   dead code and a stale ownerId (redeploy, or the alarm's ghost prune)
   blocked promotion permanently — every play/pause/seek/videoChange was
   dropped with no recovery path. The alarm's liveness pass also skipped
   anonymous sessions, so an anonymous host's ghost kept its roster slot and
   the host badge indefinitely, and pruning never transferred ownership.
   `hasLiveOwner()` now reads the runtime's live socket list (authoritative,
   survives hibernation), EVERY ghost is pruned, and the alarm hands the room
   to the oldest live peer when the owner is gone.
   New tests/room-ownership.test.mjs fails 3/4 on the old code.

3. /history DID NOT SURVIVE A RELOAD (dist/js/app.js). Room, profile and
   discovery deep links were all restored in boot(); /history had no branch,
   so refreshing (or opening a shared) /history rendered Home while the URL
   still said /history. New tests/boot-routing.test.mjs executes boot() with
   stubs and asserts all four surfaces.

Pins: catalog v29, app v55 (test pins updated with them). Tests 200/200,
check clean.

## Trailer hover preview: bigger tooltip + audio toggle (ui-2026-09-15.86)

USER: "make hover tool tip slightly bigger and add audio toggle to it,
default is on for trailer".

- SIZE: .card-preview 304px -> 360px, with the body/text scaled to match
  (title 15.5px, meta 12.5px, overview 13px, roomier padding). Still a
  tooltip-sized panel beside a 158px poster row.
- AUDIO: new .card-preview__sound chip on the media box, bottom-right.
  Default ON for every new preview; the choice persists in
  wp:trailersound and drives the next hover. Clicking it sends the YouTube
  iframe-API mute/unMute command via postMessage (no reload, the trailer
  keeps playing).
- AUTOPLAY REALITY: a hover is not a user gesture, so an unmuted autoplay is
  not guaranteed — starting unmuted can leave a frozen first frame. The
  embed therefore always starts muted (`mute=1&enablejsapi=1&origin=...`) and
  the code requests `unMute` ~700ms after the player's load event when the
  preference is ON, so the default plays with sound wherever the browser
  allows it and still plays silently where it does not. The boot-delay
  request re-checks the preference, so a click during those 700ms is never
  undone.
Tests: tests/preview-audio.test.mjs slices the shipped hover-preview section
out of catalog.js and drives it (toggle present + ON by default, persistence,
command order, persisted-OFF silence, the boot-delay race). 4/5 of its cases
fail without the feature. Tests 205/205, check clean. catalog v29 /
css v25 / ui-2026-09-15.86.

## Icons: inline SVG everywhere, and the toggle moves into the tooltip text (ui-2026-09-15.87)

USER (on .86): "i dont like the design that you using not svg but icon, change
that, also make it below toggle below it now on it" -> clarified as: the audio
toggle goes in the tooltip's TEXT AREA, right side; it is an icon-only GHOST
button; and the SVG sweep covers EVERYTHING (buttons, chips and decorative art).

- ONE ICON SYSTEM: dist/js/utils.js now owns an ICONS table (volume-2, volume-x,
  star, heart, heart-fill, check, x, zap, edit, alert, key, users, user, play,
  pause, fast-forward, skip-forward, rotate-cw, arrow-left, copy, film) plus
  WP.icon(name, size), WP.setIcon(el, name, size), WP.hasIcon(name) and
  WP.iconText(text, size). Every icon is a real inline `<svg viewBox="0 0 24 24">`
  that inherits `currentColor` (stroke 2, round caps; ratings/hearts/play draw
  filled), so it themes with the surrounding ink in both light and dark. 24x24
  arrow glyphs and emoji were the old look: gone. Unknown icon names render an
  empty svg instead of throwing, so a stale cached bundle can never take a
  surface down.
- THE SWEEP ("everything"): catalog (meta star, card + modal close buttons, the
  like heart, the tooltip), social (access-code title + copy/copied swap, code
  warning, rail toggle/close/refresh, join buttons, back link, edit profile,
  "finished" chip, empty friends/signed-out art, accept/decline, admin star),
  subs (zap on the sync button and the three "Synced" status lines, panel close),
  app (player Like heart on/off, video-bar + up-next stars, history remove),
  i18n (the "⚡ Sync" labels lost the glyph — the SVG carries it now) and
  index.html (the room-bar Like/auto-next glyphs are inline SVG). Chat system
  lines from the Durable Object still arrive as plain text with a leading glyph
  (▶️/⏸️/⏩/🎟️) — WP.iconText() translates them to SVG client-side.
- TOGGLE POSITION + LOOK: the trailer audio control left the video. The tooltip
  body is now a flex row — `.card-preview__text` (title/meta/plot) plus the
  `.card-preview__sound` ghost button pinned on the right. Transparent
  background, no border, 30x30 hit area, `var(--bg-hover)` wash on hover, dim ink
  when muted and full-strength when on (the sidenav-icon treatment). No chip, no
  red circle.
- CSS: shared `.wp-icon` / `.wp-icon--inline` / `.meta__icon` rules and flex
  centering for the icon-only buttons live in style.css; the two dead
  `#f5c518` text-`.star` rules are gone (the star is SVG now, inked by
  `.meta__icon`). catalog.css `.modal__close` is a fixed 32x32 target instead of
  26px text; the empty-friends art is muted `currentColor`, not a 26px emoji.
- TESTS: new tests/icons.test.mjs executes the shipped utils.js and enforces the
  contract — every icon name the bundles ask for exists in the table (the
  ternary swaps like `setIcon(el, on ? 'volume-2' : 'volume-x')` included), the
  SVG is 24x24/currentColor/aria-hidden, unknown names fail safe, the server's
  emoji status glyphs translate, and NO bundle or index.html line ships an emoji
  as UI. tests/preview-audio.test.mjs asserts the new placement (toggle inside
  the text area, right-most child, absent from the media box) and the ghost CSS
  instead of the old chip. Behavioral harnesses (subs/episodes-modal/ui-smoke)
  gained the SVG/text-node DOM APIs the bundles now use.
- PREVIEW: scripts/icon-preview.html is a dev page that renders the shipped
  markup (tooltip both states, every icon button, text runs, the full icon
  table) for design review: `python3 -m http.server 8010` and open
  /scripts/icon-preview.html.
Tests 210/210, check clean. catalog js v30 / catalog css v27 / style css v25 /
utils v9 / social v48 / subs v26 / app v56 / i18n v3 / ui-2026-09-15.87.

## Mobile navigation: left rail becomes a bottom bar, friends in the centre (ui-2026-09-15.88)

USER: "lets make mobile interface, how about we move left sidebar to buttom but
make it not crowded only 5, and friends menu in the center" -> clarified as:
bar = Home · Movies · FRIENDS · Series · More; the entries that don't fit live in
a "More" sheet; the bar hides inside a room (the in-room peek brings it back).

- BREAKPOINT: `<=720px` is the phone layout (the same width the old rules used).
  Desktop is UNTOUCHED: the left rail is still the rail, the bar is
  `display: none`, and the collapse toggle behaves exactly as before.
- BOTTOM BAR (5 equal slots, no horizontal scroll): Home, Movies, FRIENDS,
  Series, More. Friends is the CENTRE slot and the only accented element — a
  single red disc (`.bottomnav__center-disc`) with the label under it, which is
  what keeps the bar from looking crowded. Active slot = themed ink + weight;
  a rail-only destination (Trending, /history, ...) lights the More slot so the
  bar always says where you are.
- THE BAR IS IN THE LAYOUT, NOT OVER IT: `#bottomnav` is the LAST flex child of
  `.app-shell__main`, so every view shrinks by exactly its height instead of
  being covered (no padding hacks, no z-index games). It carries
  `padding-bottom: env(safe-area-inset-bottom)` for the iPhone home indicator and
  `--bottomnav-h` (58px) for thumb-sized slots.
- "MORE" SHEET: the rail node itself becomes an off-canvas sheet on phones
  (`position: fixed` + `translateX(-102%)`, revealed by `body.menu-open`), with a
  sheet header (title + X), the app dimmed by `#sidenav-backdrop`. It shows the
  entries the bar does NOT carry — Anime, Watch history, Trending, Top Rated,
  In Theaters, Airing Today, Admin — and Start a room moves to the TOP of the
  sheet (`order: -1`) where a thumb reaches it. Dismissal: the X, the backdrop,
  Escape, or choosing an entry.
- ONE NAVIGATOR, THREE SURFACES: `setupSidenav()` now exposes a single
  `navigate(key)` (the old per-item click body) used by the rail items, the bar
  slots and the sheet, so a destination can never behave differently depending on
  which bar was tapped. `setActive(key)` paints the active state on BOTH bars
  from one call. The sheet also closes on any navigation.
- IN A ROOM: `body.room-focus .bottomnav { display: none }` (the player/chat keep
  the whole screen, same as the desktop rail) and
  `body.room-focus.rail-peek .bottomnav { display: grid }` — the existing in-room
  peek button brings it back.
- TWO BUGS PREVENTED IN THE SAME PASS: (a) a persisted desktop collapse is now
  gated behind `@media (min-width: 721px)`, so `sidenav-collapsed` can never
  shrink the mobile sheet; (b) the old `<=720px` rules that hid the rail labels
  and shrank the rail to a 56px strip are gone — that width is the bar layout now.
- FRIENDS STATE: the rail's open/close/dock now emits `wp:friends-toggled`
  (`include detail.open`), which paints the centre disc's `is-open` state.
- i18n: `nav.more` added to all six locales (More / Lainnya / Más / Plus / Mais /
  المزيد); the More slot and the sheet title both carry the key.
- TESTS: tests/mobile-nav.test.mjs slices the SHIPPED `setupSidenav()` (+ the
  sheet helpers) out of app.js and DRIVES it against a stub DOM: five slots with
  friends dead centre, bar tap === rail tap routing, centre slot opens the
  friends drawer, More lights up for rail-only destinations, bar Home exits a
  room, sheet open/close via More/X/backdrop/Escape, navigation closes the sheet,
  and the CSS layout contract (5-slot grid, off-canvas sheet, room hiding +
  peek, safe area, desktop-gated collapse). 15 cases.
- A11Y / RTL: the closed sheet is `visibility: hidden` as well as off-canvas
  (keyboard + screen readers cannot reach a closed menu; visibility flips at the
  ends of the slide), and Arabic mirrors the sheet to the RIGHT edge with the
  shadow/border flipped — a left-anchored drawer would read backwards.
- PREVIEW: scripts/mobile-preview.html renders a 390x780 phone frame
  (scripts/mobile-frame.html = the shipped app shell in an iframe, because the
  mobile rules are media queries) with buttons for the sheet, a room, the peek
  and the theme — design review without a device.
Tests 225/225, check clean. catalog css v29 / style css v26 / app v57 /
social v50 / i18n v4 / ui-2026-09-15.88.
