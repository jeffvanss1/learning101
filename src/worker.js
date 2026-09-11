// worker.js — Cloudflare Worker entry point
//
// Responsibilities:
//   1. Serve the static frontend build from `dist/` via Workers Static Assets.
//   2. Expose a tiny JSON API for room creation/lookup.
//   3. Proxy The Movie Database (TMDB) API at `/api/tmdb/*`, injecting the
//      server-side `TMDB_API_KEY` so it never reaches the browser.
//   4. Upgrade WebSocket connections to the `WatchRoom` Durable Object
//      (Hibernation API).
//
// No `socket.io` server, no Node-only dependencies.

import { WatchRoom } from './WatchRoom.js';

export { WatchRoom };

const ROOM_RE = /^\/api\/room\/([A-Za-z0-9_-]+)\/?$/;
const HEALTH_RE = /^\/room\/([A-Za-z0-9_-]+)\/health\/?$/;
const TMDB_ORIGIN = 'https://api.themoviedb.org/3';

// Best-effort in-memory cache for the TMDB proxy (resets with the isolate;
// the `Cache-Control` header also lets Cloudflare cache responses).
const catalogCache = new Map();
const CACHE_TTL_MS = 180_000;
const CACHE_MAX = 300;

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

// Looks like a TMDB v4 "API Read Access Token" (JWT)? Then use Bearer auth.
function looksLikeToken(key) {
  return typeof key === 'string' && key.length > 60 && key.split('.').length === 3;
}

async function proxyTmdb(path, search, apiKey) {
  const target = TMDB_ORIGIN + path + search;

  const hit = catalogCache.get(target);
  if (hit && hit.expires > Date.now()) {
    return new Response(hit.body, {
      status: 200,
      headers: {
        'Content-Type': hit.contentType || 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=180',
        ...corsHeaders(),
      },
    });
  }

  const useBearer = looksLikeToken(apiKey);
  const separator = search.includes('?') ? '&' : '?';
  const url = useBearer ? target : target + separator + 'api_key=' + encodeURIComponent(apiKey);

  const upstream = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(useBearer ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
  });

  const contentType =
    upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  const body = await upstream.text();

  if (upstream.ok) {
    if (catalogCache.size >= CACHE_MAX) catalogCache.clear();
    catalogCache.set(target, {
      body,
      contentType,
      expires: Date.now() + CACHE_TTL_MS,
    });
  }

  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': upstream.ok ? 'public, max-age=180' : 'no-store',
      ...corsHeaders(),
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

    // --- TMDB catalog proxy ------------------------------------------------
    if (path.startsWith('/api/tmdb/')) {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
      }
      const apiKey = env.TMDB_API_KEY;
      if (!apiKey) {
        return json(
          {
            error: 'TMDB_API_KEY is not configured. Add it as a Worker secret ' +
              '(`wrangler secret put TMDB_API_KEY`) or to .dev.vars for local dev.',
          },
          503
        );
      }
      const rest = path.slice('/api/tmdb'.length) || '/';
      try {
        return await proxyTmdb(rest, url.search, apiKey);
      } catch (e) {
        return json({ error: 'TMDB unavailable', detail: String(e) }, 502);
      }
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

    // --- Durable Object health ------------------------------------------------
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
    if (request.method === 'GET' || request.method === 'HEAD') {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
