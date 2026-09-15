// Regression test for the "big gap above the profile" bug (2026-09-13).
//
// #profile used to sit OUTSIDE .app-shell in dist/index.html. The shell is
// height:100vh/overflow:hidden, so on /user/:username the document rendered
// a full empty viewport (the shell) with the profile starting a full screen
// down — users saw a giant blank gap above the profile card.
//
// The contract: #profile must be a DOM descendant of .app-shell (and of
// .app-shell__main), so it is the flex:1 scroll surface of the fixed-height
// main column, exactly like #home, #room and #discovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readIndex, hasAncestorClass, cssBlock, ROOT } from './dompath.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const html = readIndex();
const socialCss = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');

test('#profile lives inside .app-shell (not a body-level sibling)', () => {
  assert.ok(
    hasAncestorClass(html, 'profile', 'app-shell'),
    '#profile must be a descendant of .app-shell — outside it, the 100vh shell becomes a blank first screen above the profile'
  );
});

test('#profile lives inside .app-shell__main (the fixed-height scroll column)', () => {
  assert.ok(
    hasAncestorClass(html, 'profile', 'app-shell__main'),
    '#profile must be a flex child of .app-shell__main, like #home, #room and #discovery'
  );
});

test('.profile stays a self-contained scroll surface', () => {
  const block = cssBlock(socialCss, '.profile {');
  assert.notEqual(block, null, '.profile rule missing from social.css');
  for (const decl of ['flex: 1', 'min-height: 0', 'overflow-y: auto']) {
    assert.ok(block.includes(decl), `.profile must declare ${decl} (scroll surface contract)`);
  }
});
