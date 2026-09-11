/* catalog.js — The Movie Database (TMDB) library
 *
 * Browse movies, TV series and anime (hero banner + poster rows + search with
 * filters + a season/episode picker). Data comes from TMDB through the Worker
 * proxy at `/api/tmdb/...`, which injects the server-side API key.
 *
 * Playback still uses the Bingr watch URLs, whose IDs are TMDB IDs, so every
 * title maps 1:1 to a `bingr.one/watch/...` iframe:
 *   movie -> /watch/movie/{tmdbId}
 *   tv    -> /watch/tv/{tmdbId}/{season}/{episode}
 */
(function (global) {
  'use strict';

  const PROXY = '/api/tmdb';
  const BINGR_WATCH = 'https://bingr.one/watch';
  const IMG = 'https://image.tmdb.org/t/p';
  const CACHE_KEY_PREFIX = 'wp:cat:';
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const ANIME_KEYWORD = 210024; // TMDB keyword id for "anime"

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
    return `${BINGR_WATCH}/tv/${item.id}/${opts.season || 1}/${opts.episode || 1}`;
  }

  function buildVideo(item, opts) {
    opts = opts || {};
    return {
      type: item.type === 'movie' ? 'movie' : 'tv',
      id: String(item.id),
      src: watchUrl(item, opts),
      title: item.title || '',
      year: item.year || '',
      poster: item.poster || '',
      backdrop: item.backdrop || '',
      rating: item.rating != null ? item.rating : null,
      overview: item.overview || '',
      season: item.type === 'movie' ? null : opts.season || 1,
      episode: item.type === 'movie' ? null : opts.episode || 1,
    };
  }

  function typeLabel(item) {
    if (item.isAnime) return 'Anime';
    return item.type === 'movie' ? 'Movie' : 'Series';
  }

  function metaText(item) {
    const parts = [];
    if (item.rating) parts.push('★ ' + Number(item.rating).toFixed(1));
    if (item.year) parts.push(String(item.year));
    parts.push(typeLabel(item));
    return parts.join(' · ');
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
    if (item.backdrop) hero.style.backgroundImage = `url("${item.backdrop}")`;

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
          renderDetailBody(body, item, extra, extra.seasons || [], onPick, close);
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
    input.placeholder = 'Search movies & series\u2026';
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
        Object.keys(chipEls).forEach((k) => chipEls[k].classList.toggle('chip--active', k === key));
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

    function matchesFilter(r) {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'movie') return r.type === 'movie';
      if (activeFilter === 'anime') return !!r.isAnime;
      return r.type === 'tv' && !r.isAnime;
    }

    function renderResults() {
      filters.hidden = false;
      heroWrap.style.display = 'none';
      rowsWrap.innerHTML = '';
      const list = results.filter(matchesFilter);
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
          const data = await api('/search/multi?query=' + encodeURIComponent(q) + '&include_adult=false');
          if (destroyed || mySeq !== seq) return;
          results = (data.results || []).map(normAny).filter(Boolean);
          renderResults();
        } catch (e) {
          if (destroyed || mySeq !== seq) return;
          filters.hidden = true;
          rowsWrap.innerHTML = '';
          rowsWrap.appendChild(
            h('div', 'browse__empty', 'Search failed: ' + (e && e.message ? e.message : ''))
          );
        }
      }, 350);
    });

    function renderLoading() {
      heroWrap.innerHTML = '<div class="hero__skeleton"></div>';
      rowsWrap.innerHTML =
        '<div class="row__skeleton"><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div></div>';
    }

    async function loadBrowse() {
      const mySeq = ++seq;
      renderLoading();
      try {
        const [trendingAll, movies, tv, anime] = await Promise.allSettled([
          api('/trending/all/week'),
          api('/movie/popular'),
          api('/tv/popular'),
          api('/discover/tv?with_keywords=' + ANIME_KEYWORD + '&sort_by=popularity.desc'),
        ]);
        if (destroyed || mySeq !== seq) return;

        const all =
          trendingAll.status === 'fulfilled' && trendingAll.value && trendingAll.value.results
            ? trendingAll.value.results.map(normAny).filter(Boolean)
            : [];
        renderHero(heroWrap, all.find((x) => x.backdrop) || all[0] || null, choose);

        rowsWrap.innerHTML = '';
        if (movies.status === 'fulfilled') {
          renderRow(rowsWrap, 'Popular Movies', (movies.value.results || []).map(normMovie).slice(0, 18), choose);
        }
        if (tv.status === 'fulfilled') {
          renderRow(rowsWrap, 'Popular TV Shows', (tv.value.results || []).map((t) => normTv(t, false)).slice(0, 18), choose);
        }
        if (anime.status === 'fulfilled') {
          renderRow(rowsWrap, 'Popular Anime', (anime.value.results || []).map((t) => normTv(t, true)).slice(0, 18), choose);
        }
        if (all.length) {
          renderRow(rowsWrap, 'Trending Now', all.slice(0, 18), choose);
        }

        const anyFailed = [trendingAll, movies, tv, anime].some((r) => r.status === 'rejected');
        if (anyFailed && !rowsWrap.querySelector('.row')) {
          showError('Some sections failed to load.');
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
