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
