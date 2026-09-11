/* app.js — lobby flow, room UI, chat, and wiring everything together */
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
  };

  // --------------------------------------------------------------------------
  // Lobby
  // --------------------------------------------------------------------------
  function setupLobby() {
    const nameInput = $('name-input');
    // Persist display name locally (no account, just convenience).
    try {
      const saved = localStorage.getItem('wp:name');
      if (saved) nameInput.value = saved;
    } catch (_) {}

    $('lobby-form').addEventListener('submit', onCreateRoom);
    $('join-toggle').addEventListener('click', toggleJoinMode);
    $('join-submit').addEventListener('click', onJoinRoom);
    $('join-code-input').addEventListener('input', () => clearError('join-error'));
    $('video-input').addEventListener('input', () => clearError('video-error'));
  }

  function toggleJoinMode() {
    const wrap = $('join-code-wrap');
    const submit = $('join-submit');
    const toggle = $('join-toggle');
    const showing = wrap.hidden;
    wrap.hidden = !showing;
    submit.hidden = !showing;
    toggle.hidden = showing;
    $('lobby-title').textContent = showing ? 'Join a room' : 'Create a watch room';
    if (showing) $('join-code-input').focus();
  }

  function setLoading(btn, loading) {
    if (loading) btn.classList.add('is-loading');
    else btn.classList.remove('is-loading');
  }

  function clearError(id) {
    const el = $(id);
    if (el) el.textContent = '';
  }

  function showError(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  async function onCreateRoom(e) {
    e.preventDefault();
    const name = $('name-input').value.trim();
    const videoRaw = $('video-input').value.trim();
    if (!name) {
      $('name-input').focus();
      return;
    }
    if (videoRaw) {
      const parsed = WP.normalizeVideoInput(videoRaw);
      if (!parsed) {
        showError('video-error', 'That does not look like a valid URL.');
        return;
      }
    }

    const btn = $('lobby-submit');
    setLoading(btn, true);
    try {
      const room = await WP.apiCreateRoom();
      state.name = name;
      saveName(name);
      const video = videoRaw ? WP.normalizeVideoInput(videoRaw) : null;
      if (video) global.__wpCurrentVideo = video;
      enterRoom(room.id, video);
    } catch (err) {
      showError('video-error', err.message || 'Failed to create room.');
    } finally {
      setLoading(btn, false);
    }
  }

  async function onJoinRoom() {
    const name = $('name-input').value.trim();
    const code = $('join-code-input').value.trim();
    if (!name) {
      $('name-input').focus();
      return;
    }
    const roomId = WP.roomIdFromLink(code);
    if (!roomId) {
      showError('join-error', 'Paste a full room link or a room id.');
      return;
    }
    const btn = $('join-submit');
    setLoading(btn, true);
    try {
      await WP.apiGetRoom(roomId);
      state.name = name;
      saveName(name);
      enterRoom(roomId, null);
    } catch (err) {
      showError('join-error', err.message || 'Could not find that room.');
    } finally {
      setLoading(btn, false);
    }
  }

  function saveName(name) {
    try {
      localStorage.setItem('wp:name', name);
    } catch (_) {}
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

    // Swap views.
    $('lobby').hidden = true;
    $('room').hidden = false;

    // Replace history with the canonical room URL.
    const path = `/room/${roomId}`;
    if (location.pathname !== path) {
      history.replaceState(null, '', path);
    }

    initRoomUI();

    // Create the sync manager before connecting so any `state` message that
    // arrives immediately can be applied to the player.
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
    $('video-title').textContent = 'Connecting…';
    $('chat').innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = 'Connecting to the room…';
    $('chat').appendChild(empty);

    const chatForm = $('chat-form');
    chatForm.addEventListener('submit', onChatSubmit);
    $('copy-link').addEventListener('click', onCopyLink);
    $('leave-room').addEventListener('click', onLeaveRoom);
    $('video-form').addEventListener('submit', onVideoSubmit);
    $('toggle-play').addEventListener('click', onTogglePlay);
    $('change-video').addEventListener('click', onShowVideoForm);
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
      if (msg.video && msg.video.id) {
        state.video = msg.video;
        updateVideoUI();
      }
      updateHostUI();
      // Apply the shared playback clock and current video to the player.
      if (state.sync) state.sync.handleServerMessage(msg);
      // The `state` message is sent on (re)join with the full chat history —
      // re-render it so nothing is lost across reconnects.
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
      state.sync.handleServerMessage(msg);
    });

    client.on('play', (msg) => state.sync.handleServerMessage(msg));
    client.on('pause', (msg) => state.sync.handleServerMessage(msg));
    client.on('seek', (msg) => state.sync.handleServerMessage(msg));

    client.on('reconnecting', (info) => {
      setConnStatus(`Reconnecting…`, true);
      toast(`Connection lost — retrying in ${Math.ceil(info.delay / 1000)}s`);
    });

    client.on('close', () => {
      setConnStatus('Disconnected', true);
    });
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
      // Suppress our own echo so we don't fight our own broadcast.
      sync._suppressed = Date.now();
      if (action === 'play') {
        state.client.send({ type: 'play', time });
      } else if (action === 'pause') {
        state.client.send({ type: 'pause', time });
      } else if (action === 'seek') {
        state.client.send({ type: 'seek', time });
      }
    });

    sync.on('progress', ({ time, playing, duration }) => {
      if (state.isOwner) {
        // Host drives: periodically push authoritative state to the room.
        // (Throttled by the sync manager's own cadence.)
      }
      updatePlayerControls(playing);
    });

    sync.on('buffering', () => setConnStatus('Buffering…', true));
    sync.on('ready', () => {
      if (!state.video) showFallback();
      else hideFallback();
    });
  }

  function updatePlayerControls(playing) {
    const btn = $('toggle-play');
    if (!state.isOwner) {
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Play';
      return;
    }
    btn.disabled = !state.video;
    btn.querySelector('span').textContent = playing ? 'Pause' : 'Play';
    const icon = btn.querySelector('svg');
    if (icon) {
      icon.innerHTML = playing
        ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'
        : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    }
  }

  // --------------------------------------------------------------------------
  // Video bar UI
  // --------------------------------------------------------------------------
  function updateVideoUI() {
    const v = state.video;
    if (v && v.id) {
      $('video-title').textContent = v.title || 'Now playing';
      hideFallback();
      $('toggle-play').disabled = !state.isOwner;
      $('change-video').disabled = !state.isOwner;
    } else {
      $('video-title').textContent = 'Nothing playing yet';
      showFallback();
      $('toggle-play').disabled = true;
      $('change-video').disabled = !state.isOwner;
    }
    const hint = $('video-hint');
    hint.textContent = state.isOwner
      ? 'You are the host — playback controls sync to everyone.'
      : 'The host controls playback for everyone.';
  }

  function updateHostUI() {
    $('host-chip').hidden = !state.isOwner;
    const formWrap = $('video-form-wrap');
    formWrap.hidden = !state.isOwner;
    $('video-actions').hidden = !state.isOwner;
    updateVideoUI();
  }

  function showFallback() {
    $('player-fallback').classList.add('show');
  }

  function hideFallback() {
    $('player-fallback').classList.remove('show');
  }

  function onShowVideoForm() {
    const formWrap = $('video-form-wrap');
    formWrap.hidden = false;
    $('video-url-input').value = state.video ? state.video.id : '';
    $('video-url-input').focus();
  }

  function onVideoSubmit(e) {
    e.preventDefault();
    if (!state.isOwner) return;
    const raw = $('video-url-input').value.trim();
    const parsed = WP.normalizeVideoInput(raw);
    if (!parsed) {
      $('video-bar-error').textContent = 'Paste a valid video URL.';
      return;
    }
    $('video-bar-error').textContent = '';
    state.video = parsed;
    global.__wpCurrentVideo = parsed;
    updateVideoUI();
    state.sync.loadVideo(parsed);
    state.client.send({ type: 'videoChange', video: parsed });
    $('video-form-wrap').hidden = true;
  }

  function onTogglePlay() {
    if (!state.isOwner || !state.video) return;
    if (state.sync.localPlaying) {
      state.sync.localPause(state.sync.localTime);
    } else {
      state.sync.localPlay(state.sync.localTime);
    }
  }

  // --------------------------------------------------------------------------
  // Chat
  // --------------------------------------------------------------------------
  function onChatSubmit(e) {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (state.client && state.client.send({ type: 'chat', text })) {
      input.value = '';
    }
  }

  function chatOpts(msg) {
    const isMe = !!(msg.peerId && msg.peerId === state.myPeerId);
    const isOwner = !!(msg.peerId && state.peers.some((p) => p.id === msg.peerId && p.owner));
    return { isMe, isOwner };
  }

  function appendChatMessage(msg) {
    const chat = $('chat');
    const empty = chat.querySelector('.chat-empty');
    if (empty) empty.remove();

    const node = WP.chatMessageNode(msg, chatOpts(msg));
    chat.appendChild(node);
    scrollChat();
  }

  function appendSystemMessage(text) {
    const chat = $('chat');
    const empty = chat.querySelector('.chat-empty');
    if (empty) empty.remove();
    const node = WP.chatMessageNode({ type: 'system', text });
    chat.appendChild(node);
    scrollChat();
  }

  function renderChatHistory(messages) {
    const chat = $('chat');
    chat.innerHTML = '';
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet — say hi 👋';
      chat.appendChild(empty);
      return;
    }
    for (const msg of messages) {
      const node = WP.chatMessageNode(msg, chatOpts(msg));
      chat.appendChild(node);
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
    const shown = state.peers.slice(0, 4);
    shown.forEach((p) => {
      const av = document.createElement('div');
      av.className = 'peer-avatar';
      const [bg, fg] = WP.colorFor(p.name);
      av.style.background = bg;
      av.style.color = fg;
      av.title = p.name + (p.owner ? ' (host)' : '');
      av.textContent = WP.initialFor(p.name);
      stack.appendChild(av);
    });
    if (count > shown.length) {
      const more = document.createElement('div');
      more.className = 'peer-avatar peer-avatar--more';
      more.textContent = `+${count - shown.length}`;
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
      toast('Could not copy — copy the URL from the address bar', true);
    }
  }

  function onLeaveRoom() {
    if (state.client) state.client.close();
    if (state.sync) state.sync.destroy();
    state.client = null;
    state.sync = null;
    state.chatLoaded = false;
    state.video = null;
    state.isOwner = false;
    $('room').hidden = true;
    $('lobby').hidden = false;
    history.replaceState(null, '', '/');
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
  // Boot
  // --------------------------------------------------------------------------
  function boot() {
    setupLobby();

    // Deep link straight into a room if the URL already contains one.
    const m = location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)\/?$/);
    if (m) {
      const savedName = (() => {
        try {
          return localStorage.getItem('wp:name') || '';
        } catch (_) {
          return '';
        }
      })();
      if (savedName) {
        state.name = savedName;
        enterRoom(m[1], null);
        return;
      }
      // Ask for a name first, then join.
      $('join-code-input').value = location.href;
      toggleJoinMode();
      $('name-input').focus();
      $('lobby-title').textContent = 'Join a room';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
