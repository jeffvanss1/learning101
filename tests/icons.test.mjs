// Inline-SVG icon system (utils.js) — the contract behind "no emoji in the UI".
//
// The user rejected emoji-as-icon: every glyph the UI paints must be a real
// inline SVG from the WP.icon table. These tests keep that honest by executing
// the SHIPPED utils.js against a stub DOM and checking:
//   1. the table covers EVERY icon name the bundles actually ask for (a missing
//      name silently renders an empty <svg>, which is exactly the failure mode
//      these tests exist to prevent),
//   2. the produced SVG is themeable (viewBox 0 0 24 24, currentColor ink),
//   3. unknown names fail SAFE (empty svg, no throw),
//   4. the server's emoji status glyphs in chat system lines are translated,
//   5. no bundle ships an emoji glyph as UI text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

/** Minimal DOM good enough for utils.js (SVG + text nodes + classList). */
function stubDom() {
  class El {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this._attrs = {};
      this.textContent = '';
      this.classList = {
        add: (...c) => {
          const cur = (this._attrs.class || '').split(/\s+/).filter(Boolean);
          c.forEach((x) => cur.indexOf(x) === -1 && cur.push(x));
          this._attrs.class = cur.join(' ');
        },
        remove: (...c) => {
          const cur = (this._attrs.class || '').split(/\s+/).filter((x) => x && c.indexOf(x) === -1);
          this._attrs.class = cur.join(' ');
        },
        contains: (c) => (this._attrs.class || '').split(/\s+/).indexOf(c) !== -1,
      };
    }
    setAttribute(k, v) {
      this._attrs[k] = String(v);
    }
    getAttribute(k) {
      return k in this._attrs ? this._attrs[k] : null;
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      return c;
    }
    get firstChild() {
      return this.children[0] || null;
    }
  }
  const document = {
    createElementNS: (_ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    createDocumentFragment: () => new El('#fragment'),
  };
  return { document, El };
}

async function freshUtils() {
  const { document, El } = stubDom();
  const window = {};
  const store = {};
  globalThis.document = document;
  globalThis.window = window;
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  Object.assign(window, { document, localStorage: globalThis.localStorage });
  await import(join(ROOT, 'dist/js/utils.js') + '?v=' + Math.random());
  return { WP: window.WP, document, El };
}

const BUNDLES = ['catalog.js', 'social.js', 'subs.js', 'app.js', 'i18n.js'];

/** Icon names referenced in a bundle: ic('x'), icon('x'), setIcon(el,'x'), iconLabel(el,'x'), {icon:'x'}. */
function iconNamesUsed(src) {
  const names = new Set();
  const pats = [
    /\bic\(\s*'([a-z][a-z0-9-]*)'/g,
    /\bWP\.icon\(\s*'([a-z][a-z0-9-]*)'/g,
    /\bicon\(\s*'([a-z][a-z0-9-]*)'/g,
    /\bsetIcon\([^,]+,\s*'([a-z][a-z0-9-]*)'/g,
    // ternary swaps: setIcon(el, on ? 'volume-2' : 'volume-x', 18)
    /\bsetIcon\([^,]+,\s*[^,]*\?\s*'([a-z][a-z0-9-]*)'/g,
    /\bsetIcon\([^,]+,\s*[^,]*:\s*'([a-z][a-z0-9-]*)'/g,
    /\biconLabel\([^,]+,\s*'([a-z][a-z0-9-]*)'/g,
    /\{\s*icon:\s*'([a-z][a-z0-9-]*)'/g,
  ];
  for (const p of pats) for (const m of src.matchAll(p)) names.add(m[1]);
  return names;
}

test('icons: every name the bundles ask for EXISTS in the table (no silent empty svg)', async () => {
  const { WP } = await freshUtils();
  const missing = [];
  for (const f of BUNDLES) {
    const src = readFileSync(join(ROOT, 'dist/js', f), 'utf8');
    for (const name of iconNamesUsed(src)) if (!WP.hasIcon(name)) missing.push(f + ' -> ' + name);
  }
  assert.deepEqual(missing, [], 'icon names referenced but not defined in utils.js ICONS');
  const used = [...new Set(BUNDLES.flatMap((f) => [...iconNamesUsed(readFileSync(join(ROOT, 'dist/js', f), 'utf8'))]))];
  // The sweep touches every surface: subtitles, catalog, social, player, chat.
  for (const name of ['zap', 'star', 'x', 'check', 'copy', 'rotate-cw', 'volume-2', 'volume-x', 'heart', 'heart-fill']) {
    assert.ok(used.includes(name), 'the bundles ask for the ' + name + ' icon');
  }
  assert.ok(used.length >= 10, 'the sweep really uses the icon system (' + used.length + ' distinct names)');
});

test('icons: output is a themeable inline SVG (24x24 viewBox, currentColor) and never throws', async () => {
  const { WP } = await freshUtils();
  for (const name of ['volume-2', 'volume-x', 'star', 'heart', 'heart-fill', 'check', 'x', 'zap', 'copy', 'film']) {
    const svg = WP.icon(name, 18);
    assert.equal(svg.tagName, 'svg');
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24', name + ' uses the shared grid');
    assert.equal(svg.getAttribute('class'), 'wp-icon');
    assert.equal(svg.getAttribute('width'), '18');
    assert.equal(svg.getAttribute('height'), '18');
    assert.equal(svg.getAttribute('aria-hidden'), 'true', 'decorative: screen readers skip it');
    assert.ok(svg.children.length > 0, name + ' draws geometry');
    assert.ok(
      svg.getAttribute('stroke') === 'currentColor' || svg.getAttribute('fill') === 'currentColor',
      name + ' inherits the surrounding ink (themes with the app)'
    );
  }
  // Fail-safe: an unknown name must not take a surface down.
  const unknown = WP.icon('definitely-not-an-icon', 16);
  assert.equal(unknown.tagName, 'svg');
  assert.equal(unknown.children.length, 0, 'unknown name -> empty svg (never a throw)');
  assert.equal(WP.hasIcon('definitely-not-an-icon'), false);
});

test('icons: the SERVER emoji in chat system lines is translated to SVG on the client', async () => {
  const { WP } = await freshUtils();
  // The Durable Object emits plain-text lines like "▶️ Play", "⏸️ Paused",
  // "⏩ Skipped", "🎟️ Room created" — they must render as icons, not emoji.
  const cases = [
    ['\u25b6\ufe0f Play', 'play'],
    ['\u25b6 Play', 'play'],
    ['\u23f8\ufe0f Paused', 'pause'],
    ['\u23f8 Paused', 'pause'],
    ['\u23e9 Skipped 10s', 'fast-forward'],
    ['\ud83c\udf9f\ufe0f Room created', 'film'],
  ];
  for (const [text, expected] of cases) {
    const frag = WP.iconText(text, 13);
    assert.ok(frag, 'iconText returns a node for ' + JSON.stringify(text));
    assert.equal(frag.tagName, '#fragment');
    const kids = frag.children;
    const svg = kids[0];
    assert.ok(svg && svg.tagName === 'svg', JSON.stringify(text) + ' starts with an SVG icon');
    assert.ok(svg.children.length > 0, 'the ' + expected + ' icon actually draws (not the empty fallback)');
    assert.match(svg.getAttribute('class'), /wp-icon--inline/, 'inline alignment class for text runs');
    const words = kids
      .filter((k) => k.nodeType === 3)
      .map((k) => k.textContent)
      .join('');
    assert.ok(words.trim().length > 0, 'the words after the glyph survive as text');
    assert.ok(!/[\u25b6\u23f8\u23e9]/.test(words), 'the emoji itself is gone from the text');
  }
  // A line with no known glyph still renders (as plain text).
  const plain = WP.iconText('Hello everyone', 13);
  assert.equal(plain.tagName, '#fragment');
  assert.equal(plain.children.length, 1);
  assert.equal(plain.children[0].textContent, 'Hello everyone');
  assert.equal(plain.children[0].tagName, undefined, 'plain text line = one text node');
});

test('icons: no bundle ships an emoji glyph as UI (inline SVG only)', () => {
  // utils.js is exempt: TEXT_ICONS there is the deliberate translation table for
  // the SERVER's emoji. Comments are prose, not UI.
  const EMOJI =
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2665}\u{2661}\u{2605}\u{2606}\u{2713}\u{2717}\u{00D7}\u{270E}]/u;
  const files = [
    ...readdirSync(join(ROOT, 'dist/js'))
      .filter((f) => f.endsWith('.js') && f !== 'utils.js')
      .map((f) => 'dist/js/' + f),
    'dist/index.html',
  ];
  for (const f of files) {
    readFileSync(join(ROOT, f), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*|<!--)/.test(line)) return; // comments
        assert.ok(!EMOJI.test(line), f + ':' + (i + 1) + ' ships an emoji glyph: ' + line.trim().slice(0, 80));
      });
  }
});
