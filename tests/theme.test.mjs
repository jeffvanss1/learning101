// Theme: respect system dark/light by default, explicit pick in profile edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT } from './dompath.mjs';

test('theme: system dark/light respected by default, explicit override, profile toggle', async () => {
  const style = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  const social = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  const socialCss = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');

  // --- CSS: light palette exists for BOTH the explicit pick and the default ---
  assert.match(style, /html\[data-theme='light'\] \{/, 'explicit light theme block');
  assert.match(style, /@media \(prefers-color-scheme: light\) \{/, 'system light default block');
  assert.match(style, /html:not\(\[data-theme='dark'\]\) \{/, 'system default unless dark picked');
  assert.match(style, /^\s*color-scheme: dark;/m, 'color-scheme: dark declared');
  assert.equal((style.match(/^\s*color-scheme: light/gm) || []).length, 2, 'color-scheme: light in both light blocks');

  // Subtle fills are semantic vars now (flip direction in light mode).
  assert.equal((style.match(/--fill-med: rgba\(0, 0, 0/g) || []).length, 2, 'light fills defined in both light blocks');
  assert.equal(
    (style.match(/background: var\(--fill-(soft|med|strong)\)/g) || []).length,
    5,
    'ghost buttons + hovers + subs track use semantic fills'
  );
  assert.equal((style.match(/background: rgba\(255, 255, 255, 0\.0/g) || []).length, 0, 'no dark-only white-alpha backgrounds left');

  // Light surfaces must stay DISTINCT step-by-step (the "colors blend with
  // the same color" bug): page fff -> card f7 -> tile f1 -> hover dd.
  assert.equal((style.match(/--bg-elev: #f1f1f1;/g) || []).length, 2, 'elevated tile tone in BOTH light blocks');
  assert.equal((style.match(/--bg-elev: #ffffff;/g) || []).length, 0, '--bg-elev no longer equals the page background in light mode');
  assert.equal((style.match(/--bg-soft: #f7f7f7;/g) || []).length, 2, 'card tone distinct from page in both light blocks');

  // Header brand text must follow the theme, not stay white.
  assert.doesNotMatch(style, /color: #fff;\n  font-size: 18px;\n  font-weight: 700/, 'brand text is themed');

  // --- index.html: pre-paint application, before ANY script src ---
  assert.match(html, /wp:theme:explicit/, 'explicit theme storage key');
  assert.match(html, /document\.htmlElement|document\.documentElement\.setAttribute\('data-theme'/, 'applies data-theme pre-paint');
  const inlineIdx = html.indexOf('wp:theme:explicit');
  const firstSrc = html.indexOf('<script src=');
  assert.ok(firstSrc === -1 || inlineIdx < firstSrc, 'theme script runs BEFORE any external script (no flash)');
  assert.match(html, /name="theme-color" media="\(prefers-color-scheme: light\)" content="#ffffff"/, 'light theme-color meta');
  assert.match(html, /name="theme-color" media="\(prefers-color-scheme: dark\)" content="#0f0f0f"/, 'dark theme-color meta');

  // --- profile editor: System / Light / Dark, applied instantly ---
  assert.match(social, /const THEME_KEY = 'wp:theme:explicit'/, 'storage key in social.js');
  assert.match(social, /function themePref\(\)/, 'themePref reader');
  assert.match(social, /function applyThemePref\(pref\)/, 'themePref applier');
  assert.match(social, /h\('span', 'field__label', 'Theme'\)/, 'profile editor has a Theme field');
  assert.match(social, /'System \(auto\)'/, 'System option');
  assert.match(social, /\['light', 'Light'\]/, 'Light option');
  assert.match(social, /\['dark', 'Dark'\]/, 'Dark option');
  assert.match(social, /applyThemePref\(val\); \/\/ instant/, 'pick applies IMMEDIATELY (device setting, not save-gated)');
  assert.match(social, /global\.WP\.Social = \{\s*themePref,\s*applyThemePref,/, 'exported on WP.Social');

  // --- picker styles themed via vars ---
  assert.match(socialCss, /\.theme-picker__opt \{/, 'theme picker styles exist');
  assert.match(socialCss, /\.theme-picker__opt\.is-selected \{\s*border-color: var\(--blue\);/, 'selected state');
});

test('theme: no invisible tiles - every picker/poster-fallback tile has a rim', async () => {
  const socialCss = readFileSync(join(ROOT, 'dist/css/social.css'), 'utf8');
  const catalogCss = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');

  // frame + theme picker tiles: rimmed (was border: transparent -> blended
  // into the modal card), selected state still switches to --blue.
  assert.equal((socialCss.match(/border: 2px solid var\(--border\)/g) || []).length, 2, 'frame/theme picker tiles have a real rim');
  assert.doesNotMatch(socialCss, /\.frame-picker__opt \{[^}]*border: 2px solid transparent/, 'frame tiles no longer borderless');
  assert.doesNotMatch(socialCss, /\.theme-picker__opt \{[^}]*border: 2px solid transparent/, 'theme tiles no longer borderless');

  // poster fallback (no-poster placeholder) is visible on the card.
  assert.match(catalogCss, /\.card-item__poster-fallback \{[^}]*border: 1px solid var\(--border-soft\)/, 'poster fallback rimmed');
});
