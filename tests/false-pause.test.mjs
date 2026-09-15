// FALSE PAUSE AT ROOM START (reported bug: "false pause at first start a room
// but the video still play and give like pause banner appear").
//
// What happened: right after a room starts, the embed reports `playing: false`
// while the video is actually running (its clock keeps advancing — boot lag /
// a flapping status). The client BELIEVED the flag, so:
//   * the play/pause control + progress state flipped to "paused" while the
//     video played on,
//   * the mirror broadcast a PAUSE to the room, which the Durable Object wrote
//     into the chat as "⏸️ Host paused the movie" (the "pause banner"), and
//   * a lagging "paused" status could even be read as the END of an episode
//     (position within 2.5s of the duration).
//
// The contract now: THE CLOCK DECIDES, NEVER THE FLAG ALONE. A pause is only
// believed when the reported position is frozen and we are past the boot window
// of our own play command. This file executes the SHIPPED player.js against
// fake iframe messages (same harness style as tests/player-seek.test.mjs) and
// the SHIPPED Durable Object for the chat-banner half.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { ROOT } from './dompath.mjs';

register(new URL('./tsresolve.mjs', import.meta.url));

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh shipped player.js against a fake iframe (status + event injection). */
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
  new Function('window', readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8'))(globalThis.window);
  const Manager = globalThis.window.WP.PlaybackSyncManager;
  assert.ok(Manager, 'player.js exports WP.PlaybackSyncManager');

  const posted = [];
  const contentWindow = { postMessage: (m) => posted.push(typeof m === 'string' ? JSON.parse(m) : m) };
  const iframe = { contentWindow, addEventListener() {}, removeEventListener() {}, getAttribute: () => null, src: null };
  const sync = new Manager(/** @type {any} */ (iframe));

  const status = (currentTime, playing, duration) =>
    (listeners.message || []).forEach((fn) =>
      fn({
        source: contentWindow,
        data: {
          type: 'PLAYER_EVENT',
          data: {
            event: 'playerstatus',
            currentTime,
            playing,
            ...(duration === undefined ? {} : { duration }),
          },
        },
      })
    );
  const event = (name, extra = {}) =>
    (listeners.message || []).forEach((fn) =>
      fn({ source: contentWindow, data: { type: 'PLAYER_EVENT', data: { event: name, ...extra } } })
    );

  /** The room handed us a fresh video that should play from 0 (room start). */
  const startRoom = () => {
    sync.isController = true;
    sync.selfName = 'Host';
    sync.loadVideo({ id: 1, src: 'https://bingr.one/watch/movie/1' });
    sync._iframeLoaded = true;
    sync.applyRemote({ isPlaying: true, time: 0, timestamp: Date.now() });
  };

  const controls = [];
  sync.on('control', (e) => controls.push(e));
  const progress = [];
  sync.on('progress', (p) => progress.push(p));
  const ended = [];
  sync.on('ended', (e) => ended.push(e));
  return { sync, status, event, posted, controls, progress, ended, startRoom };
}

test('a "paused" status whose clock keeps advancing is NEVER a pause (no banner, UI stays playing)', async () => {
  const { sync, status, controls, posted, startRoom } = await freshPlayer();
  startRoom();

  status(0.3, false); // boot lag
  await tick(120);
  status(1.1, true); // the embed finally confirms playback
  await tick(1200);

  // ...now it flaps: "paused" while the position keeps moving (video is playing)
  status(2.4, false);
  await tick(320);
  status(3.5, false);
  await tick(320);
  status(4.4, false);
  await tick(900);

  assert.deepEqual(
    controls.filter((c) => c.action === 'pause'),
    [],
    'no PAUSE may be broadcast to the room from a moving clock'
  );
  assert.equal(sync.localPlaying, true, 'the UI keeps showing playback');
  assert.ok(
    !posted.some((p) => p.command === 'pause'),
    'the player is never told to pause by a lagging status'
  );
  sync.destroy();
  await tick(5);
});

test('a "paused" event during the boot window is not a pause either', async () => {
  const { sync, event, controls, progress, startRoom } = await freshPlayer();
  startRoom();

  event('paused'); // the embed announces paused while it is still buffering
  await tick(60);

  assert.equal(sync.localPlaying, true, 'boot lag never paints a paused state');
  assert.ok(!progress.some((p) => p.playing === false), 'no paused progress while booting');
  assert.deepEqual(controls.filter((c) => c.action === 'pause'), [], 'nothing broadcast');
  assert.equal(sync._awaitingStart, true, 'the start latch survives a lagging report');
  sync.destroy();
  await tick(5);
});

test('the startup latch is NOT released by a healed pause (no play/pause war)', async () => {
  const { sync, status, posted, controls, startRoom } = await freshPlayer();
  startRoom();

  // the embed never confirms play and keeps reporting "paused" while the clock
  // advances — the classic first-start boot lag
  for (let i = 0; i < 6; i++) {
    await tick(300);
    status(i * 0.6, false);
  }
  await tick(200);

  assert.equal(sync.localPlaying, true, 'still playing');
  assert.equal(
    posted.filter((p) => p.command === 'play').length,
    1,
    'play is commanded ONCE — a healed pause must not re-open the re-assert loop'
  );
  assert.deepEqual(controls.filter((c) => c.action === 'pause'), [], 'no false pause broadcast');
  sync.destroy();
  await tick(5);
});

test('a GENUINE pause (frozen clock) still lands: UI paused + control/pause broadcast', async () => {
  const { sync, status, controls, startRoom } = await freshPlayer();
  startRoom();
  status(20.0, true);
  await tick(1400); // past the suppression window

  status(20.0, false); // the user pressed pause: the clock does NOT move
  await tick(200);
  status(20.0, false); // second observation
  await tick(700);
  status(20.0, false);
  await tick(400);

  assert.equal(sync.localPlaying, false, 'a real pause is believed');
  const pauses = controls.filter((c) => c.action === 'pause');
  assert.equal(pauses.length, 1, 'exactly one control/pause for the room (no spam)');
  sync.destroy();
  await tick(5);
});

test('a lagging "paused" status near the end never fakes an episode end', async () => {
  const { sync, status, ended, startRoom } = await freshPlayer();
  startRoom();
  status(10, true, 1200); // duration known BEFORE the lag, so the gate is real
  await tick(100);
  status(10, true, 1200);
  await tick(1400);

  // "paused" at duration-1 while the clock is moving = the video is still playing
  status(1199, false, 1200);
  await tick(300);
  status(1199.8, false, 1200);
  await tick(300);

  assert.deepEqual(ended, [], 'a moving clock near the end is not the end of the episode');

  // ...the same position ONCE the clock has frozen IS the end (no explicit
  // 'ended' event is needed): the guard may not swallow real endings.
  status(1199.8, false, 1200);
  await tick(120);
  assert.equal(ended.length, 1, 'the confirmed pause at the end is the derived end');
  sync.destroy();
  await tick(5);
});

test('a genuine pause after a poll gap waits for the clock to freeze, then lands', async () => {
  const { sync, status, controls, posted, startRoom } = await freshPlayer();
  startRoom();
  status(40, true, 1200);
  await tick(1400); // past the command-suppression window

  // The user paused 1.5s after the last report: the position moved, so this
  // ONE report cannot prove a pause. It must not be painted, and the client
  // asks the embed to confirm right away instead of waiting for the 3s poll.
  status(41.5, false, 1200);
  await tick(120);
  assert.equal(sync.localPlaying, true, 'one report is not a pause');
  assert.ok(
    posted.some((p) => p.command === 'getStatus'),
    'the confirmation request goes out immediately'
  );

  status(41.5, false, 1200); // the embed confirms: the clock did NOT move
  await tick(120);
  assert.equal(sync.localPlaying, false, 'the confirmed pause lands');
  assert.deepEqual(
    controls.filter((c) => c.action === 'pause'),
    [],
    'the room is not told off ONE report (the pause mirror needs 2)'
  );

  status(41.5, false, 1200); // second observation -> the room is told once
  await tick(700); // min-age window + the scheduled re-check
  assert.equal(controls.filter((c) => c.action === 'pause').length, 1, 'exactly one pause broadcast');
  sync.destroy();
  await tick(5);
});

test('a boot-window clock jump is not mirrored as a native seek', async () => {
  const { sync, status, controls, startRoom } = await freshPlayer();
  startRoom();

  status(0.2, false);
  await tick(80);
  status(9.6, false); // the player absorbed our play/seek command: a boot jump
  await tick(120);

  assert.deepEqual(controls.filter((c) => c.action === 'seek'), [], 'boot jumps are not user drags');
  sync.destroy();
  await tick(5);
});

// ---- server half: the chat banner ------------------------------------------

function makeWs(peerId, attachment) {
  const sent = [];
  return {
    deserializeAttachment: () => attachment || { peerId },
    send: (t) => sent.push(JSON.parse(t)),
    close() {},
    _sent: sent,
  };
}

async function freshRoom(o = {}) {
  const store = {};
  if (o.seed) Object.assign(store, o.seed);
  const mod = await import(pathToFileURL(join(ROOT, 'src/WatchRoom.js')).href + '?v=' + Math.random());
  const WatchRoom = mod.WatchRoom || mod.default;
  const sockets = o.sockets || [];
  const ctx = {
    id: { toString: () => 'ROOM1' },
    getWebSockets: () => sockets,
    storage: {
      get: async (k) => store[k],
      put: async (obj) => Object.assign(store, obj),
      getAlarm: async () => store.alarmAt || null,
      setAlarm: async (ts) => {
        store.alarmAt = ts;
      },
    },
    acceptWebSocket() {},
  };
  const env = {
    PRESENCE_KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  };
  const room = new WatchRoom(ctx, env);
  await room.ensureLoaded();
  return { room, store };
}

const systemLines = (ws) => ws._sent.filter((m) => m && m.type === 'system').map((m) => m.text);

test('banner: a pause that lands at the START of a room writes NO "paused the movie" line', async () => {
  const wsHost = makeWs('p1');
  const { room } = await freshRoom({
    sockets: [wsHost],
    seed: {
      meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: { id: '27205', src: 'x' } },
      sessions: [{ id: 'p1', name: 'Host', owner: true, joinedAt: 1 }],
      chat: [],
      requests: [],
      playback: { isPlaying: true, time: 0, timestamp: Date.now() },
    },
  });

  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 0.4 }));

  const lines = systemLines(wsHost).join(' | ');
  assert.ok(!/paused the movie/.test(lines), 'no false pause banner at the first start of a room');
  assert.equal(room.playback.isPlaying, false, 'the state still applies (banner is only the messenger)');
});

test('banner: a real pause (movie had progressed) is still announced once', async () => {
  const wsHost = makeWs('p1');
  const { room } = await freshRoom({
    sockets: [wsHost],
    seed: {
      meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: { id: '27205', src: 'x' } },
      sessions: [{ id: 'p1', name: 'Host', owner: true, joinedAt: 1 }],
      chat: [],
      requests: [],
      playback: { isPlaying: true, time: 640, timestamp: Date.now() },
    },
  });

  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 641.5 }));
  assert.match(systemLines(wsHost).join(' | '), /Host paused the movie/, 'a real pause is announced');

  // a re-assert (same action within the dedupe window) must not repeat it
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 641.5 }));
  const count = systemLines(wsHost).filter((t) => /paused the movie/.test(t)).length;
  assert.equal(count, 1, 'banner dedupe holds');
});

test('banner: "resumed the movie" needs a real pause to resume from', async () => {
  const wsHost = makeWs('p1');
  const { room } = await freshRoom({
    sockets: [wsHost],
    seed: {
      meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: { id: '27205', src: 'x' } },
      // the room is ALREADY playing at position 0: a startup play re-assert
      sessions: [{ id: 'p1', name: 'Host', owner: true, joinedAt: 1 }],
      chat: [],
      requests: [],
      playback: { isPlaying: true, time: 0, timestamp: Date.now() },
    },
  });

  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'play', time: 0 }));
  assert.ok(!/resumed the movie/.test(systemLines(wsHost).join(' | ')), 'no banner for a no-op re-assert');

  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 300 }));
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'play', time: 300 }));
  assert.match(systemLines(wsHost).join(' | '), /resumed the movie/, 'a genuine resume is announced');
});
