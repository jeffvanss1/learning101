# WatchParty 🎬

A modern, YouTube-inspired **watch party** web app built entirely on the
Cloudflare stack:

- **Cloudflare Workers** (Static Assets) — serves the frontend build from `dist/`
- **Cloudflare Durable Objects** — room state + WebSocket signaling (`WatchRoom`)
- **Zero Node server dependencies** — no `socket.io`, no Express; just the
  platform-native WebSocket pair + storage APIs.

Browse a full library of **movies, TV series and anime** (with hero banners and
poster rows, just like YouTube), then stream any title in lockstep with friends
while chatting live — powered by the **Bingr Embed API**.

## Architecture

```
Browser (static build in /dist)
   │  REST:  /api/rooms, /api/room/:id
   │  Proxy: /api/tmdb/*  ->  https://api.themoviedb.org/3/*
   │  WS:    /ws?room=<id>
   ▼
Worker (src/worker.js)
   │  routes REST, proxies the TMDB catalog API, upgrades WebSockets
   ▼
WatchRoom Durable Object (src/WatchRoom.js)
   ├─ per-room state: video, playback clock, chat history, peers
   ├─ authoritative playback clock (isPlaying + time + timestamp)
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

## Synchronization model

The room owns one authoritative playback clock. The host's play/pause/seek
commands update it; the Durable Object broadcasts the new
`(isPlaying, time, timestamp)` tuple. Every client — including the host —
projects that tuple forward in wall-clock time and nudges its local player
whenever it drifts beyond a tolerance threshold, giving sub-second sync without
any clock negotiation. Host actions made inside the embedded player itself are
detected and mirrored back to the room.

## Project layout

```
wrangler.toml        # Workers Static Assets + Durable Object bindings/migration
package.json
src/
  worker.js          # routing, REST API, TMDB proxy, WS upgrade
  WatchRoom.js       # Durable Object: state, chat, sync broadcast
dist/                # static frontend (no build step required)
  index.html
  css/style.css      # room / chat / player chrome
  css/catalog.css    # browse, hero, rows, cards, hover preview, modals, seek bar
  js/utils.js        # DOM helpers, formatting, URL parsing, random names
  js/api.js          # REST + WebSocket client w/ auto-reconnect
  js/player.js       # PlaybackSyncManager (Bingr postMessage bridge)
  js/catalog.js      # TMDB library: browse, search, trailer hover, episode picker
  js/app.js          # home/room flow, modals, chat, wiring
  favicon.svg
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

## Deploy

```bash
npm run deploy
```

`wrangler.toml` declares the `WATCH_ROOM` binding and a `v1`
`new_sqlite_classes` migration (SQLite-backed storage is required for new
Durable Object namespaces on Cloudflare's free plan).

## REST API

| Method | Path                | Description                                  |
| ------ | ------------------- | -------------------------------------------- |
| GET    | `/api/rooms`        | Create a room → `{ id, url, ws }`            |
| GET    | `/api/room/:id`     | Look up a room's current state               |
| GET    | `/api/tmdb/*`       | Proxy to the TMDB catalog API                |
| GET    | `/room/:id/health`  | Durable Object health (peers, playback)      |

## WebSocket protocol

Clients connect to `/ws?room=<id>` and exchange JSON messages:

- Client → server: `join`, `chat`, `videoChange`, `play`, `pause`, `seek`, `ping`
- Server → client: `state`, `peers`, `system`, `chat`, `videoChange`,
  `play`, `pause`, `seek`, `pong`

The first connected client becomes the **host** (playback owner). If the host
leaves, ownership transfers to the oldest remaining peer automatically. The
shared `video` object carries `{ type, id, src, title, poster, backdrop, year,
season, episode }` so every client can load the exact same title and episode.
