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
 *     { command: "play" }    { command: "pause" }
 *     { command: "seek", time: seconds }
 *     { command: "volume", level: 0..1 }  { command: "mute", muted: bool }
 *     { command: "getStatus" }
 *
 *   status events (from the iframe):
 *     message.data.type === "PLAYER_EVENT"
 *     message.data.data.event === "playerstatus"
 *       with data.data.currentTime / duration / playing
 *
 * ---------------------------------------------------------------------------
 * Model (single source of truth):
 *
 *   The SERVER owns the room's (isPlaying, time, timestamp). The controller
 *   (host, or a guest granted controls) changes it only via explicit actions
 *   (play / pause / seek / videoChange). Every client — controller included —
 *   converges its local player onto that server clock:
 *
 *     1. while the iframe is loading, nothing is sent (the player isn't
 *        ready to accept commands yet);
 *     2. once the iframe has loaded (the `load` event ALWAYS fires — and the
 *        Bingr player does not autoplay on its own), we seek into position
 *        and then play, so a joiner autoplays in sync;
 *     3. on every player status report we re-converge: seek if we are more
 *        than a tolerance away, and match play/pause state. Play is
 *        idempotent (re-asserted only while we're not playing), and pause is
 *        throttled, so neither can loop.
 *
 *   The player's own internal play/pause is never mirrored back to the server
 *   (that was the source of "the host pauses itself"): only explicit room
 *   controls change the room state.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  const DRIFT_TOLERANCE = 0.75; // seconds before nudging the local player
  const SEEK_THRESHOLD = 3.5; // seconds before forcing a hard seek (paused rooms)
  const STATUS_POLL_MS = 3000;
  const READY_TIMEOUT_MS = 10000;
  const PAUSE_ASSERT_MS = 2500; // min gap between pause re-asserts (anti-loop)
  const NATIVE_SEEK_THRESHOLD = 1.2; // seconds of unexplained time jump = user dragged the native bar
  const CONTROL_DEBOUNCE_MS = 400; // in-player state must persist this long to mirror
  const MIRROR_PAUSE_CONFIRMATIONS = 2; // a PAUSE needs 2 independent observations to mirror
  const MIRROR_PAUSE_MIN_AGE_MS = 500; // ... and must stay changed at least this long
  const START_LATCH_MS = 8000; // after OUR play command, a pause is boot-lag for this long
  const MIRROR_BUFFERING_QUIET_MS = 1500; // pause mirror needs this much buffering-free runway
  const CONTROL_SUPPRESS_MS = 1200; // ignore mirror right after our own command
  const REMOTE_ECHO_GUARD_MS = 1500; // the player's DELAYED status echo must never be mirrored
  const FRESH_ASSERT_MS = 1800; // window in which a fresh remote state may re-assert (dropped commands)

  class PlaybackSyncManager {
    constructor(iframeEl) {
      this.iframe = iframeEl;
      this.video = null;
      this.isOwner = false;
      this.localPlaying = false;
      this.localTime = 0;
      this._endedFired = false; // fresh video: end detection re-arms
      this.localUpdatedAt = 0;
      this.duration = null;
      this.isBuffering = false;
      this._lastBufferingAt = 0; // last buffering/waiting/stalled event (stalls are not user pauses)
      this.ready = false;
      this.isController = false; // set by app.js when this client can drive playback
      this._lastMsg = null; // latest authoritative playback tuple (with timestamp)
      this._awaitingStart = false; // we commanded play; the embed has not confirmed playing yet
      this._playCmdAt = 0; // when we commanded play (bounds the start latch)
      this.selfName = ''; // OUR chat/peer name - 'by != selfName' marks EXTERNAL controller commands
      this._externalUntil = 0; // while set, an explicit command from ANOTHER controller must comply
      this._lastAppliedTs = 0; // staleness guard: ignore older server snapshots
      this._iframeLoaded = false;
      this._lastPauseAssert = 0;
      this._hasPlayed = false; // has the player actually played since load?
      this._suppressed = 0; // last time we sent a command (mirror suppression)
      this._doNotForceUntil = 0; // while set, don't force play/pause on a controller
      this._remoteAppliedAt = 0; // last time we applied a REMOTE authoritative state
      this._freshUntil = 0; // while set, remote states may re-assert past the throttle
      this._mirroredPlaying = null; // play/pause state the room already knows
      this._mirrorCandidate = { playing: null, since: 0, confirmations: 0 };
      this._lastStatus = { time: -1, at: 0 }; // native-seek detection baseline
      this._mirrorTimer = null;
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
      this._lastAppliedTs = 0;
      this._hasPlayed = false;
      this._suppressed = 0;
      this._doNotForceUntil = 0;
      this._mirroredPlaying = null;
      this._awaitingStart = false;
      this._playCmdAt = 0;
      this._freshUntil = 0;
      this._remoteAppliedAt = 0;
      this._lastPauseAssert = 0;
      this._lastStatus = { time: -1, at: 0 }; // stale baseline = bogus native-seek on the new title
      this._lastBufferingAt = 0;
      this._mirrorCandidate = { playing: null, since: 0, confirmations: 0 };
      if (this._mirrorTimer) {
        clearTimeout(this._mirrorTimer);
        this._mirrorTimer = null;
      }
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
        // Already loaded — nothing to reload, just re-apply the pending target.
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
      this._suppressed = Date.now(); // our own command — don't mirror it back
      this._awaitingStart = true; // until the embed confirms playing, a pause is boot lag
      this._playCmdAt = Date.now();
    }

    pause() {
      // Pause in place — do NOT seek. A seek around a pause makes some
      // players resume playback, which caused the "pausing every second" loop.
      this.post({ command: 'pause' });
      this.localPlaying = false;
      this.localUpdatedAt = Date.now();
      this._suppressed = Date.now(); // our own command — don't mirror it back
    }

    seek(time) {
      this.post({ command: 'seek', time: Number(time) || 0 });
      this.localTime = Number(time) || 0;
      this.localUpdatedAt = Date.now();
      this._suppressed = Date.now(); // a seek can flicker play state; don't mirror
    }

    // Seek only when the target is meaningfully different from where we are.
    _seekTo(time) {
      const t = Number(time);
      if (Number.isFinite(t) && Math.abs(t - this.localTime) > 0.5) {
        this.seek(t);
      }
    }

    // ---- controller actions (optimistic local apply + broadcast intent) ----
    /**
     * HOST AUTHORITY: the controller's player is the source of truth. Adopt
     * our own action into the local room snapshot IMMEDIATELY so the sync
     * loop cannot re-assert the stale state while the DO round-trip is in
     * flight (this was the "pause/play needs two clicks" bug: the last
     * snapshot still said the opposite, and the next status poll paused the
     * host back). The DO echo later confirms the same values - idempotent.
     */
    _adoptLocalState(playing) {
      if (this._lastMsg) {
        this._lastMsg.isPlaying = !!playing;
        this._lastMsg.time = this.localTime;
        this._lastMsg.timestamp = Date.now();
      }
      // While OUR action settles, never force the player from the room state.
      this._doNotForceUntil = Date.now() + 2500;
    }

    localPlay(time) {
      this.play(time !== undefined ? time : this.localTime);
      this._adoptLocalState(true);
      this.emit('control', { action: 'play', time: this.localTime });
    }

    localPause() {
      this.pause();
      this._adoptLocalState(false);
      this.emit('control', { action: 'pause', time: this.localTime });
    }

    localSeek(time) {
      this.seek(time);
      this._adoptLocalState(this.localPlaying);
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
        case 'seek': {
          // HOST SOVEREIGNTY: only an explicit broadcast from ANOTHER user
          // with control permission may drive the host's player. Own echoes
          // (by === selfName) and nameless snapshots never qualify.
          if (msg.by && this.selfName && msg.by !== this.selfName) {
            this._externalUntil = Date.now() + 4000;
          }
          // Every playback broadcast carries the authoritative `playback`
          // tuple from the server. Use it so an incoming seek can never
          // overwrite the room's play/pause state with our local state —
          // that made joins look like a pause for everyone.
          this.applyRemote(msg.playback || {
            isPlaying: msg.type === 'play',
            time: msg.time,
            timestamp: msg.timestamp,
          });
          // FRESH authoritative broadcast: converge NOW, not on the next
          // status poll (polls alone made pause/resume feel seconds late —
          // guests kept playing through the 2.5s assert throttle, which
          // read as play/pause looping).
          this._syncToTarget(true);
          break;
        }
        default:
          break;
      }
    }

    // Project the room's (isPlaying, time, timestamp) tuple onto the current
    // wall clock. If playing, time advances; if paused, time is fixed.
    estimate(msg) {
      const now = Date.now();
      let time = Number(msg.time) || 0;
      const timestamp = Number(msg.timestamp) || now;
      if (msg.isPlaying) time += (now - timestamp) / 1000;
      return { time: Math.max(0, time), isPlaying: !!msg.isPlaying };
    }

    applyRemote(msg) {
      // Staleness guard: never let an older server snapshot overwrite a newer
      // one (a late `state`/`videoChange` was pausing the host after it had
      // already started playing).
      const ts = Number(msg && msg.timestamp);
      if (Number.isFinite(ts) && ts < this._lastAppliedTs) return;
      if (Number.isFinite(ts)) this._lastAppliedTs = ts;

      // Keep the RAW message (with its timestamp) so the target is re-projected
      // against the current wall clock whenever we actually apply it — a
      // joiner's player can take seconds to load.
      this._lastMsg = msg;
      this._remoteAppliedAt = Date.now();
      this._freshUntil = Date.now() + FRESH_ASSERT_MS;
      // For a controller, whatever the room state is now becomes the mirror
      // baseline, so only a later in-player change gets broadcast.
      if (this.isController) this._mirroredPlaying = !!msg.isPlaying;
      this._syncToTarget(true);
      // Players mid-buffer can swallow the first command: re-assert shortly
      // (freshUntil keeps the re-asserts throttle-exempt for a bounded time).
      this._scheduleSync(700);
      this._scheduleSync(1600);
    }

    // Converge the local player onto the room's authoritative target. Safe to
    // call repeatedly (status polls, iframe load, follow-up timers): play is
    // only sent when we think we're paused (so it self-stops once playing),
    // and pause re-asserts are throttled so they can never loop.
    /** @param {boolean} [fresh] true = authoritative broadcast just arrived; bypass the pause-assert throttle once */
    _syncToTarget(fresh) {
      const msg = this._lastMsg;
      if (!msg || !this._iframeLoaded) return;
      if (!fresh && Date.now() < this._freshUntil) fresh = true; // bounded re-assert window
      const target = this.estimate(msg);
      const absDrift = Math.abs(target.time - this.localTime);

      if (this.isController) {
        // HOST SOVEREIGNTY (user directive): once the host's player is up and
        // playing, the room NEVER seeks or pauses it - echoes, snapshots and
        // polls are ignored (the host IS the clock). Two exceptions: a fresh
        // load still follows the room (initial autoplay, next-episode
        // advance), and an EXPLICIT command from ANOTHER user holding control
        // permission always complies - WITHOUT the own-command war guard
        // (we did not command this; our suppression must never eat their
        // seek-then-pause sequence).
        if (Date.now() < this._externalUntil) {
          if (target.isPlaying) {
            if (Math.abs(target.time - this.localTime) > DRIFT_TOLERANCE && !this.isBuffering) {
              this.seek(target.time);
            }
            if (!this.localPlaying) this.play();
          } else {
            if (Math.abs(target.time - this.localTime) > SEEK_THRESHOLD && !this.isBuffering) {
              this.seek(target.time);
            }
            if (this.localPlaying) this.pause();
          }
          return;
        }
        if (this._hasPlayed) return; // SOVEREIGN: ignore echoes/snapshots/polls
        // fresh load: fall through (initial sync / autoplay) with the
        // classic guards below.
        // WAR GUARD: right after OUR OWN command (play/pause/seek, or a drift
        // correction), the embed's status lags behind what we commanded. The
        // host got ping-ponged (seek war -> chat spam) because the very next
        // poll "corrected" toward the room's stale projection while the
        // embed was still catching up. Hold corrections briefly.
        if (Date.now() - this._suppressed < 1500) return;
        // The controller's own player is the source of truth for play/pause,
        // so we never fight a user action made inside the player itself. While
        // the "don't force" window is open (the player just changed on its own
        // and its change is being mirrored to the room), we only correct the
        // position. Outside that window we follow the room (e.g. a granted
        // guest or a new host drove the room).
        const noForce = Date.now() < this._doNotForceUntil;

        if (target.isPlaying) {
          if (!this.localPlaying && !noForce) {
            // Autoplay a fresh load, or follow a guest/room that started play.
            if (absDrift > DRIFT_TOLERANCE && !this.isBuffering) this.seek(target.time);
            this.play();
          } else if (this.localPlaying && absDrift > DRIFT_TOLERANCE && !this.isBuffering) {
            // Playing and drifted: correct the position (safe while playing).
            this.seek(target.time);
            this._scheduleSync(600);
          }
        } else {
          // Position correction respects the don't-force window too: the
          // user just acted in-player (mirror still undecided) — yanking
          // them back to the room's position mid-decision is exactly the
          // "it fights me and loops" feeling. `_maybeMirrorControl` runs
          // BEFORE this in the status handler, so the window is already set.
          if (absDrift > SEEK_THRESHOLD && !this.isBuffering && (!this.localPlaying || !noForce)) {
            this.seek(target.time);
            this._scheduleSync(600);
          }
          if (this.localPlaying && !noForce && (fresh || Date.now() - this._lastPauseAssert > PAUSE_ASSERT_MS)) {
            this.pause();
            this._lastPauseAssert = Date.now();
          }
        }
        return;
      }

      // Guest (non-controller): the room is authoritative for everything.
      if (target.isPlaying) {
        // Autoplay a joiner: seek into position first, then resume. A
        // redundant play is harmless, so assert it whenever we're not playing.
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
        // Pause a client landing in a paused room — the throttle guards
        // POLL-driven asserts; a fresh broadcast acts immediately.
        if (this.localPlaying && (fresh || Date.now() - this._lastPauseAssert > PAUSE_ASSERT_MS)) {
          this.pause();
          this._lastPauseAssert = Date.now();
        }
      }
    }

    // For the controller only: detect a genuine in-player play/pause (not a
    // buffering flicker, not the echo of our own command) and broadcast it so
    // the whole room follows the controller's player.
    _maybeMirrorControl(/** @type {boolean} */ newEvidence) {
      if (!this.isController) return;
      const now = Date.now();
      const playing = this.localPlaying;
      const time = this.localTime;

      // Just sent a command (UI button / autoplay / a re-assert) — adopt
      // whatever the player settles into as known, without broadcasting.
      // ADOPT THE ROOM'S STATE, not the player's: the re-assert pause we
      // just posted opens this window, and the player's DELAYED status
      // (still "playing") must not poison the mirror baseline — that
      // adopted-echo is what made the room play/pause loop.
      if (now - this._suppressed < CONTROL_SUPPRESS_MS) {
        this._mirroredPlaying = this._lastMsg ? !!this._lastMsg.isPlaying : playing;
        this._mirrorCandidate = { playing: this._mirroredPlaying, since: now, confirmations: 0 };
        return;
      }

      // START LATCH: right after OUR play command the embed reports
      // "paused" while it buffers/seek — mirroring that paused the room
      // while the host's player kept playing (sound on, banner up). Before
      // the embed's FIRST playing confirmation, a pause is boot lag, never
      // a user action (bounded by START_LATCH_MS so a genuine pre-start
      // pause still lands eventually).
      if (!playing && this._awaitingStart && now - this._playCmdAt < START_LATCH_MS) {
        return;
      }

      // A "pause" at the very start just means the video never began (autoplay
      // blocked) — never treat that as a user pause for the room.
      if (!playing && time < 0.5) {
        this._mirroredPlaying = playing;
        this._mirrorCandidate = { playing, since: now, confirmations: 1 };
        return;
      }

      // State changed on its own: record the candidate and re-check shortly.
      // A genuine user action stays changed; a buffering flicker flips back
      // before the check, so it never broadcasts. While undecided, hold off
      // forcing convergence so we don't fight the user's action.
      if (this._mirrorCandidate.playing !== playing) {
        // A new PAUSE candidate gets fresh evidence immediately: ask the
        // embed for a status NOW instead of waiting for the next 3s poll.
        if (!playing) this._requestStatus();
        // ECHO GUARD: right after a REMOTE apply, the player's delayed status
        // still shows the OLD state. Mirroring it broadcast a stale PLAY/PAUSE
        // and the whole room looped. Inside the guard window, a differing
        // status is treated as echo: adopt quietly, never broadcast.
        if (now - this._remoteAppliedAt < REMOTE_ECHO_GUARD_MS) {
          this._mirrorCandidate = { playing, since: now, confirmations: 0 };
          return;
        }
        this._mirrorCandidate = { playing, since: now, confirmations: newEvidence ? 1 : this._mirrorCandidate.confirmations };
        this._doNotForceUntil = now + CONTROL_SUPPRESS_MS;
        this._scheduleMirrorCheck(CONTROL_DEBOUNCE_MS);
        return;
      }
      // Same state as before: accumulate evidence (only real status arrivals
      // count — a timer re-check re-reads the same observation).
      if (newEvidence) this._mirrorCandidate.confirmations++;
      // A pause with enough confirmations but inside the min-age window:
      // re-check right when the window opens instead of waiting for the
      // next 3s poll (guests feel the difference).
      if (
        !playing &&
        playing !== this._mirroredPlaying &&
        this._mirrorCandidate.confirmations >= MIRROR_PAUSE_CONFIRMATIONS &&
        now - this._mirrorCandidate.since < MIRROR_PAUSE_MIN_AGE_MS
      ) {
        this._scheduleMirrorCheck(MIRROR_PAUSE_MIN_AGE_MS + 30);
      }

      // State has been stable long enough and differs from what the room knows.
      // A PAUSE additionally needs TWO independent observations: the old
      // single-status debounce broadcast a pause off ONE lagged/stalled
      // status — the room banner said paused while the embed played on.
      const pauseConfirmed =
        !playing &&
        this._mirrorCandidate.confirmations >= MIRROR_PAUSE_CONFIRMATIONS &&
        now - this._mirrorCandidate.since >= MIRROR_PAUSE_MIN_AGE_MS &&
        !this.isBuffering && // a stall is not a user action
        now - this._lastBufferingAt > MIRROR_BUFFERING_QUIET_MS;
      if (
        playing !== this._mirroredPlaying &&
        (playing || pauseConfirmed) &&
        now - this._mirrorCandidate.since >= CONTROL_DEBOUNCE_MS
      ) {
        // THE loop path: right after a remote apply the candidate still holds
        // the OLD state, and the player's delayed echo is "stable" — without
        // this guard it broadcast the stale state and the room play/pause
        // looped. Inside the guard window: adopt quietly, never broadcast.
        if (now - this._remoteAppliedAt < REMOTE_ECHO_GUARD_MS) {
          this._mirrorCandidate = { playing, since: now, confirmations: 1 };
          return;
        }
        this._mirroredPlaying = playing;
        this._doNotForceUntil = now + CONTROL_SUPPRESS_MS;
        this.emit('control', { action: playing ? 'play' : 'pause', time });
      }
    }

    // Detect a seek performed on the player's OWN seek bar: the reported
    // time jumped beyond what playback could have covered since the last
    // status. Controllers get it mirrored to the room ('control'/'seek');
    // everyone else keeps the sync contract (their drift is re-converged).
    _detectNativeSeek() {
      const t = this.localTime;
      const at = this.localUpdatedAt || Date.now();
      const prev = /** @type {{ time: number, at: number }} */ (this._lastStatus);
      this._lastStatus = { time: t, at: at };
      if (!this.isController || prev.time < 0 || this.isBuffering) return;
      if (Date.now() - this._suppressed < CONTROL_SUPPRESS_MS) return; // our own command
      const elapsed = Math.max(0, (at - prev.at) / 1000);
      const expected = prev.time + (this.localPlaying ? elapsed : 0);
      if (Math.abs(t - expected) > NATIVE_SEEK_THRESHOLD) {
        // Adopt the user's position: don't fight them while the room round-trips.
        this._suppressed = Date.now();
        this._mirroredPlaying = this.localPlaying;
        this.emit('control', { action: 'seek', time: t });
      }
    }

    _scheduleMirrorCheck(delay) {
      if (this._mirrorTimer) clearTimeout(this._mirrorTimer);
      this._mirrorTimer = setTimeout(() => {
        this._mirrorTimer = null;
        this._maybeMirrorControl(false); // re-reads the same observation: not new evidence
      }, delay);
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
          if (typeof d.playing === 'boolean') {
            this.localPlaying = d.playing;
            if (d.playing) {
              this._hasPlayed = true;
              this._awaitingStart = false; // the embed confirmed play — pauses are real again
            }
          }
          this.isBuffering = false;
          // DERIVED END: some embeds never post an 'ended' event - a status
          // that says "paused at (or past) the end" after having played IS
          // the end. Fire once per load; the explicit case above dedupes.
          if (
            !this._endedFired &&
            this._hasPlayed &&
            d.playing === false &&
            typeof d.currentTime === 'number' &&
            this.duration > 30 &&
            this.duration - d.currentTime <= 2.5
          ) {
            this._endedFired = true;
            this.emit('ended', { time: this.localTime, duration: this.duration, derived: true });
          }
          if (!this.ready) {
            this.ready = true;
            this._clearReadyTimer();
            this._startPolling();
            this.emit('ready', {});
          }
          // Controller: mirror a genuine in-player play/pause to the room
          // BEFORE converging, so convergence never fights the user's action.
          this._maybeMirrorControl(true); // a fresh status = fresh evidence
          // Controller: mirror a genuine drag on the player's OWN seek bar
          // (otherwise convergence reads it as drift and snaps it back).
          this._detectNativeSeek();
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
          this._hasPlayed = true;
          this.isBuffering = false;
          this._awaitingStart = false;
          this.emit('progress', {
            time: this.localTime,
            playing: true,
            duration: this.duration,
          });
          this._syncToTarget(); // discrete events bypassed convergence entirely
          break;

        case 'pause':
        case 'paused':
          this.localPlaying = false;
          this.emit('progress', {
            time: this.localTime,
            playing: false,
            duration: this.duration,
          });
          this._syncToTarget();
          break;

        case 'ended':
          this.localPlaying = false;
          this.emit('progress', {
            time: this.localTime,
            playing: false,
            duration: this.duration,
          });
          // Distinct signal for auto-advance (a PAUSE near the end looks
          // identical in 'progress' - 'ended' is unambiguous). Fire ONCE
          // per load; the derived detector below may have beaten us to it.
          if (!this._endedFired) {
            this._endedFired = true;
            this.emit('ended', { time: this.localTime, duration: this.duration });
          }
          break;

        case 'buffering':
        case 'waiting':
        case 'stalled':
          this.isBuffering = true;
          this._lastBufferingAt = Date.now();
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
      // Stop the embedded player and unload its document so nothing can keep
      // playing (audio or video) after the session ends. A hidden iframe's
      // media keeps playing, so posting `pause` alone isn't enough — we also
      // navigate the iframe to a blank document, which tears its media down.
      this.post({ command: 'pause' });
      this._clearReadyTimer();
      this._clearSyncTimer();
      if (this._mirrorTimer) {
        clearTimeout(this._mirrorTimer);
        this._mirrorTimer = null;
      }
      this._stopPolling();
      window.removeEventListener('message', this._boundMessage);
      if (this.iframe) {
        // Remove the load listener BEFORE blanking so the blank document's
        // `load` event can't re-arm polling.
        this.iframe.removeEventListener('load', this._boundIframeLoad);
        try {
          if (this.iframe.getAttribute('src')) this.iframe.src = 'about:blank';
        } catch (_) {}
      }
      this.localPlaying = false;
      this.localUpdatedAt = Date.now();
      this.ready = false;
      this._hasPlayed = false;
      this._iframeLoaded = false;
      this._lastMsg = null;
      this._lastAppliedTs = 0;
    }
  }

  global.WP.PlaybackSyncManager = PlaybackSyncManager;
})(window);
