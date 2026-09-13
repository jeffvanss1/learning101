// routes/auth.ts — passwordless identity with unique access codes.
//
// How accounts work (no passwords, no forms):
//   1. First visit: pick a display name → account created silently, server
//      generates a unique ACCESS CODE ("K7MF-9Q2X-P4TD-J8WE") and shows it
//      exactly once. Only its SHA-256 hash (peppered with SESSION_SECRET)
//      is stored, so the code can never be re-displayed or stolen from D1.
//   2. Any device: enter that code at `POST /api/auth/claim` to sign in —
//      the profile travels without a password.
//   3. Rotation: `POST /api/auth/code` (authenticated) invalidates the old
//      code and issues a fresh one.
//
// Legacy accounts created before codes existed have `code_hash = NULL`;
// the first person to log in with that username upgrades the account and
// receives its code (one-time, transitional — documented in the README).

import type { Env, UserRow } from '../types.js';
import { json, errorJson, readJson } from '../http.js';
import { issueToken, sessionUser } from '../auth.js';
import { generateAccessCode, normalizeCode, isValidNormalizedCode } from '../lib/code.js';

export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,30})[a-z0-9]$/;

/** Handles that would collide with app routes (/api/user/profile, /user/me,
 * /api/auth/...) — not registrable. */
export const RESERVED_USERNAMES = new Set([
  'profile', 'me', 'self', 'api', 'auth', 'search', 'friends', 'presence',
  'user', 'users', 'room', 'rooms', 'admin', 'root', 'login', 'logout',
  'signup', 'register', 'settings', 'static', 'assets', 'favicon',
]);

const USER_COLS =
  'id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at';

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

/** Peppered SHA-256 of a normalized code (pepper = SESSION_SECRET). */
async function hashCode(normalized: string, env: Env): Promise<string> {
  const pepper = env.SESSION_SECRET || 'watchparty-dev-secret';
  const data = new TextEncoder().encode(pepper + ':access-code:' + normalized);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function selectByUsername(env: Env, username: string) {
  return env.DB.prepare(`SELECT ${USER_COLS}, code_hash FROM users WHERE username = ?1 COLLATE NOCASE`)
    .bind(username)
    .first<UserRow & { code_hash: string | null }>();
}

/**
 * POST /api/auth/session { username, displayName?, avatarUrl? }
 * Creates a NEW account (and its access code) or resumes a legacy one.
 * A username that already has an access code is rejected with 409 — it can
 * only be claimed with the code, so nobody can take over an account by
 * re-typing its name.
 */
export async function handleSessionCreate(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{
    username?: string;
    displayName?: string;
    avatarUrl?: string;
  }>(request);
  if (!body) return errorJson(400, 'Invalid JSON body');

  const rawUsername = String(body.username ?? '').trim().toLowerCase();
  if (!rawUsername || !USERNAME_RE.test(rawUsername)) {
    return errorJson(
      422,
      'Username must be 3-32 chars: lowercase letters, numbers, "-" or "_".'
    );
  }
  if (RESERVED_USERNAMES.has(rawUsername)) {
    return errorJson(422, 'That username is reserved.');
  }
  const displayName = String(body.displayName ?? rawUsername).trim().slice(0, 60) || rawUsername;
  const avatarUrl = String(body.avatarUrl ?? '').slice(0, 500);
  const now = Date.now();

  const existing = await selectByUsername(env, rawUsername);
  if (existing) {
    if (existing.code_hash) {
      // Protected account: only its access code may claim it.
      return errorJson(
        409,
        'That name is taken. Pick another, or sign in with your access code.'
      );
    }
    // Legacy account (predates codes): upgrade in place, hand out a code.
    const accessCode = generateAccessCode();
    const codeHash = await hashCode(normalizeCode(accessCode), env);
    await env.DB.prepare(
      'UPDATE users SET code_hash = ?1, last_seen_at = ?2 WHERE id = ?3'
    )
      .bind(codeHash, now, existing.id)
      .run();
    const fresh = await selectByUsername(env, rawUsername);
    if (!fresh) return errorJson(500, 'Legacy upgrade failed');
    const token = await issueToken(env, { id: fresh.id, username: fresh.username });
    return json(
      { token, user: toPublicUser(fresh), accessCode, legacyClaim: true },
      201
    );
  }

  // Fresh account.
  const accessCode = generateAccessCode();
  const codeHash = await hashCode(normalizeCode(accessCode), env);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, avatar_url, avatar_frame_id, bio, created_at, last_seen_at, code_hash)
       VALUES (?1, ?2, ?3, ?4, 'default', '', ?5, ?5, ?6)`
    )
      .bind(id, rawUsername, displayName, avatarUrl, now, codeHash)
      .run();
  } catch (e) {
    // Lost a create race against the UNIQUE(username) constraint?
    if (/UNIQUE/i.test(String(e))) {
      return errorJson(
        409,
        'That name is taken. Pick another, or sign in with your access code.'
      );
    }
    return errorJson(500, 'Could not create session', String(e));
  }

  const row = await selectByUsername(env, rawUsername);
  if (!row) return errorJson(500, 'Session user not found after upsert');
  const token = await issueToken(env, { id: row.id, username: row.username });
  // `accessCode` is returned exactly once — the server keeps only the hash.
  return json({ token, user: toPublicUser(row), accessCode, created: true }, 201);
}

/**
 * POST /api/auth/claim { code } — sign in from anywhere with an access code.
 * Codes are rate-limited only by Cloudflare's edge in this demo; the 32^16
 * keyspace makes brute force impractical regardless.
 */
export async function handleClaim(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ code?: string }>(request);
  const normalized = normalizeCode(String((body && body.code) ?? ''));
  if (!isValidNormalizedCode(normalized)) {
    return errorJson(422, 'Access codes look like XXXX-XXXX-XXXX-XXXX.');
  }
  const hash = await hashCode(normalized, env);
  const row = await env.DB.prepare(
    `SELECT ${USER_COLS} FROM users WHERE code_hash = ?1`
  )
    .bind(hash)
    .first<UserRow>();
  if (!row) return errorJson(404, 'No account matches that access code.');

  await env.DB.prepare('UPDATE users SET last_seen_at = ?1 WHERE id = ?2')
    .bind(Date.now(), row.id)
    .run();
  const token = await issueToken(env, { id: row.id, username: row.username });
  return json({ token, user: toPublicUser(row) }, 200);
}

/**
 * POST /api/auth/code (auth) — rotate: invalidates the old code, returns the
 * new one (shown once). Old devices keep their session token until it
 * expires; the code itself is the only portable credential.
 */
export async function handleRotateCode(request: Request, env: Env): Promise<Response> {
  const me = await sessionUser(request, env);
  if (!me) return errorJson(401, 'Sign in to do that.');
  const accessCode = generateAccessCode();
  const codeHash = await hashCode(normalizeCode(accessCode), env);
  await env.DB.prepare('UPDATE users SET code_hash = ?1 WHERE id = ?2')
    .bind(codeHash, me.id)
    .run();
  return json({ accessCode }, 200);
}

/** `GET /api/auth/me` — who am I? (null when anonymous) */
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await sessionUser(request, env);
  if (!auth) return json({ user: null }, 200);
  const row = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1`)
    .bind(auth.id)
    .first<UserRow>();
  return json({ user: row ? toPublicUser(row) : null }, 200);
}
