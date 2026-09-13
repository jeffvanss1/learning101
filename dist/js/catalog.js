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

  const PROXY = '/api/tmdb';
  const BINGR_WATCH = 'https://bingr.one/watch';
  const IMG = 'https://image.tmdb.org/t/p';
  const CACHE_KEY_PREFIX = 'wp:cat:';
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const ANIME_KEYWORD = 210024; // TMDB keyword id for "anime"
  const ANILIST_CACHE_PREFIX = 'wp:anilist:';
  const ANILIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
        if (Date.now() - o.ts < ANILIST_CACHE_TTL_MS) return o.data;
      }
    } catch (_) {}
    const res = await fetch('/api/anilist/' + encodeURIComponent(tmdbId), {
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
    await Promise.all(
      tvs.map(async (r) => {
        r._animeChecked = true;
        try {
          const info = await anilistApi(r.id);
          r.isAnime = !!info.anime;
          r.anilistId = info.anilistId != null ? info.anilistId : null;
        } catch (_) {
          r.isAnime = false;
        }
      })
    );
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
        if (Date.now() - o.ts < ANILIST_CACHE_TTL_MS) return o.data || null;
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
    return 'https://www.youtube.com/embed/' + encodeURIComponent(key) +
      '?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&playsinline=1';
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
          media.innerHTML = '';
          const iframe = document.createElement('iframe');
          iframe.src = trailerEmbed(key);
          iframe.title = item.title || 'Trailer';
          iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
          iframe.setAttribute('allowfullscreen', '');
          media.appendChild(iframe);
        });
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
    const watch = h('button', 'btn btn--primary', 'Watch together');
    watch.addEventListener('click', () => onSelect(item));
    actions.appendChild(watch);
    const details = h('button', 'btn btn--ghost', 'Details');
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
    body.appendChild(h('div', 'browse__empty', 'Loading\u2026'));
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
          // (public, keyless GraphQL API). Anime never falls back to /watch/tv/.
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
              renderAnimeBody(body, item, extra, { episodes }, onPick, close);
            } else {
              renderAnimeUnresolved(body, item, extra);
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
    const poster = document.createElement('img');
    poster.className = 'detail__poster';
    poster.alt = '';
    poster.src = (extra && extra.poster_path ? img(extra.poster_path, 'w500') : '') || item.poster || '';
    poster.onerror = () => poster.remove();
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
      const play = h('button', 'btn btn--primary', 'Watch together');
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
      .map((s) => ({ season: Number(s.season_number), name: s.name || `Season ${s.season_number}`, episodes: Number(s.episode_count) || 0 }));

    const section = h('div', 'detail__section');
    section.appendChild(h('p', 'detail__label', 'Season'));
    const seasonChips = h('div', 'detail__seasons');
    const epLabel = h('p', 'detail__label', 'Episode');
    const epGrid = h('div', 'detail__episodes');
    section.appendChild(seasonChips);
    section.appendChild(epLabel);
    section.appendChild(epGrid);
    body.appendChild(section);

    function renderSeason(s, autoFirst) {
      seasonChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip--active'));
      seasonChips.querySelectorAll('.chip').forEach((c) => {
        if (Number(c.dataset.season) === s.season) c.classList.add('chip--active');
      });
      renderEpisodes(s, autoFirst);
    }

    function renderEpisodes(s, autoFirst) {
      epGrid.innerHTML = '';
      const count = s.episodes || 0;

      if (count > 120) {
        // Very long shows: use a numeric input instead of 100+ buttons.
        const wrap = h('div', 'detail__actions');
        const num = h('input', 'field__input');
        num.type = 'number';
        num.min = '1';
        num.max = String(count);
        num.value = '1';
        num.style.width = '120px';
        const go = h('button', 'btn btn--primary', 'Play episode');
        go.addEventListener('click', () => {
          let n = Math.max(1, Math.min(count, Math.floor(Number(num.value) || 1)));
          onPick(buildVideo(item, { season: s.season, episode: n }));
          close();
        });
        wrap.appendChild(num);
        wrap.appendChild(go);
        epGrid.appendChild(wrap);
        return;
      }

      if (count) {
        for (let n = 1; n <= count; n++) {
          const b = h('button', 'ep-btn', String(n));
          b.type = 'button';
          b.addEventListener('click', () => {
            onPick(buildVideo(item, { season: s.season, episode: n }));
            close();
          });
          epGrid.appendChild(b);
        }
      } else {
        epGrid.appendChild(h('div', 'browse__empty', 'No episode data.'));
      }

      // Enrich with episode names when available.
      if (autoFirst !== false) {
        api('/tv/' + encodeURIComponent(item.id) + '/season/' + s.season)
          .then((data) => {
            if (!data || !data.episodes) return;
            const byNum = new Map(data.episodes.map((e) => [e.episode_number, e]));
            epGrid.querySelectorAll('.ep-btn').forEach((b) => {
              const ep = byNum.get(Number(b.textContent));
              if (ep && ep.name) b.title = ep.name;
            });
          })
          .catch(() => {});
      }
    }

    if (!usable.length) {
      epGrid.appendChild(h('div', 'browse__empty', 'No season data available.'));
      return;
    }

    usable.forEach((s, i) => {
      const chip = h('button', 'chip' + (i === 0 ? ' chip--active' : ''), s.name || `Season ${s.season}`);
      chip.type = 'button';
      chip.dataset.season = String(s.season);
      chip.addEventListener('click', () => renderSeason(s, false));
      seasonChips.appendChild(chip);
    });
    renderEpisodes(usable[0], true);
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

    if (count > 120) {
      const wrap = h('div', 'detail__actions');
      const num = h('input', 'field__input');
      num.type = 'number';
      num.min = '1';
      num.max = String(count);
      num.value = '1';
      num.style.width = '120px';
      const go = h('button', 'btn btn--primary', 'Play episode');
      go.type = 'button';
      go.addEventListener('click', () => {
        pick(Math.max(1, Math.min(count, Math.floor(Number(num.value) || 1))));
      });
      wrap.appendChild(num);
      wrap.appendChild(go);
      epGrid.appendChild(wrap);
    } else {
      for (let n = 1; n <= count; n++) {
        const b = h('button', 'ep-btn', String(n));
        b.type = 'button';
        b.addEventListener('click', () => pick(n));
        epGrid.appendChild(b);
      }
    }
    section.appendChild(epGrid);
    body.appendChild(section);
  }

  // Detected as anime, but AniList lookup failed to yield an ID.
  function renderAnimeUnresolved(body, item, extra) {
    body.innerHTML = '';
    const title = (extra && (extra.name || extra.title)) || item.title || 'This title';
    body.appendChild(h('div', 'detail__title', title));
    body.appendChild(
      h(
        'div',
        'browse__empty',
        "This looks like anime, but we couldn't match it on AniList, so it can't be played through the anime player yet."
      )
    );
  }

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
    // The home feed is an ordered list of sections. New sections appear as you
    // scroll toward the bottom (vertical infinite scroll); each section is a
    // horizontal row that also deepens page by page. Sections are addressable
    // by `key` so the side rail can jump straight to them.
    const ROW_DEFS = [
      { key: 'movie', title: 'Popular Movies', path: (p) => `/movie/popular?page=${p}`, map: normMovie },
      { key: 'tv', title: 'Popular TV Shows', path: (p) => `/tv/popular?page=${p}`, map: (t) => normTv(t, false) },
      { key: 'anime', title: 'Popular Anime', path: (p) => `/discover/tv?with_keywords=${ANIME_KEYWORD}&sort_by=popularity.desc&page=${p}`, map: (t) => normTv(t, true) },
      { key: 'trending', title: 'Trending Now', path: (p) => `/trending/all/week?page=${p}`, map: normAny },
      { key: 'topMovies', title: 'Top Rated Movies', path: (p) => `/movie/top_rated?page=${p}`, map: normMovie },
      { key: 'topTv', title: 'Top Rated Series', path: (p) => `/tv/top_rated?page=${p}`, map: (t) => normTv(t, false) },
      { key: 'nowPlaying', title: 'In Theaters', path: (p) => `/movie/now_playing?page=${p}`, map: normMovie },
      { key: 'airingToday', title: 'Airing Today', path: (p) => `/tv/airing_today?page=${p}`, map: (t) => normTv(t, false) },
    ];
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
      sections = ROW_DEFS.map((d) => ({
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
        gridEl.appendChild(h('div', 'browse__empty', 'No results \u2014 try another title.'));
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

  global.WP.Catalog = {
    api,
    anilistApi,
    buildVideo,
    watchUrl,
    typeLabel,
    mountBrowse,
    openDetail,
    fetchRecommendations,
  };
})(window);
