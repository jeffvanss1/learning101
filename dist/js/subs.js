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

  /** @param {string} msg @param {boolean} [isError] */
  function setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = 'subs-panel__status' + (isError ? ' subs-panel__status--err' : '');
  }

  /** @param {{ type: string, id: string, season?: number, episode?: number }} v @param {string} lang @returns {Promise<{ fileId: number, release: string, lang: string, downloads: number } | null>} */
  async function searchBest(v, lang) {
    const qs = new URLSearchParams({
      type: v.type === 'movie' ? 'movie' : 'tv',
      tmdb: String(v.id),
    });
    if (v.type !== 'movie' && v.season != null) qs.set('season', String(v.season));
    if (v.type !== 'movie' && v.episode != null) qs.set('episode', String(v.episode));
    if (lang) qs.set('lang', lang);
    const res = await fetch('/api/subs/search?' + qs.toString());
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setStatus((data && data.error) || tr('subs.searchFailed', 'Subtitle search failed.'), true);
      return null;
    }
    // Diagnosability: the exact upstream query + result count, in DevTools.
    try {
      console.info('[WatchParty] subs search:', data.query, '-> total', data.total, 'best', !!data.best);
    } catch (_) {}
    if (data.best) return data.best;
    if (data.total > 0) {
      setStatus(tr('subs.noneDownloadable', 'Subtitles exist but none are downloadable with this API key/plan.'), true);
    }
    return null;
  }

  /**
   * Language fallback chain: requested language -> English -> ANY language
   * (no filter). Indonesian-dubbed titles usually have no Indonesian subs —
   * "nothing found" must never be the end of the road when English ones exist.
   * @param {{ type: string, id: string, season?: number, episode?: number }} v
   */
  async function autoLoad(v) {
    if (!v || !v.id) return;
    const primary = langSel ? langSel.value : 'en';
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
        setStatus(e instanceof Error ? e.message : tr('subs.searchFailed', 'Subtitle search failed.'), true);
        return;
      }
      if (!best) continue;
      const fileRes = await fetch('/api/subs/file?fileId=' + best.fileId);
      if (!fileRes.ok) {
        const err = await fileRes.json().catch(() => null);
        setStatus((err && err.error) || tr('subs.loadFailed', 'Could not download the subtitle.'), true);
        return;
      }
      loadCues(await fileRes.text());
      const label = (LANGS.find((l) => l[0] === best.lang) || [best.lang, best.lang])[1];
      const suffix =
        lang !== primary
          ? ' · ' + tr('subs.fallback', 'no {lang} subs — language fallback').replace('{lang}', primary.toUpperCase())
          : '';
      setStatus(
        tr('subs.loaded', 'Loaded') +
          ': ' + (best.release || 'subtitle') +
          ' [' + label + ', ' + (best.downloads || 0) + '\u2193]' + suffix
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
    cancelTapSync();
    if (cues.length && !enabled) setEnabled(true);
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

  function applyOffsetValue(abs) {
    offset = Math.round(abs * 100) / 100;
    saveOffset(offset);
    if (offsetVal) offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(2) + 's';
    cueIdx = 0;
  }

  function applyOffset(delta) {
    applyOffsetValue(offset + delta);
  }

  // ---- tap-sync ---------------------------------------------------------------
  // One-press exact sync: we show the line that should be spoken, the user
  // taps (or hits SPACE) the moment they HEAR it, and the offset is computed
  // precisely from the player clock: playerTime(at tap) - cue.start.
  let tapTarget = /** @type {number | null} */ (null);
  /** @type {HTMLButtonElement | null} */
  let tapBtn = null;

  function armTapSync() {
    if (!cues.length) {
      setStatus(tr('subs.none', 'No subtitles loaded.'), true);
      return;
    }
    const t = now();
    const target = cues.find((c) => c.start >= t + 0.5) || cues[cues.length - 1];
    tapTarget = target.start;
    const line = String(target.text).split('\n')[0].slice(0, 60);
    setStatus(tr('subs.tapListen', 'Listen for') + ': \u201C' + line + '\u201D \u2014 ' + tr('subs.tapWhen', 'tap when you hear it'));
    if (tapBtn) tapBtn.textContent = tr('subs.tapNow', 'TAP NOW');
  }

  function tapSync() {
    if (tapTarget == null) return;
    const playerTime = now() + offset; // now() already subtracts the offset
    const newOffset = playerTime - tapTarget;
    tapTarget = null;
    applyOffsetValue(newOffset);
    if (tapBtn) tapBtn.textContent = tr('subs.tapSync', 'Tap-sync');
    setStatus(
      tr('subs.tapDone', 'Synced') + ': ' + (offset > 0 ? '+' : '') + offset.toFixed(2) + 's' +
        ' (' + tr('subs.offset', 'Offset') + ' ' + tr('subs.persisted', 'saved for this title') + ')'
    );
  }

  function cancelTapSync() {
    tapTarget = null;
    if (tapBtn) tapBtn.textContent = tr('subs.tapSync', 'Tap-sync');
  }

  function buildPanel() {
    panel = /** @type {HTMLElement} */ (h('div', 'subs-panel'));
    panel.hidden = true;

    const head = h('div', 'subs-panel__head');
    head.appendChild(h('h3', 'subs-panel__title', tr('subs.title', 'Subtitles')));
    const close = /** @type {HTMLButtonElement} */ (h('button', 'subs-panel__x', '×'));
    close.type = 'button';
    close.addEventListener('click', () => togglePanel(false));
    head.appendChild(close);
    panel.appendChild(head);

    // auto-load row
    const row1 = h('div', 'subs-panel__row');
    langSel = /** @type {HTMLSelectElement} */ (h('select', 'subs-panel__select'));
    LANGS.forEach(([code, label]) => {
      const opt = /** @type {HTMLOptionElement} */ (h('option', '', label));
      opt.value = code;
      langSel.appendChild(opt);
    });
    langSel.value = (WP.I18N && WP.I18N.language) || 'en';
    row1.appendChild(langSel);
    const loadBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', tr('subs.load', 'Auto-load')));
    loadBtn.type = 'button';
    loadBtn.addEventListener('click', () => {
      if (!video) {
        setStatus(tr('subs.noVideo', 'Start a video first.'), true);
        return;
      }
      void autoLoad(video);
    });
    row1.appendChild(loadBtn);
    panel.appendChild(row1);

    // upload row
    const row2 = h('div', 'subs-panel__row');
    const file = /** @type {HTMLInputElement} */ (h('input', 'subs-panel__file'));
    file.type = 'file';
    file.accept = '.srt,.vtt,text/vtt';
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const n = parseSubtitles(String(reader.result || '')).length;
        if (!n) {
          setStatus(tr('subs.parseFailed', 'Could not read that subtitle file.'), true);
          return;
        }
        setStatus(n + ' cues ' + tr('subs.fromFile', 'from file'));
      };
      reader.readAsText(f);
    });
    row2.appendChild(file);
    panel.appendChild(row2);

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
    panel.appendChild(row3);

    const row3a = h('div', 'subs-panel__row');
    tapBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--primary btn--sm', tr('subs.tapSync', 'Tap-sync')));
    tapBtn.type = 'button';
    tapBtn.title = tr('subs.tapWhen', 'tap when you hear it');
    tapBtn.addEventListener('click', () => {
      if (tapTarget == null) armTapSync();
      else tapSync();
    });
    row3a.appendChild(tapBtn);
    panel.appendChild(row3a);

    const row3b = h('div', 'subs-panel__row');
    const reset = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', tr('subs.reset', 'Reset offset')));
    reset.type = 'button';
    reset.addEventListener('click', () => {
      offset = 0;
      saveOffset(0);
      if (offsetVal) offsetVal.textContent = '0.00s';
    });
    row3b.appendChild(reset);
    const sizeBtn = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', tr('subs.size', 'Size')));
    sizeBtn.type = 'button';
    sizeBtn.addEventListener('click', () => {
      if (!overlay) return;
      SIZES.forEach(([cls]) => cls && overlay.classList.remove(cls));
      sizeIdx = (sizeIdx + 1) % SIZES.length;
      if (SIZES[sizeIdx][0]) overlay.classList.add(SIZES[sizeIdx][0]);
    });
    row3b.appendChild(sizeBtn);
    const toggle = /** @type {HTMLButtonElement} */ (h('button', 'btn btn--ghost btn--sm', tr('subs.toggle', 'On/Off')));
    toggle.type = 'button';
    toggle.addEventListener('click', () => setEnabled(!enabled));
    row3b.appendChild(toggle);
    panel.appendChild(row3b);

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
      else if (ev.key === ' ' && tapTarget != null) {
        ev.preventDefault(); // don't scroll the page mid-sync
        tapSync();
      }
    });
  }

  /**
   * Track the room's current video (drives auto-load + offset persistence).
   * @param {{ type: string, id: string, season?: number, episode?: number } | null} v
   */
  function setVideo(v) {
    video = v && v.id ? v : null;
    cues = [];
    cueIdx = 0;
    cancelTapSync();
    gotClock = false;
    offset = loadOffset();
    if (offsetVal) offsetVal.textContent = (offset > 0 ? '+' : '') + offset.toFixed(2) + 's';
    if (statusEl) statusEl.textContent = '';
    if (video && enabled) void autoLoad(video); // next episode: reload automatically
  }

  WP.Subs = {
    mount: mount,
    setVideo: setVideo,
    togglePanel: togglePanel,
    loadCues: loadCues,
    setEnabled: setEnabled,
    parseSubtitles: parseSubtitles,
    armTapSync: armTapSync,
    tapSync: tapSync,
    // Internal hook for the runtime test-suite (not part of the UI contract).
    __test: {
      setLang(/** @type {string} */ l) {
        if (langSel) langSel.value = l;
      },
      state() {
        return { cues: cues.length, offset: offset, tapTarget: tapTarget, status: statusEl ? statusEl.textContent : '' };
      },
    },
  };
  global.WP = WP;
})(window);
