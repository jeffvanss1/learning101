/*
 * social.js — profiles, global people search, and real-time presence.
 *
 * Layout of this module:
 *   1. Session (silent sign-in, localStorage, HMAC bearer token)
 *   2. API client (typed fetchers for /api/user, /api/search/users, ...)
 *   3. Presence writers (room socket sync + home REST heartbeat + beacon)
 *   4. Shared renderers (framed avatars, presence badges)
 *   5. Search UI (user cards for the catalog's results surface)
 *   6. Profile page (Steam-style hero, live activity, showcase, history)
 *   7. Profile editor modal (display name, bio, frame, 4 pinned favorites)
 *
 * Types: see types.js (mirrors of the backend's src/types.ts payloads).
 */
// @ts-check
(function (global) {
  'use strict';

  const WP = global.WP;
  const $ = (/** @type {string} */ id) => document.getElementById(id);

  // Must mirror AVATAR_FRAMES in src/routes/users.ts (validated server-side).
  const FRAMES = ['default', 'gold', 'neon', 'rainbow', 'flame', 'ice'];
  /** @type {Record<string, string>} */
  const FRAME_LABELS = {
    default: 'None',
    gold: 'Gold',
    neon: 'Neon',
    rainbow: 'Rainbow',
    flame: 'Flame',
    ice: 'Ice',
  };

  const SESSION_KEY = 'wp:session';
  const IDLE_HEARTBEAT_MS = 60_000;
  const ROOM_SYNC_MS = 20_000;
  const PROFILE_REFRESH_MS = 30_000;
  const PIN_LIMIT = 4;

  // ---------------------------------------------------------------------------
  // 1. Session
  // ---------------------------------------------------------------------------
  /** @type {SessionState | null} */
  let session = null;

  function loadSession() {
    if (session) return session;
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.token && parsed.user) session = parsed;
      }
    } catch (_) {}
    return session;
  }

  let storageWarned = false;

  /** @param {SessionState | null} s */
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (_) {
      // Sandboxed iframe / blocked storage: the session still works for this
      // page (in-memory) but dies on reload — SAY so instead of silently
      // looping users back to "anonymous" after every refresh.
      if (!storageWarned && s) {
        storageWarned = true;
        toast('This page can\u2019t save data locally (blocked storage) \u2014 your sign-in lasts until you reload. Save your access code!', true);
      }
    }
  }

  function getSession() {
    return loadSession();
  }

  /** "Bold Falcon" -> "bold-falcon" (also "Bold  Falcon 42" -> "bold-falcon-42") */
  /** @param {string} name */
  function slugify(name) {
    const s = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    return s.length >= 3 ? s : 'user-' + (s || 'anon');
  }

  /**
   * Resume an existing session (token in localStorage) or create the account.
   * On creation the server returns the unique ACCESS CODE exactly once —
   * this module shows the "save your code" modal before it resolves.
   *
   * Never throws. Result tells the caller what happened:
   *   { ok: true, session }                    — signed in
   *   { ok: false, reason: 'taken' }           — name protected by a code
   *   { ok: false, reason: 'error', message? } — network/server trouble
   *
   * @param {string} [displayName] required only when creating
   * @returns {Promise<{ok: boolean, reason?: string, message?: string, session?: SessionState}>}
   */
  async function ensureSession(displayName) {
    const existing = loadSession();
    if (existing) {
      // Validate the cached token: it can point at an account that no longer
      // exists (DB reset/cleanup). The server is the source of truth — a
      // stale token would otherwise wedge the user into a broken "signed in"
      // state where profile/history writes fail.
      try {
        const meRes = await fetch('/api/auth/me', { headers: authHeaders() });
        if (meRes.ok) {
          const meData = await meRes.json();
          if (meData && meData.user) return { ok: true, session: existing };
          // Token is for a deleted account — drop it and (re)create below.
          saveSession(null);
        }
        // Non-OK response: server trouble — trust the cached session rather
        // than destroying a possibly-valid one.
      } catch (_) {
        return { ok: true, session: existing };
      }
    }
    if (!displayName) return { ok: false, reason: 'error', message: 'No name given.' };
    try {
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: slugify(displayName),
          displayName: displayName,
          avatarUrl: WP.avatarUrl(displayName || 'anon'),
        }),
      });
      const data = await res.json();
      if (res.status === 409) {
        return { ok: false, reason: 'taken', message: data && data.error };
      }
      if (!res.ok || !data.token) {
        return { ok: false, reason: 'error', message: (data && data.error) || '' };
      }
      const fresh = /** @type {SessionState} */ (data);
      saveSession(fresh);
      // Let the friends rail (and anything else) react to sign-in.
      global.dispatchEvent(new CustomEvent('wp:friends-changed'));
      // Handle was taken and auto-suffixed (alice -> alice-2) — surface it.
      if (data.handleAdjusted) {
        toast('Your display name stays “' + fresh.user.displayName + '” — your handle is @' + fresh.user.username + '.');
      }
      // The access code is shown once — make sure the user sees it. Runs in
      // its own microtask: a display failure here must NEVER flip the
      // already-committed signup into a reported error.
      if (data.accessCode) {
        const code = String(data.accessCode);
        Promise.resolve()
          .then(() => showAccessCode(code))
          .catch((e) => {
            console.error('code reveal failed', e);
            toast('SIGNUP OK — but the code popup failed. Your access code: ' + code, true);
          });
      }
      return { ok: true, session: fresh };
    } catch (e) {
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : '' };
    }
  }

  /**
   * Sign in from any device with an access code (the signup seed).
   * @param {string} code
   * @returns {Promise<{ok: boolean, message?: string, session?: SessionState}>}
   */
  async function claimWithCode(code) {
    try {
      const res = await fetch('/api/auth/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
      });
      const data = await res.json();
      if (!res.ok || !data.token) {
        return { ok: false, message: (data && data.error) || 'Could not sign in.' };
      }
      const fresh = /** @type {SessionState} */ (data);
      saveSession(fresh);
      global.dispatchEvent(new CustomEvent('wp:friends-changed'));
      return { ok: true, session: fresh };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not sign in.' };
    }
  }

  /**
   * Rotate the access code (auth): old code dies, new one is shown once.
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  async function rotateAccessCode() {
    try {
      const data = await api('/api/auth/code', { method: 'POST' });
      if (data && data.accessCode) {
        await showAccessCode(String(data.accessCode));
        return { ok: true };
      }
      return { ok: false, message: 'No code returned.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not rotate code.' };
    }
  }

  /**
   * "Save your access code" screen — the ONLY time the code is ever shown
   * (the server stores just a hash). Resolves once acknowledged.
   * @param {string} code
   * @returns {Promise<boolean>} true when the user acknowledged
   */
  function showAccessCode(code) {
    return new Promise((resolve) => {
      // The modal markup can be missing on a stale cached page — inject a
      // stand-in rather than throwing: the one-time code must ALWAYS be
      // showable (a throw here used to flip an already-successful signup
      // into a reported failure).
      let modal = /** @type {HTMLElement | null} */ ($('code-modal'));
      if (!modal) {
        modal = h('div', 'modal');
        modal.id = 'code-modal';
        modal.appendChild(h('div', 'modal__card modal__card--code'));
        document.body.appendChild(modal);
      }
      const card = /** @type {HTMLElement} */ (
        modal.querySelector('.modal__card') || modal.appendChild(h('div', 'modal__card modal__card--code'))
      );
      card.innerHTML = '';

      const head = h('div', 'modal__head');
      head.appendChild(h('h2', 'modal__title', '🔑 Your access code'));
      card.appendChild(head);

      card.appendChild(
        h(
          'p',
          'code-modal__lead',
          'This is the only way to sign in on another device or recover this profile — there are no passwords. Save it somewhere safe.'
        )
      );

      const display = h('div', 'code-modal__display');
      String(code)
        .split('-')
        .forEach((chunk) => display.appendChild(h('span', 'code-modal__chunk', chunk)));
      card.appendChild(display);

      const row = h('div', 'code-modal__actions-row');
      const copy = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', 'Copy code'));
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await WP.copyText(String(code).replace(/-/g, ''));
          copy.textContent = 'Copied ✓';
          setTimeout(() => (copy.textContent = 'Copy code'), 1600);
        } catch (_) {
          toast('Copy failed — write it down instead', true);
        }
      });
      row.appendChild(copy);
      card.appendChild(row);

      const warn = h('p', 'code-modal__warn', '⚠️ We cannot show this again. Lost code = lost profile.');
      card.appendChild(warn);

      const ack = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--block', "I've saved it — continue"));
      ack.type = 'button';
      ack.addEventListener('click', () => {
        modal.hidden = true;
        card.innerHTML = '';
        resolve(true);
      });
      card.appendChild(ack);

      modal.hidden = false;
      ack.focus();
    });
  }

  function signOut() {
    // Best-effort: clear server-side presence too.
    try {
      /** @type {SessionState | null} */
      const s = loadSession();
      if (s) {
        navigator.sendBeacon(
          '/api/presence',
          new Blob([JSON.stringify({ token: s.token })], { type: 'application/json' })
        );
      }
    } catch (_) {}
    saveSession(null);
    global.dispatchEvent(new CustomEvent('wp:friends-changed'));
  }

  /** @returns {Record<string, string>} */
  function authHeaders() {
    const s = loadSession();
    return s ? { Authorization: 'Bearer ' + s.token } : {};
  }

  // ---------------------------------------------------------------------------
  // 2. API client
  // ---------------------------------------------------------------------------
  /**
   * @param {string} path
   * @param {RequestInit} [opts]
   * @returns {Promise<any>}
   */
  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
        ...((opts && opts.headers) || {}),
      },
    });
    let data = null;
    let notJson = false;
    try {
      data = await res.json();
    } catch (_) {
      notJson = true;
    }
    if (!res.ok) {
      throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    }
    // A 2xx whose body isn't JSON means the worker answered with the SPA
    // fallback (index.html): the deployed worker predates this API route.
    // Say so loudly instead of silently returning null.
    if (notJson || data === null) {
      throw new Error(
        'The server returned HTML instead of JSON — the deployed worker is out of date. Redeploy the worker (npm run deploy from the PR branch), then hard-refresh (Ctrl+Shift+R).'
      );
    }
    return data;
  }

  /** @param {string} q @returns {Promise<UserSearchHit[]>} */
  async function searchUsers(q) {
    const data = await api('/api/search/users?q=' + encodeURIComponent(q));
    return (data && data.users) || [];
  }

  /** @param {string} username @returns {Promise<UserProfileResponse>} */
  async function getProfile(username) {
    return api('/api/user/' + encodeURIComponent(username));
  }

  /**
   * @param {{displayName?: string, bio?: string, avatarFrameId?: string, favorites?: FavoriteItem[]}} patch
   * @returns {Promise<any>}
   */
  async function updateProfile(patch) {
    return api('/api/user/profile', { method: 'PUT', body: JSON.stringify(patch) });
  }

  /** Fire-and-forget server-side history record for signed-in viewers. */
  /** @param {any} video */
  function recordHistoryFor(video) {
    const s = loadSession();
    if (!s || !video || !video.id || !video.title) return;
    api('/api/user/history', {
      method: 'POST',
      body: JSON.stringify({
        mediaId: String(video.id),
        mediaType: video.type || 'movie',
        mediaTitle: video.title,
        posterUrl: video.poster || video.thumb || '',
        season: video.season != null ? video.season : null,
        episode: video.episode != null ? video.episode : null,
      }),
    }).catch(() => {});
  }

  /**
   * @param {'request'|'accept'|'remove'} action
   * @param {string} username
   * @returns {Promise<any>}
   */
  async function friendAction(action, username) {
    const method = action === 'request' ? 'POST' : action === 'accept' ? 'PUT' : 'DELETE';
    return api('/api/friends/' + encodeURIComponent(username), { method });
  }

  // ---------------------------------------------------------------------------
  // 3a. Room presence — synced over the room WebSocket via the WatchRoom DO
  // ---------------------------------------------------------------------------
  /**
   * Minimal structural view of the RoomClient from api.js (avoids dragging
   * the legacy script into type checking).
   * @typedef {{ on: (type: string, fn: (msg: any) => void) => () => void, send: (obj: any) => boolean }} RoomClientLike
   */
  class RoomPresence {
    /**
     * @param {RoomClientLike} client
     * @param {{ getVideo: () => any, getPeerCount: () => number, isHost: () => boolean }} app
     */
    constructor(client, app) {
      /** @type {RoomClientLike | null} */
      this.client = client;
      this.app = app;
      this.timer = /** @type {any} */ (null);
      /** Pending "blip → IDLE" timer while the room socket reconnects. */
      this._blipTimer = /** @type {any} */ (null);
      /** Latest playback position, refreshed by syncProgress(). */
      this._lastProgress = 0;
      this.offOpen = client.on('open', () => {
        if (this._blipTimer) {
          clearTimeout(this._blipTimer);
          this._blipTimer = null;
        }
        this.syncNow();
        this._start();
      });
      // While the socket auto-reconnects (network blip, dev reload), the DO
      // has already cleared our presence — report IDLE ("Online") via REST
      // so the user doesn't flash OFFLINE for the whole reconnect window.
      this.offClose = client.on('close', () => {
        this._stop();
        if (!this._blipTimer) {
          this._blipTimer = setTimeout(() => {
            this._blipTimer = null;
            const s = getSession();
            if (!s) return;
            api('/api/presence', {
              method: 'PUT',
              body: JSON.stringify({ status: 'IDLE' }),
            }).catch(() => {});
          }, 1500); // after the DO's disconnect clear has landed
        }
      });
      this._start();
    }

    _start() {
      this._stop();
      this.timer = setInterval(() => this.syncNow(), ROOM_SYNC_MS);
    }

    _stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    /** Push current state into the presence engine (best-effort). */
    /** @param {string} [forcedStatus] */
    syncNow(forcedStatus) {
      const s = getSession();
      if (!s || !this.client) return;
      const video = this.app.getVideo() || {};
      const peers = Math.max(1, this.app.getPeerCount() || 1);
      const watching = !!(video && video.id);
      const status =
        forcedStatus || (watching ? (peers > 1 ? 'WATCHING_PARTY' : 'WATCHING_SOLO') : 'IDLE');
      this.client.send({
        type: 'presenceSync',
        token: s.token,
        userId: s.user.id,
        status,
        media_id: watching ? String(video.id) : '',
        media_title: watching ? String(video.title || '') : '',
        current_timestamp_seconds: Number(this._lastProgress) || 0,
        is_host: this.app.isHost(),
      });
    }

    /** Report the live playback position (called on progress ticks). */
    /** @param {number} seconds */
    syncProgress(seconds) {
      this._lastProgress = seconds;
    }

    destroy() {
      this._stop();
      if (this._blipTimer) {
        clearTimeout(this._blipTimer);
        this._blipTimer = null;
      }
      try {
        this.offOpen();
        this.offClose();
      } catch (_) {}
      this.client = /** @type {RoomClientLike | null} */ (null);
    }
  }

  // ---------------------------------------------------------------------------
  // 3b. Home presence — REST heartbeat + unload beacon (IDLE / cleanup)
  // ---------------------------------------------------------------------------
  let idleTimer = /** @type {any} */ (null);

  function startIdlePresence() {
    stopIdlePresence();
    if (!loadSession()) return;
    const beat = () => {
      // Skip while a room socket owns presence.
      if (document.body.classList.contains('in-room')) return;
      api('/api/presence', { method: 'PUT', body: JSON.stringify({ status: 'IDLE' }) }).catch(
        () => {}
      );
    };
    beat();
    idleTimer = setInterval(beat, IDLE_HEARTBEAT_MS);
    if (!WP.Social._pagehideWired) {
      WP.Social._pagehideWired = true;
      // iOS/bfcache can fire pagehide without a real exit; on return the
      // presence used to stay cleared until the next beat. Heal immediately.
      window.addEventListener('pageshow', () => {
        if (document.body.classList.contains('in-room')) {
          global.dispatchEvent(new CustomEvent('wp:presence-nudge'));
        } else if (loadSession()) {
          beat();
        }
      });
      window.addEventListener('pagehide', () => {
        const s = loadSession();
        if (!s) return;
        try {
          navigator.sendBeacon(
            '/api/presence',
            new Blob([JSON.stringify({ token: s.token })], { type: 'application/json' })
          );
        } catch (_) {}
      });
    }
  }

  function stopIdlePresence() {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Shared renderers
  // ---------------------------------------------------------------------------
  /**
   * Tiny DOM helper (same pattern as catalog.js).
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** @param {string} frameId */
  function safeFrame(frameId) {
    return FRAMES.includes(frameId) ? frameId : 'default';
  }

  /**
   * Avatar with a decorative frame (frames are pure CSS, see social.css).
   * @param {string} name
   * @param {string} avatarUrl
   * @param {string} frameId
   * @param {string} [sizeClass] 'avatar--lg' | 'avatar--xl' | ''
   */
  function avatarWithFrame(name, avatarUrl, frameId, sizeClass) {
    const wrap = h('div', 'avatar-frame avatar-frame--' + safeFrame(frameId) + (sizeClass ? ' ' + sizeClass : ''));
    const img = /** @type {HTMLImageElement} */ (h('img', 'avatar-frame__img'));
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.src = avatarUrl || WP.avatarUrl(name || 'anon');
    img.onerror = () => {
      img.remove();
      wrap.appendChild(h('span', 'avatar-frame__fallback', WP.initialFor(name)));
    };
    wrap.appendChild(img);
    return wrap;
  }

  /**
   * Parse 'HH:MM:SS' / 'MM:SS' into seconds.
   * @param {string} s @returns {number}
   */
  function parseClock(s) {
    const parts = String(s || '').split(':').map((x) => parseInt(x, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return 0;
  }

  /**
   * Human text for a presence payload.
   * @param {PresencePayload} p @returns {string}
   */
  function presenceText(p) {
    if (!p) return 'Offline';
    if (p.status === 'WATCHING_PARTY') {
      const host = p.is_host ? ' (hosting)' : '';
      const ts = p.current_timestamp ? ' · ' + p.current_timestamp : '';
      return 'Watching: ' + (p.media_title || 'a title') + ts + host;
    }
    if (p.status === 'WATCHING_SOLO') {
      const ts = p.current_timestamp ? ' · ' + p.current_timestamp : '';
      return 'Watching solo: ' + (p.media_title || 'a title') + ts;
    }
    if (p.status === 'IDLE') return 'Online';
    return 'Offline';
  }

  /**
   * Live presence badge (colored dot + text). Optionally ticks the playback
   * timestamp forward between profile refreshes.
   * @param {PresencePayload} p
   * @param {boolean} [live] tick the clock every second
   * @returns {{ node: HTMLElement, destroy: () => void }}
   */
  function presenceBadge(p, live) {
    const status = p && p.status ? p.status : 'OFFLINE';
    const node = h('span', 'presence presence--' + status.toLowerCase().replace('_', '-'));
    const dot = h('span', 'presence__dot');
    dot.setAttribute('aria-hidden', 'true');
    node.appendChild(dot);
    const label = h('span', 'presence__text', presenceText(p));
    node.appendChild(label);

    let timer = /** @type {any} */ (null);
    if (live && (status === 'WATCHING_PARTY' || status === 'WATCHING_SOLO')) {
      const base = parseClock(p.current_timestamp);
      const t0 = Date.now();
      timer = setInterval(() => {
        const projected = base + Math.max(0, Math.floor((Date.now() - t0) / 1000));
        const withTs = presenceText({ ...p, current_timestamp: fmtClock(projected) });
        label.textContent = withTs;
      }, 1000);
    }
    return { node, destroy: () => timer && clearInterval(timer) };
  }

  /** seconds -> 'H:MM:SS' | 'MM:SS' (client twin of src/lib/format.js). */
  function fmtClock(/** @type {number} */ seconds) {
    let s = Math.max(0, Math.floor(Number(seconds) || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const two = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return hh > 0 ? two(hh) + ':' + two(mm) + ':' + two(ss) : two(mm) + ':' + two(ss);
  }

  /**
   * Circular level chip, Steam-style.
   * @param {number} level
   */
  function levelChip(level) {
    return h('span', 'level-chip', 'Lv ' + level);
  }

  // ---------------------------------------------------------------------------
  // 5. Search UI — people results (rendered above the media grid)
  // ---------------------------------------------------------------------------

  /**
   * @param {UserSearchHit} hit
   * @param {{ onUpdate?: () => void }} [opts]
   */
  function friendButtonNode(hit, opts) {
    const btn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm'));
    const state = hit.friendship;
    const paint = (/** @type {FriendshipState} */ st) => {
      btn.disabled = false;
      btn.classList.remove('btn--primary', 'is-busy');
      if (st === 'accepted') {
        btn.textContent = '✓ Friends';
        btn.title = 'Click to remove friend';
      } else if (st === 'pending-out') {
        btn.textContent = 'Requested';
        btn.disabled = true;
      } else if (st === 'pending-in') {
        btn.textContent = 'Accept friend';
        btn.classList.add('btn--primary');
      } else {
        btn.textContent = '＋ Add friend';
      }
    };
    paint(state);
    btn.addEventListener('click', async () => {
      const s = getSession();
      if (!s) {
        global.dispatchEvent(new CustomEvent('wp:need-signin'));
        return;
      }
      btn.disabled = true;
      btn.classList.add('is-busy');
      try {
        if (hit.friendship === 'accepted') await friendAction('remove', hit.user.username);
        else if (hit.friendship === 'pending-in') await friendAction('accept', hit.user.username);
        else await friendAction('request', hit.user.username);
        // Optimistic local flip.
        hit.friendship =
          hit.friendship === 'accepted'
            ? 'none'
            : hit.friendship === 'pending-in'
              ? 'accepted'
              : 'pending-out';
        paint(hit.friendship);
        // The friends rail listens for this and re-fetches.
        global.dispatchEvent(new CustomEvent('wp:friends-changed'));
        if (opts && opts.onUpdate) opts.onUpdate();
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Something went wrong', true);
        paint(hit.friendship);
      }
    });
    return btn;
  }

  /**
   * One user card in search results.
   * @param {UserSearchHit} hit
   * @param {{ onUpdate?: () => void }} [opts]
   */
  function userCardNode(hit, opts) {
    const card = h('div', 'user-card');
    const link = /** @type {HTMLAnchorElement} */ (h('a', 'user-card__main'));
    link.href = '/user/' + encodeURIComponent(hit.user.username);
    link.appendChild(avatarWithFrame(hit.user.displayName, hit.user.avatarUrl, hit.user.avatarFrameId, 'avatar--lg'));

    const who = h('div', 'user-card__who');
    const nameRow = h('div', 'user-card__name-row');
    nameRow.appendChild(h('span', 'user-card__name', hit.user.displayName));
    nameRow.appendChild(levelChip(hit.user.level));
    who.appendChild(nameRow);
    who.appendChild(h('div', 'user-card__username', '@' + hit.user.username));
    if (hit.user.bio) who.appendChild(h('div', 'user-card__bio', hit.user.bio));

    const badge = presenceBadge(hit.presence, false);
    who.appendChild(badge.node);
    link.appendChild(who);
    card.appendChild(link);

    const actions = h('div', 'user-card__actions');
    const view = /** @type {HTMLAnchorElement} */ (h('a', 'btn btn--ghost btn--sm', 'View profile'));
    view.href = link.href;
    actions.appendChild(view);

    if (hit.presence.room_id) {
      const join = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', '▶ Join room'));
      join.title = hit.presence.media_title ? 'Join and watch “' + hit.presence.media_title + '”' : 'Join the room';
      join.addEventListener('click', () => {
        location.assign('/room/' + encodeURIComponent(hit.presence.room_id));
      });
      actions.appendChild(join);
    }
    if (hit.friendship !== 'self') actions.appendChild(friendButtonNode(hit, opts));
    card.appendChild(actions);
    return card;
  }

  /**
   * People section for the catalog's search surface.
   * Returns null when there are no people to show.
   * @param {string} query
   * @returns {Promise<HTMLElement | null>}
   */
  async function renderPeople(query) {
    const section = h('div', 'people-results');
    section.appendChild(h('div', 'people-results__title', 'People'));
    const list = h('div', 'people-results__list');
    list.appendChild(h('div', 'people-results__hint', 'Searching people…'));
    section.appendChild(list);

    // Paint the container immediately; fill it when the API answers.
    searchUsers(query)
      .then((hits) => {
        list.innerHTML = '';
        if (!hits.length) {
          section.classList.add('is-empty');
          section.remove();
          return;
        }
        hits.forEach((hit) => list.appendChild(userCardNode(hit, {})));
      })
      .catch(() => {
        list.innerHTML = '';
        section.remove();
      });
    return section;
  }

  // ---------------------------------------------------------------------------
  // 5b. Friend rows for profiles (list + people search)
  // ---------------------------------------------------------------------------

  /**
   * One friend row in a profile's friends list (same visual language as the
   * friends rail: framed avatar, name, mini presence, [Join] when in a room).
   * @param {FriendEntry} f
   */
  function profileFriendRow(f) {
    const row = h('div', 'friend-row');
    const main = /** @type {HTMLAnchorElement} */ (h('a', 'friend-row__main'));
    main.href = '/user/' + encodeURIComponent(f.user.username);
    main.title = 'View profile';
    main.appendChild(
      avatarWithFrame(f.user.displayName, f.user.avatarUrl, f.user.avatarFrameId, 'avatar--sm')
    );
    const meta = h('div', 'friend-row__meta');
    meta.appendChild(h('span', 'friend-row__name', f.user.displayName));
    const badge = presenceBadge(f.presence, false);
    badge.node.classList.add('presence--mini');
    meta.appendChild(badge.node);
    main.appendChild(meta);
    row.appendChild(main);

    if (f.presence && f.presence.room_id) {
      const join = /** @type {HTMLButtonElement} */ (
        h('button', 'btn btn--primary btn--sm friend-row__join', 'Join')
      );
      join.type = 'button';
      join.title = f.presence.media_title
        ? 'Join and watch \u201c' + f.presence.media_title + '\u201d'
        : 'Join the room';
      join.addEventListener('click', () => {
        location.assign('/room/' + encodeURIComponent(f.presence.room_id));
      });
      row.appendChild(join);
    }
    return row;
  }

  /**
   * Re-render a `[data-friends-list]` host from profile data.
   * @param {HTMLElement} host
   * @param {FriendEntry[]} friends
   * @param {boolean} ownProfile
   */
  function renderFriendsList(host, friends, ownProfile) {
    host.innerHTML = '';
    const list = friends || [];
    if (!list.length) {
      const empty = h('div', 'profile-friends__empty');
      empty.appendChild(h('span', 'muted', ownProfile
        ? 'No friends yet — search for a name below.'
        : 'No friends yet.'));
      host.appendChild(empty);
      return;
    }
    const rows = h('div', 'profile-friends__rows');
    list.forEach((f) => rows.appendChild(profileFriendRow(f)));
    host.appendChild(rows);
  }

  /**
   * One row in the profile's people-search results: identity + presence +
   * the shared add/accept/friend button (fires 'wp:friends-changed').
   * @param {UserSearchHit} hit
   */
  function friendSearchRow(hit) {
    const row = h('div', 'friend-search__row');
    const main = /** @type {HTMLAnchorElement} */ (h('a', 'friend-row__main'));
    main.href = '/user/' + encodeURIComponent(hit.user.username);
    main.title = 'View profile';
    main.appendChild(
      avatarWithFrame(hit.user.displayName, hit.user.avatarUrl, hit.user.avatarFrameId, 'avatar--sm')
    );
    const meta = h('div', 'friend-row__meta');
    const nameRow = h('div', 'friend-row__name-row');
    nameRow.appendChild(h('span', 'friend-row__name', hit.user.displayName));
    nameRow.appendChild(h('span', 'friend-search__username', '@' + hit.user.username));
    meta.appendChild(nameRow);
    const badge = presenceBadge(hit.presence, false);
    badge.node.classList.add('presence--mini');
    meta.appendChild(badge.node);
    main.appendChild(meta);
    row.appendChild(main);
    row.appendChild(friendButtonNode(hit, {}));
    return row;
  }

  // ---------------------------------------------------------------------------
  // 6. Profile page (/user/:username)
  // ---------------------------------------------------------------------------

  /**
   * @param {HTMLElement} container
   * @param {string} username
   * @returns {() => void} cleanup
   */
  function mountProfile(container, username) {
    container.innerHTML = '';
    container.hidden = false;
    container.className = 'profile';
    container.scrollTop = 0; // open at the hero, never a stale offset
    container.appendChild(profileSkeleton());

    /** @type {(() => void)[]} */
    const cleanups = [];
    let destroyed = false;
    let refreshTimer = /** @type {any} */ (null);
    let liveBadgeDestroy = /** @type {(() => void) | null} */ (null);

    const cleanup = () => {
      destroyed = true;
      if (refreshTimer) clearInterval(refreshTimer);
      cleanups.forEach((fn) => {
        try {
          fn();
        } catch (_) {}
      });
      cleanups.length = 0;
    };

    const load = async () => {
      /** @type {UserProfileResponse | null} */
      let data = null;
      /** @type {string} */
      let errMsg = '';
      try {
        data = await getProfile(username);
      } catch (e) {
        errMsg = e instanceof Error ? e.message : 'Could not load this profile.';
      }
      if (destroyed) return;
      if (!data) {
        container.innerHTML = '';
        const empty = h('div', 'profile__missing');
        const staleDeploy = /out of date/.test(errMsg);
        empty.appendChild(
          h('h2', 'profile__missing-title', staleDeploy ? 'Deployment out of date' : 'Profile not found')
        );
        empty.appendChild(h('p', 'muted', errMsg || 'No user goes by @' + username + '.'));
        const back = /** @type {HTMLAnchorElement} */ (h('a', 'btn btn--ghost btn--sm', '← Back to browsing'));
        back.href = '/';
        empty.appendChild(back);
        container.appendChild(empty);
        return;
      }
      container.innerHTML = '';
      renderProfile(container, data, cleanups, () => {
        // Re-fetch (e.g. after edit) — keeps ticker state consistent.
        cleanup();
        void mountProfile(container, username);
      });
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(async () => {
        if (destroyed) return;
        try {
          const fresh = await getProfile(username);
          if (destroyed || !fresh) return;
          refreshLive(fresh);
        } catch (_) {}
      }, PROFILE_REFRESH_MS);
    };

    /** Hot-swap the live pieces (badge, banner, stats, friends list). */
    /** @param {UserProfileResponse} fresh */
    const refreshLive = (fresh) => {
      const me = getSession();
      const ownFresh = !!(me && fresh.user.id === me.user.id);

      const badgeHost = container.querySelector('[data-live-presence]');
      const bannerHost = container.querySelector('[data-live-activity]');
      if (badgeHost) {
        badgeHost.innerHTML = '';
        // Destroy the previous badge's ticker before replacing it.
        if (liveBadgeDestroy) liveBadgeDestroy();
        const b = presenceBadge(fresh.presence, true);
        badgeHost.appendChild(b.node);
        liveBadgeDestroy = b.destroy;
        cleanups.push(b.destroy);
      }
      if (bannerHost) {
        bannerHost.innerHTML = '';
        const banner = activityBanner(fresh);
        if (banner) bannerHost.appendChild(banner);
      }

      const statsHost = /** @type {HTMLElement | null} */ (
        container.querySelector('[data-live-stats]')
      );
      if (statsHost) {
        statsHost.innerHTML = '';
        statsHost.appendChild(statNode(fresh.user.stats.watchCount, 'watched'));
        statsHost.appendChild(statNode(fresh.user.stats.friendCount, 'friends'));
        statsHost.appendChild(statNode(fresh.user.stats.favoritesCount, 'pinned'));
      }

      const friendsHost = /** @type {HTMLElement | null} */ (
        container.querySelector('[data-friends-list]')
      );
      if (friendsHost) renderFriendsList(friendsHost, fresh.friends || [], ownFresh);
    };

    // Friend actions anywhere (search rows, profile hero) fire this event —
    // refresh the friends list + counts without losing the search input.
    let changedTimer = /** @type {any} */ (null);
    const onFriendsChanged = () => {
      if (changedTimer) clearTimeout(changedTimer);
      changedTimer = setTimeout(async () => {
        if (destroyed) return;
        try {
          const fresh = await getProfile(username);
          if (!destroyed && fresh) refreshLive(fresh);
        } catch (_) {}
      }, 450);
    };
    global.addEventListener('wp:friends-changed', onFriendsChanged);
    cleanups.push(() => {
      if (changedTimer) clearTimeout(changedTimer);
      global.removeEventListener('wp:friends-changed', onFriendsChanged);
    });

    void load();
    return cleanup;
  }

  /**
   * Inline people search for your own profile's Friends section — type a
   * name or username, add/accept right from the results.
   * @returns {HTMLElement}
   */
  function friendSearchBox() {
    const wrap = h('div', 'friend-search');
    const input = /** @type {HTMLInputElement} */ (h('input', 'field__input friend-search__input'));
    input.type = 'text';
    input.placeholder = 'Find people by name or username\u2026';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Find people to add as friends');
    wrap.appendChild(input);
    const results = h('div', 'friend-search__results');
    wrap.appendChild(results);

    let timer = /** @type {any} */ (null);
    let seq = 0;
    input.addEventListener('input', () => {
      const q = input.value.trim();
      if (timer) clearTimeout(timer);
      if (q.length < 2) {
        seq++;
        results.innerHTML = '';
        return;
      }
      timer = setTimeout(async () => {
        const mySeq = ++seq;
        results.innerHTML = '';
        results.appendChild(h('div', 'muted friend-search__hint', 'Searching\u2026'));
        try {
          const hits = await searchUsers(q);
          if (seq !== mySeq) return;
          results.innerHTML = '';
          // Yourself is not a friend candidate.
          const relevant = hits.filter((hit) => hit.friendship !== 'self');
          if (!relevant.length) {
            results.appendChild(h('div', 'muted friend-search__hint', 'No people found.'));
            return;
          }
          relevant.forEach((hit) => results.appendChild(friendSearchRow(hit)));
        } catch (_) {
          if (seq !== mySeq) return;
          results.innerHTML = '';
          results.appendChild(h('div', 'muted friend-search__hint', 'Search failed \u2014 try again.'));
        }
      }, 300);
    });
    return wrap;
  }

  function profileSkeleton() {
    // NOTE: deliberately NOT classed '.profile' — that would nest a second
    // scroll/padding surface inside the profile scroller.
    const skel = h('div', 'profile--loading');
    const bar = h('div', 'profile-skel');
    for (let i = 0; i < 3; i++) bar.appendChild(h('div', 'profile-skel__row'));
    skel.appendChild(bar);
    return skel;
  }

  /**
   * The prominent real-time activity banner (hidden when offline).
   * @param {UserProfileResponse} data
   * @returns {HTMLElement | null}
   */
  function activityBanner(data) {
    const p = data.presence;
    if (!p || (p.status !== 'WATCHING_PARTY' && p.status !== 'WATCHING_SOLO')) return null;
    const isParty = p.status === 'WATCHING_PARTY';
    const banner = h('div', 'activity-banner' + (isParty ? ' activity-banner--party' : ''));
    banner.setAttribute('role', 'status');

    const pulse = h('span', 'activity-banner__pulse');
    pulse.setAttribute('aria-hidden', 'true');
    banner.appendChild(pulse);

    const info = h('div', 'activity-banner__info');
    info.appendChild(
      h('div', 'activity-banner__title', (isParty ? 'In a Watch Party — ' : 'Watching solo — ') + (p.media_title || 'a title'))
    );
    info.appendChild(
      h(
        'div',
        'activity-banner__meta',
        (p.current_timestamp ? 'Position ' + p.current_timestamp : 'Starting now') +
          (p.is_host ? ' · Hosting' : '') +
          (isParty ? ' · Sync starts the moment you join' : '')
      )
    );
    banner.appendChild(info);

    if (p.room_id) {
      const join = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary', '⏩ Join Watch Party'));
      join.addEventListener('click', () => {
        location.assign('/room/' + encodeURIComponent(p.room_id));
      });
      banner.appendChild(join);
    }
    return banner;
  }

  /**
   * @param {HTMLElement} container
   * @param {UserProfileResponse} data
   * @param {(() => void)[]} cleanups
   * @param {() => void} onEdited reload trigger after profile edits
   */
  function renderProfile(container, data, cleanups, onEdited) {
    const me = getSession();
    const own = !!(me && me.user.id === data.user.id);
    const user = data.user;

    // ---- Hero header --------------------------------------------------------
    const hero = h('header', 'profile-hero');
    const heroInner = h('div', 'profile-hero__inner');

    heroInner.appendChild(avatarWithFrame(user.displayName, user.avatarUrl, user.avatarFrameId, 'avatar--xl'));

    const head = h('div', 'profile-hero__who');
    const nameRow = h('div', 'profile-hero__name-row');
    nameRow.appendChild(h('h1', 'profile-hero__name', user.displayName));
    nameRow.appendChild(levelChip(user.level));
    head.appendChild(nameRow);

    const sub = h('div', 'profile-hero__sub');
    sub.appendChild(h('span', 'profile-hero__username', '@' + user.username));
    sub.appendChild(h('span', 'profile-hero__dot', '·'));
    sub.appendChild(h('span', 'profile-hero__level-title', user.levelTitle));
    sub.appendChild(h('span', 'profile-hero__dot', '·'));
    sub.appendChild(
      h('span', 'profile-hero__joined', 'Joined ' + new Date(user.createdAt).toLocaleDateString())
    );
    head.appendChild(sub);

    if (user.bio) head.appendChild(h('p', 'profile-hero__bio', user.bio));

    const badgeRow = h('div', 'profile-hero__badges');
    user.badges.forEach((b) => {
      const chip = h('span', 'badge-chip');
      chip.title = b.label;
      chip.appendChild(h('span', 'badge-chip__icon', b.icon));
      chip.appendChild(h('span', 'badge-chip__label', b.label));
      badgeRow.appendChild(chip);
    });
    if (!user.badges.length) badgeRow.appendChild(h('span', 'muted', 'No badges yet — watch something!'));
    head.appendChild(badgeRow);
    heroInner.appendChild(head);

    const heroSide = h('div', 'profile-hero__side');
    const liveSlot = h('div', 'profile-hero__presence');
    liveSlot.setAttribute('data-live-presence', '');
    const liveBadge = presenceBadge(data.presence, true);
    liveSlot.appendChild(liveBadge.node);
    cleanups.push(liveBadge.destroy);
    heroSide.appendChild(liveSlot);

    // Live-refreshable stats (refreshLive re-renders counts in place).
    const stats = h('div', 'profile-hero__stats');
    stats.setAttribute('data-live-stats', '');
    stats.appendChild(statNode(user.stats.watchCount, 'watched'));
    stats.appendChild(statNode(user.stats.friendCount, 'friends'));
    stats.appendChild(statNode(user.stats.favoritesCount, 'pinned'));
    heroSide.appendChild(stats);

    const actions = h('div', 'profile-hero__actions');
    if (own) {
      const edit = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', '✎ Edit profile'));
      edit.addEventListener('click', () => openProfileEditor(user, onEdited));
      actions.appendChild(edit);
      const out = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', 'Sign out'));
      out.addEventListener('click', () => {
        signOut();
        toast('Signed out');
        onEdited();
      });
      actions.appendChild(out);
    } else if (data.friendship !== 'none' || getSession()) {
      const hit = /** @type {UserSearchHit} */ ({ user, presence: data.presence, friendship: data.friendship });
      actions.appendChild(friendButtonNode(hit, { onUpdate: onEdited }));
    }
    heroSide.appendChild(actions);
    heroInner.appendChild(heroSide);

    hero.appendChild(heroInner);
    container.appendChild(hero);

    // ---- Live activity banner ------------------------------------------------
    const liveActivity = h('div', 'profile__live');
    liveActivity.setAttribute('data-live-activity', '');
    const banner = activityBanner(data);
    if (banner) liveActivity.appendChild(banner);
    container.appendChild(liveActivity);

    // ---- Columns: showcase | friends + history --------------------------------
    const cols = h('div', 'profile__cols');

    const showcase = h('section', 'showcase');
    showcase.appendChild(h('h2', 'section-title', 'Favorites showcase'));
    const grid = h('div', 'showcase__grid');
    for (let i = 0; i < PIN_LIMIT; i++) {
      const fav = data.favorites[i] || null;
      grid.appendChild(showcaseSlot(fav, own, onEdited));
    }
    showcase.appendChild(grid);
    cols.appendChild(showcase);

    // Friends column: list (public) +, on your own profile, an inline
    // people search so you can add friends without leaving the page.
    const friendsSection = h('section', 'profile-friends');
    friendsSection.appendChild(h('h2', 'section-title', 'Friends'));
    const friendsList = h('div', 'profile-friends__list');
    friendsList.setAttribute('data-friends-list', '');
    renderFriendsList(friendsList, data.friends, own);
    friendsSection.appendChild(friendsList);
    if (own) {
      friendsSection.appendChild(friendSearchBox());
    }

    // Right column holds friends + history stacked; the grid then has
    // exactly two children (showcase | side column) at every width.
    const sideCol = h('div', 'profile__side');

    const history = h('section', 'profile-history');
    history.appendChild(h('h2', 'section-title', 'Recently watched'));
    const list = h('ol', 'profile-history__list');
    if (!data.history.length) {
      list.appendChild(h('li', 'profile-history__empty muted', 'Nothing watched yet.'));
    } else {
      data.history.forEach((item) => {
        const li = h('li', 'history-row');
        const thumb = h('div', 'history-row__thumb');
        if (item.posterUrl) {
          const im = /** @type {HTMLImageElement} */ (h('img'));
          im.src = item.posterUrl;
          im.alt = '';
          im.loading = 'lazy';
          im.referrerPolicy = 'no-referrer';
          im.onerror = () => im.remove();
          thumb.appendChild(im);
        } else {
          thumb.appendChild(document.createTextNode((item.mediaTitle || '?').slice(0, 1).toUpperCase()));
        }
        li.appendChild(thumb);

        const body = h('div', 'history-row__body');
        body.appendChild(h('div', 'history-row__title', item.mediaTitle));
        const meta = h('div', 'history-row__meta');
        const ep =
          item.season != null && item.season > 0
            ? 'S' + item.season + (item.episode != null && item.episode > 0 ? 'E' + item.episode : '') + ' · '
            : '';
        meta.appendChild(document.createTextNode(ep));
        meta.appendChild(h('span', 'history-row__ago', WP.timeAgo(item.watchedAt)));
        if (item.completed) meta.appendChild(h('span', 'history-row__done', '✓ finished'));
        body.appendChild(meta);
        li.appendChild(body);
        list.appendChild(li);
      });
    }
    history.appendChild(list);
    sideCol.appendChild(friendsSection);
    sideCol.appendChild(history);
    cols.appendChild(sideCol);

    container.appendChild(cols);

    // Keep "time ago" fresh.
    const agoTimer = setInterval(() => {
      container.querySelectorAll('.history-row__ago').forEach((el, i) => {
        const item = data.history[i];
        if (item) el.textContent = WP.timeAgo(item.watchedAt);
      });
    }, 60_000);
    cleanups.push(() => clearInterval(agoTimer));
  }

  function statNode(/** @type {number} */ value, /** @type {string} */ label) {
    const s = h('div', 'stat');
    s.appendChild(h('div', 'stat__value', String(value)));
    s.appendChild(h('div', 'stat__label', label));
    return s;
  }

  /**
   * One slot of the 4-item favorites showcase.
   * @param {FavoriteItem | null} fav
   * @param {boolean} ownProfile show "pin something" affordance
   * @param {() => void} onEdited
   */
  function showcaseSlot(fav, ownProfile, onEdited) {
    if (fav) {
      const card = /** @type {HTMLAnchorElement} */ (h('a', 'showcase__card'));
      card.href = '/search';
      card.title = fav.mediaTitle + ' — find it in the library';
      card.addEventListener('click', (e) => {
        e.preventDefault();
        location.assign('/?q=' + encodeURIComponent(fav.mediaTitle));
      });
      if (fav.posterUrl) {
        const im = /** @type {HTMLImageElement} */ (h('img', 'showcase__poster'));
        im.src = fav.posterUrl;
        im.alt = fav.mediaTitle;
        im.loading = 'lazy';
        im.referrerPolicy = 'no-referrer';
        im.onerror = () => {
          im.remove();
          card.appendChild(h('div', 'showcase__fallback', fav.mediaTitle));
        };
        card.appendChild(im);
      } else {
        card.appendChild(h('div', 'showcase__fallback', fav.mediaTitle));
      }
      card.appendChild(h('div', 'showcase__caption', fav.mediaTitle));
      return card;
    }
    const empty = h('div', 'showcase__card showcase__card--empty');
    if (ownProfile) {
      empty.appendChild(h('div', 'showcase__plus', '＋'));
      empty.appendChild(h('div', 'showcase__hint', 'Pin a favorite'));
      empty.setAttribute('role', 'button');
      empty.tabIndex = 0;
      empty.addEventListener('click', () => {
        const s = getSession();
        if (s) openProfileEditor(s.user, onEdited, true);
      });
    } else {
      empty.appendChild(h('div', 'showcase__hint', 'Empty slot'));
    }
    return empty;
  }

  // ---------------------------------------------------------------------------
  // 7. Profile editor modal
  // ---------------------------------------------------------------------------

  /**
   * @param {PublicUser} user
   * @param {() => void} onSaved
   * @param {boolean} [openFavorites] jump straight to the favorites editor
   */
  function openProfileEditor(user, onSaved, openFavorites) {
    closeModal('profile-modal');
    const modal = /** @type {HTMLElement} */ ($('profile-modal'));
    const card = /** @type {HTMLElement} */ (modal.querySelector('.modal__card--profile'));
    card.innerHTML = '';

    /** @type {FavoriteItem[]} */
    const favorites = [];

    const head = h('div', 'modal__head');
    head.appendChild(h('h2', 'modal__title', 'Edit profile'));
    const closeBtn = /** @type {HTMLButtonElement} */ (h('button', 'modal__close', '×'));
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.addEventListener('click', () => closeModal('profile-modal'));
    head.appendChild(closeBtn);
    card.appendChild(head);

    const form = /** @type {HTMLFormElement} */ (h('form'));
    form.autocomplete = 'off';

    // Display name
    const nameField = h('label', 'field');
    nameField.appendChild(h('span', 'field__label', 'Display name'));
    const nameInput = /** @type {HTMLInputElement} */ (h('input', 'field__input'));
    nameInput.type = 'text';
    nameInput.maxLength = 60;
    nameInput.value = user.displayName;
    nameField.appendChild(nameInput);
    form.appendChild(nameField);

    // Bio
    const bioField = h('label', 'field');
    bioField.appendChild(h('span', 'field__label', 'Bio'));
    const bioInput = /** @type {HTMLTextAreaElement} */ (h('textarea', 'field__input field__input--area'));
    bioInput.maxLength = 300;
    bioInput.rows = 3;
    bioInput.placeholder = 'Tell people what you love watching…';
    bioInput.value = user.bio || '';
    bioField.appendChild(bioInput);
    const bioCount = h('span', 'field__hint', (user.bio || '').length + ' / 300');
    bioInput.addEventListener('input', () => {
      bioCount.textContent = bioInput.value.length + ' / 300';
    });
    bioField.appendChild(bioCount);
    form.appendChild(bioField);

    // Avatar frame picker
    const frameField = h('div', 'field');
    frameField.appendChild(h('span', 'field__label', 'Avatar frame'));
    let selectedFrame = safeFrame(user.avatarFrameId);
    const frameRow = h('div', 'frame-picker');
    FRAMES.forEach((id) => {
      const opt = /** @type {HTMLButtonElement} */ (h('button', 'frame-picker__opt'));
      opt.type = 'button';
      opt.appendChild(avatarWithFrame(user.displayName, user.avatarUrl, id, 'avatar--sm'));
      opt.appendChild(h('span', 'frame-picker__label', FRAME_LABELS[id]));
      if (id === selectedFrame) opt.classList.add('is-selected');
      opt.addEventListener('click', () => {
        selectedFrame = id;
        frameRow.querySelectorAll('.frame-picker__opt').forEach((o) => o.classList.remove('is-selected'));
        opt.classList.add('is-selected');
      });
      frameRow.appendChild(opt);
    });
    frameField.appendChild(frameRow);
    form.appendChild(frameField);

    // Favorites (4 pins)
    const favField = h('div', 'field');
    favField.appendChild(h('span', 'field__label', 'Pinned favorites (max 4)'));
    const slots = h('div', 'pin-editor');
    const renderSlots = () => {
      slots.innerHTML = '';
      for (let i = 0; i < PIN_LIMIT; i++) {
        const fav = favorites[i];
        const slot = h('div', 'pin-editor__slot' + (fav ? '' : ' pin-editor__slot--empty'));
        if (fav) {
          if (fav.posterUrl) {
            const im = /** @type {HTMLImageElement} */ (h('img'));
            im.src = fav.posterUrl;
            im.alt = '';
            im.loading = 'lazy';
            im.referrerPolicy = 'no-referrer';
            im.onerror = () => im.remove();
            slot.appendChild(im);
          }
          slot.appendChild(h('div', 'pin-editor__title', fav.mediaTitle));
          const rm = /** @type {HTMLButtonElement} */ (h('button', 'pin-editor__remove', '×'));
          rm.type = 'button';
          rm.setAttribute('aria-label', 'Remove ' + fav.mediaTitle);
          rm.addEventListener('click', () => {
            favorites.splice(i, 1);
            renderSlots();
          });
          slot.appendChild(rm);
        } else {
          slot.appendChild(h('div', 'pin-editor__hint', 'Empty'));
        }
        slots.appendChild(slot);
      }
    };
    // Seed with the profile's current pins when editing our own profile.
    getProfile(user.username)
      .then((d) => {
        favorites.length = 0;
        (d.favorites || []).forEach((/** @type {FavoriteItem} */ f) =>
          favorites.push({
            mediaId: f.mediaId,
            mediaType: f.mediaType,
            mediaTitle: f.mediaTitle,
            posterUrl: f.posterUrl,
            displayOrder: f.displayOrder,
          })
        );
        renderSlots();
      })
      .catch(() => renderSlots());
    renderSlots();
    favField.appendChild(slots);

    // TMDB title search → pick pins
    const search = h('div', 'pin-search');
    const searchInput = /** @type {HTMLInputElement} */ (h('input', 'field__input'));
    searchInput.type = 'text';
    searchInput.placeholder = 'Search movies & series to pin…';
    search.appendChild(searchInput);
    const results = h('div', 'pin-search__results');

    /** @type {any} */
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim();
      if (searchTimer) clearTimeout(searchTimer);
      if (!q) {
        results.innerHTML = '';
        return;
      }
      searchTimer = setTimeout(async () => {
        results.innerHTML = '';
        results.appendChild(h('div', 'muted', 'Searching…'));
        try {
          const data = await WP.Catalog.api(
            '/search/multi?query=' + encodeURIComponent(q) + '&include_adult=false'
          );
          results.innerHTML = '';
          const items = (data.results || [])
            .filter((/** @type {any} */ r) => r.media_type !== 'person')
            .slice(0, 6);
          if (!items.length) {
            results.appendChild(h('div', 'muted', 'No titles found.'));
            return;
          }
          items.forEach((/** @type {any} */ r) => {
            const item = /** @type {FavoriteItem} */ ({
              mediaId: String(r.id),
              mediaType: r.media_type === 'tv' ? 'tv' : 'movie',
              mediaTitle: r.title || r.name || 'Untitled',
              posterUrl: r.poster_path
                ? 'https://image.tmdb.org/t/p/w500' + r.poster_path
                : '',
              displayOrder: 0,
            });
            const row = /** @type {HTMLButtonElement} */ (h('button', 'pin-search__row'));
            row.type = 'button';
            if (item.posterUrl) {
              const im = /** @type {HTMLImageElement} */ (h('img'));
              im.src = item.posterUrl;
              im.alt = '';
              im.loading = 'lazy';
              im.referrerPolicy = 'no-referrer';
              im.onerror = () => im.remove();
              row.appendChild(im);
            }
            row.appendChild(h('span', 'pin-search__title', item.mediaTitle));
            row.addEventListener('click', () => {
              if (favorites.some((f) => f.mediaId === item.mediaId)) {
                toast('Already pinned');
                return;
              }
              if (favorites.length >= PIN_LIMIT) {
                toast('Remove a pin first — max ' + PIN_LIMIT + '.');
                return;
              }
              favorites.push(item);
              renderSlots();
              toast('Pinned “' + item.mediaTitle + '”');
            });
            results.appendChild(row);
          });
        } catch (_) {
          results.innerHTML = '';
          results.appendChild(h('div', 'muted', 'Title search failed — try again.'));
        }
      }, 350);
    });
    search.appendChild(results);
    favField.appendChild(search);
    form.appendChild(favField);

    if (openFavorites && searchInput) {
      // Bring the favorites editor into view for showcase-slot clicks.
      setTimeout(() => favField.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    }

    // Access code (rotate only — the current code can never be re-shown)
    const codeField = h('div', 'field');
    codeField.appendChild(h('span', 'field__label', 'Access code'));
    codeField.appendChild(
      h(
        'span',
        'field__hint',
        'Your code is shown once when created — we store only a hash. Rotating gives you a new code and instantly retires the old one.'
      )
    );
    const rotate = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', '↻ Regenerate code'));
    rotate.type = 'button';
    rotate.addEventListener('click', async () => {
      rotate.disabled = true;
      rotate.textContent = 'Generating…';
      const res = await rotateAccessCode();
      if (!res.ok) {
        toast(res.message || 'Could not rotate code.', true);
        rotate.disabled = false;
        rotate.textContent = '↻ Regenerate code';
        return;
      }
      rotate.textContent = '↻ Regenerate code';
      rotate.disabled = false;
    });
    codeField.appendChild(rotate);
    form.appendChild(codeField);

    // Error + save
    const err = h('div', 'field__error');
    form.appendChild(err);
    const save = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--block', 'Save profile'));
    save.type = 'submit';
    form.appendChild(save);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        await updateProfile({
          displayName: nameInput.value.trim(),
          bio: bioInput.value.trim(),
          avatarFrameId: selectedFrame,
          favorites: favorites.map((f, i) => ({ ...f, displayOrder: i })),
        });
        closeModal('profile-modal');
        toast('Profile saved');
        onSaved();
      } catch (ex) {
        err.textContent = ex instanceof Error ? ex.message : 'Could not save profile.';
        save.disabled = false;
        save.textContent = 'Save profile';
      }
    });
    card.appendChild(form);
    modal.hidden = false;
    nameInput.focus();
  }

  function closeModal(/** @type {string} */ id) {
    const m = $(id);
    if (m) m.hidden = true;
  }

  /**
   * @param {string} text
   * @param {boolean} [isError]
   */
  function toast(text, isError) {
    const wrap = $('toasts');
    if (!wrap) return;
    const t = h('div', 'toast' + (isError ? ' toast--error' : ''), text);
    wrap.appendChild(t);
    setTimeout(() => t.classList.add('is-leaving'), 2600);
    setTimeout(() => t.remove(), 3000);
  }

  // ---------------------------------------------------------------------------
  // 8. Friends rail — right side of the home surface
  //
  // Desktop (>= 1100px): a sticky card column next to the browse feed
  // (.home--with-rail grid). Narrower: a slide-over drawer opened from the
  // "Friends" item in the side nav. Polls /api/friends every 30s while
  // visible; instant refresh on 'wp:friends-changed'.
  // ---------------------------------------------------------------------------
  const RAIL_PREF_KEY = 'wp:friends-rail'; // 'open' | 'closed' (desktop)
  const RAIL_REFRESH_MS = 30_000;
  const RAIL_BREAKPOINT = '(max-width: 1099px)';
  /** @type {{ destroy: () => void, refresh: () => void, toggle: () => void } | null} */
  let railHandle = null;

  function railPrefClosed() {
    try {
      return localStorage.getItem(RAIL_PREF_KEY) === 'closed';
    } catch (_) {
      return false;
    }
  }

  /** @param {boolean} closed */
  function setRailPrefClosed(closed) {
    try {
      localStorage.setItem(RAIL_PREF_KEY, closed ? 'closed' : 'open');
    } catch (_) {}
  }

  /**
   * @param {HTMLElement | null} container no-ops when the rail markup is
   * missing (e.g. a stale cached index.html paired with fresh scripts)
   */
  function mountFriendsRail(container) {
    if (!container) return null;
    if (railHandle) railHandle.destroy();
    railHandle = createFriendsRail(container);
    return railHandle;
  }

  /** Toggle: drawer on narrow screens, collapse/expand on desktop. */
  function toggleFriendsRail() {
    if (!railHandle) return;
    railHandle.toggle();
  }

  function refreshFriendsRail() {
    if (railHandle) railHandle.refresh();
  }

  /** @type {Record<string, number>} */
  const PRESENCE_WEIGHT = { WATCHING_PARTY: 0, WATCHING_SOLO: 1, IDLE: 2, OFFLINE: 3 };

  /**
   * @param {HTMLElement} container
   */
  function createFriendsRail(container) {
    container.innerHTML = '';
    container.hidden = false;

    // ---- chrome -------------------------------------------------------------
    const head = h('div', 'friends-rail__head');
    const titleWrap = h('div', 'friends-rail__title-wrap');
    titleWrap.appendChild(h('h2', 'friends-rail__title', 'Friends'));
    const count = h('span', 'friends-rail__count', '');
    titleWrap.appendChild(count);
    head.appendChild(titleWrap);

    const refreshBtn = /** @type {HTMLButtonElement} */ (h('button', 'friends-rail__icon-btn', '⟳'));
    refreshBtn.type = 'button';
    refreshBtn.title = 'Refresh';
    refreshBtn.setAttribute('aria-label', 'Refresh friends');
    head.appendChild(refreshBtn);

    const closeBtn = /** @type {HTMLButtonElement} */ (h('button', 'friends-rail__icon-btn', '×'));
    closeBtn.type = 'button';
    closeBtn.title = 'Hide panel';
    closeBtn.setAttribute('aria-label', 'Hide friends panel');
    head.appendChild(closeBtn);
    container.appendChild(head);

    const body = h('div', 'friends-rail__body');
    container.appendChild(body);

    const backdrop = $('friends-backdrop');

    let disposed = false;
    let loadSeq = 0;
    let changeDebounce = /** @type {any} */ (null);

    // ---- visibility ----------------------------------------------------------
    const isNarrow = () => global.matchMedia(RAIL_BREAKPOINT).matches;

    function railIsVisible() {
      if (disposed || document.hidden || container.hidden) return false;
      const homeEl = $('home');
      if (!homeEl || homeEl.hidden) return false;
      if (isNarrow() && !container.classList.contains('is-open')) return false;
      return true;
    }

    function applyVisibility() {
      if (isNarrow()) {
        container.hidden = false; // CSS keeps it off-canvas until .is-open
        const homeEl = $('home');
        if (homeEl) homeEl.classList.remove('home--with-rail');
        return;
      }
      closeDrawer();
      const closed = railPrefClosed();
      container.hidden = closed;
      const homeEl = $('home');
      if (homeEl) homeEl.classList.toggle('home--with-rail', !closed);
    }

    function openDrawer() {
      container.classList.add('is-open');
      if (backdrop) backdrop.hidden = false;
    }

    function closeDrawer() {
      container.classList.remove('is-open');
      if (backdrop) backdrop.hidden = true;
    }

    function toggle() {
      if (isNarrow()) {
        if (container.classList.contains('is-open')) closeDrawer();
        else {
          applyVisibility();
          openDrawer();
          refresh();
        }
        return;
      }
      const nowClosed = !railPrefClosed();
      setRailPrefClosed(nowClosed);
      applyVisibility();
      if (!nowClosed) refresh();
    }

    // ---- rendering -------------------------------------------------------------
    /** @param {{ friends?: any[], incoming?: any[] }} data */
    function renderData(data) {
      const friends = Array.isArray(data.friends) ? data.friends : [];
      const incoming = Array.isArray(data.incoming) ? data.incoming : [];
      count.textContent = String(friends.length);
      body.innerHTML = '';

      if (incoming.length) {
        const sec = h('div', 'friends-rail__section');
        sec.appendChild(
          h('div', 'friends-rail__section-title', 'Requests · ' + incoming.length)
        );
        incoming.forEach((u) => sec.appendChild(requestRowNode(u)));
        body.appendChild(sec);
      }

      const sorted = friends.slice().sort(
        /** @returns {number} */
        (a, b) =>
          (PRESENCE_WEIGHT[a.presence && a.presence.status] ?? 3) -
            (PRESENCE_WEIGHT[b.presence && b.presence.status] ?? 3) ||
          String(a.displayName).localeCompare(String(b.displayName))
      );
      const active = sorted.filter((f) => f.presence && f.presence.status !== 'OFFLINE');
      const offline = sorted.filter((f) => !f.presence || f.presence.status === 'OFFLINE');

      if (sorted.length) {
        if (active.length) {
          const sec = h('div', 'friends-rail__section');
          sec.appendChild(h('div', 'friends-rail__section-title', 'Active now · ' + active.length));
          active.forEach((f) => sec.appendChild(friendRowNode(f)));
          body.appendChild(sec);
        }
        if (offline.length) {
          const sec = h('div', 'friends-rail__section');
          sec.appendChild(h('div', 'friends-rail__section-title', 'Offline · ' + offline.length));
          offline.forEach((f) => sec.appendChild(friendRowNode(f)));
          body.appendChild(sec);
        }
      } else {
        const empty = h('div', 'friends-rail__empty');
        empty.appendChild(h('div', 'friends-rail__empty-icon', '👀'));
        empty.appendChild(h('p', 'friends-rail__empty-text', 'No friends yet.'));
        empty.appendChild(
          h('p', 'friends-rail__empty-hint', 'Search people by name — their cards have an “Add friend” button.')
        );
        const find = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', 'Find people'));
        find.type = 'button';
        find.addEventListener('click', () => {
          closeDrawer();
          const inp = /** @type {HTMLInputElement | null} */ (
            document.getElementById('topnav-search-input')
          );
          if (inp) {
            inp.focus();
            inp.select();
          }
        });
        empty.appendChild(find);
        body.appendChild(empty);
      }

    }

    function renderSignedOut() {
      count.textContent = '';
      body.innerHTML = '';
      const box = h('div', 'friends-rail__signin');
      box.appendChild(h('div', 'friends-rail__empty-icon', '👋'));
      box.appendChild(
        h('p', 'friends-rail__empty-text', 'You are browsing anonymously.')
      );
      box.appendChild(
        h(
          'p',
          'friends-rail__empty-hint',
          'Pick a name to get a profile (you get an access code for other devices), or use "Have an access code?" in the name dialog to sign in.'
        )
      );
      const btn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', 'Pick a name'));
      btn.type = 'button';
      btn.addEventListener('click', () => {
        closeDrawer();
        global.dispatchEvent(new CustomEvent('wp:need-signin'));
      });
      box.appendChild(btn);
      body.appendChild(box);
    }

    /** @param {Error} [err] */
    function renderError(err) {
      count.textContent = '';
      body.innerHTML = '';
      const box = h('div', 'friends-rail__empty');
      box.appendChild(h('p', 'friends-rail__empty-text', 'Could not load friends.'));
      const retry = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', 'Retry'));
      retry.type = 'button';
      retry.addEventListener('click', () => refresh());
      box.appendChild(retry);
      body.appendChild(box);
      if (err) void err;
    }

    /**
     * @param {{ username: string, displayName: string, avatarUrl: string, avatarFrameId: string }} u
     */
    function requestRowNode(u) {
      const row = h('div', 'friend-row friend-row--request');
      const main = /** @type {HTMLAnchorElement} */ (h('a', 'friend-row__main'));
      main.href = '/user/' + encodeURIComponent(u.username);
      main.appendChild(avatarWithFrame(u.displayName, u.avatarUrl, u.avatarFrameId, 'avatar--sm'));
      const meta = h('div', 'friend-row__meta');
      meta.appendChild(h('span', 'friend-row__name', u.displayName));
      meta.appendChild(h('span', 'friend-row__sub', 'wants to be friends'));
      main.appendChild(meta);
      row.appendChild(main);

      const actions = h('div', 'friend-row__actions');
      const yes = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', '✓'));
      yes.type = 'button';
      yes.title = 'Accept';
      yes.setAttribute('aria-label', 'Accept friend request from ' + u.displayName);
      yes.addEventListener('click', async () => {
        yes.disabled = true;
        try {
          await friendAction('accept', u.username);
          toast('Added ' + u.displayName);
          global.dispatchEvent(new CustomEvent('wp:friends-changed'));
          refresh();
        } catch (e) {
          yes.disabled = false;
          toast(e instanceof Error ? e.message : 'Could not accept', true);
        }
      });
      const no = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', '×'));
      no.type = 'button';
      no.title = 'Decline';
      no.setAttribute('aria-label', 'Decline friend request from ' + u.displayName);
      no.addEventListener('click', async () => {
        no.disabled = true;
        try {
          await friendAction('remove', u.username);
          global.dispatchEvent(new CustomEvent('wp:friends-changed'));
          refresh();
        } catch (e) {
          no.disabled = false;
          toast(e instanceof Error ? e.message : 'Could not decline', true);
        }
      });
      actions.appendChild(yes);
      actions.appendChild(no);
      row.appendChild(actions);
      return row;
    }

    /**
     * @param {{ username: string, displayName: string, avatarUrl: string, avatarFrameId: string, presence: PresencePayload }} f
     */
    function friendRowNode(f) {
      const row = h('div', 'friend-row');
      const main = /** @type {HTMLAnchorElement} */ (h('a', 'friend-row__main'));
      main.href = '/user/' + encodeURIComponent(f.username);
      main.title = 'View profile';
      main.appendChild(avatarWithFrame(f.displayName, f.avatarUrl, f.avatarFrameId, 'avatar--sm'));
      const meta = h('div', 'friend-row__meta');
      meta.appendChild(h('span', 'friend-row__name', f.displayName));
      const badge = presenceBadge(f.presence, false);
      badge.node.classList.add('presence--mini');
      meta.appendChild(badge.node);
      main.appendChild(meta);
      row.appendChild(main);

      if (f.presence && f.presence.room_id) {
        const join = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm friend-row__join', 'Join'));
        join.type = 'button';
        join.title = f.presence.media_title ? 'Join and watch “' + f.presence.media_title + '”' : 'Join the room';
        join.addEventListener('click', () => {
          location.assign('/room/' + encodeURIComponent(f.presence.room_id));
        });
        row.appendChild(join);
      }
      return row;
    }

    // ---- data ------------------------------------------------------------------
    async function refresh() {
      if (disposed) return;
      if (!railIsVisible()) return;
      const mySeq = ++loadSeq;

      if (!getSession()) {
        renderSignedOut();
        return;
      }
      try {
        const data = await api('/api/friends');
        if (disposed || mySeq !== loadSeq) return;
        renderData(data);
      } catch (_) {
        if (disposed || mySeq !== loadSeq) return;
        // Session may have just been cleared — show the signed-out state.
        if (!getSession()) renderSignedOut();
        else renderError();
      }
    }

    function onFriendsChanged() {
      if (changeDebounce) clearTimeout(changeDebounce);
      changeDebounce = setTimeout(() => refresh(), 400);
    }

    let resizeTimer = /** @type {any} */ (null);
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        if (!isNarrow()) closeDrawer();
        applyVisibility();
      }, 150);
    };

    // ---- wire up -----------------------------------------------------------------
    refreshBtn.addEventListener('click', () => refresh());
    closeBtn.addEventListener('click', () => {
      if (isNarrow()) closeDrawer();
      else {
        setRailPrefClosed(true);
        applyVisibility();
      }
    });
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    global.addEventListener('wp:friends-changed', onFriendsChanged);
    global.addEventListener('resize', onResize);

    const poll = setInterval(() => refresh(), RAIL_REFRESH_MS);
    applyVisibility();
    refresh();

    return {
      refresh,
      toggle,
      destroy() {
        disposed = true;
        clearInterval(poll);
        if (changeDebounce) clearTimeout(changeDebounce);
        if (resizeTimer) clearTimeout(resizeTimer);
        global.removeEventListener('wp:friends-changed', onFriendsChanged);
        global.removeEventListener('resize', onResize);
        closeDrawer();
        container.innerHTML = '';
        container.hidden = true;
        const homeEl = $('home');
        if (homeEl) homeEl.classList.remove('home--with-rail');
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------
  // Build marker: makes "which build am I running?" answerable at a glance
  // (DevTools console / WP.build / WP.apiBuild) instead of guesswork. If the
  // UI stamp and API stamp disagree, the deployment is split — redeploy.
  global.WP.build = 'ui-2026-09-13.7';
  global.WP.apiBuild = null;
  try {
    console.info('[WatchParty] UI build:', global.WP.build);
    fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => {
        global.WP.apiBuild = h && h.build ? h.build : null;
        if (global.WP.apiBuild) {
          console.info('[WatchParty] API build:', global.WP.apiBuild);
        } else {
          console.warn('[WatchParty] API build: UNKNOWN — /api/health did not return JSON. The deployed worker is stale (hard refresh / redeploy).');
        }
      })
      .catch(() => console.warn('[WatchParty] API unreachable'));
  } catch (_) {}

  global.WP.Social = {
    ensureSession,
    claimWithCode,
    rotateAccessCode,
    getSession,
    signOut,
    searchUsers,
    getProfile,
    updateProfile,
    recordHistoryFor,
    friendAction,
    RoomPresence,
    startIdlePresence,
    stopIdlePresence,
    renderPeople,
    mountProfile,
    avatarWithFrame,
    presenceBadge,
    mountFriendsRail,
    toggleFriendsRail,
    refreshFriendsRail,
  };
})(/** @type {any} */ (window));
