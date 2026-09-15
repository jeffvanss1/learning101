-- 0003: server-side resume positions for watch history.
-- Every signed-in device remembers the episode AND where playback stopped.
ALTER TABLE watch_history ADD COLUMN position_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watch_history ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0;
