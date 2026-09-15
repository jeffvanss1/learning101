// TITLE LOGOS (Netflix-style title art) + the responsive scale.
//
// The hero banner, the hover tooltip and the details modal show the title's
// own TMDB wordmark when one exists, and keep the text title otherwise — a
// title without art must never leave a hole, and the text node is never
// removed (it carries the accessible name for screen readers and search).
//
// The logo helpers are sliced out of the shipped catalog.js and EXECUTED
// (same technique as tests/preview-audio.test.mjs), so the ranking rules and
// the "clip the text, keep the name" behaviour are tested, not just grepped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** catalog.js section: title-logo helpers. */
function sliceLogoHelpers() {
  const src = read('dist/js/catalog.js');
  const start = src.indexOf('  // ---- title logos (Netflix-style title art)');
  assert.ok(start > 0, 'title-logo section present in catalog.js');
  const end = src.indexOf('  // ---- hover preview (autoplaying trailer + plot)', start);
  assert.ok(end > start, 'the section ends at the hover preview');
  return (
    src.slice(start, end) +
    '\nreturn { detailPath: detailPath, pickLogoPath: pickLogoPath, ' +
    'fetchLogoPath: fetchLogoPath, applyTitleLogo: applyTitleLogo };'
  );
}

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.src = '';
    this.alt = '';
    this.dataset = {};
    this._attrs = {};
    this._classes = new Set();
    const self = this;
    this.classList = {
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c),
    };
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return this._attrs[k] === undefined ? null : this._attrs[k];
  }
  removeAttribute(k) {
    delete this._attrs[k];
  }
  insertBefore(node, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    node.parentNode = this;
    if (i === -1) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
}

function makeBundle(o = {}) {
  const doc = {
    createElement: (tag) => new FakeEl(tag),
  };
  const apiCalls = [];
  const api =
    o.api ||
    ((path) => {
      apiCalls.push(path);
      return Promise.resolve({ images: { logos: [] } });
    });
  const img = (path, size) => 'https://image.tmdb.org/t/p/' + size + path;
  const fn = new Function('document', 'api', 'img', sliceLogoHelpers())(doc, api, img);
  return { ...fn, apiCalls, doc };
}

const EN_LOGO = { file_path: '/en.png', iso_639_1: 'en', aspect_ratio: 3.4, vote_average: 5.2 };
const TEXT_FREE = { file_path: '/none.png', iso_639_1: null, aspect_ratio: 4.1, vote_average: 9.9 };
const ID_LOGO = { file_path: '/id.png', iso_639_1: 'id', aspect_ratio: 3.0, vote_average: 8 };
const SQUARE = { file_path: '/square.png', iso_639_1: 'en', aspect_ratio: 0.8, vote_average: 9 };

// ---------------------------------------------------------------------------

test('pickLogoPath: pinned language wins, textless is the fallback, wide art over square', () => {
  const { pickLogoPath } = makeBundle();
  assert.equal(pickLogoPath({ logos: [] }), '', 'no logos -> no art (text title stays)');
  assert.equal(pickLogoPath(null), '', 'a missing image block is not a crash');
  assert.equal(pickLogoPath({ logos: [EN_LOGO, ID_LOGO] }), '/en.png', 'English wordmark first');
  assert.equal(pickLogoPath({ logos: [TEXT_FREE, ID_LOGO] }), '/none.png', 'then the textless art');
  assert.equal(pickLogoPath({ logos: [ID_LOGO] }), '/id.png', 'localized data still beats nothing');
  assert.equal(
    pickLogoPath({ logos: [SQUARE, { ...EN_LOGO, file_path: '/wide.png', aspect_ratio: 2.2 }] }),
    '/wide.png',
    'a square mark never wins over a wide wordmark'
  );
  assert.equal(
    pickLogoPath({ logos: [{ ...EN_LOGO, file_path: '/low.png', vote_average: 1 }, { ...EN_LOGO, file_path: '/high.png', vote_average: 9 }] }),
    '/high.png',
    'inside a language the community-voted logo wins'
  );
  assert.equal(
    pickLogoPath({ logos: [{ file_path: '/only-square.png', iso_639_1: 'en', aspect_ratio: 0.6 }] }),
    '/only-square.png',
    'a lone square mark is still better than no art'
  );
});

test('detailPath: one request carries the logo set (and is cache-key stable)', () => {
  const { detailPath } = makeBundle();
  const movie = detailPath({ id: 157336, type: 'movie' });
  assert.equal(movie, '/movie/157336?append_to_response=images&include_image_language=en,null');
  assert.match(movie, /append_to_response=images/, 'the logo set rides along with the details');
  assert.equal(detailPath({ id: 1399, type: 'tv' }), '/tv/1399?append_to_response=images&include_image_language=en,null');
  assert.equal(detailPath({ id: 5, type: 'anime' }), '/tv/5?append_to_response=images&include_image_language=en,null', 'anime is the tv path');
  assert.match(detailPath({ id: 'a b', type: 'movie' }), /^\/movie\/a%20b\?/, 'the id is encoded');
});

test('fetchLogoPath: memoized, one request per title, never throws', async () => {
  let calls = 0;
  const { fetchLogoPath } = makeBundle({
    api: (path) => {
      calls++;
      if (path.startsWith('/tv/')) return Promise.reject(new Error('offline'));
      return Promise.resolve({ images: { logos: [EN_LOGO] } });
    },
  });
  assert.equal(await fetchLogoPath({ id: 1, type: 'movie' }), '/en.png');
  assert.equal(await fetchLogoPath({ id: 1, type: 'movie' }), '/en.png', 'cached');
  assert.equal(calls, 1, 'the second call is a cache hit');
  assert.equal(await fetchLogoPath({ id: 2, type: 'tv' }), '', 'a failed fetch resolves empty');
  assert.equal(await fetchLogoPath({ id: 2, type: 'tv' }), '', 'a miss is memoized too (no retry storm)');
  assert.equal(calls, 2, 'exactly one request per title');
  assert.equal(await fetchLogoPath({}), '', 'no id -> empty');
});

test('applyTitleLogo: art on screen, text clipped but still in the DOM', async () => {
  const { applyTitleLogo } = makeBundle({
    api: () => Promise.resolve({ images: { logos: [EN_LOGO] } }),
  });
  const parent = new FakeEl('div');
  const title = new FakeEl('h1');
  title.className = 'hero__title';
  title.textContent = 'Interstellar';
  parent.appendChild(title);

  applyTitleLogo({ id: 157336, type: 'movie' }, title, 'hero__logo');
  await new Promise((r) => setTimeout(r, 10));

  const logo = parent.children[0];
  assert.equal(logo.tagName, 'img', 'the logo is an <img> right before the title');
  assert.equal(logo.className, 'hero__logo');
  assert.match(logo.src, /w500\/en\.png$/, 'sized through the bundle img() helper');
  assert.equal(logo.alt, '', 'decorative (the title text carries the name)');
  assert.equal(logo.getAttribute('aria-hidden'), 'true');
  assert.ok(title.classList.contains('is-title-hidden'), 'the text title stops painting');
  assert.equal(title.parentNode, parent, 'but stays in the DOM for screen readers');
  assert.equal(title.textContent, 'Interstellar', 'and keeps the accessible name');

  // A logo that 404s must fall back to the text, not leave an empty banner.
  logo.onerror();
  assert.equal(logo.parentNode, null, 'the broken image is dropped');
  assert.ok(!title.classList.contains('is-title-hidden'), 'the text title comes back');
});

test('applyTitleLogo: a title without art keeps its text title untouched', async () => {
  const { applyTitleLogo } = makeBundle({ api: () => Promise.resolve({ images: { logos: [] } }) });
  const parent = new FakeEl('div');
  const title = new FakeEl('div');
  title.textContent = 'No Art Here';
  parent.appendChild(title);
  applyTitleLogo({ id: 9, type: 'movie' }, title, 'detail__logo');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(parent.children, [title], 'nothing was inserted');
  assert.ok(!title.classList.contains('is-title-hidden'), 'and nothing was hidden');
});

test('the surfaces use the shared helpers (hero, tooltip, details)', () => {
  const catalog = read('dist/js/catalog.js');
  assert.match(
    catalog,
    /const heroTitle = h\('h1', 'hero__title', item\.title\);\s*\n\s*content\.appendChild\(heroTitle\);\s*\n\s*applyTitleLogo\(item, heroTitle, 'hero__logo'\);/,
    'the hero paints its title art'
  );
  assert.match(
    catalog,
    /applyTitleLogo\(item, tipTitle, 'card-preview__logo'\)/,
    'the hover tooltip paints its title art'
  );
  assert.match(
    catalog,
    /paintTitleLogo\(pickLogoPath\(extra && extra\.images\), detailTitle, 'detail__logo'\)/,
    'the details modal reuses the payload it already fetched'
  );
  // The hero art goes up to 4K: srcset, so a phone never downloads the original.
  assert.match(catalog, /im\.srcset = item\.backdrop \+ ' 1280w, ' \+ item\.backdropLarge \+ ' 3840w'/, 'hero srcset');
  assert.match(catalog, /im\.sizes = '100vw'/, 'hero sizes hint');
  assert.match(catalog, /im\.setAttribute\('fetchpriority', 'high'\)/, 'the banner is the LCP image');
});

test('CSS: the banner is bigger, the logo is bounded, the text clip is accessible', () => {
  const css = read('dist/css/catalog.css');
  const style = read('dist/css/style.css');
  const hero = css.slice(css.indexOf('.hero {'), css.indexOf('.hero__content {'));
  assert.match(hero, /height: clamp\(300px, 33vw, 560px\)/, 'a phone gets 300px, a desktop ~33vw, a TV 560px');
  assert.match(hero, /border-radius: var\(--radius-lg\)/, 'the banner is a big rounded panel');
  assert.match(hero, /isolation: isolate/, 'scrims stack predictably');

  const logo = css.slice(css.indexOf('.hero__logo {'), css.indexOf('.hero__meta {'));
  assert.match(logo, /max-height: clamp\(58px, 7vw, 116px\)/, 'the wordmark scales with the screen');
  assert.match(logo, /max-width: min\(440px, 88%\)/, 'and can never overflow the text block');
  assert.match(logo, /object-fit: contain/, 'never stretched or cropped');

  // Every logo slot is bounded (hero, tooltip, details).
  assert.match(css, /\.card-preview__logo \{[^}]*max-height: 44px;/, 'tooltip logo bounded');
  assert.match(css, /\.detail__logo \{[^}]*max-height: clamp\(46px, 5vw, 84px\);/, 'details logo bounded');

  // The clip keeps the text readable by a screen reader (never display:none).
  const util = style.slice(style.indexOf('.is-title-hidden {'), style.indexOf('/* Icon + label inside a button'));
  assert.match(util, /clip-path: inset\(50%\)/, 'classic visually-hidden clip');
  assert.doesNotMatch(util, /display:\s*none/, 'the accessible name must survive');
});

test('CSS: the whole sheet scales from a phone to a 4K TV', () => {
  const css = read('dist/css/catalog.css');
  const phone = css.slice(css.indexOf('@media (max-width: 720px) {'), css.indexOf('@media (max-width: 520px) {'));
  assert.match(phone, /--card-w: 132px;\s*\n\s*--card-h: 198px;/, 'thumb-sized posters on a phone');
  assert.match(phone, /min-height: clamp\(240px, 62vw, 320px\)/, 'a hero that fits above the fold on a phone');
  assert.match(phone, /padding-bottom: calc\(var\(--bottomnav-h\) \+ env\(safe-area-inset-bottom, 0px\)\)/, 'the last row clears the bottom bar');

  const tv = css.slice(css.indexOf('@media (min-width: 1600px) {'), css.indexOf('@media (min-width: 2400px) {'));
  assert.match(tv, /--card-w: 182px;/, 'desktop-large posters grow');
  assert.match(tv, /\.hero \{\s*\n\s*height: clamp\(420px, 30vw, 620px\);/, 'and the banner grows with them');

  const uhd = css.slice(css.indexOf('@media (min-width: 2400px) {'));
  assert.match(uhd, /--card-w: 214px;/, '4K keeps scaling instead of shrinking into a corner');
  assert.match(uhd, /\.hero \{\s*\n\s*height: clamp\(520px, 26vw, 720px\);/, '4K banner');
  assert.match(read('dist/css/style.css'), /--page-max: 1560px;/, 'the content column token lives in the shell sheet');
  assert.match(read('dist/css/style.css'), /@media \(min-width: 2400px\) \{\s*\n\s*:root \{\s*\n\s*--topnav-h: 78px;/, 'the top bar scales too');
  assert.match(css, /orientation: landscape/, 'landscape phones are handled (banner must not eat the screen)');
});
