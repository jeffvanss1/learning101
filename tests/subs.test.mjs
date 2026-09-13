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

test('search query: episode-precise for series, none for movies', () => {
  const tv = new URLSearchParams(buildSearchQuery({ type: 'tv', tmdb: '94605', season: 3, episode: 7, lang: 'id' }));
  assert.equal(tv.get('tmdb_id'), '94605');
  assert.equal(tv.get('season_number'), '3');
  assert.equal(tv.get('episode_number'), '7');
  assert.equal(tv.get('languages'), 'id');
  const mv = new URLSearchParams(buildSearchQuery({ type: 'movie', tmdb: '420818' }));
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

// ---- client bundle runtime smoke -------------------------------------------

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
