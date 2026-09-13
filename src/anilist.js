// anilist.js — TMDB ⇄ AniList helpers for anime playback.
//
// Bingr's anime player only accepts AniList IDs:
//   https://bingr.one/watch/anime/{anilistId}/{episode}
// but our catalog is TMDB-only, so we must (1) decide whether a TMDB TV title
// is anime and (2) map its TMDB ID to an AniList ID. The worker calls the
// free, keyless AniList GraphQL API and scores the candidates against the
// TMDB title here (see src/worker.js).

export const ANIME_KEYWORD_ID = 210024; // TMDB keyword id for "anime"

/** Normalize a title for loose comparison (lowercase, no accents/punctuation). */
export function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide whether a TMDB TV show is anime.
 * `show` is the `/tv/{id}` object; `keywords` is the `/tv/{id}/keywords` object.
 */
export function classifyIsAnime(show, keywords) {
  const kw = (keywords && (keywords.results || keywords.keywords)) || [];
  const kwIds = new Set(kw.map((k) => Number(k && k.id)));
  if (kwIds.has(ANIME_KEYWORD_ID)) return true;

  const genres = ((show && show.genres) || []).map((g) =>
    String(g && (g.name || g.id)).toLowerCase()
  );
  const countries = ((show && show.origin_country) || []).map((c) =>
    String(c).toUpperCase()
  );
  return genres.includes('animation') && countries.includes('JP');
}

/**
 * Pick the AniList entry that best matches a TMDB show.
 * Returns the best media object (with id/episodes/title), or null if nothing
 * is confidently close enough.
 */
export function matchAnilist(show, media) {
  const tmdbTitles = new Set();
  if (show) {
    for (const key of ['name', 'original_name']) {
      const t = normalizeTitle(show[key]);
      if (t) tmdbTitles.add(t);
    }
  }
  const year = show && show.first_air_date
    ? Number(String(show.first_air_date).slice(0, 4))
    : null;

  let best = null;
  let bestScore = -Infinity;
  for (const m of media || []) {
    if (!m || !m.id) continue;
    const titleObj = m.title || {};
    const norm = [titleObj.romaji, titleObj.english, titleObj.native]
      .filter(Boolean)
      .map(normalizeTitle)
      .filter(Boolean);

    let score = 0;
    for (const nt of norm) {
      if (tmdbTitles.has(nt)) {
        score += 100;
        break;
      }
    }
    if (score === 0) {
      outer: for (const t of tmdbTitles) {
        for (const nt of norm) {
          if (t && nt && t.length > 2 && (t.includes(nt) || nt.includes(t))) {
            score += 60;
            break outer;
          }
        }
      }
    }
    // Year matters a lot: a same-year partial match beats an exact-title match
    // from a different year (remakes/reboots share titles, e.g. Fruits Basket).
    const my = m.startDate && m.startDate.year ? Number(m.startDate.year) : null;
    if (year && my) {
      if (my === year) score += 50;
      else if (Math.abs(my - year) <= 1) score += 15;
    }
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return bestScore >= 60 ? best : null;
}
