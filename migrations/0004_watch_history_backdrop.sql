-- 0004: landscape artwork (TMDB backdrop) for history cards.
ALTER TABLE watch_history ADD COLUMN backdrop_url TEXT NOT NULL DEFAULT '';
