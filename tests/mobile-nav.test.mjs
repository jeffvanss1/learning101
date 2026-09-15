// MOBILE NAVIGATION (feature: rail -> bottom bar + "More" sheet).
//
// The user's spec: on phones the left guide rail moves to the BOTTOM as a bar
// with only five slots ("not crowded"), with FRIENDS in the CENTRE slot; the
// rest of the menu lives in a "More" sheet, and the bar hides inside a room so
// the player keeps the screen.
//
// This file is BEHAVIORAL where it matters: it slices the SHIPPED setupSidenav()
// (+ the sheet helpers) out of dist/js/app.js and drives it against a stub DOM,
// so "tapping X navigates to Y" is executed, not eyeballed. The layout half of
// the contract (5 equal slots, off-canvas sheet, room hiding, safe area) is
// pinned against the shipped CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const APP = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
const CSS = readFileSync(join(ROOT, 'dist/css/catalog.css'), 'utf8');
const STYLE = readFileSync(join(ROOT, 'dist/css/style.css'), 'utf8');

function sliceNav() {
  const start = APP.indexOf('function mobileMenuOpen() {');
  assert.ok(start > 0, 'mobile sheet helpers present');
  const end = APP.indexOf('  // Top-nav profile button state', start);
  assert.ok(end > start, 'sidenav section ends at the profile section');
  return APP.slice(start, end);
}

// ---- stub DOM ---------------------------------------------------------------
class El {
  constructor(tag, cls) {
    this.tagName = tag;
    this.hidden = false;
    this.dataset = {};
    this._attrs = {};
    this._listeners = {};
    this._cls = new Set(String(cls || '').split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      contains: (c) => this._cls.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !this._cls.has(c) : !!force;
        if (on) this._cls.add(c);
        else this._cls.delete(c);
        return on;
      },
    };
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null;
  }
  addEventListener(t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  }
  fire(t, ev) {
    (this._listeners[t] || []).forEach((fn) => fn(ev || { key: '', stopPropagation() {}, preventDefault() {} }));
  }
  /** querySelectorAll for the two patterns setupSidenav uses on the rail. */
  querySelectorAll(sel) {
    if (sel.indexOf('.sidenav__item') !== -1) return this._railItems || [];
    return [];
  }
}

function harness({ roomHidden = true, pathname = '/' } = {}) {
  const els = {};
  ['room', 'home', 'profile', 'discovery', 'history-page', 'sidenav-close', 'sidenav-backdrop', 'bottomnav-more'].forEach(
    (id) => (els[id] = new El('div'))
  );
  els['room'].hidden = roomHidden;
  els['home'].hidden = false;
  els['profile'].hidden = true;
  els['discovery'].hidden = true;
  els['history-page'].hidden = true;
  els['sidenav-backdrop'].hidden = true;

  // rail items (the five destination keys + the rail-only ones + admin + start-room)
  const rail = [];
  const bar = [];
  for (const key of ['home', 'movies', 'series', 'anime', 'friends', 'history', 'trending', 'top-movies', 'start-room']) {
    const it = new El('button', key === 'home' ? 'sidenav__item is-active' : 'sidenav__item');
    it.dataset.nav = key;
    rail.push(it);
  }
  const sidenav = new El('aside');
  sidenav._railItems = rail;
  els['sidenav'] = sidenav;
  for (const key of ['home', 'movies', 'friends', 'series', 'more']) {
    const it = new El('button', key === 'home' ? 'bottomnav__item is-active' : 'bottomnav__item');
    it.dataset.nav = key;
    if (key === 'friends') it.classList.add('bottomnav__item--center');
    bar.push(it);
  }

  const body = new El('body');
  const document = {
    body: body,
    querySelectorAll: (sel) => (sel.indexOf('.bottomnav__item') !== -1 ? bar : []),
    addEventListener(t, fn) {
      (this._listeners = this._listeners || {}), (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    fire(t, ev) {
      ((this._listeners || {})[t] || []).forEach((fn) => fn(ev));
    },
  };
  const calls = { pushState: [], routeCurrent: 0, goHome: 0, refresh: 0, clearSearch: 0, scrollTop: 0, startRoom: 0, toggleFriends: 0 };
  const history = {
    pushState: (a, b, url) => calls.pushState.push(url),
  };
  const location = { pathname, search: '' };
  const state = { browseHandle: { refresh: () => (calls.refresh += 1) }, roomId: null };
  const WP = {
    Social: { toggleFriendsRail: () => (calls.toggleFriends += 1) },
  };
  const localStorage = { getItem: () => null, setItem() {} };
  const listeners = {};
  const window = {
    addEventListener: (t, fn) => ((listeners[t] = listeners[t] || []).push(fn)),
    dispatchEvent: (ev) => ((listeners[ev.type] || []).forEach((fn) => fn(ev)), true),
  };

  const fn = new Function(
    'WP',
    'state',
    '$',
    'document',
    'window',
    'localStorage',
    'history',
    'location',
    'goHome',
    'routeCurrent',
    'startRoomWithVideo',
    'scrollHomeTop',
    'clearSearchInputs',
    'let setActiveNav = function () {};\n' + sliceNav() + '\nreturn { setupSidenav, setMobileMenu, mobileMenuOpen, closeMobileMenu, toggleMobileMenu, setActiveNav: function (k) { setActiveNav(k); } };'
  )(
    WP,
    state,
    (id) => els[id] || null,
    document,
    window,
    localStorage,
    history,
    location,
    () => (calls.goHome += 1),
    () => (calls.routeCurrent += 1),
    () => (calls.startRoom += 1),
    () => (calls.scrollTop += 1),
    () => (calls.clearSearch += 1)
  );
  return { api: fn, els, rail, bar, body, document, calls, state, winListeners: listeners };
}

const barItem = (h, key) => h.bar.find((it) => it.dataset.nav === key);
const railItem = (h, key) => h.rail.find((it) => it.dataset.nav === key);

// ---- markup -----------------------------------------------------------------

test('bottom bar: FIVE slots, friends in the CENTRE, and it is the last main-column child', () => {
  const nav = HTML.slice(HTML.indexOf('<nav id="bottomnav"'), HTML.indexOf('</nav>', HTML.indexOf('<nav id="bottomnav"')));
  const items = nav.match(/class="bottomnav__item[^"]*" data-nav="([a-z-]+)"/g) || [];
  assert.equal(items.length, 5, 'exactly five slots (not crowded)');
  const keys = items.map((m) => m.match(/data-nav="([a-z-]+)"/)[1]);
  assert.deepEqual(keys, ['home', 'movies', 'friends', 'series', 'more'], 'friends is the centre slot');
  assert.ok(
    nav.indexOf('data-nav="friends"') > nav.indexOf('data-nav="movies"') &&
      nav.indexOf('data-nav="friends"') < nav.indexOf('data-nav="series"'),
    'friends sits dead centre'
  );
  assert.match(nav, /bottomnav__item--center/, 'the centre slot is marked for the accent disc');
  // every slot is an inline SVG + a translated label (no emoji, no icon font)
  assert.equal((nav.match(/<svg /g) || []).length, 5, 'one inline SVG per slot');
  assert.equal((nav.match(/data-i18n="nav\./g) || []).length, 5, 'one label key per slot');
  // Layout contract: the bar is the LAST child of the main column, so views
  // shrink by its height instead of being covered by it.
  const mainStart = HTML.indexOf('<div class="app-shell__main">');
  const barAt = HTML.indexOf('<nav id="bottomnav"');
  const historyAt = HTML.indexOf('id="history-page"');
  const mainEnd = HTML.indexOf('<!-- Backdrop for the mobile "More" sheet');
  assert.ok(mainStart < barAt && barAt < mainEnd, 'bar lives inside the main column');
  assert.ok(historyAt < barAt, 'bar comes after every view surface');
});

test('More sheet: the rail carries a sheet head + close button, and the backdrop exists', () => {
  assert.match(HTML, /class="sidenav__sheet-head"[\s\S]*?id="sidenav-close"/, 'sheet header with a close button');
  assert.match(HTML, /id="sidenav-close"[\s\S]*?aria-label="Close menu"/, 'close button is labelled');
  assert.match(HTML, /<div id="sidenav-backdrop" class="sidenav-backdrop" hidden><\/div>/, 'backdrop exists (hidden by default)');
  assert.match(HTML, /id="bottomnav-more"[\s\S]*?aria-expanded="false"[\s\S]*?aria-controls="sidenav"/, 'More announces what it controls');
  assert.match(HTML, /class="sidenav__sheet-title" data-i18n="nav\.more"/, 'sheet titled "More"');
});

// ---- behavior: the bar drives the same navigator as the rail ----------------

test('bar: a destination tap navigates EXACTLY like the rail item (movies -> /discovery/movies)', () => {
  const h = harness();
  h.api.setupSidenav();
  barItem(h, 'movies').fire('click');
  assert.deepEqual(h.calls.pushState, ['/discovery/movies'], 'route pushed from the bar');
  assert.equal(h.calls.routeCurrent, 1, 'router ran once');
  // rail parity on a fresh harness
  const g = harness();
  g.api.setupSidenav();
  railItem(g, 'movies').fire('click');
  assert.deepEqual(g.calls.pushState, ['/discovery/movies'], 'same route from the rail');
});

test('bar: Home refreshes the browse feed (not just a route push)', () => {
  const h = harness();
  h.api.setupSidenav();
  barItem(h, 'home').fire('click');
  assert.equal(h.calls.refresh, 1, 'browse refreshed');
  assert.equal(h.calls.clearSearch, 1, 'search inputs cleared');
  assert.equal(h.calls.scrollTop, 1, 'scrolled back to the top');
});

test('bar: the CENTRE slot opens the friends drawer (the rail item does the same)', () => {
  const h = harness();
  h.api.setupSidenav();
  barItem(h, 'friends').fire('click');
  assert.equal(h.calls.toggleFriends, 1, 'friends drawer toggled');
  assert.equal(h.calls.pushState.length, 0, 'opening friends is not a navigation');
  const g = harness();
  g.api.setupSidenav();
  railItem(g, 'friends').fire('click');
  assert.equal(g.calls.toggleFriends, 1, 'rail parity');
});

test('bar: a rail-only destination (trending) lights the MORE slot instead of nothing', () => {
  const h = harness();
  h.api.setupSidenav();
  h.api.setActiveNav('trending');
  assert.ok(barItem(h, 'more').classList.contains('is-active'), 'More shows where you are');
  assert.ok(!barItem(h, 'home').classList.contains('is-active'), 'no stale selection');
  assert.ok(railItem(h, 'trending').classList.contains('is-active'), 'the rail keeps its own active state');
  h.api.setActiveNav('home');
  assert.ok(!barItem(h, 'more').classList.contains('is-active'), 'More releases the highlight');
  assert.ok(barItem(h, 'home').classList.contains('is-active'), 'Home takes it');
});

test('bar: in a room, Home leaves the room; More/sheet still work', () => {
  const h = harness({ roomHidden: false });
  h.api.setupSidenav();
  barItem(h, 'home').fire('click');
  assert.equal(h.calls.goHome, 1, 'bar Home exits the room');
  assert.equal(h.calls.pushState.length, 0, 'no double navigation');
  barItem(h, 'more').fire('click');
  assert.ok(h.api.mobileMenuOpen(), 'the sheet still opens inside a room');
});

// ---- behavior: the More sheet ----------------------------------------------

test('More sheet: opens/closes from the bar, the X, the backdrop and Escape', () => {
  const h = harness();
  h.api.setupSidenav();
  assert.equal(h.api.mobileMenuOpen(), false, 'closed by default');
  assert.equal(h.els['sidenav-backdrop'].hidden, true, 'backdrop hidden');

  barItem(h, 'more').fire('click');
  assert.ok(h.api.mobileMenuOpen(), 'More opens the sheet');
  assert.equal(h.els['sidenav-backdrop'].hidden, false, 'backdrop shown');
  assert.equal(h.els['bottomnav-more'].getAttribute('aria-expanded'), 'true', 'aria-expanded follows');
  assert.equal(h.calls.pushState.length, 0, 'opening the sheet is NOT a navigation');

  barItem(h, 'more').fire('click');
  assert.equal(h.api.mobileMenuOpen(), false, 'tapping More again closes it');

  barItem(h, 'more').fire('click');
  h.els['sidenav-close'].fire('click');
  assert.equal(h.api.mobileMenuOpen(), false, 'the X closes it');

  barItem(h, 'more').fire('click');
  h.els['sidenav-backdrop'].fire('click');
  assert.equal(h.api.mobileMenuOpen(), false, 'the backdrop closes it');
  assert.equal(h.els['sidenav-backdrop'].hidden, true, 'backdrop hidden again');

  barItem(h, 'more').fire('click');
  h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.api.mobileMenuOpen(), false, 'Escape closes it');
  assert.equal(h.els['bottomnav-more'].getAttribute('aria-expanded'), 'false', 'aria-expanded reset');
});

test('More sheet: choosing an entry inside the sheet navigates AND closes the sheet', () => {
  const h = harness();
  h.api.setupSidenav();
  barItem(h, 'more').fire('click');
  railItem(h, 'history').fire('click');
  assert.deepEqual(h.calls.pushState, ['/history'], 'sheet entry routed');
  assert.equal(h.api.mobileMenuOpen(), false, 'sheet got out of the way');
});

test('friends drawer state reaches the centre slot (wp:friends-toggled)', () => {
  const h = harness();
  h.api.setupSidenav();
  const fire = (open) => (h.winListeners['wp:friends-toggled'] || []).forEach((fn) => fn({ detail: { open } }));
  assert.equal((h.winListeners['wp:friends-toggled'] || []).length, 1, 'the chrome listens for the drawer state');
  fire(true);
  assert.ok(barItem(h, 'friends').classList.contains('is-open'), 'centre disc marks the open drawer');
  fire(false);
  assert.ok(!barItem(h, 'friends').classList.contains('is-open'), 'and clears when it closes');
  // social.js is the emitter (the shipped rail announces open/close/dock).
  const social = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(social, /new CustomEvent\('wp:friends-toggled', \{ detail: \{ open: railIsVisible\(\) \} \}\)/, 'rail emits the event');
  assert.ok((social.match(/emitToggled\(\);/g) || []).length >= 3, 'open, close AND dock changes announce');
});

// ---- CSS layout contract ----------------------------------------------------

test('CSS: bar is display:none on desktop and a 5-slot grid on phones', () => {
  assert.match(CSS, /\.bottomnav \{\n  display: none;\n\}/, 'desktop keeps the left rail only');
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px) {'), CSS.indexOf('@media (max-width: 520px)'));
  assert.match(mobile, /\.bottomnav \{[\s\S]*?display: grid;/, 'phones get the bar');
  assert.match(mobile, /grid-template-columns: repeat\(5, 1fr\);/, 'five equal slots');
  assert.match(mobile, /min-height: var\(--bottomnav-h\);/, 'thumb-sized slot');
  assert.match(mobile, /padding-bottom: env\(safe-area-inset-bottom, 0px\);/, 'iPhone home-indicator safe area');
  assert.match(mobile, /\.bottomnav__item\.is-active \{[\s\S]*?color: var\(--text\);/, 'active slot is themed ink');
  assert.match(mobile, /\.bottomnav__center-disc \{[\s\S]*?border-radius: 50%;[\s\S]*?background: var\(--red\);/, 'centre = one red disc');
  assert.match(STYLE, /--bottomnav-h: 58px;/, 'bar height is a token in :root');
});

test('CSS: the rail becomes an off-canvas sheet (backdrop behind it, labels kept)', () => {
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px) {'), CSS.indexOf('@media (max-width: 520px)'));
  assert.match(mobile, /\.sidenav \{[\s\S]*?position: fixed;[\s\S]*?transform: translateX\(-102%\);/, 'rail slides in from the left');
  assert.match(mobile, /body\.menu-open \.sidenav \{[^}]*transform: none;[^}]*visibility: visible;/, 'menu-open reveals it');
  assert.match(mobile, /\.sidenav \{[\s\S]*?visibility: hidden;/, 'the closed sheet is unreachable (keyboard/AT)');
  assert.match(mobile, /\[dir='rtl'\] \.sidenav \{[\s\S]*?right: 0;[\s\S]*?transform: translateX\(102%\);/, 'Arabic mirrors the sheet to the right');
  assert.match(mobile, /\.sidenav-backdrop \{[\s\S]*?z-index: 55;/, 'backdrop above content');
  assert.match(mobile, /\.sidenav \{[\s\S]*?z-index: 60;/, 'sheet above the backdrop');
  assert.match(mobile, /\[data-nav='home'\][\s\S]*?\[data-nav='friends'\] \{\n    display: none;\n  \}/, 'sheet hides what the bar already carries');
  assert.match(mobile, /\.sidenav__group--bottom \{\n    order: -1;/, 'Start a room moves to the top of the sheet');
  assert.match(mobile, /\.sidenav__sheet-head \{\n    display: flex;/, 'sheet header visible on phones');
  assert.ok(!/flex-basis: 56px/.test(CSS), 'the old 56px icon strip is gone');
});

test('CSS: bar hides in a room and returns under the in-room peek', () => {
  const mobile = CSS.slice(CSS.indexOf('@media (max-width: 720px) {'), CSS.indexOf('@media (max-width: 520px)'));
  assert.match(mobile, /body\.room-focus \.bottomnav \{\n    display: none;\n  \}/, 'rooms keep the whole screen');
  assert.match(mobile, /body\.room-focus\.rail-peek \.bottomnav \{\n    display: grid;\n  \}/, 'the in-room peek brings it back');
});

test('CSS: a persisted desktop collapse can never shrink the mobile sheet', () => {
  assert.match(
    CSS,
    /@media \(min-width: 721px\) \{\n  body\.sidenav-collapsed \.sidenav \{/,
    'collapse rules are desktop-gated'
  );
  const before = CSS.slice(0, CSS.indexOf('@media (min-width: 721px) {'));
  assert.ok(!/^body\.sidenav-collapsed/m.test(before), 'no ungated collapse RULE (comments may mention it)');
});

test('i18n: every locale knows the new "More" label', () => {
  const i18n = readFileSync(join(ROOT, 'dist/js/i18n.js'), 'utf8');
  assert.equal((i18n.match(/'nav\.more':/g) || []).length, 6, 'one per supported locale (en/id/es/fr/pt/ar)');
  for (const lang of ['en', 'id', 'es', 'fr', 'pt', 'ar']) {
    const block = i18n.slice(i18n.indexOf('    ' + lang + ': {'));
    const next = block.slice(0, block.indexOf('\n    },'));
    assert.match(next, /'nav\.more':/, lang + ' has nav.more');
  }
  assert.equal((HTML.match(/data-i18n="nav\.more"/g) || []).length, 2, 'the More slot + the sheet title');
});
