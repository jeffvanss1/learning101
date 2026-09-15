/* catalog.js — The Movie Database (TMDB) library
 *
 * Browse movies, TV series and anime (hero banner + poster rows + search with
 * filters + a season/episode picker). Data comes from TMDB through the Worker
 * proxy at `/api/tmdb/...`, which injects the server-side API key.
 *
 * Playback still uses the Bingr watch URLs:
 *   movie -> /watch/movie/{tmdbId}
 *   tv    -> /watch/tv/{tmdbId}/{season}/{episode}
 *   anime -> /watch/anime/{anilistId}/{episode}   (AniList ID, episode only)
 *
 * The catalog is TMDB-only, so anime (TMDB keyword 210024) is classified and
 * mapped to an AniList ID via the Worker endpoint /api/anilist/{tmdbId}.
 */
(function (global) {
  'use strict';

  // UI strings via the i18n dictionaries (worker resolves the locale; when
  // i18n.js is absent — e.g. a stale cached page — fall back to English).
  const tr = (key, fallback) => (global.WP && global.WP.I18N ? global.WP.I18N.t(key, fallback) : fallback);

  const PROXY = '/api/tmdb';
  const BINGR_WATCH = 'https://bingr.one/watch';
  const IMG = 'https://image.tmdb.org/t/p';
  const CACHE_KEY_PREFIX = 'wp:cat:';
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const ANIME_KEYWORD = 210024; // TMDB keyword id for "anime"
  const ANILIST_CACHE_PREFIX = 'wp:anilist:v4:'; // v4: busts the v3 entries (which cached UNRESOLVED results for 7 days - the Boruto bug)
  const ANILIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for RESOLVED matches
  const ANILIST_NULL_TTL_MS = 5 * 60 * 1000; // misses live 5 minutes - a fix must reach users fast, a blip must not poison a week

  // ---- tiny DOM helpers ------------------------------------------------------
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  }

  function img(path, size) {
    return path ? `${IMG}/${size}${path}` : '';
  }

  function cacheGet(path) {
    try {
      const raw = localStorage.getItem(CACHE_KEY_PREFIX + path);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Date.now() - o.ts < CACHE_TTL_MS) return o.data;
    } catch (_) {}
    return null;
  }

  function cacheSet(path, data) {
    try {
      localStorage.setItem(CACHE_KEY_PREFIX + path, JSON.stringify({ ts: Date.now(), data }));
    } catch (_) {}
  }

  async function api(path) {
    const res = await fetch(PROXY + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const body = await res.json();
        if (body && (body.status_message || body.error)) detail = body.status_message || body.error;
      } catch (_) {}
      throw new Error(detail);
    }
    const data = await res.json();
    cacheSet(path, data);
    return data;
  }

  // Resolve a TMDB TV id into { anime, anilistId, episodes, title } via the
  // Worker (classifies with TMDB keywords, then looks the title up on AniList).
  async function anilistApi(tmdbId) {
    const cacheKey = ANILIST_CACHE_PREFIX + tmdbId;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const o = JSON.parse(raw);
        // RESOLVED results live 7 days; UNRESOLVED (anilistId:null) only 5
        // minutes - a single transient blip must not poison the cache for
        // a week (this was the Boruto "couldn't match on AniList" bug).
        const ttl = o.data && o.data.anilistId != null ? ANILIST_CACHE_TTL_MS : ANILIST_NULL_TTL_MS;
        if (Date.now() - o.ts < ttl) return o.data;
      }
    } catch (_) {}
    const res = await fetch('/api/anilist/' + encodeURIComponent(tmdbId) + '?v=3', { // v=3: never-hit URL (v2 responses may hold stale misses)
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
    } catch (_) {}
    return data;
  }

  // Lazily classify a batch of TV items as anime (used by the search filter).
  async function classifyAnime(list) {
    const tvs = (list || []).filter(
      (r) => r && r.type === 'tv' && r._animeChecked !== true
    );
    if (!tvs.length) return;
    // BOUNDED CONCURRENCY (3, staggered): a feed view resolves 20-40 titles;
    // firing them ALL at once hammered AniList into rate-limiting the whole
    // batch -> mass unresolved -> the anime feed went EMPTY. The worker's
    // day-long cache makes repeat views free; this keeps the first view polite.
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    let idx = 0;
    const run = async () => {
      for (;;) {
        const i = idx++;
        if (i >= tvs.length) return;
        const r = tvs[i];
        r._animeChecked = true;
        try {
          const info = await anilistApi(r.id);
          r.isAnime = !!info.anime;
          r.anilistId = info.anilistId != null ? info.anilistId : null;
        } catch (_) {
          r.isAnime = false;
        }
        await sleep(150);
      }
    };
    await Promise.all([run(), run(), run()]);
  }

  // ---- direct (browser -> AniList) lookup ------------------------------------
  // Fallback when the Worker's /api/anilist route isn't reachable: AniList's
  // GraphQL API is public and CORS-enabled, so the browser can resolve a title
  // straight to an AniList id without any server round-trip or API key.
  const ANILIST_ORIGIN = 'https://graphql.anilist.co';
  const ANILIST_QUERY = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME, isAdult: false, sort: [SEARCH_MATCH]) {
        id
        title { romaji english native }
        episodes
        startDate { year }
      }
    }
  }`;

  function normalizeTitle(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function matchAniMedia(title, year, media) {
    const want = normalizeTitle(title);
    if (!want) return null;
    const y = Number(year) || null;
    let best = null;
    let bestScore = -Infinity;
    for (const m of media || []) {
      if (!m || !m.id) continue;
      const t = m.title || {};
      const norm = [t.romaji, t.english, t.native]
        .filter(Boolean)
        .map(normalizeTitle)
        .filter(Boolean);
      let score = 0;
      if (norm.some((n) => n === want)) score += 100;
      else if (norm.some((n) => n.length > 2 && (n.includes(want) || want.includes(n)))) score += 60;
      const my = m.startDate && m.startDate.year ? Number(m.startDate.year) : null;
      if (y && my) {
        if (my === y) score += 50;
        else if (Math.abs(my - y) <= 1) score += 15;
      }
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    return bestScore >= 60 ? best : null;
  }

  async function anilistDirect(title, year) {
    const cacheKey = ANILIST_CACHE_PREFIX + 'direct:' + normalizeTitle(title) + ':' + (year || '');
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const o = JSON.parse(raw);
        const ttl = o.data && o.data.id != null ? ANILIST_CACHE_TTL_MS : ANILIST_NULL_TTL_MS;
        if (Date.now() - o.ts < ttl) return o.data || null;
      }
    } catch (_) {}
    try {
      const res = await fetch(ANILIST_ORIGIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: ANILIST_QUERY, variables: { search: title || '' } }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const media = (data && data.data && data.data.Page && data.data.Page.media) || [];
      const best = matchAniMedia(title, year, media);
      const result = best ? { id: best.id, episodes: best.episodes || null } : null;
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: result }));
      } catch (_) {}
      return result;
    } catch (_) {
      return null;
    }
  }

  // ---- normalization -----------------------------------------------------------
  function normMovie(m) {
    return {
      id: String(m.id),
      type: 'movie',
      title: m.title || m.original_title || '',
      year: (m.release_date || '').slice(0, 4),
      poster: img(m.poster_path, 'w500'),
      backdrop: img(m.backdrop_path, 'w1280'),
      rating: m.vote_average != null ? m.vote_average : null,
      overview: m.overview || '',
    };
  }

  function normTv(t, isAnime) {
    return {
      id: String(t.id),
      type: 'tv',
      isAnime: !!isAnime,
      title: t.name || t.original_name || '',
      year: (t.first_air_date || '').slice(0, 4),
      poster: img(t.poster_path, 'w500'),
      backdrop: img(t.backdrop_path, 'w1280'),
      rating: t.vote_average != null ? t.vote_average : null,
      overview: t.overview || '',
    };
  }

  function normAny(it) {
    if (!it) return null;
    if (it.media_type === 'movie') return normMovie(it);
    if (it.media_type === 'tv') return normTv(it, false);
    if (it.type === 'movie') return normMovie(it);
    if (it.type === 'tv' || it.type === 'anime') return normTv(it, false);
    return null;
  }

  // ---- video model --------------------------------------------------------------
  function watchUrl(item, opts) {
    opts = opts || {};
    if (item.type === 'movie') return `${BINGR_WATCH}/movie/${item.id}`;
    if (item.type === 'anime') {
      const anilistId = item.anilistId != null ? item.anilistId : item.id;
      return `${BINGR_WATCH}/anime/${anilistId}/${opts.episode || 1}`;
    }
    return `${BINGR_WATCH}/tv/${item.id}/${opts.season || 1}/${opts.episode || 1}`;
  }

  function buildVideo(item, opts) {
    opts = opts || {};
    const isAnime = item.type === 'anime' || !!item.isAnime;
    const type = item.type === 'movie' ? 'movie' : (isAnime ? 'anime' : 'tv');
    return {
      type,
      id: String(item.id),
      anilistId: item.anilistId != null ? String(item.anilistId) : null,
      malId: item.malId != null ? String(item.malId) : null,
      src: watchUrl({ type, id: item.id, anilistId: item.anilistId }, opts),
      title: item.title || '',
      year: item.year || '',
      poster: item.poster || '',
      backdrop: item.backdrop || '',
      rating: item.rating != null ? item.rating : null,
      overview: item.overview || '',
      season: type === 'tv' ? opts.season || 1 : null,
      episode: type === 'movie' ? null : opts.episode || 1,
    };
  }

  /** Episode-name tooltips cache (showId:season -> Map(ep -> name)). */
  const epNamesCache = new Map();

  // ---- Watched episodes (faded in the episode selectors) ---------------------
  // WATCHED FADE: episodes already watched render faded + a check; partially
  // watched ones carry a mini progress bar. Sources: local history (sync
  // baseline) + the server history (cross-device, cached per show).
  /** showId -> Promise<Map<ep, {pos, dur, completed}>> (server view). */
  const watchedServerCache = new Map();

  /**
   * Episodes of ONE show/season the user already watched.
   * @param {string|number} showId
   * @param {number|null} season tv: the season number; anime: null (absolute)
   * @returns {{ local: Map<number, {pos: number, dur: number, completed: boolean}>, server: Promise<Map<number, any>> | null }}
   */
  function watchedEpisodesFor(showId, season) {
    const wantSeason = season == null ? null : Number(season);
    const local = new Map();
    const merge = (m, ep, pos, dur, completed) => {
      const prev = m.get(ep) || { pos: 0, dur: 0, completed: false };
      m.set(ep, {
        pos: Math.max(prev.pos, pos),
        dur: Math.max(prev.dur, dur),
        completed: prev.completed || completed,
      });
    };
    try {
      (global.WP.historyGet() || []).forEach((e) => {
        if (!e || String(e.id) !== String(showId) || e.episode == null) return;
        const es = e.season != null && e.season !== '' ? Number(e.season) : null;
        if (wantSeason === null ? es !== null : es !== wantSeason) return;
        const pos = Number(e.position) || 0;
        const dur = Number(e.duration) || 0;
        merge(local, Number(e.episode), pos, dur, dur > 0 && pos >= dur - 30);
      });
    } catch (_) {}
    let server = watchedServerCache.get(String(showId)) || null;
    if (!server && global.WP.Social && global.WP.Social.getServerHistory) {
      server = Promise.resolve(global.WP.Social.getServerHistory())
        .then((items) => {
          const m = new Map();
          (items || []).forEach((h) => {
            if (!h || String(h.mediaId) !== String(showId) || h.episode == null) return;
            const hs = h.season != null && h.season !== 0 ? Number(h.season) : null;
            if (wantSeason === null ? hs !== null : hs !== wantSeason) return;
            const pos = Number(h.positionSeconds) || 0;
            const dur = Number(h.durationSeconds) || 0;
            merge(m, Number(h.episode), pos, dur, !!h.completed || (dur > 0 && pos >= dur - 30));
          });
          return m;
        })
        .catch(() => null);
      watchedServerCache.set(String(showId), server);
    }
    return { local: local, server: server };
  }

  /**
   * Paint watched state onto every .ep-btn under `root` (deep: covers flat
   * grids AND lazily-built thread rows). Idempotent; the CURRENT episode
   * keeps its highlight.
   * @param {HTMLElement} root
   * @param {Map<number, {pos: number, dur: number, completed: boolean}>} byEp
   * @param {number} [currentEp]
   */
  function paintWatched(root, byEp, currentEp) {
    if (!root || !byEp || !byEp.size) return;
    root.querySelectorAll('.ep-btn').forEach((b) => {
      const n = Number(b.textContent);
      if (!n || n === currentEp || b.classList.contains('ep-btn--watched') || b.classList.contains('ep-btn--partial')) return;
      const w = byEp.get(n);
      if (!w) return;
      if (w.completed || (w.dur > 0 && w.pos >= w.dur - 30)) {
        b.classList.add('ep-btn--watched');
        b.title = (b.title ? b.title + ' \u00b7 ' : '') + 'Watched';
      } else if (w.pos > 15 && w.dur > 0) {
        b.classList.add('ep-btn--partial');
        b.style.setProperty('--wp', Math.min(100, Math.round((w.pos / w.dur) * 100)) + '%');
        b.title = (b.title ? b.title + ' \u00b7 ' : '') + 'In progress';
      }
    });
  }

  /**
   * THE episode grid component - used by EVERY episode surface (detail
   * picker, anime flat picker, room episodes modal) so long seasons thread
   * identically everywhere. <=50 episodes: flat grid. >50: threaded rows.
   * Episode names enrich tooltips in both shapes (cached per show+season).
   * @param {HTMLElement} epGrid
   * @param {{ count: number, pick: (n: number) => void, currentEp?: number, showId?: string|number|null, season?: number|null }} o
   */
  function renderEpisodeGrid(epGrid, o) {
    const applyNames = (/** @type {HTMLElement} */ root) => {
      if (!o.showId || !o.season) return;
      const key = o.showId + ':' + o.season;
      const paint = (/** @type {Map<number, {name: string}>} */ byNum) => {
        root.querySelectorAll('.ep-btn').forEach((b) => {
          const ep = byNum.get(Number(b.textContent));
          if (ep && ep.name) b.title = 'E' + b.textContent + ' \u00b7 ' + ep.name;
        });
      };
      const cached = epNamesCache.get(key);
      if (cached) {
        paint(cached);
        return;
      }
      api('/tv/' + encodeURIComponent(String(o.showId)) + '/season/' + o.season)
        .then((data) => {
          if (!data || !data.episodes) return;
          const byNum = new Map(data.episodes.map((e) => [e.episode_number, e]));
          epNamesCache.set(key, byNum);
          paint(byNum);
        })
        .catch(() => {});
    };
    // WATCHED FADE: local history paints immediately; the server view
    // (cross-device) re-paints when it arrives. Deep on purpose — it also
    // decorates thread rows built later.
    const watched = o.showId != null ? watchedEpisodesFor(o.showId, o.season == null ? null : o.season) : null;
    const paintLocal = () => watched && paintWatched(epGrid, watched.local, o.currentEp || 0);
    const decorate = (/** @type {HTMLElement} */ root) => {
      applyNames(root);
      paintLocal();
    };
    if (o.count > 50) {
      buildThreadedEpisodes(epGrid, o.count, o.pick, o.currentEp || 0, decorate);
    } else {
      for (let n = 1; n <= o.count; n++) {
        const b = h('button', 'ep-btn' + (n === o.currentEp ? ' ep-btn--current' : ''), String(n));
        b.type = 'button';
        b.addEventListener('click', () => o.pick(n));
        epGrid.appendChild(b);
      }
      decorate(epGrid);
    }
    if (watched && watched.server) {
      watched.server.then((byEp) => {
        if (byEp && byEp.size && epGrid.isConnected) paintWatched(epGrid, byEp, o.currentEp || 0);
      });
    }
  }

  /**
   * Threaded episode grid for LONG seasons (> THREAD_ROW_MAX episodes):
   * every episode is available, chunked into collapsible rows of ~50 with
   * labeled headers (E1-50, E51-100, ...) - rows materialize their buttons
   * lazily on first open (1000+ episodes must not create 1000 nodes).
   * @param {HTMLElement} epGrid
   * @param {number} count
   * @param {(n: number) => void} pick
   * @param {number} [currentEp] highlight + auto-open its thread row
   * @param {(root: HTMLElement) => void} [applyNames] name enrichment per row
   */
  function buildThreadedEpisodes(epGrid, count, pick, currentEp, applyNames) {
    const THREAD_ROW_MAX = 50;
    const rows = Math.ceil(count / THREAD_ROW_MAX);
    /** @type {HTMLElement[]} */ const rowEls = [];
    for (let r = 0; r < rows; r++) {
      const from = r * THREAD_ROW_MAX + 1;
      const to = Math.min(count, from + THREAD_ROW_MAX - 1);
      const rowEl = h('div', 'detail__ep-row');
      const head = h('button', 'detail__ep-row-head', 'E' + from + '\u2013' + to);
      head.type = 'button';
      const body = h('div', 'detail__ep-row-body');
      rowEl.appendChild(head);
      rowEl.appendChild(body);
      let built = false;
      head.addEventListener('click', () => {
        if (!built) {
          built = true;
          for (let n = from; n <= to; n++) {
            const b = h('button', 'ep-btn' + (n === currentEp ? ' ep-btn--current' : ''), String(n));
            b.type = 'button';
            b.addEventListener('click', () => pick(n));
            body.appendChild(b);
          }
          if (applyNames) applyNames(body);
        }
        rowEl.classList.toggle('is-open');
      });
      epGrid.appendChild(rowEl);
      rowEls.push(rowEl);
    }
    // Auto-open the row holding the current episode (or the first row).
    const idx = currentEp ? Math.min(rows - 1, Math.floor((currentEp - 1) / THREAD_ROW_MAX)) : 0;
    const head = rowEls[idx] && /** @type {HTMLButtonElement} */ (rowEls[idx].querySelector('.detail__ep-row-head'));
    if (head) {
      head.click();
      const body = rowEls[idx].querySelector('.detail__ep-row-body');
      const cur = body && body.querySelector('.ep-btn--current');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'center' });
    }
  }

  function typeLabel(item) {
    if (item.type === 'anime' || item.isAnime) return 'Anime';
    return item.type === 'movie' ? 'Movie' : 'Series';
  }

  function metaText(item) {
    const parts = [];
    if (item.rating) parts.push('★ ' + Number(item.rating).toFixed(1));
    if (item.year) parts.push(String(item.year));
    parts.push(typeLabel(item));
    return parts.join(' · ');
  }

  // ---- recommendations --------------------------------------------------------
  // "Similar content" for the room player: TMDB's own recommendations endpoint.
  async function fetchRecommendations(video) {
    if (!video || !video.id || !video.type) return [];
    const id = encodeURIComponent(video.id);
    const path = video.type === 'movie'
      ? `/movie/${id}/recommendations`
      : `/tv/${id}/recommendations`;
    try {
      const data = await api(path);
      const results = (data && data.results) || [];
      const items = video.type === 'movie'
        ? results.map(normMovie)
        : results.map((t) => normTv(t, false));
      return items.filter((it) => it && it.title);
    } catch (_) {
      return [];
    }
  }

  // ---- hover preview (autoplaying trailer + plot) -------------------------------
  const CAN_HOVER =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover)').matches;

  const videosCache = new Map(); // "type:id" -> YouTube key (or null)
  let previewTimer = null;
  let previewEl = null;
  let previewFor = null; // item currently previewed

  /** Trailer audio preference for the hover preview (device pref, default ON). */
  const TRAILER_SOUND_KEY = 'wp:trailersound';

  /** @returns {boolean} true when the trailer should play WITH sound */
  function trailerSoundOn() {
    try {
      return localStorage.getItem(TRAILER_SOUND_KEY) !== '0';
    } catch (_) {
      return true; // default: sound on
    }
  }

  /** @param {boolean} on */
  function setTrailerSound(on) {
    try {
      localStorage.setItem(TRAILER_SOUND_KEY, on ? '1' : '0');
    } catch (_) {}
  }

  /**
   * Send a YouTube iframe-API command to the trailer in the OPEN preview
   * (no-op when nothing is playing). Used for mute / unMute.
   * @param {string} func
   */
  function commandPreview(func) {
    const frame = previewEl ? previewEl.querySelector('iframe') : null;
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: [] }), '*');
    } catch (_) {}
  }

  function closePreview() {
    if (previewTimer) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    if (previewEl) {
      previewEl.remove();
      previewEl = null;
      previewFor = null;
    }
  }

  function scheduleClosePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(closePreview, 220);
  }

  async function fetchTrailerKey(item) {
    const cacheKey = item.type + ':' + item.id;
    if (videosCache.has(cacheKey)) return videosCache.get(cacheKey);
    let key = null;
    try {
      const path = item.type === 'movie'
        ? '/movie/' + encodeURIComponent(item.id) + '/videos'
        : '/tv/' + encodeURIComponent(item.id) + '/videos';
      const data = await api(path);
      const vids = (data && data.results) || [];
      const yt = vids.filter((v) => v.site === 'YouTube' && v.key);
      const trailer =
        yt.find((v) => v.type === 'Trailer' && v.official) ||
        yt.find((v) => v.type === 'Trailer') ||
        yt[0];
      key = trailer ? trailer.key : null;
    } catch (_) {}
    videosCache.set(cacheKey, key);
    return key;
  }

  function trailerEmbed(key) {
    // `enablejsapi=1` lets the preview flip sound on/off after the player has
    // started (raw postMessage commands). The embed ALWAYS starts muted: a
    // hover is not a user gesture, so only muted autoplay is guaranteed —
    // starting unmuted can leave a frozen first frame instead of a trailer.
    // buildPreview() requests `unMute` right after load when the audio
    // preference is ON (the default), so it plays with sound wherever the
    // browser allows it and still plays silently where it does not.
    let src = 'https://www.youtube.com/embed/' + encodeURIComponent(key) +
      '?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&playsinline=1&enablejsapi=1';
    try {
      if (global.location && global.location.origin) {
        src += '&origin=' + encodeURIComponent(global.location.origin);
      }
    } catch (_) {}
    return src;
  }

  function buildPreview(item) {
    const el = h('div', 'card-preview');

    const media = h('div', 'card-preview__media');
    const fallback = item.backdrop || item.poster;
    if (fallback) {
      const im = document.createElement('img');
      im.src = fallback;
      im.alt = '';
      media.appendChild(im);
    }
    // AUDIO TOGGLE: the trailer starts muted (autoplay policy) — this control
    // is the user's one-click way to get sound, and it doubles as the visible
    // mute state. Default ON for every new preview; the choice persists so it
    // is not re-decided on every hover.
    const sound = document.createElement('button');
    sound.type = 'button';
    sound.className = 'card-preview__sound' + (trailerSoundOn() ? ' is-on' : '');
    sound.setAttribute('aria-pressed', String(trailerSoundOn()));
    sound.title = trailerSoundOn() ? 'Trailer sound: on' : 'Trailer sound: muted';
    sound.textContent = trailerSoundOn() ? '🔊' : '🔇';
    sound.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const on = !sound.classList.contains('is-on');
      setTrailerSound(on);
      sound.classList.toggle('is-on', on);
      sound.setAttribute('aria-pressed', String(on));
      sound.title = on ? 'Trailer sound: on' : 'Trailer sound: muted';
      sound.textContent = on ? '🔊' : '🔇';
      commandPreview(on ? 'unMute' : 'mute');
    });
    media.appendChild(sound);
    el.appendChild(media);

    const body = h('div', 'card-preview__body');
    body.appendChild(h('div', 'card-preview__title', item.title));
    body.appendChild(h('div', 'card-preview__meta', metaText(item)));
    if (item.overview) body.appendChild(h('p', 'card-preview__overview', item.overview));
    el.appendChild(body);

    el.addEventListener('mouseenter', () => {
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
    });
    el.addEventListener('mouseleave', scheduleClosePreview);
    return el;
  }

  function positionPreview(el, card) {
    const rect = card.getBoundingClientRect();
    const W = el.offsetWidth || 304;
    const H = el.offsetHeight || 360;
    const margin = 12;
    let left = rect.right + margin;
    if (left + W > window.innerWidth - 8) left = rect.left - W - margin;
    if (left < 8) left = 8;
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - H - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  function attachHoverPreview(card, item) {
    if (!CAN_HOVER) return;
    card.addEventListener('mouseenter', () => {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (previewFor === item) return;
        closePreview();
        previewFor = item;
        previewEl = buildPreview(item);
        document.body.appendChild(previewEl);
        positionPreview(previewEl, card);
        fetchTrailerKey(item).then((key) => {
          if (!previewEl || previewFor !== item || !key) return;
          const media = previewEl.querySelector('.card-preview__media');
          if (!media) return;
          // Drop the placeholder art only — `media.innerHTML = ''` would take
          // the audio toggle with it.
          const posterImg = media.querySelector('img');
          if (posterImg) posterImg.remove();
          const iframe = document.createElement('iframe');
          iframe.src = trailerEmbed(key);
          iframe.title = item.title || 'Trailer';
          iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
          iframe.setAttribute('allowfullscreen', '');
          // Sound ON (the default): ask the player to unmute once it has had
          // time to boot. Sent unconditionally — if the browser blocked
          // unmuted playback the trailer keeps playing silently instead of
          // showing a frozen frame, and the audio button stays authoritative.
          iframe.addEventListener('load', () => {
            if (!trailerSoundOn()) return;
            setTimeout(() => {
              // Re-check BOTH identity (the preview may have been swapped or
              // closed) and the preference — a click during this boot delay
              // must not be undone by a late unMute.
              if (previewEl && previewFor === item && trailerSoundOn()) commandPreview('unMute');
            }, 700);
          });
          media.appendChild(iframe);
        })
        .catch(() => {});
      }, 550);
    });
    card.addEventListener('mouseleave', scheduleClosePreview);
  }

  // ---- cards ---------------------------------------------------------------------
  function cardNode(item, onClick) {
    const card = h('div', 'card-item');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const poster = h('div', 'card-item__poster');
    if (item.poster) {
      const im = document.createElement('img');
      im.loading = 'lazy';
      im.alt = item.title || '';
      im.src = item.poster;
      im.onerror = () => {
        im.remove();
        poster.appendChild(
          h('div', 'card-item__poster-fallback', (item.title || '?').slice(0, 1).toUpperCase())
        );
      };
      poster.appendChild(im);
    } else {
      poster.appendChild(
        h('div', 'card-item__poster-fallback', (item.title || '?').slice(0, 1).toUpperCase())
      );
    }
    poster.appendChild(h('span', 'card-item__badge', typeLabel(item)));

    // LIKE HEART: top-right of the poster; state from the WP.Social cache.
    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'card-item__like';
    likeBtn.setAttribute('aria-label', 'Like');
    const syncHeart = (/** @type {boolean} */ on) => {
      likeBtn.classList.toggle('is-liked', on);
      likeBtn.textContent = on ? '\u2665' : '\u2661';
    };
    if (global.WP && global.WP.Social && global.WP.Social.getLikeIds) {
      global.WP.Social.getLikeIds().then((set) => {
        // Card may have been swapped out while the request was in flight.
        if (likeBtn.isConnected) syncHeart(set.has(String(item.id)));
      });
    }
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const Social = global.WP && global.WP.Social;
      if (!Social || !Social.toggleLike) return;
      if (!Social.getSession || !Social.getSession()) {
        Social.toast('Sign in to like titles.', true);
        return;
      }
      const optimistic = !likeBtn.classList.contains('is-liked');
      syncHeart(optimistic);
      Social.toggleLike({
        mediaId: String(item.id),
        mediaType: item.type === 'tv' ? 'tv' : 'movie',
        mediaTitle: item.title || '',
        posterUrl: item.poster || '',
      })
        .then((on) => syncHeart(on))
        .catch(() => {
          syncHeart(!optimistic);
          Social.toast('Could not save that like \u2014 try again.', true);
        });
    });
    poster.appendChild(likeBtn);

    const body = h('div', 'card-item__body');
    body.appendChild(h('div', 'card-item__title', item.title));
    body.appendChild(h('div', 'card-item__meta', metaText(item)));

    card.appendChild(poster);
    card.appendChild(body);

    const activate = () => {
      closePreview();
      onClick(item);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    attachHoverPreview(card, item);
    return card;
  }

  function renderHero(container, item, onSelect) {
    container.innerHTML = '';
    if (!item) {
      container.appendChild(h('div', 'hero__skeleton'));
      return;
    }
    const hero = h('div', 'hero');

    // Banner art on its own clipped layer — it can never overflow the hero.
    const media = h('div', 'hero__media');
    const artSrc = item.backdrop || item.poster || '';
    if (artSrc) {
      const im = document.createElement('img');
      im.src = artSrc;
      im.alt = '';
      im.setAttribute('aria-hidden', 'true');
      // If the backdrop fails, fall back to the poster instead.
      im.onerror = () => {
        if (item.poster && im.src !== item.poster) im.src = item.poster;
        else im.remove();
      };
      media.appendChild(im);
    }
    hero.appendChild(media);

    const content = h('div', 'hero__content');
    content.appendChild(h('span', 'hero__badge', typeLabel(item)));
    content.appendChild(h('h1', 'hero__title', item.title));
    content.appendChild(h('div', 'hero__meta', metaText(item)));
    if (item.overview) content.appendChild(h('p', 'hero__overview', item.overview));

    const actions = h('div', 'hero__actions');
    const watch = h('button', 'btn btn--primary', tr('card.watchTogether', 'Watch together'));
    watch.addEventListener('click', () => onSelect(item));
    actions.appendChild(watch);
    const details = h('button', 'btn btn--ghost', tr('card.details', 'Details'));
    details.addEventListener('click', () => openDetail(item, (v) => onSelect(v)));
    actions.appendChild(details);

    content.appendChild(actions);
    hero.appendChild(content);
    container.appendChild(hero);
  }

  // ---- detail / episode picker ---------------------------------------------------------
  function openDetail(item, onPick) {
    const overlay = h('div', 'modal');
    const card = h('div', 'modal__card modal__card--wide detail');

    const head = h('div', 'modal__head');
    head.appendChild(h('h2', 'modal__title', 'Details'));
    const closeBtn = h('button', 'modal__close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(closeBtn);
    card.appendChild(head);

    const body = h('div', 'detail__body');
    body.style.padding = '20px';
    body.style.overflowY = 'auto';
    body.appendChild(h('div', 'browse__empty', tr('feed.loading', 'Loading\u2026')));
    card.appendChild(body);

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
    }
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    (async () => {
      try {
        if (item.type === 'movie') {
          const extra = await api('/movie/' + encodeURIComponent(item.id));
          renderDetailBody(body, item, extra, null, onPick, close);
        } else {
          const extra = await api('/tv/' + encodeURIComponent(item.id));
          // Resolve anime classification + AniList id. Try the Worker endpoint
          // first (TMDB keywords + AniList match); if that's unreachable or
          // can't find a match, fall back to a direct browser -> AniList lookup
          // (public, keyless GraphQL API). Unmatched anime degrades to the TMDB tv path.
          let info = null;
          try {
            info = await anilistApi(item.id);
          } catch (_) {
            info = null;
          }
          const isAnime = !!(item.isAnime || (info && info.anime));
          if (isAnime) {
            item.isAnime = true;
            let anilistId = info && info.anilistId != null ? info.anilistId : null;
            let episodes = info && info.episodes != null ? info.episodes : null;
            if (anilistId == null) {
              const direct = await anilistDirect(item.title, item.year);
              if (direct && direct.id != null) {
                anilistId = direct.id;
                episodes = direct.episodes || null;
              }
            }
            if (anilistId != null) {
              item.anilistId = anilistId;
              const malId = info && info.malId != null ? String(info.malId) : null;
              if (malId) item.malId = malId;
              renderAnimeBody(body, item, extra, { episodes: episodes, malId: malId }, onPick, close);
            } else {
              // NO AniList match: degrade to the REAL TMDB seasons UI (chips
              // + per-season grids playing the tv path) instead of a dead
              // end. TMDB anime entries carry proper /season structure, so
              // the user can still watch; if a later resolve matches, the
              // absolute AniList grid takes over again.
              item.isAnime = false;
              item.type = 'tv';
              renderDetailBody(body, item, extra, extra.seasons || [], onPick, close);
            }
          } else {
            renderDetailBody(body, item, extra, extra.seasons || [], onPick, close);
          }
        }
      } catch (e) {
        body.innerHTML = '';
        body.appendChild(h('div', 'browse__empty', 'Could not load details: ' + e.message));
      }
    })();
  }

  function renderDetailBody(body, item, extra, seasons, onPick, close) {
    body.innerHTML = '';

    const top = h('div', 'detail__top');
    const showPosterSrc = (extra && extra.poster_path ? img(extra.poster_path, 'w500') : '') || item.poster || '';
    const poster = document.createElement('img');
    poster.className = 'detail__poster';
    poster.alt = '';
    poster.src = showPosterSrc;
    // A failed season cover reverts to the SHOW poster (never a broken image,
    // never a vanished cover); only when even the show art is gone do we drop it.
    poster.onerror = () => {
      if (poster.src !== showPosterSrc && showPosterSrc) {
        poster.src = showPosterSrc;
      } else {
        poster.remove();
      }
    };
    top.appendChild(poster);

    const info = h('div', 'detail__info');
    info.appendChild(h('div', 'detail__title', (extra && (extra.title || extra.name)) || item.title));
    const metaParts = [];
    if ((extra && extra.vote_average) || item.rating) metaParts.push('★ ' + Number((extra && extra.vote_average) || item.rating).toFixed(1));
    if ((extra && extra.release_date) || (extra && extra.first_air_date) || item.year) {
      metaParts.push(String(((extra && (extra.release_date || extra.first_air_date)) || item.year || '').slice(0, 4)));
    }
    if (extra && extra.runtime) metaParts.push(extra.runtime + ' min');
    if (extra && extra.genres && extra.genres.length) metaParts.push(extra.genres[0].name);
    metaParts.push(typeLabel(item));
    info.appendChild(h('div', 'detail__meta', metaParts.join(' · ')));

    const overview = (extra && extra.overview) || item.overview || '';
    if (overview) info.appendChild(h('p', 'detail__overview', overview));
    top.appendChild(info);
    body.appendChild(top);

    // Movies play directly; series need an episode choice.
    if (item.type === 'movie') {
      const actions = h('div', 'detail__actions');
      const play = h('button', 'btn btn--primary', tr('card.watchTogether', 'Watch together'));
      play.addEventListener('click', () => {
        onPick(buildVideo(item));
        close();
      });
      actions.appendChild(play);
      body.appendChild(actions);
      return;
    }

    const usable = (Array.isArray(seasons) ? seasons : [])
      .filter((s) => s && Number(s.season_number) > 0)
      .map((s) => ({
        season: Number(s.season_number),
        name: s.name || `Season ${s.season_number}`,
        episodes: Number(s.episode_count) || 0,
        // TMDB ships a poster per season — the detail cover follows it.
        poster: (s.poster_path ? img(s.poster_path, 'w500') : '') || showPosterSrc,
      }));

    const section = h('div', 'detail__section');
    section.appendChild(h('p', 'detail__label', 'Season'));
    const seasonChips = h('div', 'detail__seasons');
    const epLabel = h('p', 'detail__label', 'Episode');
    const epGrid = h('div', 'detail__episodes');
    section.appendChild(seasonChips);
    section.appendChild(epLabel);
    section.appendChild(epGrid);
    body.appendChild(section);

    function renderSeason(s) {
      seasonChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip--active'));
      seasonChips.querySelectorAll('.chip').forEach((c) => {
        if (Number(c.dataset.season) === s.season) c.classList.add('chip--active');
      });
      // The cover follows the selected season (falls back to the show art).
      if (s.poster && poster.parentNode && poster.src !== s.poster) poster.src = s.poster;
      renderEpisodes(s);
    }

    function renderEpisodes(s) {
      epGrid.innerHTML = '';
      const count = s.episodes || 0;
      if (!count) {
        epGrid.appendChild(h('div', 'browse__empty', 'No episode data.'));
        return;
      }
      // ONE component everywhere: flat <=50, threaded >50, names in both.
      renderEpisodeGrid(epGrid, {
        count: count,
        pick: (n) => {
          onPick(buildVideo(item, { season: s.season, episode: n }));
          close();
        },
        showId: item.id,
        season: s.season,
      });
    }

    if (!usable.length) {
      epGrid.appendChild(h('div', 'browse__empty', 'No season data available.'));
      return;
    }

    usable.forEach((s, i) => {
      const chip = h('button', 'chip' + (i === 0 ? ' chip--active' : ''), s.name || `Season ${s.season}`);
      chip.type = 'button';
      chip.dataset.season = String(s.season);
      chip.addEventListener('click', () => renderSeason(s));
      seasonChips.appendChild(chip);
    });
    renderEpisodes(usable[0]);
  }

  // Anime detail: episode-only picker (absolute numbering, AniList total).
  function renderAnimeBody(body, item, extra, info, onPick, close) {
    body.innerHTML = '';

    const top = h('div', 'detail__top');
    const poster = document.createElement('img');
    poster.className = 'detail__poster';
    poster.alt = '';
    poster.src = (extra && extra.poster_path ? img(extra.poster_path, 'w500') : '') || item.poster || '';
    poster.onerror = () => poster.remove();
    top.appendChild(poster);

    const infoEl = h('div', 'detail__info');
    infoEl.appendChild(h('div', 'detail__title', (extra && (extra.name || extra.title)) || item.title));

    const count = Math.max(
      1,
      Number(info && info.episodes) || Number(extra && extra.number_of_episodes) || 1
    );
    const metaParts = [];
    if ((extra && extra.vote_average) || item.rating) {
      metaParts.push('★ ' + Number((extra && extra.vote_average) || item.rating).toFixed(1));
    }
    const y = (extra && extra.first_air_date) || item.year || '';
    if (y) metaParts.push(String(y).slice(0, 4));
    metaParts.push('Anime');
    metaParts.push(count + ' eps');
    infoEl.appendChild(h('div', 'detail__meta', metaParts.join(' · ')));

    const overview = (extra && extra.overview) || item.overview || '';
    if (overview) infoEl.appendChild(h('p', 'detail__overview', overview));
    top.appendChild(infoEl);
    body.appendChild(top);

    const section = h('div', 'detail__section');
    section.appendChild(h('p', 'detail__label', 'Episode'));
    const epGrid = h('div', 'detail__episodes');
    const pick = (n) => {
      onPick(buildVideo(item, { episode: n }));
      close();
    };

    renderEpisodeGrid(epGrid, { count: count, pick: pick, showId: item.id, season: null });
    section.appendChild(epGrid);
    body.appendChild(section);
  }


  // ---- feed definitions (shared by the home browse feed and /discovery pages) --------
  // Pure data: instances must copy these, never mutate them (two mounts can
  // coexist — home browse + room sidebar browse).
  const FEED_DEFS = [
    { key: 'movie', title: 'Popular Movies', path: (p) => `/movie/popular?page=${p}`, map: normMovie },
    { key: 'tv', title: 'Popular TV Shows', path: (p) => `/tv/popular?page=${p}`, map: (t) => normTv(t, false) },
    { key: 'anime', title: 'Popular Anime', path: (p) => `/discover/tv?with_keywords=${ANIME_KEYWORD}&sort_by=popularity.desc&page=${p}`, map: (t) => normTv(t, true) },
    { key: 'trending', title: 'Trending Now', path: (p) => `/trending/all/week?page=${p}`, map: normAny },
    { key: 'topMovies', title: 'Top Rated Movies', path: (p) => `/movie/top_rated?page=${p}`, map: normMovie },
    { key: 'topTv', title: 'Top Rated Series', path: (p) => `/tv/top_rated?page=${p}`, map: (t) => normTv(t, false) },
    { key: 'nowPlaying', title: 'In Theaters', path: (p) => `/movie/now_playing?page=${p}`, map: normMovie },
    { key: 'airingToday', title: 'Airing Today', path: (p) => `/tv/airing_today?page=${p}`, map: (t) => normTv(t, false) },
  ];

  // Side-nav keys (= /discovery/:key route keys) → FEED_DEFS keys.
  // 'movie' is accepted as an alias of 'movies'.
  const DISCOVERY_ROUTES = {
    movies: 'movie',
    movie: 'movie',
    series: 'tv',
    anime: 'anime',
    trending: 'trending',
    'top-movies': 'topMovies',
    'top-tv': 'topTv',
    'now-playing': 'nowPlaying',
    'airing-today': 'airingToday',
  };

  // ---- browse surface -----------------------------------------------------------------
  function mountBrowse(container, opts) {
    opts = opts || {};
    const onSelect = opts.onSelect || function () {};
    // Optional async `(query) => Node | null` — renders the "People" section
    // above media results (profiles/search integration, see social.js).
    const peopleProvider = typeof opts.peopleProvider === 'function' ? opts.peopleProvider : null;
    const externalInputs = Array.isArray(opts.searchInputs)
      ? opts.searchInputs.filter(Boolean)
      : opts.searchInput
        ? [opts.searchInput]
        : null;

    container.classList.add('browse');
    container.innerHTML = '';

    // Filter chips (only shown while search results are active).
    const filters = h('div', 'browse__filters');
    filters.hidden = true;
    const FILTERS = [
      ['all', 'All'],
      ['movie', 'Movies'],
      ['tv', 'Series'],
      ['anime', 'Anime'],
    ];
    let activeFilter = 'all';
    const chipEls = {};
    FILTERS.forEach(([key, label]) => {
      const c = h('button', 'chip' + (key === 'all' ? ' chip--active' : ''), label);
      c.type = 'button';
      c.addEventListener('click', async () => {
        activeFilter = key;
        Object.keys(chipEls).forEach((k) => chipEls[k].classList.toggle('chip--active', k === key));
        // The "Anime" filter needs each result classified (TMDB → AniList).
        if (key === 'anime' && results.length) {
          await classifyAnime(results);
          if (destroyed) return;
        }
        renderResults();
      });
      chipEls[key] = c;
      filters.appendChild(c);
    });

    // Search input(s): the home page supplies the top-nav and side-nav inputs
    // (both drive the same search, kept in sync); other surfaces (the room's
    // change-video modal) get an inline search bar instead.
    let inlineInput = null;
    if (!externalInputs) {
      const search = h('div', 'browse__search');
      inlineInput = h('input', 'browse__search-input');
      inlineInput.type = 'text';
      inlineInput.placeholder = 'Search movies & series\u2026';
      inlineInput.autocomplete = 'off';
      search.appendChild(inlineInput);
      search.appendChild(filters);
      container.appendChild(search);
    } else {
      container.appendChild(filters);
    }

    const heroWrap = h('div', 'browse__hero');
    const rowsWrap = h('div', 'browse__rows');
    container.appendChild(heroWrap);
    container.appendChild(rowsWrap);

    let searchTimer = null;
    let results = [];
    let destroyed = false;
    let seq = 0;

    // ---- browse feed (vertical infinite scroll) --------------------------------
    // The home feed is an ordered list of sections (FEED_DEFS, module scope —
    // shared with the /discovery pages). New sections appear as you scroll
    // toward the bottom; each section is a horizontal row that also deepens
    // page by page. Sections are addressable by `key` so the side nav can
    // jump straight to them.
    const INITIAL_SECTIONS = 4;

    let sections = [];
    let paginateIdx = 0; // round-robin cursor for deepening existing sections

    let mode = 'browse'; // 'browse' | 'search'
    let searchQuery = '';
    let gridEl = null;
    let searchPage = 1;
    let searchDone = false;
    let loadingMore = false;
    let io = null;
    const sentinel = h('div', 'browse__sentinel');

    function resetSections() {
      sections = FEED_DEFS.map((d) => ({
        key: d.key,
        title: d.title,
        path: d.path,
        map: d.map,
        page: 0,
        done: false,
        el: null,
        loading: false,
      }));
      paginateIdx = 0;
    }

    function resetRows() {
      rowsWrap.innerHTML = '';
      rowsWrap.appendChild(sentinel);
      gridEl = null;
    }

    function makeSectionRow(def, items) {
      const sec = h('section', 'row');
      sec.dataset.row = def.key; // lets the side nav scroll to this section
      sec.appendChild(h('h2', 'row__title', def.title));
      const scroller = h('div', 'row__scroller');
      items.forEach((it) => scroller.appendChild(cardNode(it, choose)));
      sec.appendChild(scroller);
      rowsWrap.insertBefore(sec, sentinel);
      def.el = sec;
      return scroller;
    }

    function appendToSection(def, items) {
      if (!def || !def.el || !items || !items.length) return;
      const scroller = def.el.querySelector('.row__scroller');
      items.forEach((it) => scroller.appendChild(cardNode(it, choose)));
    }

    async function createSection(idx) {
      const def = sections[idx];
      if (!def || def.done || def.el || def.loading) return;
      def.loading = true;
      try {
        const data = await api(def.path(1));
        if (destroyed) return;
        const items = (data.results || []).map(def.map).filter(Boolean);
        if (items.length) makeSectionRow(def, items);
        if (!items.length || data.page >= (data.total_pages || 1)) def.done = true;
        def.page = 1;
      } catch (_) {
        def.done = true;
      } finally {
        def.loading = false;
      }
    }

    async function paginateSection(idx) {
      const def = sections[idx];
      if (!def || def.done || def.loading || !def.el) return;
      def.loading = true;
      try {
        const next = def.page + 1;
        const data = await api(def.path(next));
        if (destroyed) return;
        const items = (data.results || []).map(def.map).filter(Boolean);
        appendToSection(def, items);
        def.page = next;
        if (!items.length || data.page >= (data.total_pages || 1)) def.done = true;
      } catch (_) {
        def.done = true;
      } finally {
        def.loading = false;
      }
    }

    // Load the next chunk of the vertical feed: create the next not-yet-created
    // section until all sections exist, then deepen existing sections page by
    // page. Returns false once the whole feed is exhausted.
    async function loadNextChunk() {
      if (destroyed || mode !== 'browse') return true;
      for (let i = 0; i < sections.length; i++) {
        const def = sections[i];
        if (!def.done && !def.el && !def.loading) {
          await createSection(i);
          return true;
        }
      }
      for (let i = 0; i < sections.length; i++) {
        const idx = (paginateIdx + i) % sections.length;
        const def = sections[idx];
        if (!def.done && def.el && !def.loading) {
          paginateIdx = (idx + 1) % sections.length;
          await paginateSection(idx);
          return !sections.every((s) => s.done);
        }
      }
      return false;
    }

    async function loadMore() {
      if (loadingMore || destroyed) return;
      loadingMore = true;
      try {
        if (mode === 'search' && searchQuery) await loadMoreSearch();
        else if (mode === 'browse') await loadNextChunk();
      } finally {
        loadingMore = false;
      }
    }

    function setupInfiniteScroll() {
      if (typeof IntersectionObserver === 'undefined') return; // graceful fallback
      if (io) io.disconnect();
      io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      }, { rootMargin: '900px 0px' });
      io.observe(sentinel);
    }

    function choose(item) {
      if (item.type === 'movie') {
        onSelect(buildVideo(item));
      } else {
        openDetail(item, (video) => onSelect(video));
      }
    }

    function matchesFilter(r) {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'movie') return r.type === 'movie';
      if (activeFilter === 'anime') return !!r.isAnime;
      return r.type === 'tv' && !r.isAnime;
    }

    function renderResults() {
      filters.hidden = false;
      heroWrap.style.display = 'none';
      resetRows();
      const list = results.filter(matchesFilter);
      gridEl = h('div', 'grid');
      if (!list.length) {
        gridEl.appendChild(h('div', 'browse__empty', tr('feed.noResults', 'No results \u2014 try another title.')));
      } else {
        list.forEach((it) => gridEl.appendChild(cardNode(it, choose)));
      }
      rowsWrap.insertBefore(gridEl, sentinel);
      // People results sit above the media grid (best effort — if the call
      // fails or finds nobody, the media grid stands alone).
      if (peopleProvider && searchQuery) {
        const q = searchQuery;
        Promise.resolve(peopleProvider(q)).then((node) => {
          if (destroyed || !node || mode !== 'search' || searchQuery !== q) return;
          rowsWrap.insertBefore(node, rowsWrap.firstChild);
        }).catch(() => {});
      }
    }

    function showError(detail) {
      heroWrap.innerHTML = '';
      rowsWrap.innerHTML = '';
      const wrap = h('div', 'browse__error');
      wrap.appendChild(h('div', 'browse__empty', 'Could not load the library.'));
      if (detail) wrap.appendChild(h('div', 'browse__error-detail', String(detail)));
      const retry = h('button', 'btn btn--ghost btn--sm', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => loadBrowse());
      wrap.appendChild(retry);
      rowsWrap.appendChild(wrap);
    }

    // Keep all external search inputs showing the same query.
    const setInputsValue = (q) => {
      if (externalInputs) {
        externalInputs.forEach((inp) => {
          if (inp.value !== q) inp.value = q;
        });
      }
    };

    async function loadMoreSearch() {
      if (searchDone || !searchQuery) return;
      const mySeq = seq;
      searchPage++;
      try {
        const data = await api('/search/multi?query=' + encodeURIComponent(searchQuery) + '&include_adult=false&page=' + searchPage);
        if (destroyed || mySeq !== seq) return;
        const items = (data.results || []).map(normAny).filter(Boolean);
        if (!items.length || data.page >= (data.total_pages || 1)) searchDone = true;
        results = results.concat(items);
        if (gridEl) {
          const empty = gridEl.querySelector('.browse__empty');
          if (empty) empty.remove();
          items.filter(matchesFilter).forEach((it) => gridEl.appendChild(cardNode(it, choose)));
        }
      } catch (_) {
        searchDone = true;
      }
    }

    const onInput = (ev) => {
      const raw = String((ev && ev.target && ev.target.value) || '');
      const q = raw.trim();
      clearTimeout(searchTimer);
      if (!q) {
        seq++;
        results = [];
        setInputsValue('');
        mode = 'browse';
        searchQuery = '';
        searchPage = 1;
        searchDone = false;
        filters.hidden = true;
        heroWrap.style.display = '';
        loadBrowse();
        return;
      }
      // Keep the OTHER synced input(s) in step with the RAW value. Writing
      // the trimmed value back — especially into the input the user is
      // typing in — ate every trailing space mid-keystroke, making
      // multi-word search ("dune part two") impossible from the nav bars.
      if (externalInputs) {
        externalInputs.forEach((inp) => {
          if (inp && inp !== ev.target && inp.value !== raw) inp.value = raw;
        });
      }
      searchTimer = setTimeout(async () => {
        const mySeq = ++seq;
        mode = 'search';
        searchQuery = q;
        searchPage = 1;
        searchDone = false;
        results = [];
        resetRows();
        const grid = h('div', 'grid');
        grid.appendChild(h('div', 'browse__empty', 'Searching\u2026'));
        rowsWrap.insertBefore(grid, sentinel);
        filters.hidden = true;
        try {
          const data = await api('/search/multi?query=' + encodeURIComponent(q) + '&include_adult=false');
          if (destroyed || mySeq !== seq) return;
          results = (data.results || []).map(normAny).filter(Boolean);
          if (!results.length || data.page >= (data.total_pages || 1)) searchDone = true;
          if (activeFilter === 'anime') await classifyAnime(results);
          if (destroyed || mySeq !== seq) return;
          renderResults();
        } catch (e) {
          if (destroyed || mySeq !== seq) return;
          filters.hidden = true;
          resetRows();
          rowsWrap.insertBefore(
            h('div', 'browse__empty', 'Search failed: ' + (e && e.message ? e.message : '')),
            sentinel
          );
        }
      }, 350);
    };

    const inputs = externalInputs || [inlineInput];
    inputs.forEach((inp) => {
      if (inp) inp.addEventListener('input', onInput);
    });

    function renderLoading() {
      heroWrap.innerHTML = '<div class="hero__skeleton"></div>';
      resetRows();
      const skel = h('div', 'row__skeleton');
      for (let i = 0; i < 5; i++) skel.appendChild(h('div', 'skel-card'));
      rowsWrap.insertBefore(skel, sentinel);
    }

    async function loadBrowse() {
      const mySeq = ++seq;
      mode = 'browse';
      searchQuery = '';
      searchPage = 1;
      searchDone = false;
      resetSections();
      renderLoading();
      // Hero from trending page 1 (trending is also one of the feed sections).
      try {
        const d = await api('/trending/all/week');
        if (destroyed || mySeq !== seq) return;
        const all = (d.results || []).map(normAny).filter(Boolean);
        renderHero(heroWrap, all.find((x) => x.backdrop) || all[0] || null, choose);
      } catch (_) {
        if (destroyed || mySeq !== seq) return;
      }
      if (destroyed || mySeq !== seq) return;
      resetRows();
      // FOR YOU row: like-based suggestions sit above the feed (signed-in
      // users with likes only; silent skip otherwise).
      if (global.WP && global.WP.Social && global.WP.Social.getSuggestions) {
        try {
          const sug = await global.WP.Social.getSuggestions();
          if (!destroyed && mySeq === seq && sug.items && sug.items.length) {
            const items = sug.items.map((si) => ({
              id: si.mediaId,
              type: si.mediaType === 'tv' ? 'tv' : 'movie',
              title: si.mediaTitle,
              poster: si.posterUrl,
            }));
            makeSectionRow({ key: 'foryou', title: 'For you' + (sug.seeds && sug.seeds.length ? ' \u00b7 because you liked ' + sug.seeds[0] : '') }, items);
          }
        } catch (_) {}
      }
      for (let i = 0; i < INITIAL_SECTIONS; i++) await createSection(i);
      if (destroyed || mySeq !== seq) return;
      if (!sections.some((s) => s.el)) {
        showError('The catalog could not be reached. Check your connection and try again.');
      }
    }

    // Clear any search, (re)load the feed if needed, then reveal a section by
    // key (used by the side rail). Creates any sections needed along the way.
    async function scrollToSection(key) {
      setInputsValue('');
      const haveSection = mode === 'browse' && sections.some((s) => s.key === key && s.el);
      if (!haveSection) await loadBrowse();
      const idx = sections.findIndex((s) => s.key === key);
      if (idx < 0) return;
      for (let i = 0; i <= idx; i++) {
        if (!sections[i].done && !sections[i].el) await createSection(i);
      }
      for (let attempt = 0; attempt < 40; attempt++) {
        if (destroyed) return;
        const el = sections[idx] && sections[idx].el;
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
        if (sections[idx] && sections[idx].done) return; // no content for this section
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    loadBrowse();
    setupInfiniteScroll();

    return {
      destroy() {
        destroyed = true;
        closePreview();
        if (io) { io.disconnect(); io = null; }
        inputs.forEach((inp) => {
          if (inp) inp.removeEventListener('input', onInput);
        });
        container.innerHTML = '';
        container.classList.remove('browse');
        if (externalInputs) externalInputs.forEach((inp) => { if (inp) inp.value = ''; });
      },
      refresh() {
        loadBrowse();
      },
      scrollToSection,
    };
  }

  // ---- discovery pages (/discovery/:key) ----------------------------------------------
  // One feed section promoted to a full page with vertical infinite scroll.
  // Shares the home feed's row definitions (FEED_DEFS) and card renderer; the
  // worker's /api/tmdb proxy already passes `page` through, so this is a
  // frontend-only feature. Clicks behave exactly like the home feed: movies
  // start a room directly, series/anime open the detail preview first.
  function mountDiscovery(container, opts) {
    opts = opts || {};
    const onSelect = opts.onSelect || function () {};
    const def = FEED_DEFS.find((d) => d.key === DISCOVERY_ROUTES[opts.routeKey]);

    container.classList.add('discovery');
    container.innerHTML = '';

    if (!def) {
      const missing = h('div', 'discovery__missing');
      missing.appendChild(h('h1', 'discovery__title', 'Unknown collection'));
      missing.appendChild(h('p', 'discovery__sub', 'No library page matches \u201C' + opts.routeKey + '\u201D.'));
      const back = /** @type {HTMLAnchorElement} */ (h('a', 'btn btn--ghost btn--sm', '\u2190 Back to browsing'));
      back.href = '/';
      missing.appendChild(back);
      container.appendChild(missing);
      return {
        destroy() {
          container.innerHTML = '';
          container.classList.remove('discovery');
        },
      };
    }

    const head = h('div', 'discovery__head');
    head.appendChild(h('h1', 'discovery__title', def.title));
    head.appendChild(h('p', 'discovery__sub', tr('discovery.sub', 'Keep scrolling \u2014 more titles load automatically.')));
    container.appendChild(head);

    const grid = h('div', 'grid');
    container.appendChild(grid);
    const status = h('div', 'discovery__status');
    container.appendChild(status);
    const sentinel = h('div', 'browse__sentinel');
    container.appendChild(sentinel);

    function choose(item) {
      if (item.type === 'movie') {
        onSelect(buildVideo(item));
      } else {
        openDetail(item, (video) => onSelect(video));
      }
    }

    let page = 0;
    let loading = false;
    let done = false;
    let destroyed = false;
    let seq = 0;

    async function loadMore() {
      if (destroyed || loading || done) return;
      loading = true;
      const mySeq = ++seq;
      status.textContent = tr('feed.loading', 'Loading\u2026');
      try {
        const data = await api(def.path(page + 1));
        if (destroyed || mySeq !== seq) return;
        const items = (data.results || []).map(def.map).filter(Boolean);
        page += 1;
        const totalPages = data.total_pages || 1;
        if (!items.length || page >= totalPages) done = true;
        items.forEach((it) => grid.appendChild(cardNode(it, choose)));
        status.textContent = done && page === 1 && !grid.childElementCount ? 'Nothing here yet.' : '';
      } catch (e) {
        if (destroyed || mySeq !== seq) return;
        done = true;
        status.textContent = 'Could not load more' + (e && e.message ? ' \u2014 ' + e.message : '');
        const retry = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', 'Retry'));
        retry.type = 'button';
        retry.addEventListener('click', () => {
          done = false;
          status.textContent = '';
          void loadMore();
        });
        status.appendChild(retry);
      } finally {
        if (!destroyed && mySeq === seq) loading = false;
      }
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) void loadMore();
      },
      { rootMargin: '600px 0px' } // start loading before the bottom is reached
    );
    io.observe(sentinel);

    void loadMore(); // first page, immediately

    return {
      destroy() {
        destroyed = true;
        io.disconnect();
        container.innerHTML = '';
        container.classList.remove('discovery');
      },
      reload() {
        page = 0;
        done = false;
        grid.innerHTML = '';
        void loadMore();
      },
    };
  }

  /**
   * Room episode switcher: compact modal for the CURRENT video (tv/anime).
   * Season chips + numbered episode grid; the current episode is marked;
   * picking calls onPick(buildVideo(...)) - the room decides apply vs request.
   * @param {{ id: string, type: string, anilistId?: string|null, title?: string, season?: number|null, episode?: number|null }} video
   * @param {(video: ReturnType<typeof buildVideo>) => void} onPick
   */
  function openEpisodes(video, onPick) {
    if (!video || !video.id || video.type === 'movie') return;
    const overlay = h('div', 'modal');
    const card = h('div', 'modal__card detail episodes-modal');
    const head = h('div', 'modal__head');
    head.appendChild(h('h2', 'modal__title', (video.title || 'Series') + ' \u00b7 episodes'));
    const closeBtn = h('button', 'modal__close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    head.appendChild(closeBtn);
    card.appendChild(head);
    const body = h('div', 'detail__body');
    body.style.padding = '16px 20px 20px';
    body.style.overflowY = 'auto';
    body.appendChild(h('div', 'browse__empty', tr('feed.loading', 'Loading\u2026')));
    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const isAnime = video.type === 'anime';
    (async () => {
      try {
        const extra = await api('/tv/' + encodeURIComponent(String(video.id)));
        if (isAnime) {
          // Anime = AniList ABSOLUTE numbering. TMDB splits long anime into
          // many seasons whose episode numbers RESTART at 1 (One Piece
          // "Season 14, E5"), but the anime player plays
          // /anime/<anilistId>/<episode> with that number as the ABSOLUTE
          // episode - so every pick past TMDB season 1 replayed the wrong
          // episode. Render ONE flat absolute grid instead.
          let anilistId = video.anilistId != null ? String(video.anilistId) : null;
          let malId = video.malId != null ? String(video.malId) : null;
          let episodes = 0;
          try {
            const info = await anilistApi(video.id);
            if (info && info.anilistId != null) anilistId = String(info.anilistId);
            if (info && info.malId != null) malId = String(info.malId);
            if (info && info.episodes != null) episodes = Number(info.episodes) || 0;
          } catch (_) {}
          // Ongoing anime often have episodes: null on AniList - use the
          // TMDB total (same source the detail picker falls back to).
          if (!episodes) episodes = Number(extra && extra.number_of_episodes) || 0;
          if (anilistId == null && video.title) {
            try {
              const direct = await anilistDirect(video.title, video.year || '');
              if (direct && direct.id != null) {
                anilistId = String(direct.id);
                if (!episodes) episodes = Number(direct.episodes) || 0;
              }
            } catch (_) {}
          }
          // Last-resort counts BEFORE giving up: AniList total, then the
          // TMDB total. With an AniList id we NEVER fall back to the TMDB
          // season grid (bogus anime seasons = empty/nonsense lists).
          if (anilistId != null && !episodes) {
            try {
              const info = await anilistApi(video.id);
              if (info && info.episodes != null) episodes = Number(info.episodes) || 0;
            } catch (_) {}
          }
          if (anilistId != null && !episodes) {
            episodes = Number(extra && extra.number_of_episodes) || 0;
          }
          if (anilistId != null && episodes > 0) {
            body.innerHTML = '';
            const animePoster = (extra && extra.poster_path ? img(extra.poster_path, 'w154') : '') || video.poster || '';
            const acov = document.createElement('img');
            acov.className = 'episodes-modal__cover';
            acov.alt = '';
            acov.src = animePoster;
            acov.onerror = () => {
              if (acov.src !== animePoster && animePoster) acov.src = animePoster;
              else acov.remove();
            };
            const ameta = h('div', 'episodes-modal__covermeta');
            ameta.appendChild(h('div', 'episodes-modal__show', video.title || 'Series'));
            ameta.appendChild(h('div', 'episodes-modal__season', episodes + ' episodes'));
            const arow = h('div', 'episodes-modal__headrow');
            arow.appendChild(acov);
            ameta && arow.appendChild(ameta);
            body.appendChild(arow);
            body.appendChild(h('p', 'detail__label', 'Episode'));
            const epGrid = h('div', 'detail__episodes');
            body.appendChild(epGrid);
            renderEpisodeGrid(epGrid, {
              count: episodes,
              pick: (n) => {
                // SPREAD the room video: dropping poster/backdrop/overview here
                // is what erased the room cover on every episode switch.
                onPick(buildVideo({ ...video, type: 'anime', isAnime: true, anilistId: anilistId, malId: malId }, { episode: n }));
                close();
              },
              currentEp: Number(video.episode) || 0,
              showId: null,
              season: null,
            });
            return;
          }
          if (isAnime && anilistId != null) {
            // Had an AniList id but no usable count anywhere: say so instead
            // of rendering the broken TMDB season split.
            body.innerHTML = '';
            body.appendChild(
              h('div', 'browse__empty', 'Episode list unavailable right now - try again shortly.')
            );
            return;
          }
          // No AniList match: fall through to the TMDB grid (best effort).
        }
        // Cover art: the show's poster (the season list below falls back to it).
        // DECLARED BEFORE the map: the map callback runs eagerly, so reading a
        // `const` declared further down threw a TDZ ReferenceError whenever a
        // season had no poster of its own — the whole modal then answered
        // "Could not load episodes" for that show.
        const showPoster = (extra && extra.poster_path ? img(extra.poster_path, 'w154') : '') || video.poster || '';
        const usable = ((extra && extra.seasons) || [])
          .filter((s) => s && Number(s.season_number) > 0)
          .map((s) => ({
            season: Number(s.season_number),
            name: s.name || 'Season ' + s.season_number,
            episodes: Number(s.episode_count) || 0,
            poster: (s.poster_path ? img(s.poster_path, 'w154') : '') || showPoster,
          }));
        body.innerHTML = '';
        if (!usable.length) {
          body.appendChild(h('div', 'browse__empty', 'No season data available.'));
          return;
        }
        const curSeason = Number(video.season) || usable[0].season;
        const curEp = Number(video.episode) || 0;
        const seasonChips = h('div', 'detail__seasons');
        const epGrid = h('div', 'detail__episodes');

        // Cover row: the show's art, following the selected season (TMDB
        // ships a poster per season) — the modal no longer looks like a
        // bare numbered list. (`showPoster` is declared above the season map,
        // which falls back to it.)
        const cov = document.createElement('img');
        cov.className = 'episodes-modal__cover';
        cov.alt = '';
        cov.src = showPoster;
        cov.onerror = () => {
          if (cov.src !== showPoster && showPoster) cov.src = showPoster;
          else cov.remove();
        };
        const coverMeta = h('div', 'episodes-modal__covermeta');
        coverMeta.appendChild(h('div', 'episodes-modal__show', video.title || 'Series'));
        const seasonLabel = h('div', 'episodes-modal__season', 'Season ' + curSeason);
        coverMeta.appendChild(seasonLabel);
        const coverRow = h('div', 'episodes-modal__headrow');
        coverRow.appendChild(cov);
        coverRow.appendChild(coverMeta);
        body.appendChild(coverRow);
        body.appendChild(seasonChips);
        body.appendChild(epGrid);

        function renderEpisodes(s) {
          epGrid.innerHTML = '';
          const count = s.episodes || 0;
          renderEpisodeGrid(epGrid, {
            count: count,
            pick: (n) => {
              onPick(buildVideo({ ...video, type: isAnime ? 'anime' : 'tv', isAnime: isAnime, anilistId: video.anilistId }, { season: s.season, episode: n }));
              close();
            },
            currentEp: s.season === curSeason ? curEp : 0,
            showId: video.id,
            season: s.season,
          });
        }

        let active = usable[0];
        usable.forEach((s) => {
          const chip = h('button', 'chip' + (s.season === curSeason ? ' chip--active' : ''), s.name);
          chip.type = 'button';
          chip.dataset.season = String(s.season);
          chip.addEventListener('click', () => {
            active = s;
            seasonChips.querySelectorAll('.chip').forEach((x) => x.classList.remove('chip--active'));
            chip.classList.add('chip--active');
            if (s.poster && cov.parentNode && cov.src !== s.poster) cov.src = s.poster;
            seasonLabel.textContent = 'Season ' + s.season;
            renderEpisodes(s);
          });
          seasonChips.appendChild(chip);
          if (s.season === curSeason) active = s;
        });
        renderEpisodes(active);
      } catch (e) {
        body.innerHTML = '';
        body.appendChild(h('div', 'browse__empty', 'Could not load episodes \u2014 try again.'));
      }
    })();
  }

  global.WP.Catalog = {
    api,
    anilistApi,
    buildVideo,
    watchUrl,
    typeLabel,
    mountBrowse,
    mountDiscovery,
    openDetail,
    openEpisodes,
    fetchRecommendations,
  };
})(window);
