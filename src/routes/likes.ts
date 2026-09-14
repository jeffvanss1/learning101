// likes.ts — LIKE system: uncapped likes (taste signal + profile
// collection) and the For You suggestions derived from them.
//
//  POST /api/user/likes/toggle  { mediaId, mediaType, mediaTitle, posterUrl }
//  GET  /api/user/likes/ids     own liked mediaIds (bulk card-heart state)
//  GET  /api/suggestions        For You: TMDB recommendations seeded by the
//                               user's most recent likes (KV-cached 24h),
//                               merged + ranked + filtered.

import type { Env, LikeItem, SuggestionItem } from '../types.js';
import { json, errorJson } from '../http.js';
import { buildTmdbUrl } from '../tmdburl.js';

const TMDB_ORIGIN = 'https://api.themoviedb.org/3';
const SUGGESTION_LIMIT = 12;
const SEED_LIMIT = 4;

function sanitize(s: unknown, max: number): string {
  return String(s == null ? '' : s).slice(0, max);
}

/** POST /api/user/likes/toggle */
export async function handleToggleLike(request: Request, env: Env, me: { id: string; username: string }): Promise<Response> {
  if (!env.DB) return errorJson(500, 'Database unavailable');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const mediaId = sanitize(body && body.mediaId, 40);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(mediaId)) return errorJson(422, 'Invalid mediaId.');
  const mediaType = sanitize(body && body.mediaType, 12) === 'tv' ? 'tv' : 'movie';
  const mediaTitle = sanitize(body && body.mediaTitle, 160);
  const posterUrl = sanitize(body && body.posterUrl, 400);

  const existing = await env.DB
    .prepare('SELECT user_id FROM user_likes WHERE user_id = ?1 AND media_id = ?2')
    .bind(me.id, mediaId)
    .first<{ user_id: string }>();

  if (existing) {
    await env.DB.prepare('DELETE FROM user_likes WHERE user_id = ?1 AND media_id = ?2').bind(me.id, mediaId).run();
  } else {
    await env.DB
      .prepare(
        'INSERT OR IGNORE INTO user_likes (user_id, media_id, media_type, media_title, poster_url, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      )
      .bind(me.id, mediaId, mediaType, mediaTitle, posterUrl, Date.now())
      .run();
  }
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_likes WHERE user_id = ?1').bind(me.id).first<{ n: number }>();
  return json({ liked: !existing, likesCount: (count && count.n) || 0 }, 200, { 'Cache-Control': 'no-store' });
}

/** GET /api/user/likes/ids — the authed user's liked mediaIds. */
export async function handleLikeIds(request: Request, env: Env, me: { id: string; username: string }): Promise<Response> {
  if (!env.DB) return errorJson(500, 'Database unavailable');
  const res = await env.DB.prepare('SELECT media_id FROM user_likes WHERE user_id = ?1').bind(me.id).all<{ media_id: string }>();
  return json({ ids: (res.results || []).map((r) => r.media_id) }, 200, { 'Cache-Control': 'no-store' });
}

/**
 * PURE merge/rank (unit-tested): recommendations from each seed merged,
 * deduped, filtered (no seeds, no already-liked, no watched), ranked by
 * how many seeds recommended the title, then list order. Top `limit`.
 */
export function rankSuggestions(
  recLists: Array<Array<{ id: number; type: string; title: string; poster: string }>>,
  excludeIds: Set<string>,
  limit: number = SUGGESTION_LIMIT
): SuggestionItem[] {
  const scores = new Map<string, SuggestionItem>();
  for (const list of recLists) {
    for (let i = 0; i < list.length; i++) {
      const rec = list[i];
      const key = rec.type + ':' + rec.id;
      if (excludeIds.has(key)) continue;
      const hit = scores.get(key);
      if (hit) {
        hit.score++;
      } else {
        scores.set(key, {
          mediaId: String(rec.id),
          mediaType: rec.type,
          mediaTitle: rec.title,
          posterUrl: rec.poster,
          score: 1,
          // lower list position = TMDB likes it more; tie-break on best rank
          ...(typeof hit === 'object' ? {} : {}),
        } as SuggestionItem);
      }
    }
  }
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** GET /api/suggestions — For You for the authed user. */
export async function handleSuggestions(request: Request, env: Env, me: { id: string; username: string }): Promise<Response> {
  if (!env.DB) return errorJson(500, 'Database unavailable');
  const apiKey = env.TMDB_API_KEY || '';
  if (!apiKey) return json({ seeds: [], items: [] }, 200, { 'Cache-Control': 'no-store' });

  const seedsRes = await env.DB
    .prepare('SELECT media_id, media_type, media_title FROM user_likes WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ' + SEED_LIMIT)
    .bind(me.id)
    .all<{ media_id: string; media_type: string; media_title: string }>();
  const seeds = seedsRes.results || [];
  if (!seeds.length) return json({ seeds: [], items: [] }, 200, { 'Cache-Control': 'no-store' });

  // Exclusions: the seeds, everything liked, everything watched.
  const exclude = new Set<string>();
  for (const s of seeds) exclude.add(s.media_type + ':' + s.media_id);
  const [likedRes, watchedRes] = await Promise.all([
    env.DB.prepare('SELECT media_id, media_type FROM user_likes WHERE user_id = ?1 LIMIT 500').bind(me.id).all<{ media_id: string; media_type: string }>(),
    env.DB.prepare('SELECT DISTINCT media_id, media_type FROM watch_history WHERE user_id = ?1 LIMIT 500').bind(me.id).all<{ media_id: string; media_type: string }>(),
  ]);
  for (const r of likedRes.results || []) exclude.add(r.media_type + ':' + r.media_id);
  for (const r of watchedRes.results || []) exclude.add(r.media_type + ':' + r.media_id);

  const kv = env.PRESENCE_KV;
  const recLists: Array<Array<{ id: number; type: string; title: string; poster: string }>> = [];
  await Promise.all(
    seeds.map(async (seed) => {
      const cacheKey = 'tmdb:rec:v1:' + seed.media_type + ':' + seed.media_id;
      let raw: any = null;
      try {
        const hit = kv ? await kv.get(cacheKey) : null;
        if (hit) raw = JSON.parse(hit);
      } catch (_) {}
      if (!raw) {
        try {
          const url = buildTmdbUrl(TMDB_ORIGIN, '/' + seed.media_type + '/' + seed.media_id + '/recommendations', '?page=1', apiKey, 'en-US');
          const res = await fetch(url, { headers: { Accept: 'application/json' } });
          if (!res.ok) return;
          raw = await res.json();
          if (kv) {
            try {
              await kv.put(cacheKey, JSON.stringify(raw), { expirationTtl: 86400 });
            } catch (_) {}
          }
        } catch (_) {
          return;
        }
      }
      const list = ((raw && raw.results) || [])
        .filter((r: any) => r && r.id && !r.adult)
        .slice(0, 20)
        .map((r: any) => ({
          id: r.id as number,
          type: seed.media_type, // recommendations inherit the seed's type
          title: String(r.title || r.name || '').slice(0, 160),
          poster: r.poster_path ? 'https://image.tmdb.org/t/p/w342' + r.poster_path : '',
        }))
        .filter((r: any) => r.title);
      if (list.length) recLists.push(list);
    })
  );

  const items = rankSuggestions(recLists, exclude, SUGGESTION_LIMIT);
  return json({ seeds: seeds.map((s) => s.media_title), items }, 200, { 'Cache-Control': 'no-store' });
}
