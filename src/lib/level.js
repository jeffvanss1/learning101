// level.js — deterministic level + badge derivation for profiles.
//
// Levels come from how much a user has watched; badges are awarded from
// simple stats. Pure functions so they are trivially testable.

'use strict';

/**
 * Level curve: level 1 at 0+ watches, each level costs 4 more than the last
 * (0, 4, 12, 24, 40, ...). Cheap, monotonic, never regresses.
 * @param {number} watchCount
 * @returns {{ level: number, into: number, span: number }}
 */
function levelFor(watchCount) {
  let n = Math.max(0, Math.floor(Number(watchCount) || 0));
  let level = 1;
  let span = 4;
  while (n >= span) {
    n -= span;
    level += 1;
    span += 4;
  }
  return { level, into: n, span };
}

/**
 * Level titles, Steam-style.
 * @param {number} level
 * @returns {string}
 */
function levelTitle(level) {
  if (level >= 25) return 'Legendary Cinephile';
  if (level >= 15) return 'Curator';
  if (level >= 10) return 'Binge Master';
  if (level >= 6) return 'Couch Regular';
  if (level >= 3) return 'Watcher';
  return 'Newcomer';
}

/**
 * Award badges from raw stats.
 * @param {{ watchCount: number, friendCount: number, favoritesCount: number, isHosting?: boolean }} stats
 * @returns {Array<{ id: string, label: string, icon: string }>}
 */
function badgesFor(stats) {
  const badges = [];
  const wc = Math.max(0, Math.floor(Number(stats && stats.watchCount) || 0));
  const fc = Math.max(0, Math.floor(Number(stats && stats.friendCount) || 0));
  const fav = Math.max(0, Math.floor(Number(stats && stats.favoritesCount) || 0));

  if (wc >= 1) badges.push({ id: 'first-watch', label: 'First Watch', icon: '🎬' });
  if (wc >= 10) badges.push({ id: 'binge-10', label: 'Binge Watcher', icon: '🍿' });
  if (wc >= 50) badges.push({ id: 'binge-50', label: 'Marathoner', icon: '🏅' });
  if (fc >= 1) badges.push({ id: 'social', label: 'Social Butterfly', icon: '🤝' });
  if (fc >= 5) badges.push({ id: 'crew', label: 'The Crew', icon: '👥' });
  if (fav >= 4) badges.push({ id: 'curator', label: 'Showcase Curator', icon: '🖼️' });
  if (stats && stats.isHosting) badges.push({ id: 'host', label: 'Party Host', icon: '🎉' });
  return badges;
}

export { levelFor, levelTitle, badgesFor };
