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
//   - NEW: forwards per-user `presenceSync` messages into the KV presence
//     engine (src/presence.ts) and clears presence when a peer disconnects,
//     so "currently watching" state survives room churn without any client
//     polling.
//
// No `socket.io`, no Node-only dependencies.

import { verifyToken } from './auth.js';
import { setPresence, clearPresenceIfRoom } from './presence.js';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
// Presence refresh cadence for the DO alarm (server-side, client-independent).
// 5 min: with the 1h TTL this is 12 writes/day/user — KV free tier is
// 1,000 writes/DAY TOTAL, so per-beat writes were never survivable.
export const PRESENCE_ALARM_MS = 5 * 60_000;
// The 20s socket beat updates the DO session (free), NOT KV. KV is written
// on join/status-change, or at most this often per session otherwise:
const PRESENCE_KV_MIN_GAP_MS = 4 * 60_000;

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
  SUBS: 'subs',
  PING: 'ping',
  PONG: 'pong',
  PRESENCE_SYNC: 'presenceSync',
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

/** Chat-clock format: h:mm:ss (>= 1h) or m:ss. */
function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
    : m + ':' + String(r).padStart(2, '0');
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
    anilistId: sanitizeNum(v.anilistId),
    src: sanitizeText(v.src).slice(0, 600),
    title: sanitizeText(v.title).slice(0, 300),
    poster: sanitizeText(v.poster || v.thumb).slice(0, 600),
    backdrop: sanitizeText(v.backdrop).slice(0, 600),
    thumb: sanitizeText(v.thumb || v.poster).slice(0, 600),
    year: sanitizeText(v.year).slice(0, 20),
    season: sanitizeNum(v.season),
    episode: sanitizeNum(v.episode),
    rating: sanitizeNum(v.rating),
    overview: sanitizeText(v.overview).slice(0, 1000),
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
    this.subs = undefined;
  }

  // ---- Lifecycle / state ---------------------------------------------------
  async ensureLoaded() {
    if (this.meta !== undefined) return;
    const [meta, chat, playback, sessions, requests, subs] = await Promise.all([
      this.storage.get('meta'),
      this.storage.get('chat'),
      this.storage.get('playback'),
      this.storage.get('sessions'),
      this.storage.get('requests'),
      this.storage.get('subs'),
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
    // Host's last subtitle choice: replicated to joiners (fileId + label).
    this.subs = subs && typeof subs === 'object' ? subs : null;

    // SERVER-SIDE presence refresh: client timers are throttled in hidden
    // tabs (Chrome intensive throttling: 1 run / 5min), so presence beats
    // stop and watching users showed OFFLINE. The DO keeps the sockets
    // alive regardless — let IT refresh presence via alarms (60s cadence,
    // persisted payloads survive hibernation).
    if (this.sessions.some((s) => s.userId) && (await this.ctx.storage.getAlarm()) === null) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
      } catch (_) {}
    }
  }

  async persist() {
    await this.storage.put({
      meta: this.meta,
      chat: this.chat.slice(-MAX_CHAT),
      playback: this.playback,
      sessions: this.sessions,
      requests: this.requests.slice(-MAX_REQUESTS),
      subs: this.subs || null,
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
      // Unknown session, but the attachment may still carry a presence
      // identity — clear it best-effort so nothing goes stale.
      if (attach && attach.userId) {
        try {
          await clearPresenceIfRoom(this.env, attach.userId, this.meta.id);
        } catch (_) {}
      }
      try {
        ws.close(1000, 'bye');
      } catch (_) {}
      return;
    }
    // splice also drops peer.presence: the alarm stops refreshing leavers.
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

    // Presence teardown on disconnect. Only clear when the stored state still
    // points at THIS room — the same user may have joined another room from a
    // second tab, and we must not erase that. Also skip the clear when OTHER
    // live sockets of the same user remain here (two tabs, one room): the
    // room is still active for them.
    const presenceUserId = peer.userId || (attach && attach.userId);
    if (presenceUserId) {
      let sameUserLeft = 0;
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        try {
          const a = other.deserializeAttachment();
          if (a && a.userId === presenceUserId) sameUserLeft++;
        } catch (_) {}
      }
      if (sameUserLeft === 0) {
        try {
          await clearPresenceIfRoom(this.env, presenceUserId, this.meta.id);
        } catch (_) {}
      }
    }
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
        // LIVE-OWNER TEST (not `!meta.ownerId`): a persisted owner id whose
        // session/socket is gone must not keep the room hostage — the old
        // `!this.meta.ownerId && !this.hasLiveOwner()` short-circuited to
        // `!this.meta.ownerId`, so a stale id blocked promotion FOREVER and
        // every play/pause/seek was silently dropped for everyone.
        const becameOwner = !this.hasLiveOwner();

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
        // A new video invalidates the previous subtitle file (it belongs to
        // the OLD title/episode - serving it to new joiners showed wrong or
        // dead subs). The host's client auto-loads the new video's subs and
        // broadcasts a fresh SUBS load.
        this.subs = undefined;
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
        const rawT = Number(msg.time);
        // A message without a usable time keeps the CURRENT position —
        // a raw clampTime(undefined) snapped the room back to 0.
        const t = Number.isFinite(rawT) ? this.clampTime(rawT) : this.playback.time;
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
        if (this.shouldLogPlayback('play')) {
          this.logSystem('\u25b6\ufe0f ' + (peer.name || 'Host') + ' resumed the movie');
        }
        dirty = true;
        break;
      }

      case MSG.PAUSE: {
        if (!this.canControl(peer)) break;
        const rawT = Number(msg.time);
        // A message without a usable time keeps the CURRENT position —
        // a raw clampTime(undefined) snapped the room back to 0.
        const t = Number.isFinite(rawT) ? this.clampTime(rawT) : this.playback.time;
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
        if (this.shouldLogPlayback('pause')) {
          this.logSystem('\u23f8\ufe0f ' + (peer.name || 'Host') + ' paused the movie');
        }
        dirty = true;
        break;
      }

      case MSG.SUBS: {
        // Host-authoritative subtitles: what the host loads/matches, the room
        // inherits. Guests keep local override freedom (client-side).
        if (!this.canControl(peer)) break;
        if (msg.action === 'load') {
          const label = sanitizeText(msg.label || '').slice(0, 140);
          const fileId = sanitizeText(msg.fileId || '').slice(0, 300);
          // DUPLICATE LOAD GUARD: two controllers auto-loading (or one
          // re-running) used to broadcast twice-plus; the LAST broadcast
          // won and could flip the room's language (id -> en). Same file
          // again = nothing new: refresh the timestamp only.
          if (this.subs && this.subs.fileId && this.subs.fileId === fileId) {
            this.subs.ts = now();
            break;
          }
          this.subs = { fileId: fileId, label: label, ts: now() };
          this.logSystem(
            '\ud83c\udf9f\ufe0f ' + (peer.name || 'Host') + ' loaded subtitles' + (label ? ': ' + label : '')
          );
          this.broadcast({ type: MSG.SUBS, action: 'load', fileId: fileId, label: label, by: peer.id });
          dirty = true;
        } else if (msg.action === 'offset') {
          const v = Number(msg.value);
          if (!isFinite(v) || Math.abs(v) > 3600) break;
          this.subs = {
            fileId: (this.subs && this.subs.fileId) || '',
            label: (this.subs && this.subs.label) || '',
            offset: v,
            ts: now(),
          };
          this.broadcast({ type: MSG.SUBS, action: 'offset', value: v, by: peer.id });
          dirty = true;
        }
        break;
      }

      case MSG.SEEK: {
        if (!this.canControl(peer)) break;
        const rawT = Number(msg.time);
        // A message without a usable time keeps the CURRENT position —
        // a raw clampTime(undefined) snapped the room back to 0.
        const t = Number.isFinite(rawT) ? this.clampTime(rawT) : this.playback.time;
        this.playback.time = t;
        this.playback.timestamp = now();
        // Seek log lands in the PERSISTED chat (late joiners see it too).
        // Dedupe scrub bursts: rapid seeks to ~the same spot stay silent,
        // a genuinely different target always logs.
        const lastSeek = this._lastSeekLog;
        // 4s window: a convergence fight re-seeks every 1-3s - the old 1.5s
        // window let that flood the persisted chat.
        if (!lastSeek || now() - lastSeek.at > 4000 || Math.abs(t - lastSeek.time) > 2) {
          this._lastSeekLog = { at: now(), time: t };
          this.logSystem('\u23e9 ' + (peer.name || 'Host') + ' seeked to ' + fmtClock(t));
        }
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

      case MSG.PRESENCE_SYNC:
        await this.handlePresenceSync(ws, peer, msg);
        break;

      default:
        break;
    }

    if (dirty) await this.persist();
  }

  // ---- Presence forwarding ---------------------------------------------------
  // The room socket is the authoritative presence writer: clients push
  // `presenceSync` (identity + playback progress) every ~20s and on playback
  // changes; we verify the session token (no spoofing other users), stamp the
  // server-side room id + host flag, and persist to KV with a short TTL.
  async handlePresenceSync(ws, peer, msg) {
    if (!this.env || !this.env.PRESENCE_KV) return; // engine not bound (shouldn't happen)
    let userId = null;
    try {
      const claims = await verifyToken(this.env, String(msg.token || ''));
      if (claims && claims.sub && String(msg.userId || '') === claims.sub) {
        userId = claims.sub;
      }
    } catch (_) {}
    if (!userId) {
      // Anonymous viewers carry no presence — a bad token is silently ignored.
      return;
    }

    // Remember the identity on both the session (storage) and the socket
    // attachment (hibernation) so disconnects can clear presence.
    if (peer.userId !== userId) {
      peer.userId = userId;
      await this.persist();
    }
    try {
      const attach = ws.deserializeAttachment();
      if (!attach || attach.userId !== userId) {
        ws.serializeAttachment({ ...(attach || {}), peerId: peer.id, userId });
      }
    } catch (_) {}

    const watching = msg.status === 'WATCHING_PARTY' || msg.status === 'WATCHING_SOLO';
    // Capture BEFORE overwriting: the KV budget check below compares the new
    // beat against the previous payload (join/status-change = write, else skip).
    const prevPresence = peer.presence;
    // Remember what the alarm must keep alive (persisted on the session:
    // survives DO hibernation, unlike any in-memory map).
    peer.presence = {
      status: watching ? msg.status : 'IDLE',
      room_id: watching ? this.meta.id : '',
      media_title: watching ? msg.media_title : '',
      media_id: watching ? msg.media_id : '',
      current_timestamp_seconds: msg.current_timestamp_seconds,
    };
    await this.persist();
    // Self-healing chain: a beat arriving on an alarm-less DO (post-deploy
    // hibernated sessions carried no payload) must (re)arm the refresh.
    try {
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
      }
    } catch (_) {}
    // KV WRITE BUDGET: socket beats are 20s and KV free tier is 1,000
    // writes/DAY — per-beat writes burnt the quota before noon. Write KV
    // only on JOIN (first beat) or a STATUS/MEDIA change; the alarm keeps
    // it fresh (5-min cadence) otherwise.
    const nextPresence = {
      status: watching ? msg.status : 'IDLE',
      room_id: watching ? this.meta.id : '',
      media_title: watching ? msg.media_title : '',
      media_id: watching ? msg.media_id : '',
      current_timestamp_seconds: msg.current_timestamp_seconds,
    };
    const fieldsChanged =
      !prevPresence ||
      prevPresence.status !== nextPresence.status ||
      prevPresence.media_id !== nextPresence.media_id ||
      prevPresence.room_id !== nextPresence.room_id;
    const nowMs = Date.now();
    if (fieldsChanged || !peer._kvWroteAt || nowMs - peer._kvWroteAt > PRESENCE_KV_MIN_GAP_MS) {
      peer._kvWroteAt = nowMs;
      await setPresence(
        this.env,
        userId,
        {
          ...nextPresence,
          // The DO decides who hosts — never trust the client's flag.
          is_host: this.isOwner(peer),
        },
        { authoritativeRoom: true }
      );
    }
  }

  /**
   * Server-side presence refresh (DO alarm): re-puts every identified
   * session's presence so hidden-tab throttling can NEVER let a watching
   * user expire. Runs regardless of what the clients' timers are doing.
   */
  async alarm() {
    await this.ensureLoaded();
    if (!this.env || !this.env.PRESENCE_KV) return;

    // LIVENESS PASS: the runtime's live-socket list is the truth. A session
    // whose socket is gone (laptop slept, app killed, close frame lost) is a
    // GHOST — the refresh loop below would otherwise renew its WATCHING
    // presence every 5 min FOREVER ("user watching is stuck even they already
    // left"). webSocketClose covers the polite path; this covers the impolite
    // ones within one alarm tick.
    //
    // EVERY ghost is pruned, anonymous ones included: an anonymous ghost used
    // to stay in the roster forever (and the owner's ghost kept the host badge
    // and blocked all promotion, see hasLiveOwner).
    const livePeerIds = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const a = ws.deserializeAttachment();
        if (a && a.peerId) livePeerIds.add(a.peerId);
      } catch (_) {}
    }
    let pruned = false;
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (livePeerIds.has(s.id)) continue;
      this.sessions.splice(i, 1);
      pruned = true;
      if (s.userId) {
        try {
          await clearPresenceIfRoom(this.env, s.userId, this.meta.id);
        } catch (_) {}
      }
    }
    if (pruned) await this.persist();

    // OWNERSHIP RECOVERY: pruning the ghost that held ownership (or any stale
    // ownerId left by a redeploy) used to leave meta.ownerId pointing at a
    // peer that no longer exists — isOwner() was false for everybody, so
    // play/pause/seek/videoChange were all dropped and no joiner could ever be
    // promoted. Hand the room to the oldest live peer instead.
    if (this.meta.ownerId && !this.hasLiveOwner()) {
      await this.transferOwnership();
    }

    const alive = this.sessions.filter((s) => s.userId && s.presence);
    for (const s of alive) {
      try {
        await setPresence(
          this.env,
          s.userId,
          {
            status: s.presence.status,
            room_id: s.presence.room_id,
            media_title: s.presence.media_title,
            media_id: s.presence.media_id,
            current_timestamp_seconds: s.presence.current_timestamp_seconds,
            is_host: this.isOwner(s),
          },
          { authoritativeRoom: true }
        );
      } catch (_) {}
    }
    // Keep the beat while ANY identified session remains — sessions from
    // before the payload field existed have no `presence` yet; killing the
    // chain here made offline state STICKY until the next deploy.
    if (this.sessions.some((s) => s.userId)) {
      try {
        await this.ctx.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
      } catch (_) {}
    }
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

  /**
   * Is the room's owner actually CONNECTED? Liveness comes from the runtime's
   * socket list (authoritative, and survives hibernation) — a persisted
   * session whose socket died must not count: it would leave the room with a
   * "host" that cannot act and no one able to take over.
   */
  hasLiveOwner() {
    if (!this.meta.ownerId) return false;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const a = ws.deserializeAttachment();
        if (a && a.peerId === this.meta.ownerId) return true;
      } catch (_) {}
    }
    return false;
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
      subs: this.subs || null,
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

  // System line that ALSO lands in the chat history (broadcastSystem is
  // ephemeral — late joiners would never see "Host paused the movie").
  logSystem(text) {
    const item = {
      id: makeId(),
      type: MSG.SYSTEM,
      text: sanitizeText(text).slice(0, 300),
      ts: now(),
    };
    this.chat.push(item);
    if (this.chat.length > MAX_CHAT) this.chat = this.chat.slice(-MAX_CHAT);
    this.broadcast(item);
  }

  // Pause/play log dedupe (player re-asserts must not spam the chat).
  shouldLogPlayback(action) {
    const t = now();
    if (this._lastPlayLog && this._lastPlayLog.action === action && t - this._lastPlayLog.at < 2000) {
      return false;
    }
    this._lastPlayLog = { action: action, at: t };
    return true;
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
