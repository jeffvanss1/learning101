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

  // ---------------------------------------------------------------------------
  // Icons — inline SVG (Feather geometry: 24x24 grid, stroke=currentColor)
  // ---------------------------------------------------------------------------
  // The UI ships NO icon font and NO emoji glyphs in its chrome: every control,
  // status chip and empty state renders a real <svg>, so icons inherit the
  // current ink (and therefore theme in light/dark) and never depend on the
  // platform's emoji font rendering.
  //
  // Spec format: [tag, attrs] primitives, `solid: true` fills instead of
  // strokes (heart-fill / star).
  /** @type {Record<string, { p: Array<[string, Record<string, string|number>]>, solid?: boolean }>} */
  const ICONS = {
    'volume-2': {
      p: [
        ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }],
        ['path', { d: 'M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07' }],
      ],
    },
    'volume-x': {
      p: [
        ['polygon', { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }],
        ['line', { x1: 23, y1: 9, x2: 17, y2: 15 }],
        ['line', { x1: 17, y1: 9, x2: 23, y2: 15 }],
      ],
    },
    star: {
      solid: true,
      p: [
        ['polygon', { points: '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2' }],
      ],
    },
    heart: {
      p: [
        ['path', { d: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z' }],
      ],
    },
    'heart-fill': {
      solid: true,
      p: [
        ['path', { d: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z' }],
      ],
    },
    check: { p: [['polyline', { points: '20 6 9 17 4 12' }]] },
    x: {
      p: [
        ['line', { x1: 18, y1: 6, x2: 6, y2: 18 }],
        ['line', { x1: 6, y1: 6, x2: 18, y2: 18 }],
      ],
    },
    zap: { p: [['polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }]] },
    edit: { p: [['path', { d: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }]] },
    copy: {
      p: [
        ['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }],
        ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
      ],
    },
    alert: {
      p: [
        ['path', { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' }],
        ['line', { x1: 12, y1: 9, x2: 12, y2: 13 }],
        ['line', { x1: 12, y1: 17, x2: 12.01, y2: 17 }],
      ],
    },
    key: {
      p: [
        ['path', { d: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4' }],
      ],
    },
    users: {
      p: [
        ['path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }],
        ['circle', { cx: 9, cy: 7, r: 4 }],
        ['path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87' }],
        ['path', { d: 'M16 3.13a4 4 0 0 1 0 7.75' }],
      ],
    },
    user: {
      p: [
        ['path', { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' }],
        ['circle', { cx: 12, cy: 7, r: 4 }],
      ],
    },
    play: { solid: true, p: [['polygon', { points: '6 3 20 12 6 21 6 3' }]] },
    pause: {
      solid: true,
      p: [
        ['rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }],
        ['rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }],
      ],
    },
    'fast-forward': {
      solid: true,
      p: [
        ['polygon', { points: '13 19 22 12 13 5 13 19' }],
        ['polygon', { points: '2 19 11 12 2 5 2 19' }],
      ],
    },
    'skip-forward': {
      p: [
        ['polygon', { points: '5 4 15 12 5 20 5 4' }],
        ['line', { x1: 19, y1: 5, x2: 19, y2: 19 }],
      ],
    },
    'rotate-cw': {
      p: [
        ['polyline', { points: '23 4 23 10 17 10' }],
        ['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }],
      ],
    },
    'arrow-left': {
      p: [
        ['line', { x1: 19, y1: 12, x2: 5, y2: 12 }],
        ['polyline', { points: '12 19 5 12 12 5' }],
      ],
    },
    // Rail chevrons: a bare angle on the same 24px grid as the rest (a row
    // button points off the edge it sits on, so the ink direction matters).
    'chevron-left': {
      p: [['polyline', { points: '15 5 8 12 15 19' }]],
    },
    'chevron-right': {
      p: [['polyline', { points: '9 5 16 12 9 19' }]],
    },
    film: {
      p: [
        ['rect', { x: 2, y: 2, width: 20, height: 20, rx: 2.18 }],
        ['line', { x1: 7, y1: 2, x2: 7, y2: 22 }],
        ['line', { x1: 17, y1: 2, x2: 17, y2: 22 }],
        ['line', { x1: 2, y1: 12, x2: 22, y2: 12 }],
        ['line', { x1: 2, y1: 7, x2: 7, y2: 7 }],
        ['line', { x1: 2, y1: 17, x2: 7, y2: 17 }],
        ['line', { x1: 17, y1: 17, x2: 22, y2: 17 }],
        ['line', { x1: 17, y1: 7, x2: 22, y2: 7 }],
      ],
    },
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Build an icon element. Unknown names return an empty <svg> (never throw —
   * a stale bundle must not take a surface down).
   * @param {string} name
   * @param {number} [size] px, square
   * @returns {SVGElement}
   */
  function icon(name, size) {
    const px = Number(size) > 0 ? Number(size) : 16;
    const svg = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, 'svg'));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('class', 'wp-icon');
    const spec = ICONS[name];
    if (spec) {
      if (spec.solid) {
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('stroke', 'none');
      } else {
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
      }
      for (const [tag, attrs] of spec.p) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const k of Object.keys(attrs)) node.setAttribute(k, String(attrs[k]));
        svg.appendChild(node);
      }
    }
    return svg;
  }

  /**
   * Replace an element's content with one icon (dynamic swaps: heart on/off,
   * speaker on/off, ...).
   * @param {Element | null} el
   * @param {string} name
   * @param {number} [size]
   */
  function setIcon(el, name, size) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(icon(name, size));
  }

  /** @param {string} name @returns {boolean} */
  function hasIcon(name) {
    return Object.prototype.hasOwnProperty.call(ICONS, name);
  }

  /**
   * Icon names for the chat/status glyphs the room Durable Object emits
   * (they ride in plain text, so the client swaps them for real SVG).
   */
  const TEXT_ICONS = [
    ['\u25b6\ufe0f', 'play'],
    ['\u25b6', 'play'],
    ['\u23f8\ufe0f', 'pause'],
    ['\u23f8', 'pause'],
    ['\u23e9', 'fast-forward'],
    ['\ud83c\udf9f\ufe0f', 'film'],
  ];

  /**
   * Build a fragment for a text line whose FIRST glyph is one of the known
   * status glyphs: that glyph becomes an inline SVG, the rest stays text.
   * Text without a known glyph is returned as a single text node.
   * @param {string} text
   * @param {number} [size]
   * @returns {DocumentFragment}
   */
  function iconText(text, size) {
    const frag = document.createDocumentFragment();
    const str = String(text == null ? '' : text);
    for (const [glyph, name] of TEXT_ICONS) {
      if (str.indexOf(glyph) === 0) {
        const svg = icon(name, size || 13);
        svg.classList.add('wp-icon--inline');
        frag.appendChild(svg);
        const rest = str.slice(glyph.length).replace(/^\s+/, '');
        if (rest) frag.appendChild(document.createTextNode(' ' + rest));
        return frag;
      }
    }
    frag.appendChild(document.createTextNode(str));
    return frag;
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
      malId: video.malId != null ? video.malId : null,
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

  /**
   * Update the playback position of an existing history entry (RESUME).
   * Does NOT reorder the list (the entry was already moved to front when
   * playback started) and never creates an entry.
   * @param {{ id: string|number, season?: number|null, episode?: number|null }} video
   * @param {number} positionSeconds
   * @param {number} [durationSeconds]
   */
  function historySetProgress(video, positionSeconds, durationSeconds) {
    if (!video || !video.id) return historyGet();
    const pos = Math.max(0, Math.floor(Number(positionSeconds) || 0));
    const dur = Math.max(0, Math.floor(Number(durationSeconds) || 0));
    if (!pos) return historyGet();
    let arr = historyGet();
    const key = historyKey(video);
    for (const e of arr) {
      if (historyKey(e) === key) {
        e.position = pos;
        if (dur) e.duration = dur;
        break;
      }
    }
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch (_) {}
    return arr;
  }

  /**
   * Remove ONE entry (per-item delete on the history page).
   * @param {string} key historyKey of the entry
   */
  function historyRemove(key) {
    let arr = historyGet();
    arr = arr.filter((e) => historyKey(e) !== key);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
    } catch (_) {}
    return arr;
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
    if (video.type === 'movie') return 'Movie';
    if (video.type === 'anime') return 'Anime';
    return 'Series';
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
    } else if (v.type === 'anime' && v.episode) {
      metaParts.push('Ep ' + v.episode);
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
      // Server lines lead with a status glyph (play/pause/forward/film) —
      // render those as inline SVG instead of emoji.
      text.appendChild(iconText(msg.text || ''));
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
    historySetProgress,
    historyRemove,
    historyKey,
    historyClear,
    timeAgo,
    icon,
    setIcon,
    hasIcon,
    iconText,
  };
})(window);
