// Contracts for the two 2026-09-13 features:
//
// 1. Discovery pages — every library entry in the side nav owns a
//    /discovery/:key route rendered by WP.Catalog.mountDiscovery with
//    infinite scroll (the /api/tmdb proxy already passes `page` through).
// 2. Friends drawer — the panel is a GLOBAL slide-over (right → left),
//    opened from the side nav on any surface. Its markup must live at body
//    level (outside every view); the old desktop "sticky column" mode
//    (.home--with-rail) is gone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readIndex, ancestorsOf, hasAncestorClass, sidenavKeys, cssBlock, ROOT } from './dompath.mjs';

const html = readIndex();
const appJs = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
const catalogJs = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
const socialJs = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
const socialCss = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');

// Side-nav items that navigate to their own /discovery/:key page.
const ROUTE_KEYS = ['movies', 'series', 'anime', 'trending', 'top-movies', 'top-tv', 'now-playing', 'airing-today'];

test('#discovery surface lives inside .app-shell__main (scroll-surface contract)', () => {
  assert.ok(hasAncestorClass(html, 'discovery', 'app-shell'), '#discovery must be inside .app-shell');
  assert.ok(
    hasAncestorClass(html, 'discovery', 'app-shell__main'),
    '#discovery must be a flex child of .app-shell__main, like #home/#profile/#room'
  );
});

test('every library side-nav item has a matching /discovery route', () => {
  const navKeys = sidenavKeys(html);
  for (const key of ROUTE_KEYS) {
    assert.ok(navKeys.includes(key), `side nav is missing data-nav="${key}"`);
    const re = appJs.match(/const DISCOVERY_RE = (\/[^;]+;)/);
    assert.notEqual(re, null, 'DISCOVERY_RE missing from app.js');
    assert.ok(re[1].includes(key), `DISCOVERY_RE does not cover /discovery/${key}`);
  }
});

test('catalog.js maps every discovery route to a feed and exports mountDiscovery', () => {
  const exportBlock = catalogJs.slice(catalogJs.indexOf('global.WP.Catalog = {'));
  assert.ok(exportBlock.includes('mountDiscovery'), 'global.WP.Catalog must export mountDiscovery');
  const mapStart = catalogJs.indexOf('const DISCOVERY_ROUTES = {');
  assert.notEqual(mapStart, -1, 'DISCOVERY_ROUTES map missing from catalog.js');
  const mapBlock = catalogJs.slice(mapStart, catalogJs.indexOf('};', mapStart));
  for (const key of ROUTE_KEYS) {
    assert.ok(
      new RegExp('(^|[\\s{,\'\"])' + key + '[\'\"]?\\s*:').test(mapBlock),
      `catalog.js DISCOVERY_ROUTES is missing the '${key}' route key`
    );
  }
  assert.ok(/(^|[\s{,])movie:/.test(mapBlock), "catalog.js must accept 'movie' as an alias of 'movies'");
});

test('friends drawer markup is body-level (overlays every surface)', () => {
  for (const id of ['friends-rail', 'friends-backdrop']) {
    const chain = ancestorsOf(html, id);
    assert.notEqual(chain, null, `#${id} missing from index.html`);
    assert.equal(chain.length, 0, `#${id} must be a body-level element, not inside a view (chain: ${chain.map((c) => c.cls.join('.') || c.tag).join(' > ')})`);
  }
  assert.ok(!hasAncestorClass(html, 'friends-rail', 'home'), '#friends-rail must not live inside #home');
});

test('the drawer is the only friends-panel mode (no desktop sticky column left)', () => {
  assert.ok(!socialCss.includes('home--with-rail'), '.home--with-rail grid mode must be fully removed from CSS');
  assert.ok(!socialJs.includes('home--with-rail'), '.home--with-rail toggling must be fully removed from JS');
  const rail = cssBlock(socialCss, '.friends-rail {');
  assert.notEqual(rail, null, '.friends-rail rule missing');
  assert.ok(rail.includes('transform: translateX(105%)'), 'drawer must stay off-canvas until .is-open');
  assert.ok(rail.includes('position: fixed'), 'drawer must be a fixed overlay');
});

test('the rail polls on every surface (visibility no longer gated on #home)', () => {
  assert.ok(!socialJs.includes("$('home').hidden") || !/railIsVisible[\s\S]{0,200}\$\('home'\)/.test(socialJs),
    'railIsVisible must not gate on #home visibility — the drawer works everywhere now');
});

test('.discovery stays a self-contained scroll surface', () => {
  const block = cssBlock(socialCss, '.discovery {');
  assert.notEqual(block, null, '.discovery rule missing from social.css');
  for (const decl of ['flex: 1', 'min-height: 0', 'overflow-y: auto']) {
    assert.ok(block.includes(decl), `.discovery must declare ${decl} (scroll surface contract)`);
  }
});

test('no stale ROW_DEFS references (the empty-home bug)', () => {
  // The 2026-09-13 hoist renamed ROW_DEFS -> FEED_DEFS but a live reference
  // survived inside mountBrowse's resetSections(); the home feed then died
  // with a ReferenceError at runtime. FEED_DEFS is the only feed list.
  assert.ok(!/\bROW_DEFS\b/.test(catalogJs), 'catalog.js must not reference ROW_DEFS anymore');
  assert.ok(catalogJs.includes('const FEED_DEFS = ['), 'FEED_DEFS must exist at module scope');
});

test('the global drawer is mounted ONCE at boot (the dead-Friends-button bug)', () => {
  // When the drawer went global, its only mount call (inside mountHome) was
  // removed and never replaced — toggleFriendsRail() no-op'd forever.
  const bootMount = appJs.includes("WP.Social.mountFriendsRail($('friends-rail'))");
  assert.ok(bootMount, "app.js boot must mount the drawer: WP.Social.mountFriendsRail($('friends-rail'))");
  assert.ok(!/mountHome[\s\S]{0,400}mountFriendsRail/.test(appJs), 'the mount must live at boot level, not inside mountHome');
});

test('discovery + drawer wiring: routing, lifecycle and entry points exist', () => {
  assert.ok(appJs.includes('showDiscoveryView'), 'app.js must define showDiscoveryView');
  assert.ok(appJs.includes('teardownDiscoveryView'), 'app.js must define teardownDiscoveryView');
  assert.ok(appJs.includes('wireSearchFallback'), 'app.js must keep search bars working on non-browse surfaces');
  assert.ok(/friends'\)\) \{\s*\n\s*\/\/ Friends drawer[\s\S]*?toggleFriendsRail\(\)/.test(appJs) ||
    appJs.includes('WP.Social.toggleFriendsRail()'), "the side nav 'friends' item must toggle the global drawer");
  assert.ok(socialJs.includes("global.WP.build = '"), 'social.js must stamp its UI build');
});
