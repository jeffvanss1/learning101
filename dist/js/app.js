/* app.js — home browse, name/join modals, room flow, chat, and wiring */
(function (global) {
  'use strict';

  const WP = global.WP;
  const $ = (id) => document.getElementById(id);
  /**
   * Inline SVG icon (utils.js table) — the UI chrome renders no emoji.
   * @param {string} name @param {number} [size] @returns {Element}
   */
  const ic = (name, size) => (WP && WP.icon ? WP.icon(name, size) : document.createElement('span'));

  const state = {
    name: '',
    roomId: null,
    isOwner: false,
    amAllowed: false,
    myPeerId: null,
    peers: [],
    video: null,
    client: null,
    sync: null,
    presence: null, // RoomPresence (social.js) — writes KV presence via the DO
    chatLoaded: false,
    browseHandle: null,
    discoveryHandle: null,
    roomBrowseHandle: null,
    profileCleanup: null, // profile page teardown (social.js)
    scrubbing: false,
    _lastHistoryKey: null,
    _lastRecKey: null,
    _pushedRoom: false,
  };

  // Incremented whenever the playing video changes so a stale recommendations
  // fetch can never overwrite the current video's suggestions.
  let recSeq = 0;

  // May I drive playback? (host or a guest the host has granted controls to)
  function canControl() {
    return !!(state.isOwner || state.amAllowed);
  }

  // --------------------------------------------------------------------------
  // Name / join modals
  // --------------------------------------------------------------------------
  function savedName() {
    try {
      return localStorage.getItem('wp:name') || '';
    } catch (_) {
      return '';
    }
  }

  function saveName(name) {
    try {
      localStorage.setItem('wp:name', name);
    } catch (_) {}
  }

  /**
   * Show the name / access-code dialog.
   * @param {{force?: boolean, message?: string}} [opts]
   *   force:  open even when a name is already saved — REQUIRED for
   *           recovery, otherwise a stuck identity could never be changed
   *           or reclaimed via its access code.
   *   message: pre-filled error shown in the dialog.
   */
  function promptName(opts) {
    const force = !!(opts && opts.force);
    const presetMessage = (opts && opts.message) || '';
    return new Promise((resolve) => {
      if (state.name && !force) {
        resolve(state.name);
        return;
      }
      const modal = $('name-modal');
      const input = $('name-input');
      const err = $('name-error');
      try {
        input.value = savedName() || WP.randomName();
      } catch (_) {
        input.value = WP.randomName();
      }
      modal.hidden = false;
      input.focus();
      input.select();
      refreshNameAvatar(input.value);
      if (presetMessage) err.textContent = presetMessage;

      // Backdrop click closes the dialog. The listener is removed on EVERY
      // close path — a leftover {once} listener from a previous invocation
      // used to instantly close the next (e.g. forced recovery) dialog.
      const onBackdrop = (e) => {
        if (e.target === modal) done(null);
      };
      const done = (name) => {
        modal.removeEventListener('click', onBackdrop);
        modal.hidden = true;
        resolve(name);
      };
      modal.addEventListener('click', onBackdrop);

      // Access-code sign-in view (profile travels between devices). All
      // elements are optional — a stale cached page just loses the view.
      const nameForm = $('name-form');
      const codeForm = $('name-code-form');
      const codeInput = $('name-code-input');
      const codeErr = $('name-code-error');
      const codeToggle = $('name-code-toggle');
      const codeBack = $('name-code-back');
      const altRow = $('name-modal-alt');
      const hasCodeView = !!(nameForm && codeForm && codeInput && codeErr && codeToggle && codeBack);
      const showView = (/** @type {string} */ which) => {
        if (!hasCodeView) return;
        nameForm.hidden = which !== 'name';
        if (altRow) altRow.hidden = which !== 'name';
        codeForm.hidden = which !== 'code';
        if (which === 'code') codeInput.focus();
        else input.focus();
      };
      if (hasCodeView) {
        codeToggle.onclick = () => showView('code');
        codeBack.onclick = () => {
          codeErr.textContent = '';
          showView('name');
        };

        codeForm.onsubmit = async (e) => {
          e.preventDefault();
          const raw = codeInput.value.trim();
          if (!raw) {
            codeErr.textContent = 'Enter your access code.';
            return;
          }
          codeErr.textContent = '';
          if (!WP.Social) return;
          const res = await WP.Social.claimWithCode(raw);
          if (!res.ok) {
            codeErr.textContent = res.message || 'That code does not match any account.';
            return;
          }
          state.name = res.session.user.displayName;
          saveName(state.name);
          WP.Social.startIdlePresence();
          refreshProfileButton();
          toast('Welcome back, ' + state.name + '!');
          done(state.name);
        };
      }

      nameForm.onsubmit = (e) => {
        e.preventDefault();
        const n = input.value.trim();
        if (!n) {
          err.textContent = 'Please enter a name.';
          return;
        }
        err.textContent = '';
        saveName(n);
        // Create the profile (if needed); the access-code reveal modal is
        // shown by social.js on first creation.
        const finish = () => {
          if (WP.Social) {
            WP.Social.startIdlePresence();
            refreshProfileButton();
          }
          done(n);
        };
        if (WP.Social) {
          WP.Social.ensureSession(n).then((res) => {
            if (res && res.ok) {
              finish();
            } else if (res && res.reason === 'taken') {
              err.textContent =
                'That name is protected by an access code. Pick another, or choose "Have an access code?".';
            } else {
              // Offline / server trouble: keep the app usable anonymously,
              // but SAY so (with the server's detail) — silent anonymity is
              // what confused people.
              finish();
              toast(
                'Could not create your profile — you are browsing anonymously.' +
                  (res && res.message ? ' (' + res.message + ')' : '') +
                  ' Reload to retry.',
                true
              );
            }
          });
        } else {
          finish();
        }
      };
    });
  }

  function refreshNameAvatar(name) {
    const img = $('name-avatar');
    if (img) img.src = WP.avatarUrl(name || 'anon');
  }

  function openJoin() {
    $('join-modal').hidden = false;
    $('join-name').value = state.name || savedName() || WP.randomName();
    $('join-code').value = '';
    $('join-error').textContent = '';
    $('join-name').focus();
    $('join-name').select();
  }

  function closeModal(id) {
    $(id).hidden = true;
  }

  function setupChrome() {
    $('nav-join').addEventListener('click', openJoin);
    $('nav-new-room').addEventListener('click', () => startRoomWithVideo(null));

    // Profile / sign-in button in the top nav.
    const profileBtn = $('nav-profile');
    if (profileBtn) {
      profileBtn.addEventListener('click', async () => {
        let s = WP.Social && WP.Social.getSession();
        if (!s) {
          // promptName handles creation AND access-code sign-in — but it
          // resolves instantly when a name is already saved, so make sure a
          // missing session actually gets (re)created here instead of
          // silently doing nothing.
          const n = await promptName();
          if (!n) return;
          if (WP.Social) {
            const res = await WP.Social.ensureSession(n);
            if (res && res.ok) {
              s = res.session;
              WP.Social.startIdlePresence();
            } else if (res && res.reason === 'taken') {
              // Forced dialog so recovery (new name / access code) is
              // actually reachable — a toast alone is a dead end.
              await promptName({
                force: true,
                message:
                  '“' + n + '” is protected by an access code. Pick a new name, or use "Have an access code?" to sign in.',
              });
              s = (WP.Social && WP.Social.getSession()) || null;
              if (s) WP.Social.startIdlePresence();
            } else {
              toast('Could not start a session — you are still anonymous.', true);
            }
            refreshProfileButton();
          }
        }
        if (s) {
          history.pushState(null, '', '/user/' + encodeURIComponent(s.user.username));
          routeCurrent();
        } else if (!$('profile').hidden) {
          routeCurrent(); // drop out of a stale profile view
        }
      });
    }

    // social.js asks us to run the sign-in flow (e.g. "Add friend" while
    // anonymous).
    window.addEventListener('wp:need-signin', async () => {
      // Forced: this fires when the session is missing — a saved name alone
      // must not swallow the recovery dialog.
      const n = await promptName({ force: true });
      if (n && WP.Social) {
        WP.Social.startIdlePresence();
        refreshProfileButton();
      }
    });

    // Keep the view in sync with history traversal (browser Back/Forward, or
    // the `history.back()` we call when leaving a room).
    window.addEventListener('popstate', onPopState);

    // Home guide rail (left sidebar).
    setupSidenav();
    wireSearchFallback();
    // Global friends drawer — mounted ONCE at boot (body-level markup); the
    // side-nav "Friends" item only toggles it. Polling starts when opened.
    if (WP.Social) WP.Social.mountFriendsRail($('friends-rail'));

    document.querySelectorAll('.modal__close').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
    });

    // Random-handle dice buttons — no typing required.
    $('name-shuffle').addEventListener('click', () => {
      const input = $('name-input');
      input.value = WP.randomName();
      $('name-error').textContent = '';
      input.focus();
      input.select();
      refreshNameAvatar(input.value);
    });
    $('name-input').addEventListener('input', () => {
      refreshNameAvatar($('name-input').value);
    });
    $('join-shuffle').addEventListener('click', () => {
      const input = $('join-name');
      input.value = WP.randomName();
      input.focus();
      input.select();
    });

    $('history-clear').addEventListener('click', () => {
      WP.historyClear();
      state._historyServer = []; // server merge stays out for this session too
      renderHistory();
    });

    $('join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('join-name').value.trim();
      const code = $('join-code').value.trim();
      if (!name) {
        $('join-error').textContent = 'Enter your name.';
        return;
      }
      const roomId = WP.roomIdFromLink(code);
      if (!roomId) {
        $('join-error').textContent = 'Paste a full room link or a room id.';
        return;
      }
      try {
        await WP.apiGetRoom(roomId);
      } catch (err) {
        $('join-error').textContent = err.message || 'Room not found.';
        return;
      }
      state.name = name;
      saveName(name);
      // Silent profile session (same as the name modal); the code-reveal
      // modal is handled inside social.js. Joining a room never REQUIRES a
      // profile, but failures are surfaced so anonymous state is never a
      // surprise.
      if (WP.Social) {
        WP.Social.ensureSession(name).then((res) => {
          if (res && res.ok) {
            WP.Social.startIdlePresence();
            refreshProfileButton();
          } else if (res && res.reason === 'taken') {
            toast('“' + name + '” is protected by an access code — you are browsing anonymously. Use "Have an access code?" to sign in.', true);
          }
        });
      }
      $('join-error').textContent = '';
      enterRoom(roomId, null);
    });
  }

  async function startRoomWithVideo(video) {
    // History card with a saved position (>60s in): resume on ready.
    state._pendingResume = video && Number(video.position) > 60 ? Number(video.position) : null;
    // SERVER RESUME MEMORY: for signed-in viewers, the server row may know a
    // position this device doesn't (watched on the phone, resuming on the
    // laptop). tryResume() only consumes _pendingResume once the room is
    // drivable, so upgrading it mid-setup is safe; consumed = harmless no-op.
    // ANIME FROM A HISTORY CARD: server-first rows carry no anilistId - the
    // anime src (watch/anime/<anilistId>/<ep>) AND sequential auto-advance
    // both need it. Resolve once, bounded 4s, then start (same object flows
    // into the room, so the ended-path sees the id even mid-play).
    if (video && video.type === 'anime' && video.anilistId == null && video.id && WP.Catalog && WP.Catalog.anilistApi) {
      try {
        const info = await Promise.race([
          WP.Catalog.anilistApi(String(video.id)),
          new Promise((r) => setTimeout(() => r(null), 4000)),
        ]);
        if (info && info.anilistId != null) {
          video.anilistId = String(info.anilistId);
          if (info.malId != null) video.malId = String(info.malId);
          video.src = WP.Catalog.buildVideo(video, { episode: video.episode || 1 }).src;
        }
      } catch (_) {}
    }
    if (video && video.id && WP.Social && WP.Social.getServerEntry && WP.Social.getSession && WP.Social.getSession()) {
      const wantSeason = video.season != null ? Number(video.season) : null;
      const wantEp = video.episode != null ? Number(video.episode) : null;
      WP.Social.getServerEntry(String(video.id), wantSeason, wantEp)
        .then((entry) => {
          const pos = (entry && Number(entry.positionSeconds)) || 0;
          const dur = (entry && Number(entry.durationSeconds)) || 0;
          if (pos <= 60) return; // nothing useful remembered
          if (dur && pos >= dur - 30) return; // already finished — fresh start
          // Upgrade, never downgrade: local pending wins unless the server is
          // meaningfully (30s) ahead.
          if (state._pendingResume == null || pos > state._pendingResume + 30) {
            state._pendingResume = pos;
          }
        })
        .catch(() => {});
    }
    // A saved identity is reused silently — no re-login every time.
    if (!state.name) state.name = await promptName();
    if (!state.name) return;
    try {
      const room = await WP.apiCreateRoom();
      if (video) global.__wpCurrentVideo = video;
      enterRoom(room.id, video || null);
    } catch (err) {
      toast(err.message || 'Failed to create room.', true);
    }
  }

  // --------------------------------------------------------------------------
  // Entering the room
  // --------------------------------------------------------------------------
  // Keep the subtitle overlay in sync with the room's current video (it reads
  // the same clock the sync manager consumes and persists offsets per title).
  function notifySubs() {
    if (WP.Subs) WP.Subs.setVideo(state.video);
  }

  // ---- Sidenav auto-collapse in rooms ---------------------------------------
  // The room needs the space: entering a room auto-collapses the guide rail to
  // the 72px icon strip; leaving restores EXACTLY the pre-room state. The auto
  // move is NEVER persisted (it is contextual, not a preference), and a manual
  // toggle inside the room wins - we never fight an explicit click.
  function sidenavCollapsed() {
    return document.body.classList.contains('sidenav-collapsed');
  }
  function setSidenav(collapsed) {
    document.body.classList.toggle('sidenav-collapsed', collapsed);
    const t = $('nav-toggle-sidenav');
    if (t) t.setAttribute('aria-expanded', String(!collapsed));
  }

  function enterRoom(roomId, video) {
    state.roomId = roomId;
    state.video = video || null;
    notifySubs();
    state.peers = [];
    state.myPeerId = null;
    state.isOwner = false;
    state.amAllowed = false;
    state.chatLoaded = false;
    state._lastRecKey = null;
    resetRecs();

    // Room focus: the guide rail is HIDDEN entirely (CSS body.room-focus);
    // the collapsed class is kept so a peek (#room-nav-toggle) shows the
    // icon strip. Remember only whether WE collapsed it, so leaving restores
    // the user's pre-room state faithfully.
    if (!sidenavCollapsed()) {
      setSidenav(true);
      state._sidenavAuto = true;
      state._sidenavTouched = false;
    }
    document.body.classList.add('room-focus');

    // Tear down any previous session so listeners/commands never stack.
    if (state.sync) {
      state.sync.destroy();
      state.sync = null;
    }
    if (state.client) {
      state.client.close();
      state.client = null;
    }

    // Swap views.
    $('home-nav').hidden = true;
    $('home').hidden = true;
    $('profile').hidden = true;
    // #discovery AND #history-page share the fixed-height column with the
    // room — leaving either visible stacks the player and that grid on top
    // of each other (entering a room from /history split the UI).
    teardownDiscoveryView();
    teardownHistoryView();
    $('room').hidden = false;
    document.body.classList.add('in-room');
    if (WP.Social) WP.Social.stopIdlePresence();

    // Push the room URL onto history (instead of replacing it) so the browser
    // back button returns to the home page rather than leaving the app.
    const path = `/room/${roomId}`;
    if (location.pathname !== path) {
      history.pushState(null, '', path);
      state._pushedRoom = true;
    } else {
      state._pushedRoom = false;
    }

    initRoomUI();

    const sync = new WP.PlaybackSyncManager($('video-frame'));
    sync.selfName = state.name; // host sovereignty: own echoes never drive us
    state.sync = sync;
    wireSync(sync);

    const client = new WP.RoomClient(roomId);
    state.client = client;
    wireClient(client);

    // Real-time presence: room lifecycle + playback progress are pushed into
    // the KV presence engine by the WatchRoom DO on our behalf.
    if (WP.Social) {
      state.presence = new WP.Social.RoomPresence(client, {
        getVideo: () => state.video,
        getPeerCount: () => state.peers.length,
        isHost: () => state.isOwner,
      });
    }

    client.connect(state.name);

    if (state.video) sync.loadVideo(state.video);
    else showFallback();
  }

  function initRoomUI() {
    updatePeerUI();
    $('room-topic').textContent = 'Room';
    $('video-title').textContent = 'Connecting\u2026';
    $('chat').innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'Connecting to the room\u2026';
    $('chat').appendChild(empty);


    // Property assignment (not addEventListener) so re-entering a room never
    // stacks duplicate handlers — a duplicate toggle handler was a source of
    // the host play/pause loop.
    $('chat-form').onsubmit = onChatSubmit;
    $('copy-link').onclick = onCopyLink;
    $('leave-room').onclick = onLeaveRoom;
    $('toggle-play').onclick = onTogglePlay;
    $('change-video').onclick = onOpenBrowse;
    // Player LIKE: same taste signal as the catalog hearts, one tap away.
    // Element refs + painter are module-scope; only wiring lives here.
    if (WP.Social && WP.Social.getLikeIds) {
      const vid0 = state.video && state.video.id ? String(state.video.id) : null;
      WP.Social.getLikeIds().then((set) => {
        if (vid0 && state.video && String(state.video.id) === vid0) paintLike(set.has(vid0));
      });
    }
    likeBtn.onclick = () => {
      const v = state.video;
      const Social = WP.Social;
      if (!v || !v.id || !Social || !Social.toggleLike) return;
      if (!Social.getSession || !Social.getSession()) {
        Social.toast('Sign in to like titles.', true);
        return;
      }
      const was = likeBtn.classList.contains('is-liked');
      const vid = String(v.id);
      paintLike(!was); // optimistic
      Social.toggleLike({
        mediaId: vid,
        mediaType: v.type === 'tv' ? 'tv' : 'movie',
        mediaTitle: v.title || '',
        posterUrl: v.poster || '',
      })
        .then((on) => {
          // Late reply for a video we already switched away from: ignore it
          // (the server state is hydrated on the next video change anyway).
          if (state.video && String(state.video.id) === vid) paintLike(on);
        })
        .catch(() => {
          if (state.video && String(state.video.id) === vid) paintLike(was);
          toast('Could not save that like \u2014 try again.', true);
        });
    };
    // TEMPORARY navigation peek while the rail is hidden in a room: shows the
    // icon strip until toggled back. Deliberately NOT the persistent pref and
    // does NOT claim the rail (leaving still restores the pre-room state).
    $('room-nav-toggle').onclick = () => {
      const peek = document.body.classList.toggle('rail-peek');
      if (peek) setSidenav(true);
      $('room-nav-toggle').setAttribute('aria-expanded', String(peek));
    };
    // AUTO NEXT toggle (device pref): painted once here; clicks persist.
    const autoBtn = $('auto-next');
    if (autoBtn) {
      paintAutoNext();
      autoBtn.onclick = () => setAutoNext(!autoNextOn());
    }
    $('episode-switch').onclick = () => {
      const v = state.video;
      if (!v || v.type === 'movie' || !WP.Catalog.openEpisodes) return;
      WP.Catalog.openEpisodes(v, (video) => {
        if (canControl()) setRoomVideo(video);
        else requestVideo(video);
      });
    };
    $('recs-toggle').onclick = onToggleRecs;

    // The logo acts as a "back to home" button inside the room.
    const brand = $('brand-home');
    if (brand) {
      brand.onclick = (e) => {
        e.preventDefault();
        onLeaveRoom();
      };
    }

    // Mobile chat sheet toggle (header button + tapping the chat header).
    const chatToggle = $('chat-toggle');
    if (chatToggle) chatToggle.onclick = onToggleChat;

    // Custom subtitles: CC button toggles the panel; the overlay lives in
    // .player-wrap and tracks the room clock via postMessage (subs.js).
    if (WP.Subs) {
      WP.Subs.mount(document.querySelector('.player-wrap'));
      const subsBtn = $('subs-toggle');
      if (subsBtn) subsBtn.onclick = () => WP.Subs.togglePanel();
      // Host-authoritative subs: what the host loads/matches, everyone gets.
      WP.Subs.onLoaded((info) => {
        if (!state.client || !canControl() || !info || (!info.fileId && !info.label)) return;
        state.client.send({ type: 'subs', action: 'load', fileId: info.fileId || '', label: info.label || '' });
      });
      WP.Subs.onOffset((v) => {
        if (!state.client || !canControl()) return;
        state.client.send({ type: 'subs', action: 'offset', value: v });
      });
    }
    const sideHead = document.querySelector('.sidebar__head');
    if (sideHead) sideHead.onclick = onToggleChat;

  }

  // --------------------------------------------------------------------------
  // WebSocket client wiring
  // --------------------------------------------------------------------------
  function wireClient(client) {
    client.on('open', () => {
      setConnStatus('In sync', false);
      if (state._connDropped) {
        state._connDropped = false;
        toast('Connection restored.');
      }
    });
    client.on('reconnecting', () => {
      // The status chip already shows "Reconnecting\u2026" - the toast makes a
      // drop unmissable (deduped per drop, not per retry).
      if (!state._connDropped) {
        state._connDropped = true;
        toast('Connection lost \u2014 reconnecting\u2026', true);
      }
    });

    client.on('state', (msg) => {
      if (msg.you) {
        state.myPeerId = msg.you.id;
        state.isOwner = !!msg.you.owner;
        state.amAllowed = !!msg.you.allowed;
        if (state.isOwner || state.amAllowed) tryResume(); // ack arrived late
      } else if (msg.ownerId !== undefined && state.myPeerId) {
        state.isOwner = msg.ownerId === state.myPeerId;
      }
      if (msg.video && msg.video.src) {
        state.video = msg.video;
        updateVideoUI();
        notifySubs();
      }
      updateHostUI();
      if (state.sync) state.sync.handleServerMessage(msg);
      if (msg.subs && WP.Subs) {
        // Late joiner: inherit what the host loaded + how they matched it.
        if (msg.subs.fileId) WP.Subs.loadRemote(msg.subs);
        if (typeof msg.subs.offset === 'number') WP.Subs.applyRemoteOffset(msg.subs.offset);
      }
      if (Array.isArray(msg.chat)) {
        state.chatLoaded = true;
        renderChatHistory(msg.chat);
      }
      if (Array.isArray(msg.requests)) {
        msg.requests.forEach((r) => appendRequest(r));
      }
    });

    client.on('peers', (msg) => {
      state.peers = (msg.peers || []).slice();
      if (state.myPeerId) {
        const me = state.peers.find((p) => p.id === state.myPeerId);
        state.isOwner = !!(me && me.owner);
        state.amAllowed = !!(me && me.allowed);
        updateHostUI();
      }
      updatePeerUI();
    });

    client.on('system', (msg) => appendSystemMessage(msg.text));
    // Host subs replication: load the host's pick, mirror the host's match.
    client.on('subs', (msg) => {
      if (!msg || msg.by === state.myPeerId) return; // my own echo
      if (!WP.Subs) return;
      if (msg.action === 'load') WP.Subs.loadRemote(msg);
      else if (msg.action === 'offset') WP.Subs.applyRemoteOffset(msg.value);
    });
    client.on('chat', (msg) => appendChatMessage(msg.message));

    client.on('request', (msg) => {
      if (msg.request) appendRequest(msg.request);
    });

    client.on('requestResolved', (msg) => {
      WP.markRequestResolved(msg.requestId, msg.accepted);
    });

    client.on('videoChange', (msg) => {
      state.video = msg.video;
      updateVideoUI();
      notifySubs();
      if (state.sync) state.sync.handleServerMessage(msg);
    });

    client.on('play', (msg) => state.sync && state.sync.handleServerMessage(msg));
    client.on('pause', (msg) => state.sync && state.sync.handleServerMessage(msg));
    client.on('seek', (msg) => state.sync && state.sync.handleServerMessage(msg));

    // Presence nudges: reflect playback/roster changes immediately instead of
    // waiting for the periodic heartbeat (host flag, solo vs party, title).
    const presenceNudge = () => {
      if (state.presence) state.presence.syncNow();
    };
    ['play', 'pause', 'seek', 'videoChange', 'peers'].forEach((t) => client.on(t, presenceNudge));
    // bfcache/page-restore: social.js asks us to re-assert room presence.
    window.addEventListener('wp:presence-nudge', presenceNudge);

    client.on('reconnecting', (info) => {
      setConnStatus('Reconnecting\u2026', true);
      toast(`Connection lost \u2014 retrying in ${Math.ceil(info.delay / 1000)}s`);
    });

    client.on('close', () => setConnStatus('Disconnected', true));
  }

  function setConnStatus(text, syncing) {
    $('sync-text').textContent = text;
    const ind = $('sync-indicator');
    ind.hidden = false;
    ind.classList.toggle('sync-indicator--syncing', syncing);
  }

  // --------------------------------------------------------------------------
  // Playback sync wiring
  // --------------------------------------------------------------------------
  function wireSync(sync) {
    sync.on('video', () => {
      clearUpNext();
      state._lastProgAt = 0;
      updateVideoUI();
    });

    // A controller action (play / pause / seek) is applied locally by the
    // sync manager and broadcast here. The room's playback state only changes
    // through these explicit controls — never by mirroring the player's own
    // internal state, which was the source of the "host pauses itself" bug.
    sync.on('control', ({ action, time }) => {
      if (!state.client || !canControl()) return;
      if (action === 'play') state.client.send({ type: 'play', time });
      else if (action === 'pause') state.client.send({ type: 'pause', time });
      else if (action === 'seek') state.client.send({ type: 'seek', time });
    });

    sync.on('progress', ({ time, playing, duration }) => {
      updatePlayerControls(playing);
      if (state.presence) state.presence.syncProgress(time);
      saveWatchProgress({ time, playing, duration });
    });
    // Unambiguous end-of-episode signal (see player.js 'ended').
    sync.on('ended', () => onEpisodeEnded());

    sync.on('buffering', () => setConnStatus('Buffering\u2026', true));
    sync.on('ready', () => {
      if (!state.video || !state.video.src) showFallback();
      else hideFallback();
      updateHostUI();
      tryResume();
    });
    sync.on('unavailable', () => {
      toast('The player does not expose remote control (Server 2 fallback). Sync may be limited.', true);
    });
  }

  function updatePlayerControls(playing) {
    const btn = $('toggle-play');
    if (!canControl()) {
      btn.disabled = true;
      return;
    }
    btn.disabled = !state.video || !state.video.src;
    btn.querySelector('span').textContent = playing ? 'Pause' : 'Play';
    const icon = btn.querySelector('svg');
    if (icon) {
      icon.innerHTML = playing
        ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'
        : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
  }

  // --------------------------------------------------------------------------
  // Video UI
  // --------------------------------------------------------------------------
  /**
   * Room video bar meta. A rating is `{ icon: 'star' }` so the line renders a
   * real SVG star (no "\u2605" text glyph); everything else stays a string.
   * @param {any} v @returns {Array<string | { icon: string }>}
   */
  function videoMetaParts(v) {
    /** @type {Array<string | { icon: string }>} */
    const parts = [];
    if (v.rating) parts.push({ icon: 'star' }, Number(v.rating).toFixed(1));
    if (v.year) parts.push(String(v.year));
    if (v.type === 'movie') parts.push('Movie');
    else if (v.type === 'anime') parts.push('Anime');
    else parts.push('Series');
    if (v.type === 'anime' && v.episode) {
      parts.push('Ep ' + v.episode);
    } else if (v.type === 'tv' && v.season) {
      parts.push('S' + v.season + (v.episode ? 'E' + v.episode : ''));
    }
    return parts;
  }

  /**
   * @param {HTMLElement | null} el @param {any} v
   */
  function paintVideoMeta(el, v) {
    if (!el) return;
    const parts = videoMetaParts(v);
    if (!parts.length) {
      el.textContent = v.type === 'movie' ? 'Movie' : v.type === 'anime' ? 'Anime' : 'Series';
      return;
    }
    el.textContent = '';
    parts.forEach((part, i) => {
      if (i) el.appendChild(document.createTextNode(' \u00b7 '));
      if (typeof part === 'string') el.appendChild(document.createTextNode(part));
      else {
        const star = ic(part.icon, 12);
        star.classList.add('meta__icon');
        el.appendChild(star);
      }
    });
  }

  // Player LIKE: hoisted so initRoomUI (wiring) and updateVideoUI (enable +
  // re-hydrate) share one painter instead of two disconnected copies.
  const likeBtn = $('like-video');
  const likeIcon = $('like-video-icon');
  const likeLabel = $('like-video-label');
  const paintLike = (/** @type {boolean} */ on) => {
    if (likeIcon && WP.setIcon) WP.setIcon(likeIcon, on ? 'heart-fill' : 'heart', 14);
    if (likeLabel) likeLabel.textContent = on ? 'Liked' : 'Like';
    if (likeBtn) likeBtn.classList.toggle('is-liked', on);
  };

  function updateVideoUI() {
    const v = state.video;
    const thumb = $('video-thumb');
    let img = thumb ? thumb.querySelector('.video-bar__poster') : null;

    // Everyone can browse; controllers change what plays, guests request.
    const cv = $('change-video');
    cv.disabled = false;
    cv.querySelector('span').textContent = canControl() ? 'Change video' : 'Request video';
    // Like must be CLICKABLE whenever a video is loaded - the markup ships it
    // disabled, so updateVideoUI owns the enable/disable from here on.
    likeBtn.disabled = !(v && v.id);
    // Like button follows the current video's liked state. The reply is
    // validated against the CURRENT video: a slow response for a video the
    // user already switched away from must NOT paint the new video's heart.
    const Social0 = WP.Social;
    const vid = v && v.id ? String(v.id) : null;
    if (Social0 && Social0.getLikeIds && vid) {
      Social0.getLikeIds().then((set) => {
        if (state.video && String(state.video.id) === vid) paintLike(set.has(vid));
      });
    }
    // Episodes switcher: only for series/anime, and only once we have a video.
    const epBtn = $('episode-switch');
    if (epBtn) {
      const isSeries = !!(v && v.src && (v.type === 'tv' || v.type === 'anime'));
      epBtn.hidden = !isSeries;
      epBtn.disabled = !isSeries;
    }

    if (v && v.src) {
      $('video-title').textContent = v.title || 'Now playing';
      paintVideoMeta($('video-meta-line'), v);

      // Overview / description box (collapsed to a few lines, YouTube-style).
      const desc = $('video-desc');
      const ov = $('video-overview');
      if (ov && v.overview) {
        ov.textContent = v.overview;
        if (desc) desc.hidden = false;
      } else if (desc) {
        desc.hidden = true;
      }

      // Remember what was watched so the home page can show a history row.
      const hk = v.id + '|' + (v.season != null ? v.season : '') + '|' + (v.episode != null ? v.episode : '');
      if (hk !== state._lastHistoryKey) {
        state._lastHistoryKey = hk;
        WP.historyAdd(v);
        // Server-side history for signed-in profiles (fire-and-forget).
        if (WP.Social) WP.Social.recordHistoryFor(v);
      }
      if (v.poster && thumb) {
        if (!img) {
          img = document.createElement('img');
          img.className = 'video-bar__poster';
          img.alt = '';
          thumb.appendChild(img);
        }
        if (img.src !== v.poster) img.src = v.poster;
        img.onerror = () => img.remove(); // broken art must never show as a torn frame
      } else if (img) {
        img.remove();
      }
      hideFallback();
      $('toggle-play').disabled = !canControl();

      // Refresh "similar titles" only when the identity actually changes.
      const recKey = v.type + ':' + v.id;
      if (recKey !== state._lastRecKey) {
        state._lastRecKey = recKey;
        renderRecommendations();
      }
    } else {
      $('video-title').textContent = 'Nothing playing yet';
      $('video-meta-line').textContent = '';
      const desc = $('video-desc');
      if (desc) desc.hidden = true;
      if (img) img.remove();
      showFallback();
      $('toggle-play').disabled = true;
      state._lastRecKey = null;
      renderRecommendations();
    }
    $('video-hint').textContent = state.isOwner
      ? 'You are the host \u2014 playback controls sync to everyone.'
      : state.amAllowed
        ? 'You have playback controls.'
        : 'The host controls playback for everyone.';
  }

  function updateHostUI() {
    $('host-chip').hidden = !state.isOwner;
    // Play/pause is controller-only; browse/request stays visible for everyone.
    $('video-actions').hidden = false;
    $('toggle-play').style.display = canControl() ? '' : 'none';
    // Keep the sync manager aware of whether this client drives playback.
    if (state.sync) state.sync.isController = canControl();
    updateVideoUI();
  }

  function showFallback() {
    $('player-fallback').classList.add('show');
  }

  function hideFallback() {
    $('player-fallback').classList.remove('show');
  }

  function onTogglePlay() {
    if (!canControl() || !state.sync || !state.video || !state.video.src) return;
    if (state.sync.localPlaying) {
      state.sync.localPause(state.sync.localTime);
      updatePlayerControls(false); // INSTANT - never wait for the 3s status poll
    } else {
      state.sync.localPlay(state.sync.localTime);
      updatePlayerControls(true);
    }
  }

  // Collapse/expand the chat bottom sheet on small screens. No visual effect
  // on desktop (the CSS scopes the sheet to mobile), so it is safe to leave
  // the toggle always wired.
  function onToggleChat() {
    const roomEl = $('room');
    const open = roomEl.classList.toggle('chat-open');
    const btn = $('chat-toggle');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) scrollChat();
  }

  // Similar-titles panel: collapsed by default, expanded via a small button.
  function onToggleRecs() {
    const body = $('recs-body');
    const btn = $('recs-toggle');
    if (!body || !btn) return;
    const open = body.hidden;
    body.hidden = !open;
    btn.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const label = $('recs-toggle-label');
    if (label) label.textContent = open ? 'Hide similar titles' : 'Show similar titles';
  }

  function collapseRecs() {
    const body = $('recs-body');
    if (body) body.hidden = true;
    const btn = $('recs-toggle');
    if (btn) {
      btn.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
    }
    const label = $('recs-toggle-label');
    if (label) label.textContent = 'Show similar titles';
  }

  // Hide the panel, empty the scroller, and collapse it back to the toggle.
  function resetRecs() {
    const recs = $('recs');
    if (recs) recs.hidden = true;
    const scroller = $('recs-scroller');
    if (scroller) scroller.innerHTML = '';
    const count = $('recs-count');
    if (count) count.hidden = true;
    collapseRecs();
  }

  // Browse: controllers pick what plays immediately; guests propose a title
  // and the host approves it from chat.
  function onOpenBrowse() {
    $('browse-modal').hidden = false;
    const title = $('browse-modal-title');
    if (title) title.textContent = canControl() ? 'Choose a video' : 'Request a video';
    const body = $('browse-modal-body');
    state.roomBrowseHandle = WP.Catalog.mountBrowse(body, {
      onSelect: (video) => {
        if (canControl()) setRoomVideo(video);
        else requestVideo(video);
        closeBrowse();
      },
    });
  }

  function closeBrowse() {
    $('browse-modal').hidden = true;
    if (state.roomBrowseHandle) {
      state.roomBrowseHandle.destroy();
      state.roomBrowseHandle = null;
    }
  }

  function setRoomVideo(video) {
    state.video = video;
    global.__wpCurrentVideo = video;
    updateVideoUI();
    notifySubs();
    if (state.sync) state.sync.loadVideo(video);
    if (state.client) state.client.send({ type: 'videoChange', video });
  }

  function requestVideo(video) {
    if (!state.client || !video || !video.src) return;
    if (state.client.send({ type: 'request', video })) {
      toast('Request sent to the host');
    }
  }

  // "Similar content" under the player, refreshed on every video change and
  // excluding the title currently playing. Stays collapsed behind a toggle so
  // it never crowds the player controls.
  async function renderRecommendations() {
    const recs = $('recs');
    const scroller = $('recs-scroller');
    if (!recs || !scroller) return;
    const v = state.video;
    const mySeq = ++recSeq;
    resetRecs();
    if (!v || !v.id || !v.type) return;

    const hint = $('recs-hint');
    if (hint) hint.textContent = canControl()
      ? 'Pick one to play it for the room'
      : 'Pick one to request it from the host';

    let items = [];
    try {
      items = await WP.Catalog.fetchRecommendations(v);
    } catch (_) {
      items = [];
    }
    if (mySeq !== recSeq) return; // the video changed while we were fetching
    const filtered = items.filter((it) => it && it.id && it.id !== String(v.id));
    scroller.innerHTML = '';
    if (!filtered.length) return; // panel stays hidden entirely

    const count = $('recs-count');
    if (count) {
      count.hidden = false;
      count.textContent = String(filtered.length);
    }
    filtered.slice(0, 12).forEach((it) => scroller.appendChild(recCard(it)));
    collapseRecs(); // collapsed by default; the toggle reveals it
    recs.hidden = false;
  }

  function recCard(item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'upnext-item';
    b.title = item.title;

    const thumb = document.createElement('div');
    thumb.className = 'upnext-item__thumb';
    const art = item.backdrop || item.poster;
    if (art) {
      const im = document.createElement('img');
      im.src = art;
      im.alt = '';
      im.loading = 'lazy';
      im.onerror = () => {
        im.remove();
        thumb.appendChild(
          document.createTextNode((item.title || '?').slice(0, 1).toUpperCase())
        );
      };
      thumb.appendChild(im);
    } else {
      thumb.appendChild(
        document.createTextNode((item.title || '?').slice(0, 1).toUpperCase())
      );
    }

    const body = document.createElement('div');
    body.className = 'upnext-item__body';
    const title = document.createElement('div');
    title.className = 'upnext-item__title';
    title.textContent = item.title;
    const meta = document.createElement('div');
    meta.className = 'upnext-item__meta';
    const parts = [];
    if (item.rating) parts.push({ icon: 'star' }, Number(item.rating).toFixed(1));
    if (item.year) parts.push(String(item.year));
    parts.push(item.type === 'movie' ? 'Movie' : 'Series');
    meta.classList.add('meta-line');
    parts.forEach((part, i) => {
      if (i) meta.appendChild(document.createTextNode(' \u00b7 '));
      if (typeof part === 'string') meta.appendChild(document.createTextNode(part));
      else {
        const star = ic(part.icon, 11);
        star.classList.add('meta__icon');
        meta.appendChild(star);
      }
    });
    body.appendChild(title);
    body.appendChild(meta);

    b.appendChild(thumb);
    b.appendChild(body);

    b.addEventListener('click', () => {
      const play = (video) => {
        if (canControl()) setRoomVideo(video);
        else requestVideo(video);
      };
      if (item.type === 'movie') {
        play(WP.Catalog.buildVideo(item));
      } else {
        // Series/anime: open the picker so anime gets classified (AniList id).
        WP.Catalog.openDetail(item, play);
      }
    });
    return b;
  }

  // --------------------------------------------------------------------------
  // Chat
  // --------------------------------------------------------------------------
  function onChatSubmit(e) {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (state.client && state.client.send({ type: 'chat', text })) input.value = '';
  }

  function chatOpts(msg) {
    const isMe = !!(msg.peerId && msg.peerId === state.myPeerId);
    const isOwner = !!(
      msg.peerId && state.peers.some((p) => p.id === msg.peerId && p.owner)
    );
    return { isMe, isOwner };
  }

  function appendChatMessage(msg) {
    const chat = $('chat');
    const empty = chat.querySelector('.chat-empty');
    if (empty) empty.remove();
    chat.appendChild(WP.chatMessageNode(msg, chatOpts(msg)));
    scrollChat();
  }

  function appendSystemMessage(text) {
    const chat = $('chat');
    const empty = chat.querySelector('.chat-empty');
    if (empty) empty.remove();
    chat.appendChild(WP.chatMessageNode({ type: 'system', text }));
    scrollChat();
  }

  function appendRequest(request) {
    if (!request) return;
    const chat = $('chat');
    const empty = chat.querySelector('.chat-empty');
    if (empty) empty.remove();
    chat.appendChild(
      WP.chatMessageNode(
        { type: 'request', ...request, author: request.name },
        {
          canAccept: !!(state.isOwner && !request.resolved),
          onAccept: (id) => state.client && state.client.send({ type: 'accept', requestId: id }),
          onReject: (id) => state.client && state.client.send({ type: 'reject', requestId: id }),
        }
      )
    );
    scrollChat();
  }

  function renderChatHistory(messages) {
    const chat = $('chat');
    chat.innerHTML = '';
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet \u2014 say hi';
      chat.appendChild(empty);
      return;
    }
    for (const msg of messages) {
      chat.appendChild(WP.chatMessageNode(msg, chatOpts(msg)));
    }
    scrollChat();
  }

  function scrollChat() {
    const chat = $('chat');
    chat.scrollTop = chat.scrollHeight;
  }

  // --------------------------------------------------------------------------
  // Peer stack
  // --------------------------------------------------------------------------
  function updatePeerUI() {
    const count = state.peers.length;
    $('peer-count').textContent = count;
    $('peer-label').textContent = `${count} watching`;

    const stack = $('peer-stack');
    stack.innerHTML = '';
    state.peers.slice(0, 4).forEach((p) => {
      const av = document.createElement('div');
      av.className = 'peer-avatar';
      const [bg, fg] = WP.colorFor(p.name);
      av.style.background = bg;
      av.style.color = fg;
      av.title = p.name + (p.owner ? ' (host)' : '');
      av.textContent = WP.initialFor(p.name); // fallback
      const img = document.createElement('img');
      img.src = WP.avatarUrl(p.name);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      av.appendChild(img);
      stack.appendChild(av);
    });
    if (count > 4) {
      const more = document.createElement('div');
      more.className = 'peer-avatar peer-avatar--more';
      more.textContent = `+${count - 4}`;
      stack.appendChild(more);
    }

    renderPeerList();
  }

  function peerBadge(text) {
    const b = document.createElement('span');
    b.className = 'peer-badge';
    b.textContent = text;
    return b;
  }

  function renderPeerList() {
    const list = $('peer-list');
    if (!list) return;
    list.innerHTML = '';
    const peers = state.peers.slice();
    if (!peers.length) {
      list.hidden = true;
      return;
    }
    list.hidden = false;

    peers.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'peer-row';

      const av = document.createElement('div');
      av.className = 'peer-row__avatar';
      const [bg, fg] = WP.colorFor(p.name);
      av.style.background = bg;
      av.style.color = fg;
      av.textContent = WP.initialFor(p.name);
      const img = document.createElement('img');
      img.src = WP.avatarUrl(p.name);
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = () => img.remove();
      av.appendChild(img);

      const name = document.createElement('span');
      name.className = 'peer-row__name';
      name.textContent = p.name || 'Anonymous';

      row.appendChild(av);
      row.appendChild(name);

      if (p.owner) row.appendChild(peerBadge('host'));
      else if (p.allowed) row.appendChild(peerBadge('controls'));

      // Only the host manages the roster; never for the host themselves.
      if (state.isOwner && !p.owner && p.id !== state.myPeerId) {
        const actions = document.createElement('div');
        actions.className = 'peer-row__actions';
        const makeHost = document.createElement('button');
        makeHost.type = 'button';
        makeHost.className = 'peer-btn';
        makeHost.textContent = 'Make host';
        makeHost.addEventListener('click', () => {
          if (state.client) state.client.send({ type: 'transfer', peerId: p.id });
        });
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'peer-btn';
        toggle.textContent = p.allowed ? 'Revoke' : 'Allow';
        toggle.addEventListener('click', () => {
          if (state.client) {
            state.client.send({ type: p.allowed ? 'revoke' : 'grant', peerId: p.id });
          }
        });
        actions.appendChild(makeHost);
        actions.appendChild(toggle);
        row.appendChild(actions);
      }

      list.appendChild(row);
    });
  }

  // --------------------------------------------------------------------------
  // Header actions
  // --------------------------------------------------------------------------
  async function onCopyLink() {
    try {
      await WP.copyText(location.href);
      toast('Invite link copied');
    } catch (_) {
      toast('Could not copy \u2014 copy the URL from the address bar', true);
    }
  }

  function isRoomPath() {
    return /^\/room\/[A-Za-z0-9_-]+\/?$/.test(location.pathname);
  }

  // Fully tear down the room session, including stopping/unloading the player
  // so its audio cannot keep playing after the user leaves.
  function teardownRoomSession() {
    if (state.presence) {
      state.presence.destroy(); // also stops the room-sync heartbeat
      state.presence = null;
    }
    if (state.client) {
      state.client.close(); // the DO clears our presence key on disconnect
      state.client = null;
    }
    if (state.sync) {
      state.sync.destroy(); // posts pause + unloads the iframe
      state.sync = null;
    }
    if (state.roomBrowseHandle) {
      state.roomBrowseHandle.destroy();
      state.roomBrowseHandle = null;
    }
    document.body.classList.remove('in-room');
    if (WP.Social && WP.Social.getSession()) WP.Social.startIdlePresence();
    state.chatLoaded = false;
    state.video = null;
    notifySubs();
    state.isOwner = false;
    state.amAllowed = false;
    state.myPeerId = null;
    state.roomId = null;
    state._lastRecKey = null;
    resetRecs();
    $('browse-modal').hidden = true;
    // Leaving the room hands the rail back exactly as the user had it -
    // unless they expanded it themselves inside the room (last explicit
    // action wins).
    clearUpNext();
    state._lastProgAt = 0;
    state._pendingResume = null;
    state._connDropped = false;
    if (state._sidenavAuto && !state._sidenavTouched) setSidenav(false);
    document.body.classList.remove('room-focus');
    document.body.classList.remove('rail-peek');
    state._sidenavAuto = false;
    state._sidenavTouched = false;
  }

  // Show the home surface. Idempotent: re-mounts the browse UI only when we
  // are not already on the home view.
  function showHome() {
    const alreadyHome = $('room').hidden && !$('home').hidden;
    teardownDiscoveryView();
    $('room').hidden = true;
    $('profile').hidden = true;
    $('home-nav').hidden = false;
    $('home').hidden = false;
    if ($('history-page')) $('history-page').hidden = true;
    if (!alreadyHome) mountHome();
  }

  // --------------------------------------------------------------------------
  // Profile page routing (/user/:username)
  // --------------------------------------------------------------------------
  const PROFILE_RE = /^\/user\/([A-Za-z0-9_-]{1,64})\/?$/;

  // Discovery pages: every library entry in the side nav owns /discovery/:key
  // ('movie' accepted as an alias of 'movies'). Rendered by WP.Catalog.mountDiscovery.
  const DISCOVERY_RE = /^\/discovery\/(movies?|series|anime|trending|top-movies|top-tv|now-playing|airing-today)\/?$/;

  function teardownProfileView() {
    if (state.profileCleanup) {
      state.profileCleanup();
      state.profileCleanup = null;
    }
    $('profile').hidden = true;
    $('profile').innerHTML = '';
  }

  function teardownDiscoveryView() {
    if (state.discoveryHandle) {
      state.discoveryHandle.destroy();
      state.discoveryHandle = null;
    }
    $('discovery').hidden = true;
    $('discovery').innerHTML = '';
  }

  function showProfileView(username) {
    if (state.client || state.sync) teardownRoomSession();
    teardownDiscoveryView();
    teardownHistoryView();
    $('room').hidden = true;
    $('home').hidden = true;
    $('home-nav').hidden = false;
    clearSearchInputs();
    if (!WP.Social) return;
    if (state.browseHandle) {
      // Pause browse work while the profile owns the screen.
      state.browseHandle.destroy();
      state.browseHandle = null;
    }
    $('profile').hidden = false;
    state.profileCleanup = WP.Social.mountProfile($('profile'), username);
  }

  // /discovery/:key — a library collection as its own infinite-scroll page.
  function showDiscoveryView(routeKey) {
    if (state.client || state.sync) teardownRoomSession();
    teardownProfileView();
    teardownHistoryView();
    $('room').hidden = true;
    $('home').hidden = true;
    $('home-nav').hidden = false;
    clearSearchInputs();
    if (state.browseHandle) {
      // Pause browse work while the discovery page owns the screen.
      state.browseHandle.destroy();
      state.browseHandle = null;
    }
    setActiveNav(routeKey === 'movie' ? 'movies' : routeKey);
    $('discovery').hidden = false;
    state.discoveryHandle = WP.Catalog.mountDiscovery($('discovery'), {
      routeKey: routeKey,
      onSelect: (video) => startRoomWithVideo(video),
    });
  }

  // Dedicated watch-history page (own URL, own surface - NOT the home page).
  function teardownHistoryView() {
    const page = $('history-page');
    if (page && !page.hidden) {
      page.hidden = true;
      const sc = $('history-scroller');
      if (sc) sc.innerHTML = '';
    }
  }

  function showHistoryView() {
    // NEVER-BLANK GUARANTEE: a throw in ANY teardown must not leave the user
    // on a blank stuck page (home hidden, history hidden). Each step is
    // isolated; the page + render always happen; failures surface in-page.
    const steps = [
      () => {
        if (state.client || state.sync) teardownRoomSession();
      },
      () => teardownProfileView(),
      () => teardownDiscoveryView(),
      () => {
        if (state.browseHandle) {
          // Pause browse work while the history page owns the screen.
          state.browseHandle.destroy();
          state.browseHandle = null;
        }
      },
    ];
    for (const step of steps) {
      try {
        step();
      } catch (e) {
        console.error('[history] view setup step failed', e);
      }
    }
    $('room').hidden = true;
    $('home').hidden = true;
    $('home-nav').hidden = false;
    clearSearchInputs();
    const page = $('history-page');
    if (page) page.hidden = false;
    state._historyServer = null;
    state._historyServerTried = false;
    renderHistory();
    try {
      window.dispatchEvent(new CustomEvent('wp:view-changed'));
    } catch (_) {}
  }

  // Render whichever surface the current URL asks for (boot + popstate).
  const HISTORY_RE = /^\/history\/?$/;

  function routeCurrent() {
    if (HISTORY_RE.test(location.pathname)) {
      teardownProfileView();
      teardownDiscoveryView();
      showHistoryView();
      setActiveNav('history');
      return;
    }
    const profileMatch = location.pathname.match(PROFILE_RE);
    if (profileMatch) {
      showProfileView(decodeURIComponent(profileMatch[1]));
      setActiveNav('home');
      return;
    }
    const discoveryMatch = location.pathname.match(DISCOVERY_RE);
    if (discoveryMatch) {
      showDiscoveryView(discoveryMatch[1]);
      return;
    }
    if (isRoomPath()) return; // room deep-links are handled at boot
    teardownProfileView();
    teardownDiscoveryView();
    teardownHistoryView();
    showHome();
    setActiveNav('home');
    // /search?q=... and /?q=... prefill the unified search.
    const q = new URLSearchParams(location.search).get('q');
    if (q) runSearch(q);
    // The friends rail re-evaluates dock-vs-drawer on surface changes.
    window.dispatchEvent(new CustomEvent('wp:view-changed'));
  }

  function onLeaveRoom() {
    const pushed = state._pushedRoom;
    teardownRoomSession();
    if (pushed) {
      // We navigated here from the home page — step back to it in history.
      // Restore home immediately; the popstate handler re-affirms (no-op).
      state._pushedRoom = false;
      showHome();
      history.back();
      return;
    }

    // Deep-linked straight into the room: no home page behind us, so render
    // home in place.
    history.replaceState(null, '', '/');
    showHome();
  }

  // Keep the view in sync with the URL when the user (or `history.back()`)
  // traverses history. Landing on a non-room path means "back at home": tear
  // down any room session (killing the player) and show the home surface.
  function onPopState() {
    if (isRoomPath()) return; // back into a room entry — handled elsewhere
    if (!$('room').hidden || state.client || state.sync) teardownRoomSession();
    routeCurrent();
  }

  // GLOBAL ERROR SURFACE: an uncaught error or rejection used to be console-
  // only — the user saw a blank/broken UI with no explanation and we got
  // "it's blank" with nothing to debug. Now it toasts (10s) with the cause.
  window.addEventListener('error', (ev) => {
    const msg = ev && ev.error && ev.error.message ? ev.error.message : ev && ev.message;
    if (msg) toast('Error: ' + String(msg).slice(0, 160), true);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev && ev.reason;
    const msg = r && r.message ? r.message : String(r || 'unknown');
    toast('Error: ' + msg.slice(0, 160), true);
  });

  // --------------------------------------------------------------------------
  // Toasts
  // --------------------------------------------------------------------------
  function toast(text, isError) {
    const wrap = $('toasts');
    const t = document.createElement('div');
    t.className = 'toast' + (isError ? ' toast--error' : '');
    t.textContent = text;
    wrap.appendChild(t);
    setTimeout(() => t.classList.add('is-leaving'), 2600);
    setTimeout(() => t.remove(), 3000);
  }

  // --------------------------------------------------------------------------
  // Watch history (+ resume + auto-advance)
  // --------------------------------------------------------------------------
  // RESUME: the room creator continues where the history entry stopped.
  // localPlay(position) = seek + play + ADOPT the snapshot + broadcast.
  // The old version consumed the pending position on player-ready and
  // gambled that canControl() was already true - on a slow host ack the
  // broadcast was silently DROPPED, the room stayed at ~0, and convergence
  // fought the host forever (the seek-spam war). Now it RETRIES until the
  // room can actually be driven, and only ever fires ONCE.
  function tryResume() {
    const resumeAt = state._pendingResume;
    if (resumeAt == null) return;
    if (!state.sync || !state.video || !state.video.src || !canControl()) {
      // Not drivable yet (host ack still in flight): retry shortly.
      setTimeout(tryResume, 600);
      return;
    }
    state._pendingResume = null; // consumed exactly once, successfully
    setTimeout(() => {
      if (state.sync && state._pendingResume == null) state.sync.localPlay(resumeAt);
    }, 900); // let the player surface settle before seeking in
  }

  // AUTO NEXT: a device preference (like the theme), NOT room state - each
  // viewer decides whether THEIR player advances. The host's toggle decides
  // whether the ROOM advances (only the controller can change the video).
  const AUTO_NEXT_KEY = 'wp:autonext';

  /** @returns {boolean} */
  function autoNextOn() {
    try {
      return localStorage.getItem(AUTO_NEXT_KEY) !== '0';
    } catch (_) {
      return true;
    }
  }

  function paintAutoNext() {
    const btn = $('auto-next');
    if (!btn) return;
    const on = autoNextOn();
    btn.setAttribute('aria-pressed', String(on));
    const label = $('auto-next-label');
    if (label) label.textContent = 'Auto next: ' + (on ? 'on' : 'off');
    btn.classList.toggle('is-on', on);
  }

  function setAutoNext(on) {
    try {
      localStorage.setItem(AUTO_NEXT_KEY, on ? '1' : '0');
    } catch (_) {}
    paintAutoNext();
  }

  // Resume: playback position is saved into the local history entry every ~8s
  // (sync 'progress'). Starting that item again seeks to it (see _pendingResume).

  /** @param {{ time: number, playing: boolean, duration?: number }} p */
  function saveWatchProgress(p) {
    const v = state.video;
    if (!v || !v.id || !WP.historySetProgress) return;
    if (!p || !Number(p.time)) return;
    const now = Date.now();
    if (now - (state._lastProgAt || 0) < 8000) return; // throttle
    state._lastProgAt = now;
    WP.historySetProgress(v, p.time, p.duration || 0);
    // SERVER RESUME MEMORY: same cadence, fire-and-forget — any device can
    // pick up exactly here (signed-in viewers only; the helper self-gates).
    if (WP.Social && WP.Social.recordProgressFor) WP.Social.recordProgressFor(v, p.time, p.duration || 0);
  }

  function clearUpNext() {
    if (state._upNextTimer) {
      clearInterval(state._upNextTimer);
      state._upNextTimer = null;
    }
    const el = $('up-next');
    if (el) el.remove();
    state._upNextShown = false;
    state._endedToasted = false;
  }

  /** Auto-advance: what happens when the episode ends. */
  function onEpisodeEnded() {
    const v = state.video;
    // SERVER: remember this episode as finished (position = duration).
    if (v && v.id && WP.Social && WP.Social.recordProgressFor) {
      const dur = (state.sync && state.sync.duration) || 0;
      WP.Social.recordProgressFor(v, dur || 1, dur || 0);
    }
    if (!v || v.type === 'movie') return;
    // The toggle is the first gate - OFF means the ended episode just stops.
    if (!autoNextOn()) {
      clearUpNext();
      return;
    }
    if (!canControl()) {
      if (!state._endedToasted) {
        state._endedToasted = true;
        toast('Episode ended \u2014 ask the host to play the next one.');
      }
      return;
    }
    if (state._upNextShown) return;
    state._upNextShown = true;
    resolveNextEpisode(v)
      .then((next) => {
        if (!next) {
          state._upNextShown = false;
          return; // series/season finale - nothing to advance to
        }
        showUpNext(next);
      })
      .catch(() => {
        state._upNextShown = false;
      });
  }

  /**
   * TRUE next episode. Two data-correctness rules learned the hard way:
   * - TV: TMDB's season episode_count METADATA lies (The Walking Dead S02
   *   advanced to a phantom E14) - use the SEASON DETAIL episode list and
   *   skip specials. At a season finale, offer the next season's E1.
   * - Anime: the AniList-native absolute count is the source of truth
   *   (TMDB splits anime into bogus seasons and its metadata lies).
   * @returns {Promise<{season?: number, episode: number} | null>}
   */
  function resolveNextEpisode(v) {
    if (v.type === 'anime') {
      const curEp = Number(v.episode) || 1;
      // ANILIST-NATIVE: the canonical `episodes` count (worker endpoint ->
      // direct GraphQL fallback). Absolute numbering. NO anilistId (rows
      // started from a server-first history card): resolve it NOW (bounded)
      // instead of dead-ending the binge, then fall back to the TMDB walk.
      const withTimeout = (/** @type {Promise<number|null>} */ p) =>
        Promise.race([p, new Promise((r) => setTimeout(() => r(null), 4000))]);
      if (v.anilistId == null) {
        const resolved = WP.Catalog.anilistApi
          ? withTimeout(
              WP.Catalog.anilistApi(v.id)
                .then((/** @type {any} */ info) => {
                  if (info && info.anilistId != null) {
                    v.anilistId = String(info.anilistId);
                    if (info.malId != null) v.malId = String(info.malId);
                    return Number(info.episodes) || null;
                  }
                  return null;
                })
                .catch(() => null)
            )
          : Promise.resolve(null);
        return resolved.then((count) => {
          if (count) return curEp + 1 <= count ? { episode: curEp + 1 } : null;
          return tvAdvance(v); // unmatched anime: TMDB walk still advances sequentially
        });
      }
      return withTimeout(
        WP.Catalog.anilistApi(v.id)
          .then((/** @type {any} */ info) => (info && info.episodes != null ? Number(info.episodes) : null))
          .catch(() => null)
      ).then((/** @type {number|null} */ count) => {
        if (!count) return null; // unknown total - never offer a ghost episode
        return curEp + 1 <= count ? { episode: curEp + 1 } : null; // series finale
      });
    }
    return tvAdvance(v);
  }

  /** TV/UNMATCHED-ANIME sequential advance: real TMDB season list, skip specials. */
  function tvAdvance(v) {
    const curSeason = Number(v.season) || 1;
    const curEp = Number(v.episode) || 1;
    return WP.Catalog.api('/tv/' + encodeURIComponent(String(v.id)) + '/season/' + curSeason)
      .then((/** @type {any} */ season) => {
        const eps = (((season && season.episodes) || []) )
          .filter((/** @type {any} */ e) => e && e.episode_type !== 'special' && Number.isFinite(Number(e.episode_number)))
          .map((/** @type {any} */ e) => Number(e.episode_number));
        const nextEp = eps.find((/** @type {number} */ n) => n > curEp);
        if (nextEp) return { season: curSeason, episode: nextEp };
        // Season finale: first episode of the next season with content.
        return WP.Catalog.api('/tv/' + encodeURIComponent(String(v.id))).then((/** @type {any} */ data) => {
          const seasons = ((data && data.seasons) || [])
            .filter((/** @type {any} */ s) => s && Number(s.season_number) > curSeason && Number(s.episode_count) > 0)
            .sort((/** @type {any} */ x, /** @type {any} */ y) => Number(x.season_number) - Number(y.season_number));
          if (!seasons.length) return null; // series finale
          return { season: Number(seasons[0].season_number), episode: 1 };
        });
      });
  }

  /** Countdown overlay in the player: "Up next: ..." with Play now / Cancel. */
  function showUpNext(next) {
    clearUpNext();
    const host = document.querySelector('.player');
    if (!host) return;
    const v = state.video;
    const nextLabel = next.season ? 'S' + next.season + ' E' + next.episode : 'E' + next.episode;
    const bar = document.createElement('div');
    bar.id = 'up-next';
    bar.className = 'up-next';
    const label = document.createElement('span');
    label.className = 'up-next__label';
    label.textContent = 'Up next: ' + nextLabel;
    const playNow = document.createElement('button');
    playNow.type = 'button';
    playNow.className = 'btn btn--primary btn--sm';
    playNow.textContent = 'Play now';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost btn--sm';
    cancel.textContent = 'Cancel';
    bar.appendChild(label);
    bar.appendChild(playNow);
    bar.appendChild(cancel);
    host.appendChild(bar);

    const advance = () => {
      clearUpNext();
      if (!state.video || !state.sync) return;
      setRoomVideo(WP.Catalog.buildVideo(state.video, { season: next.season != null ? next.season : state.video.season, episode: next.episode }));
    };
    let left = 5;
    label.textContent = 'Up next: ' + nextLabel + ' in ' + left + 's';
    state._upNextTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        advance();
        return;
      }
      label.textContent = 'Up next: ' + nextLabel + ' in ' + left + 's';
    }, 1000);
    playNow.addEventListener('click', advance);
    cancel.addEventListener('click', clearUpNext);
  }

  function renderHistory() {
    const scroller = $('history-scroller');
    const empty = $('history-empty');
    // NOTE: the old guard also required $('history') — an element removed
    // from the DOM long ago — so the page silently rendered NOTHING
    // ("/history doesn't show"). Only the scroller is required now.
    if (!scroller) return;
    try {

      // SERVER-FIRST (user directive): when signed in, the ACCOUNT history is
      // the source of truth - server rows become fully playable cards (src is
      // rebuilt from the id) with their resume positions; local entries only
      // fill gaps. Signed out: local history is all there is.
      const local = WP.historyGet();
      const kOf = (id, s, e) => `${id}|${s != null ? s : ''}|${e != null ? e : ''}`;
      const sess = WP.Social && WP.Social.getSession ? WP.Social.getSession() : null;
      const server = state._historyServer;
      let merged;
      if (sess && server) {
        const seen = new Set();
        const fromServer = server.map((h) => {
          const type = h.mediaType === 'tv' ? 'tv' : h.mediaType === 'anime' ? 'anime' : 'movie';
          let src = '';
          try {
            src = WP.Catalog && WP.Catalog.buildVideo
              ? WP.Catalog.buildVideo(
                  { id: String(h.mediaId), type, title: h.mediaTitle || 'Untitled', poster: h.posterUrl || '', year: '', overview: '', rating: null },
                  { season: h.season || 1, episode: h.episode || 1 }
                ).src
              : '';
          } catch (_) {}
          seen.add(kOf(String(h.mediaId), h.season || null, h.episode || null));
          return {
            type, id: String(h.mediaId), src,
            title: h.mediaTitle || 'Untitled', year: '', poster: h.posterUrl || '', backdrop: h.backdropUrl || '',
            season: h.season || null, episode: h.episode || null,
            watchedAt: h.watchedAt || 0, completed: !!h.completed,
            position: Number(h.positionSeconds) || 0,
            duration: Number(h.durationSeconds) || 0,
          };
        });
        const localExtras = local.filter((v) => !seen.has(kOf(v.id, v.season, v.episode)));
        merged = fromServer.concat(localExtras);
        merged.sort((x, y) => (y.watchedAt || 0) - (x.watchedAt || 0));
      } else {
        merged = local.slice();
      }
      if (!state._historyServerTried && WP.Social && WP.Social.getServerHistoryStatus && sess) {
        // One fetch per page visit; re-render merges it in when it arrives.
        state._historyServerTried = true;
        WP.Social.getServerHistoryStatus().then((r) => {
          state._historyServer = r && Array.isArray(r.items) ? r.items : [];
          state._historyStatusError = r && r.error && r.error !== 'signed-out' ? r.error : null;
          const page = $('history-page');
          if (page && !page.hidden) renderHistory();
        });
      }

      // Filter chips (All / Movies / Series / Anime).
      const f = state._historyFilter || 'all';
      const items = merged.filter((v) => {
        if (f === 'all') return true;
        if (f === 'movie') return v.type === 'movie';
        if (f === 'tv') return v.type === 'tv';
        if (f === 'anime') return v.type === 'anime';
        return true;
      });

      renderHistoryChips(merged.length);
      paintHistoryStatus(items);
      if (empty) empty.hidden = !!items.length;
      if (!items.length) {
        scroller.innerHTML = '';
        // SELF-EXPLANATORY EMPTY: signed-out users must learn that history is
        // account-bound (cross-device), not a rendering failure.
        if (empty) {
        const signedIn = !!(WP.Social && WP.Social.getSession && WP.Social.getSession());
        empty.textContent = signedIn
        ? 'Nothing watched on your account yet - press play on anything and it will show up here.'
        : 'Nothing here on this device yet. Sign in and your watch history follows you across every device.';
        }
        return;
      }
      scroller.innerHTML = '';
      items.forEach((v) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'history-card';
        card.title = v.title;
        card.dataset.mediakey = v.type + ':' + v.id + '|' + (v.season != null ? v.season : '') + '|' + (v.episode != null ? v.episode : '');

        const poster = document.createElement('div');
        poster.className = 'history-card__poster';
        const src = v.backdrop || v.poster;
        if (src) {
          const im = document.createElement('img');
          im.src = src;
          im.alt = '';
          im.loading = 'lazy';
          im.onerror = () => im.remove();
          poster.appendChild(im);
        }
        // Resume position: YouTube-style red progress bar under the artwork.
        // WATCHED FADE: a finished movie/episode shows a FULL faded bar (like
        // YouTube's watched state) instead of nothing.
        const finished = !!v.completed || (v.duration > 0 && v.position > 0 && v.position >= v.duration - 30);
        if (finished) {
          const prog = document.createElement('div');
          prog.className = 'history-card__progress';
          const fill = document.createElement('div');
          fill.className = 'history-card__progress-fill history-card__progress-fill--done';
          fill.style.width = '100%';
          prog.appendChild(fill);
          poster.appendChild(prog);
        } else if (v.position > 15 && v.duration && v.position < v.duration - 30) {
          const prog = document.createElement('div');
          prog.className = 'history-card__progress';
          const fill = document.createElement('div');
          fill.className = 'history-card__progress-fill';
          fill.style.width = Math.min(100, Math.round((v.position / v.duration) * 100)) + '%';
          prog.appendChild(fill);
          poster.appendChild(prog);
        }
        const body = document.createElement('div');
        body.className = 'history-card__body';
        const title = document.createElement('div');
        title.className = 'history-card__title';
        title.textContent = v.title;
        const meta = document.createElement('div');
        meta.className = 'history-card__meta';
        const ep = v.season != null ? `S${v.season} E${v.episode} · ` : '';
        const when = v.completed ? 'Watched' : WP.timeAgo(v.watchedAt);
        meta.textContent = ep + when;
        body.appendChild(title);
        body.appendChild(meta);

        // Per-item remove (does not nuke the whole history).
        const rm = document.createElement('span');
        rm.className = 'history-card__remove';
        // Guarded WP.icon (no free identifier): renderHistory is executed
        // standalone by the behavioral harness, which injects WP.
        if (WP.icon) rm.appendChild(WP.icon('x', 13));
        rm.title = 'Remove from history';
        rm.setAttribute('role', 'button');
        rm.setAttribute('aria-label', 'Remove ' + v.title + ' from history');
        rm.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          WP.historyRemove(WP.historyKey(v));
          state._historyServer = (state._historyServer || []).filter(
            (h) => kOf(String(h.mediaId), h.season || null, h.episode || null) !== kOf(v.id, v.season, v.episode)
          );
          renderHistory();
        });
        // THE FIX: poster + body were BUILT but never ATTACHED - every card
        // rendered as an empty box. (Lost in a refactor; tests only counted
        // cards, never their contents.)
        card.appendChild(poster);
        card.appendChild(body);
        card.appendChild(rm);

        // Server-only entries have no src - they link to a fresh start (and
        // still resume if a local position exists for them later).
        // Every card now has a playable src (server rows are rebuilt from the
        // id) and its remembered position - click = resume exactly there.
        card.addEventListener('click', () => startRoomWithVideo(v));
        scroller.appendChild(card);
      });
      // POSTER SELF-HEAL: rows recorded without artwork get a TMDB lookup
      // (bounded queue), the card is painted in place, and the server row is
      // patched - the database heals itself over one page visit. Cosmetic
      // ONLY: a failure here can never nuke the rendered cards.
      try {
        healHistoryPosters(items);
      } catch (_) {}

      // SELF-DIAGNOSIS: the status line reports how many cards were BUILT
      // and how many are ACTUALLY in the DOM - "Account: 62 · Device: 13 ·
      // Cards: 75 (DOM: 75)". A mismatch pinpoints the failing layer
      // instantly (0 built = logic, built-but-absent = environment).
      try {
        console.log('[history] rendered', items.length, 'cards,', scroller.children.length, 'in DOM');
      } catch (_) {}
      } catch (e) {
        // NEVER silent: a failed render shows WHY instead of a blank page.
        console.error('[history] render failed', e);
        scroller.innerHTML = '';
        if (empty) {
          empty.textContent = 'History failed to load: ' + ((e && e.message) || e);
          empty.hidden = false;
        }
      }
  }

  // ---- Poster self-heal (bounded, cached, self-patching) ---------------------
  const POSTER_QUEUED = 'data-poster-queued';
  /** mediaKey -> Promise<posterUrl>; one lookup per title per session. */
  const posterLookups = new Map();

  /** @param {{ id: string|number, type: string }} v @returns {Promise<{poster: string, backdrop: string}>} */
  function lookupArt(v) {
    const key = v.type + ':' + v.id;
    if (posterLookups.has(key)) return posterLookups.get(key);
    const base = v.type === 'movie' ? '/movie/' : '/tv/';
    const p = WP.Catalog
      .api(base + encodeURIComponent(String(v.id)))
      .then((d) => ({
        poster: d && d.poster_path ? 'https://image.tmdb.org/t/p/w500' + d.poster_path : '',
        backdrop: d && d.backdrop_path ? 'https://image.tmdb.org/t/p/w780' + d.backdrop_path : '',
      }))
      .catch(() => ({ poster: '', backdrop: '' }));
    posterLookups.set(key, p);
    return p;
  }

  /**
   * Fill in missing card artwork + patch the server rows. Concurrency is
   * capped (150ms stagger) — never a fan-out burst.
   * @param {Array<any>} items rendered history entries
   */
  function healHistoryPosters(items) {
    // Landscape-first: anything missing its BACKDROP gets healed (rows that
    // only carry a vertical poster are re-resolved once, then permanent).
    const missing = items.filter((v) => !v.backdrop && v.id);
    if (!missing.length) return;
    console.log('[history] healing posters:', missing.length);
    let idx = 0;
    const run = () => {
      if (idx >= missing.length) return;
      const v = missing[idx++];
      const card = /** @type {HTMLElement | null} */ (document.querySelector('.history-card[data-mediakey="' + v.type + ':' + v.id + '|' + (v.season != null ? v.season : '') + '|' + (v.episode != null ? v.episode : '') + '"]'));
      const finish = (art) => {
        if (!art || (!art.backdrop && !art.poster) || !card || !card.isConnected) return;
        const box = card.querySelector('.history-card__poster');
        // LANDSCAPE FIRST: the card box is 16:9 — the native backdrop fills
        // it perfectly; the vertical poster is only the fallback.
        const url = art.backdrop || art.poster;
        if (box) {
          const im = box.querySelector('img');
          if (im) im.src = url;
          else if (box) {
            const el = document.createElement('img');
            el.src = url;
            el.alt = '';
            el.loading = 'lazy';
            box.appendChild(el);
          }
        }
        // Patch the server row (poster + backdrop) so the fix is permanent.
        if (WP.Social && WP.Social.recordHistoryFor) {
          WP.Social.recordHistoryFor({
            id: v.id, type: v.type, title: v.title,
            poster: art.poster || v.poster || '',
            backdrop: art.backdrop || '',
            season: v.season, episode: v.episode,
            position: v.position, duration: v.duration,
          });
        }
      };
      if (card) card.setAttribute(POSTER_QUEUED, '1');
      lookupArt(v).then(finish);
      setTimeout(run, 150);
    };
    run();
  }

  /** Status line: clean type breakdown (All / Movies / Series / Anime). */
  function paintHistoryStatus(items) {
    const el = $('history-status');
    if (!el) return;
    const signedIn = !!(WP.Social && WP.Social.getSession && WP.Social.getSession());
    if (!signedIn || !state._historyServerTried) {
      el.hidden = true;
      return;
    }
    if (!state._historyServer && state._historyStatusError) {
      el.hidden = false;
      el.classList.add('history__status--err');
      el.textContent = 'Account history unavailable: ' + state._historyStatusError + ' - showing this device only.';
      return;
    }
    el.classList.remove('history__status--err');
    el.hidden = false;
    const byType = { movie: 0, tv: 0, anime: 0 };
    (items || []).forEach((v) => {
      if (v.type === 'movie') byType.movie++;
      else if (v.type === 'anime') byType.anime++;
      else if (v.type === 'tv') byType.tv++;
    });
    el.textContent =
      'All Titles: ' + (items ? items.length : 0) +
      ' \u00b7 Movies: ' + byType.movie +
      ' \u00b7 Series: ' + byType.tv +
      ' \u00b7 Anime: ' + byType.anime;
  }

  /** Filter chip row (All / Movies / Series / Anime) for the history page. */
  function renderHistoryChips(total) {
    const host = $('history-filters');
    if (!host) return;
    const opts = [
      ['all', 'All'],
      ['movie', 'Movies'],
      ['tv', 'Series'],
      ['anime', 'Anime'],
    ];
    const f = state._historyFilter || 'all';
    host.innerHTML = '';
    opts.forEach(([val, label]) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (f === val ? ' chip--active' : '');
      chip.textContent = label;
      chip.addEventListener('click', () => {
        state._historyFilter = val;
        renderHistory();
      });
      host.appendChild(chip);
    });
    host.hidden = !total;
  }

  // --------------------------------------------------------------------------
  // Home guide rail (left sidebar) — persistent across home and room views
  // --------------------------------------------------------------------------
  // Assigned by setupSidenav; lets routeCurrent keep the side nav's active
  // item in sync with the surface the URL asks for.
  let setActiveNav = /** @type {(key: string) => void} */ (function () {});

  // Leave the room (if any) and land on the home surface, preserving the
  // browser Back behavior used everywhere else in the app.
  function goHome() {
    const pushed = state._pushedRoom;
    teardownRoomSession();
    if (pushed) {
      state._pushedRoom = false;
      showHome();
      history.back();
    } else {
      history.replaceState(null, '', '/');
      showHome();
    }
  }

  function scrollHomeTop() {
    const home = $('home');
    if (home && home.scrollTo) home.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearSearchInputs() {
    const input = $('topnav-search-input');
    if (input && input.value) input.value = '';
    const sideInput = $('sidenav-search-input');
    if (sideInput && sideInput.value) sideInput.value = '';
  }

  function setupSidenav() {
    const nav = $('sidenav');
    if (!nav) return;
    const items = Array.from(nav.querySelectorAll('.sidenav__item[data-nav]'));
    const setActive = (key) => {
      items.forEach((it) => it.classList.toggle('is-active', it.dataset.nav === key));
    };
    setActiveNav = setActive;

    items.forEach((it) => {
      it.addEventListener('click', () => {
        const key = it.dataset.nav;
        const inRoom = !$('room').hidden;

        if (key === 'home') {
          if (inRoom) {
            goHome();
            return;
          }
          if (
            !$('profile').hidden ||
            !$('discovery').hidden ||
            !$('history-page').hidden // DEAD END FIX: leaving /history had NO branch — Home did nothing.
          ) {
            // Leaving the profile/discovery/history page: push '/' so Back returns to it.
            history.pushState(null, '', '/');
            routeCurrent();
            return;
          }
          clearSearchInputs();
          if (state.browseHandle && state.browseHandle.refresh) state.browseHandle.refresh();
          setActive('home');
          scrollHomeTop();
        } else if (key === 'history') {
          // Dedicated page: real URL, back-button friendly.
          if (inRoom) goHome();
          if (location.pathname !== '/history') {
            history.pushState(null, '', '/history');
          }
          routeCurrent();
        } else if (key === 'admin') {
          // Admin drawer (only visible when the signed-in user is_admin).
          if (WP.Social && WP.Social.toggleAdminPanel) WP.Social.toggleAdminPanel();
        } else if (key === 'friends') {
          // Friends drawer: a global slide-over (right → left) on every
          // surface — home, /discovery pages, profiles and rooms alike.
          if (WP.Social) WP.Social.toggleFriendsRail();
        } else if (key === 'start-room') {
          startRoomWithVideo(null);
        } else {
          // Library entries own a /discovery/:key page (infinite scroll).
          if (inRoom) goHome();
          const route = '/discovery/' + key;
          if (location.pathname !== route) {
            history.pushState(null, '', route);
            routeCurrent(); // also syncs the active nav item
          }
        }
      });
    });

    // Collapse/expand toggle (desktop): remembered across visits.
    const toggle = $('nav-toggle-sidenav');
    if (toggle) {
      const apply = (collapsed) => {
        document.body.classList.toggle('sidenav-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
      };
      try {
        apply(localStorage.getItem('wp:sidenav') === 'collapsed');
      } catch (_) {}
      toggle.addEventListener('click', () => {
        const collapsed = document.body.classList.toggle('sidenav-collapsed');
        try {
          localStorage.setItem('wp:sidenav', collapsed ? 'collapsed' : 'open');
        } catch (_) {}
        toggle.setAttribute('aria-expanded', String(!collapsed));
        // Expanded BY HAND inside a room: the user owns the rail state now -
        // leaving the room must not re-collapse it behind their back.
        if (state.roomId && !collapsed) state._sidenavTouched = true;
      });
    }
  }

  // --------------------------------------------------------------------------
  // Top-nav profile button state
  // --------------------------------------------------------------------------
  function refreshProfileButton() {
    const btn = $('nav-profile');
    if (!btn) return;
    const s = WP.Social && WP.Social.getSession();
    const img = $('nav-profile-avatar');
    const fallback = btn.querySelector('.topnav__profile-fallback');
    if (s && img) {
      img.hidden = false;
      // Prefer the stored account avatar; DiceBear(name) is only the
      // fallback for legacy sessions without one.
      img.src = s.user.avatarUrl || WP.avatarUrl(s.user.displayName || s.user.username);
      if (fallback) fallback.style.display = 'none';
      btn.title = 'Your profile — @' + s.user.username;
    } else {
      if (img) {
        img.hidden = true;
        img.removeAttribute('src');
      }
      if (fallback) fallback.style.display = '';
      btn.title = 'Sign in to WatchParty';
    }
  }

  // On surfaces without a mounted browse feed (profiles, /discovery pages)
  // the two search bars have no live listeners — mountBrowse owns them while
  // it exists. Pressing Enter there routes to /?q=… so the home surface
  // mounts and runs the search (routeCurrent handles the prefill).
  function wireSearchFallback() {
    [$('topnav-search-input'), $('sidenav-search-input')].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || state.browseHandle) return;
        const q = inp.value.trim();
        if (!q) return;
        ev.preventDefault();
        history.pushState(null, '', '/?q=' + encodeURIComponent(q));
        routeCurrent();
      });
    });
  }

  // Drive the catalog's search pipeline from a raw query (deep links like
  // /search?q=... or /?q=... — also used by profile showcase slots).
  function runSearch(query) {
    const q = String(query || '').trim();
    if (!q) return;
    [$('topnav-search-input'), $('sidenav-search-input')].forEach((inp) => {
      if (!inp) return;
      inp.value = q;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // --------------------------------------------------------------------------
  // Home browse
  // --------------------------------------------------------------------------
  function mountHome() {
    if (state.browseHandle) {
      state.browseHandle.destroy();
      state.browseHandle = null;
    }
    state.browseHandle = WP.Catalog.mountBrowse($('browse'), {
      onSelect: (video) => startRoomWithVideo(video),
      // Two search bars drive the same search (kept in sync): the top-nav bar
      // that shares the logo row and the side-rail's dedicated search bar.
      searchInputs: [$('topnav-search-input'), $('sidenav-search-input')],
      // People results (profiles + live presence) render above media results.
      peopleProvider: WP.Social ? (q) => WP.Social.renderPeople(q) : null,
    });
    // (The friends drawer is global — mounted once at boot, overlays any view.)
  }

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  async function handleDeepLink(roomId) {
    let name = state.name || savedName();
    if (!name) name = await promptName();
    if (!name) {
      mountHome();
      return;
    }
    state.name = name;
    try {
      await WP.apiGetRoom(roomId);
    } catch (err) {
      toast(err.message || 'Room not found.', true);
      mountHome();
      return;
    }
    enterRoom(roomId, null);
  }

  function boot() {
    setupChrome();
    // Restore the saved identity so we never ask for a name twice.
    state.name = savedName();
    // Resume the saved profile (token in localStorage) + IDLE heartbeat.
    // Passing the saved name matters: users whose session creation once
    // failed (or who predate sessions) have a name but no session — without
    // the name this call could never (re)create it and they would browse
    // anonymously forever with no prompt (promptName resolves instantly
    // when a name is already saved).
    if (state.name && WP.Social) {
      WP.Social.ensureSession(state.name).then((res) => {
        if (res && res.ok) {
          WP.Social.startIdlePresence();
          refreshProfileButton();
        } else if (res && res.reason === 'taken') {
          // Stuck identity: the saved name is protected by an access code.
          // Open the dialog FORCED (it would otherwise short-circuit on the
          // saved name and the user could never recover).
          promptName({
            force: true,
            message:
              '“' + state.name + '” is protected by an access code. Pick a new name, or use "Have an access code?" to sign in.',
          });
        }
      });
    }
    refreshProfileButton();

    const roomMatch = location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)\/?$/);
    if (roomMatch) {
      handleDeepLink(roomMatch[1]);
      return;
    }
    // /history has its own URL (the nav pushes it) and routeCurrent() restores
    // it on popstate — but boot() had no branch for it, so a RELOAD (or a
    // shared link) on the history page rendered Home while the address bar
    // still said /history. Restore it like any other dedicated surface.
    if (HISTORY_RE.test(location.pathname)) {
      showHistoryView();
      setActiveNav('history');
      return;
    }
    const profileMatch = location.pathname.match(PROFILE_RE);
    if (profileMatch) {
      showProfileView(decodeURIComponent(profileMatch[1]));
      return;
    }
    const discoveryMatch = location.pathname.match(DISCOVERY_RE);
    if (discoveryMatch) {
      showDiscoveryView(discoveryMatch[1]);
      return;
    }
    mountHome();
    // /search?q=... or /?q=... deep links drive the unified search.
    const q = new URLSearchParams(location.search).get('q');
    if (q) runSearch(q);
    // Let the friends rail pick its mode for the deep-linked surface.
    window.dispatchEvent(new CustomEvent('wp:view-changed'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
