-- 0001_profiles.sql — persistent profile system for WatchParty
--
-- Entities: users, user_favorites (pinned showcase), watch_history
-- (server-side per-user history) and friendships.
--
-- Apply locally:  npx wrangler d1 migrations apply watchparty-db --local
-- Apply remotely: npx wrangler d1 migrations apply watchparty-db --remote

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users — one row per account. `username` is the public, URL-safe handle
-- used in /user/:username and in search.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,                       -- opaque id (crypto.randomUUID-style)
  username          TEXT NOT NULL UNIQUE COLLATE NOCASE,    -- public handle, case-insensitive
  display_name      TEXT NOT NULL DEFAULT '',
  avatar_url        TEXT NOT NULL DEFAULT '',
  avatar_frame_id   TEXT NOT NULL DEFAULT 'default',
  bio               TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,                       -- unix ms
  last_seen_at      INTEGER NOT NULL DEFAULT 0              -- unix ms (session touch)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users (username);

-- ---------------------------------------------------------------------------
-- user_favorites — up to 4 pinned titles shown in the profile showcase.
-- Enforced as "max 4 rows per user" by application code (PUT /api/user/profile)
-- plus a partial unique index per (user_id, display_order) so two pins can
-- never claim the same slot.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_favorites (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id       TEXT NOT NULL,                             -- TMDB id (or embed id)
  media_type     TEXT NOT NULL DEFAULT 'movie',             -- 'movie' | 'tv' | 'anime'
  media_title    TEXT NOT NULL,
  poster_url     TEXT NOT NULL DEFAULT '',
  display_order  INTEGER NOT NULL DEFAULT 0,                -- 0..3, showcase slot
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, media_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_favorites_slot
  ON user_favorites (user_id, display_order);

CREATE INDEX IF NOT EXISTS idx_user_favorites_order
  ON user_favorites (user_id, display_order);

-- ---------------------------------------------------------------------------
-- watch_history — server-side history (the client keeps a localStorage copy
-- for anonymous visitors). One row per title+episode; `completed` marks
-- finished viewings. `watched_at` is bumped on every rewatch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS watch_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id     TEXT NOT NULL,
  media_type   TEXT NOT NULL DEFAULT 'movie',
  media_title  TEXT NOT NULL,
  poster_url   TEXT NOT NULL DEFAULT '',
  season       INTEGER,
  episode      INTEGER,
  completed    INTEGER NOT NULL DEFAULT 0,                  -- boolean (0/1)
  watched_at   INTEGER NOT NULL,                            -- unix ms
  UNIQUE (user_id, media_id, season, episode)
);

CREATE INDEX IF NOT EXISTS idx_watch_history_recent
  ON watch_history (user_id, watched_at DESC);

-- ---------------------------------------------------------------------------
-- friendships — directed edges. A request inserts (user -> friend, 'pending');
-- accepting flips the requester's edge to 'accepted' and inserts the reverse
-- edge. 'blocked' is stored on the blocker's edge only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friendships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_friend
  ON friendships (friend_id, status);
