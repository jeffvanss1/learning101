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
  const room = new WatchRoom(ctx, {});
  await room.ensureLoaded();
  return { room, store, wsHost, wsGuest };
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

test('presence TTL survives background-tab throttling (900s, not 180s)', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'src/presence.ts')).href + '?v=' + Math.random());
  assert.equal(mod.PRESENCE_TTL_S, 900, 'TTL raised: hidden-tab timers fire as rarely as 1/5min');
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
  assert.equal(puts[0].expirationTtl, 900, 'the write carries the raised TTL');
});
