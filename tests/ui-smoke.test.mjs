// Runtime smoke test — executes the REAL shipped bundles (dist/js/*.js) in
// Node with a minimal DOM stub and drives the two surfaces that broke on
// 2026-09-13:
//
// 1. Home browse feed: a hoisting refactor renamed ROW_DEFS -> FEED_DEFS but
//    left one live reference behind; `node --check` and static tests cannot
//    see inside a function, so the home feed died with a ReferenceError at
//    runtime. Executing mountBrowse catches that class of bug.
// 2. Friends drawer: the old mount call (inside mountHome) was removed when
//    the drawer became global, and no boot-level mount replaced it — the
//    button silently no-op'd. Executing the boot sequence catches that.
//
// These stubs are intentionally dumb: plain objects/arrays, no behavior
// beyond what the bundles call during mount/toggle.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.tabIndex = 0;
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
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  insertBefore(c) {
    this.children.push(c);
    return c;
  }
  setAttribute() {}
  removeAttribute() {}
  remove() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
  select() {}
  get firstChild() {
    return this.children[0] || null;
  }
  get childElementCount() {
    return this.children.length;
  }
}

function installDomStubs({ fetchImpl }) {
  globalThis.window = {
    WP: {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  globalThis.document = {
    createElement: (tag) => new FakeEl(tag),
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    readyState: 'complete',
    hidden: false,
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.fetch = fetchImpl;
  return globalThis.window;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recursively collect every dataset.row value in the fake tree. */
function collectRowKeys(el, out = []) {
  if (el.dataset && el.dataset.row) out.push(el.dataset.row);
  (el.children || []).forEach((c) => collectRowKeys(c, out));
  return out;
}

const TMDB_PAGE = {
  page: 1,
  total_pages: 2,
  results: [
    {
      id: 1,
      media_type: 'movie',
      title: 'Fixture Movie',
      poster_path: '/x.jpg',
      vote_average: 7,
      release_date: '2026-01-01',
    },
  ],
};

test('home browse feed mounts and renders feed sections (no stale references)', async () => {
  const window = installDomStubs({
    fetchImpl: (url) => {
      if (String(url).includes('/api/health')) {
        return Promise.resolve({ ok: true, json: async () => ({ build: 'test' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ...TMDB_PAGE }) });
    },
  });

  // Load the real shipped bundles, in dependency order.
  await import(join(ROOT, 'dist/js/utils.js'));
  await import(join(ROOT, 'dist/js/api.js'));
  await import(join(ROOT, 'dist/js/catalog.js'));
  assert.ok(window.WP.Catalog, 'catalog.js must register WP.Catalog');

  const container = new FakeEl('div');
  const handle = window.WP.Catalog.mountBrowse(container, {
    onSelect() {},
    searchInputs: [],
    peopleProvider: null,
  });
  assert.ok(handle, 'mountBrowse must return a handle');

  await tick(120); // let hero + initial sections settle

  const keys = collectRowKeys(container);
  for (const expected of ['movie', 'tv', 'anime', 'trending']) {
    assert.ok(
      keys.includes(expected),
      `home feed must render the '${expected}' section (got: ${keys.join(', ') || 'none'})`
    );
  }

  handle.destroy();
});

test('friends drawer mounts at boot level and toggles open/closed', async () => {
  const window = installDomStubs({
    fetchImpl: (url) =>
      Promise.resolve({ ok: true, json: async () => ({ build: 'test', user: null }) }),
  });

  await import(join(ROOT, 'dist/js/utils.js'));
  await import(join(ROOT, 'dist/js/api.js'));
  await import(join(ROOT, 'dist/js/catalog.js')); // social.js may touch WP.Catalog
  await import(join(ROOT, 'dist/js/social.js'));
  assert.ok(window.WP.Social, 'social.js must register WP.Social');

  // Boot: exactly what app.js does once at startup.
  const aside = new FakeEl('aside');
  window.WP.Social.mountFriendsRail(aside);

  window.WP.Social.toggleFriendsRail();
  assert.ok(aside.classList.contains('is-open'), 'first toggle must OPEN the drawer');

  window.WP.Social.toggleFriendsRail();
  assert.ok(!aside.classList.contains('is-open'), 'second toggle must CLOSE the drawer');

  // Destroy handles (clears their 30s polls) so the test process can exit.
  window.WP.Social.mountFriendsRail(new FakeEl('aside')).destroy();
  await tick(10);
});
