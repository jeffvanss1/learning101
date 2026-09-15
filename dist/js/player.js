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

  // ---- drift corrections are EXPENSIVE: budget them ------------------------
  // A "correction" is a seek, and a seek makes the embedded player refetch from
  // a new offset (it drops its buffer and shows its loading state). The old
  // 0.75s tolerance corrected on EVERY 3s status poll, and on a phone - where
  // the status lags the player by a few hundred ms and the buffer is slow - the
  // measured drift sits above 0.75s permanently, so the guest sought forever:
  // seek -> loading -> a status still reporting the OLD position -> seek again.
  // That is the "it keeps trying to sync and the video is never playable" bug.
  //
  // The rules below make a seek the LAST resort instead of the first reflex:
  //   1. a playing room tolerates real drift (the player's own clock keeps the
  //      room's rhythm, so a small offset is invisible on screen);
  //   2. a correction needs the drift to PERSIST (two observations), unless it
  //      is so large that it is certainly not measurement noise;
  //   3. never while the player is buffering, and never inside the SETTLE
  //      window that follows any seek/load/play - until a seek lands, the
  //      player still reports the old position, which reads as fresh drift;
  //   4. one correction per cooldown, with exponential backoff, and the
  //      backoff only resets when a status shows us in sync again;
  //   5. a correction also requires the clock to have MOVED since the last one:
  //      a frozen clock is a player still loading, not a player out of place;
  //   6. an explicit room command (host seek/play/pause) clears the whole
  //      budget - following the room must never wait on a damping timer.
  const DRIFT_TOLERANCE = 2.5; // seconds of drift a PLAYING room simply ignores
  const SEEK_THRESHOLD = 3.5; // seconds before forcing a hard seek (paused rooms)
  const CORRECTION_HARD_DRIFT = 12; // seconds: obvious, correct on sight
  const CORRECTION_STREAK = 2; // observations of the same drift before a seek
  const CORRECTION_BASE_COOLDOWN_MS = 8000; // first correction -> next allowed
  const CORRECTION_MAX_COOLDOWN_MS = 48000; // backoff cap (a stuck player waits)
  const CORRECTION_SETTLE_MS = 5000; // after a seek: the player is reloading
  const PLAY_SETTLE_MS = 3000; // after a play command: buffering, not mismatched
  const CORRECTION_RECHECK_MS = 1200; // look again once the seek has landed
  const SKEW_SAMPLES = 8; // clock-offset samples kept (see estimate)
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
  // "False pause" guards. A report that claims PAUSED is only believed when its
  // own clock is frozen (a paused player cannot advance) and we are past the
  // boot window of our play command. Boot lag reports "paused" while the video
  // plays — believing it painted a paused button/banner and broadcast a pause
  // to the room while the video never stopped.
  const PAUSE_CLOCK_WINDOW_MS = 2000; // how long a paused-clock observation stays valid
  const PAUSE_CLOCK_EPSILON = 0.35; // seconds of clock movement that falsify a pause

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
      this._pauseClock = null; // { t, at } = last "paused" report's position (credibility check)
      // Drift-correction budget (see the constants above).
      this._settleUntil = 0; // no corrections at all until this timestamp
      this._lastCorrectionAt = 0; // when we last seeked to correct drift
      this._correctionBackoff = 0; // current cooldown (grows, resets when in sync)
      this._driftStreak = { dir: 0, n: 0 }; // consecutive same-direction observations
      this._clockMovedAt = 0; // last status whose position actually MOVED
      this._lastReportedTime = -1; // the player's own last reported position
      this._skewSamples = []; // arrival - server timestamp, recent window
      this._lastStatusReqAt = 0; // throttle for the confirm-my-pause status requests
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
      this._pauseClock = null; // a new title starts with a clean pause-credibility window
      this._lastStatusReqAt = 0;
      this._lastBufferingAt = 0;
      // A new title: the budget starts over (a fresh load is welcome to seek)
      // and the clock-skew window is re-sampled for this session.
      this._settleUntil = 0;
      this._lastCorrectionAt = 0;
      this._correctionBackoff = 0;
      this._driftStreak = { dir: 0, n: 0 };
      this._clockMovedAt = 0;
      this._lastReportedTime = -1;
      this._skewSamples = [];
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
      // A just-started player buffers before it reports anything useful, so its
      // first statuses are news about loading, not about being out of position.
      this._settleUntil = Math.max(this._settleUntil, Date.now() + PLAY_SETTLE_MS);
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
      // A seek drops the player's buffer: until it lands, every status still
      // reports the PREVIOUS position. Correcting that read-back is what turned
      // one seek into a seek loop on a slow connection.
      this._settleUntil = Math.max(this._settleUntil, Date.now() + CORRECTION_SETTLE_MS);
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
      // `msg.timestamp` is the SERVER's clock, so projecting the room's position
      // onto "now" needs the offset between the two clocks - otherwise a device
      // whose clock is off by minutes computes a target minutes away and seeks
      // to it on every poll (a phone with a wrong clock was unplayable this
      // way). The offset is estimated from the messages themselves: the
      // SMALLEST observed (arrival - timestamp) is the offset plus the least
      // network latency, and a sliding window of samples follows a device clock
      // that later corrects itself.
      const skew = this._clockSkew();
      if (msg.isPlaying) time += Math.max(0, now - timestamp - skew) / 1000;
      let target = Math.max(0, time);
      // Never project past the media: a stale tuple plus a skew must not seek
      // the room to the end (which looks like "it skipped the movie").
      if (this.duration > 0 && target > this.duration - 1) target = this.duration - 1;
      return { time: target, isPlaying: !!msg.isPlaying };
    }

    /** Median-free, robust clock offset (ms) from the last few messages. */
    _clockSkew() {
      const list = this._skewSamples;
      if (!list || !list.length) return 0;
      let min = list[0];
      for (const v of list) if (v < min) min = v;
      return min;
    }

    /**
     * Record one (arrival - server timestamp) sample. Messages arrive after some
     * latency, so the minimum over the window approaches the true offset.
     * @param {number} timestampMs
     */
    _noteClockSample(timestampMs) {
      const sample = Date.now() - Number(timestampMs);
      if (!Number.isFinite(sample) || Math.abs(sample) > 12 * 60 * 60 * 1000) return; // nonsense
      if (!this._skewSamples) this._skewSamples = [];
      this._skewSamples.push(sample);
      if (this._skewSamples.length > SKEW_SAMPLES) this._skewSamples.shift();
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
      this._noteClockSample(msg.timestamp);
      this._remoteAppliedAt = Date.now();
      this._freshUntil = Date.now() + FRESH_ASSERT_MS;
      // An explicit room command CLEARS the drift budget: following the room
      // (host seek / room play / room pause) must land immediately, never wait
      // out a damping timer that exists only to stop drift-chasing.
      this._settleUntil = 0;
      this._lastCorrectionAt = 0;
      this._correctionBackoff = 0;
      this._driftStreak = { dir: 0, n: 0 };
      // For a controller, whatever the room state is now becomes the mirror
      // baseline, so only a later in-player change gets broadcast.
      if (this.isController) this._mirroredPlaying = !!msg.isPlaying;
      this._syncToTarget(true, true);
      // Players mid-buffer can swallow the first command: re-assert shortly
      // (freshUntil keeps the re-asserts throttle-exempt for a bounded time).
      this._scheduleSync(700);
      this._scheduleSync(1600);
    }

    // Converge the local player onto the room's authoritative target. Safe to
    // call repeatedly (status polls, iframe load, follow-up timers): play is
    // only sent when we think we're paused (so it self-stops once playing),
    // and pause re-asserts are throttled so they can never loop.
    /**
     * @param {boolean} [fresh] true = authoritative broadcast just arrived; bypass the pause-assert throttle once
     * @param {boolean} [force] true = an EXPLICIT room command: its seek must
     *   land now, whatever the drift budget says (following the room is not
     *   drift-chasing). Only applyRemote sets this, and only once per message.
     */
    _syncToTarget(fresh, force) {
      const msg = this._lastMsg;
      if (!msg || !this._iframeLoaded) return;
      if (!fresh && Date.now() < this._freshUntil) fresh = true; // bounded re-assert window
      const target = this.estimate(msg);

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
            this._correctDrift(target, { force: force });
            if (!this.localPlaying) this.play();
          } else {
            this._correctDrift(target, { paused: true, force: force });
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
            this._correctDrift(target, { force: force });
            this.play();
          } else if (this.localPlaying) {
            // Playing and drifted: correct the position - through the budget,
            // so a slow connection is not seeked into a loading loop.
            this._correctDrift(target, { force: force });
          }
        } else {
          // Position correction respects the don't-force window too: the
          // user just acted in-player (mirror still undecided) — yanking
          // them back to the room's position mid-decision is exactly the
          // "it fights me and loops" feeling. `_maybeMirrorControl` runs
          // BEFORE this in the status handler, so the window is already set.
          if (!this.localPlaying || !noForce) this._correctDrift(target, { paused: true, force: force });
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
        this._correctDrift(target, { force: force });
        if (!this.localPlaying) this.play();
      } else {
        this._correctDrift(target, { paused: true, force: force });
        // Pause a client landing in a paused room — the throttle guards
        // POLL-driven asserts; a fresh broadcast acts immediately.
        if (this.localPlaying && (fresh || Date.now() - this._lastPauseAssert > PAUSE_ASSERT_MS)) {
          this.pause();
          this._lastPauseAssert = Date.now();
        }
      }
    }

    /**
     * Correct the local position toward the room's clock - but only when such a
     * seek is worth its cost. A correction seeks, a seek reloads the buffer, and
     * on a phone a correction every poll means the video never finishes loading.
     * Returns true when the local player is already close enough.
     * @param {{ time: number, isPlaying: boolean }} target
     * @param {{ paused?: boolean, force?: boolean }} [opts] paused = use the
     *   wider paused threshold; force = an explicit room command, seek now
     * @returns {boolean} true when the player is in sync (no seek needed)
     */
    _correctDrift(target, opts) {
      const o = opts || {};
      const now = Date.now();
      const drift = target.time - this.localTime;
      const absDrift = Math.abs(drift);
      const tolerance = o.paused ? SEEK_THRESHOLD : DRIFT_TOLERANCE;

      if (absDrift <= tolerance) {
        // In sync: the budget starts over, so a later genuine jump corrects fast.
        this._correctionBackoff = 0;
        this._driftStreak = { dir: 0, n: 0 };
        return true;
      }
      if (!this._iframeLoaded) return false;
      if (o.force) {
        // An explicit room command: seek now. The whole point of the budget is
        // to stop DRIFT-CHASING, never to make the room's own commands late.
        this._driftStreak = { dir: 0, n: 0 };
        this._correctionBackoff = CORRECTION_BASE_COOLDOWN_MS;
        this._lastCorrectionAt = now;
        this.seek(target.time);
        return false;
      }
      if (this.isBuffering) return false; // a stall is not a position
      // We commanded play and the embed has not confirmed it yet: give the boot
      // a bounded window (the same 8s latch the pause/seek guards use).
      if (this._awaitingStart && now - this._playCmdAt < START_LATCH_MS) return false;
      if (now < this._settleUntil) return false; // a seek/load/play is settling

      // The drift has to PERSIST to count as a position error rather than
      // measurement noise (...unless it is so large it cannot be noise).
      const dir = drift > 0 ? 1 : -1;
      if (this._driftStreak.dir === dir) this._driftStreak.n += 1;
      else this._driftStreak = { dir: dir, n: 1 };
      if (absDrift < CORRECTION_HARD_DRIFT && this._driftStreak.n < CORRECTION_STREAK) return false;

      const cooldown = this._correctionBackoff || CORRECTION_BASE_COOLDOWN_MS;
      // A seek only helps a player that is RUNNING and merely behind. If the
      // clock has not ADVANCED since our last correction, the player is still
      // loading (or stalled) - seeking it again just restarts the load, which
      // is precisely the loop this budget exists to break. Back off instead.
      // (A paused room reports a frozen clock by definition, so this rule is
      // for playing rooms only; the cooldown damps those.)
      // (>= on purpose: a status that lands in the same millisecond as the
      // correction still carries a position that ADVANCED, which is exactly the
      // evidence we are after - a strict > made that a coin flip.)
      const progressed = this._clockMovedAt >= this._lastCorrectionAt;
      if (!o.paused && this._lastCorrectionAt && !progressed) {
        this._correctionBackoff = Math.min(CORRECTION_MAX_COOLDOWN_MS, cooldown * 2);
        return false;
      }
      // THE COOLDOWN IS NEVER BYPASSED on the passive path. It used to let an
      // "obvious" drift through when the clock had progressed, and THAT is how
      // a slow phone kept looping: a load always ends with a forward jump
      // (progressed) while the room has run ahead by the load time (obvious),
      // so finishing a load instantly bought another seek - and another load.
      // An explicit room command is the thing that must never wait, and it
      // arrives through `force` above; passive drift-chasing waits its turn.
      if (this._lastCorrectionAt && now - this._lastCorrectionAt < cooldown) return false;

      this._lastCorrectionAt = now;
      this._correctionBackoff = Math.min(CORRECTION_MAX_COOLDOWN_MS, cooldown * 2);
      this._driftStreak = { dir: 0, n: 0 };
      this.seek(target.time); // stamps the settle window
      this._scheduleSync(CORRECTION_RECHECK_MS); // look again once it lands
      return false;
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

    /**
     * Is a "paused" report BELIEVABLE? The clock decides, never the flag alone.
     *
     *   1. BOOT LAG: right after OUR play command the embed reports "paused"
     *      until it finishes buffering (the start latch) — not a pause.
     *   2. A MOVING CLOCK: a paused player's position cannot advance, so a
     *      "paused" report whose position moves is a lie about the pause. This
     *      was the "false pause at first start a room while the video still
     *      plays" bug: the paused button/banner appeared and a PAUSE was
     *      broadcast to the room while playback never stopped.
     *
     * Consecutive paused reports must therefore ALL show the same position; the
     * first one is believed only when it did not move since the previous report
     * of any kind. An unconfirmed claim is answered with an immediate status
     * request, so the ambiguity resolves in milliseconds, not polls.
     * @param {number} reportedTime
     * @returns {boolean}
     */
    _believePaused(reportedTime) {
      if (this._awaitingStart && Date.now() - this._playCmdAt < START_LATCH_MS) return false;
      const t = Number(reportedTime);
      if (!Number.isFinite(t)) return true;
      const at = Date.now();
      const prev = this._pauseClock;
      let frozen;
      if (prev && at - prev.at <= PAUSE_CLOCK_WINDOW_MS) {
        frozen = Math.abs(t - prev.t) <= PAUSE_CLOCK_EPSILON;
      } else {
        const last = /** @type {{ time: number, at: number }} */ (this._lastStatus);
        frozen = !last || last.time < 0 || Math.abs(t - last.time) <= PAUSE_CLOCK_EPSILON;
      }
      this._pauseClock = { t: t, at: at };
      if (!frozen) {
        // The claim is not credible YET: ask for the next status right away so
        // a genuine pause is confirmed fast and a lagging one is discarded.
        if (at - this._lastStatusReqAt > 250) {
          this._lastStatusReqAt = at;
          this._requestStatus();
        }
      }
      return frozen;
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
      // BOOT WINDOW: until the embed confirms it is playing, a position jump
      // is our own play/seek command being absorbed by the player — not the
      // user dragging the bar. Mirroring it spammed the room with seeks.
      if (this._awaitingStart && Date.now() - this._playCmdAt < START_LATCH_MS) return;
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
            // Did the player's OWN clock advance since its last report? Only
            // forward movement is evidence of playback: a player that is still
            // loading re-reports the stale position it last managed to buffer,
            // and seeking that again only restarts the load. (Measured against
            // the player's previous report, never against the position WE asked
            // for - a seek that silently failed must still be retried.)
            if (this._lastReportedTime >= 0 && d.currentTime > this._lastReportedTime + 0.2) {
              this._clockMovedAt = Date.now();
            }
            this._lastReportedTime = d.currentTime;
            this.localTime = d.currentTime;
            this.localUpdatedAt = Date.now();
          }
          if (typeof d.duration === 'number') this.duration = d.duration;
          // A claimed pause is only a pause when the clock agrees (see
          // _believePaused). Otherwise the video is running and the report is
          // boot lag — keep the playing state so the UI never shows a pause
          // for a video that is playing.
          const claimedPause = d.playing === false;
          const crediblePause = claimedPause && this._believePaused(d.currentTime);
          const stalePause = claimedPause && !crediblePause;
          if (typeof d.playing === 'boolean') {
            if (d.playing) {
              // A POSITIVE play confirmation is the only thing that releases
              // the start latch (a healed false pause must not: the very next
              // lagging pause would be believed).
              this.localPlaying = true;
              this._hasPlayed = true;
              this._awaitingStart = false; // the embed confirmed play — pauses are real again
              this._pauseClock = null;
            } else if (crediblePause) {
              this.localPlaying = false;
            } else {
              // The embed claims paused but the video is running: keep the
              // playing state (no paused button, no pause banner).
              this.localPlaying = true;
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
            !stalePause && // a lagging "paused" near the end is not the end
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
          if (stalePause) {
            // The embed lied about the pause: no fresh evidence for the mirror
            // (a lie must never start a play OR pause candidate) — just clear
            // the candidate so nothing is broadcast from it.
            this._mirrorCandidate = { playing: this.localPlaying, since: Date.now(), confirmations: 0 };
          } else {
            // Controller: mirror a genuine in-player play/pause to the room
            // BEFORE converging, so convergence never fights the user's action.
            this._maybeMirrorControl(true); // a fresh status = fresh evidence
          }
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
          this._pauseClock = null; // playing again: the pause window is closed
          this.emit('progress', {
            time: this.localTime,
            playing: true,
            duration: this.duration,
          });
          this._syncToTarget(); // discrete events bypassed convergence entirely
          break;

        case 'pause':
        case 'paused':
          // A pause EVENT during the boot window is the same boot lag the
          // status path guards against: the embed announces "paused" before it
          // has actually started playing. Never paint that as a real pause.
          if (!this._believePaused(this.localTime)) {
            // Keep playing, but do NOT claim an embed play confirmation: the
            // start latch must survive a lagging report, otherwise the next
            // lagging pause would be believed.
            this.localPlaying = true;
            this.emit('progress', {
              time: this.localTime,
              playing: true,
              duration: this.duration,
            });
            break;
          }
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
