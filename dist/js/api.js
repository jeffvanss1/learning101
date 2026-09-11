/* api.js — REST + WebSocket client for the WatchParty backend */
(function (global) {
  'use strict';

  const RECONNECT_BASE = 800;
  const RECONNECT_MAX = 15000;
  const RECONNECT_JITTER = 300;

  class RoomClient {
    constructor(roomId) {
      this.roomId = roomId;
      this.ws = null;
      this.connected = false;
      this.attempts = 0;
      this.closedByUser = false;
      this._handlers = new Map();
      this._reconnectTimer = null;
      this._pingTimer = null;
    }

    on(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, new Set());
      this._handlers.get(type).add(fn);
      return () => this.off(type, fn);
    }

    off(type, fn) {
      const set = this._handlers.get(type);
      if (set) set.delete(fn);
    }

    emit(type, payload) {
      const set = this._handlers.get(type);
      if (set) for (const fn of set) {
        try {
          fn(payload);
        } catch (e) {
          console.error('handler error', e);
        }
      }
    }

    wsUrl() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws?room=${encodeURIComponent(this.roomId)}`;
    }

    connect(name) {
      this.closedByUser = false;
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
        return;
      }
      const url = this.wsUrl();
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        this.connected = true;
        this.attempts = 0;
        this.emit('open', {});
        // Introduce ourselves once the socket is up.
        this.send({
          type: 'join',
          name: name || '',
          video: (global.__wpCurrentVideo) || null,
        });
        this._startPing();
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (!msg || !msg.type) return;
        if (msg.type === 'pong') return;
        this.emit('message', msg);
        this.emit(msg.type, msg);
      });

      ws.addEventListener('close', (ev) => {
        this.connected = false;
        this._stopPing();
        this.emit('close', ev);
        if (!this.closedByUser) this._scheduleReconnect(name);
      });

      ws.addEventListener('error', () => {
        // `close` always follows; nothing extra to do here.
      });
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        this.send({ type: 'ping', ts: Date.now() });
      }, 25000);
    }

    _stopPing() {
      if (this._pingTimer) {
        clearInterval(this._pingTimer);
        this._pingTimer = null;
      }
    }

    _scheduleReconnect(name) {
      if (this._reconnectTimer) return;
      const delay = Math.min(
        RECONNECT_BASE * Math.pow(2, this.attempts),
        RECONNECT_MAX
      ) + Math.floor(Math.random() * RECONNECT_JITTER);
      this.attempts += 1;
      this.emit('reconnecting', { delay });
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this.connect(name);
      }, delay);
    }

    close() {
      this.closedByUser = true;
      this._stopPing();
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this.ws) {
        try {
          this.ws.close(1000, 'bye');
        } catch (_) {}
        this.ws = null;
      }
      this.connected = false;
    }
  }

  async function apiCreateRoom() {
    const res = await fetch('/api/rooms');
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      throw new Error(data.error || 'Failed to create room');
    }
    return data;
  }

  async function apiGetRoom(roomId) {
    const res = await fetch(`/api/room/${encodeURIComponent(roomId)}`);
    if (!res.ok) {
      let msg = 'Room not found';
      try {
        const d = await res.json();
        if (d.error) msg = d.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  }

  global.WP.RoomClient = RoomClient;
  global.WP.apiCreateRoom = apiCreateRoom;
  global.WP.apiGetRoom = apiGetRoom;
})(window);
