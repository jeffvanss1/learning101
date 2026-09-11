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
   │  Proxy: /api/bingr/*  ->  https://api.bingr.one/*
   │  WS:    /ws?room=<id>
   ▼
Worker (src/worker.js)
   │  routes REST, proxies the Bingr catalog API, upgrades WebSockets
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
| Anime  | `https://bingr.one/watch/anime/{anilistId}/{episode}` |

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

## The Bingr catalog API (library)

The frontend never talks to `api.bingr.one` directly — the Worker proxies
`/api/bingr/*` to it (CORS-safe, with a short cache). Endpoints used:

- `/trending/all`, `/trending/movie`, `/trending/tv`
- `/discover/movie?sort_by=...&genre=...`, `/discover/tv?sort_by=...`
- `/anime/discover?sort=TRENDING_DESC`
- `/search?q=` (movies + series) and `/anime/search?q=` (anime)
- `/details/movie/{id}`, `/details/tv/{id}` (seasons/episodes)
- `/anime/{id}` (episode counts)

Each title resolves to a Bingr watch URL via the table above; series and anime
open a season/episode picker before playback starts.

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
  worker.js          # routing, REST API, Bingr proxy, WS upgrade
  WatchRoom.js       # Durable Object: state, chat, sync broadcast
dist/                # static frontend (no build step required)
  index.html
  css/style.css      # room / chat / player chrome
  css/catalog.css    # browse, hero, rows, cards, modals, seek bar
  js/utils.js        # DOM helpers, formatting, URL parsing
  js/api.js          # REST + WebSocket client w/ auto-reconnect
  js/player.js       # PlaybackSyncManager (Bingr postMessage bridge)
  js/catalog.js      # Bingr library: browse, search, detail/episode picker
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
| GET    | `/api/bingr/*`      | Proxy to the Bingr catalog API               |
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
