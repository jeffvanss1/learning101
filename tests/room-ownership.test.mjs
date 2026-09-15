// Room ownership recovery (Durable Object contracts).
//
// Two failure modes are covered here, both of which left a room with NO
// controllable host:
//
//   1. `join` promoted a newcomer only when `meta.ownerId` was unset. A
//      persisted owner id whose session is gone (redeploy, or the alarm's
//      ghost-prune pass) therefore blocked promotion FOREVER — every
//      play/pause/seek was dropped and nobody could take over.
//   2. The alarm's liveness pass only pruned sessions that had a `userId`, so
//      an anonymous host whose socket died without a close frame stayed in the
//      roster (and kept the host badge) long after it was gone.
//
// The harness mirrors tests/room-subs.test.mjs: real webSocketMessage entry,
// stubbed storage + an in-place mutable socket list. The `seed` option fills
// storage BEFORE the DO loads it (ensureLoaded reads it once).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';
import { ROOT } from './dompath.mjs';

// src/WatchRoom.js imports bundler-style './x.js' specifiers that resolve to
// x.ts — raw node needs the hook below (registered BEFORE the dynamic import).
register(new URL('./tsresolve.mjs', import.meta.url));

function makeWs(peerId, attachment) {
  const sent = [];
  return {
    deserializeAttachment: () => attachment || { peerId },
    send: (t) => sent.push(JSON.parse(t)),
    close() {},
    _sent: sent,
  };
}

/**
 * @param {{ seed?: Record<string, any>, sockets?: ReturnType<typeof makeWs>[] }} [o]
 */
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
    PRESENCE_KV: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  };
  const room = new WatchRoom(ctx, env);
  await room.ensureLoaded();
  return { room, store, sockets };
}

/** @param {any[]} list @param {string} type */
function find(list, type) {
  return list.filter((m) => m && m.type === type)[0] || null;
}

test('a stale ownerId (owner session gone) does not block promotion', async () => {
  // State after a redeploy / ghost prune: ownership points at a session that
  // no longer exists, and only one real client is connected.
  const wsHost = makeWs('p2');
  const { room, store } = await freshRoom({
    sockets: [wsHost],
    seed: {
      meta: { createdAt: 1, ownerId: 'p-gone', allowed: [], video: {} },
      sessions: [{ id: 'p2', name: '', owner: false, joinedAt: 5 }],
      chat: [],
      requests: [],
    },
  });

  await room.webSocketMessage(wsHost, JSON.stringify({ type: 'join', name: 'Late' }));

  const state = find(wsHost._sent, 'state');
  assert.ok(state, 'join answered with a state snapshot');
  assert.equal(state.you.owner, true, 'the only live peer must become the host');
  assert.equal(store.meta.ownerId, 'p2', 'ownership is persisted for the next joiner');
});

test('a live owner keeps ownership (no promotion while the host is connected)', async () => {
  const wsHost = makeWs('p1');
  const wsGuest = makeWs('p2');
  const { room, store } = await freshRoom({
    sockets: [wsHost, wsGuest],
    seed: {
      meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: {} },
      sessions: [
        { id: 'p1', name: 'Host', owner: true, joinedAt: 1 },
        { id: 'p2', name: '', owner: false, joinedAt: 2 },
      ],
      chat: [],
      requests: [],
    },
  });

  await room.webSocketMessage(wsGuest, JSON.stringify({ type: 'join', name: 'Guest' }));

  const state = find(wsGuest._sent, 'state');
  assert.ok(state, 'join answered');
  assert.equal(state.you.owner, false, 'the connected host is not displaced');
  assert.equal(store.meta.ownerId, 'p1', 'owner unchanged');
});

test('the alarm hands ownership to a live peer when the host socket dies silently', async () => {
  // Anonymous host (no userId) + signed-in guest. The host's socket vanishes
  // without a close frame: the alarm is the only recovery path.
  const wsHost = makeWs('p1');
  const wsGuest = makeWs('p2', { peerId: 'p2', userId: 'user-2' });
  const { room, store, sockets } = await freshRoom({
    sockets: [wsHost, wsGuest],
    seed: {
      meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: { id: 'm1', title: 'X' } },
      sessions: [
        { id: 'p1', name: 'GhostHost', owner: true, joinedAt: 1 },
        {
          id: 'p2',
          name: 'Guest',
          owner: false,
          joinedAt: 2,
          userId: 'user-2',
          presence: {
            status: 'WATCHING_PARTY',
            room_id: 'ROOM1',
            media_title: 'X',
            media_id: 'm1',
            current_timestamp_seconds: 5,
          },
        },
      ],
      chat: [],
      requests: [],
    },
  });

  sockets.splice(sockets.indexOf(wsHost), 1); // the host's socket is gone
  await room.alarm();

  assert.deepEqual(
    store.sessions.map((s) => s.id),
    ['p2'],
    'the anonymous ghost is pruned from the roster (it used to survive forever)'
  );
  assert.equal(store.meta.ownerId, 'p2', 'ownership moved to the live peer');
  const state = find(wsGuest._sent, 'state');
  assert.ok(state && state.you.owner === true, 'the new host is told it owns the room');
  assert.ok(
    wsGuest._sent.some((m) => m.type === 'peers' && m.peers.some((p) => p.id === 'p2' && p.owner)),
    'the roster broadcast shows the new host'
  );
  assert.ok(store.alarmAt > Date.now(), 'the presence beat keeps running for the survivor');
});

test('hasLiveOwner() follows the socket list, not the persisted roster', async () => {
  const wsHost = makeWs('p1');
  const { room, sockets } = await freshRoom({
    sockets: [wsHost],
    seed: {
      meta: { createdAt: 1, ownerId: 'p1', allowed: [], video: {} },
      sessions: [{ id: 'p1', name: 'Host', owner: true, joinedAt: 1 }],
      chat: [],
      requests: [],
    },
  });

  assert.equal(room.hasLiveOwner(), true, 'owner socket connected');
  sockets.splice(0); // socket died silently
  assert.equal(room.hasLiveOwner(), false, 'a session without a socket is not a live owner');
});
