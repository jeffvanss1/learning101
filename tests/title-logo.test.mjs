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
    '\nreturn { detailPath: detailPath, pickLogo: pickLogo, pickLogoPath: pickLogoPath, ' +
    'fetchLogo: fetchLogo, fetchLogoPath: fetchLogoPath, paintTitleLogo: paintTitleLogo, ' +
    'LOGO_FOLD_BOX: LOGO_FOLD_BOX, applyTitleLogo: applyTitleLogo };'
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
    this.style = {};
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
  /** Walk up by class selector (the fold straddle looks for .card-preview__body). */
  closest(sel) {
    const want = String(sel).replace(/^\./, ''); // real closest() takes a selector
    let node = this;
    while (node) {
      if (String(node.className || '').split(/\s+/).includes(want)) return node;
      node = node.parentNode;
    }
    return null;
  }
  /** Settable layout box: the straddle measures the text column. */
  setRect(rect) {
    this.getBoundingClientRect = () => rect;
    return this;
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
  const globalObj = o.global || { getComputedStyle: null };
  const fn = new Function('document', 'api', 'img', 'global', sliceLogoHelpers())(
    doc,
    api,
    img,
    globalObj
  );
  return { ...fn, apiCalls, doc, globalObj };
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

test('pickLogo carries the art aspect (what the fold measurement needs)', () => {
  const { pickLogo, pickLogoPath, LOGO_FOLD_BOX } = makeBundle();
  assert.deepEqual(pickLogo({ logos: [EN_LOGO] }), { path: '/en.png', aspect: 3.4 }, 'the chosen art reports its shape');
  assert.deepEqual(pickLogo({ logos: [SQUARE] }), { path: '/square.png', aspect: 0.8 }, 'a square mark too');
  assert.deepEqual(pickLogo({ logos: [] }), { path: '', aspect: 0 }, 'no art -> no path, no aspect');
  assert.deepEqual(pickLogo(null), { path: '', aspect: 0 }, 'a missing image block is not a crash');
  assert.equal(pickLogoPath({ logos: [EN_LOGO] }), '/en.png', 'the path-only helper is unchanged');
  assert.equal(LOGO_FOLD_BOX.maxH, 104, 'the measured box matches .card-preview__logo (max-height: 104px)');
  assert.equal(LOGO_FOLD_BOX.maxWRatio, 0.88, 'and its width matches (max-width: 88%)');
});

test('ONE rule for every logo: the class never depends on the art shape', async () => {
  const square = { file_path: '/sq.png', iso_639_1: 'en', aspect_ratio: 0.9, vote_average: 5 };
  const ultraWide = { file_path: '/uw.png', iso_639_1: 'en', aspect_ratio: 6.2, vote_average: 5 };
  const paint = async (logos) => {
    const bundle = makeBundle({ api: () => Promise.resolve({ images: { logos } }) });
    const parent = new FakeEl('div');
    const title = new FakeEl('div');
    title.className = 'card-preview__title';
    title.textContent = 'Interstellar';
    parent.appendChild(title);
    bundle.applyTitleLogo({ id: 1, type: 'movie' }, title, 'card-preview__logo');
    await new Promise((r) => setTimeout(r, 10));
    return { logo: parent.children[0], title, bundle };
  };

  // Shape is NOT a switch any more: square, mid and ultra-wide all land in the
  // same lockup (it was "big box vs in-column" that looked inconsistent).
  for (const [name, art] of [['square', square], ['wordmark', EN_LOGO], ['ultra-wide', ultraWide]]) {
    const out = await paint([art]);
    assert.equal(out.logo.tagName, 'img', name + ': the art is painted');
    assert.equal(out.logo.className, 'card-preview__logo', name + ': one class, no tier');
    assert.ok(out.title.classList.contains('is-title-hidden'), name + ': the text title yields');
    assert.equal(out.bundle.pickLogo({ logos: [art] }).aspect, art.aspect_ratio, name + ': the shape is still measured');
  }

  // Not even a leftover hook: a shape-based class would drift back in.
  const catalog = read('dist/js/catalog.js');
  assert.ok(!/is-logo-big/.test(catalog), 'no tier class in the bundle');
  assert.ok(!/isSmallLogoArt|LOGO_SMALL_ASPECT/.test(catalog), 'no shape-based branch left');
  assert.ok(!/is-logo-big/.test(read('dist/css/catalog.css')), 'and none in the stylesheet');
});

test('the tooltip art is centred on the fold (measured from the aspect ratio)', async () => {
  const square = { file_path: '/sq.png', iso_639_1: 'en', aspect_ratio: 1, vote_average: 5 };
  const { paintTitleLogo, LOGO_BIG_BOX } = makeBundle({
    api: () => Promise.resolve({ images: { logos: [square] } }),
    // the tooltip body's real padding (top) is read from the computed style
    global: { getComputedStyle: () => ({ paddingTop: '14px' }) },
  });

  // The shipped tooltip structure: panel > media + body > text > title.
  const panel = new FakeEl('div');
  panel.className = 'card-preview';
  const media = new FakeEl('div');
  media.className = 'card-preview__media';
  panel.appendChild(media);
  const body = new FakeEl('div');
  body.className = 'card-preview__body';
  panel.appendChild(body);
  const text = new FakeEl('div');
  text.className = 'card-preview__text';
  text.setRect({ width: 300, height: 120, top: 0, bottom: 0 });
  body.appendChild(text);
  const title = new FakeEl('div');
  title.className = 'card-preview__title';
  text.appendChild(title);

  paintTitleLogo({ path: '/sq.png', aspect: 1 }, title, 'card-preview__logo');
  const logo = text.children[0];
  // height = min(104, 300 * 0.88 / 1) = 104  ->  margin = -(104/2 + 14) = -66
  assert.equal(logo.style.marginTop, '-66px', 'half of the square art sits over the trailer, on the fold');

  // ...and a WIDE wordmark is measured the same way — the treatment is one rule,
  // only the art's own height differs: height = 300 * 0.88 / 6 = 44 -> -(22+14).
  const wideBody = new FakeEl('div');
  wideBody.className = 'card-preview__body';
  const wide = new FakeEl('div');
  wide.className = 'card-preview__text';
  wide.setRect({ width: 300, height: 120, top: 0, bottom: 0 });
  wideBody.appendChild(wide);
  const wideTitle = new FakeEl('div');
  wideTitle.className = 'card-preview__title';
  wide.appendChild(wideTitle);
  paintTitleLogo({ path: '/en.png', aspect: 6 }, wideTitle, 'card-preview__logo');
  assert.equal(wide.children[0].style.marginTop, '-36px', 'a wordmark straddles the same fold, just shorter');

  // Both are pulled up by exactly half their rendered height plus the body
  // padding: the art's CENTRE is on the fold in either case.
  assert.equal(14 + 104 / 2, 66, 'square: padding + half the box');
  assert.equal(14 + 44 / 2, 36, 'wordmark: padding + half its own height');
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
    /paintTitleLogo\(pickLogo\(extra && extra\.images\), detailTitle, 'detail__logo'\)/,
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
  assert.match(logo, /max-height: clamp\(96px, 9vw, 156px\)/, 'the art scales with the screen (one measure)');
  assert.match(logo, /max-width: min\(520px, 84%\)/, 'and can never overflow the text block');
  assert.match(logo, /object-fit: contain/, 'never stretched or cropped');

  // ONE rule per surface (the consistency contract): the tooltip lockup lives on
  // the BASE class, so the art's shape can never change the treatment...
  const tipLogo = css.slice(css.indexOf('.card-preview__logo {'), css.indexOf('.card-preview__meta {'));
  assert.match(tipLogo, /max-height: 104px;/, 'tooltip box');
  assert.match(tipLogo, /max-width: 88%;/, 'tooltip width');
  assert.match(tipLogo, /margin-top: -52px;/, 'the no-JS fold straddle');
  assert.match(tipLogo, /position: relative;/, 'paints above the trailer');
  assert.match(tipLogo, /z-index: 2;/, 'and stays above it');
  assert.match(tipLogo, /filter: drop-shadow\(/, 'the same shadow on every logo (it used to be big-art only)');
  assert.match(tipLogo, /object-position: left center;/, 'and the same left alignment');
  assert.doesNotMatch(css, /\.is-logo-big/, 'no shape-based tier left in the stylesheet');

  // ...and each surface carries ONE cap for every logo shape.
  assert.match(css, /\.hero__logo \{[^}]*max-height: clamp\(96px, 9vw, 156px\);/, 'hero: one cap');
  assert.match(css, /\.detail__logo \{[^}]*max-height: clamp\(84px, 7vw, 132px\);/, 'details: one cap');
  assert.match(css, /\.modal__card--wide \.hero__logo \{[^}]*max-height: 72px;/, 'the compact picker banner keeps its own smaller measure');
  assert.match(css, /\.modal__card--wide \.hero__logo \{[^}]*max-width: min\(340px, 58%\);/, 'and a width cap');

  // The clip keeps the text readable by a screen reader (never display:none).
  const util = style.slice(style.indexOf('.is-title-hidden {'), style.indexOf('/* Icon + label inside a button'));
  assert.match(util, /clip-path: inset\(50%\)/, 'classic visually-hidden clip');
  assert.doesNotMatch(util, /display:\s*none/, 'the accessible name must survive');
});

test('CSS: ONE lockup rhythm — the gap under the logo is a shared token', () => {
  const css = read('dist/css/catalog.css');

  // The token (and its size scale) lives with the other catalog tokens.
  assert.match(css, /--logo-gap: 12px;/, 'the base rhythm');
  const cols = read('dist/css/catalog.css').split('\n');
  const tierFor = (media, value) => {
    const i = cols.findIndex((l) => l.includes('@media (min-width: ' + media + 'px)'));
    assert.ok(i >= 0, media + ' tier exists');
    // The token sits in that tier's :root block (tokens first, then the rules).
    const body = cols.slice(i, i + 12).join('\n');
    assert.ok(body.includes('--logo-gap: ' + value + ';'), media + ' tier rhythm (' + value + ')');
  };
  tierFor(1600, '14px');
  tierFor(2400, '16px');
  // NB: catalog.css has two max-width:720px blocks (the mobile nav one comes
  // first), so anchor on the tier's own token block instead of the media line.
  const phoneTok = cols.findIndex((l) => l.includes('--card-w: 132px;'));
  assert.ok(phoneTok >= 0, 'the phone tier token block exists');
  assert.ok(
    cols.slice(phoneTok, phoneTok + 4).join('\n').includes('--logo-gap: 10px;'),
    'the phone tier tightens it like everything else'
  );

  // All three surfaces consume it — that is the consistency contract.
  const uses = css.match(/var\(--logo-gap/g) || [];
  assert.equal(uses.length, 3, 'tooltip + hero + details: exactly three consumers');
  const logo = css.slice(css.indexOf('.card-preview__logo {'), css.indexOf('.card-preview__meta {'));
  assert.match(logo, /margin-bottom: var\(--logo-gap, 12px\);/, 'the tooltip art owns the gap');
  const detail = css.slice(css.indexOf('.detail__logo {'), css.indexOf('.detail__meta {'));
  assert.match(detail, /margin-bottom: var\(--logo-gap, 12px\);/, 'and the detail header');
  const hero = css.slice(css.indexOf('.hero__content {'), css.indexOf('.hero__badge {'));
  assert.match(hero, /gap: var\(--logo-gap, 12px\);/, 'the banner shares the same rhythm');

  // The rating row must never sit tighter than the token: its own top margin is
  // the no-art gap, and adjacent sibling margins collapse to the larger value —
  // so a 4px there can not shave the 12px lockup gap (that was the crowding:
  // 2px + 4px collapsing to 4px).
  const meta = css.slice(css.indexOf('.card-preview__meta {'), css.indexOf('.card-preview__overview {'));
  const top = Number((meta.match(/margin:\s*(\d+)px 0/) || [])[1]);
  assert.equal(top, 4, 'the no-art gap stays 4px (larger sibling margin wins)');
  assert.ok(top < 12, 'and it is smaller than the lockup gap, so it can never shave it');
});

test('CSS: the whole sheet scales from a phone to a 4K TV', () => {
  const css = read('dist/css/catalog.css');
  const phone = css.slice(css.indexOf('@media (max-width: 720px) {'), css.indexOf('@media (max-width: 520px) {'));
  assert.match(phone, /--card-w: 132px;\s*\n\s*--card-h: 198px;/, 'thumb-sized posters on a phone');
  assert.match(phone, /min-height: clamp\(240px, 62vw, 320px\)/, 'a hero that fits above the fold on a phone');
  assert.match(phone, /padding-bottom: calc\(var\(--bottomnav-h\) \+ env\(safe-area-inset-bottom, 0px\)\)/, 'the last row clears the bottom bar');

  assert.match(phone, /\.hero__logo \{[^}]*max-height: 108px;/, 'the same measure, scaled for a phone');
  assert.match(phone, /\.detail__logo \{[^}]*max-height: 104px;/, 'and in the phone detail header');
  // ...and only ONE rule teaches that cap (a second copy is the stale-cascade bug
  // that once silently overrode a themed fix). The modal-scoped rule does not
  // count: it is a different selector at a different level.
  assert.equal((phone.match(/^  \.hero__logo \{/gm) || []).length, 1, 'exactly one phone hero-logo cap');

  const tv = css.slice(css.indexOf('@media (min-width: 1600px) {'), css.indexOf('@media (min-width: 2400px) {'));
  assert.match(tv, /--card-w: 182px;/, 'desktop-large posters grow');
  assert.match(tv, /\.hero \{\s*\n\s*height: clamp\(420px, 30vw, 620px\);/, 'and the banner grows with them');
  assert.match(tv, /\.hero__logo \{[^}]*max-height: clamp\(150px, 12vw, 230px\);/, 'the measure grows on a TV');
  assert.match(tv, /\.card-preview__logo \{[^}]*max-height: 116px;/, 'tooltip too');

  const uhd = css.slice(css.indexOf('@media (min-width: 2400px) {'));
  assert.match(uhd, /--card-w: 214px;/, '4K keeps scaling instead of shrinking into a corner');
  assert.match(uhd, /\.hero \{\s*\n\s*height: clamp\(520px, 26vw, 720px\);/, '4K banner');
  assert.match(uhd, /\.hero__logo \{[^}]*max-height: 280px;/, '4K measure');
  assert.match(uhd, /\.detail__logo \{[^}]*max-height: 200px;/, '4K details');
  assert.match(read('dist/css/style.css'), /--page-max: 1560px;/, 'the content column token lives in the shell sheet');
  assert.match(read('dist/css/style.css'), /@media \(min-width: 2400px\) \{\s*\n\s*:root \{\s*\n\s*--topnav-h: 78px;/, 'the top bar scales too');
  assert.match(css, /orientation: landscape/, 'landscape phones are handled (banner must not eat the screen)');
});
