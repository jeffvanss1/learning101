// subs.js — custom subtitles with auto-sync for the room player.
//
// The Bingr player reports its playback clock via postMessage
// (PLAYER_EVENT → playerstatus { currentTime, playing }). Because we can
// READ the clock, we can render our own subtitle overlay exactly in sync —
// independent of the embed's built-in subs (the ones users report as
// "out of sync").
//
//   • Source A (auto): OpenSubtitles via the worker proxy
//       /api/subs/search → best candidate for the exact movie/episode
//       /api/subs/file?fileId= → WebVTT (KV-cached worker-side)
//   • Source B: upload any .srt/.vtt file — no API key needed.
//
//   • "Auto-sync": the clock is interpolated between status reports, the
//     offset is one-click adjustable (±0.25s / ±1s, keyboard [ and ]) and
//     PERSISTED per movie/episode — fix once, stays fixed.
//   • Needs the main Bingr player (the only one that reports a clock);
//     "Server 2" fallback embeds can't drive the overlay.
//
// @ts-check
(function (global) {
  'use strict';

  const WP = global.WP || {};
  const $ = (/** @type {string} */ id) => document.getElementById(id);
  const tr = (/** @type {string} */ key, /** @type {string} */ fb) =>
    WP.I18N ? WP.I18N.t(key, fb) : fb;
  /**
   * Inline SVG icon (utils.js table) — no emoji in the UI chrome.
   * @param {string} name @param {number} [size] @returns {Element}
   */
  const ic = (name, size) => (WP.icon ? WP.icon(name, size) : document.createElement('span'));

  const LANGS = [
    ['en', 'English'], ['id', 'Bahasa Indonesia'], ['es', 'Español'],
    ['fr', 'Français'], ['pt', 'Português'], ['ar', 'العربية'],
    ['de', 'Deutsch'], ['ja', '日本語'], ['ko', '한국어'],
    ['hi', 'हिन्दी'], ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['zh', '中文'],
  ];
  const SIZES = [
    ['subs--sm', 'S'],
    ['', 'M'],
    ['subs--lg', 'L'],
    ['subs--xl', 'XL'],
  ];

  // ---- SRT/VTT → cues -------------------------------------------------------

  /** @param {string} s @returns {number | null} */
  function parseTs(s) {
    const m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/.exec(s);
    if (!m) return null;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
  }

  /**
   * Parse SRT or WebVTT into cues.
   * @param {string} raw
   * @returns {{ start: number, end: number, text: string }[]}
   */
  function parseSubtitles(raw) {
    const text = String(raw || '').replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/, '');
    const cues = [];
    const blocks = text.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      while (lines.length && !/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s+-->/.test(lines[0])) lines.shift();
      if (!lines.length) continue;
      const tm = /^\s*(\S+)\s+-->\s+(\S+)/.exec(lines.shift() || '');
      if (!tm) continue;
      const start = parseTs(tm[1]);
      const end = parseTs(tm[2]);
      if (start == null || end == null || end <= start) continue;
      const body = lines
        .join('\n')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/\{\\[^}]*\}/g, '')
        .trim();
      if (!body) continue;
      cues.push({ start: start, end: end, text: body });
    }
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }

  // ---- state ----------------------------------------------------------------

  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {HTMLElement | null} */
  let overlayText = null;
  /** @type {HTMLElement | null} */
  let panel = null;
  /** @type {HTMLElement | null} */
  let statusEl = null;
  /** @type {HTMLSelectElement | null} */
  let langSel = null;
  /** @type {HTMLElement | null} */
  let offsetVal = null;

  let clockTime = 0;
  let clockAt = 0;
  let clockPlaying = false;
  let gotClock = false;

  let cues = [];
  let cueIdx = 0;
  let enabled = false;
  let sizeIdx = 1;
  let video = /** @type {any} */ (null);
  let rafId = 0;

  /** @returns {string} persistence key for the current video */
  function videoKey() {
    if (!video) return 'none';
    return video.type + '|' + video.id + '|' + (video.season != null ? video.season : '') + '|' + (video.episode != null ? video.episode : '');
  }

  /** @returns {number} the persisted offset for the current video */
  function loadOffset() {
    try {
      const v = Number(localStorage.getItem('wp:suboff:' + videoKey()));
      return Number.isFinite(v) ? v : 0;
    } catch (_) {
      return 0;
    }
  }

  /** @param {number} sec */
  function saveOffset(sec) {
    try {
      localStorage.setItem('wp:suboff:' + videoKey(), String(sec));
    } catch (_) {}
  }

  let offset = 0;

  /** @returns {number} interpolated player time */
  function now() {
    if (!gotClock) return -1;
    const t = clockPlaying ? clockTime + (Date.now() - clockAt) / 1000 : clockTime;
    return t - offset;
  }

  // ---- rendering ------------------------------------------------------------

  function renderLoop() {
    if (!overlay || !enabled) return;
    const t = now();
    if (t >= 0) {
      if (cues.length) {
        // Full-timeline mini-map: head position + thread offset repaint per
        // frame with a single transform (no DOM rebuilds).
        paintEditorThread();
      }
      while (cueIdx < cues.length && cues[cueIdx].end <= t) cueIdx++;
      const cue = cues[cueIdx];
      const text = cue && cue.start <= t && t < cue.end ? cue.text : '';
      if (overlayText && overlayText.textContent !== text) {
        overlayText.textContent = text;
        overlayText.style.display = text ? 'block' : 'none';
      }
    }
    rafId = global.requestAnimationFrame(renderLoop);
  }

  function startLoop() {
    if (!rafId) rafId = global.requestAnimationFrame(renderLoop);
  }

  function stopLoop() {
    if (rafId) {
      global.cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (overlayText) {
      overlayText.textContent = '';
      overlayText.style.display = 'none';
    }
  }

  // ---- clock (postMessage, independent of player.js) ------------------------

  /** @param {MessageEvent} ev */
  function onMessage(ev) {
    const d = ev.data;
    if (!d || d.type !== 'PLAYER_EVENT') return;
    const s = (d.data && d.data.event === 'playerstatus' ? d.data : null) || (d.data && d.data.event === 'timeupdate' ? d.data : null);
    if (!s || typeof s.currentTime !== 'number') return;
    clockTime = s.currentTime;
    clockAt = Date.now();
    clockPlaying = !!s.playing;
    gotClock = true;
    cueIdx = 0; // cheap re-scan; monotonic lists make this O(1) amortized
  }

  // ---- data -----------------------------------------------------------------

  /**
   * @param {string} msg @param {boolean} [isError] @param {string} [iconName] leading inline SVG
   */
  function setStatus(msg, isError, iconName) {
    if (!statusEl) return;
    statusEl.textContent = '';
    if (iconName) {
      const svg = ic(iconName, 13);
      svg.classList.add('wp-icon--inline');
      statusEl.appendChild(svg);
      statusEl.appendChild(document.createTextNode(' '));
    }
    statusEl.appendChild(document.createTextNode(msg));
    statusEl.className = 'subs-panel__status' + (isError ? ' subs-panel__status--err' : '');
  }

  /** @param {{ type: string, id: string, season?: number, episode?: number }} v @param {string} lang @returns {Promise<{ cand: { fileId: number, release: string, lang: string, downloads: number }, text: string } | null>} */
  async function searchBest(v, lang) {
    const qs = new URLSearchParams({
      type: v.type === 'movie' ? 'movie' : 'tv',
      tmdb: String(v.id),
    });
    // Non-movie ALWAYS searches with season+episode (Wyzie requires them
    // together; lima 400s without). Anime videos carry episode but season
    // null -> default both (S1/E1) so anime gets subs at all.
    if (v.type !== 'movie') qs.set('season', String(v.season != null ? v.season : 1));
    if (v.type !== 'movie') qs.set('episode', String(v.episode != null ? v.episode : 1));
    if (lang) qs.set('lang', lang);
    const res = await fetch('/api/subs/search?' + qs.toString());
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setStatus((data && data.error) || tr('subs.searchFailed', 'Subtitle search failed.'), true);
      return null;
    }
    // Diagnosability: the exact upstream query + result count, in DevTools.
    try {
      console.info('[WatchParty] subs search:', data.query, '-> total', data.total, 'candidates', (data.results || []).length);
    } catch (_) {}
    // Try ALL ranked candidates (server caps at 12) — the old top-5 cap made
    // a run of dead hosts read as "no <lang> subs" and silently flipped the
    // chain to English even when Indonesian files existed just below.
    const candidates = data.results || [];
    try {
      console.info('[WatchParty] subs ' + (lang || 'any') + ': ' + candidates.length + ' candidates, trying downloads');
    } catch (_) {}
    if (!candidates.length) return null;
    let lastErr = '';
    for (const cand of candidates) {
      try {
        const fileRes = await fetch('/api/subs/file?fileId=' + cand.fileId);
        if (!fileRes.ok) {
          const err = await fileRes.json().catch(() => null);
          lastErr = (err && err.error) || 'HTTP ' + fileRes.status;
          continue;
        }
        // Single download owner: return the text; the caller renders it.
        // (This used to load cues AND the caller re-fetched the same file —
        // doubling every load.)
        return { cand: cand, text: await fileRes.text() };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    setStatus(
      tr('subs.loadFailed', 'Could not download the subtitle.') + ' (' + lastErr + ')',
      true
    );
    return null;
  }

  /**
   * Language fallback chain: requested language -> English -> ANY language
   * (no filter). Indonesian-dubbed titles usually have no Indonesian subs —
   * "nothing found" must never be the end of the road when English ones exist.
   * @param {{ type: string, id: string, season?: number, episode?: number }} v
   */
  /** @type {string} '' | 'gated:13' — what the last search chain saw dropped as gated */
  let lastGatedSeen = '';
  // ---- room sync hooks (wired by app.js: host actions replicate to guests) ---
  /** @type {null | function({fileId: string|null, label: string}): void} */
  let onLoadedCb = null;
  /** @type {null | function(number): void} */
  let onOffsetCb = null;
  /** @type {string} last fileId this client loaded (dedupes host echo) */
  let lastLoadedFileId = '';
  // ---- mini timing editor (manual match: click a line, align it to "now") ----
  let edTicks = /** @type {HTMLElement | null} */ (null);
  let edPlay = /** @type {HTMLElement | null} */ (null);
  let edInfo = /** @type {HTMLElement | null} */ (null);
  let edAlign = /** @type {HTMLButtonElement | null} */ (null);
  let edSelected = /** @type {number | null} */ (null);
  const EDITOR_MAX_TICKS = 500;
  // Caption-bar palette (user-supplied): consecutive bars always alternate.
  const SUBS_PALETTE = [
    { fill: 'rgba(80, 3, 192, 0.55)', edge: '#5003C0' },   // violet
    { fill: 'rgba(171, 3, 169, 0.55)', edge: '#AB03A9' },  // magenta
    { fill: 'rgba(255, 70, 122, 0.55)', edge: '#FF467A' }, // pink/red
    { fill: 'rgba(255, 213, 30, 0.55)', edge: '#FFD51E' }, // yellow
  ];
  // ZOOM: the strip shows a 5-minute window around the playhead, not the
  // whole movie (a 2h film compressed into one bar is unreadable). The
  // window slides forward as playback approaches its right edge.
  // MINI-MAP, TWO PERSISTED MODES:
  //  FULL (default): the strip spans the WHOLE subtitle file - every caption
  //    bar is always visible; the head travels the strip with the clock.
  //  ZOOM: a 60-second window with the head pinned mid-strip (the working
  //    view for precise sync). The choice persists across sessions.
  const ZOOM_PREF_KEY = 'wp:subsmap:zoom';
  const EDITOR_WINDOW_S = 60;
  /** px per second on the current mini-map scale */
  let edPps = 10;
  /** zoom mode: false = full timeline (default), true = 60s centered window */
  let edZoom = false;
  try {
    edZoom = localStorage.getItem(ZOOM_PREF_KEY) === '1';
  } catch (_) {}
  /** total timeline span in seconds (last cue end); 1 while empty */
  function edSpan() {
    return cues.length ? Math.max(1, cues[cues.length - 1].end || 1) : 1;
  }

  /** @param {number} s @returns {string} h:mm:ss / m:ss */
  function fmtTS(s) {
    const t = Math.max(0, Math.floor(s));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    const mm = (h ? String(m).padStart(2, '0') : String(m));
    const ss = String(sec).padStart(2, '0');
    return (h ? h + ':' : '') + mm + ':' + ss;
  }

  function buildEditorTicks() {
    if (!edTicks) return;
    while (edTicks.firstChild) edTicks.removeChild(edTicks.firstChild);
    if (edAlign) edAlign.disabled = edSelected == null; // keep a picked line armed across slides
    if (!cues.length) {
      if (edPlay) edPlay.style.display = 'none';
      if (edInfo) edInfo.textContent = tr('subs.editorEmpty', 'Load subtitles to see their timing here.');
      return;
    }
    edPps = edBarWidth() / (edZoom ? EDITOR_WINDOW_S : edSpan());
    // EVERY caption becomes a BLOCK whose length equals its timestamp span
    // (left = start, width = duration on the px scale) - a Premiere-style
    // sequence of caption clips, not thin ticks. Sample only absurd files.
    const step = cues.length > EDITOR_MAX_TICKS ? Math.ceil(cues.length / EDITOR_MAX_TICKS) : 1;
    for (let ix = 0; ix < cues.length; ix += step) {
      const cue = cues[ix];
      const tick = h('div', 'subs-editor__tick' + (ix === edSelected ? ' subs-editor__tick--sel' : ''));
      tick.style.left = (cue.start * edPps).toFixed(1) + 'px'; // absolute time -> px
      // BAR LENGTH = CAPTION LENGTH: width mirrors the cue's own duration.
      tick.style.width = Math.max(1, (cue.end - cue.start) * edPps).toFixed(1) + 'px';
      // ALTERNATING PALETTE: adjacent bars always differ (4-color cycle;
      // same-color neighbors are impossible since consecutive bars cycle
      // through 4 distinct hues - even sampled files keep k and k+1 apart).
      const pal = SUBS_PALETTE[ix % SUBS_PALETTE.length];
      tick.style.background = pal.fill;
      tick.style.borderLeftColor = pal.edge;
      tick.title = fmtTS(cue.start) + ' \u00b7 ' + String(cue.text).split('\n')[0].slice(0, 60);
      ((/** @type {number} */ idx, /** @type {any} */ c, /** @type {HTMLElement} */ el) => {
        el.addEventListener('click', () => {
          if (Date.now() < threadDragGuardUntil) return; // drag, not a pick
          edSelected = idx;
          const ticks = edTicks ? edTicks.children || [] : [];
          for (let j = 0; j < ticks.length; j++) {
            (/** @type {any} */ ticks[j]).classList.remove('subs-editor__tick--sel');
          }
          el.classList.add('subs-editor__tick--sel');
          if (edInfo) edInfo.textContent = fmtTS(c.start) + ' \u00b7 ' + String(c.text).split('\n')[0].slice(0, 60);
          if (edAlign) edAlign.disabled = false;
        });
      })(ix, cue, tick);
      edTicks.appendChild(tick);
    }
    if (edInfo) edInfo.textContent = tr('subs.editorHint', 'Drag the strip to sync \u00b7 tap a line, then align it.');
    paintEditorThread();
  }


  // ---- room sync: apply what the HOST loaded/matched -------------------------
  /** @param {{ fileId?: string, label?: string }} info */
  /** host/room subtitle priority: once the host's file is applied, local
   * auto-load must never override it (its arrival cancels in-flight runs). */
  let roomSubsActive = false;
  let autoLoadGen = 0;

  async function loadRemote(info) {
    const fileId = String((info && info.fileId) || '');
    if (!fileId) {
      if (info && info.label) setStatus((info.label) + ' \u00b7 ' + tr('subs.byHost', 'loaded by host'));
      return;
    }
    if (fileId === lastLoadedFileId && cues.length) return; // echo guard
    autoLoadGen++; // supersede any in-flight LOCAL auto-load while we try the host's file
    try {
      const res = await fetch('/api/subs/file?fileId=' + encodeURIComponent(fileId));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!parseSubtitles(text).length) throw new Error('unparseable');
      // SUCCESS only now: the room's pick wins over local auto-load.
      roomSubsActive = true;
      lastLoadedFileId = fileId;
      loadCues(text);
      setStatus((info && info.label ? info.label : '') + ' \u00b7 ' + tr('subs.byHost', 'loaded by host'));
    } catch (_) {
      // FIRST-LOAD DEAD END (fixed): the inherited file failed to download -
      // previously roomSubsActive was already true AND the local auto-load
      // was killed, leaving the joiner with nothing. Fall back to our own
      // auto-load for this video.
      roomSubsActive = false;
      if (video) void autoLoad(video, { force: true });
    }
  }

  /** @param {number} v */
  function applyRemoteOffset(v) {
    const n = Number(v);
    if (!isFinite(n)) return;
    applyOffsetValue(n, { remote: true });
    setStatus(
      tr('subs.tapDone', 'Synced') + ': ' + (offset > 0 ? '+' : '') + offset.toFixed(2) + 's' +
        ' \u00b7 ' + tr('subs.byHostMatch', 'matched by host'),
      false,
      'zap'
    );
  }

  /** @type {string} identity of the auto-load currently running/finished */
  let autoKey = '';

  async function autoLoad(v, opts) {
    if (!v || !v.id) return;
    // ROOM PRIORITY: the host's pick (state.subs / broadcasts) outranks every
    // local auto-load — a guest's own search (possibly another language) must
    // never race and override what the room is already watching.
    if (roomSubsActive && !(opts && opts.force)) return;
    const myGen = ++autoLoadGen;
    if (opts && opts.force) roomSubsActive = false; // manual pick outranks the room
    // ONE AUTO-LOAD PER VIDEO+LANGUAGE: manual triggers (language switch,
    // Auto-load button) pass {force:true}; automatic calls dedupe here so a
    // burst of setVideo calls can never stack parallel searches whose last
    // finisher overrides the room's subtitle language.
    const key = videoIdentity(v) + '|' + (langSel ? langSel.value : 'en');
    if (!(opts && opts.force) && key === autoKey) return;
    autoKey = key;
    lastGatedSeen = '';
    let primary = langSel ? langSel.value : 'en';
    // IP LANGUAGE GUARANTEE: without an explicit pick, the geo language IS
    // the primary - even if the select somehow still says 'en'.
    try {
      const geoLang = WP.I18N && WP.I18N.language;
      const explicit = localStorage.getItem('wp:subslang:explicit') === '1';
      if (!explicit && geoLang) primary = geoLang;
    } catch (_) {}
    const chain = primary === 'en' ? ['en', ''] : [primary, 'en', ''];
    /** @type {string[]} */
    const tried = [];
    for (const lang of chain) {
      if (tried.indexOf(lang) !== -1) continue;
      tried.push(lang);
      setStatus(tr('subs.loading', 'Finding subtitles…'));
      let best = null;
      try {
        best = await searchBest(v, lang);
      } catch (e) {
        if (myGen !== autoLoadGen) return; // superseded (host load / newer run)
        setStatus(e instanceof Error ? e.message : tr('subs.searchFailed', 'Subtitle search failed.'), true);
        return;
      }
      if (myGen !== autoLoadGen) return; // superseded while searching
      if (!best) continue;
      loadCues(best.text); // already downloaded by searchBest — no second fetch
      const label = (LANGS.find((l) => l[0] === best.cand.lang) || [best.cand.lang, best.cand.lang])[1];
      const suffix =
        lang !== primary
          ? ' · ' + tr('subs.fallback', 'no {lang} subs — language fallback').replace('{lang}', primary.toUpperCase())
          : '';
      lastLoadedFileId = String(best.cand.fileId || '');
      setStatus(
        tr('subs.loaded', 'Loaded') +
          ': ' + (best.cand.release || 'subtitle') +
          ' [' + label + ', ' + (best.cand.downloads || 0) + '\u2193]' + suffix
      );
      if (onLoadedCb) {
        try {
          onLoadedCb({
            fileId: lastLoadedFileId,
            label: (best.cand.release || 'subtitle') + ' [' + label + ']',
          });
        } catch (_) {}
      }
      return;
    }
    if (lastGatedSeen) {
      setStatus(
        tr('subs.gated', 'Found {n} subtitles, but they sit behind a provider approval gate. Upload an .srt meanwhile — it works instantly.').replace('{n}', lastGatedSeen.replace('gated:', '')) +
          ' [' + lastGatedSeen + ']',
        true
      );
      return;
    }
    setStatus(tr('subs.noneAny', 'No subtitles found at all for this title.'), true);
  }

  /**
   * Feed parsed cues in (worker VTT, or an uploaded SRT/VTT file).
   * @param {string} raw
   */
  function loadCues(raw) {
    cues = parseSubtitles(raw);
    cueIdx = 0;
    if (cues.length && !enabled) setEnabled(true);
    buildEditorTicks();
    paintEditorThread();
  }

  function setEnabled(on) {
    enabled = !!on;
    if (overlay) overlay.style.display = enabled ? 'block' : 'none';
    if (enabled) {
      startLoop();
      // No clock from this player? Say so instead of showing nothing.
      setTimeout(() => {
        if (enabled && !gotClock) {
          setStatus(tr('subs.noClock', 'This server’s player doesn’t report its clock — custom subtitles need the main player.'), true);
        }
      }, 8000);
    } else {
      stopLoop();
    }
  }

  // ---- panel ----------------------------------------------------------------

  function applyOffsetValue(abs, opts) {
    offset = Math.round(abs * 100) / 100;
    saveOffset(offset);
    if (offsetVal) offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(2) + 's';
    paintEditorThread();
    cueIdx = 0;
    // Local edits fire the room-sync hook; remote-applied ones don't (no echo).
    if ((!opts || !opts.remote) && onOffsetCb) {
      try {
        onOffsetCb(offset);
      } catch (_) {}
    }
  }

  function applyOffset(delta) {
    applyOffsetValue(offset + delta);
  }

  // ---- one-press sync ("Shazam-style") ----------------------------------------
  // No reading, no line-matching: the user presses ONE button the moment a
  // new line starts being SPOKEN, and the next upcoming cue snaps to that
  // instant (offset = playerTime(atTap) - cue.start, computed exactly from
  // the player clock). Each press re-snaps, so 1-2 presses converge. True
  // audio fingerprinting is not feasible here (cross-origin streams block
  // audio capture; no public movie-fingerprint DB), this is the same
  // zero-thought UX without the mic.
  /** @type {HTMLButtonElement | null} */
  let syncBtn = null;

  function syncSnap() {
    if (!cues.length) {
      setStatus(tr('subs.none', 'No subtitles loaded.'), true);
      return;
    }
    const t = now(); // adjusted clock (offset already applied)
    // Guard: before the first PLAYER_EVENT there is no clock — snapping
    // would compute a garbage offset from t = -1 and kill all cues.
    if (t < 0) {
      setStatus(tr('subs.snapNoClock', 'Start playback first, then sync.'), true);
      return;
    }
    const last = cues[cues.length - 1];
    // Guard: tapping after the FINAL cue ended (credits) must not snap the
    // last line to now — that pushed a +minutes offset in and every other
    // cue landed in the past (subs silently vanished).
    if (t > last.end) {
      setStatus(tr('subs.snapAtEnd', 'No more lines ahead — rewind a little to sync.'), true);
      return;
    }
    const target = cues.find((c) => c.start >= t) || last;
    const playerTime = t + offset; // true player time at the tap
    applyOffsetValue(playerTime - target.start);
    setStatus(
      tr('subs.tapDone', 'Synced') + ': ' + (offset > 0 ? '+' : '') + offset.toFixed(2) + 's' +
        ' \u00b7 ' + tr('subs.snapAgain', 'Still off? Press again while someone speaks.'),
      false,
      'zap'
    );
  }

  // ---------------------------------------------------------------------------
  // Mini-map thread sync: the cue strip IS the timeline. Grab the thread and
  // slide it left/right like a clip in Premiere Pro - the playhead stays put,
  // the whole subtitle track slides with your pointer, offset updates live
  // (locally per frame, replicated to the room ONCE on release).
  // ---------------------------------------------------------------------------
  const THREAD_MAX_S = 60; // sane drag ceiling (panel buttons go further)
  /** @type {{ startX: number, startOffset: number, pps: number, moved: boolean } | null} */
  let threadDrag = null;
  let threadDragGuardUntil = 0; // a drag must not also select the tick under the pointer

  /** Bar width via DOM; the test harness stubs provide none (fallback 600). */
  function edBarWidth() {
    try {
      const el = /** @type {any} */ (edTicks && edTicks.parentElement);
      if (el && el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        if (r && r.width > 0) return r.width;
      }
    } catch (_) {}
    return 600;
  }

  /** Slide the whole thread visually by the current offset (cheap transform). */
  function paintEditorThread() {
    if (!edTicks) return;
    const t = now();
    // FULL: the head TRAVELS the strip with the clock; bars carry ONLY the
    // offset (now() already subtracts it - double-counting rendered bars at
    // 2x the offset, "bar not sync with the subs").
    // ZOOM: the head is PINNED mid-strip and the scale centers on the clock.
    if (edPlay) {
      if (edZoom) {
        edPlay.style.left = '50%'; // pinned, clock or not
        edPlay.style.display = t >= 0 ? 'block' : 'none';
      } else if (t >= 0) {
        edPlay.style.display = 'block';
        edPlay.style.left = (Math.min(1, Math.max(0, t / edSpan())) * 100).toFixed(2) + '%';
      } else {
        edPlay.style.display = 'none';
      }
    }
    let x;
    if (edZoom) {
      // now() already subtracts the offset; pre-clock uses virtual V=0.
      x = edBarWidth() / 2 - (t >= 0 ? t : -offset) * edPps;
    } else {
      x = offset * edPps;
    }
    edTicks.style.transform = 'translateX(' + x.toFixed(1) + 'px)';
  }

  /** @param {any} e */
  function onThreadPointerDown(e) {
    if (!edTicks) return;
    threadDrag = { startX: e.clientX, startOffset: offset, pps: edPps || 10, moved: false };
    if (e.currentTarget && e.currentTarget.setPointerCapture) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    }
    if (e.preventDefault) e.preventDefault();
  }

  /** @param {any} e */
  function onThreadPointerMove(e) {
    if (!threadDrag) return;
    const dx = e.clientX - threadDrag.startX;
    if (Math.abs(dx) > 4) threadDrag.moved = true;
    if (!(threadDrag.pps > 0)) return;
    // 1:1 spatial: dragging the thread 10px at 10px/s shifts timing 1s.
    const next = threadDrag.startOffset + dx / threadDrag.pps;
    // {remote:true} = local-only while dragging (no per-frame room spam);
    // the final offset replicates once on pointerup.
    applyOffsetValue(Math.max(-THREAD_MAX_S, Math.min(THREAD_MAX_S, Math.round(next * 100) / 100)), { remote: true });
    paintEditorThread();
  }

  function onThreadPointerUp() {
    if (!threadDrag) return;
    const moved = threadDrag.moved;
    threadDrag = null;
    buildEditorTicks(); // snap the ticks to exact px positions
    paintEditorThread();
    if (moved && onOffsetCb) {
      try { onOffsetCb(offset); } catch (_) {} // ONE room replication per drag
    }
    if (moved) threadDragGuardUntil = Date.now() + 350;
  }

  function buildPanel() {
    panel = /** @type {HTMLElement} */ (h('div', 'subs-panel'));
    panel.hidden = true;

    const head = h('div', 'subs-panel__head');
    head.appendChild(h('h3', 'subs-panel__title', tr('subs.title', 'Subtitles')));
    const close = /** @type {HTMLButtonElement} */ (h('button', 'subs-panel__x', ''));
    close.setAttribute('aria-label', 'Close');
    close.appendChild(ic('x', 18));
    close.type = 'button';
    close.addEventListener('click', () => togglePanel(false));
    head.appendChild(close);
    panel.appendChild(head);

    // auto-load row
    const row1 = h('div', 'subs-panel__row');
    // Master switch first: subtitles on/off (persists the explicit choice).
    const toggle = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', tr('subs.toggle', 'On/Off')));
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      const next = !enabled;
      setEnabled(next);
      try {
        localStorage.setItem('wp:subs:pref', next ? 'on' : 'off'); // explicit choice wins over auto-load
      } catch (_) {}
    });
    row1.appendChild(toggle);
    langSel = /** @type {HTMLSelectElement} */ (h('select', 'subs-panel__select'));
    LANGS.forEach(([code, label]) => {
      const opt = /** @type {HTMLOptionElement} */ (h('option', '', label));
      opt.value = code;
      langSel.appendChild(opt);
    });
    // IP LANGUAGE FIRST: the geo UI language (WP_GEO country -> id) is the
    // default subtitle language - "impossible to miss". A saved choice only
    // counts when the user EXPLICITLY picked it in this select (flagged);
    // stale unflagged values never override the IP language again. (This
    // used to read WP.I18N.language which did not exist -> silently 'en'.)
    try {
      const saved = localStorage.getItem('wp:subslang');
      const explicit = localStorage.getItem('wp:subslang:explicit') === '1';
      langSel.value = (explicit && saved) || (WP.I18N && WP.I18N.language) || saved || 'en';
    } catch (_) {
      langSel.value = (WP.I18N && WP.I18N.language) || 'en';
    }
    row1.appendChild(langSel);
    // Switching language = save the choice + reload subs immediately.
    langSel.addEventListener('change', () => {
      try {
        localStorage.setItem('wp:subslang', langSel.value);
        localStorage.setItem('wp:subslang:explicit', '1'); // explicit pick beats geo
      } catch (_) {}
      if (video) void autoLoad(video, { force: true }); // instant reload in the new language
    });
    const loadBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', tr('subs.load', 'Auto-load')));
    loadBtn.type = 'button';
    loadBtn.addEventListener('click', () => {
      if (!video) {
        setStatus(tr('subs.noVideo', 'Start a video first.'), true);
        return;
      }
      void autoLoad(video, { force: true });
    });
    row1.appendChild(loadBtn);
    // Upload on the same row (compact) - a whole row for one input
    // crowded the panel.
    const file = /** @type {HTMLInputElement} */ (h('input', 'subs-panel__file'));
    file.type = 'file';
    file.accept = '.srt,.vtt,text/vtt';
    file.title = 'Load from file (.srt / .vtt)';
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        if (!parseSubtitles(raw).length) {
          setStatus(tr('subs.parseFailed', 'Could not read that subtitle file.'), true);
          return;
        }
        loadCues(raw);
        lastLoadedFileId = '';
        setStatus(f.name + ' \u00b7 ' + tr('subs.fromFile', 'from file'));
        if (onLoadedCb) {
          try {
            onLoadedCb({ fileId: null, label: f.name + ' (upload)' });
          } catch (_) {}
        }
      };
      reader.readAsText(f);
    });
    row1.appendChild(file);
    panel.appendChild(row1);

    // offset row
    const row3 = h('div', 'subs-panel__row');
    row3.appendChild(h('span', 'subs-panel__label', tr('subs.offset', 'Offset')));
    const mk = (/** @type {string} */ label, /** @type {number} */ d, /** @type {string} */ title) => {
      const b = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', label));
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', () => applyOffset(d));
      return b;
    };
    row3.appendChild(mk('−1s', -1, 'Delay subtitles'));
    row3.appendChild(mk('−¼s', -0.25, 'Delay subtitles a bit'));
    offsetVal = h('span', 'subs-panel__offset', '');
    row3.appendChild(offsetVal);
    row3.appendChild(mk('+¼s', 0.25, 'Advance subtitles a bit'));
    row3.appendChild(mk('+1s', 1, 'Advance subtitles'));
    // One-press sync lives on the SAME row (hint as tooltip) - the panel
    // had five button rows and felt crowded.
    syncBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm'));
    syncBtn.appendChild(ic('zap', 15));
    syncBtn.appendChild(document.createTextNode(tr('subs.tapSync', 'Sync')));
    syncBtn.type = 'button';
    syncBtn.title = tr('subs.snapHint', 'Press exactly when someone starts speaking \u2014 the next line snaps to now.');
    syncBtn.addEventListener('click', syncSnap); // ONE press = synced. No arming.
    row3.appendChild(syncBtn);
    panel.appendChild(row3);

    // mini timing editor: every cue as a tick on a strip; click = inspect,
    // Align = that line starts NOW (manual match, no mic, no arithmetic).
    const rowEd = h('div', 'subs-panel__row subs-editor');
    const edBar = h('div', 'subs-editor__bar');
    // THREAD SYNC: drag the strip itself (Premiere-style clip slide).
    edBar.addEventListener('pointerdown', onThreadPointerDown);
    edBar.addEventListener('pointermove', onThreadPointerMove);
    edBar.addEventListener('pointerup', onThreadPointerUp);
    edBar.addEventListener('pointercancel', onThreadPointerUp);
    edTicks = h('div', 'subs-editor__ticks');
    edPlay = h('div', 'subs-editor__play');
    edPlay.style.display = 'none';
    edBar.appendChild(edTicks);
    edBar.appendChild(edPlay);
    rowEd.appendChild(edBar);
    edInfo = h('div', 'subs-panel__hint', tr('subs.editorEmpty', 'Load subtitles to see their timing here.'));
    rowEd.appendChild(edInfo);
    edAlign = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', tr('subs.align', 'Align to playhead')));
    edAlign.type = 'button';
    edAlign.disabled = true;
    edAlign.title = tr('subs.alignHint', 'Makes this line start right now.');
    edAlign.addEventListener('click', () => {
      if (edSelected == null || !cues[edSelected]) return;
      const t = now();
      if (t < 0) return;
      const matched = cues[edSelected];
      applyOffsetValue(t - matched.start);
      setStatus(
        tr('subs.tapDone', 'Synced') + ': ' + (offset > 0 ? '+' : '') + offset.toFixed(2) + 's' +
          ' (' + fmtTS(matched.start) + ' \u2192 ' + tr('subs.now', 'now') + ')',
        false,
        'zap'
      );
      // Release the pick: the window resumes following the playhead.
      edSelected = null;
      edAlign.disabled = true;
      buildEditorTicks();
    });
    rowEd.appendChild(edAlign);
    const resetBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm subs-editor__reset', tr('subs.reset', 'Reset sync')));
    resetBtn.type = 'button';
    resetBtn.title = tr('subs.resetHint', 'Back to zero offset.');
    resetBtn.addEventListener('click', () => {
      applyOffsetValue(0);
    });
    rowEd.appendChild(resetBtn);
    // Zoom toggle: full timeline <-> 60s centered window (persisted).
    const zoomBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm subs-editor__zoom', edZoom ? '\u23f1 60s' : '\u2922 full'));
    zoomBtn.type = 'button';
    zoomBtn.title = tr('subs.zoomHint', 'Switch between the whole timeline and a 60-second working view.');
    zoomBtn.addEventListener('click', () => {
      edZoom = !edZoom;
      try {
        localStorage.setItem(ZOOM_PREF_KEY, edZoom ? '1' : '0');
      } catch (_) {}
      zoomBtn.textContent = edZoom ? '\u23f1 60s' : '\u2922 full';
      buildEditorTicks();
    });
    rowEd.appendChild(zoomBtn);
    // Text size joins the zoom toggle (both are display controls).
    const sizeBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', tr('subs.size', 'Size')));
    sizeBtn.type = 'button';
    sizeBtn.title = tr('subs.sizeHint', 'Cycle subtitle text size.');
    sizeBtn.addEventListener('click', () => {
      if (!overlay) return;
      SIZES.forEach(([cls]) => cls && overlay.classList.remove(cls));
      sizeIdx = (sizeIdx + 1) % SIZES.length;
      if (SIZES[sizeIdx][0]) overlay.classList.add(SIZES[sizeIdx][0]);
    });
    rowEd.appendChild(sizeBtn);
    panel.appendChild(rowEd);

    statusEl = h('div', 'subs-panel__status', '');
    panel.appendChild(statusEl);

    const hint = h('div', 'subs-panel__hint', tr('subs.hint', 'Keys: [ delay · ] advance (while the panel is open)'));
    panel.appendChild(hint);
    return panel;
  }

  /** @param {boolean} [force] */
  function togglePanel(force) {
    if (!panel) return;
    const show = force != null ? force : panel.hidden;
    panel.hidden = !show;
    if (show) {
      if (offsetVal) offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(2) + 's';
      panel.classList.remove('is-open');
      void panel.offsetWidth; // restart the slide-in transition
      panel.classList.add('is-open');
    }
  }

  // ---- h() ------------------------------------------------------------------
  /** @param {string} tag @param {string} cls @param {string} [text] */
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  // ---- public ---------------------------------------------------------------

  /**
   * Mount the overlay + panel into the player container.
   * @param {HTMLElement | null} container .player-wrap
   */
  function mount(container) {
    if (!container || overlay) return; // already mounted (room UI re-init)
    overlay = h('div', 'subs-overlay');
    overlay.style.display = 'none';
    overlayText = h('div', 'subs-overlay__text');
    overlay.appendChild(overlayText);
    container.appendChild(overlay);
    container.appendChild(buildPanel());
    global.addEventListener('message', onMessage);
    global.addEventListener('keydown', (/** @type {KeyboardEvent} */ ev) => {
      if (!panel || panel.hidden) return;
      if (ev.key === '[') applyOffset(-0.25);
      else if (ev.key === ']') applyOffset(0.25);
      else if (ev.key === 's' || ev.key === 'S') {
        syncSnap(); // keyboard alias for the one-press sync
      }
    });
  }

  /**
   * Track the room's current video (drives auto-load + offset persistence).
   * @param {{ type: string, id: string, season?: number, episode?: number } | null} v
   */
  /** @type {string} video identity of the last setVideo call (same-video guard) */
  let lastVideoKey = '';
  /** DISTINCT from the no-arg videoKey() (offset persistence key) — this
   * identifies a video for the same-video guard only.
   * @param {{ type?: string, id?: string|number, season?: number|null, episode?: number|null } | null} v */
  function videoIdentity(v) {
    if (!v || !v.id) return '';
    return [v.type || 'movie', v.id, v.season == null ? '' : v.season, v.episode == null ? '' : v.episode].join(':');
  }

  function setVideo(v) {
    const next = v && v.id ? v : null;
    const nextKey = videoIdentity(next);
    // SAME-VIDEO GUARD: setVideo fires on EVERY room-state message (join
    // echo, host video syncs, UI updates). Re-wiping cues and re-running the
    // auto-load search each time duplicated loads and — when one re-run's
    // search flaked and fell back to English — silently switched the whole
    // room's language. Unchanged video -> keep the loaded cues untouched.
    if (nextKey && nextKey === lastVideoKey) {
      // Same video: refresh the persisted offset (cheap, local) but NEVER
      // wipe cues or re-run the auto-load search — the burst of setVideo
      // calls from room-state messages must not re-search (and a flaky
      // re-search falling back to English must not flip the room's
      // subtitle language).
      offset = loadOffset();
      if (offsetVal) offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(2) + 's';
      return;
    }
    lastVideoKey = nextKey;
    video = next;
    roomSubsActive = false; // new video = fresh subtitle context (the old room pick is stale)
    cues = [];
    cueIdx = 0;
    gotClock = false;
    offset = loadOffset();
    if (offsetVal) offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(2) + 's';
    if (statusEl) statusEl.textContent = '';
    autoKey = ''; // new video -> auto-load runs again
    // AUTO-LOAD ON OPEN: every video gets subtitles automatically unless the
    // user explicitly turned them off (the CC toggle remembers the choice).
    if (video) {
      let pref = '';
      try {
        pref = localStorage.getItem('wp:subs:pref') || '';
      } catch (_) {}
      if (pref !== 'off') void autoLoad(video);
    }
  }

  WP.Subs = {
    mount: mount,
    setVideo: setVideo,
    togglePanel: togglePanel,
    loadCues: loadCues,
    setEnabled: setEnabled,
    parseSubtitles: parseSubtitles,
    syncSnap: syncSnap,
    onLoaded: (/** @type {function({fileId: string|null, label: string}): void} */ cb) => {
      onLoadedCb = cb;
    },
    onOffset: (/** @type {function(number): void} */ cb) => {
      onOffsetCb = cb;
    },
    loadRemote: loadRemote,
    applyRemoteOffset: applyRemoteOffset,
    // Internal hook for the runtime test-suite (not part of the UI contract).
    __test: {
      setLang(/** @type {string} */ l) {
        if (langSel) langSel.value = l;
      },
      state() {
        return { cues: cues.length, offset: offset, status: statusEl ? statusEl.textContent : '' };
      },
      /** Test hook: apply an offset as the UI would (repaints the thread). */
      setOffset(/** @type {number} */ v) {
        applyOffsetValue(v);
      },
    },
  };
  global.WP = WP;
})(window);
