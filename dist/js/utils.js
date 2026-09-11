/* utils.js — small shared helpers (no framework) */
(function (global) {
  'use strict';

  const PALETTE = [
    ['#ff0033', '#ffffff'],
    ['#3ea6ff', '#ffffff'],
    ['#2ba640', '#ffffff'],
    ['#f5c518', '#0b0b0b'],
    ['#7c3aed', '#ffffff'],
    ['#ea580c', '#ffffff'],
    ['#0ea5e9', '#ffffff'],
    ['#db2777', '#ffffff'],
  ];

  /** Deterministic pick from a string so a user keeps one colour. */
  function hashStr(s) {
    let h = 5381;
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function colorFor(name) {
    return PALETTE[hashStr(name || 'anon') % PALETTE.length];
  }

  // ---- DiceBear avatars --------------------------------------------------------
  // Same seed -> same avatar, so each name keeps one consistent picture.
  const DICEBEAR_STYLE = 'critters';
  function avatarUrl(name) {
    const seed = String(name || '').trim() || 'anon';
    return (
      'https://api.dicebear.com/10.x/' +
      DICEBEAR_STYLE +
      '/svg?seed=' +
      encodeURIComponent(seed)
    );
  }

  // ---- Watch history -----------------------------------------------------------
  const HISTORY_KEY = 'wp:history';
  const HISTORY_MAX = 40;

  function historyGet() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function historyKey(v) {
    return `${v.id}|${v.season != null ? v.season : ''}|${v.episode != null ? v.episode : ''}`;
  }

  function historyAdd(video) {
    if (!video || !video.src || !video.title) return historyGet();
    let arr = historyGet();
    const key = historyKey(video);
    arr = arr.filter((e) => historyKey(e) !== key);
    arr.unshift({
      type: video.type,
      id: video.id,
      src: video.src,
      title: video.title,
      year: video.year || '',
      poster: video.poster || '',
      backdrop: video.backdrop || '',
      season: video.season != null ? video.season : null,
      episode: video.episode != null ? video.episode : null,
      rating: video.rating != null ? video.rating : null,
      watchedAt: Date.now(),
    });
    arr = arr.slice(0, HISTORY_MAX);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch (_) {}
    return arr;
  }

  function historyClear() {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch (_) {}
  }

  function timeAgo(ts) {
    const s = Math.max(0, Math.floor((Date.now() - (ts || 0)) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    const w = Math.floor(d / 7);
    if (w < 5) return w + 'w ago';
    const mo = Math.floor(d / 30);
    if (mo < 12) return mo + 'mo ago';
    return Math.floor(d / 365) + 'y ago';
  }

  function el(id) {
    return document.getElementById(id);
  }

  /** Build a safe DOM node for a chat message (avoids innerHTML injection). */
  function chatMessageNode(msg, opts) {
    opts = opts || {};
    const wrap = document.createElement('div');

    if (msg.type === 'system') {
      wrap.className = 'chat-msg chat-msg--system';
      const body = document.createElement('div');
      body.className = 'chat-msg__body';
      const text = document.createElement('span');
      text.className = 'chat-msg__text';
      text.textContent = msg.text || '';
      body.appendChild(text);
      wrap.appendChild(body);
      return wrap;
    }

    wrap.className = 'chat-msg';
    if (opts.isMe) wrap.classList.add('chat-msg--me');

    const avatar = document.createElement('div');
    avatar.className = 'chat-msg__avatar';
    avatar.textContent = initialFor(msg.author); // fallback while the image loads / if offline
    const [bg, fg] = colorFor(msg.author);
    avatar.style.background = bg;
    avatar.style.color = fg;
    const aimg = document.createElement('img');
    aimg.alt = '';
    aimg.loading = 'lazy';
    // `emote` from the server is an opaque id (ev_...), not an image URL, so
    // only use it when it actually looks like a URL; otherwise use DiceBear.
    aimg.src = /^https?:\/\//i.test(msg.emote || '') ? msg.emote : avatarUrl(msg.author);
    aimg.onerror = () => aimg.remove();
    avatar.appendChild(aimg);

    const body = document.createElement('div');
    body.className = 'chat-msg__body';

    const head = document.createElement('div');
    head.className = 'chat-msg__head';

    const author = document.createElement('span');
    author.className = 'chat-msg__author';
    if (opts.isOwner) author.classList.add('is-owner');
    author.textContent = msg.author || 'Anonymous';
    head.appendChild(author);

    const time = document.createElement('span');
    time.className = 'chat-msg__time';
    time.textContent = formatTime(msg.ts);
    head.appendChild(time);

    const text = document.createElement('div');
    text.className = 'chat-msg__text';
    text.textContent = msg.text || '';

    body.appendChild(head);
    body.appendChild(text);
    wrap.appendChild(avatar);
    wrap.appendChild(body);
    return wrap;
  }

  function initialFor(name) {
    const n = String(name || 'A').trim();
    return n ? n[0].toUpperCase() : '?';
  }

  function formatTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  function genRoomCode(len) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    const arr = new Uint32Array(len || 6);
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length; i++) {
      s += chars[arr[i] % chars.length];
    }
    return s;
  }

  /** Extract a room id from a shared link. */
  function roomIdFromLink(input) {
    const str = String(input || '').trim();
    if (!str) return null;
    // Already a plain id?
    if (/^[A-Za-z0-9_-]{10,80}$/.test(str)) return str;
    try {
      const u = new URL(str);
      const m = u.pathname.match(/\/room\/([A-Za-z0-9_-]+)\/?$/);
      if (m) return m[1];
      const q = u.searchParams.get('room');
      if (q) return q;
    } catch (_) {}
    return null;
  }

  // A little dictionary so nobody has to think up a handle.
  const NAME_ADJECTIVES = [
    'Bold', 'Brave', 'Calm', 'Cheerful', 'Chill', 'Clever', 'Cozy', 'Crisp',
    'Curious', 'Daring', 'Dreamy', 'Electric', 'Epic', 'Fancy', 'Fearless',
    'Fierce', 'Friendly', 'Gentle', 'Golden', 'Happy', 'Hidden', 'Jolly',
    'Kind', 'Lazy', 'Lucky', 'Lunar', 'Mellow', 'Mysterious', 'Nimble',
    'Noble', 'Plucky', 'Quick', 'Quiet', 'Radiant', 'Retro', 'Rogue',
    'Rustic', 'Silver', 'Sleepy', 'Smooth', 'Solar', 'Speedy', 'Stellar',
    'Swift', 'Tidy', 'Tropical', 'Velvet', 'Vivid', 'Wander', 'Whimsical',
    'Wild', 'Witty', 'Zesty',
  ];

  const NAME_NOUNS = [
    'Badger', 'Bandicoot', 'Bison', 'Blizzard', 'Comet', 'Coyote', 'Cricket',
    'Dolphin', 'Dragon', 'Eagle', 'Ember', 'Falcon', 'Fennec', 'Flamingo',
    'Fox', 'Gecko', 'Giraffe', 'Grizzly', 'Harrier', 'Hawk', 'Hedgehog',
    'Heron', 'Ibex', 'Iguana', 'Jaguar', 'Koala', 'Lemur', 'Llama', 'Lynx',
    'Mango', 'Meerkat', 'Meteor', 'Moose', 'Narwhal', 'Nebula', 'Ocelot',
    'Otter', 'Panda', 'Panther', 'Parrot', 'Penguin', 'Phoenix', 'Pigeon',
    'Puffin', 'Quokka', 'Raccoon', 'Rocket', 'Salamander', 'Sphinx',
    'Starling', 'Tiger', 'Toucan', 'Vulcan', 'Walrus', 'Wolf', 'Wombat',
    'Yeti', 'Zebra',
  ];

  /** Generate a friendly randomized handle, e.g. "Bold Falcon" or "Quiet Comet 42". */
  function randomName() {
    const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
    const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
    const suffix = Math.random() < 0.25 ? ' ' + (10 + Math.floor(Math.random() * 90)) : '';
    return adj + ' ' + noun + suffix;
  }

  /** Parse a pasted video link into a normalized embed URL. */
  function normalizeVideoInput(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (u.hostname === 'embed.bingr.one') {
        return { id: raw, title: 'Bingr stream', thumb: '' };
      }
      return { id: raw, title: u.hostname || 'Video', thumb: '' };
    } catch (_) {}
    return null;
  }

  global.WP = {
    el,
    colorFor,
    hashStr,
    avatarUrl,
    chatMessageNode,
    initialFor,
    formatTime,
    formatDuration,
    copyText,
    genRoomCode,
    roomIdFromLink,
    normalizeVideoInput,
    randomName,
    historyGet,
    historyAdd,
    historyClear,
    timeAgo,
  };
})(window);
