// worker.js — Cloudflare Worker entry point
//
// Responsibilities:
//   1. Serve the static frontend build from `dist/` via Workers Static Assets
//      (asset-first routing; unmatched navigation requests fall back to the
//      SPA shell via `not_found_handling = "single-page-application"`).
//   2. Expose a tiny JSON API for room creation/lookup.
//   3. Upgrade WebSocket connections and forward them to the `WatchRoom`
//      Durable Object, which terminates the socket (Hibernation API).
//
// No `socket.io` server, no Node-only dependencies.

import { WatchRoom } from './WatchRoom.js';

export { WatchRoom };

const ROOM_RE = /^\/api\/room\/([A-Za-z0-9_-]+)\/?$/;
const HEALTH_RE = /^\/room\/([A-Za-z0-9_-]+)\/health\/?$/;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra,
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // --- WebSocket upgrade -> WatchRoom Durable Object ----------------------
    if (request.headers.get('Upgrade') === 'websocket') {
      const roomId = url.searchParams.get('room');
      if (!roomId) {
        return json({ error: 'Missing ?room= parameter' }, 400);
      }
      const id = env.WATCH_ROOM.idFromString(roomId);
      const stub = env.WATCH_ROOM.get(id);
      return stub.fetch(request);
    }

    // --- REST API ------------------------------------------------------------
    if (path.startsWith('/api/')) {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
      }

      if (path === '/api/rooms') {
        try {
          const id = env.WATCH_ROOM.newUniqueId();
          return json({
            id: id.toString(),
            url: `${url.origin}/room/${id.toString()}`,
            ws: `wss://${url.host}/ws?room=${id.toString()}`,
          });
        } catch (e) {
          return json({ error: 'Failed to create room', detail: String(e) }, 500);
        }
      }

      const roomMatch = path.match(ROOM_RE);
      if (roomMatch) {
        try {
          const id = env.WATCH_ROOM.idFromString(roomMatch[1]);
          const stub = env.WATCH_ROOM.get(id);
          const res = await stub.fetch('https://room/state');
          if (res.ok) {
            return json(await res.json(), 200);
          }
          return json({ error: 'Room not found' }, 404);
        } catch (e) {
          return json({ error: 'Invalid room id', detail: String(e) }, 400);
        }
      }

      return json({ error: 'Not found' }, 404);
    }

    // --- Durable Object health (non-navigation requests only) ---------------
    const healthMatch = path.match(HEALTH_RE);
    if (healthMatch && request.method === 'GET') {
      try {
        const id = env.WATCH_ROOM.idFromString(healthMatch[1]);
        const stub = env.WATCH_ROOM.get(id);
        return stub.fetch('https://room/health');
      } catch (e) {
        return json({ error: 'Invalid room id', detail: String(e) }, 400);
      }
    }

    // --- Static assets (Workers Static Assets) -------------------------------
    // GET/HEAD requests that don't match an API route are forwarded to the
    // ASSETS binding, which serves the file or the SPA shell.
    if (request.method === 'GET' || request.method === 'HEAD') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
