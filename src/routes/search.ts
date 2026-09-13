// routes/search.ts — GET /api/search/users?q={query}
//
// 1. Narrow candidates in D1: LIKE on username/display_name against the whole
//    query and its first token (the username index serves prefix hits; the
//    %…% arms are bounded by LIMIT).
// 2. Fuzzy-rank the candidates in memory (src/lib/fuzzy.js) so typos and
//    partial words still surface the right people.
// 3. Batch-fetch presence (KV) + stats + friendship edges for the matching
//    ids and merge everything into `UserSearchHit[]`.

import type { Env, UserSearchHit, UserRow, PresencePayload } from '../types.js';
import { json, errorJson } from '../http.js';
import { rankCandidates } from '../lib/fuzzy.js';
import { getPresences } from '../presence.js';
import { sessionUser } from '../auth.js';
import { publicUserFromRow, fetchStats, friendEdgeMap, friendshipFor, OFFLINE_PRESENCE } from './users.js';

const LIMIT = 12;

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export async function handleUserSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 60);
  if (!q) return json({ query: '', users: [] as UserSearchHit[] }, 200);

  const firstToken = q.split(/\s+/)[0] ?? q;
  const likeAll = `%${escapeLike(q)}%`;
  const likeToken = `%${escapeLike(firstToken)}%`;

  let rows: UserRow[];
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
       FROM users
       WHERE username LIKE ?1 ESCAPE '\\'
          OR display_name LIKE ?1 ESCAPE '\\'
          OR username LIKE ?2 ESCAPE '\\'
          OR display_name LIKE ?2 ESCAPE '\\'
       LIMIT 200`
    )
      .bind(likeAll, likeToken)
      .all<UserRow>());
  } catch (e) {
    return errorJson(500, 'User search failed', String(e));
  }

  // Fuzzy ranking (exact > prefix > word > substring > typo > subsequence).
  // LIKE is only a cheap pre-filter; when it comes back thin, widen the pool
  // with a bounded scan so typos ('dva' ~ 'dave') still find people.
  if (rows.length < LIMIT) {
    try {
      const { results: wider } = await env.DB.prepare(
        `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
         FROM users LIMIT 500`
      ).all<UserRow>();
      const seen = new Set(rows.map((r) => r.id));
      rows = rows.concat(wider.filter((r) => !seen.has(r.id)));
    } catch {
      // keep the LIKE results
    }
  }

  const order = rankCandidates(
    q,
    rows.map((r) => ({ username: r.username, displayName: r.display_name }))
  );
  const ranked = order.map((i) => rows[i]).filter(Boolean).slice(0, LIMIT);

  const me = await sessionUser(request, env);
  const ids = ranked.map((r) => r.id);

  // Batch presence (one KV pass), stats (one grouped query), friendship
  // edges (one query) — never N+1.
  const [presences, stats, friendEdges] = await Promise.all([
    getPresences(env, ids),
    fetchStats(env, ids),
    me ? friendEdgeMap(env, me.id, ids) : Promise.resolve(new Map()),
  ]);

  const users: UserSearchHit[] = ranked.map((row) => {
    const presence: PresencePayload = presences.get(row.id) ?? OFFLINE_PRESENCE;
    return {
      user: publicUserFromRow(
        row,
        stats.get(row.id) ?? { watchCount: 0, friendCount: 0, favoritesCount: 0 },
        presence.is_host
      ),
      presence,
      friendship: me ? friendshipFor(friendEdges.get(row.id), me, row.id) : 'none',
    };
  });

  // Presence is live data — never cache at the edge.
  return json({ query: q, users }, 200, { 'Cache-Control': 'no-store' });
}
