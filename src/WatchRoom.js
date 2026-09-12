// WatchRoom.js — Cloudflare Durable Object
//
// Owns all mutable state for a single watch room and acts as the WebSocket
// signaling hub. Every connected client's socket is terminated here so all
// clients in the same room share one authoritative clock and one chat stream.
//
// Uses the WebSocket Hibernation API:
//   - sockets are accepted via `state.acceptWebSocket()` so the object can
//     hibernate (and stop billing) while idle without dropping clients;
//   - per-socket identity lives in the WebSocket attachment
//     (`serializeAttachment` / `deserializeAttachment`) so it survives
//     hibernation;
//   - the connected-peer roster is persisted to Durable Object storage (in
//     memory state is reset on hibernation) and broadcast via
//     `state.getWebSockets()`.
//
// No `socket.io`, no Node-only dependencies.

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
export const MSG = {
  JOIN: 'join',
  STATE: 'state',
  PEERS: 'peers',
  SYSTEM: 'system',
  CHAT: 'chat',
  VIDEO_CHANGE: 'videoChange',
  PLAY: 'play',
  PAUSE: 'pause',
  SEEK: 'seek',
  TRANSFER: 'transfer',
  GRANT: 'grant',
  REVOKE: 'revoke',
  REQUEST: 'request',
  ACCEPT: 'accept',
  REJECT: 'reject',
  REQUEST_RESOLVED: 'requestResolved',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
};

const MAX_CHAT = 200; // messages kept per room
const MAX_REQUESTS = 50; // video requests kept per room
const MAX_PLAYBACK_STATE_AGE_MS = 2 * 60 * 60 * 1000; // 2h before state is stale
const EMOTE_DIGITS = 6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function base62(n) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  do {
    s = chars[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s;
}

function emoteForName(name = '') {
  const trimmed = name.trim();
  if (!trimmed) return null;
  let hash = 5381;
  for (let i = 0; i < trimmed.length; i++) {
    hash = ((hash * 33) ^ trimmed.charCodeAt(i)) >>> 0;
  }
  const code = hash % 1000000;
  return `ev_${String(code).padStart(EMOTE_DIGITS, '0')}`;
}

function makeId() {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffffff).toString(36).padStart(7, '0');
  const salt = base62(Math.floor(Math.random() * 3844));
  return `${t}${r}${salt}`;
}

function now() {
  return Date.now();
}

function sanitizeText(s) {
  return String(s ?? '');
}

function sanitizeName(s) {
  return String(s ?? '').trim().slice(0, 40);
}

function sanitizeNum(n) {
  const x = Number(n);
  return Number.isFinite(x) && x > 0 ? x : null;
}

function sanitizeMeta(video) {
  const v = video || {};
  return {
    type: sanitizeText(v.type).slice(0, 20),
    id: sanitizeText(v.id),
    src: sanitizeText(v.src).slice(0, 600),
    title: sanitizeText(v.title).slice(0, 300),
    poster: sanitizeText(v.poster || v.thumb).slice(0, 600),
    backdrop: sanitizeText(v.backdrop).slice(0, 600),
    thumb: sanitizeText(v.thumb || v.poster).slice(0, 600),
    year: sanitizeText(v.year).slice(0, 20),
    season: sanitizeNum(v.season),
    episode: sanitizeNum(v.episode),
  };
}

function sanitizePeer(peer, allowedSet) {
  const allowed = allowedSet instanceof Set && allowedSet.has(peer.id);
  return {
    id: peer.id,
    name: String(peer.name ?? '').slice(0, 40),
    emote: peer.emote || null,
    owner: !!peer.owner,
    allowed,
  };
}

// ---------------------------------------------------------------------------
// WatchRoom Durable Object
// ---------------------------------------------------------------------------
export class WatchRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    // Loaded lazily from storage (see ensureLoaded).
    this.meta = undefined;
    this.chat = undefined;
    this.playback = undefined;
    this.sessions = undefined;
    this.requests = undefined;
  }

  // ---- Lifecycle / state ---------------------------------------------------
  async ensureLoaded() {
    if (this.meta !== undefined) return;
    const [meta, chat, playback, sessions, requests] = await Promise.all([
      this.storage.get('meta'),
      this.storage.get('chat'),
      this.storage.get('playback'),
      this.storage.get('sessions'),
      this.storage.get('requests'),
    ]);
    this.meta = {
      id: this.ctx.id.toString(),
      createdAt: (meta && meta.createdAt) || now(),
      ownerId: (meta && meta.ownerId) || null,
      allowed: Array.isArray(meta && meta.allowed) ? meta.allowed : [],
      video: sanitizeMeta(meta && meta.video),
      ...(meta && typeof meta.topic === 'string' ? { topic: meta.topic } : {}),
    };
    this.chat = Array.isArray(chat) ? chat : [];
    this.playback = {
      isPlaying: false,
      time: 0,
      timestamp: now(),
      ...(playback && typeof playback === 'object' ? playback : {}),
    };
    this.sessions = Array.isArray(sessions) ? sessions : [];
    this.requests = Array.isArray(requests) ? requests : [];
  }

  async persist() {
    await this.storage.put({
      meta: this.meta,
      chat: this.chat.slice(-MAX_CHAT),
      playback: this.playback,
      sessions: this.sessions,
      requests: this.requests.slice(-MAX_REQUESTS),
    });
  }

  // ---- Socket identity -------------------------------------------------------
  peerFor(ws) {
    let attach = null;
    try {
      attach = ws.deserializeAttachment();
    } catch (_) {}
    const peerId = attach && attach.peerId;
    if (!peerId) return null;
    return this.sessions.find((p) => p.id === peerId) || null;
  }

  // ---- HTTP fetch (Worker-side routing lands here) --------------------------
  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade (Hibernation-compatible)
    if (request.headers.get('Upgrade') === 'websocket') {
      await this.ensureLoaded();
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const peer = {
        id: makeId(),
        name: '',
        emote: null,
        owner: false,
        joinedAt: now(),
      };
      this.sessions.push(peer);
      await this.persist();

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ peerId: peer.id });

      return new Response(null, { status: 101, webSocket: client });
    }

    await this.ensureLoaded();

    // Standard HTTP handlers (GET only)
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          id: this.meta.id,
          peers: this.sessions.length,
          isPlaying: this.playback.isPlaying,
          time: Math.round(this.currentTime() * 1000) / 1000,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/state') {
      const allowed = this.allowedSet();
      return new Response(
        JSON.stringify({
          ...this.snapshotState(),
          peers: this.sessions.slice(0, 50).map((p) => sanitizePeer(p, allowed)),
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404 });
  }

  // ---- Hibernation WebSocket API --------------------------------------------
  async webSocketMessage(ws, message) {
    await this.ensureLoaded();
    const peer = this.peerFor(ws);
    if (!peer) {
      try {
        ws.close(1011, 'Unknown session');
      } catch (_) {}
      return;
    }
    await this.handleMessage(ws, peer, message);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    await this.ensureLoaded();
    await this.removePeer(ws, { code, reason });
  }

  async webSocketError(ws, error) {
    await this.ensureLoaded();
    await this.removePeer(ws, { error });
  }

  async removePeer(ws, detail = {}) {
    let attach = null;
    try {
      attach = ws.deserializeAttachment();
    } catch (_) {}
    const peerId = attach && attach.peerId;
    const idx = this.sessions.findIndex((p) => p.id === peerId);
    if (idx === -1) {
      try {
        ws.close(1000, 'bye');
      } catch (_) {}
      return;
    }
    const [peer] = this.sessions.splice(idx, 1);
    try {
      ws.close(1000, 'bye');
    } catch (_) {}

    // A leaving peer loses any playback grant.
    if (Array.isArray(this.meta.allowed)) {
      this.meta.allowed = this.meta.allowed.filter((id) => id !== peer.id);
    }

    this.broadcastPeers();
    if (peer.name) {
      this.broadcastSystem(`${peer.name} left`);
    }
    if (peer.owner && this.meta.ownerId === peer.id) {
      await this.transferOwnership();
    }
    await this.persist();
  }

  // ---- Message handling -------------------------------------------------------
  async handleMessage(ws, peer, message) {
    let msg;
    try {
      msg = JSON.parse(String(message));
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    let dirty = false;

    switch (msg.type) {
      case MSG.JOIN: {
        const name = sanitizeName(msg.name);
        const video = sanitizeMeta(msg.video);
        const becameOwner = !this.meta.ownerId && !this.hasLiveOwner();

        peer.name = name;
        peer.emote = emoteForName(name);

        if (becameOwner) {
          peer.owner = true;
          this.meta.ownerId = peer.id;
          if (video.id) {
            this.meta.video = video;
            // Picking a title starts the watch party — autoplay from 0.
            this.playback = { isPlaying: true, time: 0, timestamp: now() };
          }
        }

        // A freshly joined client starts from the room's shared timeline.
        this.send(ws, {
          type: MSG.STATE,
          ...this.snapshotState(),
          you: sanitizePeer(peer, this.allowedSet()),
          chat: this.chat.slice(-100),
        });
        this.broadcastPeers();
        if (video.id && becameOwner) {
          this.broadcast({
            type: MSG.VIDEO_CHANGE,
            video: this.meta.video,
            playback: this.playback,
            ts: now(),
          });
        }
        this.broadcastSystem(`${name || 'Someone'} joined`);
        dirty = true;
        break;
      }

      case MSG.CHAT: {
        const text = sanitizeText(msg.text).slice(0, 500);
        if (!text.trim()) break;
        const chatMsg = {
          id: makeId(),
          peerId: peer.id,
          author: peer.name || 'Anonymous',
          emote: peer.emote,
          text,
          ts: now(),
        };
        this.chat.push(chatMsg);
        if (this.chat.length > MAX_CHAT) this.chat = this.chat.slice(-MAX_CHAT);
        this.broadcast({ type: MSG.CHAT, message: chatMsg });
        dirty = true;
        break;
      }

      case MSG.VIDEO_CHANGE: {
        if (!this.canControl(peer)) break;
        const video = sanitizeMeta(msg.video);
        if (!video.id) break;
        this.meta.video = video;
        // Choosing a video begins playback for the whole room — no need to
        // press the UI play button to start.
        this.playback = { isPlaying: true, time: 0, timestamp: now() };
        this.broadcast({
          type: MSG.VIDEO_CHANGE,
          video,
          playback: this.playback,
          ts: now(),
        });
        dirty = true;
        break;
      }

      case MSG.PLAY: {
        if (!this.canControl(peer)) break;
        const t = this.clampTime(msg.time);
        this.playback.isPlaying = true;
        this.playback.time = t;
        this.playback.timestamp = now();
        this.broadcast({
          type: MSG.PLAY,
          time: t,
          timestamp: this.playback.timestamp,
          playback: this.playback,
          by: peer.name,
        });
        dirty = true;
        break;
      }

      case MSG.PAUSE: {
        if (!this.canControl(peer)) break;
        const t = this.clampTime(msg.time);
        this.playback.isPlaying = false;
        this.playback.time = t;
        this.playback.timestamp = now();
        this.broadcast({
          type: MSG.PAUSE,
          time: t,
          timestamp: this.playback.timestamp,
          playback: this.playback,
          by: peer.name,
        });
        dirty = true;
        break;
      }

      case MSG.SEEK: {
        if (!this.canControl(peer)) break;
        const t = this.clampTime(msg.time);
        this.playback.time = t;
        this.playback.timestamp = now();
        this.broadcast({
          type: MSG.SEEK,
          time: t,
          timestamp: this.playback.timestamp,
          playback: this.playback,
          by: peer.name,
        });
        dirty = true;
        break;
      }

      case MSG.TRANSFER: {
        if (!this.isOwner(peer)) break;
        const targetId = sanitizeText(msg.peerId);
        if (!targetId || targetId === peer.id) break;
        const target = this.sessions.find((p) => p.id === targetId);
        if (!target) break;
        peer.owner = false;
        target.owner = true;
        this.meta.ownerId = target.id;
        // The new host no longer needs an explicit grant.
        this.meta.allowed = this.meta.allowed.filter((id) => id !== targetId);
        this.sendToPeer(target.id, {
          type: MSG.STATE,
          ...this.snapshotState(),
          you: sanitizePeer(target, this.allowedSet()),
        });
        this.broadcastPeers();
        this.broadcastSystem(`${target.name || 'Someone'} is now the host`);
        dirty = true;
        break;
      }

      case MSG.GRANT: {
        if (!this.isOwner(peer)) break;
        const targetId = sanitizeText(msg.peerId);
        if (!targetId) break;
        const target = this.sessions.find((p) => p.id === targetId);
        if (!target || target.owner) break;
        if (!this.meta.allowed.includes(targetId)) this.meta.allowed.push(targetId);
        this.broadcastPeers();
        this.broadcastSystem(`${peer.name || 'The host'} gave ${target.name || 'a guest'} playback controls`);
        dirty = true;
        break;
      }

      case MSG.REVOKE: {
        if (!this.isOwner(peer)) break;
        const targetId = sanitizeText(msg.peerId);
        if (!targetId) break;
        const target = this.sessions.find((p) => p.id === targetId);
        this.meta.allowed = this.meta.allowed.filter((id) => id !== targetId);
        this.broadcastPeers();
        if (target) {
          this.broadcastSystem(`${peer.name || 'The host'} removed ${target.name || 'a guest'}'s playback controls`);
        }
        dirty = true;
        break;
      }

      case MSG.REQUEST: {
        // Anyone can propose a title; the host decides whether to play it.
        const video = sanitizeMeta(msg.video);
        if (!video.id || !video.src) break;
        const request = {
          id: makeId(),
          peerId: peer.id,
          name: peer.name || 'Anonymous',
          emote: peer.emote,
          video,
          resolved: false,
          ts: now(),
        };
        this.requests.push(request);
        if (this.requests.length > MAX_REQUESTS) {
          this.requests = this.requests.slice(-MAX_REQUESTS);
        }
        this.broadcast({ type: MSG.REQUEST, request });
        dirty = true;
        break;
      }

      case MSG.ACCEPT: {
        if (!this.isOwner(peer)) break;
        const requestId = sanitizeText(msg.requestId);
        const request = this.requests.find((r) => r.id === requestId && !r.resolved);
        if (!request) break;
        request.resolved = true;
        request.accepted = true;
        // Accepting plays the requested title for the whole room immediately.
        this.meta.video = request.video;
        this.playback = { isPlaying: true, time: 0, timestamp: now() };
        this.broadcast({
          type: MSG.VIDEO_CHANGE,
          video: request.video,
          playback: this.playback,
          ts: now(),
        });
        this.broadcast({
          type: MSG.REQUEST_RESOLVED,
          requestId,
          accepted: true,
          title: request.video.title,
          by: request.name,
        });
        this.broadcastSystem(`${request.name}'s request is now playing`);
        dirty = true;
        break;
      }

      case MSG.REJECT: {
        if (!this.isOwner(peer)) break;
        const requestId = sanitizeText(msg.requestId);
        const request = this.requests.find((r) => r.id === requestId && !r.resolved);
        if (!request) break;
        request.resolved = true;
        request.accepted = false;
        this.broadcast({
          type: MSG.REQUEST_RESOLVED,
          requestId,
          accepted: false,
          title: request.video.title,
          by: request.name,
        });
        this.broadcastSystem(`${peer.name || 'The host'} declined ${request.name}'s request`);
        dirty = true;
        break;
      }

      case MSG.PING:
        this.send(ws, { type: MSG.PONG, ts: msg.ts ?? now() });
        break;

      default:
        break;
    }

    if (dirty) await this.persist();
  }

  // ---- Ownership / permissions ---------------------------------------------
  allowedSet() {
    return new Set(Array.isArray(this.meta.allowed) ? this.meta.allowed : []);
  }

  isOwner(peer) {
    return !!(peer && this.meta.ownerId && peer.id === this.meta.ownerId);
  }

  canControl(peer) {
    return this.isOwner(peer) || this.allowedSet().has(peer && peer.id);
  }

  hasLiveOwner() {
    if (!this.meta.ownerId) return false;
    return this.sessions.some((p) => p.id === this.meta.ownerId);
  }

  async transferOwnership() {
    // Prefer the oldest still-connected peer.
    let next = null;
    for (const p of this.sessions) {
      if (!next || p.joinedAt < next.joinedAt) next = p;
    }
    if (next) {
      next.owner = true;
      this.meta.ownerId = next.id;
      // The promoted peer no longer needs an explicit grant.
      this.meta.allowed = this.meta.allowed.filter((id) => id !== next.id);
      this.sendToPeer(next.id, {
        type: MSG.STATE,
        ...this.snapshotState(),
        you: sanitizePeer(next, this.allowedSet()),
      });
      this.broadcastSystem(`${next.name || 'Someone'} is now the host`);
    } else {
      this.meta.ownerId = null;
    }
    this.broadcastPeers();
    await this.persist();
  }

  // ---- Playback -----------------------------------------------------------
  currentTime() {
    const p = this.playback;
    if (p.isPlaying) {
      return p.time + (now() - p.timestamp) / 1000;
    }
    return p.time;
  }

  clampTime(t) {
    const n = Number(t);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(n, 24 * 60 * 60)); // 24h hard cap
  }

  snapshotState() {
    const p = this.playback;
    const stale =
      !p.isPlaying && p.time <= 0 && now() - p.timestamp > MAX_PLAYBACK_STATE_AGE_MS;
    return {
      roomId: this.meta.id,
      ownerId: this.meta.ownerId,
      video: this.meta.video,
      topic: this.meta.topic,
      requests: this.requests.slice(-20),
      playback: stale
        ? { isPlaying: false, time: 0, timestamp: now() }
        : {
            // Report the projected position (not the last action's frozen
            // time) so a freshly joined client lands on the current time.
            isPlaying: p.isPlaying,
            time: this.currentTime(),
            timestamp: now(),
          },
    };
  }

  // ---- Send / broadcast -----------------------------------------------------
  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  sendToPeer(peerId, obj) {
    for (const ws of this.ctx.getWebSockets()) {
      let attach = null;
      try {
        attach = ws.deserializeAttachment();
      } catch (_) {}
      if (attach && attach.peerId === peerId) {
        this.send(ws, obj);
        return;
      }
    }
  }

  broadcast(obj) {
    const text = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch (_) {}
    }
  }

  broadcastPeers() {
    const allowed = this.allowedSet();
    this.broadcast({
      type: MSG.PEERS,
      peers: this.sessions.slice(0, 50).map((p) => sanitizePeer(p, allowed)),
    });
  }

  broadcastSystem(text) {
    this.broadcast({
      id: makeId(),
      type: MSG.SYSTEM,
      text: sanitizeText(text).slice(0, 300),
      ts: now(),
    });
  }
}
