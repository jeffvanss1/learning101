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

  function makeAvatar(name, emote) {
    const avatar = document.createElement('div');
    avatar.className = 'chat-msg__avatar';
    avatar.textContent = initialFor(name); // fallback while the image loads / if offline
    const [bg, fg] = colorFor(name);
    avatar.style.background = bg;
    avatar.style.color = fg;
    const aimg = document.createElement('img');
    aimg.alt = '';
    aimg.loading = 'lazy';
    // `emote` from the server is an opaque id (ev_...), not an image URL, so
    // only use it when it actually looks like a URL; otherwise use DiceBear.
    aimg.src = /^https?:\/\//i.test(emote || '') ? emote : avatarUrl(name);
    aimg.onerror = () => aimg.remove();
    avatar.appendChild(aimg);
    return avatar;
  }

  function typeLabelFor(video) {
    if (!video) return '';
    return video.type === 'movie' ? 'Movie' : 'Series';
  }

  /** A video-request card shown in chat; the host can Accept/Reject it. */
  function requestNode(msg, opts) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg chat-msg--request';
    wrap.dataset.requestId = msg.id || '';
    if (msg.resolved) wrap.classList.add('is-resolved');

    wrap.appendChild(makeAvatar(msg.name || msg.author || 'Anonymous', msg.emote));

    const body = document.createElement('div');
    body.className = 'chat-msg__body';

    const head = document.createElement('div');
    head.className = 'chat-msg__head';
    const author = document.createElement('span');
    author.className = 'chat-msg__author';
    author.textContent = msg.name || msg.author || 'Anonymous';
    head.appendChild(author);
    const time = document.createElement('span');
    time.className = 'chat-msg__time';
    time.textContent = formatTime(msg.ts);
    head.appendChild(time);
    body.appendChild(head);

    const hint = document.createElement('div');
    hint.className = 'chat-msg__text';
    hint.textContent = msg.resolved
      ? 'Requested a title'
      : 'wants to watch this';
    body.appendChild(hint);

    const card = document.createElement('div');
    card.className = 'chat-request';

    const v = msg.video || {};
    const thumb = document.createElement('div');
    thumb.className = 'chat-request__poster';
    if (v.poster || v.thumb) {
      const im = document.createElement('img');
      im.src = v.poster || v.thumb;
      im.alt = '';
      im.loading = 'lazy';
      im.onerror = () => {
        im.remove();
        thumb.appendChild(
          document.createTextNode((v.title || '?').slice(0, 1).toUpperCase())
        );
      };
      thumb.appendChild(im);
    } else {
      thumb.appendChild(
        document.createTextNode((v.title || '?').slice(0, 1).toUpperCase())
      );
    }
    card.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'chat-request__info';
    const title = document.createElement('div');
    title.className = 'chat-request__title';
    title.textContent = v.title || 'Untitled';
    info.appendChild(title);
    const metaParts = [typeLabelFor(v)];
    if (v.year) metaParts.push(String(v.year));
    if (v.type === 'tv' && v.season) {
      metaParts.push('S' + v.season + (v.episode ? 'E' + v.episode : ''));
    }
    const meta = document.createElement('div');
    meta.className = 'chat-request__meta';
    meta.textContent = metaParts.filter(Boolean).join(' · ');
    info.appendChild(meta);
    card.appendChild(info);

    if (msg.resolved) {
      const badge = document.createElement('span');
      badge.className = 'chat-request__badge';
      badge.textContent = msg.accepted ? 'Playing now' : 'Declined';
      card.appendChild(badge);
    } else if (opts.canAccept) {
      const actions = document.createElement('div');
      actions.className = 'chat-request__actions';
      const accept = document.createElement('button');
      accept.type = 'button';
      accept.className = 'btn btn--primary btn--sm';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => opts.onAccept(msg.id));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'btn btn--ghost btn--sm';
      reject.textContent = 'Reject';
      reject.addEventListener('click', () => opts.onReject(msg.id));
      actions.appendChild(accept);
      actions.appendChild(reject);
      card.appendChild(actions);
    }

    body.appendChild(card);
    wrap.appendChild(body);
    return wrap;
  }

  /** Mark a pending request card as accepted/declined (host decision). */
  function markRequestResolved(requestId, accepted) {
    if (!requestId) return;
    // Server request ids are alphanumeric (base36/base62); strip anything else
    // so the value stays safe inside an attribute selector.
    const safeId = String(requestId).replace(/[^A-Za-z0-9_-]/g, '');
    if (!safeId) return;
    const card = document.querySelector(
      '.chat-msg--request[data-request-id="' + safeId + '"]'
    );
    if (!card) return;
    card.classList.add('is-resolved');
    const hint = card.querySelector('.chat-msg__text');
    if (hint) hint.textContent = 'Requested a title';
    const actions = card.querySelector('.chat-request__actions');
    if (actions) actions.remove();
    const holder = card.querySelector('.chat-request');
    if (holder && !holder.querySelector('.chat-request__badge')) {
      const badge = document.createElement('span');
      badge.className = 'chat-request__badge';
      badge.textContent = accepted ? 'Playing now' : 'Declined';
      holder.appendChild(badge);
    }
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

    if (msg.type === 'request') {
      return requestNode(msg, opts);
    }

    wrap.className = 'chat-msg';
    if (opts.isMe) wrap.classList.add('chat-msg--me');

    wrap.appendChild(makeAvatar(msg.author, msg.emote));

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
    markRequestResolved,
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
