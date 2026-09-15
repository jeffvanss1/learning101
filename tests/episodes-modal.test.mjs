// Runtime regression: the room's episode switcher (WP.Catalog.openEpisodes).
//
// The season list is built with `.map(...)` that falls back to the show's own
// poster (`|| showPoster`) when a season has no poster of its own. `showPoster`
// used to be declared BELOW that map, and because the map callback runs
// eagerly the `const` was still in its temporal dead zone — a ReferenceError
// swallowed by the modal's catch, so every series whose TMDB payload contains a
// season without `poster_path` answered "Could not load episodes — try again."
// (`s.poster_path` truthy short-circuited the `||`, which is why the failure
// only showed up for *some* shows and stayed invisible to static checks.)
//
// This test EXECUTES the shipped dist/js/catalog.js against a minimal DOM stub
// and asserts the modal renders its season grid in both cases.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal DOM element: children + class list + the handful of props used. */
class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.className = '';
    this.tabIndex = 0;
    this.parentNode = null;
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
  }
  set innerHTML(_v) {
    // A real browser clears children; the modal swaps its "Loading…"
    // placeholder out this way.
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
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  get firstChild() {
    return this.children[0] || null;
  }
}

const store = {};
const doc = {
  createElement: (tag) => new FakeEl(tag),
  // The bundles build inline SVG icons + text nodes (WP.icon / meta lines).
  createElementNS: (_ns, tag) => new FakeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
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
globalThis.location = { search: '', pathname: '/room/ROOM1' };
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
globalThis.IntersectionObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({}) });

// The bundles are IIFEs bound to the FIRST window they see, so the stubs and
// the imports happen once — each test only swaps the fetch implementation.
await import(join(ROOT, 'dist/js/utils.js'));
await import(join(ROOT, 'dist/js/api.js'));
await import(join(ROOT, 'dist/js/catalog.js'));

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** All elements whose className contains one of `needles`. */
function collect(el, needles, out = []) {
  const cls = String(el.className || '');
  if (needles.some((n) => cls.includes(n))) out.push({ cls, text: el.textContent });
  (el.children || []).forEach((c) => collect(c, needles, out));
  return out;
}

/** TMDB fetch stub for a tv show; `seasonPoster` drives the season art. */
function tvFetch(seasonPoster) {
  return (url) => {
    const u = String(url);
    if (u.includes('/api/health')) return Promise.resolve({ ok: true, json: async () => ({ build: 'test' }) });
    if (u.includes('/api/tmdb/tv/123/season')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ episodes: [{ episode_number: 1 }, { episode_number: 2 }] }),
      });
    }
    if (u.includes('/api/tmdb/tv/123')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: 123,
          poster_path: '/show.jpg',
          seasons: [
            { season_number: 0, name: 'Specials', episode_count: 1, poster_path: seasonPoster },
            { season_number: 1, name: 'Season 1', episode_count: 3, poster_path: seasonPoster },
          ],
        }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  };
}

/** Drive openEpisodes for a tv show and return the modal's body element. */
async function openTvEpisodes(seasonPoster) {
  globalThis.localStorage.clear(); // fresh TMDB cache + history per run
  doc.body = new FakeEl('body'); // clean surface per run
  globalThis.fetch = tvFetch(seasonPoster);
  const WP = globalThis.window.WP;
  WP.historyGet = () => []; // no local history in this test
  assert.ok(WP.Catalog && WP.Catalog.openEpisodes, 'catalog.js exposes openEpisodes');
  WP.Catalog.openEpisodes(
    { id: '123', type: 'tv', title: 'Test Show', poster: 'https://img/test.jpg', season: 1, episode: 2 },
    () => {}
  );
  await tick(120); // let the /tv/123 fetch + render settle
  return doc.body;
}

test('episode modal renders the season grid when a season has NO poster (TDZ regression)', async () => {
  const body = await openTvEpisodes(null);
  const empties = collect(body, ['browse__empty']).map((e) => e.text);
  assert.ok(
    !empties.some((t) => /Could not load episodes/.test(t)),
    'modal must not fall into its error branch: ' + JSON.stringify(empties)
  );
  const chips = collect(body, ['chip']).map((e) => e.text);
  assert.ok(chips.includes('Season 1'), 'season chip rendered (got: ' + chips.join(', ') + ')');
  assert.deepEqual(
    collect(body, ['ep-btn']).map((e) => e.text),
    ['1', '2', '3'],
    'episode buttons rendered'
  );
  const cover = collect(body, ['episodes-modal__cover']).filter((e) =>
    e.cls.split(' ').includes('episodes-modal__cover')
  );
  assert.equal(cover.length, 1, 'cover art shown (exact class match, not covermeta)');
});

test('episode modal renders the season grid when every season has its own poster', async () => {
  const body = await openTvEpisodes('/s1.jpg');
  const empties = collect(body, ['browse__empty']).map((e) => e.text);
  assert.ok(
    !empties.some((t) => /Could not load episodes|No season data/.test(t)),
    'modal renders normally: ' + JSON.stringify(empties)
  );
  assert.deepEqual(
    collect(body, ['ep-btn']).map((e) => e.text),
    ['1', '2', '3']
  );
});
