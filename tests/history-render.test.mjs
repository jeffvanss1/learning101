// BEHAVIORAL: the /history render path is EXECUTED here (sliced out of the
// shipped app.js and run against a stub DOM). This is the regression that
// shipped twice: renderHistory() guarded on a removed element and the whole
// page went silently blank. Now proven by execution, not by eyeballing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

function sliceRenderHistory() {
  const a = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  const start = a.indexOf('function renderHistory() {');
  assert.ok(start > 0, 'renderHistory present');
  const chips = a.indexOf('function renderHistoryChips(', start);
  assert.ok(chips > start, 'renderHistoryChips follows');
  const end = a.indexOf('\n  }', a.indexOf('];', chips)) + 4;
  return a.slice(start, end);
}

function harness({ local = [], signedIn = null, boom = false } = {}) {
  const els = {};
  const mk = (id) => ({
    id,
    kids: [],
    hidden: false,
    innerHTML: '',
    className: '',
    title: '',
    textContent: '',
    style: { setProperty() {} },
    setAttribute() {},
    addEventListener() {},
    appendChild(c) {
      this.kids.push(c);
      return c;
    },
    querySelectorAll() {
      return [];
    },
  });
  ['history-scroller', 'history-empty', 'history-filters'].forEach((id) => (els[id] = mk(id)));
  const document = { createElement: () => mk('dyn'), createTextNode: (t) => ({ text: t }) };
  const WP = {
    historyGet: boom
      ? () => {
          throw new Error('storage broken');
        }
      : () => local,
    historyKey: (v) => `${v.id}|${v.season ?? ''}|${v.episode ?? ''}`,
    historyRemove: () => {},
    timeAgo: () => '5m ago',
    Social: signedIn === null ? undefined : { getSession: () => (signedIn ? { user: {} } : null) },
  };
  const state = {};
  const $ = (id) => els[id] || null;
  const errors = [];
  const consoleError = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  try {
    const fn = new Function('WP', 'state', '$', 'document', 'window', sliceRenderHistory() + '\nreturn renderHistory;')(
      WP,
      state,
      $,
      document,
      {}
    );
    fn();
  } finally {
    console.error = consoleError;
  }
  return els;
}

test('/history EXECUTES: local entries render as cards (dead-guard regression)', () => {
  const els = harness({
    local: [
      { type: 'movie', id: '27205', src: 'x', title: 'Inception', watchedAt: Date.now() - 60000, position: 600, duration: 8000 },
      { type: 'tv', id: '1399', src: 'y', title: 'GoT', season: 1, episode: 3, watchedAt: Date.now() - 3000, position: 100, duration: 3000 },
    ],
  });
  assert.equal(els['history-scroller'].kids.length, 2, 'two cards rendered');
  assert.equal(els['history-empty'].hidden, true, 'empty state hidden');
  assert.equal(els['history-filters'].kids.length, 4, 'filter chips rendered');
});

test('/history empty + SIGNED OUT says so (never a bare blank)', () => {
  const els = harness({ local: [], signedIn: false });
  assert.equal(els['history-scroller'].kids.length, 0, 'no cards');
  assert.match(els['history-empty'].textContent, /Sign in/, 'signed-out hint shown');
});

test('/history empty + signed in points at the account', () => {
  const els = harness({ local: [], signedIn: true });
  assert.match(els['history-empty'].textContent, /account/, 'account hint shown');
});

test('/history render failure shows the ERROR (never silent blank)', () => {
  const els = harness({ boom: true });
  assert.match(els['history-empty'].textContent, /History failed to load: storage broken/, 'visible error with cause');
  assert.equal(els['history-scroller'].kids.length, 0);
});
