// Runtime test: seeks performed on the PLAYER'S OWN seek bar must be
// mirrored to the room for controllers (2026-09-13 regression of UX:
// convergence read a native drag as drift and snapped the user back, so
// only the WatchParty UI seek bar "worked").
//
// Executes the real shipped dist/js/player.js against fake postMessage
// status events and asserts the exact 'control' emissions app.js routes
// to the room ({type:'seek'}).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh module instance + window stub with a message-event registry. */
async function freshPlayer() {
  const listeners = {};
  globalThis.window = {
    WP: {},
    addEventListener: (type, fn) => (listeners[type] || (listeners[type] = [])).push(fn),
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  // node --check-ed bundle is an IIFE over `window`
  const src = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  new Function('window', src)(globalThis.window);
  const Manager = globalThis.window.WP.PlaybackSyncManager;
  assert.ok(Manager, 'player.js must export WP.PlaybackSyncManager');

  const contentWindow = { postMessage() {} };
  const iframe = {
    contentWindow,
    addEventListener() {},
    removeEventListener() {},
  };
  const sync = new Manager(/** @type {any} */ (iframe));

  const fire = (currentTime, playing = true) =>
    (listeners.message || []).forEach((fn) =>
      fn({
        source: contentWindow,
        data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime, playing } },
      })
    );

  return { sync, fire };
}

test('a native seek-bar drag is mirrored to the room as control/seek', async () => {
  const { sync, fire } = await freshPlayer();
  /** @type {any[]} */
  const events = [];
  sync.on('control', (e) => events.push(e));

  sync.isController = true;
  sync._mirroredPlaying = true; // room already knows "playing" (no initial play emission)

  fire(10, true); // baseline
  await tick(60);
  fire(10.1, true); // normal playback — must NOT be treated as a seek
  await tick(60);
  assert.equal(events.filter((e) => e.action === 'seek').length, 0, 'smooth playback is not a seek');

  fire(60, true); // the user dragged the native bar: 10.1 -> 60 is unexplainable by playback
  const seeks = events.filter((e) => e.action === 'seek');
  assert.equal(seeks.length, 1, 'a native drag must emit exactly one control/seek');
  assert.equal(seeks[0].time, 60);
  sync.destroy();
  await tick(5);
});

test('our own convergence seeks are never mirrored back (suppression)', async () => {
  const { sync, fire } = await freshPlayer();
  /** @type {any[]} */
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync.isController = true;
  sync._mirroredPlaying = true;

  fire(10, true); // baseline
  await tick(40);
  sync.seek(120); // the sync engine itself seeks (room state) — sets the suppress window
  fire(120, true); // the status right after our own seek
  assert.equal(events.filter((e) => e.action === 'seek').length, 0, 'own seeks must not echo');
  sync.destroy();
  await tick(5);
});

test('guests (non-controllers) do not mirror native seeks — sync wins', async () => {
  const { sync, fire } = await freshPlayer();
  /** @type {any[]} */
  const events = [];
  sync.on('control', (e) => events.push(e));

  fire(10, true);
  await tick(40);
  fire(90, true); // a guest dragging their bar: drift, re-converged, not broadcast
  assert.equal(events.filter((e) => e.action === 'seek').length, 0, 'guests must not steer the room');
  sync.destroy();
  await tick(5);
});
