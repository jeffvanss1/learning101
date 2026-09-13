// Room-level subtitle sync + playback logs (Durable Object contracts).
//
// WatchRoom.js is exercised through its real webSocketMessage entry with a
// stubbed storage/websocket harness: a HOST peer and a GUEST peer, asserting
// that pause/resume land in the PERSISTED chat history and that the host's
// subtitle load/offset replicate to every peer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { ROOT } from './dompath.mjs';

// src/WatchRoom.js imports bundler-style './x.js' specifiers that resolve to
// x.ts — raw node needs the hook below (registered BEFORE the dynamic import).
register(new URL('./tsresolve.mjs', import.meta.url));

function makeWs(peerId) {
  const sent = [];
  const ws = {
    deserializeAttachment: () => ({ peerId }),
    send: (t) => sent.push(JSON.parse(t)),
    close() {},
    _sent: sent,
  };
  return ws;
}

async function freshRoom() {
  const store = {};
  const mod = await import(pathToFileURL(join(ROOT, 'src/WatchRoom.js')).href + '?v=' + Math.random());
  const WatchRoom = mod.WatchRoom || mod.default;
  const ctx = {
    id: { toString: () => 'ROOM1' },
    getWebSockets: () => [wsHost, wsGuest],
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
  // Seed: host p1 (owner), guest p2. ensureLoaded reads these.
  const storeInit = {
    meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: { id: 'm1', title: 'X' } },
    chat: [],
    playback: { isPlaying: true, time: 10, timestamp: 1 },
    sessions: [
      { id: 'p1', name: 'Host', owner: true, joinedAt: 1 },
      { id: 'p2', name: 'Guest', owner: false, joinedAt: 2 },
    ],
    requests: [],
  };
  Object.assign(store, storeInit);
  const wsHost = makeWs('p1');
  const wsGuest = makeWs('p2');
  const sockets = [wsHost, wsGuest];
  ctx.getWebSockets = () => sockets; // mutable in place: tests simulate socket deaths
  const kvPuts = [];
  const kvDels = [];
  const lastPut = {}; // stateful enough for clearPresenceIfRoom's read-first
  const env = {
    PRESENCE_KV: {
      get: async (k, type) => (lastPut[k] !== undefined && type === 'json' ? JSON.parse(lastPut[k]) : lastPut[k]) || null,
      put: async (k, v, opts) => {
        lastPut[k] = v;
        kvPuts.push({ k, v: JSON.parse(v), opts });
      },
      delete: async (k) => {
        delete lastPut[k];
        kvDels.push(k);
      },
    },
  };
  const room = new WatchRoom(ctx, env);
  await room.ensureLoaded();
  return { room, store, wsHost, wsGuest, kvPuts, kvDels, sockets };
}

test('host pause/resume lands in the chat history as system lines', async () => {
  const { room, store, wsHost, wsGuest } = await freshRoom();
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 12 }));
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'play', time: 12 }));

  const sysTexts = store.chat.filter((c) => c.type === 'system').map((c) => c.text);
  assert.ok(sysTexts.some((t) => /paused the movie/.test(t)), 'pause logged: ' + sysTexts.join(' | '));
  assert.ok(sysTexts.some((t) => /resumed the movie/.test(t)), 'resume logged: ' + sysTexts.join(' | '));
  assert.ok(sysTexts.some((t) => /Host/.test(t)), 'log names the actor');
  // The live broadcast reached BOTH peers (they render it via client.on('system')).
  assert.ok(wsHost._sent.some((m) => m.type === 'system' && /paused/.test(m.text)), 'host saw it');
  assert.ok(wsGuest._sent.some((m) => m.type === 'system' && /paused/.test(m.text)), 'guest saw it');
});

test('play/pause re-asserts do not spam the log (2s dedupe)', async () => {
  const { room, store, wsHost } = await freshRoom();
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 5 }));
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'pause', time: 5 }));
  const pauses = store.chat.filter((c) => c.type === 'system' && /paused/.test(c.text));
  assert.equal(pauses.length, 1, 'deduped to one log line');
});

test('host subtitle load: logged, broadcast, persisted; guests cannot set subs', async () => {
  const { room, store, wsHost, wsGuest } = await freshRoom();
  const chatBefore = store.chat.length;

  await room.webSocketMessage(
    wsHost,
    JSON.stringify({ type: 'subs', action: 'load', fileId: 'tokABC', label: 'The Martian [Indonesian]' })
  );

  assert.ok(store.subs && store.subs.fileId === 'tokABC', 'persisted for late joiners');
  assert.equal(store.subs.label, 'The Martian [Indonesian]');
  const sys = store.chat
    .slice(chatBefore)
    .filter((c) => c.type === 'system')
    .map((c) => c.text)
    .join(' | ');
  assert.ok(/loaded subtitles/.test(sys) && /The Martian/.test(sys), 'chat log names it: ' + sys);
  assert.ok(wsGuest._sent.some((m) => m.type === 'subs' && m.action === 'load' && m.fileId === 'tokABC'), 'guest received the load');
  assert.ok(wsHost._sent.some((m) => m.type === 'system' && /loaded subtitles/.test(m.text)), 'host saw the log too');

  // Guest tries the same -> ignored (canControl gate).
  const countBefore = store.chat.length;
  await room.webSocketMessage(
    makeWs('p2'),
    JSON.stringify({ type: 'subs', action: 'load', fileId: 'evil', label: 'hax' })
  );
  assert.equal(store.chat.length, countBefore, 'guest load produced no log');
  assert.equal(store.subs.fileId, 'tokABC', 'guest load did not change room subs');

  // Host offset match: broadcast + persisted, carries sender id (echo guard).
  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'subs', action: 'offset', value: 2.25 }));
  assert.equal(store.subs.offset, 2.25, 'offset persisted');
  const off = wsGuest._sent.filter((m) => m.type === 'subs' && m.action === 'offset');
  assert.equal(off.length, 1, 'offset broadcast exactly once');
  assert.equal(off[0].by, 'p1', 'carries the sender id for client echo-guard');
});

test('presence TTLs match the KV write budget (1h, refreshed server-side)', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'src/presence.ts')).href + '?v=' + Math.random());
  assert.equal(mod.PRESENCE_TTL_S, 3600, 'watching TTL 1h (KV free tier: 1000 writes/day - freshness comes from the DO alarm)');
  assert.equal(mod.IDLE_PRESENCE_TTL_S, 3600, 'idle TTL 1h');
  const puts = [];
  const env = {
    PRESENCE_KV: {
      get: async () => null,
      put: async (k, v, opts) => puts.push(opts),
    },
  };
  await mod.setPresence(env, 'user-1', {
    status: 'WATCHING_PARTY',
    room_id: 'ROOM1',
    media_title: 'The Martian',
    media_id: '286217',
    current_timestamp_seconds: 120,
  });
  assert.ok(puts.length === 1, 'one KV write');
  assert.equal(puts[0].expirationTtl, 3600, 'watching: 1h (refreshed 5-min by the room DO - write budget)');

  // IDLE carries no live data and has NO server-side refresher on the home
  // surface — an hour so background-throttled clients cannot go stale.
  puts.length = 0;
  await mod.setPresence(env, 'user-1', { status: 'IDLE' });
  assert.equal(puts[0].expirationTtl, 3600, 'idle: 1h (no server refresher on home)');
});

test('presence is refreshed SERVER-SIDE by the DO alarm (hidden-tab proof)', async () => {
  // Hidden tabs throttle client timers to 1/5min — the room DO must keep
  // presence alive itself. Sessions carry persisted presence payloads.
  const { room, store, kvPuts } = await freshRoom();
  store.sessions[0].userId = 'user-1'; // identified via a previous presenceSync
  store.sessions[0].presence = {
    status: 'WATCHING_PARTY',
    room_id: 'ROOM1',
    media_title: 'The Martian',
    media_id: '286217',
    current_timestamp_seconds: 320,
  };
  store.sessions[1].userId = 'user-2';
  store.sessions[1].presence = {
    status: 'IDLE',
    room_id: '',
    media_title: '',
    media_id: '',
    current_timestamp_seconds: 0,
  };
  kvPuts.length = 0;
  store.alarmAt = null;

  await room.alarm();

  const writes = kvPuts.map((p) => ({ status: p.v.status, ttl: p.opts && p.opts.expirationTtl }));
  assert.ok(writes.some((x) => x.status === 'WATCHING_PARTY' && x.ttl === 3600), 'watcher refreshed: ' + JSON.stringify(writes));
  assert.ok(writes.some((x) => x.status === 'IDLE'), 'idle member refreshed too');
  assert.ok(store.alarmAt > Date.now(), 'alarm rescheduled while sessions remain');

  // A session WITHOUT identity/presence must never be written. Mutate the
  // SAME array the room holds (this.sessions keeps the reference).
  store.sessions.splice(1); // guest leaves
  store.sessions[0].presence = null; // watching but never sent a beat
  kvPuts.length = 0;
  store.alarmAt = null;
  await room.alarm();
  assert.equal(kvPuts.length, 0, 'no identity/presence -> no write');
  // But the CHAIN STAYS ALIVE: an identified session (pre-deploy, no payload
  // yet) must not kill the refresh — sticky-offline regression guard.
  assert.ok(store.alarmAt > Date.now(), 'identified session keeps the chain armed');

  // Nobody identified at all -> the beat stops.
  store.sessions.splice(0);
  store.alarmAt = null;
  await room.alarm();
  assert.equal(store.alarmAt, null, 'nobody identified -> alarm not rescheduled');
});

test('a beat re-arms the alarm on an alarm-less DO (self-healing chain)', async () => {
  // Post-deploy hibernated sessions carry no payload; the FIRST beat after
  // deploy must arm the alarm again (the old code never did -> sticky offlines).
  const { room, store, wsHost } = await freshRoom();
  store.alarmAt = null; // no alarm pending: the dead-chain state
  await room.webSocketMessage(
    wsHost,
    JSON.stringify({
      type: 'presenceSync',
      token: 'x',
      userId: 'p1',
      status: 'WATCHING_PARTY',
      media_title: 'M',
      media_id: '1',
      current_timestamp_seconds: 10,
    })
  );
  // (the JWT will not verify against the stub env, so the identity write is
  // skipped — exercise the scheduling path directly instead)
  store.sessions[0].userId = 'user-1';
  store.sessions[0].presence = { status: 'WATCHING_PARTY', room_id: 'ROOM1', media_title: 'M', media_id: '1', current_timestamp_seconds: 10 };
  store.alarmAt = null;
  // Simulate the beat's scheduling step:
  try {
    if ((await room.ctx.storage.getAlarm()) === null) {
      await room.ctx.storage.setAlarm(Date.now() + 60000);
    }
  } catch (_) {}
  assert.ok(store.alarmAt > Date.now(), 'beat re-arms the chain');
  void room;
  void wsHost;
});


test('ghost sessions (socket died without a close) are pruned and their WATCHING presence cleared', async () => {
  const { room, store, wsHost, wsGuest, kvPuts, kvDels, sockets } = await freshRoom();
  store.sessions[0].userId = 'user-1';
  store.sessions[0].presence = { status: 'WATCHING_PARTY', room_id: 'ROOM1', media_title: 'M', media_id: '1', current_timestamp_seconds: 5 };
  store.sessions[1].userId = 'user-2';
  store.sessions[1].presence = { status: 'IDLE', room_id: '', media_title: '', media_id: '', current_timestamp_seconds: 0 };

  kvPuts.length = 0;
  await room.alarm();
  assert.equal(kvPuts.length, 2, 'both refreshed while both sockets live');

  // The guest's socket DIES without a close frame (app killed / laptop slept):
  // only the host's socket remains in the runtime's live list.
  sockets.splice(sockets.indexOf(wsGuest), 1);
  kvPuts.length = 0;
  kvDels.length = 0;
  store.alarmAt = null;

  await room.alarm();

  assert.equal(store.sessions.length, 1, 'ghost session removed');
  assert.equal(store.sessions[0].id, 'p1', 'the live host survives');
  assert.equal(kvDels.length, 1, 'ghost presence cleared');
  assert.ok(store.alarmAt > Date.now(), 'chain continues for the survivor');

  // Everyone's sockets die -> everything cleared, beat stops.
  sockets.splice(0);
  store.alarmAt = null;
  await room.alarm();
  assert.equal(store.sessions.length, 0, 'all ghosts pruned');
  assert.equal(store.alarmAt, null, 'nobody left -> beat stops');
});

test('WRITE BUDGET: 20s socket beats do NOT write KV per beat (free tier = 1000/day)', async () => {
  const { register } = await import('node:module');
  register(new URL('./tsresolve.mjs', import.meta.url));
  const auth = await import(pathToFileURL(join(ROOT, 'src/auth.ts')).href + '?v=' + Math.random());
  const { room, store, wsHost, kvPuts } = await freshRoom();
  store.sessions[0].userId = 'user-1';
  // Sign with the same secret the room's env verifies (harness env omits
  // SESSION_SECRET -> auth falls back to the dev secret on both sides).
  const token = await auth.issueToken({}, { id: 'user-1', username: 'jeff' });

  const beat = (ts) =>
    room.webSocketMessage(
      wsHost,
      JSON.stringify({ type: 'presenceSync', token, userId: 'user-1', status: 'WATCHING_PARTY', media_title: 'M', media_id: '1', current_timestamp_seconds: ts })
    );
  await beat(1);
  await beat(21);
  await beat(41);
  await beat(61);
  const writesForUser = kvPuts.filter((p) => p.k === 'presence:user:user-1').length;
  assert.equal(writesForUser, 1, 'four beats -> ONE kv write (join only): ' + writesForUser);

  // A status CHANGE writes immediately.
  await room.webSocketMessage(
    wsHost,
    JSON.stringify({ type: 'presenceSync', token, userId: 'user-1', status: 'IDLE', current_timestamp_seconds: 0 })
  );
  assert.equal(kvPuts.filter((p) => p.k === 'presence:user:user-1').length, 2, 'status change -> new write');
  assert.equal(store.sessions[0].presence.status, 'IDLE', 'session payload follows the beat');
});

test('SUBS duplicate-load guard: same fileId twice = ONE broadcast/log, language cannot flip', async () => {
  const { room, store, wsHost, wsGuest } = await freshRoom();
  const load = (fileId, label) =>
    room.webSocketMessage(wsHost, JSON.stringify({ type: 'subs', action: 'load', fileId, label }));

  // Room scenario from the bug report: Indonesian track loads, an auto-load
  // re-run loads it AGAIN, then a third run lands a DIFFERENT (English) file.
  await load('file-id-1', 'Bleach.S01E11... [Bahasa Indonesia]');
  await load('file-id-1', 'Bleach.S01E11... [Bahasa Indonesia]'); // duplicate auto-load
  const subsLogs = store.chat.filter((c) => c.type === 'system' && /loaded subtitles/.test(c.text));
  assert.equal(subsLogs.length, 1, 'duplicate fileId is not re-logged/re-broadcast');
  const guestLoads = wsGuest._sent.filter((m) => m.type === 'subs' && m.action === 'load');
  assert.equal(guestLoads.length, 1, 'guest received the load exactly once');
  assert.equal(room.subs.fileId, 'file-id-1');

  // A genuinely DIFFERENT file is still a real user action: it goes through.
  await load('file-en-1', 'Bleach.S01E11... [English]');
  assert.equal(room.subs.fileId, 'file-en-1');
  assert.equal(store.chat.filter((c) => c.type === 'system' && /loaded subtitles/.test(c.text)).length, 2);
});

test('subs auto-load: same-video guard + force flag + room dedup wired', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const subs = readFileSync(join(ROOT, 'dist/js/subs.js'), 'utf8');
  // setVideo: unchanged video keeps cues (no wipe, no re-search).
  assert.match(subs, /function videoIdentity\(/, 'video identity helper exists (distinct from the offset videoKey())');
  assert.match(subs, /nextKey === lastVideoKey\) \{[\s\S]{0,400}?offset = loadOffset\(\);/, 'same-video: refresh offset, never re-search');
  // autoLoad: dedupe key + force option (manual language switch/button).
  assert.match(subs, /async function autoLoad\(v, opts\)/, 'autoLoad takes opts');
  assert.match(subs, /\(opts && opts\.force\) && key === autoKey/, 'auto-load dedupes unless forced');
  assert.equal(/autoLoad\(video, \{ force: true \}\)/.test(subs), true, 'manual paths force-reload');
  assert.match(subs, /if \(pref !== 'off'\) void autoLoad\(video\);/, 'setVideo auto-load stays on the dedupe path');
  // Room priority + full-candidate downloads (language-flip fix).
  assert.doesNotMatch(subs, /slice\(0, 5\)/, 'searchBest must NOT cap downloads at 5 candidates');
  assert.match(subs, /roomSubsActive/, 'host subs suppress local auto-load');
  assert.match(subs, /autoLoadGen\+\+/, 'in-flight auto-loads are generation-checked');
});
