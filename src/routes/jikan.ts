// jikan.ts — MyAnimeList episode lists via the Jikan v4 API (server-side
// proxy so the browser stays same-origin and we can throttle + cache).
//
// Jikan limits: 3 req/sec and 60 req/min (https://docs.api.jikan.moe).
// This module therefore (a) caches each (malId, page) in memory for 6h
// (Jikan itself caches MAL 24h) and (b) enforces a token-bucket below the
// upstream limits. When the bucket is empty we fail SOFT with 429 — the
// client falls back to the existing AniList/TMDB counts, never breaking.
import { json, errorJson } from '../http.js';
import type { Env } from '../types.js';

const JIKAN_ORIGIN = 'https://api.jikan.moe/v4';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 512;
const MAX_PAGE = 12; // 100 eps/page => 1200 episodes (One Piece fits)

/** (malId:page) -> { data, expires } — best-effort edge cache. */
const jikanCache = new Map<string, { data: unknown; expires: number }>();

/** Shared token bucket: max 2/sec and 50/min — deliberately UNDER the limits. */
let secStart = 0;
let secCount = 0;
let minStart = 0;
let minCount = 0;

function takeToken(): boolean {
  const now = Date.now();
  if (now - secStart >= 1000) {
    secStart = now;
    secCount = 0;
  }
  if (now - minStart >= 60000) {
    minStart = now;
    minCount = 0;
  }
  if (secCount >= 2 || minCount >= 50) return false;
  secCount += 1;
  minCount += 1;
  return true;
}

export interface JikanEpisode {
  number: number;
  title: string;
  filler?: boolean;
  recap?: boolean;
  aired?: string | null;
}

/**
 * GET /api/jikan/anime/:malId/episodes?page=N
 * -> { episodes: JikanEpisode[], page, lastPage }
 */
export async function handleJikanEpisodes(
  _request: Request,
  env: Env,
  malIdRaw: string,
  pageRaw: string
): Promise<Response> {
  const malId = Number(malIdRaw);
  const page = Math.max(1, Math.min(MAX_PAGE, Number(pageRaw) || 1));
  if (!Number.isInteger(malId) || malId <= 0 || malId > 99999999) {
    return errorJson(422, 'Invalid MAL id.');
  }

  const key = malId + ':' + page;
  const hit = jikanCache.get(key);
  if (hit && hit.expires > Date.now()) {
    return json(hit.data as Record<string, unknown>, 200, {
      'Cache-Control': 'public, max-age=21600',
    });
  }
  if (jikanCache.size >= CACHE_MAX) jikanCache.clear();

  if (!takeToken()) {
    return errorJson(429, 'Jikan rate budget spent - retry shortly.');
  }

  let res: Response;
  try {
    res = await fetch(`${JIKAN_ORIGIN}/anime/${malId}/episodes?page=${page}`, {
      headers: { Accept: 'application/json' },
    });
  } catch (e) {
    return errorJson(502, 'Jikan unreachable', String(e));
  }
  if (!res.ok) {
    return errorJson(502, 'Jikan lookup failed', 'HTTP ' + res.status);
  }
  let payload: {
    data?: Array<{ mal_id?: number; title?: string | null; filler?: boolean; recap?: boolean; aired?: string | null }>;
    pagination?: { last_visible_page?: number };
  };
  try {
    payload = await res.json();
  } catch (e) {
    return errorJson(502, 'Jikan returned invalid JSON', String(e));
  }
  const episodes: JikanEpisode[] = (payload.data || [])
    .filter((e) => Number.isInteger(e.mal_id))
    .map((e) => ({
      number: Number(e.mal_id),
      title: String(e.title || ''),
      filler: !!e.filler,
      recap: !!e.recap,
      aired: e.aired ?? null,
    }));
  const lastPage = Math.max(1, Math.min(MAX_PAGE, Number(payload.pagination && payload.pagination.last_visible_page) || 1));
  const body = { episodes, page, lastPage };
  jikanCache.set(key, { data: body, expires: Date.now() + CACHE_TTL_MS });
  return json(body as unknown as Record<string, unknown>, 200, {
    'Cache-Control': 'public, max-age=21600',
  });
}
