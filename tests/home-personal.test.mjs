// BEHAVIORAL: the tailored home page (category pills + "watched the most").
//
// The shipped dist/js/catalog.js is EXECUTED here against a stub DOM, so the
// pill filtering, the taste ordering and the history rows are proven by RUNNING
// them — not by grepping for class names:
//   * the pills above the feed filter which ROWS are shown, in place;
//   * the feed leads with the type the viewer watches the most;
//   * "Continue watching" comes from the resume positions in wp:history;
//   * "Because you watched X" is seeded by the most-watched title and never
//     recommends something already in the history;
//   * an untailored mount (the room's video picker) and a viewer with no
//     history both get exactly the feed we shipped before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal DOM element: children, classes, inline style + the props we use. */
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag || 'div').toLowerCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.tabIndex = 0;
    this.parentNode = null;
    this.value = '';
    this.attrs = {};
    this.__handlers = {};
    this.clientWidth = 0;
    this.scrollWidth = 0;
    this.scrollLeft = 0;
    const cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !cls.has(c) : !!force;
        if (on) cls.add(c);
        else cls.delete(c);
        return on;
      },
      contains: (c) => cls.has(c),
    };
    // className and classList are two views of ONE list, exactly like the DOM
    // (the shipped code sets one and reads the other).
    Object.defineProperty(this, 'className', {
      get: () => [...cls].join(' '),
      set: (v) =>
        String(v || '')
          .split(/\s+/)
          .filter(Boolean)
          .forEach((x) => cls.add(x)),
    });
  }
  set innerHTML(_v) {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
  }
  get innerHTML() {
    return '';
  }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.removeChild(c);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(c);
    else this.children.splice(at, 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.__handlers[type] = this.__handlers[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.__handlers[type] || [];
    this.__handlers[type] = list.filter((x) => x !== fn);
  }
  scrollIntoView() {}
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const want = String(sel).replace(/^\./, '');
    const out = [];
    const walk = (el) => {
      (el.children || []).forEach((c) => {
        if (String(c.className).split(/\s+/).includes(want)) out.push(c);
        walk(c);
      });
    };
    walk(this);
    return out;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === doc.body || n === doc;
  }
}

const store = {};
const doc = {
  createElement: (tag) => new FakeEl(tag),
  createElementNS: (_ns, tag) => new FakeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text), parentNode: null }),
  createDocumentFragment: () => new FakeEl('#fragment'),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: new FakeEl('html'),
  addEventListener() {},
  removeEventListener() {},
  readyState: 'complete',
  hidden: false,
};
doc.body = new FakeEl('body');

globalThis.document = doc;
globalThis.location = { search: '', pathname: '/', href: 'http://localhost/' };
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => {
    store[k] = String(v);
  },
  removeItem: (k) => {
    delete store[k];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
};
globalThis.window = {
  WP: {},
  document: doc,
  location: globalThis.location,
  localStorage: globalThis.localStorage,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};
globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });

// The bundles are IIFEs bound to the FIRST window they see: stubs first, then
// one import each (subsequent tests only swap the fetch implementation).
await import(join(ROOT, 'dist/js/utils.js'));
await import(join(ROOT, 'dist/js/api.js'));
await import(join(ROOT, 'dist/js/catalog.js'));

const WP = globalThis.window.WP;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixtures --------------------------------------------------------------
function movie(id, title) {
  return {
    id,
    media_type: 'movie',
    title,
    release_date: '2020-01-01',
    poster_path: '/p' + id + '.jpg',
    backdrop_path: '/b' + id + '.jpg',
    vote_average: 7.1,
    overview: '',
  };
}
function tv(id, title) {
  return {
    id,
    media_type: 'tv',
    name: title,
    first_air_date: '2019-01-01',
    poster_path: '/p' + id + '.jpg',
    backdrop_path: '/b' + id + '.jpg',
    vote_average: 8.0,
    overview: '',
  };
}

/** wp:history of a viewer who binges series, then anime, then the odd movie. */
function bingeHistory() {
  const rows = [];
  for (let e = 1; e <= 5; e++) {
    rows.push({
      type: 'tv',
      id: '100',
      src: 'https://bingr.one/watch/tv/100/1/' + e,
      title: 'Heavy Show',
      year: '2019',
      poster: 'https://img/100.jpg',
      season: 1,
      episode: e,
      malId: null,
      rating: 8.2,
      // Episode 5 is the one left unfinished.
      watchedAt: 1000 + e,
      position: e === 5 ? 1200 : 3000,
      duration: 2400,
    });
  }
  for (let e = 1; e <= 3; e++) {
    rows.push({
      type: 'anime',
      id: '200',
      src: 'https://bingr.one/watch/anime/200/' + e,
      title: 'Anime Thing',
      year: '2021',
      poster: 'https://img/200.jpg',
      season: null,
      episode: e,
      malId: '700',
      rating: 8.8,
      watchedAt: 500 + e,
    });
  }
  rows.push({
    type: 'movie',
    id: '300',
    src: 'https://bingr.one/watch/movie/300',
    title: 'Some Movie',
    year: '2018',
    poster: 'https://img/300.jpg',
    season: null,
    episode: null,
    malId: null,
    rating: 7.0,
    watchedAt: 400,
  });
  return rows;
}

const CATALOG = [
  ['/trending/all/week', { results: [movie(900, 'Trending Flick'), tv(901, 'Trending Show')], page: 1, total_pages: 3 }],
  ['/movie/popular', { results: [movie(11, 'Pop Movie A'), movie(12, 'Pop Movie B')], page: 1, total_pages: 5 }],
  ['/tv/popular', { results: [tv(21, 'Pop Show A'), tv(22, 'Pop Show B')], page: 1, total_pages: 5 }],
  ['/discover/tv?with_keywords', { results: [tv(31, 'Anime A'), tv(32, 'Anime B')], page: 1, total_pages: 5 }],
  ['/movie/top_rated', { results: [movie(41, 'Rated Movie')], page: 1, total_pages: 5 }],
  ['/tv/top_rated', { results: [tv(51, 'Rated Show')], page: 1, total_pages: 5 }],
  ['/movie/now_playing', { results: [movie(61, 'In Theaters')], page: 1, total_pages: 5 }],
  ['/tv/airing_today', { results: [tv(71, 'Airing Today')], page: 1, total_pages: 5 }],
  [
    '/tv/100/recommendations',
    {
      // 100 is the seed itself — a recommendation must never be something the
      // viewer already watched.
      results: [tv(100, 'Heavy Show'), tv(101, 'Next Show'), tv(102, 'Other Show')],
      page: 1,
      total_pages: 1,
    },
  ],
  ['/search/multi', { results: [movie(11, 'Pop Movie A'), tv(21, 'Pop Show A')], page: 1, total_pages: 1 }],
];

function useCatalog() {
  globalThis.fetch = (url) => {
    const u = String(url);
    const hit = CATALOG.find(([needle]) => u.includes(needle));
    const body = hit ? hit[1] : u.includes('/api/health') ? { build: 'test' } : { results: [], page: 1, total_pages: 1 };
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  };
}

/** Mount the feed with the given options and let the first chunks settle. */
async function mount(opts = {}, history = bingeHistory()) {
  store && Object.keys(store).forEach((k) => delete store[k]);
  if (history) localStorage.setItem('wp:history', JSON.stringify(history));
  useCatalog();
  doc.body = new FakeEl('body');
  const container = new FakeEl('div');
  doc.body.appendChild(container);
  if (opts.withSearchInput) {
    opts.searchInputs = [new FakeEl('input')];
  }
  const handle = WP.Catalog.mountBrowse(container, opts);
  await tick(80); // hero + rows
  return { container, handle, input: opts.searchInputs && opts.searchInputs[0] };
}

/** Every row element, in DOM order. */
function rows(container) {
  const out = [];
  const walk = (el) => {
    (el.children || []).forEach((c) => {
      const cls = String(c.className).split(/\s+/);
      if (cls.includes('row')) {
        const title = (c.querySelector('.row__title') || {}).textContent || '';
        out.push({ key: c.dataset.row, title, display: c.style.display, hidden: c.style.display === 'none', el: c });
      }
      walk(c);
    });
  };
  walk(container);
  return out;
}

const visibleKeys = (container) => rows(container).filter((r) => !r.hidden).map((r) => r.key);
const pills = (container) =>
  [...container.querySelectorAll('.chip')].map((c) => ({
    label: c.textContent,
    active: c.classList.contains('chip--active'),
    el: c,
  }));

/** Fire an element's click handlers and await the handler(s). */
function click(el) {
  const handlers = (el.__handlers && el.__handlers.click) || [];
  return Promise.all(handlers.map((fn) => fn({ target: el })));
}

test('the tailored home leads with the type watched the most, then continue + because rows', async () => {
  const { container, handle } = await mount({ tailored: true, withSearchInput: true });
  const list = rows(container);

  // Taste: 5 series rows → series leads the feed. Trending rides beside them.
  assert.deepEqual(
    list.map((r) => r.key),
    ['continue', 'because', 'tv', 'topTv', 'airingToday', 'trending'],
    'tailored rows first, then the dominant type, then the rest'
  );
  assert.equal(list[0].title, 'Continue watching');
  assert.equal(list[1].title, 'Because you watched Heavy Show');

  // The billboard picks from the trending pool by the dominant taste (series).
  const heroTitle = (container.querySelector('.hero__title') || {}).textContent;
  assert.equal(heroTitle, 'Trending Show', 'hero follows the dominant type');

  // Continue watching: the unfinished episode, its progress and its label.
  const resumeCards = list[0].el.querySelectorAll('.card-item');
  assert.equal(resumeCards.length, 1, 'only the unfinished title is resumable');
  assert.equal(resumeCards[0].querySelector('.card-item__title').textContent, 'Heavy Show');
  assert.equal(resumeCards[0].querySelector('.card-item__resume').textContent, 'S1 E5');
  assert.equal(
    resumeCards[0].querySelector('.card-item__progress-fill').style.width,
    '50%',
    '1200s of 2400s'
  );

  // Recommendations: the seed itself (already watched) is filtered out.
  const recTitles = list[1].el
    .querySelectorAll('.card-item__title')
    .map((t) => t.textContent);
  assert.deepEqual(recTitles, ['Next Show', 'Other Show']);

  handle.destroy();
});

test('category pills filter the feed in place and load the rows they uncover', async () => {
  const { container, handle } = await mount({ tailored: true, withSearchInput: true });

  assert.deepEqual(
    pills(container).map((p) => p.label),
    ['All', 'Movies', 'Series', 'Anime', 'Trending Now'],
    'the full category bar is visible on the home feed'
  );
  assert.equal(pills(container)[0].active, true, 'All starts active');

  // Movies: the feed had no movie row loaded yet (it sits behind the series
  // rows in the taste order) — the pill pulls the chunks it needs.
  await click(pills(container).find((p) => p.label === 'Movies').el);
  await tick(40);
  assert.deepEqual(
    visibleKeys(container),
    ['movie', 'topMovies'],
    'only movie rows stay, in feed order'
  );
  assert.equal(
    rows(container).filter((r) => r.key === 'continue')[0].hidden,
    true,
    'tailored rows live under the All pill'
  );
  assert.equal(pills(container).find((p) => p.label === 'Movies').active, true);

  // Back to All: everything that is loaded is on screen again.
  await click(pills(container).find((p) => p.label === 'All').el);
  await tick(40);
  assert.deepEqual(visibleKeys(container), [
    'continue',
    'because',
    'tv',
    'topTv',
    'airingToday',
    'trending',
    'movie',
    'topMovies',
  ]);

  // Trending: one row, everything else hidden.
  await click(pills(container).find((p) => p.label === 'Trending Now').el);
  await tick(40);
  assert.deepEqual(visibleKeys(container), ['trending']);

  handle.destroy();
});

test('search swaps the same chip row back to the type filters', async () => {
  const { container, handle, input } = await mount({ tailored: true, withSearchInput: true });
  assert.ok(input, 'the mount got its search input');

  input.value = 'pop';
  (input.__handlers.input || []).forEach((fn) => fn({ target: input }));
  await tick(450); // mountBrowse debounces typing by 350ms

  assert.deepEqual(
    pills(container).map((p) => p.label),
    ['All', 'Movies', 'Series', 'Anime'],
    'search context shows the type filters'
  );
  assert.equal(
    container.querySelectorAll('.card-item').length,
    2,
    'the result grid rendered'
  );
  await click(pills(container).find((p) => p.label === 'Series').el);
  await tick(20);
  assert.equal(container.querySelectorAll('.card-item').length, 1, 'filtered to the series result');

  handle.destroy();
});

test('a viewer with no history gets the plain feed (and no empty tailored rows)', async () => {
  const { container, handle } = await mount({ tailored: true, withSearchInput: true }, []);
  assert.deepEqual(
    rows(container).map((r) => r.key),
    ['movie', 'tv', 'anime', 'trending'],
    'FEED_DEFS order, no taste to apply'
  );
  assert.deepEqual(
    pills(container).map((p) => p.label),
    ['All', 'Movies', 'Series', 'Anime', 'Trending Now'],
    'the category bar is still there'
  );
  handle.destroy();
});

test('an untailored mount (the room video picker) is untouched', async () => {
  const { container, handle } = await mount({}, bingeHistory());
  assert.deepEqual(
    rows(container).map((r) => r.key),
    ['movie', 'tv', 'anime', 'trending'],
    'no tailored rows'
  );
  assert.equal(
    container.querySelectorAll('.chip').length,
    0,
    'no chips in browse mode (they only appear for a search)'
  );
  handle.destroy();
});
