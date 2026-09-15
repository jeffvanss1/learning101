// EXHAUSTIVE color audit — the "hardcoded UI colors" guard.
// Every theme-coupled color must be a var; the ONLY hardcoded literals
// allowed are: var definitions, brand/accent inks, on-accent text, and
// on-dark overlays (player/scrims). Exact counts pin the allowlist, and a
// duplication detector prevents the stale-duplicate-cascade bug (the whole
// catalog stylesheet was once pasted twice — the later copy silently
// overrode every themed fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT } from './dompath.mjs';

const FILES = ['dist/css/style.css', 'dist/css/catalog.css', 'dist/css/social.css'];

function count(css, lit) {
  const esc = lit.replace(/[.*#{}()]/g, '\\$&');
  const tail = /[a-zA-Z0-9]$/.test(lit) ? '\\b' : '';
  return (css.match(new RegExp(esc + tail, 'g')) || []).length;
}

test('colors: pastel accent texts are BANNED (they wash out in light mode)', () => {
  for (const f of FILES) {
    const css = readFileSync(join(ROOT, f), 'utf8');
    for (const lit of ['#ff8fa3', '#ffccd5', '#b9e3ff', '#ff6b6b']) {
      assert.equal(count(css, lit), 0, `${f}: ${lit} banned - use var(--red)/var(--blue)`);
    }
  }
});

test('colors: hardcoded literal allowlist is EXACT (any new literal must be reviewed)', () => {
  const allowed = {
    'dist/css/style.css': { '#fff': 6, '#0b0b0b': 1, '#e8c35a': 1, '#f5d76a': 1, '#cccccc': 1, '#f5c518': 1 },
    // catalog.css #fff: on-media inks + the mobile centre-slot disc (white ink
    // on the red friends disc, same treatment as .btn--primary).
    // catalog.css #fff: on-media inks (hero badge, hero title, card badge,
    // like heart, mobile centre-slot disc, history card) - the banner owns its
    // ink because it sits on artwork in BOTH themes.
    'dist/css/catalog.css': { '#fff': 7, '#d4d4d4': 1 },
    'dist/css/social.css': { '#fff': 4, '#0b0b0b': 1, '#7ee08a': 1, '#444': 1 },
  };
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  const catalog = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  const social = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  const css = { 'dist/css/style.css': style, 'dist/css/catalog.css': catalog, 'dist/css/social.css': social };
  for (const [f, lits] of Object.entries(allowed)) {
    for (const [lit, n] of Object.entries(lits)) {
      assert.equal(count(css[f], lit), n, `${f}: ${lit} count drifted (${n} allowed) - justify or use a var`);
    }
  }
  // context pins for the trickiest ones
  assert.match(style, /--on-accent: #0b0b0b;/, 'on-accent ink defined for dark');
  assert.equal((style.match(/--on-accent: #ffffff;/g) || []).length, 2, 'on-accent ink in BOTH light blocks');
  assert.match(style, /--amber: #e8c35a;/, 'amber defined for dark');
  assert.equal((style.match(/--amber: #8f6c00;/g) || []).length, 2, 'deep amber in BOTH light blocks');
});

test('colors: buttons/inks/status are var-driven in BOTH themes', () => {
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  const catalog = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  const social = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');

  assert.match(style, /\.btn \{[^}]*border: 1px solid var\(--border\)/, 'default button has a real rim');
  assert.match(style, /\.btn--primary \{[^}]*border-color: transparent/, 'primary stays solid');
  assert.match(style, /\.btn--secondary \{[^}]*color: var\(--on-accent\)/, 'secondary ink = on-accent (dark navy needs WHITE ink in light)');
  assert.match(style, /\.btn__spinner \{[^}]*border-top-color: currentColor/, 'spinner follows button ink');
  assert.equal((style.match(/color: var\(--on-accent\)/g) || []).length, 2, 'secondary btn + chat send both use on-accent');
  assert.match(catalog, /\.chip--active \{[^}]*color: var\(--bg\)/, 'active chip ink = inverse of current theme');
  assert.match(style, /\.toast--error \{[^}]*color: var\(--red\)/, 'error toast uses real red');
  assert.match(style, /\.host-chip \{[^}]*color: var\(--red\)/, 'host chip uses real red');
  assert.match(style, /\.peer-badge \{[^}]*color: var\(--blue\)/, 'peer badge uses real blue');
  assert.match(style, /\.chat-msg__author\.is-owner \{[^}]*color: var\(--red\)/, 'owner name uses real red');
  assert.match(style, /\.subs-panel__status--err \{[^}]*color: var\(--red\)/, 'subs error uses real red');
  assert.match(social, /\.presence--watching-party \{[^}]*color: var\(--green\)/, 'watching status uses real green');
  assert.match(social, /\.presence--idle \{[^}]*color: var\(--amber\)/, 'idle status uses themed amber');
  assert.match(social, /\.code-modal__chunk \{[^}]*color: var\(--green\)/, 'access code uses real green');
  assert.match(social, /\.code-modal__warn \{[^}]*color: var\(--amber\)/, 'code warning uses themed amber');
});

test('stylesheet duplication is BANNED (stale second copy once overrode every themed fix)', () => {
  const catalog = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  const social = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  // catalog was once ~2250 lines with the whole sheet pasted twice.
  // Anchored to top-level (column 0) rules: media-query overrides are
  // indented and legitimate.
  const countTop = (css, lit) => (css.match(new RegExp('^' + lit.replace(/[.*#{}]/g, '\\$&'), 'gm')) || []).length;
  for (const marker of ['/* ---- Top nav', '.topnav {', '.chip--active {', '.ep-btn {', '.modal__card {', ':root {']) {
    assert.equal(countTop(catalog, marker), 1, `catalog.css: "${marker}" appears once at top level (no duplicate generation)`);
  }
  assert.equal(count(catalog, 'rgba(15, 15, 15, 0.92)'), 1, 'topnav dark bg only as the var fallback');
  // Coarse backstop for the "whole sheet pasted twice" bug (that copy was
  // ~2250 lines), NOT a style budget — raised 1400 -> 1500 for the trailer
  // audio toggle, 1500 -> 1900 for the responsive TV tiers + title-logo rules,
  // 1900 -> 1960 for the small-art big box (.is-logo-big). The top-level marker
  // counts above are the real duplication detector.
  assert.ok(catalog.split('\n').length < 1960, 'catalog.css stays deduplicated');
  assert.equal(count(style, '.btn--primary {'), 1, 'style.css: no duplicate .btn--primary');
  assert.equal(count(social, '.presence--idle {'), 1, 'social.css: no duplicate .presence--idle');
});
