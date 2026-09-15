// DRIFT CORRECTIONS — the mobile "it keeps trying to sync, never playable" fix.
//
// A correction is a SEEK, and a seek makes the embedded player refetch from a new
// offset (its buffer drops and it shows its loading state). The old rule
// corrected any drift over 0.75s on EVERY 3s status poll; on a phone, where the
// status lags the player and the buffer is slow, the measured drift sits above
// that permanently — so a guest seeked forever: seek -> loading -> a status still
// reporting the old position -> seek again. The video never finished loading.
//
// These cases EXECUTE dist/js/player.js against fake status events and count the
// SEEK commands that actually reach the iframe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// The shipped manager ARMS its status poll with `setInterval` by NAME from the
// global scope, and only clears it when the manager is stopped. Node holds a
// process open for any timer that has not fired, so a fake room left polling
// hung `node --test` after the last assertion - the run printed no summary at
// all. This wrapper unrefs INTERVALS only (still fires on schedule, no longer
// counts as pending work); `setTimeout` stays ref'd, because an unref'd timeout
// that nothing else waits on can let the runner exit mid-test.
const keep = (h) => {
  if (h && typeof h.unref === 'function') h.unref();
  return h;
};
const realSetInterval = globalThis.setInterval;
const fakeSetInterval = (fn, ms, ...rest) => keep(realSetInterval(fn, ms, ...rest));
globalThis.setInterval = fakeSetInterval;

/** Fresh shipped player + a fake iframe that records every postMessage. */
async function freshPlayer() {
  const listeners = {};
  globalThis.window = {
    WP: {},
    addEventListener: (type, fn) => (listeners[type] || (listeners[type] = [])).push(fn),
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval: fakeSetInterval,
    clearInterval,
  };
  const src = readFileSync(join(ROOT, 'dist/js/player.js'), 'utf8');
  new Function('window', src)(globalThis.window);
  const Manager = globalThis.window.WP.PlaybackSyncManager;
  assert.ok(Manager, 'player.js exports WP.PlaybackSyncManager');

  const posted = [];
  const contentWindow = { postMessage: (m) => posted.push(m) };
  const iframeListeners = {};
  const iframe = {
    contentWindow,
    _src: 'https://bingr.one/watch/movie/603',
    addEventListener: (t, fn) => (iframeListeners[t] || (iframeListeners[t] = [])).push(fn),
    removeEventListener() {},
    getAttribute(k) {
      return k === 'src' ? this._src : null;
    },
    set src(v) {
      this._src = v;
    },
    get src() {
      return this._src;
    },
    fire: (t) => (iframeListeners[t] || []).forEach((fn) => fn({})),
  };
  const sync = new Manager(/** @type {any} */ (iframe));

  /** A status report, the way the Bingr embed posts it. */
  const status = (currentTime, playing = true) =>
    (listeners.message || []).forEach((fn) =>
      fn({
        source: contentWindow,
        data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime, playing } },
      })
    );
  const seekCount = () => posted.filter((m) => m && m.command === 'seek').length;
  const seeks = () => posted.filter((m) => m && m.command === 'seek').map((m) => m.time);
  const plays = () => posted.filter((m) => m && m.command === 'play').length;

  return { sync, status, seekCount, seeks, plays, iframe, posted };
}

/** Seat a GUEST into a room that is 300s into a movie. */
async function guestWatching() {
  const app = await freshPlayer();
  app.sync.isController = false;
  app.sync.loadVideo({ src: 'https://bingr.one/watch/movie/603' });
  app.iframe.fire('load');
  assert.equal(app.sync._iframeLoaded, true, 'the embed document loaded');
  app.sync.applyRemote({ time: 300, isPlaying: true, timestamp: Date.now() });
  return app;
}

test('join: a slow phone is seeked ONCE into position, then left to load', async () => {
  const app = await guestWatching();
  assert.equal(app.seekCount(), 1, 'the join seek');

  // The player is still loading: polls for longer than the settle window AND
  // the base cooldown, every one reporting the stale position it last buffered
  // (0) — no forward progress at all. The old rule seeked on each of these.
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < 7000) {
    await tick(320);
    app.status(0, true);
    polls += 1;
  }
  assert.ok(polls >= 18, 'enough polls to have triggered the old loop: ' + polls);
  assert.equal(app.seekCount(), 1, 'a loading player is NOT seeked again (was: one per poll)');
  assert.ok(app.plays() >= 1, 'but it is told to play — the join must autoplay');
});

test('join: the old eager rule would have seeked on every poll (the loop, pinned)', async () => {
  const app = await guestWatching();
  const before = app.seekCount();
  // Same stale statuses, but the player makes a little progress each time: the
  // budget still refuses to chase a few seconds of buffer behind.
  for (let i = 0; i < 6; i++) {
    await tick(320);
    app.status(i * 0.4, true); // 0.4s of progress per 3s of wall clock: buffering
  }
  assert.equal(app.seekCount(), before, 'no chase while the buffer is filling');
});

test('a small offset is IGNORED while playing (2.5s, not 0.75s)', async () => {
  const app = await freshPlayer();
  app.sync.isController = false;
  app.sync.loadVideo({ src: 'https://bingr.one/watch/movie/603' });
  app.iframe.fire('load');
  app.sync.applyRemote({ time: 100, isPlaying: true, timestamp: Date.now() });
  await tick(400);
  const after = app.seekCount();

  // The player runs 1.5s behind the room's projection: invisible on screen, and
  // not worth a buffer-dropping seek.
  app.sync.localTime = 98.5;
  for (let i = 0; i < 4; i++) app.status(98.5 + i * 0.9, true);
  assert.equal(app.seekCount(), after, 'a playing room tolerates real drift');
  assert.equal(app.sync._correctionBackoff, 0, 'and the budget stays clean');
});

test('a big, PROGRESSING drift is corrected once per cooldown — not per poll', async () => {
  const app = await guestWatching(); // 300s target, joins at 0
  const first = app.seekCount();
  assert.equal(first, 1, 'join correction');

  // The join seek has landed (the settle window itself is proven in test 2, on
  // real time); the player now plays, 20s behind the room, and is MOVING: each
  // status advances its own clock.
  app.sync._settleUntil = 0;
  app.sync._awaitingStart = false;
  let local = 280;
  for (let i = 0; i < 8; i++) {
    local += 3;
    // Keep the ROOM where it is (a stale snapshot still being followed) so the
    // gap is the player's own lag, and let it advance its clock as it plays.
    app.sync._lastMsg.timestamp = Date.now();
    app.status(local, true);
  }
  const second = app.seekCount();
  assert.equal(second, first + 1, 'a genuinely behind, playing client is corrected once');
  assert.equal(app.seeks()[app.seeks().length - 1], 300, 'to the room\'s position');
  assert.equal(
    app.seeks().filter((t) => t === 300).length,
    2,
    'exactly two seeks to 300 in eight polls: the join, then one drift fix'
  );
});

test('a FROZEN clock backs the player off instead of hammering it', async () => {
  const app = await freshPlayer();
  app.sync.isController = false;
  app.sync.loadVideo({ src: 'https://bingr.one/watch/movie/603' });
  app.iframe.fire('load');
  app.sync.applyRemote({ time: 300, isPlaying: true, timestamp: Date.now() });
  const first = app.seekCount();
  assert.equal(first, 1, 'join seek');

  // The player NEVER advances (a stuck/loading player), for far longer than the
  // base cooldown: the budget must keep growing its backoff, not seek.
  const t0 = Date.now();
  let frozeAt = 0;
  while (Date.now() - t0 < 7000) {
    app.status(frozeAt, true); // same position every time
    await tick(40);
  }
  assert.equal(app.seekCount(), 1, 'a frozen player is never seeked again');
  assert.ok(app.sync._correctionBackoff > 8000, 'the backoff grew instead: ' + app.sync._correctionBackoff);
});

test('an explicit room command CLEARS the budget: following the host is never delayed', async () => {
  const app = await guestWatching();
  // Burn the budget: many corrections' worth of drift, first one spent.
  assert.equal(app.seekCount(), 1);
  const before = app.seekCount();

  // The HOST seeks the room to 900s — an explicit command.
  app.sync.applyRemote({ time: 900, isPlaying: true, timestamp: Date.now() });
  assert.equal(app.seekCount(), before + 1, 'the room command lands immediately');
  assert.equal(app.seeks()[app.seeks().length - 1], 900, 'to the room\'s position');
  assert.ok(app.sync._lastCorrectionAt > 0, 'the correction was made (and the budget armed for drift)');
  assert.equal(app.sync._correctionBackoff, 8000, 'at the BASE cooldown, not an escalated one');
});

test('a room PAUSE still lands while the budget is exhausted (pause is not a seek)', async () => {
  const app = await guestWatching();
  app.sync.applyRemote({ time: 305, isPlaying: false, timestamp: Date.now() });
  const posts = app.posted.map((m) => m && m.command);
  assert.equal(posts[posts.length - 1], 'pause', 'the room pause reaches the player at once');
  assert.ok(
    posts.filter((c) => c === 'seek').length <= 2,
    'the paused room is positioned once, not chased: ' + JSON.stringify(posts)
  );
});

test('clock skew: a device clock minutes off does NOT become a minutes-long seek', async () => {
  const app = await freshPlayer();
  app.sync.isController = false;
  app.sync.loadVideo({ src: 'https://bingr.one/watch/movie/603' });
  app.iframe.fire('load');

  // The SERVER says "300s in, playing, and my clock says T". This device's clock
  // is 5 minutes ahead, so projecting with the raw device clock would put the
  // room at 600s — and the guest would be seeked 300s forward, then the next
  // status would compute the same nonsense forever.
  const serverNow = Date.now() - 300000;
  app.sync.applyRemote({ time: 300, isPlaying: true, timestamp: serverNow });
  assert.ok(app.sync._clockSkew() > 290000, 'the offset is measured from the message');

  const target = app.sync.estimate({ time: 300, isPlaying: true, timestamp: serverNow });
  assert.ok(Math.abs(target.time - 300) < 3, 'the projection cancels the skew: ' + target.time);

  // The player sits exactly where the room says: nothing to correct.
  await tick(400);
  const seeksBefore = app.seekCount();
  app.sync.localTime = 300.2;
  app.status(300.2, true);
  assert.equal(app.seekCount(), seeksBefore, 'no phantom seek from a skewed clock');
  assert.ok(app.sync._skewSamples.length >= 1, 'the sample window is populated');
});

test('projection: a stale tuple plus skew never seeks PAST the media end', async () => {
  const app = await freshPlayer();
  app.sync.localPlaying = true;
  app.sync.duration = 600;
  const target = app.sync.estimate({ time: 5000, isPlaying: true, timestamp: Date.now() });
  assert.ok(target.time <= 599, 'clamped inside the media: ' + target.time);
});

test('the host is protected by the same budget while its player is loading', async () => {
  const app = await freshPlayer();
  app.sync.isController = true;
  app.sync.loadVideo({ src: 'https://bingr.one/watch/movie/603' });
  app.iframe.fire('load');
  app.sync.applyRemote({ time: 120, isPlaying: true, timestamp: Date.now() });
  const first = app.seekCount();
  assert.equal(first, 1, 'the fresh-load join seek');
  for (let i = 0; i < 8; i++) {
    await tick(150);
    app.status(0, true); // never advances
  }
  assert.equal(app.seekCount(), 1, 'the host\'s loading player is not hammered either');
});

test('buffering: a stall blocks the next correction attempt (a stall is not a position)', async () => {
  const app = await freshPlayer();
  app.sync.isController = false;
  app.sync.loadVideo({ src: 'https://bingr.one/watch/movie/603' });
  app.iframe.fire('load');
  app.sync.applyRemote({ time: 300, isPlaying: true, timestamp: Date.now() });
  const before = app.seekCount();
  assert.ok(before >= 1, 'the join seek happened');

  // The embed reports a STALL. The convergence attempts that follow (the
  // re-check timers a room command schedules) must refuse to seek: a stalled
  // player is not out of position, it is out of buffer.
  app.sync._settleUntil = 0;
  app.sync._awaitingStart = false;
  app.sync._lastMsg.timestamp = Date.now();
  app.sync.isBuffering = true;
  app.sync.localTime = 250;
  app.sync._lastReportedTime = 250;
  app.sync._syncToTarget();
  assert.equal(app.seekCount(), before, 'no seek while buffering');

  // Once the embed is fine again (a status clears the stall flag), the drift is
  // corrected - as soon as the player shows it is actually MOVING again.
  app.status(250, true); // clears the stall flag, no forward progress yet
  assert.equal(app.seekCount(), before, 'still no seek: the clock has not moved');
  app.status(253, true); // the player is running again
  assert.equal(app.seekCount(), before + 1, 'and now the position is corrected');
});


test('the fix is a BUDGET, not a single-shot: once in sync the budget resets', async () => {
  const app = await guestWatching();
  assert.ok(app.sync._correctionBackoff >= 8000, 'armed after the join seek');
  // A status that shows us close to the room (inside the tolerance) resets it.
  app.sync._settleUntil = 0; // the seek has landed
  app.sync.localTime = 299.5;
  app.sync.localPlaying = true;
  app.sync._awaitingStart = false;
  app.status(299.5, true);
  assert.equal(app.sync._correctionBackoff, 0, 'backoff reset when in sync');
  assert.equal(app.sync._driftStreak.n, 0, 'and the streak is clean');
});
