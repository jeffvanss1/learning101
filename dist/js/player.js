/* player.js — PlaybackSyncManager
 *
 * Bridges the room's authoritative playback clock to the embedded Bingr
 * player iframe. Implements the real Bingr Embed API:
 *
 *   iframe src:
 *     movie  -> https://bingr.one/watch/movie/{tmdbId}
 *     series -> https://bingr.one/watch/tv/{tmdbId}/{season}/{episode}
 *     anime  -> https://bingr.one/watch/anime/{anilistId}/{episode}
 *
 *   commands (posted to iframe.contentWindow):
 *     { command: "play" }
 *     { command: "pause" }
 *     { command: "seek",  time: seconds }
 *     { command: "volume", level: 0..1 }
 *     { command: "mute",  muted: true|false }
 *     { command: "getStatus" }
 *
 *   status events (from the iframe):
 *     message.data.type === "PLAYER_EVENT"
 *     message.data.data.event === "playerstatus"
 *       with data.data.currentTime / duration / playing
 *
 * Every client projects the room's (isPlaying, time, timestamp) tuple forward
 * in wall-clock time and nudges the local player whenever it drifts beyond a
 * tolerance, so everyone stays within ~a second of each other.
 */
(function (global) {
  'use strict';

  const DRIFT_TOLERANCE = 0.75; // seconds before nudging the local player
  const SEEK_THRESHOLD = 3.5; // seconds before forcing a hard seek
  const STATUS_POLL_MS = 3000;
  const READY_TIMEOUT_MS = 10000;

  class PlaybackSyncManager {
    constructor(iframeEl) {
      this.iframe = iframeEl;
      this.video = null;
      this.isOwner = false;
      this.localPlaying = false;
      this.localTime = 0;
      this.localUpdatedAt = 0;
      this.duration = null;
      this.isBuffering = false;
      this.ready = false;
      this._suppressed = 0;
      this._lastTarget = null;
      this._statusTimer = null;
      this._readyTimer = null;
      this._handlers = new Map();
      this._boundMessage = this._onWindowMessage.bind(this);
      window.addEventListener('message', this._boundMessage);
    }

    on(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, new Set());
      this._handlers.get(type).add(fn);
    }

    emit(type, payload) {
      const set = this._handlers.get(type);
      if (set) {
        for (const fn of set) {
          try {
            fn(payload);
          } catch (e) {
            console.error(e);
          }
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
      this.video = video || null;
      this.ready = false;
      this.localTime = 0;
      this.localPlaying = false;
      this.duration = null;
      this._lastTarget = null;
      this._stopPolling();
      this.emit('video', { video: this.video });

      if (!video || !video.src) return;
      // Changing the iframe src is how the Bingr player loads a title.
      this.iframe.src = video.src;
      this._armReadyTimer();
    }

    play(time) {
      if (time !== undefined && time !== null) this.seek(time);
      this.post({ command: 'play' });
      this.localPlaying = true;
      this.localUpdatedAt = Date.now();
    }

    pause(time) {
      if (time !== undefined && time !== null) this.seek(time);
      this.post({ command: 'pause' });
      this.localPlaying = false;
      this.localUpdatedAt = Date.now();
    }

    seek(time) {
      this.post({ command: 'seek', time: Number(time) || 0 });
      this.localTime = Number(time) || 0;
      this.localUpdatedAt = Date.now();
    }

    // ---- host actions (optimistic local apply + broadcast intent) ----------
    localPlay(time) {
      this.play(time !== undefined ? time : this.localTime);
      this.emit('control', { action: 'play', time: this.localTime });
    }

    localPause(time) {
      this.pause(time !== undefined ? time : this.localTime);
      this.emit('control', { action: 'pause', time: this.localTime });
    }

    localSeek(time) {
      this.seek(time);
      this.emit('control', { action: 'seek', time: this.localTime });
    }

    // ---- inbound protocol messages from the Durable Object ------------------
    handleServerMessage(msg) {
      switch (msg.type) {
        case 'state': {
          if (msg.video && msg.video.src && msg.video.src !== (this.video && this.video.src)) {
            this.loadVideo(msg.video);
          }
          if (msg.playback) this.applyRemote(msg.playback);
          break;
        }
        case 'videoChange': {
          this.loadVideo(msg.video);
          if (msg.playback) this.applyRemote(msg.playback);
          break;
        }
        case 'play':
          this.applyRemote({ isPlaying: true, time: msg.time, timestamp: msg.timestamp });
          break;
        case 'pause':
          this.applyRemote({ isPlaying: false, time: msg.time, timestamp: msg.timestamp });
          break;
        case 'seek':
          this.applyRemote({ isPlaying: this.localPlaying, time: msg.time, timestamp: msg.timestamp });
          break;
        default:
          break;
      }
    }

    estimate(msg) {
      const now = Date.now();
      let time = Number(msg.time) || 0;
      const timestamp = Number(msg.timestamp) || now;
      if (msg.isPlaying) time += (now - timestamp) / 1000;
      return { time: Math.max(0, time), isPlaying: !!msg.isPlaying };
    }

    applyRemote(msg) {
      const target = this.estimate(msg);
      this._lastTarget = target;

      // Ignore the echo of our own action for a beat.
      if (Date.now() - this._suppressed < 500) return;

      if (!this.ready) return; // apply once the player reports ready

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

    // ---- status events emitted by the embedded player -----------------------
    _onWindowMessage(ev) {
      if (ev.source !== (this.iframe && this.iframe.contentWindow)) return;
      const data = ev.data;
      if (!data || data.type !== 'PLAYER_EVENT') return;
      const d = data.data || {};

      switch (d.event) {
        case 'playerstatus':
          if (typeof d.currentTime === 'number') {
            this.localTime = d.currentTime;
            this.localUpdatedAt = Date.now();
          }
          if (typeof d.duration === 'number') this.duration = d.duration;
          if (typeof d.playing === 'boolean') this.localPlaying = d.playing;
          this.isBuffering = false;
          if (!this.ready) {
            this.ready = true;
            this._clearReadyTimer();
            this._startPolling();
            this.emit('ready', {});
            if (this._lastTarget) this.applyRemote(this._lastTarget);
          }
          this.emit('progress', {
            time: this.localTime,
            playing: this.localPlaying,
            duration: this.duration,
          });
          break;

        case 'ready':
        case 'loaded':
          this.ready = true;
          this._clearReadyTimer();
          this._startPolling();
          this.emit('ready', {});
          if (this._lastTarget) this.applyRemote(this._lastTarget);
          break;

        case 'play':
        case 'playing':
          this.localPlaying = true;
          this.isBuffering = false;
          this.emit('progress', {
            time: this.localTime,
            playing: true,
            duration: this.duration,
          });
          break;

        case 'pause':
        case 'paused':
          this.localPlaying = false;
          this.emit('progress', {
            time: this.localTime,
            playing: false,
            duration: this.duration,
          });
          break;

        case 'ended':
          this.localPlaying = false;
          this.emit('progress', {
            time: this.localTime,
            playing: false,
            duration: this.duration,
          });
          break;

        case 'buffering':
        case 'waiting':
        case 'stalled':
          this.isBuffering = true;
          this.emit('buffering', {});
          break;

        default:
          break;
      }
    }

    _requestStatus() {
      this.post({ command: 'getStatus' });
    }

    _startPolling() {
      this._stopPolling();
      this._statusTimer = setInterval(() => this._requestStatus(), STATUS_POLL_MS);
    }

    _stopPolling() {
      if (this._statusTimer) {
        clearInterval(this._statusTimer);
        this._statusTimer = null;
      }
    }

    _armReadyTimer() {
      this._clearReadyTimer();
      this._readyTimer = setTimeout(() => {
        if (!this.ready) {
          // The player never announced readiness (possible "Server 2"
          // fallback embed, which does not support remote control).
          this.emit('unavailable', {});
          this._requestStatus();
        }
      }, READY_TIMEOUT_MS);
    }

    _clearReadyTimer() {
      if (this._readyTimer) {
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
      }
    }

    destroy() {
      this._clearReadyTimer();
      this._stopPolling();
      window.removeEventListener('message', this._boundMessage);
    }
  }

  global.WP.PlaybackSyncManager = PlaybackSyncManager;
})(window);
