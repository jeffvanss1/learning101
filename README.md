# WatchParty 🎬

A modern, YouTube-inspired **watch party** web app built entirely on the
Cloudflare stack:

- **Cloudflare Workers** (Static Assets) — serves the frontend build from `dist/`
- **Cloudflare Durable Objects** — room state + WebSocket signaling (`WatchRoom`)
- **Zero Node server dependencies** — no `socket.io`, no Express; just the
  platform-native WebSocket pair + storage APIs.

Create or join a room, load any video through the embedded player
(`https://embed.bingr.one/`), and stream it in lockstep with friends while
chatting live.

## Architecture

```
Browser (static build in /dist)
   │  REST: /api/rooms, /api/room/:id
   │  WS:   /ws?room=<id>
   ▼
Worker (src/worker.js)
   │  routes REST + upgrades WebSockets
   ▼
WatchRoom Durable Object (src/WatchRoom.js)
   ├─ per-room state: video, playback clock, chat history, peers
   ├─ authoritative playback clock (isPlaying + time + timestamp)
   └─ broadcasts play/pause/seek/videoChange/chat to every connected client
```

**Synchronization model.** The room owns one authoritative playback clock.
The host's play/pause/seek commands update it; the Durable Object broadcasts
the new `(isPlaying, time, timestamp)` tuple. Every client — including the
host — projects that tuple forward in wall-clock time and nudges its local
player (via the iframe `postMessage` protocol) whenever it drifts beyond a
tolerance threshold. The result is sub-second sync across clients with no
clock negotiation needed.

## Project layout

```
wrangler.toml        # Workers Static Assets + Durable Object bindings/migration
package.json
src/
  worker.js          # entry: routing, REST API, WS upgrade
  WatchRoom.js       # Durable Object: state, chat, sync broadcast
dist/                # static frontend (no build step required)
  index.html
  css/style.css
  js/utils.js        # DOM helpers, formatting, URL parsing
  js/api.js          # REST + WebSocket client w/ auto-reconnect
  js/player.js       # PlaybackSyncManager (iframe postMessage bridge)
  js/app.js          # lobby flow, room UI, chat, wiring
  favicon.svg
```

## Run locally

```bash
npm install
npm run dev:local      # wrangler dev on 0.0.0.0:8787
```

Then open `http://localhost:8787`. Create a room in one tab and open the
invite link (or the `/room/<id>` URL) in another to test sync + chat.

> Note: `wrangler dev` spins up a local Durable Objects runtime, so both
> WebSocket signaling and room persistence work offline.

## Deploy

```bash
npm run deploy
```

`wrangler.toml` already declares the `WATCH_ROOM` binding and the `v1`
migration for the `WatchRoom` class, so the first deploy provisions the
Durable Object namespace automatically.

## REST API

| Method | Path                | Description                                  |
| ------ | ------------------- | -------------------------------------------- |
| GET    | `/api/rooms`        | Create a room → `{ id, url, ws }`            |
| GET    | `/api/room/:id`     | Look up a room's current state               |
| GET    | `/room/:id/health`  | Durable Object health (peers, playback)      |

## WebSocket protocol

Clients connect to `/ws?room=<id>` and exchange JSON messages:

- Client → server: `join`, `chat`, `videoChange`, `play`, `pause`, `seek`, `ping`
- Server → client: `state`, `peers`, `system`, `chat`, `videoChange`,
  `play`, `pause`, `seek`, `pong`

The first connected client becomes the **host** (playback owner). If the host
leaves, ownership transfers to the oldest remaining peer automatically.

## Embedded player

The video player is an `<iframe>` pointed at `https://embed.bingr.one/`. The
sync manager drives it through the standard HTML5-player `postMessage`
protocol (`load`, `play`, `pause`, `seek`, plus common fallbacks such as
`seekTo` / `setCurrentTime`), so it interoperates with any player that
implements that contract. Playback state is read back from `time` /
`playing` / `pause` messages emitted by the player.
