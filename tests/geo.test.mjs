// Geo-language contracts (feature: render the UI + TMDB content in the
// visitor's country language).
//
// - src/geo.js is the SINGLE source of the country→language map: the worker
//   uses it to localize the TMDB proxy (?language=xx-CC) and to inject
//   window.WP_GEO into every HTML response.
// - dist/js/i18n.js ships the UI dictionaries; every language must define the
//   same key set as English, and every data-i18n key used in index.html must
//   exist in the English dictionary (missing keys silently show English).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';
import {
  SUPPORTED_UI_LANGS,
  COUNTRY_LANG,
  parseAcceptLanguage,
  resolveGeo,
  injectGeoScript,
} from '../src/geo.js';

test('country map is well-formed (2-letter codes, known languages)', () => {
  for (const [country, lang] of Object.entries(COUNTRY_LANG)) {
    assert.match(country, /^[A-Z]{2}$/, `bad country code: ${country}`);
    assert.match(lang, /^[a-z]{2}$/, `bad language code for ${country}: ${lang}`);
  }
  assert.equal(COUNTRY_LANG.ID, 'id', 'Indonesia must resolve to Indonesian');
  assert.equal(COUNTRY_LANG.BR, 'pt');
  assert.equal(COUNTRY_LANG.SA, 'ar');
});

test('resolveGeo: ID gets Indonesian UI + localized TMDB content', () => {
  const geo = resolveGeo('ID', null, null);
  assert.equal(geo.uiLang, 'id');
  assert.equal(geo.tmdbLang, 'id-ID');
  assert.equal(geo.source, 'country');
});

test('resolveGeo: unsupported-UI country localizes CONTENT, chrome stays English', () => {
  const geo = resolveGeo('DE', 'en-US,en;q=0.9', null);
  assert.equal(geo.uiLang, 'en', 'no German UI dictionary yet');
  assert.equal(geo.tmdbLang, 'de-DE', 'but TMDB titles/overviews come back German');
});

test('resolveGeo: Accept-Language is the fallback when the country is unknown', () => {
  const geo = resolveGeo(undefined, 'fr-CA,fr;q=0.9,en;q=0.8', null);
  assert.equal(geo.uiLang, 'fr');
  assert.equal(geo.tmdbLang, 'fr');
  assert.equal(geo.source, 'accept-language');
});

test('resolveGeo: explicit override wins and is validated', () => {
  assert.equal(resolveGeo('ID', null, 'en').uiLang, 'en', '?lang=en must beat the country');
  const bad = resolveGeo('ID', null, 'zz');
  assert.equal(bad.uiLang, 'id', 'unknown override is ignored');
  assert.equal(new Set(SUPPORTED_UI_LANGS).size, SUPPORTED_UI_LANGS.length, 'no duplicate langs');
});

test('injectGeoScript embeds valid JSON before </head>', () => {
  const html = '<html><head><title>t</title></head><body></body></html>';
  const out = injectGeoScript(html, { country: 'ID', uiLang: 'id', tmdbLang: 'id-ID' });
  const m = /<script>window\.WP_GEO=(\{.*?\});<\/script><\/head>/.exec(out);
  assert.notEqual(m, null, 'geo script must be injected before </head>');
  assert.deepEqual(JSON.parse(m[1]), { country: 'ID', uiLang: 'id', tmdbLang: 'id-ID' });
  assert.equal(injectGeoScript('<body>no head</body>', { country: null, uiLang: 'en', tmdbLang: 'en-US' }), '<body>no head</body>');
});

test('i18n dictionaries: every language defines exactly the English key set', () => {
  const src = readFileSync(join(ROOT, 'dist/js/i18n.js'), 'utf8');
  const keys = {};
  for (const lang of SUPPORTED_UI_LANGS) {
    const blockRe = new RegExp('  ' + lang + ': \\{([\\s\\S]*?)\\n  \\}');
    const m = blockRe.exec(src);
    assert.notEqual(m, null, `dictionary '${lang}' missing from i18n.js`);
    keys[lang] = new Set([...m[1].matchAll(/'([A-Za-z0-9.]+)':/g)].map((x) => x[1]));
  }
  const en = keys.en;
  assert.ok(en.size >= 30, 'the English dictionary should cover the chrome (' + en.size + ' keys)');
  for (const lang of SUPPORTED_UI_LANGS) {
    assert.deepEqual(keys[lang], en, `dictionary '${lang}' keys must match English exactly`);
  }
});

test('every data-i18n / data-i18n-placeholder key in index.html exists in the dictionary', () => {
  const src = readFileSync(join(ROOT, 'dist/js/i18n.js'), 'utf8');
  const enBlock = /  en: \{([\s\S]*?)\n  \}/.exec(src);
  assert.notEqual(enBlock, null);
  const dict = new Set([...enBlock[1].matchAll(/'([A-Za-z0-9.]+)':/g)].map((x) => x[1]));
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  const used = new Set([
    ...[...html.matchAll(/data-i18n="([A-Za-z0-9.]+)"/g)].map((x) => x[1]),
    ...[...html.matchAll(/data-i18n-placeholder="([A-Za-z0-9.]+)"/g)].map((x) => x[1]),
  ]);
  assert.ok(used.size >= 20, 'expected substantial data-i18n coverage, got ' + used.size);
  for (const key of used) {
    assert.ok(dict.has(key), `data-i18n key '${key}' is used in index.html but missing from the en dictionary`);
  }
});
