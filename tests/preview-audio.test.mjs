// BEHAVIORAL: the hover preview's trailer audio toggle, EXECUTED.
//
// The hover preview (dist/js/catalog.js) plays a muted YouTube trailer. This
// covers the audio control added on top of it:
//   • the toggle renders on the media box and defaults to ON (audio),
//   • the choice persists (wp:trailersound) and drives the next preview,
//   • the embed always starts muted (`mute=1&enablejsapi=1`) — unmuted autoplay
//     is not guaranteed without a user gesture — and the code REQUESTS sound
//     once the player has booted, so the default is audible where allowed,
//   • clicking the toggle sends the matching mute/unMute player command,
//   • a click during the boot delay is not undone by the late unMute request.
//
// The hover-preview section is sliced out of the shipped catalog.js (its
// modules are IIFEs with private helpers — same technique as
// tests/history-render.test.mjs) and run against a stub DOM with real timers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** catalog.js section: hover preview (state + trailer embed + preview card). */
function sliceHoverPreview() {
  const src = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  const start = src.indexOf('  // ---- hover preview (autoplaying trailer + plot)');
  assert.ok(start > 0, 'hover preview section present in catalog.js');
  const end = src.indexOf('  // ---- cards ----', start);
  assert.ok(end > start, 'hover preview section ends at the cards section');
  return (
    src.slice(start, end) +
    '\nreturn { attachHoverPreview: attachHoverPreview, closePreview: closePreview };'
  );
}

/** Event object good enough for the click handlers (preventDefault etc.). */
function evt(type) {
  return { type, stopPropagation() {}, preventDefault() {}, target: null };
}

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.textContent = '';
    this.title = '';
    this.type = '';
    this._attrs = {};
    this._listeners = {};
    this.parentNode = null;
    this.posted = [];
    this.dataset = {};
    this.contentWindow = { postMessage: (msg) => this.posted.push(JSON.parse(msg)) };
    // className and classList share ONE class set (like a real element), so a
    // className assignment is visible through classList.contains().
    const cls = new Set();
    Object.defineProperty(this, 'className', {
      get: () => Array.from(cls).join(' '),
      set: (v) => {
        cls.clear();
        String(v == null ? '' : v)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((x) => cls.add(x));
      },
      configurable: true,
    });
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
  set src(v) {
    this._src = v;
  }
  get src() {
    return this._src;
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) {
    this._attrs[k] = v;
  }
  getAttribute(k) {
    return this._attrs[k];
  }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  /** Fire the listeners registered for `type` (simulates iframe load / click). */
  fire(type) {
    (this._listeners[type] || []).forEach((fn) => fn(evt(type)));
  }
  getBoundingClientRect() {
    return { right: 200, left: 40, top: 100, width: 160, height: 240 };
  }
  /** Depth-first lookup by tag ('iframe') or class ('.card-preview__sound'). */
  querySelector(sel) {
    const match = (el) =>
      sel.charAt(0) === '.'
        ? String(el.className).split(' ').indexOf(sel.slice(1)) !== -1
        : el.tagName === sel;
    for (const c of this.children) {
      if (match(c)) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
}

/**
 * Run the shipped hover-preview section with stub DOM/localStorage/api.
 * @param {{ storedSound?: string|null, trailerKey?: string }} [o]
 */
function harness(o = {}) {
  const store = {};
  if (o.storedSound != null) store['wp:trailersound'] = String(o.storedSound);
  const body = new FakeEl('body');
  const doc = { createElement: (tag) => new FakeEl(tag), body: body, querySelector: () => null };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  const window = { innerWidth: 1400, innerHeight: 900, matchMedia: () => ({ matches: true }) };
  const api = () =>
    Promise.resolve({
      results: [{ site: 'YouTube', type: 'Trailer', official: true, key: o.trailerKey || 'KEY123' }],
    });
  const h = (tag, cls, text) => {
    const el = new FakeEl(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  };
  // buildPreview builds its meta line through metaNode() (the bundle's shared
  // meta helper) — it must be bound or the whole preview throws.
  const metaNode = (_item, cls) => h('div', cls || '', '2026 \u00b7 Movie');
  // Icon spy: the bundle paints icons with WP.icon / WP.setIcon (utils.js), so
  // recording the calls is how these tests prove "inline SVG, never emoji".
  const icons = [];
  const WP = {
    icon: (name, size) => {
      const svg = h('svg', 'wp-icon');
      svg.dataset.icon = name;
      svg.dataset.size = String(size);
      return svg;
    },
    setIcon: (el, name, size) => {
      icons.push({ el, name, size });
      el.children.length = 0; // replace, like the real painter
      el.appendChild(WP.icon(name, size));
    },
  };
  const globalObj = { location: { origin: 'https://example.test' }, WP };
  const fn = new Function(
    'window',
    'document',
    'localStorage',
    'api',
    'h',
    'metaNode',
    'global',
    sliceHoverPreview()
  )(window, doc, localStorage, api, h, metaNode, globalObj);
  return { attachHoverPreview: fn.attachHoverPreview, closePreview: fn.closePreview, body, store, icons };
}

const ITEM = { id: 42, type: 'movie', title: 'Fixture', poster: '/p.jpg', backdrop: '/b.jpg' };

/** Hover a card, wait out the 550ms intent delay + the trailer lookup. */
async function openPreview(app) {
  const card = new FakeEl('div');
  app.attachHoverPreview(card, ITEM);
  card.fire('mouseenter');
  await sleep(620);
  await sleep(40);
  return { card, preview: app.body.children[0] };
}

const postedFuncs = (iframe) => iframe.posted.map((m) => m && m.func);

/** Name of the icon MOST RECENTLY painted onto `el` (via WP.setIcon). */
const iconName = (app, el) => {
  const rec = app.icons.filter((r) => r.el === el).pop();
  return rec && rec.name;
};

test('trailer audio: the toggle is present and defaults to ON (sound)', async () => {
  const app = harness(); // no stored preference
  const { preview } = await openPreview(app);
  assert.ok(preview, 'hover preview rendered');
  assert.equal(preview.className, 'card-preview');

  const sound = preview.querySelector('.card-preview__sound');
  assert.ok(sound, 'audio toggle exists on the preview');
  assert.ok(sound.classList.contains('is-on'), 'default state is ON for every new preview');
  assert.equal(sound.getAttribute('aria-pressed'), 'true');
  // The toggle is a REAL inline SVG (Feather speaker), not an emoji glyph.
  const svg = sound.children[0];
  assert.ok(svg, 'the toggle carries an icon element');
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.className, 'wp-icon');
  assert.equal(iconName(app, sound), 'volume-2', 'ON paints the speaker-with-waves icon');
  assert.equal(sound.textContent, '', 'no emoji text content');

  // Placement contract: in the TEXT AREA (right side), never over the video.
  assert.equal(
    preview.querySelector('.card-preview__media').querySelector('.card-preview__sound'),
    null,
    'the toggle is not on top of the video'
  );
  const body = preview.querySelector('.card-preview__body');
  assert.ok(body.children.indexOf(sound) !== -1, 'the toggle lives in the tooltip text area');
  assert.ok(body.children.indexOf(preview.querySelector('.card-preview__text')) !== -1, 'title/meta/plot text box present');
  assert.equal(body.children[body.children.length - 1], sound, 'the toggle sits on the RIGHT of the text area');
  assert.equal(app.store['wp:trailersound'], undefined, 'no write until the user clicks');

  const iframe = preview.querySelector('iframe');
  assert.ok(iframe, 'trailer iframe loaded');
  assert.equal(
    preview.querySelector('.card-preview__media').querySelector('img'),
    null,
    'placeholder art is dropped in favour of the trailer (but the toggle survives)'
  );
  assert.ok(preview.querySelector('.card-preview__sound'), 'audio toggle is NOT wiped when the trailer loads');
  // Autoplay-safe embed + the APIs the toggle needs.
  assert.match(iframe.src, /autoplay=1/, 'autoplay');
  assert.match(iframe.src, /mute=1/, 'starts muted (unmuted autoplay is not guaranteed)');
  assert.match(iframe.src, /enablejsapi=1/, 'accepts mute/unMute commands');
  assert.match(iframe.src, /origin=https%3A%2F%2Fexample\.test/, 'origin param sent');

  // ON by default => sound is requested once the player has booted.
  iframe.fire('load');
  await sleep(780);
  assert.deepEqual(postedFuncs(iframe), ['unMute'], 'unMute requested on boot (audio default)');

  app.closePreview();
  assert.equal(app.body.children.length, 0, 'closePreview removes the tooltip');
});

test('trailer audio: clicking the toggle flips state, persists it, and commands the player', async () => {
  const app = harness();
  const { preview } = await openPreview(app);
  const iframe = preview.querySelector('iframe');
  const sound = preview.querySelector('.card-preview__sound');

  iframe.fire('load');
  await sleep(780); // boot delay already fired its unMute

  sound.fire('click'); // -> muted
  assert.equal(app.store['wp:trailersound'], '0', 'preference persisted (off)');
  assert.ok(!sound.classList.contains('is-on'), 'chip drops the ON state');
  assert.equal(sound.getAttribute('aria-pressed'), 'false');
  assert.equal(iconName(app, sound), 'volume-x', 'muted paints the crossed speaker icon');
  assert.deepEqual(postedFuncs(iframe), ['unMute', 'mute'], 'mute command sent');

  sound.fire('click'); // -> sound on again
  assert.equal(app.store['wp:trailersound'], '1', 'preference persisted (on)');
  assert.ok(sound.classList.contains('is-on'));
  assert.equal(iconName(app, sound), 'volume-2', 'ON paints the speaker icon again');
  assert.deepEqual(postedFuncs(iframe), ['unMute', 'mute', 'unMute'], 'unMute command sent');
});

test('trailer audio: a persisted OFF keeps the next preview silent (no unMute)', async () => {
  const app = harness({ storedSound: '0' });
  const { preview } = await openPreview(app);
  const iframe = preview.querySelector('iframe');
  const sound = preview.querySelector('.card-preview__sound');

  assert.ok(!sound.classList.contains('is-on'), 'stored OFF is reflected on the button');
  assert.equal(iconName(app, sound), 'volume-x', 'stored OFF paints the muted icon');
  iframe.fire('load');
  await sleep(780);
  assert.deepEqual(postedFuncs(iframe), [], 'no audio command when sound is off');
});

test('trailer audio: muting during the boot delay is not undone by the late unMute', async () => {
  const app = harness();
  const { preview } = await openPreview(app);
  const iframe = preview.querySelector('iframe');
  const sound = preview.querySelector('.card-preview__sound');

  iframe.fire('load'); // schedules the +700ms unMute
  sound.fire('click'); // user mutes BEFORE that request fires
  assert.deepEqual(postedFuncs(iframe), ['mute'], 'immediate mute');

  await sleep(800);
  assert.deepEqual(postedFuncs(iframe), ['mute'], 'the deferred unMute was cancelled by the preference');
});

test('trailer audio: CSS ships the bigger tooltip + the ghost icon toggle (theme-safe)', () => {
  const css = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  const preview = css.slice(css.indexOf('.card-preview {'), css.indexOf('.card-preview__media {'));
  assert.match(preview, /width: 360px;/, 'tooltip got bigger (was 304px)');
  // Text area = flex row so title/meta/plot flow on the left and the toggle
  // is pinned on the right (never absolutely positioned over the video).
  assert.match(css, /\.card-preview__body \{[^}]*display: flex;/, 'text area is a flex row');
  assert.match(css, /\.card-preview__text \{[^}]*flex: 1 1 auto;/, 'text takes the free space');
  const sound = css.slice(css.indexOf('.card-preview__sound {'), css.indexOf('.card-preview__sound.is-on {'));
  assert.match(sound, /flex: 0 0 auto;/, 'the toggle keeps its size next to the text');
  assert.match(sound, /background: transparent;/, 'ghost button (no chip)');
  assert.match(sound, /border: 0;/, 'ghost button (no border)');
  assert.ok(!/position: absolute/.test(sound), 'no longer floats over the video frame');
  assert.ok(!/border-radius: 50%/.test(sound), 'not a circle chip');
  assert.match(sound, /\.card-preview__sound:hover \{[^}]*background: var\(--bg-hover\);/, 'hover wash like the sidenav icons');
  assert.match(css, /\.card-preview__sound\.is-on \{[^}]*color: var\(--text\);/, 'ON state brightens the icon (themed ink)');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /js\/catalog\.js\?v=30/, 'catalog js cache-bumped');
  assert.match(html, /css\/catalog\.css\?v=29/, 'catalog css cache-bumped');
});

test('icons: the shipped UI carries NO emoji glyphs (inline SVG only)', () => {
  // The user rejected emoji-as-icon: every glyph in the UI chrome must now be a
  // real inline SVG. utils.js is exempt: TEXT_ICONS there is the deliberate
  // translation table for the SERVER's emoji in chat system lines.
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2665}\u{2661}\u{2605}\u{2606}\u{2713}\u{2717}\u{00D7}\u{270E}]/u;
  for (const f of ['dist/js/catalog.js', 'dist/js/social.js', 'dist/js/subs.js', 'dist/js/app.js', 'dist/js/i18n.js', 'dist/index.html']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // comments are not UI, and the arrows in prose are harmless
      if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return;
      assert.ok(!EMOJI.test(line), f + ':' + (i + 1) + ' still ships an emoji glyph: ' + line.trim().slice(0, 80));
    });
  }
});
