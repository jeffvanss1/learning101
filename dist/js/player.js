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
  const PAUSE_ASSERT_MS = 2500; // min gap between pause re-asserts (anti-loop)

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
      this._lastMsg = null;
      this._iframeLoaded = false;
      this._lastPauseAssert = 0;
      this._statusTimer = null;
      this._readyTimer = null;
      this._syncTimer = null;
      this._handlers = new Map();
      this._boundMessage = this._onWindowMessage.bind(this);
      this._boundIframeLoad = this._onIframeLoad.bind(this);
      window.addEventListener('message', this._boundMessage);
      if (this.iframe) this.iframe.addEventListener('load', this._boundIframeLoad);
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
      this._lastMsg = null;
      this._clearSyncTimer();
      this._stopPolling();
      this.emit('video', { video: this.video });

      if (!video || !video.src) {
        this._iframeLoaded = false;
        return;
      }

      // Changing the iframe src is how the Bingr player loads a title.
      const sameSrc = this.iframe && this.iframe.getAttribute('src') === video.src;
      if (sameSrc) {
        // Already loaded; nothing to reload. Re-apply any pending target.
        this._iframeLoaded = true;
        this._startPolling();
        this._syncToTarget();
      } else {
        this._iframeLoaded = false;
        this.iframe.src = video.src;
        this._armReadyTimer();
      }
    }

    // The embed page finished loading. The Bingr player does NOT autoplay on
    // its own — it sits at "click to play" until we drive it — so this is the
    // moment to apply the room's play/seek state for a joining client.
    _onIframeLoad() {
      this._iframeLoaded = true;
      this._startPolling(); // learn status even if it never announces ready
      if (this._lastMsg) {
        // Give the player a beat to finish booting, then sync.
        this._scheduleSync(300);
      }
    }

    play(time) {
      this._seekTo(time);
      this.post({ command: 'play' });
      this.localPlaying = true;
      this.localUpdatedAt = Date.now();
    }

    pause() {
      // Pause in place — do NOT seek. A seek around a pause makes some
      // players resume playback, which turned one host pause into an endless
      // "pausing every second" loop on remote clients.
      this.post({ command: 'pause' });
      this.localPlaying = false;
      this.localUpdatedAt = Date.now();
    }

    seek(time) {
      this.post({ command: 'seek', time: Number(time) || 0 });
      this.localTime = Number(time) || 0;
      this.localUpdatedAt = Date.now();
    }

    // Seek only when the target is meaningfully different from where we are.
    // A "seek" to the current position can make some players resume playback,
    // which broke pause sync on remote clients.
    _seekTo(time) {
      const t = Number(time);
      if (Number.isFinite(t) && Math.abs(t - this.localTime) > 0.5) {
        this.seek(t);
      }
    }

    // ---- host actions (optimistic local apply + broadcast intent) ----------
    localPlay(time) {
      this.play(time !== undefined ? time : this.localTime);
      this.emit('control', { action: 'play', time: this.localTime });
    }

    localPause() {
      this.pause();
      this.emit('control', { action: 'pause', time: this.localTime });
    }

    localSeek(time) {
      this.seek(time);
      this.emit('control', { action: 'seek', time: this.localTime });
    }

    // ---- inbound protocol messages from the Durable Object ------------------
    handleServerMessage(msg) {
      switch (msg.type) {
        case 'state':
        case 'videoChange': {
          if (msg.video && msg.video.src && msg.video.src !== (this.video && this.video.src)) {
            this.loadVideo(msg.video);
          }
          if (msg.playback) this.applyRemote(msg.playback);
          break;
        }
        case 'play':
        case 'pause':
        case 'seek':
          // Every playback broadcast carries the authoritative `playback`
          // tuple from the server. Use it so an incoming seek can never
          // overwrite the room's play/pause state with our (possibly stale)
          // local state — that made joins look like a pause for everyone.
          this.applyRemote(msg.playback || {
            isPlaying: msg.type === 'play',
            time: msg.time,
            timestamp: msg.timestamp,
          });
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
      // Keep the RAW message (with its timestamp) so the target is re-projected
      // against the current wall clock whenever we actually apply it — a
      // joiner's player can take seconds to load, and freezing the position at
      // join time left it behind the rest of the room.
      this._lastMsg = msg;
      if (Date.now() - this._suppressed < 500) return;
      this._syncToTarget();
    }

    // Converge the local player onto the room's authoritative target. Safe to
    // call repeatedly (status polls, iframe load, follow-up timers): play is
    // only sent when we think we're paused (so it self-stops once playing),
    // and pause re-asserts are throttled so they can never loop.
    _syncToTarget() {
      const msg = this._lastMsg;
      if (!msg || !this._iframeLoaded) return;
      const target = this.estimate(msg);
      const absDrift = Math.abs(target.time - this.localTime);

      if (target.isPlaying) {
        // Autoplay a joiner: seek into position first, then resume. A
        // redundant play is harmless, so always assert it when we're not
        // already playing.
        if (absDrift > DRIFT_TOLERANCE && !this.isBuffering) {
          this.seek(target.time);
          this._scheduleSync(600); // re-check once the seek settles
        }
        if (!this.localPlaying) this.play();
      } else {
        if (absDrift > SEEK_THRESHOLD && !this.isBuffering) {
          this.seek(target.time);
          this._scheduleSync(600);
        }
        // Pause a joiner landing in a paused room — throttled against loops.
        if (this.localPlaying && Date.now() - this._lastPauseAssert > PAUSE_ASSERT_MS) {
          this.pause();
          this._lastPauseAssert = Date.now();
        }
      }
    }

    _scheduleSync(delay) {
      this._clearSyncTimer();
      this._syncTimer = setTimeout(() => {
        this._syncTimer = null;
        this._syncToTarget();
      }, delay);
    }

    _clearSyncTimer() {
      if (this._syncTimer) {
        clearTimeout(this._syncTimer);
        this._syncTimer = null;
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
          }
          // Every status report is a chance to converge: recovers a play/seek
          // command that raced a seek, and heals a joiner that got stuck.
          this._syncToTarget();
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
          this._syncToTarget();
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
          // Still try to drive the target once — the iframe may be loaded
          // even if it never emits a status event.
          this._syncToTarget();
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
      this._clearSyncTimer();
      this._stopPolling();
      window.removeEventListener('message', this._boundMessage);
      if (this.iframe) this.iframe.removeEventListener('load', this._boundIframeLoad);
    }
  }

  global.WP.PlaybackSyncManager = PlaybackSyncManager;
})(window);
