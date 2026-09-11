/* app.js — home browse, name/join modals, room flow, chat, and wiring */
(function (global) {
  'use strict';

  const WP = global.WP;
  const $ = (id) => document.getElementById(id);

  const state = {
    name: '',
    roomId: null,
    isOwner: false,
    myPeerId: null,
    peers: [],
    video: null,
    client: null,
    sync: null,
    chatLoaded: false,
    browseHandle: null,
    roomBrowseHandle: null,
    scrubbing: false,
    _hostMirror: null,
  };

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
        input.value = savedName();
      } catch (_) {}
      modal.hidden = false;
      input.focus();

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

  function openJoin() {
    $('join-modal').hidden = false;
    $('join-name').value = state.name || savedName();
    $('join-code').value = '';
    $('join-error').textContent = '';
    $('join-name').focus();
  }

  function closeModal(id) {
    $(id).hidden = true;
  }

  function setupChrome() {
    $('nav-join').addEventListener('click', openJoin);
    $('nav-new-room').addEventListener('click', () => startRoomWithVideo(null));

    document.querySelectorAll('.modal__close').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.dataset.close));
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
    const name = await promptName();
    if (!name) return;
    state.name = name;
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
    state._hostMirror = null;
    state.chatLoaded = false;

    // Swap views.
    $('home-nav').hidden = true;
    $('home').hidden = true;
    $('room').hidden = false;

    // Replace history with the canonical room URL.
    const path = `/room/${roomId}`;
    if (location.pathname !== path) history.replaceState(null, '', path);

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

    $('chat-form').addEventListener('submit', onChatSubmit);
    $('copy-link').addEventListener('click', onCopyLink);
    $('leave-room').addEventListener('click', onLeaveRoom);
    $('toggle-play').addEventListener('click', onTogglePlay);
    $('change-video').addEventListener('click', onOpenBrowse);

    const seek = $('seek-bar');
    seek.addEventListener('input', () => {
      state.scrubbing = true;
      $('time-current').textContent = WP.formatDuration(parseFloat(seek.value));
    });
    seek.addEventListener('change', () => {
      state.scrubbing = false;
      if (state.isOwner && state.sync) {
        state.sync.localSeek(parseFloat(seek.value));
      }
    });
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
    });

    client.on('peers', (msg) => {
      state.peers = (msg.peers || []).slice();
      if (state.myPeerId) {
        const me = state.peers.find((p) => p.id === state.myPeerId);
        state.isOwner = !!(me && me.owner);
        updateHostUI();
      }
      updatePeerUI();
    });

    client.on('system', (msg) => appendSystemMessage(msg.text));
    client.on('chat', (msg) => appendChatMessage(msg.message));

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

    sync.on('control', ({ action, time }) => {
      if (!state.client || !state.isOwner) return;
      sync._suppressed = Date.now();
      if (action === 'play') state.client.send({ type: 'play', time });
      else if (action === 'pause') state.client.send({ type: 'pause', time });
      else if (action === 'seek') state.client.send({ type: 'seek', time });
    });

    sync.on('progress', ({ time, playing, duration }) => {
      updateProgress(time, playing, duration);
      // Mirror host actions taken inside the embedded player itself.
      if (state.isOwner && state.client) {
        mirrorHostState(time, playing);
      }
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

  function mirrorHostState(time, playing) {
    const now = Date.now();
    const wasOurAction = now - state.sync._suppressed < 700;
    const prev = state._hostMirror;
    if (!wasOurAction && prev) {
      const projected = prev.playing ? prev.time + (now - prev.at) / 1000 : prev.time;
      const drift = time - projected;
      if (Math.abs(drift) > 1.2) {
        state.client.send({ type: 'seek', time });
        state.sync._suppressed = now;
      } else if (playing !== prev.playing) {
        state.client.send({ type: playing ? 'play' : 'pause', time });
        state.sync._suppressed = now;
      }
    }
    state._hostMirror = { playing, time, at: now };
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
    // Host may scrub only once we know the duration.
    seek.disabled = !(state.isOwner && duration != null && duration > 0);
    updatePlayerControls(playing);
  }

  function updatePlayerControls(playing) {
    const btn = $('toggle-play');
    if (!state.isOwner) {
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
  function updateVideoUI() {
    const v = state.video;
    const titleWrap = document.querySelector('.video-bar__title');
    let img = titleWrap.querySelector('.video-bar__poster');

    if (v && v.src) {
      $('video-title').textContent = v.title || 'Now playing';
      if (v.poster) {
        if (!img) {
          img = document.createElement('img');
          img.className = 'video-bar__poster';
          img.alt = '';
          titleWrap.prepend(img);
        }
        if (img.src !== v.poster) img.src = v.poster;
      } else if (img) {
        img.remove();
      }
      hideFallback();
      $('toggle-play').disabled = !state.isOwner;
      $('change-video').disabled = !state.isOwner;
    } else {
      $('video-title').textContent = 'Nothing playing yet';
      if (img) img.remove();
      showFallback();
      $('toggle-play').disabled = true;
      $('change-video').disabled = !state.isOwner;
    }
    $('video-hint').textContent = state.isOwner
      ? 'You are the host \u2014 playback controls sync to everyone.'
      : 'The host controls playback for everyone.';
  }

  function updateHostUI() {
    $('host-chip').hidden = !state.isOwner;
    $('video-actions').hidden = !state.isOwner;
    updateVideoUI();
  }

  function showFallback() {
    $('player-fallback').classList.add('show');
  }

  function hideFallback() {
    $('player-fallback').classList.remove('show');
  }

  function onTogglePlay() {
    if (!state.isOwner || !state.sync || !state.video || !state.video.src) return;
    if (state.sync.localPlaying) state.sync.localPause(state.sync.localTime);
    else state.sync.localPlay(state.sync.localTime);
  }

  // Browse-to-change-video (host only)
  function onOpenBrowse() {
    if (!state.isOwner) return;
    $('browse-modal').hidden = false;
    const body = $('browse-modal-body');
    state.roomBrowseHandle = WP.Catalog.mountBrowse(body, {
      onSelect: (video) => {
        setRoomVideo(video);
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
      av.textContent = WP.initialFor(p.name);
      stack.appendChild(av);
    });
    if (count > 4) {
      const more = document.createElement('div');
      more.className = 'peer-avatar peer-avatar--more';
      more.textContent = `+${count - 4}`;
      stack.appendChild(more);
    }
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

  function onLeaveRoom() {
    if (state.client) state.client.close();
    if (state.sync) state.sync.destroy();
    if (state.roomBrowseHandle) state.roomBrowseHandle.destroy();
    state.client = null;
    state.sync = null;
    state.roomBrowseHandle = null;
    state.chatLoaded = false;
    state.video = null;
    state.isOwner = false;
    state.myPeerId = null;
    $('browse-modal').hidden = true;
    $('room').hidden = true;
    $('home-nav').hidden = false;
    $('home').hidden = false;
    history.replaceState(null, '', '/');
    mountHome();
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
  // Home browse
  // --------------------------------------------------------------------------
  function mountHome() {
    if (state.browseHandle) {
      state.browseHandle.destroy();
      state.browseHandle = null;
    }
    state.browseHandle = WP.Catalog.mountBrowse($('browse'), {
      onSelect: (video) => startRoomWithVideo(video),
    });
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
