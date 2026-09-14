// worker.ts — Cloudflare Worker entry point
//
// Responsibilities:
//   1. Serve the static frontend build from `dist/` via Workers Static Assets.
//   2. Expose the room JSON API, proxy TMDB + AniList, upgrade WebSockets to
//      the `WatchRoom` Durable Object. (Unchanged from the original worker.js.)
//   3. NEW: profiles / global search / presence — delegated to src/router.ts,
//      backed by D1 (`DB`) and KV (`PRESENCE_KV`).
//
// No `socket.io` server, no Node-only dependencies.

import { WatchRoom } from './WatchRoom.js';
import { classifyIsAnime, matchAnilist } from './anilist.js';
import { routeApi } from './router.js';
import { sessionUser } from './auth.js';
import { injectGeoScript, resolveGeo } from './geo.js';
import {
  buildSearchQuery,
  composeWyzieNote,
  fetchWyzieAvailableSources,
  fetchWyzieMultiSource,
  wyzieFanSources,
  wyzieSearchCacheKey,
  decodeWyzieToken,
  fetchSubtitleVtt,
  fetchWyzieVtt,
  pickBest,
  shapeSearchResponse,
  shapeWyzieResults,
} from './subs.js';
import { buildTmdbUrl, looksLikeToken } from './tmdburl.js';
import type { Env } from './types.js';

export { WatchRoom };

const ROOM_RE = /^\/api\/room\/([A-Za-z0-9_-]+)\/?$/;
const HEALTH_RE = /^\/room\/([A-Za-z0-9_-]+)\/health\/?$/;
const ANILIST_RE = /^\/api\/anilist\/(\d+)\/?$/;
const TMDB_ORIGIN = 'https://api.themoviedb.org/3';
const ANILIST_ORIGIN = 'https://graphql.anilist.co';
const ANIME_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ANILIST_QUERY = `query ($search: String) {
  Page(page: 1, perPage: 10) {
    media(search: $search, type: ANIME, isAdult: false, sort: [SEARCH_MATCH]) {
      id
      idMal
      title { romaji english native }
      episodes
      format
      startDate { year }
    }
  }
}`;

// Best-effort in-memory cache for the TMDB proxy (resets with the isolate;
// the `Cache-Control` header also lets Cloudflare cache responses).
const catalogCache = new Map<string, { body: string; contentType: string; expires: number }>();
const CACHE_TTL_MS = 180_000;
const CACHE_MAX = 300;

// TMDB → AniList resolution cache (7 days; the response is also CDN-cached).
const animeCache = new Map<string, { data: unknown; expires: number }>();
const ANIME_CACHE_MAX = 500;

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/** Hardening headers on EVERY response (pages + API). */
function securityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // Measured CSP: the player embeds bingr.one, trailer previews embed
    // youtube.com; posters come from TMDB, avatars from DiceBear; the anime
    // fallback talks to AniList's GraphQL directly. 'unsafe-inline' scripts
    // stay (the pre-paint theme bootstrap is inline by design).
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https://image.tmdb.org https://api.dicebear.com; " +
      "media-src 'self' https:; frame-src https://bingr.one https://www.youtube.com; " +
      "connect-src 'self' wss: https://graph.anilist.org; font-src 'self' data:; " +
      "base-uri 'self'; frame-ancestors 'self'",
  };
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...securityHeaders(),
      ...extra,
    },
  });
}

async function proxyTmdb(
  path: string,
  search: string,
  apiKey: string,
  language?: string
): Promise<Response> {
  // Canonical URL: the query is re-parsed and re-serialized (buildTmdbUrl),
  // so exactly one '?' ever reaches upstream — the geo feature regressed
  // this into `?language=..?api_key=..` on parameter-less paths (details),
  // which TMDB read as an invalid key. Localized content stays part of the
  // URL (and therefore of the cache key).
  const target = buildTmdbUrl(TMDB_ORIGIN, path, search, apiKey, language);

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

  const upstream = await fetch(target, {
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

// Fetch and parse a TMDB JSON resource directly (server-side API key).
async function tmdbJson(path: string, apiKey: string): Promise<any> {
  const useBearer = looksLikeToken(apiKey);
  const sep = path.includes('?') ? '&' : '?';
  const url = useBearer
    ? TMDB_ORIGIN + path
    : TMDB_ORIGIN + path + sep + 'api_key=' + encodeURIComponent(apiKey);
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...(useBearer ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
  });
  if (!res.ok) throw new Error('TMDB ' + res.status);
  return res.json();
}

// Classify a TMDB TV title and, when it is anime, resolve its AniList ID.
async function resolveAnime(tmdbId: string, apiKey: string): Promise<Record<string, unknown>> {
  /** @returns {Promise<any>} null when the id simply isn't a TMDB tv show (404) */
  const tvOr404 = async (p: string) => {
    try {
      return await tmdbJson(p, apiKey);
    } catch (e) {
      if (String(e).indexOf('404') !== -1) return null;
      throw e;
    }
  };
  // language=en-US: `name` must be locale-stable for title matching (a
  // Japanese-locale request returned Japanese for BOTH name and
  // original_name and the AniList match collapsed). original_name keeps the
  // native script, which the (now unicode-aware) matcher compares against
  // AniList's title.native.
  const [show, keywords] = await Promise.all([
    tvOr404(`/tv/${tmdbId}?language=en-US`),
    tvOr404(`/tv/${tmdbId}/keywords`),
  ]);
  if (!show || !show.id) return { anime: false };
  if (!classifyIsAnime(show, keywords)) return { anime: false };

  let anilistId: number | null = null;
  let episodes: number | null = null;
  let title: string | null = null;
  try {
    const res = await fetch(ANILIST_ORIGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: ANILIST_QUERY,
        variables: { search: show.original_name || show.name || '' },
      }),
    });
    if (res.ok) {
      const data: any = await res.json();
      const media = (data && data.data && data.data.Page && data.data.Page.media) || [];
      const best = matchAnilist(show, media);
      if (best) {
        anilistId = best.id;
        episodes = best.episodes || null;
        title = (best.title && (best.title.romaji || best.title.english)) || null;
      }
    }
  } catch (_) {
    // AniList unreachable — the caller gets { anime: true, anilistId: null }.
  }

  return { anime: true, anilistId, episodes, title };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // --- Profile / search / presence API (D1 + KV) ---------------------------
    if (path.startsWith('/api/')) {
      // Belt-and-braces: one broken handler must never take the request down
      // with a raw error page — API clients get a parseable JSON 500 (with
      // CORS headers) instead.
      let routed: Response | null = null;
      try {
        routed = await routeApi(request, env, path);
      } catch (e) {
        return json({ error: 'Internal error', detail: String(e) }, 500);
      }
      if (routed) return routed;
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
        const geo = resolveGeo(
          (request as Request & { cf?: { country?: string } }).cf?.country,
          request.headers.get('accept-language'),
          url.searchParams.get('lang')
        );
        // English catalog titles (user request): TMDB content language is
        // pinned to en-US — with geo locales, anime titles render in native
        // script (ジョジョの奇妙な冒険) because id-ID data falls back to it.
        // UI strings stay geo-localized (geo.uiLang path is unchanged).
        return await proxyTmdb(rest, url.search, apiKey, 'en-US');
      } catch (e) {
        return json({ error: 'TMDB unavailable', detail: String(e) }, 502);
      }
    }

    // --- Subtitles (Wyzie primary, OpenSubtitles fallback; own overlay) --------
    if (path.startsWith('/api/subs/')) {
      const wyzieKey = env.WYZIE_API_KEY;
      const osKey = env.OPENSUBTITLES_API_KEY;
      if (!wyzieKey && !osKey) {
        return json(
          {
            error:
              'No subtitle provider is configured. Get a free key at store.wyzie.io/redeem and set it ' +
              '(`wrangler secret put WYZIE_API_KEY`), and/or OPENSUBTITLES_API_KEY. ' +
              'Uploading a subtitle file still works without either.',
          },
          503
        );
      }
      try {
        if (path === '/api/subs/search' && request.method === 'GET') {
          const type = url.searchParams.get('type') === 'movie' ? 'movie' : 'tv';
          const tmdb = url.searchParams.get('tmdb') || '';
          if (!/^\d+$/.test(tmdb)) return json({ error: 'tmdb id required' }, 400);
          const season = url.searchParams.get('season') ? Number(url.searchParams.get('season')) : null;
          const episode = url.searchParams.get('episode') ? Number(url.searchParams.get('episode')) : null;
          const lang = url.searchParams.get('lang') || undefined;

          // PRIMARY: Wyzie Subs (key IS the query param; kept server-side).
          // wyzieNote explains, in the final response, exactly what happened
          // to the primary attempt ("not-configured" = the secret is unset).
          let wyzieNote = 'not-configured';
          // Which sources may THIS key query? Live truth via GET /sources
          // (KV-cached 24h) — support-quoted code lists and the docs both
          // drifted from the live set. WYZIE_SOURCES overrides everything
          // (set 'all' on a Pro key).
          const kv = env.PRESENCE_KV || null;
          let wyzieSources = /** @type {string[] | null} */ (null);
          if (env.WYZIE_SOURCES) {
            wyzieSources = env.WYZIE_SOURCES.split(',').map((x) => x.trim()).filter(Boolean);
          } else {
            const ck = 'wyzie:sources:v1';
            try {
              const cached = kv ? await kv.get(ck) : null;
              if (cached) wyzieSources = /** @type {string[]} */ (JSON.parse(cached));
            } catch (_) {}
            if (!wyzieSources) {
              wyzieSources = await fetchWyzieAvailableSources({ key: wyzieKey, fallback: ['charlie', 'lima'] });
              if (wyzieSources && kv) {
                try {
                  await kv.put(ck, JSON.stringify(wyzieSources), { expirationTtl: 86400 });
                } catch (_) {}
              }
            }
          }
          if (!wyzieSources || !wyzieSources.length) wyzieSources = ['charlie', 'lima'];
          let queryEcho = 'no-wyzie-key';
          // Shared search cache: warm titles answer in ~1 KV read instead of
          // a multi-second upstream chain (15 min TTL). Checked BEFORE the
          // upstream so a stale-but-good answer also rides out upstream
          // hiccups. Error responses are never cached.
          const searchKey = wyzieKey
            ? wyzieSearchCacheKey({
                tmdb: tmdb,
                season: season,
                episode: episode,
                lang: lang,
                sources: wyzieSources,
              })
            : '';
          if (wyzieKey && kv && searchKey) {
            try {
              const hit = await kv.get(searchKey);
              if (hit) {
                return new Response(hit, {
                  status: 200,
                  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
                });
              }
            } catch (_) {}
          }
          if (wyzieKey) {
            // TV-only sources (lima) only make sense when season+episode exist.
            const fanSources = wyzieFanSources(wyzieSources, season != null && episode != null);
            const ms = await fetchWyzieMultiSource({ sources: fanSources, tmdb, season, episode, lang, key: wyzieKey });
            const usable = ms.perSource.filter((p) => !p.http && !p.bad);
            if (!usable.length && ms.perSource.some((p) => p.http === 429)) {
              return json({ error: 'Subtitle search is rate-limited right now — retry in a moment.' }, 429);
            }
            if (!usable.length && ms.perSource.some((p) => p.http === 401 || p.http === 403)) {
              return json({ error: 'Wyzie rejected the API key — check WYZIE_API_KEY (store.wyzie.io).' }, 502);
            }
            // Echo the query WITHOUT the key.
            const echo = new URLSearchParams({ sources: fanSources.join(','), id: String(tmdb) });
            if (season != null && episode != null) {
              echo.set('season', String(season));
              echo.set('episode', String(episode));
            }
            if (lang) echo.set('language', lang);
            echo.set('format', 'srt');
            queryEcho = echo.toString();
            const shaped = shapeWyzieResults(ms.records);
            if (shaped.best) {
              const body = {
                results: shaped.results,
                best: shaped.best,
                total: shaped.results.length,
                provider: 'wyzie',
                wyzieNote: composeWyzieNote(shaped, ms),
                query: queryEcho,
              };
              const bodyText = JSON.stringify(body);
              if (kv && searchKey) {
                try {
                  await kv.put(searchKey, bodyText, { expirationTtl: 900 });
                } catch (_) {}
              }
              return new Response(bodyText, {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
              });
            }
            wyzieNote = 'empty:' + shaped.shape + (ms.note ? ' | src ' + ms.note : '');
          }

          // FALLBACK: OpenSubtitles v3.
          if (!osKey) {
            // No fallback configured: report the primary's fate honestly.
            return json(
              { results: [], best: null, total: 0, provider: 'wyzie', wyzieNote: wyzieNote, query: queryEcho },
              200,
              { 'Cache-Control': 'public, max-age=60' }
            );
          }
          const query = buildSearchQuery({
            type: type,
            tmdb: tmdb,
            season: season,
            episode: episode,
            lang: lang,
          });
          const res = await fetch(
            'https://api.opensubtitles.com/api/v1/subtitles?' + query,
            { headers: { 'Api-Key': osKey, Accept: 'application/json', 'User-Agent': 'WatchParty v1.0.0' } }
          );
          if (res.status === 429) {
            return json({ error: 'Subtitle search is rate-limited right now — retry in a moment.' }, 429);
          }
          if (res.status === 401 || res.status === 403) {
            return json(
              {
                error:
                  'OpenSubtitles rejected the API key (' + res.status + ') — check OPENSUBTITLES_API_KEY and that the key is approved on api.opensubtitles.com.',
              },
              502
            );
          }
          if (!res.ok) return json({ error: 'OpenSubtitles ' + res.status }, 502);
          const payload: any = await res.json();
          return json(
            {
              results: shapeSearchResponse(payload),
              best: pickBest(payload && payload.data),
              total: payload && payload.total,
              provider: 'opensubtitles',
              wyzieNote: wyzieNote,
              // The EXACT upstream query — makes any future "why empty" a glance.
              query: query,
            },
            200,
            { 'Cache-Control': 'public, max-age=60' }
          );
        }
        if (path === '/api/subs/file' && request.method === 'GET') {
          const fileId = url.searchParams.get('fileId') || '';
          if (!fileId) return json({ error: 'fileId required' }, 400);
          // OpenSubtitles fileIds are numeric; Wyzie tokens are opaque base64url.
          let vtt: string;
          let cached: boolean;
          if (/^\d+$/.test(fileId)) {
            if (!osKey) {
              return json({ error: 'OpenSubtitles fallback is not configured — numeric file ids are unsupported.' }, 400);
            }
            const r = await fetchSubtitleVtt(fileId, osKey, env.PRESENCE_KV || null);
            vtt = r.vtt;
            cached = r.cached;
          } else {
            const r = await fetchWyzieVtt(fileId, env.PRESENCE_KV || null);
            vtt = r.vtt;
            cached = r.cached;
          }
          return new Response(vtt, {
            status: 200,
            headers: {
              'Content-Type': 'text/vtt; charset=utf-8',
              'Cache-Control': 'public, max-age=86400', // VTT is immutable per fileId token
              'X-Subs-Cache': cached ? 'hit' : 'miss',
              ...corsHeaders(),
            },
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json({ error: msg, detail: String(e) }, 502);
      }
    }

    // --- Geo-language resolution (diagnostics) ---------------------------------
    if (path === '/api/geo' && request.method === 'GET') {
      return json(
        resolveGeo(
          (request as Request & { cf?: { country?: string } }).cf?.country,
          request.headers.get('accept-language'),
          url.searchParams.get('lang')
        ),
        200
      );
    }

    // --- REST API (rooms, AniList) --------------------------------------------
    if (path.startsWith('/api/')) {
      if (request.method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
      }

      // TMDB ID → AniList ID (classification + resolution for anime).
      if (path.startsWith('/api/anilist/')) {
        const m = path.match(ANILIST_RE);
        if (!m) return json({ error: 'Not found' }, 404);
        const apiKey = env.TMDB_API_KEY;
        if (!apiKey) {
          return json({ error: 'TMDB_API_KEY is not configured' }, 503);
        }
        const tmdbId = m[1];
        const hit = animeCache.get(tmdbId);
        if (hit && hit.expires > Date.now()) {
          // Resolved matches cache a day; misses/nulls only 5 minutes so a
          // matcher fix propagates fast (the old 7d edge TTL poisoned the
          // pre-fix null responses for a WEEK — clients couldn't un-see it).
          const cc = (hit.data as any) && (hit.data as any).anilistId ? 'public, max-age=86400' : 'public, max-age=300';
          return json(hit.data, 200, { 'Cache-Control': cc });
        }
        try {
          const data = await resolveAnime(tmdbId, apiKey);
          if (animeCache.size >= ANIME_CACHE_MAX) animeCache.clear();
          animeCache.set(tmdbId, { data, expires: Date.now() + (data.anilistId ? ANIME_TTL_MS : 5 * 60 * 1000) });
          const cc = data.anilistId ? 'public, max-age=86400' : 'public, max-age=300';
          return json(data, 200, { 'Cache-Control': cc });
        } catch (e) {
          return json({ error: 'AniList lookup failed', detail: String(e) }, 502);
        }
      }

      if (path === '/api/rooms') {
        try {
          const id = env.WATCH_ROOM.newUniqueId();
          // Admin room registry (best-effort — a registry failure must NEVER
          // block room creation): who minted this room, and when.
          try {
            if (env.DB) {
              const creator = await sessionUser(request, env);
              if (creator) {
                await env.DB.prepare(
                  'INSERT OR IGNORE INTO rooms_created (room_id, owner_id, owner_username, created_at) VALUES (?1, ?2, ?3, ?4)'
                )
                  .bind(id.toString(), creator.id, creator.username, Date.now())
                  .run();
              }
            }
          } catch {
            // Registry is monitoring-only; ignore failures.
          }
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
      const upstream = await env.ASSETS.fetch(request);
      // Headers from ASSETS are immutable — rewrap so the security headers
      // can be applied to pages AND static assets alike.
      const res = new Response(upstream.body, upstream);
      for (const [k, v] of Object.entries(securityHeaders())) res.headers.set(k, v);
      // Tell the UI its locale with zero extra round-trips: inject
      // window.WP_GEO into every HTML response (GET only — HEAD has no body;
      // any injection failure must never break serving).
      if (request.method === 'GET') {
        try {
          const type = res.headers.get('content-type') || '';
          if (type.includes('text/html')) {
            const geo = resolveGeo(
              (request as Request & { cf?: { country?: string } }).cf?.country,
              request.headers.get('accept-language'),
              url.searchParams.get('lang')
            );
            const html = injectGeoScript(await res.text(), geo);
            const headers = new Headers(res.headers);
            headers.delete('content-length'); // body length changed
            return new Response(html, { status: res.status, headers });
          }
        } catch (_) {
          return res; // fall back to the untouched asset
        }
      }
      return res;
    }

    return new Response('Not found', { status: 404 });
  },
};

