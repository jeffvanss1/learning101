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
  buildWyzieSearchUrl,
  wyzieExtractList,
  wyzieHostPolicy,
  decodeWyzieToken,
  encodeWyzieToken,
  fetchSubtitleVtt,
  fetchWyzieVtt,
  parseTimestamp,
  formatVttTimestamp,
  toVtt,
  pickBest,
  shapeSearchResponse,
  shapeWyzieResults,
  fetchWyzieMultiSource,
  composeWyzieNote,
  WYZIE_FREE_SOURCES,
  parseWyzieSources,
  fetchWyzieAvailableSources,
  wyzieFanSources,
  wyzieSearchCacheKey,
  WYZIE_TV_ONLY_SOURCES,
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
  assert.equal(tv.get('type'), 'episode', 'series must send type=episode (missing type => 0 results since 2025-07)');
  assert.equal(tv.get('parent_tmdb_id'), '94605', 'series must search by parent_tmdb_id');
  assert.equal(tv.get('tmdb_id'), null, 'tmdb_id must NOT be sent for series');
  assert.equal(tv.get('season_number'), '3');
  assert.equal(tv.get('episode_number'), '7');
  assert.equal(tv.get('languages'), 'id');
  const an = new URLSearchParams(buildSearchQuery({ type: 'anime', tmdb: '123', season: 1, episode: 1 }));
  assert.equal(an.get('type'), 'episode', 'anime follows the series rules (type=episode)');
  assert.equal(an.get('parent_tmdb_id'), '123', 'anime follows the series rules');
  const mv = new URLSearchParams(buildSearchQuery({ type: 'movie', tmdb: '420818' }));
  assert.equal(mv.get('type'), 'movie', 'movies must send type=movie (missing type => 0 results since 2025-07)');
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


// ---- Wyzie provider (primary) ----------------------------------------------

const WY = {
  id: '1955024019',
  url: 'https://sub.wyzie.io/c/198e0c4d/id/1955024019?format=srt&encoding=UTF-8',
  format: 'srt',
  display: 'English',
  language: 'en',
  media: 'The Martian',
  isHearingImpaired: false,
  source: 'subf2m',
  release: 'The.Martian.2015.1080p.WEB-DL',
  fileName: 'the.martian.2015.1080p.web-dl.srt',
  downloadCount: 4321,
  ai: false,
};

test('Wyzie search URL: TMDB id, season+episode, language, srt, all sources, key only when given', () => {
  const u = new URL(buildWyzieSearchUrl({ tmdb: '286217', season: 1, episode: 2, lang: 'id', key: 'K' }));
  assert.equal(u.origin + u.pathname, 'https://sub.wyzie.io/search');
  assert.equal(u.searchParams.get('id'), '286217');
  assert.equal(u.searchParams.get('season'), '1');
  assert.equal(u.searchParams.get('episode'), '2');
  assert.equal(u.searchParams.get('language'), 'id');
  assert.equal(u.searchParams.get('format'), 'srt');
  assert.equal(u.searchParams.get('source'), 'all', 'aggregate sources; gated OS urls are dropped at shaping');
  assert.equal(u.searchParams.get('key'), 'K');
  const noKey = new URL(buildWyzieSearchUrl({ tmdb: '286217' }));
  assert.equal(noKey.searchParams.get('key'), null, 'the echo must never embed the key');
  const mv = new URL(buildWyzieSearchUrl({ tmdb: '420818' }));
  assert.equal(mv.searchParams.get('season'), null, 'movies carry no season/episode');
});

test('host policy: fetchable / gated / foreign (live-learned)', () => {
  assert.equal(wyzieHostPolicy('https://sub.wyzie.io/c/x?format=srt'), 'fetchable');
  assert.equal(wyzieHostPolicy('https://dl.wyzie.io/files/a.srt'), 'fetchable');
  assert.equal(wyzieHostPolicy('https://www.subf2m.co.uk/download/a'), 'fetchable', 'Subf2M source host');
  assert.equal(wyzieHostPolicy('https://dl.opensubtitles.org/a.srt'), 'gated', 'observed 401 live');
  assert.equal(wyzieHostPolicy('https://dl.opensubtitles.com/a.srt'), 'gated', 'com twin');
  assert.equal(wyzieHostPolicy('http://sub.wyzie.io/a.srt'), 'foreign', 'https only');
  assert.equal(wyzieHostPolicy('https://evil.example/a.srt'), 'foreign');
  assert.equal(wyzieHostPolicy('https://evil.wyzie.io.evil.example/a.srt'), 'foreign', 'suffix tricks rejected');
  assert.equal(wyzieHostPolicy('https://dl.opensubtitles.org.evil.example/a.srt'), 'foreign');
  assert.equal(wyzieHostPolicy('https://github.com/opensubtitles.org'), 'foreign', 'suffix must match the HOST tail');
  assert.equal(wyzieHostPolicy('not a url'), 'foreign');
});

test('shaping reports dropped records with the reason (fields vs host)', () => {
  const good = { id: '1', url: 'https://sub.wyzie.io/c/a?format=srt', release: 'G', downloadCount: 5 };
  const shaped = shapeWyzieResults([
    { code: 401, message: 'x' }, // no url/id -> fields
    { id: '2', url: 'https://cdn.otherhost.net/a.srt' }, // foreign host (not on the allowlist)
    good,
  ]);
  assert.equal(shaped.results.length, 1);
  assert.ok(shaped.shape.includes('dropped:2'), 'drop line must appear: ' + shaped.shape);
  assert.ok(shaped.shape.includes('(fields:1)'), shaped.shape);
  assert.ok(shaped.shape.includes('(host:1@cdn.otherhost.net)'), shaped.shape);
});

test('Wyzie wrapper tolerance: arrays, wrapped objects and error objects', () => {
  const rec = { id: '1', url: 'https://sub.wyzie.io/c/a?format=srt', release: 'R' };
  assert.equal(wyzieExtractList([rec]).shape, 'array');
  assert.equal(wyzieExtractList([rec]).list.length, 1);
  const wrapped = wyzieExtractList({ results: [rec] });
  assert.equal(wrapped.shape, 'object:results');
  assert.equal(wrapped.list.length, 1);
  const err = wyzieExtractList({ code: 401, message: 'API key required' });
  assert.equal(err.shape, 'error:401');
  assert.equal(err.list.length, 0);
  assert.equal(wyzieExtractList('nope').shape, 'string');
  // and the shaper consumes a WRAPPED payload end-to-end:
  const shaped = shapeWyzieResults({ results: [rec] });
  assert.equal(shaped.results.length, 1);
  assert.equal(shaped.best.release, 'R');
});

test('Wyzie token round-trips; foreign hosts are rejected (no open proxy)', () => {
  const tok = encodeWyzieToken(WY.url);
  assert.equal(decodeWyzieToken(tok), WY.url);
  assert.equal(decodeWyzieToken(encodeWyzieToken('https://evil.example/x.srt')), null);
  assert.equal(decodeWyzieToken('http://sub.wyzie.io/a.srt'.slice(0, 0) + '!!!'), null);
  assert.equal(decodeWyzieToken(encodeWyzieToken('http://sub.wyzie.io/a.srt')), null, 'https only');
  assert.ok(decodeWyzieToken(encodeWyzieToken('https://dl.wyzie.io/a.srt')), '*.wyzie.io file hosts decode');
});

test('Wyzie shaping ranks human > AI, clean > HI, then downloads; best carries an opaque token', () => {
  const { results, best } = shapeWyzieResults([
    { ...WY, id: '1', ai: true, downloadCount: 999_999 },
    { ...WY, id: '2', isHearingImpaired: true, downloadCount: 500_000 },
    { ...WY, id: '3' }, // clean human, 4321 downloads -> winner
    { url: 'https://evil.example/a.srt', id: '4', downloadCount: 9_999_999 }, // non-allowlisted -> never a candidate
  ]);
  assert.equal(best.fileId, encodeWyzieToken(WY.url));
  assert.equal(results.length, 3, 'non-allowlisted urls must not become candidates');
  assert.equal(best.release, 'The.Martian.2015.1080p.WEB-DL');
  assert.equal(best.machineTranslated, false);
  assert.ok(!best._score, 'ranking bookkeeping must not leak into the response');
  // order: human-clean (3) first
  assert.equal(results[0].downloads, 4321);
});

test('LIVE field report replay: 65 gated dl.opensubtitles.org records drop cleanly', async () => {
  const recs = Array.from({ length: 65 }, (_, i) => ({
    id: String(i),
    url: 'https://dl.opensubtitles.org/download/' + i + '?format=srt',
    release: 'Rel.' + i,
    language: 'en',
    downloadCount: i,
    ai: false,
    isHearingImpaired: false,
  }));
  const { results, best, shape } = shapeWyzieResults(recs);
  assert.equal(results.length, 0, 'gated records must not become candidates (they 401 on fetch)');
  assert.equal(best, null);
  assert.ok(shape.includes('dropped:65'), shape);
  assert.ok(shape.includes('(gated:65)'), shape);
  // ...which routes the title to the authenticated OpenSubtitles fallback.
});

test('LIVE 2026-09-14: gated charlie URLs rewrite to the Wyzie proxy and FETCH', async () => {
  // Live probe (The Martian): the search returns raw dl.opensubtitles.org
  // urls of the shape .../vrf-<hash>/file/<id> (gated 401), but Wyzie's own
  // documented proxy path /c/<hash>/id/<id>?format=srt&encoding=UTF-8 serves
  // the SAME file publicly. Verified by hand before coding this.
  const recs = Array.from({ length: 20 }, (_, i) => ({
    id: String(1955024019 - i),
    url: 'https://dl.opensubtitles.org/en/download/subencoding-utf8/src-api/vrf-198e0c' + (40 + i) + '/file/' + (1955024019 - i),
    format: 'srt',
    encoding: 'UTF-8',
    display: 'English',
    language: 'en',
    media: 'The Martian',
    isHearingImpaired: false,
    source: 'charlie',
    release: 'The.Martian.2015.720p.BluRay.x264-SPARKS',
    fileName: 'The.Martian.2015.720p.BluRay.x264-SPARKS.srt',
    downloadCount: 1000000 - i,
    ai: false,
  }));
  const { results, best, shape } = shapeWyzieResults(recs);
  assert.equal(results.length, 12, 'rewritten records become candidates (cap 12)');
  assert.equal(shape.includes('gated'), false, 'no gated drops anymore: ' + shape);
  assert.ok(best, 'a best candidate exists');
  const url = decodeWyzieToken(best.fileId);
  assert.equal(
    url,
    'https://sub.wyzie.io/c/198e0c40/id/1955024019?format=srt&encoding=UTF-8',
    'fileId decodes to the documented proxy path'
  );
  let hit = '';
  globalThis.fetch = (u) => {
    hit = String(u);
    return Promise.resolve({
      ok: true,
      text: async () => '1\n00:00:00,000 --> 00:00:06,000\nMark just discovered dirt.\n',
    });
  };
  const { vtt } = await fetchWyzieVtt(best.fileId, null);
  assert.ok(hit.startsWith('https://sub.wyzie.io/c/198e0c40/id/1955024019'), 'worker fetches the PROXY url: ' + hit);
  assert.ok(vtt.includes('Mark just discovered dirt'), 'converts to VTT end-to-end');
});

test('fetchable source hosts (Subf2M) shape into candidates and fetch', async () => {
  const recs = Array.from({ length: 70 }, (_, i) => ({
    id: String(i),
    url: 'https://www.subf2m.co.uk/download/' + i + '?type=srt',
    release: 'Rel.' + i,
    language: 'en',
    downloadCount: i,
    ai: false,
    isHearingImpaired: false,
  }));
  const { results, best } = shapeWyzieResults(recs);
  assert.equal(results.length, 12);
  assert.ok(best && best.release === 'Rel.69', 'highest-download record ranked first');

  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nFetchable cue\n';
  globalThis.fetch = (url) => {
    assert.ok(String(url).startsWith('https://www.subf2m.co.uk/'));
    return Promise.resolve({ ok: true, text: async () => SRT });
  };
  const { vtt } = await fetchWyzieVtt(best.fileId, null);
  assert.ok(vtt.includes('Fetchable cue'));
});

test('fetchWyzieVtt converts the direct file to VTT and honors the allowlist', async () => {
  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nWyzie cue\n';
  globalThis.fetch = (url) => {
    assert.ok(String(url).startsWith('https://sub.wyzie.io/'), 'only allowlisted hosts may be fetched');
    return Promise.resolve({ ok: true, text: async () => SRT });
  };
  const tok = encodeWyzieToken('https://sub.wyzie.io/c/x/id/1?format=srt');
  const { vtt } = await fetchWyzieVtt(tok, null);
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('Wyzie cue'));
  await assert.rejects(fetchWyzieVtt(encodeWyzieToken('https://evil.example/a.srt'), null), /invalid subtitle token/);
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
  get firstChild() {
    return this.children[0] || null;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i !== -1) this.children.splice(i, 1);
    return c;
  }
  setAttribute() {}
  addEventListener(t, f) {
    (this._h || (this._h = {}))[t] = f; // recorded so tests can fire real handlers
  }
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
    get firstChild() {
      return this.children[0] || null;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      return c;
    }
    setAttribute() {}
    addEventListener(t, f) {
      (this._h || (this._h = {}))[t] = f; // recorded so tests can fire real handlers
    }
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

test('one-press sync (Shazam-style) snaps a cue to the tap instant, exactly', async () => {
  const { Subs, listeners, rafQueue, store } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.loadCues('1\n00:00:10,000 --> 00:00:12,000\nWhere are you?\n');

  // Player reports 11.3s. ONE press while a line is being spoken — no arming,
  // no reading a quoted line. Cue starts at 10s -> offset must be +1.3s.
  fireClock(listeners, rafQueue, 11.3);
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, 1.3, 'offset = playerTime(atTap) - cueStart');
  assert.ok(Subs.__test.state().status.includes('Synced'), 'status confirms: ' + Subs.__test.state().status);

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

test('one-press sync targets the NEXT upcoming line and re-snaps on repeat presses', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  Subs.mount(new El2());
  Subs.loadCues(
    '1\n00:00:10,000 --> 00:00:11,000\nFirst line\n\n' +
      '2\n00:00:20,000 --> 00:00:21,000\nSecond line\n'
  );

  // Speech starting at true 11.3s = the NEXT line in the file (starts 20s).
  // One press -> that line snaps to now: offset = 11.3 - 20 = -8.7s.
  fireClock(listeners, rafQueue, 11.3);
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, -8.7, 'next upcoming cue snapped to the tap instant');

  // Press again during later speech: re-snap updates the offset (self-correcting).
  fireClock(listeners, rafQueue, 12.0); // adjusted = 12.0 + 8.7 = 20.7 -> no cue >= 20.7 -> last (20)
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, -8.0, 'second press re-snapped');

  // No cues loaded: a press must not crash or change anything.
  const { Subs: Subs2 } = await freshSubs();
  Subs2.mount(new El2());
  Subs2.syncSnap();
  assert.equal(Subs2.__test.state().offset, 0, 'no cues -> no offset change');
  assert.ok(Subs2.__test.state().status.length > 0, 'tells the user why');
});

test('subtitle language crosses audio: defaults to geo locale, persists choice, live-reloads on switch', async () => {
  // English audio + Indonesian subs is a first-class path: the selector
  // defaults to the geo UI language (id for Indonesian users), the choice is
  // remembered across videos, and switching reloads immediately.
  const seenLangs = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/subs/search')) {
      const m = /[?&]lang=([^&]*)/.exec(u);
      seenLangs.push(m ? decodeURIComponent(m[1]) : '(none)');
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [{ fileId: 'ID1', release: 'Ganool.BluRay', lang: 'id', downloads: 4409, machineTranslated: false }],
          best: { fileId: 'ID1', release: 'Ganool.BluRay', lang: 'id', downloads: 4409 },
        }),
      });
    }
    if (u.includes('fileId=ID1')) {
      return Promise.resolve({ ok: true, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nMark baru saja menemukan kotoran\n' });
    }
    return Promise.reject(new Error('unexpected ' + u));
  };

  const { Subs, store } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.__test.setLang('id'); // like the geo default for an Indonesian user
  Subs.setVideo({ type: 'movie', id: '286217' }); // The Martian (English audio)
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seenLangs, ['id'], 'searched INDONESIAN subs for the English movie');
  assert.ok(Subs.__test.state().cues === 1, 'Indonesian cues loaded');

  // Switch to English in the selector -> the REAL change handler fires:
  // choice saved + immediate reload in the new language.
  const sel = findClass(wrap, 'subs-panel__select');
  assert.ok(sel && sel._h && sel._h.change, 'selector records a change handler');
  Subs.__test.setLang('en');
  sel._h.change();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store['wp:subslang'], 'en', 'choice persisted');
  assert.ok(seenLangs.indexOf('en') !== -1, 'reloaded in the new language: ' + seenLangs.join(','));
});

test('AUDIT: syncSnap refuses garbage — no clock yet, or tapped after the last cue', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  Subs.mount(new El2());
  Subs.loadCues('1\n00:00:10,000 --> 00:00:12,000\nOnly line\n');

  // No PLAYER_EVENT yet: now() is -1 -> a snap must NOT write a garbage offset.
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, 0, 'no clock -> offset untouched');
  assert.ok(Subs.__test.state().status.length > 0, 'tells the user why');

  // Playback running, but the tap lands AFTER the final cue ended (credits):
  // the old code snapped the last line to now (+minutes) and every cue
  // vanished into the past. Offset must stay put with a clear message.
  fireClock(listeners, rafQueue, 5000); // 83 minutes in; the cue ended long ago
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, 0, 'post-credits tap -> offset untouched');

  // A normal in-range tap still works.
  fireClock(listeners, rafQueue, 11.5);
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, 1.5, 'in-range snap unchanged by the guards');
});

test('AUDIT: Reset routes through the room-sync path (guests learn about it)', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  const offsets = [];
  Subs.onOffset((v) => offsets.push(v));
  Subs.loadCues('1\n00:00:10,000 --> 00:00:12,000\nLine\n');

  fireClock(listeners, rafQueue, 11.0);
  Subs.syncSnap();
  assert.equal(Subs.__test.state().offset, 1, 'synced +1 first');

  // Find the panel's Reset button (exact label text, per tr fallback).
  const findByText = (root, txt) => {
    if ((root.textContent || '') === txt) return root;
    for (const c of root.children || []) {
      const hit = findByText(c, txt);
      if (hit) return hit;
    }
    return null;
  };
  const panel = findClass(wrap, 'subs-panel');
  assert.ok(panel, 'panel rendered');
  const resetBtn = findByText(panel, 'Reset offset');
  assert.ok(resetBtn && resetBtn._h && resetBtn._h.click, 'reset button present with a handler');
  resetBtn._h.click();
  assert.equal(Subs.__test.state().offset, 0, 'offset zeroed');
  assert.ok(offsets.indexOf(0) !== -1, 'reset FIRED the room hook (host reset now reaches guests): ' + JSON.stringify(offsets));
});

test('AUDIT: Align releases its pick; bars carry ONLY the offset (no 2x)', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.loadCues(
    '1\n00:00:10,000 --> 00:00:11,000\nEarly line\n\n' +
      '2\n00:06:00,000 --> 00:06:01,000\nLater line\n'
  );

  const findBy = (root, cls) => {
    if (String(root.className || '').split(/\s+/).indexOf(cls) !== -1) return root;
    for (const c of root.children || []) {
      const hit = findBy(c, cls);
      if (hit) return hit;
    }
    return null;
  };
  const row = findBy(wrap, 'subs-editor');
  const bar = row.children[0];
  const ticksWrap = bar.children[0];
  const play = bar.children[1];
  const alignBtn = row.children[2];

  fireClock(listeners, rafQueue, 10.5);
  ticksWrap.children[0]._h.click();
  assert.equal(alignBtn.disabled, false, 'picked -> Align armed');
  alignBtn._h.click();
  assert.equal(Math.abs(Subs.__test.state().offset - 0.5) < 0.6, true, 'aligned');
  assert.equal(alignBtn.disabled, true, 'selection RELEASED after align');

  // Full timeline: at t=400 of span 361 the head is clamped at the right edge.
  fireClock(listeners, rafQueue, 400);
  for (let i = 0; i < 3 && rafQueue.length; i++) {
    rafQueue.splice(0).forEach((cb) => cb());
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.ok(parseFloat(play.style.left) > 95, 'head travelled to ~the end: ' + play.style.left);
  // Bars carry ONLY the offset (pps = 600/361): the 2x bug double-counted it.
  const x = parseFloat(String(ticksWrap.style.transform).replace(/[^-0-9.]/g, ''));
  assert.equal(Math.round(x), Math.round(Subs.__test.state().offset * (600 / 361)), 'transform == offset*pps exactly');
});

test('mini-map: full timeline, EVERY caption visible as a bar sized to its duration', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  // Two lines 40 minutes apart: BOTH visible at once (nothing "missed").
  Subs.loadCues(
    '1\n00:00:10,000 --> 00:00:11,000\nEarly line\n\n' +
      '2\n00:00:40:00,000 --> 00:00:40:01,000\nLater line\n'.replace(/00:00:40:00/g, '00:40:00').replace(/00:00:40:01/g, '00:40:01')
  );

  const findBy = (root, cls) => {
    if (String(root.className || '').split(/\s+/).indexOf(cls) !== -1) return root;
    for (const c of root.children || []) {
      const hit = findBy(c, cls);
      if (hit) return hit;
    }
    return null;
  };
  const row = findBy(wrap, 'subs-editor');
  const bar = row.children[0];
  const ticksWrap = bar.children[0];
  const play = bar.children[1];

  // Both captions drawn as BLOCKS on the full timeline (600px / 2401s).
  assert.equal(ticksWrap.children.length, 2, 'both captions drawn');
  const pps = 600 / 2401;
  assert.ok(Math.abs(parseFloat(ticksWrap.children[0].style.left) - 10 * pps) < 0.5, 'caption 1 bar at 10s');
  assert.ok(Math.abs(parseFloat(ticksWrap.children[0].style.width) - 1 * pps) < 0.5 || parseFloat(ticksWrap.children[0].style.width) === 2, 'caption 1 bar length = its 1s duration');
  assert.ok(Math.abs(parseFloat(ticksWrap.children[1].style.left) - 2400 * pps) < 0.5, 'caption 2 bar at 40:00');
  assert.ok(Math.abs(parseFloat(ticksWrap.children[1].style.width) - 1 * pps) < 0.5 || parseFloat(ticksWrap.children[1].style.width) === 2, 'caption 2 bar length = its 1s duration');

  // Head travels: hidden before any clock, then proportional to the span.
  assert.equal(play.style.display, 'none', 'no clock yet -> head hidden');
  fireClock(listeners, rafQueue, 1200); // mid-timeline
  for (let i = 0; i < 4 && rafQueue.length; i++) {
    rafQueue.splice(0).forEach((cb) => cb());
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal(play.style.display, 'block', 'head visible with the clock');
  const left = parseFloat(play.style.left);
  assert.ok(left > 40 && left < 60, 'head at ~50% of the FULL timeline at t=1200/2401: ' + play.style.left);

  // ALTERNATING PALETTE: adjacent bars always differ; exact user palette.
  assert.notEqual(ticksWrap.children[0].style.background, ticksWrap.children[1].style.background, 'adjacent bars differ in color');
  const sub = (await import('node:fs')).readFileSync(join(ROOT, 'dist/js/subs.js'), 'utf8');
  for (const hex of ['#5003C0', '#AB03A9', '#FF467A', '#FFD51E']) {
    assert.ok(sub.includes(hex), 'palette carries ' + hex);
  }

  // Manual match stays exact (file IO between clock and click shifts the
  // interpolated time - keep them adjacent; fired 2390 -> offset -10).
  fireClock(listeners, rafQueue, 2390);
  rafQueue.splice(0).forEach((cb) => cb());
  ticksWrap.children[1]._h.click(); // the 40:00 line
  row.children[2]._h.click(); // Align to playhead
  const off = Subs.__test.state().offset;
  assert.ok(Math.abs(off + 10) < 0.5, 'align snapped the 40:00 line to the playhead (now=2390): ' + off);
});

test('anime subs: tv/anime searches always carry season+episode (lima 400s without)', async () => {
  // Anime videos arrive with episode set but season null (catalog shape).
  // Wyzie requires season&episode TOGETHER -> default both, else anime never
  // gets subs (and the lima source hard-400s).
  const urls = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/subs/search')) {
      urls.push(u);
      return Promise.resolve({ ok: true, json: async () => ({ results: [], best: null }) });
    }
    return Promise.reject(new Error('unexpected ' + u));
  };
  const { Subs } = await freshSubs();
  Subs.mount(new El2());
  Subs.__test.setLang('id');
  Subs.setVideo({ type: 'anime', id: '31918', episode: 5 }); // season deliberately missing
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(urls.length >= 1, 'search fired');
  assert.ok(/[?&]season=1&episode=5/.test(urls[0]), 'S defaulted to 1, E preserved: ' + urls[0]);
  assert.ok(/[?&]type=tv/.test(urls[0]), 'anime searches as tv: ' + urls[0]);
});

test('room sync: onLoaded/onOffset fire locally; applyRemoteOffset does NOT echo', async () => {
  // app.js wires these: the HOST broadcasts what they load/match; clients
  // apply via loadRemote/applyRemoteOffset — which must not re-broadcast.
  let fileFetches = 0;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/subs/search')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [{ fileId: 'R1', release: 'Host.Pick', lang: 'id', downloads: 900, machineTranslated: false }],
          best: { fileId: 'R1', release: 'Host.Pick', lang: 'id', downloads: 900 },
        }),
      });
    }
    if (u.includes('fileId=R1')) {
      fileFetches++;
      return Promise.resolve({ ok: true, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nroom cue\n' });
    }
    if (u.includes('fileId=R2')) {
      fileFetches++;
      return Promise.resolve({ ok: true, text: async () => '1\n00:00:03,000 --> 00:00:04,000\nremote cue\n' });
    }
    return Promise.reject(new Error('unexpected ' + u));
  };

  const { Subs, listeners, rafQueue } = await freshSubs();
  Subs.mount(new El2());
  const loaded = [];
  const offsets = [];
  Subs.onLoaded((info) => loaded.push(info));
  Subs.onOffset((v) => offsets.push(v));

  Subs.__test.setLang('id');
  Subs.setVideo({ type: 'movie', id: '5' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(loaded.length, 1, 'onLoaded fired once');
  assert.equal(loaded[0].fileId, 'R1', 'carries the fileId (relayed to the room)');
  assert.ok(/Host.Pick/.test(loaded[0].label), 'label names the release: ' + loaded[0].label);

  // A sync press fires the offset hook (host relays it).
  fireClock(listeners, rafQueue, 1.5);
  Subs.syncSnap();
  assert.equal(offsets.length, 1, 'onOffset fired for the local sync');

  // Remote apply: offset lands, but the hook stays silent (no echo loop).
  Subs.applyRemoteOffset(2.5);
  assert.equal(Subs.__test.state().offset, 2.5, 'remote offset applied');
  assert.equal(offsets.length, 1, 'remote apply did NOT re-fire the hook');

  // loadRemote fetches once, loads cues, marks status.
  const before = fileFetches;
  await Subs.loadRemote({ fileId: 'R2', label: 'Rel [en]' });
  assert.equal(fileFetches, before + 1, 'loadRemote downloaded the file');
  assert.ok(Subs.__test.state().status.includes('host'), 'status says who loaded it: ' + Subs.__test.state().status);
});

test('mini timing editor: click a tick shows its timestamp; Align snaps it to now', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.loadCues(
    '1\n00:00:10,000 --> 00:00:11,000\nFirst line\n\n' +
      '2\n00:00:20,000 --> 00:00:21,000\nSecond line\n'
  );

  /** findClass but for compound classNames (the row is 'subs-panel__row subs-editor') */
  const findBy = (root, cls) => {
    if (String(root.className || '').split(/\s+/).indexOf(cls) !== -1) return root;
    for (const c of root.children || []) {
      const hit = findBy(c, cls);
      if (hit) return hit;
    }
    return null;
  };
  const row = findBy(wrap, 'subs-editor');
  assert.ok(row, 'editor row rendered');
  const ticksWrap = row.children[0].children[0];
  assert.ok(ticksWrap.children.length >= 2, 'both cues drawn as ticks');
  assert.equal(row.children[2].disabled, true, 'Align disabled until a line is picked');

  // Click the FIRST tick (cue at 10s) -> info shows its timestamp, Align arms.
  ticksWrap.children[0]._h.click();
  assert.ok(/0:10/.test(row.children[1].textContent), 'timestamp shown: ' + row.children[1].textContent);
  assert.equal(row.children[2].disabled, false, 'Align armed');

  // Player is at 11.3s -> aligning the 10s line sets offset = +1.3s.
  fireClock(listeners, rafQueue, 11.3);
  row.children[2]._h.click();
  assert.equal(Subs.__test.state().offset, 1.3, 'manual match is exact');
});

test('mini-map sync: bars carry EXACTLY the offset (no 2x), head matches the displayed caption', async () => {
  const { Subs, listeners, rafQueue } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.loadCues(FRESH_SRT); // one caption 10s..12s (span 12s, stub 600px => 50px/s)

  const findBy = (root, cls) => {
    if (String(root.className || '').split(/\s+/).indexOf(cls) !== -1) return root;
    for (const c of root.children || []) {
      const hit = findBy(c, cls);
      if (hit) return hit;
    }
    return null;
  };
  const row = findBy(wrap, 'subs-editor');
  const bar = row.children[0];
  const ticksWrap = bar.children[0];
  const play = bar.children[1];

  // offset 0, video 11s: the caption is displayed NOW and the head sits on it.
  fireClock(listeners, rafQueue, 11);
  rafQueue.splice(0).forEach((cb) => cb());
  assert.equal(Subs.__test.state().offset, 0);
  assert.equal(Math.round(parseFloat(play.style.left)), Math.round((11 / 12) * 100), 'head at 11/12 of the span');
  assert.equal(String(ticksWrap.style.transform), 'translateX(0.0px)', 'zero offset -> zero transform');

  // THE 2X BUG PIN: +5s offset -> transform must be 5*50=250px (2x made it 500).
  Subs.__test.setOffset(5);
  rafQueue.splice(0).forEach((cb) => cb());
  const x = parseFloat(String(ticksWrap.style.transform).replace(/[^-0-9.]/g, ''));
  assert.equal(Math.round(x), 250, 'transform == offset*pps EXACTLY (2x bug rendered 500)');
});

test('auto-load iterates candidates when the top one fails to download', async () => {
  // Live scenario (2026-09-13): the ranked-best record sat on a gated host
  // (dl.opensubtitles.org -> 401). Auto-load must skip it and load #2.
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/subs/search')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [
            { fileId: 'A', release: 'Gated.Release', lang: 'en', downloads: 9000, machineTranslated: false },
            { fileId: 'B', release: 'Good.Release', lang: 'en', downloads: 4000, machineTranslated: false },
          ],
          best: { fileId: 'A', release: 'Gated.Release', lang: 'en', downloads: 9000 },
        }),
      });
    }
    if (u.includes('fileId=A')) {
      return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'subtitle file fetch 401 (gated host)' }) });
    }
    if (u.includes('fileId=B')) {
      return Promise.resolve({ ok: true, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nSecond candidate\n' });
    }
    return Promise.reject(new Error('unexpected ' + u));
  };

  const { Subs } = await freshSubs();
  const wrap = new El2();
  Subs.mount(wrap);
  Subs.__test.setLang('en');
  Subs.loadCues('1\n00:00:05,000 --> 00:00:06,000\nwarmup\n'); // enable (returning-user path)
  Subs.setVideo({ type: 'movie', id: '7' }); // enabled -> next-video auto-load fires
  await new Promise((r) => setTimeout(r, 50));

  const st = Subs.__test.state();
  assert.equal(st.cues, 1, 'the second candidate must load');
  assert.ok(st.status.includes('Good.Release'), 'status names the release that actually loaded: ' + st.status);
});

test('multi-source fan-out: free codes queried explicitly, merged, deduped by url', async () => {
  // Wyzie support (2026-09-14): free keys = alpha, charlie, kilo, lima ONLY.
  // 'all' silently degrades to charlie (gated OS host). The worker must query
  // each free code EXPLICITLY and merge what comes back.
  assert.deepEqual(WYZIE_FREE_SOURCES, ['alpha', 'charlie', 'kilo', 'lima']);

  const gated = 'https://dl.opensubtitles.org/p/subs/1';
  const pub1 = 'https://subf2m.co.uk/dl/1';
  const pub2 = 'https://yifysubtitles.com/sub/1';
  const urlsHit = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    urlsHit.push(u);
    const src = /[?&]source=([a-z]+)/.exec(u)[1];
    if (src === 'alpha') {
      return { ok: true, json: async () => [
        { id: 1, url: pub1, language: 'en', release: 'Alpha.Rel.1', downloadCount: 100 },
        { id: 2, url: gated, language: 'en', release: 'Alpha.Gated', downloadCount: 9000 },
      ] };
    }
    if (src === 'kilo') {
      return { ok: true, json: async () => [
        { id: 3, url: pub1, language: 'en', release: 'DUP.same.url', downloadCount: 5 }, // dup of alpha's pub1
        { id: 4, url: pub2, language: 'en', release: 'Kilo.YIFY', downloadCount: 50 },
      ] };
    }
    if (src === 'charlie') return { ok: true, json: async () => ({ code: 404, message: 'none here' }) };
    if (src === 'lima') return { ok: false, status: 500, json: async () => ({}) };
    throw new Error('unexpected ' + u);
  };

  const ms = await fetchWyzieMultiSource({
    fetchImpl,
    sources: ['alpha', 'charlie', 'kilo', 'lima'],
    tmdb: 286217,
    lang: 'en',
    key: 'k',
  });

  assert.equal(urlsHit.length, 4, 'one explicit request per free source code');
  assert.ok(urlsHit.every((u) => /[?&]format=srt/.test(u)), 'format=srt preserved');
  assert.equal(ms.records.length, 3, 'merged, deduped by url (dup + gated both collapse/handled downstream)');
  const ids = ms.records.map((r) => r.id).sort();
  assert.deepEqual(ids, [1, 2, 4], 'url-duplicates dropped, records kept in source order');
  assert.equal(ms.perSource.find((p) => p.source === 'alpha').gated, 1, 'alpha gated tally');
  assert.equal(ms.perSource.find((p) => p.source === 'lima').http, 500, 'per-source http fate');
  assert.ok(ms.note.includes('alpha:2(g1@dl.opensubtitles.org)'), 'note names source + tally + host: ' + ms.note);
  assert.ok(ms.note.includes('charlie:0'), 'wrapper-only source counts 0: ' + ms.note);
  assert.ok(ms.note.includes('lima:0:http500'), 'http failure visible: ' + ms.note);
});

test('composeWyzieNote keeps the gated:N token the frontend parses', () => {
  const shaped = shapeWyzieResults([
    { id: 1, url: 'https://dl.opensubtitles.org/p/a', language: 'en' },
    { id: 2, url: 'https://dl.opensubtitles.org/p/b', language: 'en' },
  ]);
  assert.equal(shaped.best, null, 'all gated -> no candidates');
  const note = composeWyzieNote(shaped, { note: 'charlie:2(g2@dl.opensubtitles.org)' });
  assert.ok(/gated:2/.test(note), 'gated:N token present for the frontend regex: ' + note);
  assert.ok(note.startsWith('ok'), 'success-path note still opens with ok');
  assert.ok(note.includes('src charlie:2(g2@dl.opensubtitles.org)'), 'per-source provenance included');
});

test('source discovery: live /sources payload scopes the fan-out (no ghost codes)', async () => {
  // LIVE /sources (2026-09-14, keyless): bravo/charlie/foxtrot/india/juliet/
  // lima/mike/november; free = [charlie, lima]. Support-quoted 'alpha'/'kilo'
  // DO NOT EXIST live -> they 400'd. Discovery must never emit them.
  const live = {
    sources: ['bravo', 'charlie', 'foxtrot', 'india', 'juliet', 'lima', 'mike', 'november'],
    free: ['charlie', 'lima'],
    paid: ['bravo', 'foxtrot', 'india', 'juliet', 'mike', 'november'],
    allFree: false,
  };

  // Keyless payload -> free tier.
  assert.deepEqual(parseWyzieSources(live, ['x']), ['charlie', 'lima']);

  // Key-scoped payload -> 'available' wins.
  const scoped = { ...live, key: { valid: true, type: 'free' }, available: ['charlie', 'lima'], restricted: ['bravo'] };
  assert.deepEqual(parseWyzieSources(scoped, ['x']), ['charlie', 'lima']);
  const scopedPaid = { ...live, key: { valid: true, type: 'paid' }, available: ['bravo', 'charlie', 'india', 'lima'] };
  assert.deepEqual(parseWyzieSources(scopedPaid, ['x']), ['bravo', 'charlie', 'india', 'lima']);

  // Garbage -> null (caller uses its own fallback); unusable payloads ->
  // the fallback list is APPLIED (graceful degradation when the endpoint
  // changes shape again); no fallback -> null.
  assert.equal(parseWyzieSources(null, ['charlie']), null);
  assert.deepEqual(parseWyzieSources({}, ['charlie', 'lima']), ['charlie', 'lima']);
  assert.deepEqual(parseWyzieSources({ available: [], free: [] }, ['charlie', 'lima']), ['charlie', 'lima']);

  // fetchWyzieAvailableSources: network/HTTP/JSON failures -> null.
  const ok = await fetchWyzieAvailableSources({
    fetchImpl: async () => ({ ok: true, json: async () => scopedPaid }),
    key: 'k',
    fallback: ['charlie'],
  });
  assert.deepEqual(ok, ['bravo', 'charlie', 'india', 'lima']);
  assert.equal(
    await fetchWyzieAvailableSources({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }), key: 'k', fallback: ['charlie'] }),
    null
  );
  assert.equal(
    await fetchWyzieAvailableSources({ fetchImpl: async () => { throw new Error('down'); }, key: 'k', fallback: ['charlie'] }),
    null
  );
  const hit = [];
  const called = await fetchWyzieAvailableSources({
    fetchImpl: async (u) => {
      hit.push(String(u));
      return { ok: true, json: async () => scopedPaid };
    },
    key: 'SECRET',
    fallback: ['charlie'],
  });
  assert.deepEqual(called, ['bravo', 'charlie', 'india', 'lima']);
  assert.ok(hit[0].startsWith('https://sub.wyzie.io/sources?key=SECRET'), 'key scoped, server-side only');
});

test('fan-out trims TV-only sources for movies; cache key scopes precisely', () => {
  // Live 2026-09-14: lima answers movie queries with http400 (TV-only).
  assert.deepEqual(WYZIE_TV_ONLY_SOURCES, ['lima']);
  const srcs = ['charlie', 'lima'];
  assert.deepEqual(wyzieFanSources(srcs, false), ['charlie'], 'movie: dead leg trimmed');
  assert.deepEqual(wyzieFanSources(srcs, true), ['charlie', 'lima'], 'tv: both queried');
  assert.deepEqual(wyzieFanSources(['charlie'], false), ['charlie'], 'no TV-only codes: unchanged');
  assert.deepEqual(wyzieFanSources([], true), []);

  const k1 = wyzieSearchCacheKey({ tmdb: 286217, season: null, episode: null, lang: 'id', sources: ['charlie'] });
  const k2 = wyzieSearchCacheKey({ tmdb: 286217, season: 1, episode: 2, lang: 'id', sources: ['charlie', 'lima'] });
  const k3 = wyzieSearchCacheKey({ tmdb: 286217, season: null, episode: null, lang: 'en', sources: ['charlie'] });
  assert.notEqual(k1, k2, 'movie vs episode differ');
  assert.notEqual(k1, k3, 'language differs');
  assert.ok(k1.startsWith('subs:search:v2:286217:-x-:id:charlie'), k1);
});

test('SPEED: file downloads exactly ONCE (no double fetch), fresh user auto-loads, opt-out respected', async () => {
  let fileFetches = 0;
  let searchFetches = 0;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/subs/search')) {
      searchFetches++;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          results: [{ fileId: 'Z', release: 'Fast.Release', lang: 'en', downloads: 100, machineTranslated: false }],
          best: { fileId: 'Z', release: 'Fast.Release', lang: 'en', downloads: 100 },
        }),
      });
    }
    if (u.includes('fileId=Z')) {
      fileFetches++;
      return Promise.resolve({ ok: true, text: async () => '1\n00:00:01,000 --> 00:00:02,000\nfast cue\n' });
    }
    return Promise.reject(new Error('unexpected ' + u));
  };

  // FRESH USER: never enabled anything, no warmup — opening a player must
  // auto-load. (This used to require the user to press CC first.)
  const { Subs } = await freshSubs();
  Subs.mount(new El2());
  Subs.__test.setLang('en');
  Subs.setVideo({ type: 'movie', id: '9' });
  await new Promise((r) => setTimeout(r, 50));
  const st = Subs.__test.state();
  assert.equal(st.cues, 1, 'fresh user gets subtitles on open');
  assert.ok(st.status.includes('Fast.Release'), 'status names the release: ' + st.status);
  assert.equal(searchFetches, 1, 'one search');
  assert.equal(fileFetches, 1, 'file downloaded EXACTLY once (was: twice — searchBest and autoLoad both fetched)');

  // EXPLICIT OPT-OUT: the CC toggle memory must stop auto-load entirely.
  const store = globalThis.localStorage;
  store.setItem('wp:subs:pref', 'off');
  searchFetches = 0;
  Subs.setVideo({ type: 'movie', id: '10' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(searchFetches, 0, 'opted-out user: no search fired at all');
  store.setItem('wp:subs:pref', 'on');
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
        // The WORKER's compact contract (what the frontend actually iterates).
        return Promise.resolve({
          ok: true,
          json: async () => ({
            results: [{ fileId: 9, release: 'Rel.ENG', lang: 'en', downloads: 5000, machineTranslated: false }],
            best: { fileId: 9, release: 'Rel.ENG', lang: 'en', downloads: 5000 },
          }),
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
  assert.ok(Subs.__test.state().status.includes('Rel.ENG'), 'status names the loaded release');
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

test('mini-map thread sync: drag the cue strip like a Premiere clip (panel-internal)', async () => {
  // --- listener-recording DOM stubs (fresh module instance) -----------------
  class El3 {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.style = {};
      this.hidden = false;
      this.textContent = '';
      this.className = '';
      this._listeners = {};
      this.addEventListener = (type, fn) => ((this._listeners[type] || (this._listeners[type] = [])).push(fn));
      this.removeEventListener = () => {};
      this.setAttribute = () => {};
      this.appendChild = (c) => (this.children.push(c), c);
      this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
    }
  }
  const store3 = {};
  const doc3 = {
    createElement: (t) => new El3(t),
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    documentElement: new El3('html'),
    body: new El3('body'),
    addEventListener() {},
    readyState: 'complete',
    hidden: false,
  };
  globalThis.window = {
    WP: {},
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    requestAnimationFrame: (cb) => cb && 1,
    cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (k) => (k in store3 ? store3[k] : null),
      setItem: (k, v) => (store3[k] = String(v)),
      removeItem: (k) => delete store3[k],
    },
  };
  globalThis.document = doc3;
  globalThis.location = { search: '' };
  globalThis.localStorage = globalThis.window.localStorage;
  Object.assign(globalThis.window, { document: doc3, location: globalThis.location, localStorage: globalThis.localStorage });
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ results: [], best: null }) });

  const mod = await import(join(ROOT, 'dist/js/subs.js') + '?thread=' + Date.now());
  const Subs = globalThis.window.WP.Subs;
  assert.ok(Subs, 'fresh subs module registered');

  const wrap3 = new El3('div');
  Subs.mount(wrap3);
  Subs.loadCues(FRESH_SRT);

  // The sync surface lives INSIDE the subs panel (mini-map editor row).
  const panel = wrap3.children.find((c) => c.className === 'subs-panel');
  assert.ok(panel, 'panel exists');
  const rowEd = panel.children.find((c) => String(c.className).indexOf('subs-editor') !== -1);
  assert.ok(rowEd, 'mini-map editor row exists in the panel');
  const bar = rowEd.children.find((c) => c.className === 'subs-editor__bar');
  assert.ok(bar, 'thread bar exists');
  const ticks = bar.children.find((c) => c.className === 'subs-editor__ticks');
  assert.ok(ticks, 'ticks strip exists');
  const resetBtn = rowEd.children.find((c) => String(c.className).indexOf('subs-editor__reset') !== -1);
  assert.ok(resetBtn, 'reset control exists in the row');
  // BAR LENGTH == CAPTION LENGTH: FRESH_SRT spans 10s->12s (2s) on the
  // full timeline (600px/12s = 50px/s) => the block is exactly 100px wide.
  const block = ticks.children.find((c) => String(c.className).indexOf('subs-editor__tick') !== -1);
  assert.ok(block, 'caption block rendered');
  assert.equal(block.style.width, '100.0px', 'caption block width == its timestamp duration (2s x 50px/s)');
  assert.equal(Math.round(parseFloat(block.style.left)), 500, 'caption block positioned at its 10s start');

  // NO floating pill anywhere.
  assert.ok(!doc3.body.children.some((c) => String(c.className).indexOf('subs-syncbar') !== -1), 'no floating pill');

  const fire = (el, type, ev) => (el._listeners[type] || []).forEach((fn) => fn(ev));
  const pd = (x) => ({ pointerId: 1, clientX: x, clientY: 5, currentTarget: bar, preventDefault() {} });

  let roomOffsets = [];
  Subs.onOffset((v) => roomOffsets.push(v));

  // Full-timeline scale: 600px stub / 12s span = 50 px/s => 60px = +1.2s.
  const xBefore = parseFloat(String(ticks.style.transform).replace(/[^-0-9.]/g, '')) || 0;
  fire(bar, 'pointerdown', pd(100));
  fire(bar, 'pointermove', pd(130));
  fire(bar, 'pointermove', pd(160));
  const xDuring = parseFloat(String(ticks.style.transform).replace(/[^-0-9.]/g, ''));
  assert.equal(String(ticks.style.transform).indexOf('translateX(') === 0, true, 'thread slides via transform');
  assert.equal(Math.round(xDuring - xBefore), 60, '60px drag slides the thread 60px (1:1 spatial)');
  assert.equal(roomOffsets.length, 0, 'dragging does NOT spam the room per frame');

  const rows = panel.children.filter((c) => String(c.className).indexOf('subs-panel__row') === 0);
  const offEl = rows.map((r) => r.children.find((c) => c.className === 'subs-panel__offset')).find(Boolean);
  assert.ok(offEl, 'offset readout exists');
  assert.equal(offEl.textContent, '+1.20s', 'offset follows the thread drag (50 px/s on the 12s timeline)');

  fire(bar, 'pointerup', pd(160));
  assert.equal(roomOffsets.length, 1, 'release replicates the offset to the room EXACTLY once');
  assert.equal(roomOffsets[0], 1.2);

  // Reset control returns to zero.
  fire(resetBtn, 'click', {});
  assert.equal(offEl.textContent, '0.00s', 'reset returns to zero');
  assert.equal(Math.round(parseFloat(String(ticks.style.transform).replace(/[^-0-9.]/g, '')) - xBefore), 0, 'thread snaps back to the pre-drag position');
});
