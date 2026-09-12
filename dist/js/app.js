/* app.js — home browse, name/join modals, room flow, chat, and wiring */
(function (global) {
  'use strict';

  const WP = global.WP;
  const $ = (id) => document.getElementById(id);

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
    chatLoaded: false,
    browseHandle: null,
    roomBrowseHandle: null,
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

  function promptName() {
    return new Promise((resolve) => {
      if (state.name) {
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

      const done = (name) => {
        modal.hidden = true;
        resolve(name);
      };

      $('name-form').onsubmit = (e) => {
        e.preventDefault();
        const n = input.value.trim();
        if (!n) {
          err.textContent = 'Please enter a name.';
          return;
        }
        err.textContent = '';
        saveName(n);
        done(n);
      };
      modal.addEventListener('click', (e) => {
        if (e.target === modal) done(null);
      }, { once: true });
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

    // Keep the view in sync with history traversal (browser Back/Forward, or
    // the `history.back()` we call when leaving a room).
    window.addEventListener('popstate', onPopState);

    // Home guide rail (left sidebar).
    setupSidenav();

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
      $('join-error').textContent = '';
      enterRoom(roomId, null);
    });
  }

  async function startRoomWithVideo(video) {
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
  function enterRoom(roomId, video) {
    state.roomId = roomId;
    state.video = video || null;
    state.peers = [];
    state.myPeerId = null;
    state.isOwner = false;
    state.amAllowed = false;
    state.chatLoaded = false;
    state._lastRecKey = null;
    resetRecs();

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
    $('room').hidden = false;

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
    state.sync = sync;
    wireSync(sync);

    const client = new WP.RoomClient(roomId);
    state.client = client;
    wireClient(client);
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

    resetProgress();

    // Property assignment (not addEventListener) so re-entering a room never
    // stacks duplicate handlers — a duplicate toggle handler was a source of
    // the host play/pause loop.
    $('chat-form').onsubmit = onChatSubmit;
    $('copy-link').onclick = onCopyLink;
    $('leave-room').onclick = onLeaveRoom;
    $('toggle-play').onclick = onTogglePlay;
    $('change-video').onclick = onOpenBrowse;
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
    const sideHead = document.querySelector('.sidebar__head');
    if (sideHead) sideHead.onclick = onToggleChat;

    const seek = $('seek-bar');
    seek.oninput = () => {
      state.scrubbing = true;
      $('time-current').textContent = WP.formatDuration(parseFloat(seek.value));
    };
    seek.onchange = () => {
      state.scrubbing = false;
      if (canControl() && state.sync) {
        state.sync.localSeek(parseFloat(seek.value));
      }
    };
  }

  function resetProgress() {
    $('time-current').textContent = '0:00';
    $('time-duration').textContent = '0:00';
    const seek = $('seek-bar');
    seek.value = '0';
    seek.max = '1000';
    seek.disabled = true;
  }

  // --------------------------------------------------------------------------
  // WebSocket client wiring
  // --------------------------------------------------------------------------
  function wireClient(client) {
    client.on('open', () => setConnStatus('In sync', false));

    client.on('state', (msg) => {
      if (msg.you) {
        state.myPeerId = msg.you.id;
        state.isOwner = !!msg.you.owner;
        state.amAllowed = !!msg.you.allowed;
      } else if (msg.ownerId !== undefined && state.myPeerId) {
        state.isOwner = msg.ownerId === state.myPeerId;
      }
      if (msg.video && msg.video.src) {
        state.video = msg.video;
        updateVideoUI();
      }
      updateHostUI();
      if (state.sync) state.sync.handleServerMessage(msg);
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
      if (state.sync) state.sync.handleServerMessage(msg);
    });

    client.on('play', (msg) => state.sync && state.sync.handleServerMessage(msg));
    client.on('pause', (msg) => state.sync && state.sync.handleServerMessage(msg));
    client.on('seek', (msg) => state.sync && state.sync.handleServerMessage(msg));

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
    sync.on('video', () => updateVideoUI());

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
      updateProgress(time, playing, duration);
    });

    sync.on('buffering', () => setConnStatus('Buffering\u2026', true));
    sync.on('ready', () => {
      if (!state.video || !state.video.src) showFallback();
      else hideFallback();
      updateHostUI();
    });
    sync.on('unavailable', () => {
      toast('The player does not expose remote control (Server 2 fallback). Sync may be limited.', true);
    });
  }

  function updateProgress(time, playing, duration) {
    const seek = $('seek-bar');
    if (duration != null && duration > 0) {
      seek.max = String(duration);
      $('time-duration').textContent = WP.formatDuration(duration);
    }
    if (!state.scrubbing) {
      seek.value = String(time || 0);
      $('time-current').textContent = WP.formatDuration(time || 0);
    }
    // Controllers may scrub only once we know the duration.
    seek.disabled = !(canControl() && duration != null && duration > 0);
    updatePlayerControls(playing);
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
  function videoMetaLine(v) {
    const parts = [];
    if (v.rating) parts.push('\u2605 ' + Number(v.rating).toFixed(1));
    if (v.year) parts.push(String(v.year));
    if (v.type === 'movie') parts.push('Movie');
    else if (v.type === 'anime') parts.push('Anime');
    else parts.push('Series');
    if (v.type === 'anime' && v.episode) {
      parts.push('Ep ' + v.episode);
    } else if (v.type === 'tv' && v.season) {
      parts.push('S' + v.season + (v.episode ? 'E' + v.episode : ''));
    }
    return parts.filter(Boolean).join(' \u00b7 ');
  }

  function updateVideoUI() {
    const v = state.video;
    const thumb = $('video-thumb');
    let img = thumb ? thumb.querySelector('.video-bar__poster') : null;

    // Everyone can browse; controllers change what plays, guests request.
    const cv = $('change-video');
    cv.disabled = false;
    cv.querySelector('span').textContent = canControl() ? 'Change video' : 'Request video';

    if (v && v.src) {
      $('video-title').textContent = v.title || 'Now playing';
      $('video-meta-line').textContent = videoMetaLine(v) || (v.type === 'movie' ? 'Movie' : v.type === 'anime' ? 'Anime' : 'Series');

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
      }
      if (v.poster && thumb) {
        if (!img) {
          img = document.createElement('img');
          img.className = 'video-bar__poster';
          img.alt = '';
          thumb.appendChild(img);
        }
        if (img.src !== v.poster) img.src = v.poster;
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
    if (state.sync.localPlaying) state.sync.localPause(state.sync.localTime);
    else state.sync.localPlay(state.sync.localTime);
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
    if (item.rating) parts.push('\u2605 ' + Number(item.rating).toFixed(1));
    if (item.year) parts.push(String(item.year));
    parts.push(item.type === 'movie' ? 'Movie' : 'Series');
    meta.textContent = parts.filter(Boolean).join(' \u00b7 ');
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
      empty.textContent = 'No messages yet \u2014 say hi \u{1F44B}';
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
    if (state.client) {
      state.client.close();
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
    state.chatLoaded = false;
    state.video = null;
    state.isOwner = false;
    state.amAllowed = false;
    state.myPeerId = null;
    state.roomId = null;
    state._lastRecKey = null;
    resetRecs();
    $('browse-modal').hidden = true;
  }

  // Show the home surface. Idempotent: re-mounts the browse UI only when we
  // are not already on the home view.
  function showHome() {
    const alreadyHome = $('room').hidden && !$('home').hidden;
    $('room').hidden = true;
    $('home-nav').hidden = false;
    $('home').hidden = false;
    if (!alreadyHome) mountHome();
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
    showHome();
  }

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
  // Watch history
  // --------------------------------------------------------------------------
  function renderHistory() {
    const sec = $('history');
    const scroller = $('history-scroller');
    if (!sec || !scroller) return;
    const items = WP.historyGet();
    if (!items.length) {
      sec.hidden = true;
      scroller.innerHTML = '';
      return;
    }
    sec.hidden = false;
    scroller.innerHTML = '';
    items.forEach((v) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'history-card';
      card.title = v.title;

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
      const body = document.createElement('div');
      body.className = 'history-card__body';
      const title = document.createElement('div');
      title.className = 'history-card__title';
      title.textContent = v.title;
      const meta = document.createElement('div');
      meta.className = 'history-card__meta';
      const ep = v.season != null ? `S${v.season} E${v.episode} · ` : '';
      meta.textContent = ep + WP.timeAgo(v.watchedAt);
      body.appendChild(title);
      body.appendChild(meta);

      card.appendChild(poster);
      card.appendChild(body);
      card.addEventListener('click', () => startRoomWithVideo(v));
      scroller.appendChild(card);
    });
  }

  // --------------------------------------------------------------------------
  // Home guide rail (left sidebar)
  // --------------------------------------------------------------------------
  function scrollToBrowseRow(key) {
    const sel = '.browse [data-row="' + key + '"]';
    let tries = 0;
    const attempt = () => {
      const el = document.querySelector(sel);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (++tries < 12) setTimeout(attempt, 160);
      else toast('That section is still loading\u2026', true);
    };
    attempt();
  }

  function setupSidenav() {
    const nav = $('sidenav');
    if (!nav) return;
    const items = Array.from(nav.querySelectorAll('.sidenav__item[data-nav]'));
    const setActive = (key) => {
      items.forEach((it) => it.classList.toggle('is-active', it.dataset.nav === key));
    };

    items.forEach((it) => {
      it.addEventListener('click', () => {
        const key = it.dataset.nav;
        if (key === 'home') {
          // Reset any search and reload the default hero + rows.
          const input = $('topnav-search-input');
          if (input && input.value) input.value = '';
          if (state.browseHandle && state.browseHandle.refresh) state.browseHandle.refresh();
          setActive('home');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (key === 'movies' || key === 'series' || key === 'anime') {
          const ROW_KEYS = { movies: 'movie', series: 'tv', anime: 'anime' };
          const rowKey = ROW_KEYS[key] || key;
          // If the row isn't rendered (e.g. we're in a search grid), reset to
          // browse first so the row exists, then scroll to it.
          if (!document.querySelector('.browse [data-row="' + rowKey + '"]')) {
            const input = $('topnav-search-input');
            if (input && input.value) input.value = '';
            if (state.browseHandle && state.browseHandle.refresh) state.browseHandle.refresh();
          }
          setActive(key);
          scrollToBrowseRow(rowKey);
        } else if (key === 'history') {
          const sec = $('history');
          if (sec && !sec.hidden) {
            setActive('history');
            sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            toast('Nothing in your watch history yet.');
          }
        } else if (key === 'start-room') {
          startRoomWithVideo(null);
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
      });
    }
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
      // The search bar lives in the top nav, in the same bar as the logo.
      searchInput: $('topnav-search-input'),
    });
    renderHistory();
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
    const m = location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      handleDeepLink(m[1]);
    } else {
      mountHome();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
