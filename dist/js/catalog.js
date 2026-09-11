/* catalog.js — Bingr library (browse + search + detail picker)
 *
 * Talks to the Bingr catalog API through the Worker proxy at `/api/bingr/...`
 * (which forwards to https://api.bingr.one). Renders a YouTube-style browse
 * surface: hero banner, horizontal rows of posters, live search with type
 * filters, and a detail modal with a season/episode picker for series & anime.
 */
(function (global) {
  'use strict';

  const PROXY = '/api/bingr';
  const DIRECT = 'https://api.bingr.one';
  const BINGR_WATCH = 'https://bingr.one/watch';
  const CACHE_KEY_PREFIX = 'wp:cat:';
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  // ---- tiny DOM helpers ------------------------------------------------------
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
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

  async function fetchJson(base, path) {
    const res = await fetch(base + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Try the Worker proxy first (CORS-safe), then the API directly, then a
  // cached copy. Cache every success so a later outage never blanks the home.
  async function api(path) {
    const errors = [];
    for (const base of [PROXY, DIRECT]) {
      try {
        const data = await fetchJson(base, path);
        cacheSet(path, data);
        return data;
      } catch (e) {
        errors.push(base + ' \u2192 ' + e.message);
      }
    }
    const cached = cacheGet(path);
    if (cached) return cached;
    throw new Error(errors.join(' | ') || 'unreachable');
  }

  // ---- video model --------------------------------------------------------------
  function watchUrl(item, opts) {
    opts = opts || {};
    if (item.type === 'movie') return `${BINGR_WATCH}/movie/${item.id}`;
    if (item.type === 'tv') {
      return `${BINGR_WATCH}/tv/${item.id}/${opts.season || 1}/${opts.episode || 1}`;
    }
    if (item.type === 'anime') {
      return `${BINGR_WATCH}/anime/${item.id}/${opts.episode || 1}`;
    }
    return item.src || '';
  }

  function buildVideo(item, opts) {
    opts = opts || {};
    return {
      type: item.type,
      id: String(item.id),
      src: watchUrl(item, opts),
      title: item.title || '',
      year: item.year || '',
      poster: item.poster || '',
      backdrop: item.backdrop || '',
      rating: item.rating != null ? item.rating : null,
      overview: item.overview || '',
      season: opts.season || null,
      episode: opts.episode || null,
    };
  }

  function typeLabel(t) {
    if (t === 'movie') return 'Movie';
    if (t === 'tv') return 'Series';
    if (t === 'anime') return 'Anime';
    return 'Video';
  }

  function metaText(item) {
    const parts = [];
    if (item.rating) parts.push('★ ' + Number(item.rating).toFixed(1));
    if (item.year) parts.push(String(item.year));
    parts.push(typeLabel(item.type));
    return parts.join(' · ');
  }

  // ---- cards ---------------------------------------------------------------------
  function cardNode(item, onClick) {
    const card = h('div', 'card-item');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const poster = h('div', 'card-item__poster');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = item.title || '';
    img.src = item.poster || '';
    img.onerror = () => {
      img.remove();
      poster.appendChild(
        h('div', 'card-item__poster-fallback', (item.title || '?').slice(0, 1).toUpperCase())
      );
    };
    poster.appendChild(img);
    poster.appendChild(h('span', 'card-item__badge', typeLabel(item.type)));

    const body = h('div', 'card-item__body');
    body.appendChild(h('div', 'card-item__title', item.title));
    body.appendChild(h('div', 'card-item__meta', metaText(item)));

    card.appendChild(poster);
    card.appendChild(body);

    const activate = () => onClick(item);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    return card;
  }

  function renderRow(container, title, items, onSelect) {
    if (!items || !items.length) return;
    const sec = h('section', 'row');
    sec.appendChild(h('h2', 'row__title', title));
    const scroller = h('div', 'row__scroller');
    items.forEach((it) => scroller.appendChild(cardNode(it, onSelect)));
    sec.appendChild(scroller);
    container.appendChild(sec);
  }

  function renderHero(container, item, onSelect) {
    container.innerHTML = '';
    if (!item) {
      container.appendChild(h('div', 'hero__skeleton'));
      return;
    }
    const hero = h('div', 'hero');
    const bg = item.backdrop || item.poster || '';
    if (bg) hero.style.backgroundImage = `url("${bg}")`;

    const content = h('div', 'hero__content');
    content.appendChild(h('span', 'hero__badge', typeLabel(item.type)));
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
      let extra = null;
      let seasons = [];
      try {
        if (item.type === 'movie') {
          extra = await api('/details/movie/' + encodeURIComponent(item.id));
        } else if (item.type === 'tv') {
          extra = await api('/details/tv/' + encodeURIComponent(item.id));
          seasons = (extra && extra.seasons) || [];
        } else if (item.type === 'anime') {
          extra = await api('/anime/' + encodeURIComponent(item.id));
          seasons = (extra && extra.seasons) || [];
        }
      } catch (_) {
        extra = null;
      }
      renderDetailBody(body, item, extra, seasons, onPick, close);
    })();
  }

  function renderDetailBody(body, item, extra, seasons, onPick, close) {
    body.innerHTML = '';

    const top = h('div', 'detail__top');
    const poster = document.createElement('img');
    poster.className = 'detail__poster';
    poster.alt = '';
    poster.src = (extra && extra.poster) || item.poster || '';
    poster.onerror = () => poster.remove();
    top.appendChild(poster);

    const info = h('div', 'detail__info');
    info.appendChild(h('div', 'detail__title', (extra && extra.title) || item.title));
    const metaParts = [];
    if ((extra && extra.rating) || item.rating) metaParts.push('★ ' + Number((extra && extra.rating) || item.rating).toFixed(1));
    if ((extra && extra.year) || item.year) metaParts.push(String((extra && extra.year) || item.year));
    if (extra && extra.runtime) metaParts.push(extra.runtime + ' min');
    if (extra && extra.certification) metaParts.push(extra.certification);
    metaParts.push(typeLabel(item.type));
    info.appendChild(h('div', 'detail__meta', metaParts.join(' · ')));

    const overview = (extra && extra.overview) || item.overview || '';
    if (overview) info.appendChild(h('p', 'detail__overview', overview));
    top.appendChild(info);
    body.appendChild(top);

    // Movies play directly; series/anime need an episode choice.
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

    // Normalize seasons.
    let list = Array.isArray(seasons) ? seasons.filter((s) => s && s.episodes) : [];
    if (!list.length) {
      const total = (item.type === 'anime' && item.episodes) || (extra && extra.episodes) || 1;
      list = [{ season: 1, name: 'Season 1', episodes: total }];
    }

    const section = h('div', 'detail__section');
    section.appendChild(h('p', 'detail__label', 'Season'));
    const seasonChips = h('div', 'detail__seasons');
    const epLabel = h('p', 'detail__label', 'Episode');
    const epGrid = h('div', 'detail__episodes');
    section.appendChild(seasonChips);
    section.appendChild(epLabel);
    section.appendChild(epGrid);
    body.appendChild(section);

    function selectSeason(s) {
      seasonChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip--active'));
      seasonChips.querySelectorAll('.chip').forEach((c) => {
        if (Number(c.dataset.season) === Number(s.season)) c.classList.add('chip--active');
      });
      renderEpisodes(s);
    }

    function renderEpisodes(s) {
      epGrid.innerHTML = '';
      const count = Number(s.episodes) || 0;
      if (!count) {
        epGrid.appendChild(h('div', 'browse__empty', 'No episode data.'));
        return;
      }
      if (count > 120) {
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
      for (let n = 1; n <= count; n++) {
        const b = h('button', 'ep-btn', String(n));
        b.type = 'button';
        b.addEventListener('click', () => {
          onPick(
            buildVideo(item, {
              season: item.type === 'tv' ? s.season : null,
              episode: n,
            })
          );
          close();
        });
        epGrid.appendChild(b);
      }
    }

    list.forEach((s, i) => {
      const chip = h('button', 'chip' + (i === 0 ? ' chip--active' : ''), s.name || `Season ${s.season}`);
      chip.type = 'button';
      chip.dataset.season = String(s.season);
      chip.addEventListener('click', () => selectSeason(s));
      seasonChips.appendChild(chip);
    });
    renderEpisodes(list[0]);
  }

  // ---- browse surface -----------------------------------------------------------------
  function mountBrowse(container, opts) {
    opts = opts || {};
    const onSelect = opts.onSelect || function () {};

    container.classList.add('browse');
    container.innerHTML = '';

    // Search bar + filters
    const search = h('div', 'browse__search');
    const input = h('input', 'browse__search-input');
    input.type = 'text';
    input.placeholder = 'Search movies, series & anime\u2026';
    input.autocomplete = 'off';
    search.appendChild(input);

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
      c.addEventListener('click', () => {
        activeFilter = key;
        Object.keys(chipEls).forEach((k) =>
          chipEls[k].classList.toggle('chip--active', k === key)
        );
        renderResults();
      });
      chipEls[key] = c;
      filters.appendChild(c);
    });
    search.appendChild(filters);
    container.appendChild(search);

    const heroWrap = h('div', 'browse__hero');
    const rowsWrap = h('div', 'browse__rows');
    container.appendChild(heroWrap);
    container.appendChild(rowsWrap);

    let searchTimer = null;
    let results = [];
    let destroyed = false;
    let seq = 0;

    function choose(item) {
      if (item.type === 'movie') {
        onSelect(buildVideo(item));
      } else {
        openDetail(item, (video) => onSelect(video));
      }
    }

    function renderResults() {
      filters.hidden = false;
      heroWrap.style.display = 'none';
      rowsWrap.innerHTML = '';
      let list = results;
      if (activeFilter !== 'all') list = list.filter((r) => r.type === activeFilter);
      const grid = h('div', 'grid');
      if (!list.length) {
        grid.appendChild(h('div', 'browse__empty', 'No results \u2014 try another title.'));
      } else {
        list.slice(0, 60).forEach((it) => grid.appendChild(cardNode(it, choose)));
      }
      rowsWrap.appendChild(grid);
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

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(searchTimer);
      if (!q) {
        seq++;
        results = [];
        filters.hidden = true;
        heroWrap.style.display = '';
        rowsWrap.innerHTML = '';
        loadBrowse();
        return;
      }
      searchTimer = setTimeout(async () => {
        const mySeq = ++seq;
        rowsWrap.innerHTML = '';
        const grid = h('div', 'grid');
        grid.appendChild(h('div', 'browse__empty', 'Searching\u2026'));
        rowsWrap.appendChild(grid);
        filters.hidden = true;
        try {
          const [a, b] = await Promise.allSettled([
            api('/search?q=' + encodeURIComponent(q)),
            api('/anime/search?q=' + encodeURIComponent(q)),
          ]);
          if (destroyed || mySeq !== seq) return;
          results = [];
          if (a.status === 'fulfilled' && a.value && a.value.results) results.push(...a.value.results);
          if (b.status === 'fulfilled' && b.value && b.value.results) results.push(...b.value.results);
          renderResults();
        } catch (_) {
          if (destroyed || mySeq !== seq) return;
          filters.hidden = true;
          rowsWrap.innerHTML = '';
          rowsWrap.appendChild(h('div', 'browse__empty', 'Search failed \u2014 please try again.'));
        }
      }, 350);
    });

    function renderLoading() {
      heroWrap.innerHTML = '<div class="hero__skeleton"></div>';
      rowsWrap.innerHTML = '<div class="row__skeleton"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div>';
    }

    async function loadBrowse() {
      const mySeq = ++seq;
      renderLoading();
      try {
        const [trending, movies, tv, anime] = await Promise.allSettled([
          api('/trending/all'),
          api('/trending/movie'),
          api('/trending/tv'),
          api('/anime/discover?sort=TRENDING_DESC'),
        ]);
        if (destroyed || mySeq !== seq) return;

        const all =
          trending.status === 'fulfilled' && trending.value && trending.value.results
            ? trending.value.results
            : [];
        const heroItem = all.find((x) => x.backdrop) || all[0] || null;
        renderHero(heroWrap, heroItem, choose);

        rowsWrap.innerHTML = '';
        if (movies.status === 'fulfilled') {
          renderRow(rowsWrap, 'Trending Movies', (movies.value.results || []).slice(0, 18), choose);
        }
        if (tv.status === 'fulfilled') {
          renderRow(rowsWrap, 'Popular TV Shows', (tv.value.results || []).slice(0, 18), choose);
        }
        if (anime.status === 'fulfilled') {
          renderRow(rowsWrap, 'Popular Anime', (anime.value.results || []).slice(0, 18), choose);
        }
        if (all.length) {
          renderRow(rowsWrap, 'Trending Now', all.slice(0, 18), choose);
        }
      } catch (e) {
        if (destroyed || mySeq !== seq) return;
        showError(e && e.message ? e.message : null);
      }
    }

    loadBrowse();

    return {
      destroy() {
        destroyed = true;
        container.innerHTML = '';
        container.classList.remove('browse');
      },
      refresh() {
        loadBrowse();
      },
    };
  }

  global.WP.Catalog = {
    api,
    buildVideo,
    watchUrl,
    typeLabel,
    mountBrowse,
    openDetail,
  };
})(window);
