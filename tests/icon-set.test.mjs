// ICON SYSTEM: every glyph in the UI is an inline SVG from WP.icon (utils.js).
// User directive: "no emoji as icon" — an emoji renders as a full-color glyph
// that ignores the theme ink, the font stack and the icon's size, which is what
// the icons replaced. This file executes the SHIPPED utils.js against a minimal
// DOM stub and scans the SHIPPED client bundles for leftover emoji.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Minimal Element/Node stub: enough for WP.icon / WP.setIcon. */
function makeDom() {
  class El {
    constructor(tag) {
      this.tagName = tag;
      this.attrs = {};
      this.children = [];
      this.parentNode = null;
      this.textContent = '';
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return this.attrs[k];
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    appendChild(node) {
      if (node && node.__fragment) {
        node.children.forEach((c) => {
          c.parentNode = this;
          this.children.push(c);
        });
      } else {
        node.parentNode = this;
        this.children.push(node);
      }
      return node;
    }
    removeChild(node) {
      this.children = this.children.filter((c) => c !== node);
      return node;
    }
    get firstChild() {
      return this.children[0] || null;
    }
    /** Deep walk (assertions only). */
    get all() {
      return this.children.flatMap((c) => (c.all ? [c, ...c.all] : [c]));
    }
  }
  globalThis.document = {
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    createDocumentFragment: () => {
      const f = new El('#fragment');
      f.__fragment = true;
      return f;
    },
  };
  return El;
}

test('WP.icon: every icon is a themed inline SVG (real bundle run)', async () => {
  makeDom();
  globalThis.window = { WP: {} };
  new Function('window', read('dist/js/utils.js'))(globalThis.window);
  const WP = globalThis.window.WP;
  assert.equal(typeof WP.icon, 'function', 'utils.js exports WP.icon');

  const names = ['volume-2', 'volume-x', 'star', 'heart', 'heart-fill', 'check', 'x', 'zap',
    'edit', 'copy', 'alert', 'key', 'users', 'user', 'play', 'pause', 'fast-forward',
    'skip-forward', 'rotate-cw', 'arrow-left', 'chevron-left', 'chevron-right', 'film'];
  names.forEach((name) => {
    assert.equal(WP.hasIcon(name), true, name + ' exists in the set');
    const svg = WP.icon(name, 18);
    assert.equal(svg.tagName, 'svg', name + ' renders an <svg>');
    assert.equal(svg.getAttribute('width'), '18', name + ' honours the requested size');
    assert.equal(svg.getAttribute('height'), '18', name + ' honours the requested size');
    // Inline + themed: the colour comes from the surrounding ink, never from
    // a hardcoded palette or a full-colour emoji glyph.
    assert.equal(svg.getAttribute('class'), 'wp-icon', name + ' carries the wp-icon class');
    // The ink is ALWAYS currentColor (themed) or nothing — never a palette
    // literal, which is what makes an emoji-as-icon wrong in the first place.
    const stroke = svg.getAttribute('stroke');
    const fill = svg.getAttribute('fill');
    assert.ok(
      stroke === 'currentColor' || fill === 'currentColor',
      name + ' inherits the surrounding ink (currentColor)'
    );
    [stroke, fill].forEach((v) =>
      assert.ok(['currentColor', 'none'].includes(v), name + ' paints with the ink only (saw ' + v + ')')
    );
    // Geometry only: vector shapes, never a raster image or a text glyph
    // (an emoji inside <text> would render as a full-colour glyph again).
    const shapeTags = ['path', 'line', 'polyline', 'polygon', 'circle', 'rect', 'ellipse'];
    assert.ok(svg.all.length > 0, name + ' has geometry');
    svg.all.forEach((n) =>
      assert.ok(shapeTags.includes(n.tagName), name + ' draws only vector shapes (saw ' + n.tagName + ')')
    );
  });
  // Filled variants opt into currentColor fill explicitly.
  const solid = WP.icon('heart-fill', 18);
  assert.equal(solid.getAttribute('fill'), 'currentColor', 'heart-fill fills with currentColor');
  assert.equal(solid.getAttribute('stroke'), 'none', 'heart-fill has no outline');
  assert.equal(WP.hasIcon('nope-not-real'), false, 'unknown names are reported as missing');
  assert.equal(WP.icon('nope-not-real', 18).tagName, 'svg', 'and render as an empty svg (never throw)');
});

test('WP.setIcon swaps a button glyph in place (like/on-off toggles)', async () => {
  const El = makeDom();
  globalThis.window = { WP: {} };
  new Function('window', read('dist/js/utils.js'))(globalThis.window);
  const WP = globalThis.window.WP;
  const btn = new El('button');
  btn.appendChild(new El('span')); // stale content
  WP.setIcon(btn, 'heart', 18);
  assert.equal(btn.children.length, 1, 'the old content is replaced');
  assert.equal(btn.children[0].tagName, 'svg');
  assert.equal(btn.children[0].getAttribute('stroke'), 'currentColor', 'the outline heart strokes with the ink');
  assert.equal(btn.children[0].getAttribute('fill'), 'none');
  WP.setIcon(btn, 'heart-fill', 18);
  assert.equal(btn.children.length, 1, 'swapping again replaces it');
  assert.equal(btn.children[0].getAttribute('fill'), 'currentColor', 'the filled heart fills with the ink');
  assert.equal(btn.children[0].getAttribute('stroke'), 'none');
  WP.setIcon(null, 'heart', 18); // must be a no-op, not a crash
});

test('the shipped client has no emoji-as-icon left', () => {
  // Files that BUILD UI. WP.utils keeps a text-only fallback map for logged
  // message lines (WhatsApp-style prefixes), which is deliberate and is the
  // single allowlisted exception.
  const uiFiles = [
    'dist/js/app.js',
    'dist/js/social.js',
    'dist/js/catalog.js',
    'dist/js/subs.js',
    'dist/js/player.js',
    'dist/js/i18n.js',
    'dist/js/api.js',
  ];
  const offenders = [];
  for (const file of uiFiles) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        // Strip comments: prose may mention an emoji without rendering one.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (/\p{Extended_Pictographic}/u.test(code)) offenders.push(file + ':' + (i + 1) + ' ' + code.trim());
      });
  }
  assert.deepEqual(offenders, [], 'icons are inline SVG (WP.icon), never emoji glyphs');
});

test('.wp-icon is inline-block and inherits the surrounding ink', () => {
  const style = read('dist/css/style.css');
  const block = style.slice(style.indexOf('.wp-icon {'), style.indexOf('.meta__icon {'));
  assert.match(block, /display: inline-block/, 'icons sit in text runs');
  assert.match(block, /vertical-align:/, 'and on the text baseline');
  // No CSS paints an icon directly: the ink is inherited so icons theme with
  // the surrounding text (accent ink for stars etc. comes from the container).
  assert.doesNotMatch(block, /\bcolor:\s*#/, 'no hardcoded ink on the icon itself');
  assert.match(style, /\.meta__icon \{[^}]*color: var\(--/, 'accent icons pull a theme var, not a literal');
});
