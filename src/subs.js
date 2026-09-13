// subs.js — subtitle pipeline for the Cloudflare edge (OpenSubtitles v3 API).
//
// The room player (Bingr embed) reports its playback clock via postMessage,
// so the frontend renders its OWN subtitle overlay in perfect sync (with a
// user-adjustable offset). This module is the worker-side half:
//
//   GET /api/subs/search?type=movie|tv&tmdb=<id>&season=&episode=&lang=<code>
//     -> OpenSubtitles search by TMDB id (+ season/episode for series),
//        shaped into compact candidates ranked for auto-pick.
//
//   GET /api/subs/file?fileId=<id>
//     -> download endpoint -> subtitle file -> converted to WebVTT.
//        VTT text is cached in KV (`subs:vtt:<fileId>`, 7 days) so the API's
//        tight daily download quota is amortized across ALL users/rooms —
//        one download per subtitle ever, per isolate-cold-start at worst.
//
// Plain JS (like geo.js / anilist.js) so node --test runs the exact logic.
//
// @ts-check

export const SUBS_KV_PREFIX = 'subs:vtt:';
export const SUBS_KV_TTL_S = 7 * 24 * 60 * 60; // subtitles never change

const OPENSUBTITLES_ORIGIN = 'https://api.opensubtitles.com';
const DOWNLOAD_TIMEOUT_MS = 12_000;

/**
 * Build the OpenSubtitles search query string for a video.
 * @param {{ type: string, tmdb: string, season?: number | null, episode?: number | null, lang?: string }} v
 * @returns {string} query string (no leading '?')
 */
export function buildSearchQuery(v) {
  const params = new URLSearchParams();
  // OpenSubtitles (July 2025 API change, confirmed by their admin): queries
  // without an explicit `type` return ZERO results. movie -> 'movie',
  // series/anime -> 'episode'.
  params.set('type', v.type === 'movie' ? 'movie' : 'episode');
  if (v.type === 'movie') {
    // Movies: the movie's own TMDB id.
    params.set('tmdb_id', String(v.tmdb));
  } else {
    // Series/anime (docs): the SHOW's TMDB id goes in parent_tmdb_id,
    // together with season_number + episode_number. tmdb_id + season/
    // episode is an invalid combination and returns wrong/empty results.
    params.set('parent_tmdb_id', String(v.tmdb));
    if (v.season != null) params.set('season_number', String(v.season));
    if (v.episode != null) params.set('episode_number', String(v.episode));
  }
  if (v.lang) params.set('languages', v.lang);
  return params.toString();
}

/**
 * Parse "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT) into seconds.
 * @param {string} s
 * @returns {number | null}
 */
export function parseTimestamp(s) {
  const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
  );
}

/** @param {number} s @returns {string} VTT timestamp "HH:MM:SS.mmm" */
export function formatVttTimestamp(s) {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  /** @param {number} n @param {number} w */
  const pad = (n, w) => String(n).padStart(w, '0');
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(sec, 2) + '.' + pad(milli, 3);
}

/**
 * Convert subtitle text to WebVTT. Accepts SRT (the overwhelmingly common
 * case) and passes VTT through (normalized). Anything else (ASS/SSA/VobSub…)
 * returns null — callers move on to the next candidate.
 * @param {string} text
 * @returns {string | null}
 */
export function toVtt(text) {
  if (!text) return null;
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (/^WEBVTT/.test(trimmed)) return trimmed;

  const isSrt = /^\d+\s*\r?\n\d{1,2}:\d{2}:\d{2},\d{1,3}\s+-->/m.test(trimmed);
  if (!isSrt) return null;

  const out = ['WEBVTT', ''];
  // SRT block: index line (optional once indexed), timing line, text lines.
  const blocks = trimmed.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== '' || true);
    while (lines.length && lines[0].trim() === '') lines.shift();
    if (!lines.length) continue;
    if (/^\d+$/.test(lines[0].trim())) lines.shift(); // SRT index
    const timing = lines.shift();
    if (!timing) continue;
    const tm = /^\s*(\S+)\s+-->\s+(\S+)(.*)$/.exec(timing);
    if (!tm) continue;
    const start = parseTimestamp(tm[1]);
    const end = parseTimestamp(tm[2]);
    if (start == null || end == null || end <= start) continue;
    // Text: strip basic markup tags, keep line breaks.
    const body = lines
      .join('\n')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '') // ASS-style override blocks
      .trim();
    if (!body) continue;
    out.push(formatVttTimestamp(start) + ' --> ' + formatVttTimestamp(end));
    out.push(body);
    out.push('');
  }
  // A usable VTT has at least one cue.
  return out.length > 3 ? out.join('\n') : null;
}

/**
 * Rank OpenSubtitles search results for auto-pick. Preference order:
 *   1. not "foreign parts only" (those only subtitle the non- dialog),
 *   2. machine-translated ones last,
 *   3. more downloads (popular, usually the matching release),
 *   4. fps 23.976/24 preferred (the embed's usual frame rates).
 * @param {any[]} results raw `data` array from /api/v1/subtitles
 * @returns {{ fileId: number, release: string, lang: string, downloads: number, fps: number | null, machineTranslated: boolean, foreignPartsOnly: boolean } | null}
 */
export function pickBest(results) {
  const shaped = [];
  for (const r of Array.isArray(results) ? results : []) {
    const file = r && r.files && Array.isArray(r.files) ? r.files[0] : null;
    if (!file || file.file_id == null) continue;
    const attrs = r.attributes || {};
    const feature = attrs.feature_details || {};
    shaped.push({
      fileId: Number(file.file_id),
      release: String((attrs.release_dates && attrs.release_dates[0] && attrs.release_dates[0].release) || attrs.title || ''),
      lang: String((attrs.language || '').slice(0, 3)),
      downloads: Number(attrs.download_count || 0),
      fps: feature.frame_rate ? Number(feature.frame_rate) : null,
      machineTranslated: !!attrs.ai_translated,
      foreignPartsOnly: !!attrs.foreign_parts_only,
      _rank:
        (attrs.foreign_parts_only ? 4_000_000_000 : 0) +
        (attrs.ai_translated ? 2_000_000_000 : 0) +
        (feature.frame_rate && feature.frame_rate >= 23 && feature.frame_rate <= 24 ? 0 : 500_000_000) -
        Number(attrs.download_count || 0),
    });
  }
  if (!shaped.length) return null;
  shaped.sort((a, b) => a._rank - b._rank);
  const best = shaped[0];
  return {
    fileId: best.fileId,
    release: best.release,
    lang: best.lang,
    downloads: best.downloads,
    fps: best.fps,
    machineTranslated: best.machineTranslated,
    foreignPartsOnly: best.foreignPartsOnly,
  };
}

/**
 * Shape the raw search response into the compact candidate list the panel shows.
 * @param {any} payload
 * @returns {any[]}
 */
export function shapeSearchResponse(payload) {
  const list = Array.isArray(payload && payload.data) ? payload.data : [];
  const out = [];
  for (const r of list) {
    const file = r && r.files && Array.isArray(r.files) ? r.files[0] : null;
    if (!file || file.file_id == null) continue;
    const attrs = r.attributes || {};
    out.push({
      fileId: Number(file.file_id),
      release: String(
        (attrs.release_dates && attrs.release_dates[0] && attrs.release_dates[0].release) ||
          attrs.title ||
          ''
      ).slice(0, 80),
      lang: String((attrs.language || '').slice(0, 3)),
      downloads: Number(attrs.download_count || 0),
      fps: (attrs.feature_details && attrs.feature_details.frame_rate) || null,
      machineTranslated: !!attrs.ai_translated,
      foreignPartsOnly: !!attrs.foreign_parts_only,
    });
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * Fetch the subtitle file for `fileId` and return WebVTT text. Worker-only
 * (needs the API key + KV); kept here so the route handler stays thin.
 * @param {number | string} fileId
 * @param {string} apiKey
 * @param {{ get(key: string): Promise<string | null>, put(key: string, value: string, opts?: any): Promise<void> } | null} kv
 * @returns {Promise<{ vtt: string, cached: boolean }>}
 */
export async function fetchSubtitleVtt(fileId, apiKey, kv) {
  const cacheKey = SUBS_KV_PREFIX + String(fileId);
  if (kv) {
    try {
      const hit = await kv.get(cacheKey);
      if (hit) return { vtt: hit, cached: true };
    } catch (_) {}
  }

  const headers = {
    'Api-Key': apiKey,
    Accept: 'application/json',
    'User-Agent': 'WatchParty v1.0.0',
  };
  const dlRes = await fetch(OPENSUBTITLES_ORIGIN + '/api/v1/download?file_id=' + encodeURIComponent(String(fileId)), {
    headers,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!dlRes.ok) {
    // Free tier download quota is tiny (~10/day) — say so plainly when it
    // bites (406 DownloadLimitExceeded / 429 throttled). KV-cached subs
    // keep working regardless.
    if (dlRes.status === 406 || dlRes.status === 429) {
      throw new Error(
        'OpenSubtitles daily download limit reached — resets daily. Already-cached subtitles keep working.'
      );
    }
    throw new Error('OpenSubtitles download ' + dlRes.status);
  }
  const dl = /** @type {any} */ (await dlRes.json());
  if (!dl || !dl.link) throw new Error('OpenSubtitles download returned no link');

  const fileRes = await fetch(dl.link, {
    headers: { Accept: '*/*', 'User-Agent': 'WatchParty v1.0.0' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!fileRes.ok) throw new Error('subtitle file fetch ' + fileRes.status);
  const vtt = toVtt(await fileRes.text());
  if (!vtt) throw new Error('unsupported subtitle format (need SRT/VTT)');

  if (kv) {
    try {
      await kv.put(cacheKey, vtt, { expirationTtl: SUBS_KV_TTL_S });
    } catch (_) {}
  }
  return { vtt: vtt, cached: false };
}
