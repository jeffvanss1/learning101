// schema.ts — self-provisioning D1 schema.
//
// The canonical migrations live in migrations/ (apply with
// `npm run db:migrate:local|remote`). This module makes the app resilient
// anyway: on the first profile-route request in an isolate it verifies the
// tables exist and creates any that are missing with idempotent
// `CREATE ... IF NOT EXISTS` DDL. Without it, a fresh/unmigrated database
// turned every session create into a 500 and left users permanently
// "anonymous" — the exact bug this prevents.

import type { Env } from './types.js';

let schemaReady = false;

/** DDL matching migrations/0001_profiles.sql + 0002_access_codes.sql. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    avatar_frame_id TEXT NOT NULL DEFAULT 'default',
    bio TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    code_hash TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_code_hash
     ON users (code_hash) WHERE code_hash IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS user_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'movie',
    media_title TEXT NOT NULL,
    poster_url TEXT NOT NULL DEFAULT '',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, media_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_favorites_slot
     ON user_favorites (user_id, display_order)`,
  `CREATE INDEX IF NOT EXISTS idx_user_favorites_order
     ON user_favorites (user_id, display_order)`,
  `CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'movie',
    media_title TEXT NOT NULL,
    poster_url TEXT NOT NULL DEFAULT '',
    season INTEGER,
    episode INTEGER,
    completed INTEGER NOT NULL DEFAULT 0,
    position_seconds INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    watched_at INTEGER NOT NULL,
    UNIQUE (user_id, media_id, season, episode)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_watch_history_recent
     ON watch_history (user_id, watched_at DESC)`,
  `CREATE TABLE IF NOT EXISTS friendships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'blocked')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships (friend_id, status)`,
  // Admin monitoring: one row per room minted via POST /api/rooms. Rooms
  // themselves live in Durable Objects (not enumerable) — this registry is
  // the only server-side "who created what, when" record.
  // LIKES: uncapped taste signal (favorites stay the pinned-4 showcase).
  // Drives the profile "Liked" collection and the For You suggestions.
  `CREATE TABLE IF NOT EXISTS user_likes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'movie',
    media_title TEXT NOT NULL,
    poster_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, media_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_likes_time ON user_likes (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS rooms_created (
    room_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '',
    owner_username TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_created_time ON rooms_created (created_at DESC)`,
];

/**
 * Ensure the profile tables exist. Runs at most once per isolate; a failed
 * attempt leaves the flag unset so the next request retries.
 * Best-effort: failures are swallowed (routes surface their own errors).
 */
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  try {
    // 0002 added users.code_hash via ALTER TABLE (not idempotent), so only
    // include it when the column is missing — fresh databases get it from
    // the CREATE TABLE above, old ones from this ALTER.
    let needsCodeColumn = false;
    let needsAdminColumn = false;
    let needsProgressColumns = false;
    try {
      const info = await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();
      needsCodeColumn = !info.results.some((c) => c.name === 'code_hash');
      needsAdminColumn = !info.results.some((c) => c.name === 'is_admin');
    } catch {
      // Table missing entirely → the CREATE TABLE in the batch covers it.
    }
    try {
      const whInfo = await env.DB.prepare('PRAGMA table_info(watch_history)').all<{ name: string }>();
      // 0003: resume positions live server-side so every device remembers
      // the episode and where it faded out.
      needsProgressColumns =
        !whInfo.results.some((c) => c.name === 'position_seconds') ||
        !whInfo.results.some((c) => c.name === 'duration_seconds');
    } catch {
      // Table missing entirely → the CREATE TABLE in the batch covers it.
    }

    const statements = DDL.map((sql) => env.DB.prepare(sql));
    if (needsCodeColumn) {
      statements.push(env.DB.prepare('ALTER TABLE users ADD COLUMN code_hash TEXT'));
    }
    if (needsAdminColumn) {
      statements.push(env.DB.prepare('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'));
    }
    if (needsProgressColumns) {
      statements.push(env.DB.prepare('ALTER TABLE watch_history ADD COLUMN position_seconds INTEGER NOT NULL DEFAULT 0'));
      statements.push(env.DB.prepare('ALTER TABLE watch_history ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0'));
    }
    // D1 batches run inside an implicit transaction and reject DDL there, so
    // each statement runs individually (all idempotent — safe to retry).
    let failures = 0;
    for (const stmt of statements) {
      try {
        await stmt.run();
      } catch (e) {
        const msg = String(e);
        if (/duplicate column/i.test(msg)) continue; // ALTER raced — fine
        failures++;
      }
    }
    if (!failures) {
      schemaReady = true;
      // Seed the first admin (idempotent — matches 0 rows once set). The
      // account is keyed by username; the owner of this deployment is @jeff.
      try {
        await env.DB.prepare("UPDATE users SET is_admin = 1 WHERE username = 'jeff' AND is_admin = 0").run();
      } catch {
        // Best-effort: a missing table here is covered by the retry path.
      }
    }
  } catch {
    // Leave schemaReady false — retried on the next request.
  }
}
