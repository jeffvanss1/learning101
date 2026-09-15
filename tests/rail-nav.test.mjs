// ROW RAIL — the horizontal paging buttons + the edge fade into the page.
//
// A mouse has no horizontal wheel axis and a desktop has no swipe, so every
// poster row carries its own pair of chevron buttons, and the edge that still
// hides cards fades into the page background. The shipped catalog.js is
// EXECUTED here (same technique as tests/title-logo.test.mjs): the rail is a
// real component with real measurements, not a grep of a stylesheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CSS = read('dist/css/catalog.css');

/** Minimal element stub: enough for h(), classList, listeners and the rail. */
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.type = '';
    this.dataset = {};
    this._attrs = {};
    this._classes = new Set();
    this._events = {};
    const self = this;
    this.classList = {
      add: (c) => self._classes.add(c),
      remove: (c) => self._classes.delete(c),
      contains: (c) => self._classes.has(c),
      toString: () => [...self._classes].join(' '),
    };
  }
  /** className and classList are one list in the DOM - keep the stub honest. */
  get className() {
    return [...this._classes].join(' ');
  }
  set className(v) {
    this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return this._attrs[k] === undefined ? null : this._attrs[k];
  }
  appendChild(node) {
    if (node && node.parentNode) node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  addEventListener(type, fn) {
    (this._events[type] = this._events[type] || []).push(fn);
  }
  fire(type, ev) {
    (this._events[type] || []).forEach((fn) => fn(ev || {}));
  }
  /** Deep walk (assertions only). */
  get all() {
    return this.children.flatMap((c) => (c.all ? [c, ...c.all] : [c]));
  }
}

/** A scroller stub with a fixed geometry: view of `view` px, `total` px of cards. */
function makeScroller({ view = 1000, total = 4000, dir = 'ltr' } = {}) {
  const scroller = new El('div');
  scroller.className = 'row__scroller';
  scroller.clientWidth = view;
  scroller.scrollWidth = total;
  scroller.scrollLeft = 0;
  scroller.moves = [];
  scroller.scrollBy = (opts) => {
    scroller.moves.push(opts.left);
    scroller.scrollLeft += opts.left;
  };
  scroller.ownerDocument = { documentElement: { getAttribute: (k) => (k === 'dir' ? dir : null) } };
  return scroller;
}

/** Run the SHIPPED catalog.js against a stub DOM; return its rail component. */
function freshCatalog() {
  const document = {
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    createDocumentFragment: () => new El('#fragment'),
  };
  const win = {
    document,
    WP: {
      // The real one builds an inline SVG; the stub records which glyph was asked.
      icon: (name, size) => {
        const svg = new El('svg');
        svg.className = 'wp-icon';
        svg.setAttribute('name', name);
        svg.setAttribute('width', String(size));
        return svg;
      },
    },
  };
  globalThis.document = document;
  new Function('window', 'document', read('dist/js/catalog.js'))(win, document);
  return win.WP.Catalog;
}

const railOf = (scroller) => freshCatalog().mountRail(scroller);

/** The two buttons + two fades, read back from the rail. */
function parts(rail) {
  const by = (cls) => rail.all.filter((n) => n.classList.contains(cls));
  return {
    fades: by('row__fade'),
    navs: by('row__nav'),
    prev: by('row__nav').find((n) => n.classList.contains('row__nav--prev')),
    next: by('row__nav').find((n) => n.classList.contains('row__nav--next')),
  };
}

// --------------------------------------------------------------- structure ---

test('rail: the scroller is wrapped, the fades come first and the chevrons ride ON them', () => {
  const scroller = makeScroller();
  const { el: rail, sync } = railOf(scroller);
  assert.ok(rail.classList.contains('row__rail'), 'the rail is its own element');
  assert.equal(scroller.parentNode, rail, 'the scroller lives in the rail');
  assert.equal(typeof sync, 'function', 'the rail exposes its repaint');

  const { fades, navs, prev, next } = parts(rail);
  assert.equal(fades.length, 2, 'one fade per end');
  assert.equal(navs.length, 2, 'one button per end');
  assert.deepEqual(
    rail.children.slice(1).map((n) => n.className),
    ['row__fade row__fade--prev', 'row__fade row__fade--next', 'row__nav row__nav--prev', 'row__nav row__nav--next'],
    'DOM order: scroller, fade, fade, button, button (a chevron sits over its fade)'
  );
  assert.equal(prev.type, 'button', 'prev is a real button');
  assert.equal(next.type, 'button', 'next is a real button');
  fades.forEach((f) => assert.equal(f.getAttribute('aria-hidden'), 'true', 'fades are decoration'));
  assert.equal(prev.getAttribute('aria-label'), 'Scroll back', 'prev is labelled for screen readers');
  assert.equal(next.getAttribute('aria-label'), 'Scroll forward', 'next is labelled for screen readers');
  const glyphs = navs.map((b) => b.children[0]);
  assert.deepEqual(glyphs.map((g) => g.getAttribute('name')), ['chevron-left', 'chevron-right'], 'inline SVG chevrons');
  assert.deepEqual(glyphs.map((g) => g.getAttribute('width')), ['22', '22'], 'both draw at the button size');
});

test('rail: a row that already fits offers nothing (no dead arrows, no fade)', () => {
  const scroller = makeScroller({ view: 1200, total: 900 });
  const { el: rail } = railOf(scroller);
  assert.equal(rail.classList.contains('can-prev'), false, 'nothing behind the start');
  assert.equal(rail.classList.contains('can-next'), false, 'nothing past the end');
  assert.equal(rail.className, 'row__rail', 'a short row stays exactly as it was built');
});

test('rail: a row built while hidden (no layout yet) offers nothing until it is measured', () => {
  const scroller = makeScroller({ view: 0, total: 4000 });
  const { el: rail, sync } = railOf(scroller);
  assert.equal(rail.classList.contains('can-next'), false, 'a 0-width container proves nothing');
  scroller.clientWidth = 1000; // the row is in the layout now
  sync();
  assert.equal(rail.classList.contains('can-next'), true, 'the sync after insertion lights the edge up');
  assert.equal(rail.classList.contains('can-prev'), false, 'still at the start');
});

test('rail: each end is lit exactly when cards are hidden there', () => {
  const scroller = makeScroller({ view: 1000, total: 4000 });
  const { el: rail, sync } = railOf(scroller);
  assert.equal(rail.classList.contains('can-prev'), false, 'start: only "next"');
  assert.equal(rail.classList.contains('can-next'), true);

  scroller.scrollLeft = 1500; // the scroller fires this itself while it moves
  scroller.fire('scroll');
  assert.equal(rail.classList.contains('can-prev'), true, 'middle: both ends');
  assert.equal(rail.classList.contains('can-next'), true);

  scroller.scrollLeft = 3000; // max = 4000 - 1000
  sync();
  assert.equal(rail.classList.contains('can-prev'), true, 'end: only "back"');
  assert.equal(rail.classList.contains('can-next'), false);
});

test('rail: the state follows the SCROLLER (a row never scrolls itself)', () => {
  const scroller = makeScroller({ view: 1000, total: 4000 });
  const { el: rail } = railOf(scroller);
  assert.equal(scroller._events.scroll.length, 1, 'one scroll listener, on the scroller');
  scroller.scrollLeft = 4000;
  scroller.fire('scroll');
  assert.equal(rail.classList.contains('can-next'), false, 'the listener repainted it');
  assert.equal(rail.classList.contains('can-prev'), true);
});

// ------------------------------------------------------------------ clicks ---

test('rail: one click travels most of the visible width (a mouse can page a row)', () => {
  const scroller = makeScroller({ view: 1000, total: 4000 });
  const { el: rail, ...rest } = railOf(scroller);
  void rest;
  const { next, prev } = parts(rail);
  next.fire('click');
  assert.deepEqual(scroller.moves, [860], 'one page = 86% of the visible width');
  assert.equal(scroller.scrollLeft, 860);
  assert.equal(rail.classList.contains('can-prev'), true, 'the "back" end lights up immediately');
  assert.equal(rail.classList.contains('can-next'), true, 'and there is still more ahead');

  prev.fire('click');
  assert.equal(scroller.scrollLeft, 0, 'back returns to the start');
  assert.equal(rail.classList.contains('can-prev'), false, 'and the "back" end goes dark');
});

test('rail: a narrow row still moves at least a card per click, and never past an end', () => {
  const scroller = makeScroller({ view: 140, total: 4000 }); // phone-ish view
  const { el: rail } = railOf(scroller);
  const { next, prev } = parts(rail);
  next.fire('click');
  assert.equal(scroller.moves[0], 160, 'the floor keeps a click useful on a narrow row');

  // At the far end a click must not invent travel (or a phantom "next" edge).
  scroller.scrollLeft = 3860; // max
  rail.classList.remove('can-prev');
  next.fire('click');
  assert.equal(scroller.moves[scroller.moves.length - 1], 0, 'clamped at the end');
  assert.equal(rail.classList.contains('can-next'), false);
  assert.equal(rail.classList.contains('can-prev'), true);

  scroller.scrollLeft = 0;
  prev.fire('click');
  assert.equal(scroller.moves[scroller.moves.length - 1], 0, 'clamped at the start');
  assert.equal(rail.classList.contains('can-prev'), false, 'no "back" arrow at the start');
});

test('rail: RTL pages the other way (the content starts at the right edge)', () => {
  const scroller = makeScroller({ view: 1000, total: 4000, dir: 'rtl' });
  const { el: rail } = railOf(scroller);
  const { next, prev } = parts(rail);
  next.fire('click');
  assert.equal(scroller.moves[0], -860, 'forward is a NEGATIVE scrollLeft in RTL');
  prev.fire('click');
  assert.equal(scroller.moves[1], 860, 'and back is positive');
  assert.equal(rail.classList.contains('can-prev'), false, 'RTL distance is measured as a magnitude');
});

test('rail: the labels are localized, with an English fallback when i18n is absent', () => {
  const scroller = makeScroller();
  const { el: rail } = railOf(scroller);
  const { prev, next } = parts(rail);
  assert.equal(prev.getAttribute('aria-label'), 'Scroll back', 'fallback (no WP.I18N in this stub)');
  assert.equal(next.getAttribute('aria-label'), 'Scroll forward');
  const cat = read('dist/js/catalog.js');
  assert.match(cat, /tr\('row\.prev',\s*'Scroll back'\)/, 'the label goes through the i18n helper');
  assert.match(cat, /tr\('row\.next',\s*'Scroll forward'\)/);
  const i18n = read('dist/js/i18n.js');
  for (const key of ["'row.prev':", "'row.next':"]) {
    assert.equal((i18n.match(new RegExp(key.replace('.', '\\.'), 'g')) || []).length, 6, key + ' in all six dictionaries');
  }
});

// -------------------------------------------------------------- the wiring ---

test('rail: rows are built through mountRail, and appended pages repaint them', () => {
  const cat = read('dist/js/catalog.js');
  assert.match(cat, /const rail = mountRail\(scroller\);/, 'makeSectionRow wraps its scroller');
  assert.match(cat, /sec\.appendChild\(rail\.el\);/, 'the rail is what enters the section');
  assert.match(cat, /def\.rail = rail;/, 'the section keeps its rail');
  assert.match(cat, /rail\.sync\(\);\s*\n\s*return scroller;/, 'measured again once the section is in the DOM');
  assert.match(cat, /if \(def\.rail\) def\.rail\.sync\(\);/, 'a page of new cards repaints the rail');
  // One resize listener per surface, removed with the surface (never per row).
  assert.equal((cat.match(/addEventListener\('resize', syncRails\)/g) || []).length, 1, 'one resize hook');
  assert.equal((cat.match(/removeEventListener\('resize', syncRails\)/g) || []).length, 1, 'and it is removed on destroy');
  assert.match(cat, /mountRail,\n  \};/, 'mountRail is exported for the preview page');
});

// --------------------------------------------------------------- the style ---

test('rail css: the fades are the PAGE background, fading out (never a black wash)', () => {
  assert.match(CSS, /\.row__fade--prev \{\s*inset-inline-start: 0;\s*background: linear-gradient\(to right, var\(--bg\), transparent\);/);
  assert.match(CSS, /\.row__fade--next \{\s*inset-inline-end: 0;\s*background: linear-gradient\(to left, var\(--bg\), transparent\);/);
  assert.match(CSS, /html\[dir='rtl'\] \.row__fade--prev \{ background: linear-gradient\(to left, var\(--bg\), transparent\); \}/, 'the ramps mirror in RTL');
  assert.match(CSS, /html\[dir='rtl'\] \.row__fade--next \{ background: linear-gradient\(to right, var\(--bg\), transparent\); \}/);
  assert.match(CSS, /\.row__fade \{[\s\S]*?pointer-events: none;[\s\S]*?opacity: 0;/, 'fades are inert and hidden by default');
  assert.match(CSS, /\.row__rail\.can-prev \.row__fade--prev,\s*\.row__rail\.can-next \.row__fade--next \{\s*opacity: 1;/, 'each fade answers its own end');
  assert.equal(/\.row__fade[^{]*\{[^}]*rgba\(0, 0, 0/.test(CSS), false, 'a fade never darkens the page');
});

test('rail css: a button exists only for a live end, and is revealed by pointer or keyboard', () => {
  assert.match(CSS, /\.row__nav \{[\s\S]*?display: none;/, 'not offered by default');
  assert.match(CSS, /\.row__rail\.can-prev \.row__nav--prev,\s*\.row__rail\.can-next \.row__nav--next \{\s*display: grid;/, 'each button answers its own end');
  assert.match(CSS, /\.row__rail:hover \.row__nav,\s*\.row__nav:focus-visible \{\s*opacity: 1;\s*pointer-events: auto;/, 'hover OR keyboard focus reveals it');
  assert.match(CSS, /\.row__nav \{[\s\S]*?pointer-events: none;/, 'an invisible button never eats a click');
  assert.equal(/\.row__rail:focus-within/.test(CSS), false, 'a focused CARD must not park arrows over the artwork');
  assert.match(CSS, /\.row__nav:focus-visible \{ outline: 2px solid var\(--blue\);/, 'keyboard focus is visible');
});

test('rail css: touch swipes (no buttons), RTL mirrors the chevron, motion is respected', () => {
  // NOTE: the sheet carries an older (hover: none) block; this one is the rail's.
  const hoverNone = CSS.slice(CSS.lastIndexOf('@media (hover: none)'), CSS.lastIndexOf('@media (hover: none)') + 200);
  assert.match(hoverNone, /\.row__rail\.can-prev \.row__nav--prev,\s*\.row__rail\.can-next \.row__nav--next \{ display: none; \}/, 'a touch device keeps its swipe');
  assert.ok(
    CSS.lastIndexOf('@media (hover: none)') > CSS.indexOf('.row__rail.can-next .row__nav--next {\n  display: grid;\n}'),
    'and it comes LAST, so it wins the cascade over the display rule'
  );
  assert.match(CSS, /html\[dir='rtl'\] \.row__nav svg \{ transform: scaleX\(-1\); \}/, 'the chevron points off its own edge in RTL');
  const reduced = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.row__fade,\s*\.row__nav \{ transition: none; \}/, 'no fades animating');
  assert.match(reduced, /\.row__scroller \{ scroll-behavior: auto; \}/, 'and no smooth glide');
  assert.match(CSS, /\.row__scroller \{[\s\S]*?scroll-behavior: smooth;/, 'the buttons glide to the next page');
});

test('rail css: the button is the on-media control the rest of the app already uses', () => {
  assert.match(CSS, /\.card-item__badge \{[\s\S]*?background: rgba\(0, 0, 0, 0.62\);/, 'the badge sets the recipe');
  const nav = CSS.slice(CSS.indexOf('.row__nav {'), CSS.indexOf('.row__nav--prev {'));
  assert.match(nav, /background: rgba\(0, 0, 0, 0.62\);/, 'same translucent black over artwork');
  assert.match(nav, /color: #fff;/, 'white ink in BOTH themes');
  assert.match(nav, /border: 1px solid rgba\(255, 255, 255, 0.16\);/, 'same hairline');
  assert.match(nav, /backdrop-filter: blur\(6px\);/, 'and the same blur');
  assert.match(nav, /inset-block-start: calc\(50% - 10px\);/, 'centred on the CARDS, not on the scrollbar');
  assert.match(nav, /inline-size: 34px;[\s\S]*?block-size: 68px;/, 'a tall rounded slab, like the reference');
  assert.match(CSS, /:root \{\s*--card-w: 132px;[\s\S]*?\.row__nav \{\s*inline-size: 28px;\s*block-size: 54px;/, 'a narrow window gets a compact button');
});

test('rail css: the rail never breaks the row layout it wraps', () => {
  assert.match(CSS, /\.row__rail \{\s*position: relative;\s*min-width: 0;/, 'the rail is the positioning context and can shrink');
  assert.match(CSS, /\.row__fade--prev \{\s*inset-inline-start: 0;/, 'logical edges, so RTL needs no extra rule');
  assert.match(CSS, /\.row__nav--prev \{ inset-inline-start: 2px; \}/);
  assert.match(CSS, /\.row__nav--next \{ inset-inline-end: 2px; \}/);
});
