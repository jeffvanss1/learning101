/* player.js — PlaybackSyncManager
 *
 * Wraps the embedded player iframe (`https://embed.bingr.one/`) and keeps every
 * client locked to the room's authoritative playback clock broadcast by the
 * WatchRoom Durable Object.
 *
 * Because the player is a cross-origin iframe, control is done via the
 * standard postMessage protocol understood by HTML5 players:
 *   -> { type: 'load', url }
 *   -> { type: 'play' } / { type: 'pause' } / { type: 'seek', time }
 *   <- { type: 'time', time, playing } / { type: 'ready' } / ...
 * If a provider exposes other commands (seekTo / setCurrentTime / playVideo…)
 * we send those as graceful fallbacks so a variety of players can cooperate.
 */
(function (global) {
  'use strict';

  const DRIFT_TOLERANCE = 0.75; // seconds before we nudge the local player
  const SEEK_THRESHOLD = 3.5; // seconds before we force a hard seek
  const READY_TIMEOUT = 9000;

  class PlaybackSyncManager {
    constructor(iframeEl) {
      this.iframe = iframeEl;
      this.video = null;
      this.isOwner = false;
      this.localPlaying = false;
      this.localTime = 0;
      this.localUpdatedAt = 0;
      this.latency = 0; // smoothed RTT, seconds
      this.isBuffering = false;
      this.ready = false;
      this._readyTimer = null;
      this._lastSyncAt = 0;
      this._suppressed = 0;
      this._localTimer = null;
      this._handlers = new Map();
      this._outbound = [];
      this._lastTarget = null;
      this._boundMessage = this._onWindowMessage.bind(this);
      window.addEventListener('message', this._boundMessage);
    }

    on(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, new Set());
      this._handlers.get(type).add(fn);
    }

    emit(type, payload) {
      const set = this._handlers.get(type);
      if (set) for (const fn of set) {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      }
    }

    // ---- control messages to the iframe ------------------------------------
    post(msg) {
      if (!this.iframe || !this.iframe.contentWindow) return;
      try {
        this.iframe.contentWindow.postMessage(msg, '*');
      } catch (_) {}
    }

    loadVideo(video) {
      this.video = video;
      this.ready = false;
      this.localTime = 0;
      this.localPlaying = false;
      this.emit('video', { video });
      if (!video || !video.id) return;
      this.post({ type: 'load', url: video.id });
      this._armReadyTimer();
    }

    play(time) {
      if (time !== undefined) {
        this.post({ type: 'seek', time });
        this.post({ type: 'seekTo', time });
        this.post({ type: 'setCurrentTime', time });
        this.localTime = time;
      }
      this.post({ type: 'play' });
      this.localPlaying = true;
    }

    pause(time) {
      if (time !== undefined) {
        this.post({ type: 'seek', time });
        this.post({ type: 'seekTo', time });
        this.post({ type: 'setCurrentTime', time });
        this.localTime = time;
      }
      this.post({ type: 'pause' });
      this.localPlaying = false;
    }

    seek(time) {
      this.post({ type: 'seek', time });
      this.post({ type: 'seekTo', time });
      this.post({ type: 'setCurrentTime', time });
      this.localTime = time;
      this.localUpdatedAt = Date.now();
    }

    // ---- inbound protocol messages from the Durable Object ------------------
    handleServerMessage(msg) {
      switch (msg.type) {
        case 'state': {
          if (msg.playback) this.applyRemote(msg.playback);
          if (msg.video && msg.video.id && msg.video.id !== (this.video && this.video.id)) {
            this.loadVideo(msg.video);
          }
          break;
        }
        case 'videoChange': {
          this.loadVideo(msg.video);
          if (msg.playback) this.applyRemote(msg.playback);
          break;
        }
        case 'play':
          this.applyRemote({
            isPlaying: true,
            time: msg.time,
            timestamp: msg.timestamp,
          });
          break;
        case 'pause':
          this.applyRemote({
            isPlaying: false,
            time: msg.time,
            timestamp: msg.timestamp,
          });
          break;
        case 'seek':
          this.applyRemote({
            isPlaying: this.localPlaying,
            time: msg.time,
            timestamp: msg.timestamp,
          });
          break;
        default:
          break;
      }
    }

    /** Estimate the room's current playback position. */
    estimate(msg) {
      const now = Date.now();
      let time = Number(msg.time) || 0;
      const timestamp = Number(msg.timestamp) || now;
      if (msg.isPlaying) {
        time += (now - timestamp) / 1000;
      }
      return { time: Math.max(0, time), isPlaying: !!msg.isPlaying };
    }

    applyRemote(msg) {
      const target = this.estimate(msg);
      this._lastTarget = target;

      // Ignore echoes of our own actions for a beat.
      if (Date.now() - this._suppressed < 500) return;

      if (!this.ready) {
        // Player not ready yet — remember the target for when it loads.
        return;
      }

      const drift = target.time - this.localTime;
      const absDrift = Math.abs(drift);

      if (target.isPlaying) {
        if (!this.localPlaying) {
          this.play(this.isBuffering ? undefined : target.time);
        } else if (absDrift > SEEK_THRESHOLD) {
          this.seek(target.time);
        } else if (absDrift > DRIFT_TOLERANCE) {
          this.seek(target.time);
        }
      } else {
        if (this.localPlaying) {
          this.pause(target.time);
        } else if (absDrift > SEEK_THRESHOLD) {
          this.seek(target.time);
        }
      }
    }

    /** Apply a local action from the host; broadcast intent to the server. */
    localPlay(time) {
      this.localPlaying = true;
      this.localUpdatedAt = Date.now();
      if (time !== undefined) this.localTime = time;
      this.emit('control', { action: 'play', time: this.localTime });
    }

    localPause(time) {
      this.localPlaying = false;
      this.localUpdatedAt = Date.now();
      if (time !== undefined) this.localTime = time;
      this.emit('control', { action: 'pause', time: this.localTime });
    }

    localSeek(time) {
      this.localTime = time;
      this.localUpdatedAt = Date.now();
      this.emit('control', { action: 'seek', time });
    }

    // ---- messages coming back from the embedded player ----------------------
    _onWindowMessage(ev) {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;

      // Only trust messages originating from the iframe we embedded.
      if (
        ev.source !== (this.iframe && this.iframe.contentWindow) &&
        !(data.__wpBridge === true)
      ) {
        return;
      }

      const type = data.type;

      if (type === 'ready' || type === 'loaded' || type === 'playerReady') {
        this.ready = true;
        this._clearReadyTimer();
        if (this.video) this.post({ type: 'load', url: this.video.id });
        if (this._lastTarget) this.applyRemote(this._lastTarget);
        this.emit('ready', {});
        return;
      }

      if (type === 'buffering' || type === 'waiting' || type === 'stalled') {
        this.isBuffering = true;
        this.emit('buffering', {});
        return;
      }

      if (type === 'playing' || type === 'timeupdate' || type === 'time') {
        this.isBuffering = false;
        if (typeof data.time === 'number') {
          this.localTime = data.time;
          this.localUpdatedAt = Date.now();
        }
        if (typeof data.playing === 'boolean') this.localPlaying = data.playing;
        else if (type === 'playing') this.localPlaying = true;
        else if (data.paused === true) this.localPlaying = false;
        else if (data.ended === true) this.localPlaying = false;
        this.emit('progress', {
          time: this.localTime,
          playing: this.localPlaying,
          duration: data.duration,
        });
        return;
      }

      if (type === 'pause' || type === 'paused') {
        this.isBuffering = false;
        this.localPlaying = false;
        if (typeof data.time === 'number') this.localTime = data.time;
        this.localUpdatedAt = Date.now();
        this.emit('progress', { time: this.localTime, playing: false });
        return;
      }
    }

    _armReadyTimer() {
      this._clearReadyTimer();
      this._readyTimer = setTimeout(() => {
        // Assume the player is usable even if it never announces readiness.
        if (!this.ready) {
          this.ready = true;
          if (this._lastTarget) this.applyRemote(this._lastTarget);
        }
      }, READY_TIMEOUT);
    }

    _clearReadyTimer() {
      if (this._readyTimer) {
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
      }
    }

    destroy() {
      this._clearReadyTimer();
      window.removeEventListener('message', this._boundMessage);
      if (this._localTimer) clearInterval(this._localTimer);
    }
  }

  global.WP.PlaybackSyncManager = PlaybackSyncManager;
})(window);
