// format.js — small pure formatting helpers shared by the worker + tests.

'use strict';

/**
 * Format a playback position in seconds as `H:MM:SS` or `MM:SS`
 * (the presence payload's `current_timestamp`, e.g. "01:14:20").
 * @param {number} seconds
 * @returns {string}
 */
function formatClock(seconds) {
  let s = Math.floor(Number(seconds));
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Compact "time ago" for server-rendered strings (the frontend has its own
 * relative ticker; this is used in API payloads/tests).
 * @param {number} ts unix ms
 * @param {number} [nowMs]
 * @returns {string}
 */
function timeAgo(ts, nowMs) {
  const s = Math.max(0, Math.floor(((nowMs || Date.now()) - (ts || 0)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return Math.floor(d / 7) < 1 ? d + 'd ago' : Math.floor(d / 7) + 'w ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}

export { formatClock, timeAgo };
