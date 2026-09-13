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


test('fresh pause broadcasts converge immediately (no 2.5s throttle delay)', async () => {
  const { sync, fire } = await freshPlayer();
  const posts = [];
  sync.iframe = sync.iframe || {};
  // The harness's contentWindow stub records every command the manager posts.
  const cw = sync.iframe.contentWindow;
  const orig = cw.postMessage;
  cw.postMessage = (data) => posts.push(data && data.command);

  sync._iframeLoaded = true;
  sync.isController = false; // guest: room is authoritative
  fire(100, true); // playing
  await tick(10);

  sync.handleServerMessage({ type: 'pause', playback: { isPlaying: false, time: 100, timestamp: Date.now() } });
  assert.equal(posts[posts.length - 1], 'pause', 'pause applied IMMEDIATELY on the broadcast');

  // Player resumes (status), another pause broadcast arrives right away —
  // the OLD poll path throttled this for 2.5s (the perceived "loop and pause").
  fire(101, true);
  await tick(10);
  sync.handleServerMessage({ type: 'pause', playback: { isPlaying: false, time: 101, timestamp: Date.now() } });
  const pauseCount = posts.filter((c) => c === 'pause').length;
  assert.ok(pauseCount >= 2, 'fresh broadcasts bypass the assert throttle: ' + pauseCount);
  sync.destroy();
  await tick(5);
});

test('AUDIT: the player\'s delayed echo of a remote apply is never mirrored (pause-loop fix)', async () => {
  const { sync, fire } = await freshPlayer();
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync._iframeLoaded = true;
  sync.isController = true;
  sync._mirroredPlaying = false; // the room knows: PAUSED (a remote/granted pause landed)

  sync.handleServerMessage({ type: 'pause', playback: { isPlaying: false, time: 50, timestamp: Date.now() } });
  await tick(20);

  // The player's status events lag: for ~750ms they STILL report playing.
  // (This was the room-wide play/pause loop: the mirror broadcast the echo.)
  fire(52, true);
  await tick(150);
  fire(52.5, true);
  await tick(300);
  fire(53, true);
  await tick(300);
  assert.equal(events.length, 0, 'delayed echo must not broadcast anything: ' + JSON.stringify(events));

  // The echo settles — still nothing broadcast.
  fire(53, false);
  await tick(100);
  assert.equal(events.length, 0);

  // A GENUINE user play after the guard window IS mirrored (time-continuous,
  // so the native-seek detector correctly sees no drag).
  await tick(1600);
  // Wall-clock-consistent resume: ~2s of real time passed while paused, so
  // "now" in player time is ~55 (the engine correctly treats a frozen-time
  // resume after a long wait as a jump otherwise).
  fire(55, true);
  await tick(450);
  fire(55.5, true);
  await tick(450);
  const plays = events.filter((e) => e.action === 'play');
  assert.equal(plays.length, 1, 'a real user play still mirrors: ' + JSON.stringify(events));
  assert.equal(events.filter((e) => e.action === 'seek').length, 0, 'continuous playback is not a seek');
  sync.destroy();
  await tick(5);
});

test('AUDIT: a pause swallowed by a buffering player is re-asserted within ~1s', async () => {
  const { sync, fire } = await freshPlayer();
  const posts = [];
  sync.iframe.contentWindow.postMessage = (d) => posts.push(d && d.command);
  sync._iframeLoaded = true;
  sync.isController = false; // guest: the room is authoritative

  fire(100, true); // playing
  await tick(10);

  sync.handleServerMessage({ type: 'pause', playback: { isPlaying: false, time: 100, timestamp: Date.now() } });
  assert.equal(posts[posts.length - 1], 'pause', 'paused immediately on the broadcast');

  // The player was mid-buffer and "missed" it: the next status still says
  // playing. The OLD code waited for the 2.5s-throttled poll — the video
  // visibly kept running. The fresh window re-asserts right away.
  fire(101, true);
  await tick(10);
  const pauses = posts.filter((c) => c === 'pause').length;
  assert.ok(pauses >= 2, 'pause re-asserted past the throttle: ' + JSON.stringify(posts));
  sync.destroy();
  await tick(5);
});
