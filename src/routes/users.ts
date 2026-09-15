// routes/users.ts — profile endpoints.
//
//   GET  /api/user/:username   public profile (favorites, history, presence)
//   PUT  /api/user/profile     update bio / display name / frame / pins
//   POST /api/user/history     record a watched title (called by the client)
//   GET  /api/friends          friends + incoming requests (with presence)
//   POST /api/friends/:u       send a friend request (auto-accepts mutual)
//   PUT  /api/friends/:u       accept an incoming request
//   DELETE /api/friends/:u     remove / decline / cancel

import type {
  Env,
  UserRow,
  LikeItem,
  FavoriteRow,
  HistoryRow,
  FriendshipRow,
  PresencePayload,
  PublicUser,
  Badge,
  AuthedUser,
  UserProfileResponse,
  FriendshipState,
  FriendEntry,
  FriendUser,
} from '../types.js';
import { json, errorJson, readJson } from '../http.js';
import { sessionUser } from '../auth.js';
import { getPresence, getPresences } from '../presence.js';
import { levelFor, levelTitle, badgesFor } from '../lib/level.js';
import { toPublicUser } from './auth.js';

// Must mirror the frame catalog in dist/js/social.js (rendered + validated).
export const AVATAR_FRAMES: Record<string, string> = {
  default: 'None',
  gold: 'Gold',
  neon: 'Neon',
  rainbow: 'Rainbow',
  flame: 'Flame',
  ice: 'Ice',
};

export const OFFLINE_PRESENCE: PresencePayload = {
  status: 'OFFLINE',
  room_id: '',
  media_title: '',
  media_id: '',
  current_timestamp: '',
  is_host: false,
  last_updated: 0,
};

export interface UserStats {
  watchCount: number;
  friendCount: number;
  favoritesCount: number;
  likesCount: number;
}

/** Full public projection: row + stats → level, title, badges. */
export function publicUserFromRow(row: UserRow, stats: UserStats, isHosting = false): PublicUser {
  const { level } = levelFor(stats.watchCount);
  const badges: Badge[] = badgesFor({ ...stats, isHosting });
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatarUrl: row.avatar_url,
    avatarFrameId: row.avatar_frame_id || 'default',
    bio: row.bio || '',
    createdAt: row.created_at,
    level,
    levelTitle: levelTitle(level),
    badges,
    stats,
  };
}

/** Aggregate watch/friend/favorite counts for many users in one query. */
export async function fetchStats(
  env: Env,
  userIds: string[]
): Promise<Map<string, UserStats>> {
  const out = new Map<string, UserStats>();
  if (!userIds.length) return out;
  const placeholders = userIds.map((_, i) => `?${i + 1}`).join(',');
  try {
    const watches = await env.DB.prepare(
      `SELECT user_id, COUNT(*) AS n FROM watch_history WHERE user_id IN (${placeholders}) GROUP BY user_id`
    )
      .bind(...userIds)
      .all<{ user_id: string; n: number }>();
    const friendsRes = await env.DB.prepare(
      `SELECT user_id AS uid, COUNT(*) AS n FROM friendships
       WHERE status = 'accepted' AND user_id IN (${placeholders}) GROUP BY user_id`
    )
      .bind(...userIds)
      .all<{ uid: string; n: number }>();
    const favsRes = await env.DB.prepare(
      `SELECT user_id, COUNT(*) AS n FROM user_favorites WHERE user_id IN (${placeholders}) GROUP BY user_id`
    )
      .bind(...userIds)
      .all<{ user_id: string; n: number }>();
    const likesRes = await env.DB.prepare(
      `SELECT user_id, COUNT(*) AS n FROM user_likes WHERE user_id IN (${placeholders}) GROUP BY user_id`
    )
      .bind(...userIds)
      .all<{ user_id: string; n: number }>();

    const friends = friendsRes.results;
    const favs = favsRes.results;

    const friendCounts = new Map<string, number>();
    for (const r of friends) friendCounts.set(r.uid, (friendCounts.get(r.uid) || 0) + r.n);
    const favCounts = new Map(favs.map((r) => [r.user_id, r.n] as const));
    const likeCounts = new Map(likesRes.results.map((r) => [r.user_id, r.n] as const));
    const watchCounts = new Map(watches.results.map((r) => [r.user_id, r.n] as const));

    for (const id of userIds) {
      out.set(id, {
        watchCount: watchCounts.get(id) || 0,
        friendCount: friendCounts.get(id) || 0,
        favoritesCount: favCounts.get(id) || 0,
        likesCount: likeCounts.get(id) || 0,
      });
    }
  } catch {
    // Stats are cosmetic — degrade to zeros rather than failing the request.
  }
  return out;
}

/** My friendship edge(s) with each of `otherIds`, mapped by their user id. */
export async function friendEdgeMap(
  env: Env,
  meId: string,
  otherIds: string[]
): Promise<Map<string, FriendshipRow>> {
  const out = new Map<string, FriendshipRow>();
  if (!otherIds.length) return out;
  const placeholders = otherIds.map((_, i) => `?${i + 2}`).join(',');
  try {
    const { results } = await env.DB.prepare(
      `SELECT user_id, friend_id, status, created_at FROM friendships
       WHERE (user_id = ?1 AND friend_id IN (${placeholders}))
          OR (friend_id = ?1 AND user_id IN (${placeholders}))`
    )
      // ?1..?n+1 are reused across both arms — bind exactly n+1 values.
      .bind(meId, ...otherIds)
      .all<FriendshipRow>();
    // Both directed edges can exist per pair; pick deterministically —
    // a block always wins for display (never advertise a blocked pair as
    // friends), then accepted, then pending.
    const RANK: Record<string, number> = { blocked: 0, accepted: 1, pending: 2 };
    for (const f of results) {
      const key = f.user_id === meId ? f.friend_id : f.user_id;
      const prev = out.get(key);
      if (!prev || RANK[f.status] < RANK[prev.status]) out.set(key, f);
    }
  } catch {
    // Best-effort enrichment.
  }
  return out;
}

/** Normalize an edge row into the API's directional friendship state. */
export function friendshipFor(
  edge: FriendshipRow | undefined,
  me: AuthedUser | null,
  otherId: string
): FriendshipState {
  if (!me) return 'none';
  if (me.id === otherId) return 'self';
  if (!edge) return 'none';
  if (edge.status === 'pending') {
    // I sent it → outgoing; they sent it → incoming.
    return edge.user_id === me.id ? 'pending-out' : 'pending-in';
  }
  return edge.status;
}

function rowToFavorite(f: FavoriteRow) {
  return {
    mediaId: f.media_id,
    mediaType: f.media_type,
    mediaTitle: f.media_title,
    posterUrl: f.poster_url,
    displayOrder: f.display_order,
  };
}

interface LikeRow {
  user_id: string;
  media_id: string;
  media_type: string;
  media_title: string;
  poster_url: string;
  created_at: number;
}

function rowToLike(l: LikeRow): LikeItem {
  return {
    mediaId: l.media_id,
    mediaType: l.media_type,
    mediaTitle: l.media_title,
    posterUrl: l.poster_url,
    createdAt: l.created_at,
  };
}

function rowToHistory(h: HistoryRow) {
  return {
    mediaId: h.media_id,
    mediaType: h.media_type,
    mediaTitle: h.media_title,
    posterUrl: h.poster_url,
    season: h.season || null,
    episode: h.episode || null,
    completed: !!h.completed,
    watchedAt: h.watched_at,
  };
}

// ---------------------------------------------------------------------------
// GET /api/user/:username
// ---------------------------------------------------------------------------
export async function handleGetProfile(
  request: Request,
  env: Env,
  username: string
): Promise<Response> {
  const me = await sessionUser(request, env);

  const user = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
     FROM users WHERE username = ?1 COLLATE NOCASE`
  )
    .bind(username)
    .first<UserRow>();
  if (!user) return errorJson(404, 'User not found');

  const [favoritesRes, historyRes, likesRes, statsMap, presence, friendEdges, friendsRes] = await Promise.all([
    env.DB.prepare(
      `SELECT user_id, media_id, media_type, media_title, poster_url, display_order, created_at
       FROM user_favorites WHERE user_id = ?1 ORDER BY display_order LIMIT 4`
    )
      .bind(user.id)
      .all<FavoriteRow>(),
    env.DB.prepare(
      `SELECT id, user_id, media_id, media_type, media_title, poster_url, season, episode, completed, watched_at
       FROM watch_history WHERE user_id = ?1 ORDER BY watched_at DESC LIMIT 5`
    )
      .bind(user.id)
      .all<HistoryRow>(),
    env.DB.prepare(
      `SELECT user_id, media_id, media_type, media_title, poster_url, created_at
       FROM user_likes WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 24`
    )
      .bind(user.id)
      .all<LikeRow>(),
    fetchStats(env, [user.id]),
    getPresence(env, user.id),
    me ? friendEdgeMap(env, me.id, [user.id]) : Promise.resolve(new Map()),
    // Public friends list (Steam-style), live presence merged below.
    env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_frame_id
       FROM friendships f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?1 AND f.status = 'accepted'
       ORDER BY u.display_name COLLATE NOCASE LIMIT 24`
    )
      .bind(user.id)
      .all<Pick<UserRow, 'id' | 'username' | 'display_name' | 'avatar_url' | 'avatar_frame_id'>>(),
  ]);

  const friendPresences = await getPresences(
    env,
    friendsRes.results.map((r) => r.id)
  );
  const friendEntries: FriendEntry[] = friendsRes.results.map((r) => ({
    user: {
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatarUrl: r.avatar_url,
      avatarFrameId: r.avatar_frame_id || 'default',
    } satisfies FriendUser,
    presence: friendPresences.get(r.id) ?? OFFLINE_PRESENCE,
  }));

  const stats =
    statsMap.get(user.id) ?? { watchCount: 0, friendCount: 0, favoritesCount: 0, likesCount: 0 };
  const edge = friendEdges.get(user.id);

  const body: UserProfileResponse = {
    user: publicUserFromRow(user, stats, presence.is_host),
    presence,
    favorites: favoritesRes.results.map(rowToFavorite),
    history: historyRes.results.map(rowToHistory),
    likes: likesRes.results.map(rowToLike),
    friends: friendEntries,
    friendship: friendshipFor(edge, me, user.id),
  };
  // Presence is live — never cache.
  return json(body, 200, { 'Cache-Control': 'no-store' });
}

// ---------------------------------------------------------------------------
// PUT /api/user/profile  (auth)
// ---------------------------------------------------------------------------
export async function handleUpdateProfile(
  request: Request,
  env: Env,
  me: AuthedUser
): Promise<Response> {
  const body = await readJson<{
    displayName?: string;
    bio?: string;
    avatarFrameId?: string;
    favorites?: Array<{
      mediaId?: string;
      mediaType?: string;
      mediaTitle?: string;
      posterUrl?: string;
    }>;
  }>(request);
  if (!body) return errorJson(400, 'Invalid JSON body');

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (typeof body.displayName === 'string') {
    const displayName = body.displayName.trim().slice(0, 60);
    if (!displayName) return errorJson(422, 'Display name cannot be empty.');
    updates.push('display_name = ?');
    binds.push(displayName);
  }
  if (typeof body.bio === 'string') {
    const bio = body.bio.trim().slice(0, 300);
    updates.push('bio = ?');
    binds.push(bio);
  }
  if (typeof body.avatarFrameId === 'string') {
    if (!AVATAR_FRAMES[body.avatarFrameId]) {
      return errorJson(422, `Unknown avatar frame. Valid: ${Object.keys(AVATAR_FRAMES).join(', ')}`);
    }
    updates.push('avatar_frame_id = ?');
    binds.push(body.avatarFrameId);
  }

  // Replace the pinned showcase when `favorites` is provided (max 4 items —
  // enforced here AND by the (user_id, display_order) unique index).
  let favoriteStmts: D1PreparedStatement[] | null = null;
  if (Array.isArray(body.favorites)) {
    if (body.favorites.length > 4) {
      return errorJson(422, 'You can pin at most 4 favorites.');
    }
    const seen = new Set<string>();
    const pins: FavoriteRow[] = [];
    for (let i = 0; i < body.favorites.length; i++) {
      const raw = body.favorites[i] ?? {};
      const mediaId = String(raw.mediaId ?? '').trim().slice(0, 64);
      const mediaTitle = String(raw.mediaTitle ?? '').trim().slice(0, 300);
      if (!mediaId || !mediaTitle || seen.has(mediaId)) continue;
      seen.add(mediaId);
      pins.push({
        user_id: me.id,
        media_id: mediaId,
        media_type: ['movie', 'tv', 'anime'].includes(String(raw.mediaType))
          ? String(raw.mediaType)
          : 'movie',
        media_title: mediaTitle,
        poster_url: String(raw.posterUrl ?? '').slice(0, 600),
        display_order: pins.length,
        created_at: Date.now(),
      });
    }
    favoriteStmts = [
      env.DB.prepare('DELETE FROM user_favorites WHERE user_id = ?1').bind(me.id),
      ...pins.map((p) =>
        env.DB.prepare(
          `INSERT INTO user_favorites (user_id, media_id, media_type, media_title, poster_url, display_order, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        ).bind(p.user_id, p.media_id, p.media_type, p.media_title, p.poster_url, p.display_order, p.created_at)
      ),
    ];
  }

  try {
    if (updates.length) {
      await env.DB.prepare(
        `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
      )
        .bind(...binds, me.id)
        .run();
    }
    if (favoriteStmts) await env.DB.batch(favoriteStmts);
  } catch (e) {
    return errorJson(500, 'Could not update profile', String(e));
  }

  const row = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
     FROM users WHERE id = ?1`
  )
    .bind(me.id)
    .first<UserRow>();
  if (!row) return errorJson(404, 'Account no longer exists');
  const statsMap = await fetchStats(env, [me.id]);
  const stats = statsMap.get(me.id) ?? { watchCount: 0, friendCount: 0, favoritesCount: 0, likesCount: 0 };
  return json({ user: toPublicUser(row), stats }, 200);
}

// ---------------------------------------------------------------------------
// POST /api/user/history  (auth) — one row per title+episode, re-watches bump
// watched_at. season/episode use 0 for "not applicable" so the UNIQUE index
// dedupes movies correctly (SQLite treats NULLs as distinct).
// ---------------------------------------------------------------------------
export async function handleRecordHistory(
  request: Request,
  env: Env,
  me: AuthedUser
): Promise<Response> {
  const body = await readJson<{
    mediaId?: string;
    mediaType?: string;
    mediaTitle?: string;
    posterUrl?: string;
    backdropUrl?: string;
    season?: number;
    episode?: number;
    completed?: boolean;
    positionSeconds?: number;
    durationSeconds?: number;
  }>(request);
  if (!body) return errorJson(400, 'Invalid JSON body');

  const mediaId = String(body.mediaId ?? '').trim().slice(0, 64);
  const mediaTitle = String(body.mediaTitle ?? '').trim().slice(0, 300);
  if (!mediaId || !mediaTitle) return errorJson(422, 'mediaId and mediaTitle are required.');

  const season = Number.isInteger(body.season) && (body.season as number) > 0 ? body.season! : 0;
  const episode = Number.isInteger(body.episode) && (body.episode as number) > 0 ? body.episode! : 0;

  try {
    // Resume memory: clamp to sane bounds (a day covers any runtime).
    const positionSeconds = Math.max(0, Math.min(Math.floor(Number(body.positionSeconds) || 0), 86400));
    const durationSeconds = Math.max(0, Math.min(Math.floor(Number(body.durationSeconds) || 0), 86400));

    await env.DB.prepare(
      `INSERT INTO watch_history (user_id, media_id, media_type, media_title, poster_url, backdrop_url, season, episode, completed, position_seconds, duration_seconds, watched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (user_id, media_id, season, episode) DO UPDATE SET
         watched_at = excluded.watched_at,
         completed = excluded.completed,
         position_seconds = excluded.position_seconds,
         duration_seconds = excluded.duration_seconds,
         media_title = excluded.media_title,
         poster_url = excluded.poster_url,
         backdrop_url = excluded.backdrop_url`
    )
      .bind(
        me.id,
        mediaId,
        ['movie', 'tv', 'anime'].includes(String(body.mediaType)) ? String(body.mediaType) : 'movie',
        mediaTitle,
        String(body.posterUrl ?? '').slice(0, 600),
        String(body.backdropUrl ?? '').slice(0, 600),
        season,
        episode,
        body.completed ? 1 : 0,
        positionSeconds,
        durationSeconds,
        Date.now()
      )
      .run();
  } catch (e) {
    return errorJson(500, 'Could not record history', String(e));
  }
  return json({ ok: true }, 201);
}

/**
 * GET /api/user/history — the signed-in user's history (newest first).
 * The /history page merges this with the local list (local wins: it carries
 * resume positions); this keeps phone and desktop consistent on titles.
 */
export async function handleGetHistory(_request: Request, env: Env, me: AuthedUser): Promise<Response> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT media_id, media_type, media_title, poster_url, backdrop_url, season, episode, completed, position_seconds, duration_seconds, watched_at
       FROM watch_history WHERE user_id = ?1 ORDER BY watched_at DESC LIMIT 100`
    )
      .bind(me.id)
      .all();
    const items = (results || []).map((r: Record<string, unknown>) => ({
      mediaId: String(r.media_id),
      mediaType: String(r.media_type),
      mediaTitle: String(r.media_title),
      posterUrl: r.poster_url ? String(r.poster_url) : '',
      backdropUrl: r.backdrop_url ? String(r.backdrop_url) : '',
      season: Number(r.season) || null,
      episode: Number(r.episode) || null,
      completed: Number(r.completed) === 1,
      positionSeconds: Number(r.position_seconds) || 0,
      durationSeconds: Number(r.duration_seconds) || 0,
      watchedAt: Number(r.watched_at) || 0,
    }));
    return json({ items });
  } catch (e) {
    return errorJson(500, 'Could not load history', String(e));
  }
}

// ---------------------------------------------------------------------------
// /api/friends
// ---------------------------------------------------------------------------
export async function handleListFriends(request: Request, env: Env, me: AuthedUser): Promise<Response> {
  const [accepted, incoming] = await Promise.all([
    env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_frame_id FROM friendships f
       JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?1 AND f.status = 'accepted' ORDER BY u.display_name COLLATE NOCASE`
    )
      .bind(me.id)
      .all<Pick<UserRow, 'id' | 'username' | 'display_name' | 'avatar_url' | 'avatar_frame_id'>>(),
    env.DB.prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.avatar_frame_id, f.created_at FROM friendships f
       JOIN users u ON u.id = f.user_id
       WHERE f.friend_id = ?1 AND f.status = 'pending' ORDER BY f.created_at DESC`
    )
      .bind(me.id)
      .all<Pick<UserRow, 'id' | 'username' | 'display_name' | 'avatar_url' | 'avatar_frame_id'>>(),
  ]);

  const ids = [
    ...accepted.results.map((r) => r.id),
    ...incoming.results.map((r) => r.id),
  ];
  const presences = await getPresences(env, ids);
  return json(
    {
      friends: accepted.results.map((r) => ({ ...toPublicUser({ ...r, bio: '', created_at: 0, last_seen_at: 0 } as UserRow), presence: presences.get(r.id) ?? OFFLINE_PRESENCE })),
      incoming: incoming.results.map((r) => ({ ...toPublicUser({ ...r, bio: '', created_at: 0, last_seen_at: 0 } as UserRow), presence: presences.get(r.id) ?? OFFLINE_PRESENCE })),
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function userByUsername(env: Env, username: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
     FROM users WHERE username = ?1 COLLATE NOCASE`
  )
    .bind(username)
    .first<UserRow>();
}

/** POST /api/friends/:username — request (auto-accepts when they already asked). */
export async function handleFriendRequest(request: Request, env: Env, me: AuthedUser, username: string): Promise<Response> {
  const target = await userByUsername(env, username);
  if (!target) return errorJson(404, 'User not found');
  if (target.id === me.id) return errorJson(422, 'You cannot befriend yourself.');

  // Read BOTH directed edges — the pair's state is the worst/common state
  // of the two, never "whichever row happens to come back first".
  const { results: pairRows } = await env.DB.prepare(
    `SELECT user_id, friend_id, status FROM friendships
     WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)`
  )
    .bind(me.id, target.id)
    .all<FriendshipRow>();
  // A block, in EITHER direction, stops new requests — the blocker must
  // remove/decline first. (Previously the blocker's own request overwrote
  // their block with a pending edge.)
  if (pairRows.some((e) => e.status === 'blocked')) {
    return errorJson(403, 'Unblock this person first.');
  }
  if (pairRows.some((e) => e.status === 'accepted')) {
    return json({ status: 'accepted' }, 200);
  }

  // They already invited us → accept both edges.
  if (pairRows.some((e) => e.user_id === target.id && e.status === 'pending')) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE friendships SET status = 'accepted' WHERE user_id = ?1 AND friend_id = ?2`).bind(target.id, me.id),
      env.DB.prepare(
        `INSERT INTO friendships (user_id, friend_id, status, created_at) VALUES (?1, ?2, 'accepted', ?3)
         ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'`
      ).bind(me.id, target.id, Date.now()),
    ]);
    return json({ status: 'accepted' }, 200);
  }

  await env.DB.prepare(
    `INSERT INTO friendships (user_id, friend_id, status, created_at) VALUES (?1, ?2, 'pending', ?3)
     ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'pending', created_at = excluded.created_at`
  )
    .bind(me.id, target.id, Date.now())
    .run();
  return json({ status: 'pending' }, 201);
}

/** PUT /api/friends/:username — accept an incoming request. */
export async function handleFriendAccept(request: Request, env: Env, me: AuthedUser, username: string): Promise<Response> {
  const target = await userByUsername(env, username);
  if (!target) return errorJson(404, 'User not found');

  const pending = await env.DB.prepare(
    `SELECT user_id, friend_id, status FROM friendships WHERE user_id = ?1 AND friend_id = ?2 AND status = 'pending'`
  )
    .bind(target.id, me.id)
    .first<FriendshipRow>();
  if (!pending) return errorJson(404, 'No pending request from this user.');

  await env.DB.batch([
    env.DB.prepare(`UPDATE friendships SET status = 'accepted' WHERE user_id = ?1 AND friend_id = ?2`).bind(target.id, me.id),
    env.DB.prepare(
      `INSERT INTO friendships (user_id, friend_id, status, created_at) VALUES (?1, ?2, 'accepted', ?3)
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted'`
    ).bind(me.id, target.id, Date.now()),
  ]);
  return json({ status: 'accepted' }, 200);
}

/** DELETE /api/friends/:username — remove / decline / cancel in one move. */
export async function handleFriendRemove(request: Request, env: Env, me: AuthedUser, username: string): Promise<Response> {
  const target = await userByUsername(env, username);
  if (!target) return errorJson(404, 'User not found');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(me.id, target.id),
    env.DB.prepare('DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2').bind(target.id, me.id),
  ]);
  return json({ ok: true }, 200);
}
