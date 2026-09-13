// Regression test for the "big gap above the profile" bug (2026-09-13).
//
// #profile used to sit OUTSIDE .app-shell in dist/index.html. The shell is
// height:100vh/overflow:hidden, so on /user/:username the document rendered
// a full empty viewport (the shell) with the profile starting a full screen
// down — users saw a giant blank gap above the profile card.
//
// The contract: #profile must be a DOM descendant of .app-shell (and of
// .app-shell__main), so it is the flex:1 scroll surface of the fixed-height
// main column, exactly like #home and #room.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'dist/index.html'), 'utf8');
const socialCss = readFileSync(join(root, 'dist/css/social.css'), 'utf8');

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/** Walks the HTML and returns the ancestor chain (id/class descriptors) of the element with the given id. */
function ancestorsOf(id) {
  const start = html.indexOf('<body');
  const end = html.indexOf('</body>');
  const body = html.slice(start, end);
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  let m;
  while ((m = tagRe.exec(body)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    if (VOID_TAGS.has(tag) || attrs.endsWith('/')) continue;
    if (closing) {
      // Pop to the matching open tag (index.html is machine-formatted; a
      // simple pop is sufficient and keeps the parser tiny).
      const idx = stack.lastIndexOf(tag);
      if (idx !== -1) stack.length = idx;
      continue;
    }
    const idMatch = /id="([^"]*)"/.exec(attrs);
    if (idMatch && idMatch[1] === id) return stack.map((e) => e);
    const clsMatch = /class="([^"]*)"/.exec(attrs);
    stack.push({ tag, id: idMatch ? idMatch[1] : '', cls: clsMatch ? clsMatch[1].split(/\s+/) : [] });
  }
  return null;
}

test('#profile lives inside .app-shell (not a body-level sibling)', () => {
  const chain = ancestorsOf('profile');
  assert.notEqual(chain, null, '#profile not found in index.html');
  const hasShell = chain.some((a) => a.cls.includes('app-shell'));
  assert.ok(hasShell, '#profile must be a descendant of .app-shell — outside it, the 100vh shell becomes a blank first screen above the profile');
});

test('#profile lives inside .app-shell__main (the fixed-height scroll column)', () => {
  const chain = ancestorsOf('profile');
  assert.notEqual(chain, null, '#profile not found in index.html');
  const hasMain = chain.some((a) => a.cls.includes('app-shell__main'));
  assert.ok(hasMain, '#profile must be a flex child of .app-shell__main, like #home and #room');
});

test('.profile stays a self-contained scroll surface', () => {
  const start = socialCss.indexOf('.profile {');
  assert.notEqual(start, -1, '.profile rule missing from social.css');
  const block = socialCss.slice(start, socialCss.indexOf('}', start));
  for (const decl of ['flex: 1', 'min-height: 0', 'overflow-y: auto']) {
    assert.ok(block.includes(decl), `.profile must declare ${decl} (scroll surface contract)`);
  }
});
