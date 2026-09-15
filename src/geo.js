// geo.js — IP-country → language resolution for the Cloudflare edge.
//
// Cloudflare exposes `request.cf.country` on every request (derived from the
// client IP at the edge — no IP database, no external API). This module maps
// that country to:
//   1. a UI language  — used by the frontend dictionaries (dist/js/i18n.js)
//                       when the language is one we ship translations for;
//   2. a TMDB locale  — `<lang>-<COUNTRY>`, appended to every /api/tmdb
//                       proxy call so MOVIE TITLES AND OVERVIEWS come back
//                       localized even for languages without UI translations
//                       (e.g. a German IP gets German titles, English chrome).
//
// Resolution priority (see resolveGeo):
//   explicit override ('?lang=' — validated)  >  IP country  >  Accept-Language
//   >  'en'.
//
// Plain JS (like WatchRoom.js / anilist.js) so node --test can import the
// exact logic the worker runs.

// @ts-check

/** UI languages we ship dictionaries for (dist/js/i18n.js must match). */
export const SUPPORTED_UI_LANGS = ['en', 'id', 'es', 'fr', 'pt', 'ar'];

/** RTL scripts get `dir="rtl"` applied by i18n.js when the UI lang is one of these. */
export const RTL_UI_LANGS = ['ar'];

/**
 * Country (ISO 3166-1 alpha-2) → primary spoken language (ISO 639-1 base).
 * Drives both the UI dictionary choice (when in SUPPORTED_UI_LANGS) and the
 * TMDB content locale. Countries not listed resolve via Accept-Language, then
 * 'en'.
 * @type {Record<string, string>}
 */
export const COUNTRY_LANG = {
  // Southeast Asia
  ID: 'id', MY: 'ms', SG: 'en', TH: 'th', VN: 'vi', PH: 'en',
  // East Asia
  JP: 'ja', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh',
  // South Asia
  IN: 'hi', PK: 'ur', BD: 'bn',
  // Middle East (Arabic belt + Israel)
  SA: 'ar', AE: 'ar', EG: 'ar', DZ: 'ar', MA: 'ar', TN: 'ar', IQ: 'ar',
  JO: 'ar', LB: 'ar', SY: 'ar', YE: 'ar', OM: 'ar', KW: 'ar', QA: 'ar',
  BH: 'ar', IL: 'he', IR: 'fa',
  // Europe
  TR: 'tr', RU: 'ru', UA: 'uk', PL: 'pl', DE: 'de', AT: 'de', CH: 'de',
  FR: 'fr', BE: 'nl', NL: 'nl', IT: 'it', ES: 'es', PT: 'pt',
  SE: 'sv', NO: 'no', DK: 'da', FI: 'fi', IS: 'is',
  EE: 'et', LV: 'lv', LT: 'lt', CZ: 'cs', SK: 'sk', HU: 'hu', RO: 'ro',
  BG: 'bg', GR: 'el', HR: 'hr', RS: 'sr', SI: 'sl',
  // Americas
  US: 'en', CA: 'en', MX: 'es', BR: 'pt', AR: 'es', CL: 'es', CO: 'es',
  PE: 'es', VE: 'es', EC: 'es', BO: 'es', PY: 'es', UY: 'es',
  CR: 'es', PA: 'es', CU: 'es', DO: 'es', GT: 'es',
  // Africa / Oceania
  ZA: 'en', NG: 'en', KE: 'en', GH: 'en', AU: 'en', NZ: 'en',
};

/** @param {string} [code] @returns {string | null} normalized 2-letter country */
function normCountry(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/**
 * "fr-CA,fr;q=0.9,en;q=0.8" → ['fr', 'en'] (base tags, quality order).
 * @param {string | null} header
 * @returns {string[]}
 */
export function parseAcceptLanguage(header) {
  if (!header) return [];
  return String(header)
    .split(',')
    .map((part) => {
      const tag = part.split(';')[0].trim().toLowerCase();
      const base = tag.split('-')[0];
      return /^[a-z]{2}$/.test(base) ? base : '';
    })
    .filter((base, i, all) => base && all.indexOf(base) === i);
}

/**
 * Resolve the locale for a request.
 * @param {string | undefined} cfCountry  request.cf?.country (undefined in local dev)
 * @param {string | null} acceptLanguage  request.headers.get('accept-language')
 * @param {string | null} override       '?lang=' value (must be a SUPPORTED_UI_LANG)
 * @returns {{ country: string | null, uiLang: string, tmdbLang: string, source: string }}
 */
export function resolveGeo(cfCountry, acceptLanguage, override) {
  const country = normCountry(cfCountry);

  // 1. Explicit override — only ever to a language we actually ship.
  const ov = String(override || '').trim().toLowerCase();
  if (SUPPORTED_UI_LANGS.indexOf(ov) !== -1) {
    return {
      country: country,
      uiLang: ov,
      tmdbLang: country ? ov + '-' + country : ov,
      source: 'override',
    };
  }

  // 2. IP country. The mapped language drives TMDB content for EVERY mapped
  //    country; the UI only localizes when we ship a dictionary for it.
  const mapped = country ? COUNTRY_LANG[country] || null : null;
  if (mapped) {
    const uiLang = SUPPORTED_UI_LANGS.indexOf(mapped) !== -1 ? mapped : 'en';
    return {
      country: country,
      uiLang: uiLang,
      tmdbLang: mapped + '-' + country,
      source: 'country',
    };
  }

  // 3. Browser languages (travelers on unmapped countries, local dev where
  //    request.cf is absent).
  for (const base of parseAcceptLanguage(acceptLanguage)) {
    if (SUPPORTED_UI_LANGS.indexOf(base) !== -1) {
      return { country: country, uiLang: base, tmdbLang: base, source: 'accept-language' };
    }
  }

  // 4. Default.
  return { country: country, uiLang: 'en', tmdbLang: 'en-US', source: 'default' };
}

/**
 * Inject `window.WP_GEO` into the served HTML (before </head>) so the UI
 * knows the locale with zero extra round-trips. Returns the input unchanged
 * when there is no head to inject into.
 * @param {string} html
 * @param {{ country: string | null, uiLang: string, tmdbLang: string }} geo
 * @returns {string}
 */
export function injectGeoScript(html, geo) {
  const marker = '</head>';
  if (html.indexOf(marker) === -1) return html;
  const payload = JSON.stringify({
    country: geo.country,
    uiLang: geo.uiLang,
    tmdbLang: geo.tmdbLang,
  });
  const script = '<script>window.WP_GEO=' + payload + ';</script>';
  return html.replace(marker, script + marker);
}
