// tmdburl.js — canonical TMDB upstream URL builder.
//
// REGRESSION GUARD: the geo-localization feature appended
// `?language=xx-CC` to the proxied path BEFORE the api_key was appended,
// and the api_key separator was derived from the incoming search string
// only. Parameter-less requests (details: /movie/{id}, /tv/{id}, seasons)
// then produced `.../movie/{id}?language=id-ID?api_key=...` — TMDB read
// the parameter NAME as "?api_key" and answered
// "Invalid API key: You must be granted a valid key" for every detail
// click while feed rows (?page=…) kept working.
//
// This builder parses the incoming query and re-serializes it, so exactly
// one '?' ever reaches the upstream URL and every parameter survives.
//
// Plain JS (project convention) so node --test runs the exact logic the
// worker ships.
//
// @ts-check

/** v4 read tokens look like "ey….ey….sig" (three dot-separated parts, long). */
/** @param {string} apiKey */
export function looksLikeToken(apiKey) {
  return typeof apiKey === 'string' && apiKey.length > 60 && apiKey.split('.').length === 3;
}

/**
 * Build the upstream TMDB URL.
 * @param {string} origin e.g. https://api.themoviedb.org/3
 * @param {string} path   e.g. /movie/123 (no query)
 * @param {string} search incoming query ("", "?page=2", "?a=b&c=d")
 * @param {string} apiKey v3 key (embedded as api_key) or v4 token (omitted here)
 * @param {string} [language] optional TMDB locale ("id-ID")
 * @returns {string}
 */
export function buildTmdbUrl(origin, path, search, apiKey, language) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (apiKey && !looksLikeToken(apiKey)) params.set('api_key', apiKey);
  if (language) params.set('language', language);
  const qs = params.toString();
  return origin + path + (qs ? '?' + qs : '');
}
