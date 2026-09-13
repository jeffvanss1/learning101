// Subtitle pipeline contracts (feature: custom, auto-synced subtitles).
//
// Worker side (src/subs.js): SRT->VTT conversion, candidate ranking, query
// building. Client side (dist/js/subs.js): executes the REAL shipped bundle
// against fake PLAYER_EVENT postMessages and asserts the overlay renders the
// right cue at the right (offset-adjusted) time — the "auto-sync" core.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';
import {
  buildSearchQuery,
  fetchSubtitleVtt,
  parseTimestamp,
  formatVttTimestamp,
  toVtt,
  pickBest,
  shapeSearchResponse,
} from '../src/subs.js';

const SRT = `1
00:00:20,000 --> 00:00:22,400
Hello <i>world</i>

2
00:01:05,500 --> 00:01:08,000
Second cue
second line
`;

test('SRT -> WebVTT: timestamps, tag stripping, multi-line cues', () => {
  const vtt = toVtt('\uFEFF' + SRT);
  assert.notEqual(vtt, null);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:20.000 --> 00:00:22.400'), 'SRT comma timestamps must become VTT dots');
  assert.ok(vtt.includes('Hello world'), 'markup tags must be stripped');
  assert.ok(!vtt.includes('<i>'), 'no markup may survive');
  assert.ok(vtt.includes('00:01:05.500 --> 00:01:08.000'));
  assert.ok(vtt.includes('Second cue\nsecond line'), 'multi-line cue text preserved');
});

test('toVtt passes WebVTT through and rejects foreign formats', () => {
  const vtt = 'WEBVTT\n\n00:10.000 --> 00:12.000\nhi';
  assert.equal(toVtt(vtt), vtt.trim());
  assert.equal(toVtt('[Script Info]\nTitle: anime.ass'), null, '.ass must be rejected');
  assert.equal(toVtt(''), null);
});

test('timestamp round-trip', () => {
  assert.equal(parseTimestamp('01:02:03,456'), 3723.456);
  assert.equal(formatVttTimestamp(3723.456), '01:02:03.456');
  assert.equal(parseTimestamp('nope'), null);
});

test('search query: PARENT tmdb id for series (docs), own id for movies', () => {
  // OpenSubtitles docs: season_number/episode_number pair with
  // parent_tmdb_id — tmdb_id + season/episode returns wrong/empty results.
  const tv = new URLSearchParams(buildSearchQuery({ type: 'tv', tmdb: '94605', season: 3, episode: 7, lang: 'id' }));
  assert.equal(tv.get('parent_tmdb_id'), '94605', 'series must search by parent_tmdb_id');
  assert.equal(tv.get('tmdb_id'), null, 'tmdb_id must NOT be sent for series');
  assert.equal(tv.get('season_number'), '3');
  assert.equal(tv.get('episode_number'), '7');
  assert.equal(tv.get('languages'), 'id');
  const an = new URLSearchParams(buildSearchQuery({ type: 'anime', tmdb: '123', season: 1, episode: 1 }));
  assert.equal(an.get('parent_tmdb_id'), '123', 'anime follows the series rules');
  const mv = new URLSearchParams(buildSearchQuery({ type: 'movie', tmdb: '420818' }));
  assert.equal(mv.get('tmdb_id'), '420818', 'movies keep their own tmdb_id');
  assert.equal(mv.get('parent_tmdb_id'), null, 'movies must not carry a parent id');
  assert.equal(mv.get('season_number'), null, 'movies must not carry season/episode params');
});

test('pickBest prefers real dialogue over machine/foreign-only, then popularity', () => {
  const best = pickBest([
    { files: [{ file_id: 1 }], attributes: { ai_translated: true, download_count: 999_999, feature_details: { frame_rate: 23.976 } } },
    { files: [{ file_id: 2 }], attributes: { foreign_parts_only: true, download_count: 500_000 } },
    { files: [{ file_id: 3 }], attributes: { download_count: 12_000, feature_details: { frame_rate: 23.976 } } },
    { files: [{ file_id: 4 }], attributes: { download_count: 11_000 } },
    { attributes: { download_count: 999_999 } }, // no file -> ignored
  ]);
  assert.equal(best.fileId, 3, 'clean 23.976 release with high downloads must win');
});

test('shapeSearchResponse caps the candidate list and maps fields', () => {
  const payload = {
    data: Array.from({ length: 30 }, (_, i) => ({
      files: [{ file_id: i + 1 }],
      attributes: { language: 'en', download_count: i, title: 'T' + i },
    })),
  };
  const shaped = shapeSearchResponse(payload);
  assert.equal(shaped.length, 12, 'candidate list must be capped');
  assert.equal(shaped[0].fileId, 1);
  assert.equal(shaped[0].lang, 'en');
});

test('download quota exhaustion surfaces a plain-language error', async () => {
  globalThis.fetch = () =>
    Promise.resolve({ ok: false, status: 406, json: async () => ({}) });
  let message = '';
  try {
    await fetchSubtitleVtt(1, 'key', null);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.ok(message.includes('daily download limit'), 'quota errors must be plain-language: ' + message);
  assert.ok(message.includes('cached'), 'the error must mention cached subs keep working');
});

// ---- client bundle runtime smoke -------------------------------------------

const El2 = class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.classList = {
      add: (c) => (this._cls || (this._cls = new Set())).add(c),
      remove: (c) => this._cls && this._cls.delete(c),
      contains: (c) => !!(this._cls && this._cls.has(c)),
      toggle() {},
    };
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  setAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  get offsetWidth() {
    return 0;
  }
};

function findClass(root, cls) {
  if (root.className === cls) return root;
  for (const c of root.children || []) {
    const hit = findClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

/**
 * Fresh module + DOM stubs (a new import path gives a new module instance,
 * so each runtime test starts from clean state).
 */
async function freshSubs() {
  class El {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.hidden = false;
      this.textContent = '';
      this.className = '';
      this.classList = {
        add: (c) => (this._cls || (this._cls = new Set())).add(c),
        remove: (c) => this._cls && this._cls.delete(c),
        contains: (c) => !!(this._cls && this._cls.has(c)),
        toggle() {},
      };
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
    setAttribute() {}
    addEventListener() {}
    removeEventListener() {}
    get offsetWidth() {
      return 0;
    }
  }

  const store = {};
  const listeners = {};
  const rafQueue = [];
  globalThis.window = {
    WP: {},
    addEventListener: (type, fn) => ((listeners[type] || (listeners[type] = [])).push(fn)),
    removeEventListener() {},
    dispatchEvent() {},
    requestAnimationFrame: (cb) => (rafQueue.push(cb), rafQueue.length),
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    __fire: (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev)),
  };
  const doc = {
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelectorAll: () => [],
    documentElement: new El('html'),
    body: new El('body'),
    addEventListener() {},
    readyState: 'complete',
    hidden: false,
  };
  globalThis.document = doc;
  globalThis.location = { search: '' };
  globalThis.localStorage = globalThis.window.localStorage;
  Object.assign(globalThis.window, { document: doc, location: globalThis.location, localStorage: globalThis.localStorage });
  const mod = await import(join(ROOT, 'dist/js/subs.js') + '?v=' + Math.random());
  return { Subs: globalThis.window.WP.Subs, listeners, rafQueue, store, El };
}

const fireClock = (listeners, rafQueue, t, playing = true) => {
  (listeners.message || []).forEach((fn) =>
    fn({ source: {}, data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime: t, playing } } })
  );
  rafQueue.splice(0).forEach((cb) => cb());
};

test('tap-sync computes the offset from the player clock, exactly', async () => {
  const { Subs, listeners, rafQueue, store } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.loadCues('1\n00:00:10,000 --> 00:00:12,000\nWhere are you?\n');

  // Player reports 11.3s. The user taps the moment they hear "Where are you?"
  // (cue starts at 10s) -> offset must be exactly +1.3s.
  fireClock(listeners, rafQueue, 11.3);
  Subs.armTapSync();
  Subs.tapSync();
  assert.equal(Subs.__test.state().offset, 1.3, 'offset = playerTime(atTap) - cueStart');

  // The nudge must be persisted for the title.
  // (loadCues without setVideo -> videoKey 'none' -> persisted under that key)
  assert.ok(Object.keys(store).length >= 1, 'offset must be persisted to localStorage');

  // With the offset applied, a clock of 11.4 displays as 10.1 -> cue visible.
  fireClock(listeners, rafQueue, 11.4);
  await new Promise((r) => setTimeout(r, 5));
  rafQueue.splice(0).forEach((cb) => cb());
  const overlay = findClass(wrap, 'subs-overlay');
  assert.equal(overlay.children[0].textContent, 'Where are you?');
});

test('language fallback: id -> en -> any, and the status says what loaded', async () => {
  const calls = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/api/subs/search')) {
      if (u.includes('lang=id')) {
        return Promise.resolve({ ok: true, json: async () => ({ results: [], best: null }) });
      }
      if (u.includes('lang=en')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ results: [{ files: [{ file_id: 9 }] }], best: { fileId: 9, release: 'Rel.ENG', lang: 'en', downloads: 5000 } }),
        });
      }
    }
    if (u.includes('/api/subs/file')) {
      return Promise.resolve({ ok: true, text: async () => '1\n00:00:10,000 --> 00:00:12,000\nFallback cue\n' });
    }
    return Promise.reject(new Error('unexpected ' + u));
  };

  const { Subs, listeners, rafQueue } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.loadCues('1\n00:00:05,000 --> 00:00:06,000\nwarmup\n'); // enable subs (like a returning user)
  Subs.__test.setLang('id');
  Subs.setVideo({ type: 'movie', id: '42' }); // enabled -> next-episode auto-load fires
  await new Promise((r) => setTimeout(r, 30)); // auto-load chain resolves

  const searchCalls = calls.filter((u) => u.includes('/api/subs/search'));
  assert.ok(searchCalls.some((u) => u.includes('lang=id')), 'must try the requested language first');
  assert.ok(searchCalls.some((u) => u.includes('lang=en')), 'must fall back to English');
  assert.equal(Subs.__test.state().cues, 1, 'English fallback subs must load');
  assert.ok(Subs.__test.state().status.includes('Bahasa Indonesia') === false, 'loaded label reflects the actual language');
  assert.ok(Subs.__test.state().status.toLowerCase().includes('rel.eng') || Subs.__test.state().status.includes('Rel.ENG'), 'status names the loaded release');
});

const FRESH_SRT = `1
00:00:10,000 --> 00:00:12,000
Auto-synced cue
`;

test('subs.js overlay follows the player clock and the offset (runtime)', async () => {
  // --- DOM stubs (window/document/location/message registry/rAF) -----------
  class El {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.hidden = false;
      this.textContent = '';
      this.className = '';
      this.classList = {
        add: (c) => (this._cls || (this._cls = new Set())).add(c),
        remove: (c) => this._cls && this._cls.delete(c),
        contains: (c) => !!(this._cls && this._cls.has(c)),
        toggle() {},
      };
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
    setAttribute() {}
    addEventListener() {}
    removeEventListener() {}
    get offsetWidth() {
      return 0;
    }
  }

  const store = {};
  const listeners = {};
  const rafQueue = [];
  globalThis.window = {
    WP: {},
    addEventListener: (type, fn) => ((listeners[type] || (listeners[type] = [])).push(fn)),
    removeEventListener() {},
    dispatchEvent() {},
    requestAnimationFrame: (cb) => (rafQueue.push(cb), rafQueue.length),
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    __fire: (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev)),
  };
  const doc = {
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelectorAll: () => [],
    documentElement: new El('html'),
    body: new El('body'),
    addEventListener() {},
    readyState: 'complete',
    hidden: false,
  };
  globalThis.document = doc;
  globalThis.location = { search: '' };
  globalThis.localStorage = globalThis.window.localStorage; // bare-id access in subs.js
  Object.assign(globalThis.window, { document: doc, location: globalThis.location, localStorage: globalThis.localStorage });

  await import(join(ROOT, 'dist/js/subs.js'));
  assert.ok(globalThis.window.WP.Subs, 'subs.js must register WP.Subs');
  const Subs = globalThis.window.WP.Subs;

  const wrap = new El('div');
  Subs.mount(wrap);
  const overlay = wrap.children.find((c) => c.className === 'subs-overlay');
  const text = overlay.children[0];
  assert.ok(overlay, 'mount must create the overlay');

  Subs.loadCues(FRESH_SRT); // enables the overlay + starts the loop
  assert.ok(overlay.style.display !== 'none', 'loading cues must enable the overlay');

  // Player reports t=10.5s, playing → the cue (10s..12s) must show.
  globalThis.window.__fire('message', {
    source: {},
    data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime: 10.5, playing: true } },
  });
  rafQueue.splice(0).forEach((cb) => cb());
  await new Promise((r) => setTimeout(r, 5));
  rafQueue.splice(0).forEach((cb) => cb());
  assert.equal(text.textContent, 'Auto-synced cue', 'cue must render at t=10.5');

  // +1s offset => display time runs 1s behind => cue hidden at 10.5s, shown at 11.2s.
  globalThis.fetch = () =>
    Promise.resolve({ ok: true, json: async () => ({ best: null }) }); // autoLoad stub
  store['wp:suboff:movie|1|10|2'] = '1'; // what setVideo() would load
  Subs.setVideo({ type: 'movie', id: '1', season: 10, episode: 2 });
  await new Promise((r) => setTimeout(r, 5));
  Subs.loadCues(FRESH_SRT);

  const fire = (t) => {
    globalThis.window.__fire('message', {
      source: {},
      data: { type: 'PLAYER_EVENT', data: { event: 'playerstatus', currentTime: t, playing: true } },
    });
    rafQueue.splice(0).forEach((cb) => cb());
  };
  fire(10.5);
  await new Promise((r) => setTimeout(r, 5));
  rafQueue.splice(0).forEach((cb) => cb());
  assert.equal(text.textContent, '', 'a +1s persisted offset must delay the cue');

  fire(11.2); // display time 10.2 -> inside the cue again
  await new Promise((r) => setTimeout(r, 5));
  rafQueue.splice(0).forEach((cb) => cb());
  assert.equal(text.textContent, 'Auto-synced cue', 'cue must reappear once playback passes (start + offset)');
});
