// PRESENCE NOTIFICATIONS — "a friend came online" / "started watching", EXECUTED.
//
// The notification section of dist/js/social.js is sliced out and run against a
// stub DOM, so the transition rules, the cooldowns, the baseline sweep, the
// mute and the toast itself are tested as BEHAVIOUR (not greps): the whole point
// of the feature is knowing WHEN NOT to interrupt someone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dompath.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The watcher's own 30s heartbeat is a real interval: unref it here so a test
// that fails BEFORE its stop() can never hold the whole suite open.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms) => {
  const t = realSetInterval(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

/** social.js section: presence notifications (between the friends panel and likes). */
function sliceNotify() {
  const src = read('dist/js/social.js');
  const start = src.indexOf('  // 9. Presence notifications');
  assert.ok(start > 0, 'presence-notifications section present in social.js');
  const from = src.lastIndexOf('  // ---', start);
  const end = src.indexOf('  // 11b. LIKES: uncapped taste signal', start);
  assert.ok(end > from, 'the section ends at the likes section');
  return (
    src.slice(from, end) +
    '\nreturn { presenceKind: presenceKind, presenceTransition: presenceTransition, ' +
    'presenceSweep: presenceSweep, presenceNotifyText: presenceNotifyText, ' +
    'showPresenceToast: showPresenceToast, renderPresenceEvents: renderPresenceEvents, ' +
    'startPresenceWatch: startPresenceWatch, notifyPrefOn: notifyPrefOn, ' +
    'setNotifyPref: setNotifyPref, toggleNotifyPref: toggleNotifyPref, ' +
    'NOTIFY_COOLDOWN_MS: NOTIFY_COOLDOWN_MS, NOTIFY_TTL_MS: NOTIFY_TTL_MS, ' +
    'NOTIFY_MAX_ON_SCREEN: NOTIFY_MAX_ON_SCREEN, NOTIFY_MAX_NAMED: NOTIFY_MAX_NAMED };'
  );
}

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.textContent = '';
    this.type = '';
    this.dataset = {};
    this._attrs = {};
    this._handlers = {};
    this._classes = new Set();
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._classes.add(x)),
      remove: (...c) => c.forEach((x) => self._classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c);
        else self._classes.delete(c);
        return on;
      },
      contains: (c) => self._classes.has(c),
    };
  }
  get className() {
    return [...this._classes].join(' ');
  }
  set className(v) {
    this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return this._attrs[k] === undefined ? null : this._attrs[k];
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    }
    this.parentNode = null;
  }
  addEventListener(type, fn) {
    (this._handlers[type] = this._handlers[type] || []).push(fn);
  }
  fire(type, ev) {
    (this._handlers[type] || []).forEach((fn) => fn(ev || { stopPropagation() {} }));
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.flatMap((c) => [
      ...(c.classList.contains(cls) ? [c] : []),
      ...(c.querySelectorAll ? c.querySelectorAll(sel) : []),
    ]);
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get all() {
    return this.children.flatMap((c) => (c.all ? [c, ...c.all] : [c]));
  }
}

/** One friend row, the way /api/friends returns it. */
function friend(username, presence, extra = {}) {
  return {
    username,
    displayName: username.charAt(0).toUpperCase() + username.slice(1),
    avatarUrl: '/a/' + username + '.png',
    avatarFrameId: 'none',
    presence,
    ...extra,
  };
}

const watching = (title, mediaId, room, isHost) => ({
  status: room ? 'WATCHING_PARTY' : 'WATCHING_SOLO',
  room_id: room || '',
  media_title: title,
  media_id: mediaId,
  current_timestamp: '12:34',
  is_host: !!isHost,
  last_updated: 0,
});
const IDLE = { status: 'IDLE', room_id: '', media_title: '', media_id: '', current_timestamp: '', is_host: false, last_updated: 0 };
const OFFLINE = { status: 'OFFLINE', room_id: '', media_title: '', media_id: '', current_timestamp: '', is_host: false, last_updated: 0 };

/**
 * Run the shipped notification section with a stub DOM.
 * @param {{ friends?: any[], session?: boolean, pref?: string|null, visibility?: 'visible'|'hidden' }} [o]
 */
function harness(o = {}) {
  const store = {};
  if (o.pref != null) store['wp:notify-presence'] = o.pref;
  const toasts = new El('div');
  const toastsById = { toasts };
  const doc = {
    visibilityState: o.visibility || 'visible',
    getElementById: (id) => toastsById[id] || null,
    createElement: (tag) => new El(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  const navigations = [];
  const globalObj = {
    location: { pathname: '/', assign: (u) => navigations.push(u), origin: 'https://example.test' },
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
    WP: {
      setIcon: (el, name) => {
        el.setAttribute('data-icon', name);
      },
    },
  };
  const h = (tag, cls, text) => {
    const el = new El(tag);
    if (cls) el.className = cls;
    if (text !== undefined && text !== null) el.textContent = text;
    return el;
  };
  const plainToasts = [];
  let calls = 0;
  let payload = { friends: o.friends || [] };
  const api = () => {
    calls += 1;
    return o.api ? o.api(payload, calls) : Promise.resolve(payload);
  };
  const fn = new Function(
    'window',
    'document',
    'localStorage',
    'api',
    'h',
    'toast',
    'avatarWithFrame',
    '$',
    'getSession',
    'global',
    sliceNotify()
  )(
    globalObj,
    doc,
    localStorage,
    api,
    h,
    (text) => plainToasts.push(text),
    (name) => h('div', 'avatar-frame avatar--sm', name),
    (id) => toastsById[id] || null,
    () => (o.session === false ? null : { user: { username: 'me' } }),
    globalObj
  );
  return {
    ...fn,
    toasts,
    store,
    navigations,
    plainToasts,
    setPayload: (p) => {
      payload = p;
    },
    get calls() {
      return calls;
    },
  };
}

// ---------------------------------------------------------------- transitions --

test('presence: the four states a notification cares about', () => {
  const app = harness();
  assert.equal(app.presenceKind({ status: 'WATCHING_PARTY' }), 'party');
  assert.equal(app.presenceKind({ status: 'WATCHING_SOLO' }), 'solo');
  assert.equal(app.presenceKind({ status: 'IDLE' }), 'idle');
  assert.equal(app.presenceKind({ status: 'OFFLINE' }), 'offline');
  assert.equal(app.presenceKind(null), 'offline', 'no payload = offline');
});

test('presence: coming online and starting to watch ARE events', () => {
  const app = harness();
  assert.equal(app.presenceTransition(OFFLINE, IDLE).kind, 'online', 'offline -> idle');
  assert.equal(app.presenceTransition(OFFLINE, watching('Dune', 1)).kind, 'watching', 'offline -> watching');
  assert.equal(app.presenceTransition(null, watching('Dune', 1, 'room-1')).kind, 'watching', 'never seen -> watching');
  assert.equal(app.presenceTransition(IDLE, watching('Dune', 1)).kind, 'watching', 'idle -> watching');
  assert.equal(app.presenceTransition(watching('Dune', 1), watching('Dune', 1, 'room-1')).kind, 'party', 'solo -> party, same title');
});

test('presence: a goodbye, a stop and a clock tick are NOT events', () => {
  const app = harness();
  assert.equal(app.presenceTransition(watching('Dune', 1), OFFLINE), null, 'went offline: no goodbye spam');
  assert.equal(app.presenceTransition(watching('Dune', 1), IDLE), null, 'stopped watching: not news');
  assert.equal(app.presenceTransition(watching('Dune', 1), watching('Dune', 1)), null, 'same title, same shape: just the clock');
  assert.equal(app.presenceTransition(watching('Dune', 1, 'room-1'), watching('Dune', 1, 'room-1')), null, 'same room');
  assert.equal(app.presenceTransition(OFFLINE, OFFLINE), null, 'still offline');
  assert.equal(app.presenceTransition(IDLE, IDLE), null, 'still idle');
});

test('presence: switching title is an event, and it is told apart by media id', () => {
  const app = harness();
  assert.equal(app.presenceTransition(watching('Dune', 1), watching('Inception', 2)).kind, 'switched');
  // Two different titles with the SAME id (a re-upload, a renamed row) still count
  // as one title; two identical titles with different ids are two titles.
  assert.equal(app.presenceTransition(watching('Dune', 1), watching('Dune (2012)', 1)), null, 'same id, same title');
  assert.equal(app.presenceTransition(watching('Dune', 1), watching('Dune', 2)).kind, 'switched', 'same words, different title');
});

// ------------------------------------------------------------------- sweeps ----

test('sweep: the first sweep is a BASELINE — walking into a full room is not 8 toasts', () => {
  const app = harness();
  const seen = new Map();
  const lastAt = new Map();
  const list = [friend('alice', IDLE), friend('bob', watching('Dune', 1, 'room-1'))];
  const events = app.presenceSweep(seen, list, lastAt, 1000, { announce: false, currentRoomId: '' });
  assert.deepEqual(events, [], 'nothing announced on the baseline sweep');
  assert.equal(seen.size, 2, 'but the snapshot is learned');
  // The very next sweep with no change is also silent...
  assert.deepEqual(app.presenceSweep(seen, list, lastAt, 2000, { announce: true }), [], 'no change, no noise');
  // ...and a real change after it IS announced.
  const after = [friend('alice', IDLE), friend('bob', watching('Inception', 2, 'room-1'))];
  const ev = app.presenceSweep(seen, after, lastAt, 3000, { announce: true });
  assert.equal(ev.length, 1, 'one friend changed');
  assert.equal(ev[0].friend.username, 'bob');
  assert.equal(ev[0].kind, 'switched');
});

test('sweep: one notification per friend per cooldown, and the snapshot still tracks', () => {
  const app = harness();
  const seen = new Map();
  const lastAt = new Map();
  const t0 = 1_000_000;
  app.presenceSweep(seen, [friend('alice', OFFLINE)], lastAt, t0, { announce: true }); // baseline-ish
  const on = app.presenceSweep(seen, [friend('alice', IDLE)], lastAt, t0 + 1000, { announce: true });
  assert.equal(on.length, 1, 'came online: announced');

  // Offline and back within the cooldown: the state IS tracked, but nothing is said.
  app.presenceSweep(seen, [friend('alice', OFFLINE)], lastAt, t0 + 2000, { announce: true });
  const again = app.presenceSweep(seen, [friend('alice', IDLE)], lastAt, t0 + 3000, { announce: true });
  assert.deepEqual(again, [], 'still inside the 10 minute cooldown');

  // Another friend is NOT held back by alice's cooldown.
  const bob = app.presenceSweep(
    seen,
    [friend('alice', IDLE), friend('bob', watching('Dune', 1))],
    lastAt,
    t0 + 4000,
    { announce: true }
  );
  assert.deepEqual(bob.map((e) => e.friend.username), ['bob'], 'the cooldown is per friend');

  // Offline again: silent, but the snapshot follows.
  const off = app.presenceSweep(
    seen,
    [friend('alice', OFFLINE), friend('bob', watching('Dune', 1))],
    lastAt,
    t0 + 5000,
    { announce: true }
  );
  assert.deepEqual(off, [], 'going offline is never announced');

  // Past the cooldown, alice speaks again.
  const late = app.presenceSweep(
    seen,
    [friend('alice', IDLE), friend('bob', watching('Dune', 1))],
    lastAt,
    t0 + 1000 + app.NOTIFY_COOLDOWN_MS,
    { announce: true }
  );
  assert.deepEqual(late.map((e) => e.friend.username), ['alice'], 'cooldown expired: they can be announced again');
  assert.equal(late[0].kind, 'online');
});

test('sweep: the room you are IN is never announced (they are on screen)', () => {
  const app = harness();
  const seen = new Map();
  const lastAt = new Map();
  const list = [friend('alice', watching('Dune', 1, 'room-1'), {})];
  const ev = app.presenceSweep(seen, list, lastAt, 1000, { announce: true, currentRoomId: 'room-1' });
  assert.deepEqual(ev, [], 'same room: silent');
  const other = app.presenceSweep(seen, list, lastAt, 2000, { announce: true, currentRoomId: 'room-2' });
  assert.deepEqual(other, [], 'and a second sweep cannot re-announce the same state');
  const seen2 = new Map();
  const ev2 = app.presenceSweep(seen2, list, new Map(), 3000, { announce: true, currentRoomId: 'room-2' });
  assert.equal(ev2.length, 1, 'from another room it IS announced');
  assert.equal(ev2[0].kind, 'watching');
});

// --------------------------------------------------------------- the watcher ---

test('watcher: it polls /api/friends, stays quiet on the first sweep, then notifies', async () => {
  const app = harness({ friends: [friend('alice', IDLE)] });
  const watch = app.startPresenceWatch();
  await watch.poll();
  assert.equal(app.calls, 1, 'one poll');
  assert.equal(app.toasts.children.length, 0, 'the first sweep only learns the room');

  app.setPayload({ friends: [friend('alice', watching('Inception', 2))] });
  await watch.poll();
  assert.equal(app.toasts.children.length, 1, 'the change is announced');
  const toastEl = app.toasts.children[0];
  assert.equal(toastEl.className, 'toast toast--presence');
  assert.equal(toastEl.querySelector('.toast__name').textContent, 'Alice');
  assert.equal(toastEl.querySelector('.toast__text').textContent, 'is now watching Inception');
  watch.stop();
});

test('watcher: no session, no polling (nothing to watch, nothing to leak)', async () => {
  const app = harness({ session: false });
  const watch = app.startPresenceWatch();
  await watch.poll();
  assert.equal(app.calls, 0, 'an anonymous visitor does not poll /api/friends');
  watch.stop();
});

test('watcher: a hidden tab says nothing, and coming back re-baselines', async () => {
  const app = harness({ friends: [friend('alice', IDLE)] });
  const watch = app.startPresenceWatch();
  await watch.poll(); // baseline
  app.toasts.children.length = 0;

  // Everything changes while the tab is in the background...
  app.setPayload({ friends: [friend('alice', watching('Inception', 2))] });
  app.startPresenceWatch; // (no-op: the handle is already live)
  await watch.poll(); // still visible in the stub -> announced
  assert.equal(app.toasts.children.length, 1, 'visible tab: announced');

  // ...and a HIDDEN poll is refused outright.
  const hidden = harness({ friends: [friend('carol', IDLE)], visibility: 'hidden' });
  const watch2 = hidden.startPresenceWatch();
  await watch2.poll();
  assert.equal(hidden.calls, 0, 'a hidden tab does not even fetch');
  assert.equal(hidden.toasts.children.length, 0, 'and never notifies into the void');
  watch2.stop();

  // The re-baseline path itself: after a fresh start the first sweep is silent,
  // which is what the visibility handler relies on when the tab comes back.
  const back = harness({ friends: [friend('carol', watching('Dune', 1))] });
  const watch3 = back.startPresenceWatch();
  await watch3.poll();
  assert.equal(back.toasts.children.length, 0, 'returning to the tab does not replay the backlog');
  watch3.stop();
  watch.stop();
});

test('watcher: the handle is a singleton and stop() releases it', () => {
  const app = harness();
  const a = app.startPresenceWatch();
  const b = app.startPresenceWatch();
  assert.equal(a, b, 'starting twice returns the same watcher');
  a.stop();
  const c = app.startPresenceWatch();
  assert.notEqual(c, a, 'after stop() a new watcher can be started');
  c.stop();
});

// ------------------------------------------------------------ the toast --------

test('toast: avatar, name, line — and a Join that opens the ROOM', async () => {
  const app = harness();
  const p = watching('Inception', 2, 'room-9', true);
  const node = app.showPresenceToast(friend('alice', p), 'party', p, 40);
  assert.equal(node.className, 'toast toast--presence');
  assert.ok(node.querySelector('.avatar-frame'), 'framed avatar (the app-wide avatar component)');
  assert.equal(node.querySelector('.toast__name').textContent, 'Alice');
  assert.equal(node.querySelector('.toast__text').textContent, 'started a watch party · Inception');

  const join = node.querySelector('.toast__join');
  assert.ok(join, 'a room gets a Join button');
  assert.equal(join.textContent, 'Join');
  assert.equal(join.getAttribute('aria-label'), 'Join Alice watching Inception', 'labelled for screen readers');

  join.fire('click');
  assert.deepEqual(app.navigations, ['/room/room-9'], 'Join opens the party');
  // Clicking the card itself opens the profile instead.
  node.fire('click');
  assert.deepEqual(app.navigations, ['/room/room-9', '/user/alice'], 'the card opens the profile');

  await sleep(80);
  assert.equal(node.className, 'toast toast--presence is-leaving', 'it dismisses itself');
});

test('toast: no room, no Join — and the ink/lines are the documented ones', () => {
  const app = harness();
  const p = watching('Dune', 1);
  const node = app.showPresenceToast(friend('bob', p), 'watching', p, 5000);
  assert.equal(node.querySelector('.toast__join'), null, 'solo watching has nothing to join');
  assert.equal(node.querySelector('.toast__text').textContent, 'is now watching Dune');

  const online = app.showPresenceToast(friend('bob', IDLE), 'online', IDLE, 5000);
  assert.equal(online.querySelector('.toast__text').textContent, 'is online');
  const solo = app.showPresenceToast(friend('bob', p), 'switched', watching('Arrival', 3), 5000);
  assert.equal(solo.querySelector('.toast__text').textContent, 'switched to Arrival');
  const inParty = app.showPresenceToast(friend('bob', p), 'watching', watching('Dune', 1, 'room-3'), 5000);
  assert.equal(inParty.querySelector('.toast__text').textContent, 'is watching Dune in a party', 'a party is called a party');
});

test('toast: pointing at it keeps it on screen (a notification is read, not raced)', async () => {
  const app = harness();
  const node = app.showPresenceToast(friend('alice', IDLE), 'online', IDLE, 40);
  node.fire('mouseenter');
  await sleep(80);
  assert.equal(node.className, 'toast toast--presence', 'the timer waits while the pointer is on it');
  node.fire('mouseleave');
  await sleep(80);
  assert.ok(node.className.includes('is-leaving'), 'and resumes when the pointer leaves');
});

test('toast: the stack is capped (a fourth would hide under the mobile bar)', () => {
  const app = harness();
  for (let i = 0; i < app.NOTIFY_MAX_ON_SCREEN + 1; i++) {
    app.showPresenceToast(friend('f' + i, IDLE), 'online', IDLE, 5000);
  }
  assert.equal(app.toasts.children.length, app.NOTIFY_MAX_ON_SCREEN, 'the oldest leaves first');
  assert.equal(app.toasts.children[0].querySelector('.toast__name').textContent, 'F1', 'the newest are kept');
});

// ---------------------------------------------------------------- the batch ----

test('batch: at most two named notifications, the rest collapse into one summary', () => {
  const app = harness();
  const events = ['a', 'b', 'c', 'd'].map((u) => ({
    friend: friend(u, IDLE),
    kind: 'online',
    presence: IDLE,
  }));
  app.renderPresenceEvents(events);
  assert.equal(app.toasts.children.length, app.NOTIFY_MAX_NAMED, 'two named toasts');
  assert.deepEqual(app.plainToasts, ['+2 more friends are active'], 'one summary line for the rest');
  app.renderPresenceEvents([]);
  assert.equal(app.plainToasts.length, 1, 'an empty sweep adds nothing');
});

// ------------------------------------------------------------- the mute -------

test('mute: the pref is device-local, defaults to ON, and silences the sweep', async () => {
  const app = harness({ friends: [friend('alice', IDLE)] });
  assert.equal(app.notifyPrefOn(), true, 'default ON');
  app.setNotifyPref(false);
  assert.equal(app.store['wp:notify-presence'], '0', 'persisted');
  assert.equal(app.notifyPrefOn(), false);
  assert.equal(app.toggleNotifyPref(), true, 'toggle flips it');

  const muted = harness({ friends: [friend('alice', IDLE)], pref: '0' });
  const watch = muted.startPresenceWatch();
  await watch.poll(); // baseline
  muted.setPayload({ friends: [friend('alice', watching('Dune', 1))] });
  await watch.poll();
  assert.equal(muted.toasts.children.length, 0, 'muted: nothing is shown');
  watch.stop();
});

test('mute: the friends panel carries the bell, and it says which state it is in', () => {
  const src = read('dist/js/social.js');
  // NOTE: the friends panel (section 8) comes AFTER the profile page (section 6)
  // in the file, so the slice runs to the NEXT section, not to mountProfile.
  const rail = src.slice(src.indexOf('function createFriendsRail'), src.indexOf('// 9. Presence notifications'));
  assert.match(rail, /const bellBtn = .*friends-rail__icon-btn/, 'the bell is in the panel header');
  assert.match(rail, /global\.WP\.setIcon\(bellBtn, on \? 'bell' : 'bell-off', 16\)/, 'the icon shows the state');
  assert.match(rail, /bellBtn\.setAttribute\('aria-pressed', on \? 'true' : 'false'\)/, 'and so does aria-pressed');
  assert.match(rail, /toggleNotifyPref\(\)/, 'clicking it is the mute toggle');
  assert.match(rail, /removeEventListener\('wp:notify-pref', paintBell\)/, 'the listener is released with the panel');
  // The two glyphs must exist in the icon table (an unknown name renders an
  // empty svg — a silent, invisible button).
  const utils = read('dist/js/utils.js');
  assert.match(utils, /^\s{4}bell: \{/m, 'bell exists');
  assert.match(utils, /^\s{4}'bell-off': \{/m, "bell-off exists");
});

test('wiring: the watcher starts at boot, not when the panel happens to be open', () => {
  const app = read('dist/js/app.js');
  assert.match(app, /WP\.Social\.startPresenceWatch\(\)/, 'app.js starts the watcher');
  const social = read('dist/js/social.js');
  assert.match(social, /startPresenceWatch,\n/, 'and social.js exports it');
  assert.match(social, /showPresenceToast,\n/, 'the toast itself is exported (the icon review page drives it)');
  assert.match(social, /const NOTIFY_POLL_MS = 30_000/, 'on the friends panel\'s own beat');
  assert.match(social, /global\.addEventListener\('wp:friends-changed', onChange\)/, 'a friend change polls immediately');
});

test('css: the toast is clickable, wraps, and reuses the app ink (no literals)', () => {
  const css = read('dist/css/social.css');
  const block = css.slice(css.indexOf('.toast--presence {'), css.indexOf('.toast--presence .avatar-frame {'));
  assert.match(block, /display: flex;/, 'avatar + two text lines + Join in one row');
  assert.match(block, /white-space: normal;/, 'the base toast is a single ellipsised line');
  assert.match(block, /pointer-events: auto;/, 'the toast container is a pass-through by default');
  assert.match(block, /cursor: pointer;/);
  assert.match(css, /\.toast__name \{[^}]*color: var\(--text\);/, 'themed ink');
  assert.match(css, /\.toast__text \{[^}]*color: var\(--text-dim\);/, 'and the quiet line is quieter');
  // No hardcoded colours crept in (the color audit pins the allowlist). The
  // block ends at the NEXT section marker - later sections legitimately carry
  // on-media inks.
  const from = css.indexOf('/* ---- Presence notifications');
  const presenceCss = css.slice(from, css.indexOf('/* ----', from + 10));
  assert.equal(/#[0-9a-fA-F]{3,6}\b/.test(presenceCss), false, 'no colour literals in the presence block');
});
