// admin.ts — deployment-owner monitoring surface.
// GET /api/admin/overview → account + room registry stats, recent lists and
// LIVE room occupancy (from presence KV). Everything here is server-gated on
// users.is_admin; the UI nav item is a convenience, never the gate.

import type { Env } from '../types.js';
import { json, errorJson } from '../http.js';
import { sessionUser } from '../auth.js';

export async function handleAdminOverview(request: Request, env: Env): Promise<Response> {
  const auth = await sessionUser(request, env);
  if (!auth) return errorJson(401, 'Sign in required.');
  if (!env.DB) return errorJson(500, 'Database unavailable');

  const adminRow = await env.DB.prepare('SELECT is_admin FROM users WHERE id = ?1')
    .bind(auth.id)
    .first<{ is_admin: number }>();
  if (!adminRow || !adminRow.is_admin) return errorJson(403, 'Admin only.');

  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const weekAgo = now - 7 * 86_400_000;

  const count = async (sql: string, since?: number): Promise<number> => {
    const q = env.DB.prepare(sql);
    const row = since === undefined
      ? await q.first<{ n: number }>()
      : await q.bind(since).first<{ n: number }>();
    return (row && row.n) || 0;
  };

  const [usersTotal, usersToday, usersWeek, roomsTotal, roomsToday, roomsWeek] = await Promise.all([
    count('SELECT COUNT(*) AS n FROM users'),
    count('SELECT COUNT(*) AS n FROM users WHERE created_at > ?1', dayAgo),
    count('SELECT COUNT(*) AS n FROM users WHERE created_at > ?1', weekAgo),
    count('SELECT COUNT(*) AS n FROM rooms_created'),
    count('SELECT COUNT(*) AS n FROM rooms_created WHERE created_at > ?1', dayAgo),
    count('SELECT COUNT(*) AS n FROM rooms_created WHERE created_at > ?1', weekAgo),
  ]);

  const [usersRes, roomsRes] = await Promise.all([
    env.DB.prepare(
      'SELECT id, username, display_name, avatar_url, created_at, last_seen_at, is_admin FROM users ORDER BY created_at DESC LIMIT 50'
    ).all(),
    env.DB.prepare(
      'SELECT room_id, owner_id, owner_username, created_at FROM rooms_created ORDER BY created_at DESC LIMIT 50'
    ).all(),
  ]);

  // LIVE occupancy: read presence keys (they carry room_id while WATCHING_*).
  // Capped — an admin refresh is occasional, but KV list+get are billed ops.
  const live: Record<string, number> = {};
  let liveViewers = 0;
  try {
    const page = await env.PRESENCE_KV.list({ prefix: 'presence:user:', limit: 200 });
    const values = await Promise.all(page.keys.slice(0, 200).map((k: { name: string }) => env.PRESENCE_KV.get(k.name)));
    for (const v of values) {
      if (!v) continue;
      try {
        const p = JSON.parse(v) as { status?: string; room_id?: string };
        if ((p.status === 'WATCHING_PARTY' || p.status === 'WATCHING_SOLO') && p.room_id) {
          live[p.room_id] = (live[p.room_id] || 0) + 1;
          liveViewers++;
        }
      } catch {
        // malformed presence value — skip
      }
    }
  } catch {
    // KV trouble → live counts stay empty; registry data still renders.
  }

  return json(
    {
      users: {
        total: usersTotal,
        today: usersToday,
        week: usersWeek,
        recent: usersRes.results || [],
      },
      rooms: {
        total: roomsTotal,
        today: roomsToday,
        week: roomsWeek,
        recent: roomsRes.results || [],
      },
      live: { rooms: Object.keys(live).length, viewers: liveViewers, byRoom: live },
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}
