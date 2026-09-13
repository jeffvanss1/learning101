// routes/auth.ts — demo-grade session endpoints.
//
// `POST /api/auth/session { username, displayName? }` → create-or-login,
// returns `{ token, user }`. There are no passwords (documented in the
// README); tokens are HMAC-signed in src/auth.ts so profile mutations are
// still authenticated and tamper-proof.

import type { Env, UserRow } from '../types.js';
import { json, errorJson, readJson } from '../http.js';
import { issueToken, sessionUser } from '../auth.js';

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,30})[a-z0-9]$/;

/** Public projection of a user row. */
export function toPublicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatarUrl: row.avatar_url,
    avatarFrameId: row.avatar_frame_id || 'default',
    bio: row.bio || '',
    createdAt: row.created_at,
  };
}

/** Create the account if missing (case-insensitive handle), then log in. */
export async function handleSessionCreate(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ username?: string; displayName?: string; avatarUrl?: string }>(
    request
  );
  if (!body) return errorJson(400, 'Invalid JSON body');

  const rawUsername = String(body.username ?? '').trim().toLowerCase();
  if (!rawUsername || !USERNAME_RE.test(rawUsername)) {
    return errorJson(
      422,
      'Username must be 3-32 chars: lowercase letters, numbers, "-" or "_".'
    );
  }
  const displayName = String(body.displayName ?? rawUsername).trim().slice(0, 60) || rawUsername;
  const avatarUrl = String(body.avatarUrl ?? '').slice(0, 500);
  const now = Date.now();
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, 'default', '', ?5, ?5)
       ON CONFLICT (username) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    )
      .bind(id, rawUsername, displayName, avatarUrl, now)
      .run();
  } catch (e) {
    return errorJson(500, 'Could not create session', String(e));
  }

  const row = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
     FROM users WHERE username = ?1`
  )
    .bind(rawUsername)
    .first<UserRow>();
  if (!row) return errorJson(500, 'Session user not found after upsert');

  const token = await issueToken(env, { id: row.id, username: row.username });
  return json({ token, user: toPublicUser(row) }, 201);
}

/** `GET /api/auth/me` — who am I? (null when anonymous) */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await sessionUser(request, env);
  if (!auth) return json({ user: null }, 200);
  const row = await env.DB.prepare(
    `SELECT id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at
     FROM users WHERE id = ?1`
  )
    .bind(auth.id)
    .first<UserRow>();
  return json({ user: row ? toPublicUser(row) : null }, 200);
}
