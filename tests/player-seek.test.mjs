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
    getAttribute: () => null,
  };
  const sync = new Manager(/** @type {any} */ (iframe));

  const fire = (currentTime, playing = true) =>
    (listeners.message || []).forEach((fn) =>
      fn({
        source: contentWindow,
        data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime, playing } },
      })
    );

  const fireEvent = (event, extra = {}) =>
    (listeners.message || []).forEach((fn) =>
      fn({
        source: contentWindow,
        data: { type: 'PLAYER_EVENT', data: { event, ...extra } },
      })
    );

  return { sync, fire, fireEvent };
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

// HOST AUTHORITY (2026-09-14): the controller's own play/pause/seek must
// adopt the local room snapshot IMMEDIATELY. The old bug: the last snapshot
// still said the opposite, and the next 3s status poll re-asserted the STALE
// state - cancelling the host's click ("I have to hit twice to register").
test('controller actions adopt the local snapshot - no stale re-assert', async () => {
  const { sync, fire } = await freshPlayer();
  const posted = [];
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync.iframe.contentWindow.postMessage = (m) => posted.push(m);
  sync.isController = true;

  // The room says: PLAYING at t=100 (authoritative snapshot arrives).
  sync.applyRemote({ isPlaying: true, time: 100, timestamp: Date.now() });
  assert.equal(sync._lastMsg.isPlaying, true, 'baseline snapshot adopted');

  // Host hits PAUSE. Snapshot must flip IMMEDIATELY (no round-trip wait).
  sync.localPause();
  assert.equal(sync.localPlaying, false, 'local state = paused');
  assert.equal(sync._lastMsg.isPlaying, false, 'snapshot adopted the pause instantly');
  assert.equal(sync._lastMsg.time, sync.localTime, 'snapshot time = local time');
  assert.ok(Date.now() < sync._doNotForceUntil, 'no-force window open while the action settles');
  assert.ok(posted.some((m) => m.command === 'pause'), 'pause went to the player');

  // The status poll fires BEFORE the DO echo arrives (snapshot was adopted,
  // so the sync loop must NOT re-assert the old playing state).
  posted.length = 0;
  fire(100.2, false); // iframe agrees: paused at ~100
  sync._syncToTarget(true);
  assert.ok(!posted.some((m) => m.command === 'play'), 'NO stale play re-assert after a host pause');

  // Host hits PLAY from the paused snapshot - same guarantee.
  sync.localPlay();
  assert.equal(sync._lastMsg.isPlaying, true, 'snapshot adopted the play instantly');
  posted.length = 0;
  fire(100.5, true);
  sync._syncToTarget(true);
  assert.ok(!posted.some((m) => m.command === 'pause'), 'NO stale pause re-assert after a host play');

  // Seek adopts the position (no yank-back to the stale position).
  sync.localSeek(250);
  assert.equal(sync._lastMsg.time, 250, 'snapshot adopted the seek position');

  // RESUME via localPlay(position): seek in + PLAY + adopt + broadcast.
  // (The old resume used RAW seek() - no broadcast, no adopt - so the room
  // stayed paused@0 and convergence yanked the host back forever.)
  events.length = 0;
  posted.length = 0;
  sync.applyRemote({ isPlaying: false, time: 0, timestamp: Date.now() }); // room: paused at the start
  sync.localPlay(600); // "continue watching" from 10:00
  assert.ok(posted.some((m) => m.command === 'seek'), 'seek went to the player');
  assert.ok(posted.some((m) => m.command === 'play'), 'play went to the player');
  assert.ok(events.some((e) => e.action === 'play'), 'play BROADCAST to the room');
  assert.equal(sync._lastMsg.isPlaying, true, 'snapshot adopted playing');
  assert.equal(sync._lastMsg.time, 600, 'snapshot adopted the resume position');
  posted.length = 0;
  fire(600.3, true);
  sync._syncToTarget(true);
  assert.ok(!posted.some((m) => m.command === 'seek'), 'NO yank-back to the room stale position');
  sync.destroy(); // stop the status poller so the test process can exit
});

// Instant UI: the room Play/Pause button flips SYNCHRONOUSLY with the host's
// click (it used to wait for the iframe status poll, reading as "not registered").
test('room play/pause button flips instantly on host click', async () => {
  const app = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(app, /function onTogglePlay\(\) \{\s*if \(!canControl\(\)[\s\S]*?localPause\(state\.sync\.localTime\);\s*updatePlayerControls\(false\);/, 'pause click flips the button immediately');
  assert.match(app, /localPlay\(state\.sync\.localTime\);\s*updatePlayerControls\(true\);/, 'play click flips the button immediately');
});

test('derived end: paused-at-end after playing fires ended ONCE (no explicit event needed)', async () => {
  const { sync, fire } = await freshPlayer();
  const ended = [];
  sync.on('ended', (e) => ended.push(e));
  sync.duration = 120; // duration learned from the embed
  fire(118, true); // playing -> _hasPlayed = true
  fire(120, false); // paused AT the end; the embed NEVER sent an 'ended' event
  fire(120, false); // the confirm: the clock did not move (a pause claim that
  //                   follows a >0.35s gap is only believed once the embed
  //                   answers our immediate getStatus with the same position)
  assert.equal(ended.length, 1, 'derived ended fired exactly once');
  fire(120, false); // later polls (paused at the end) must not re-fire
  fire(119.8, false);
  await tick(3100);
  assert.equal(ended.length, 1, 'no duplicates on subsequent polls');
  // a mid-video pause must NOT count as the end:
  const sync2 = await freshPlayer();
  const ended2 = [];
  sync2.sync.on('ended', (e) => ended2.push(e));
  sync2.sync.duration = 120;
  sync2.fire(30, true);
  sync2.fire(30, false); // user paused at 0:30
  assert.equal(ended2.length, 0, 'mid-video pause is not an end');
  sync.destroy();
  sync2.sync.destroy();
});

// ---------------------------------------------------------------------------
// Phantom-pause regression (user report: resume -> "paused" banner while the
// player kept playing; room flapped pause/play on buffering blips).
// ---------------------------------------------------------------------------

/** Boot a controller whose room state says PAUSED at 0 (joined a fresh room). */
async function freshController() {
  const { sync, fire, fireEvent } = await freshPlayer();
  sync.isController = true;
  sync._iframeLoaded = true;
  sync.applyRemote({ isPlaying: false, time: 0, timestamp: Date.now() - 60000 });
  await tick(10);
  return { sync, fire, fireEvent };
}

test('phantom pause #1: boot lag after resume NEVER broadcasts a pause', async () => {
  const { sync, fire } = await freshController();
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync.localPlay(1200); // resume command (seek+play+adopt+broadcast)
  await tick(1300); // command-suppression window expires
  // The embed is still buffering the seek: statuses report PAUSED at the
  // resume position. The old mirror turned ONE such status into a pause
  // broadcast ("paused" banner) while the player then started (sound on).
  fire(1200, false);
  await tick(500);
  fire(1200, false);
  await tick(500);
  fire(1200, false);
  await tick(500);
  assert.equal(events.filter((e) => e.action === 'pause').length, 0, 'boot lag must not pause the room');
  // The embed finally starts: the latch clears; the room already knows
  // playing (our own resume broadcast) — no flap either way.
  fire(1210, true);
  await tick(500);
  assert.equal(events.filter((e) => e.action === 'pause').length, 0, 'still no pause after start');
  sync.destroy();
});

test('phantom pause #2: a single stalled status cannot pause the room (needs 2 observations)', async () => {
  const { sync, fire } = await freshController();
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync.localPlay(300);
  fire(300, true); // start confirmed -> latch off
  await tick(1200);
  fire(305, true); // playing baseline (mirror baseline = playing)
  await tick(1200);
  assert.equal(events.filter((e) => e.action === 'pause').length, 0, 'quiet playback (the resume play broadcast is expected)');
  fire(305, false); // ONE stalled/lagged status — must stay silent
  await tick(600);
  assert.equal(events.filter((e) => e.action === 'pause').length, 0, 'one observation is not a pause');
  fire(305, false); // second observation + age: a REAL user pause lands
  await tick(700);
  const pauses = events.filter((e) => e.action === 'pause');
  assert.equal(pauses.length, 1, 'a persistent pause is mirrored exactly once');
  sync.destroy();
});

test('phantom pause #3: buffering events block the pause mirror', async () => {
  const { sync, fire, fireEvent } = await freshController();
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync.localPlay(300);
  fire(300, true);
  await tick(1200);
  fireEvent('buffering');
  fire(300, false); // stall reads as paused
  fireEvent('waiting'); // real players re-emit stall events while stuck
  fire(300, false);
  await tick(800);
  fireEvent('stalled');
  fire(300, false);
  await tick(800);
  assert.equal(events.filter((e) => e.action === 'pause').length, 0, 'a stall is not a user pause');
  fire(310, true); // recovered
  await tick(500);
  assert.equal(events.filter((e) => e.action === 'pause').length, 0);
  sync.destroy();
});

test('new-load hygiene: stale baseline reset - a new title never mirrors a bogus seek', async () => {
  const { sync, fire } = await freshPlayer();
  sync.isController = true;
  sync._iframeLoaded = true;
  sync._mirroredPlaying = true;
  sync._lastStatus = { time: 5000, at: Date.now() - 3000 }; // stale from the PREVIOUS title
  sync.loadVideo({ src: 'https://bingr.one/watch/movie/99', id: 'm99', type: 'movie', title: 'x' });
  assert.equal(sync._lastStatus.time, -1, 'native-seek baseline reset on load');
  assert.equal(sync._awaitingStart, false, 'latch reset on load');
  const events = [];
  sync.on('control', (e) => events.push(e));
  sync._iframeLoaded = true; // pretend the new document finished loading
  fire(0, false); // first status of the new title
  await tick(100);
  assert.equal(events.length, 0, 'stale state must not emit bogus controls');
  sync.destroy();
});

// ---------------------------------------------------------------------------
// HOST SOVEREIGNTY (user directive): the host's player is never sought/paused
// by room echoes, snapshots or polls. Only an explicit play/pause/seek from
// ANOTHER user with control permission complies. Fresh loads still follow.
// ---------------------------------------------------------------------------

test('sovereign host: nameless snapshots/echoes NEVER pause or seek a playing host', async () => {
  const { sync, fire } = await freshPlayer();
  const events = [];
  sync.on('control', (e) => events.push(e));
  try {
    sync.isController = true;
    sync._iframeLoaded = true;
    sync.applyRemote({ isPlaying: true, time: 100, timestamp: Date.now() - 5000 });
    await tick(10);
    fire(100, true); // start confirmed -> _hasPlayed = true (sovereign from here)
    await tick(1300);
    sync.applyRemote({ isPlaying: false, time: 500, timestamp: Date.now() });
    await tick(2200);
    assert.equal(sync.localPlaying, true, 'host stays playing');
    assert.ok(sync.localTime < 200, 'host was not seeked');
    assert.equal(events.filter((e) => e.action === 'pause').length, 0, 'no pause compliance');
  } finally {
    sync.destroy();
  }
});

test('sovereign host: own echo (by === selfName) is ignored', async () => {
  const { sync, fire } = await freshPlayer();
  try {
    sync.isController = true;
    sync.selfName = 'Jeff';
    sync._iframeLoaded = true;
    sync.applyRemote({ isPlaying: true, time: 100, timestamp: Date.now() - 5000 });
    await tick(10);
    fire(100, true);
    await tick(1300);
    sync.handleServerMessage({ type: 'pause', by: 'Jeff', playback: { isPlaying: false, time: 100, timestamp: Date.now() } });
    await tick(2200);
    assert.equal(sync.localPlaying, true, 'own echo must not pause the host');
  } finally {
    sync.destroy();
  }
});

test('another controller (by !== selfName) COMPLIES: pause + seek land immediately', async () => {
  const { sync, fire } = await freshPlayer();
  try {
    sync.isController = true;
    sync.selfName = 'Jeff';
    sync._iframeLoaded = true;
    sync.applyRemote({ isPlaying: true, time: 100, timestamp: Date.now() - 5000 });
    await tick(10);
    fire(100, true);
    await tick(1300);
    sync.handleServerMessage({ type: 'seek', by: 'Guest2', time: 777, playback: { isPlaying: true, time: 777, timestamp: Date.now() } });
    await tick(60);
    assert.ok(sync.localTime > 700, 'external seek complied');
    sync.handleServerMessage({ type: 'pause', by: 'Guest2', playback: { isPlaying: false, time: 777, timestamp: Date.now() } });
    await tick(60);
    assert.equal(sync.localPlaying, false, 'external pause complied immediately (war guard skipped for external commands)');
  } finally {
    sync.destroy();
  }
});
