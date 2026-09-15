// BEHAVIORAL: boot()'s deep-link routing, EXECUTED (sliced out of the shipped
// dist/js/app.js with stub dependencies).
//
// Regression: every dedicated surface (room, profile, discovery) had a branch
// in boot() except /history — the nav pushes that URL and routeCurrent()
// restores it on popstate, so a RELOAD (or a shared link) on the history page
// rendered Home while the address bar still said /history.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

function sliceBoot() {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  const start = a.indexOf('function boot() {');
  assert.ok(start > 0, 'boot() present in app.js');
  const end = a.indexOf('if (document.readyState ===', start);
  assert.ok(end > start, 'boot() ends before the readyState bootstrap');
  return a.slice(start, end);
}

/** Run boot() against `pathname` and report which surfaces it opened. */
function runBoot(pathname) {
  const opened = [];
  const track = (name) => (...args) => {
    opened.push([name, ...args]);
  };
  const state = {};
  const WP = {
    Social: {
      ensureSession: async () => ({ ok: true }),
      startIdlePresence() {},
    },
  };
  const window = { dispatchEvent() {} };
  const location = { pathname: pathname, search: '' };
  const fn = new Function(
    'WP',
    'state',
    'location',
    'window',
    'HISTORY_RE',
    'PROFILE_RE',
    'DISCOVERY_RE',
    'setupChrome',
    'savedName',
    'refreshProfileButton',
    'handleDeepLink',
    'showHistoryView',
    'showProfileView',
    'showDiscoveryView',
    'mountHome',
    'runSearch',
    'setActiveNav',
    sliceBoot() + '\nreturn boot;'
  )(
    WP,
    state,
    location,
    window,
    /^\/history\/?$/,
    /^\/user\/([A-Za-z0-9_-]{1,64})\/?$/,
    /^\/discovery\/(movies?|series|anime|trending|top-movies|top-tv|now-playing|airing-today)\/?$/,
    track('setupChrome'),
    () => 'Jeff',
    track('refreshProfileButton'),
    track('handleDeepLink'),
    track('showHistoryView'),
    track('showProfileView'),
    track('showDiscoveryView'),
    track('mountHome'),
    track('runSearch'),
    track('setActiveNav')
  );
  fn();
  return opened;
}

const names = (opened) => opened.map((o) => o[0]);
const call = (opened, name) => opened.filter((o) => o[0] === name)[0] || null;

test('boot() restores /history on a reload (it is a real URL)', () => {
  const opened = runBoot('/history');
  assert.ok(call(opened, 'showHistoryView'), 'history surface shown (got: ' + names(opened).join(', ') + ')');
  assert.equal(call(opened, 'mountHome'), null, 'home must NOT be mounted behind it');
  assert.deepEqual(call(opened, 'setActiveNav'), ['setActiveNav', 'history'], 'the nav highlights History');
});

test('boot() still routes the other dedicated surfaces', () => {
  const room = runBoot('/room/ABC123');
  assert.deepEqual(call(room, 'handleDeepLink'), ['handleDeepLink', 'ABC123'], 'room deep link');

  const profile = runBoot('/user/jeff');
  assert.deepEqual(call(profile, 'showProfileView'), ['showProfileView', 'jeff'], 'profile deep link');

  const discovery = runBoot('/discovery/movies');
  assert.deepEqual(call(discovery, 'showDiscoveryView'), ['showDiscoveryView', 'movies'], 'discovery deep link');

  const home = runBoot('/');
  assert.ok(call(home, 'mountHome'), 'plain / mounts home');
  assert.equal(call(home, 'showHistoryView'), null, 'history not shown on /');
});
