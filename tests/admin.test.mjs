import { register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
register(new URL('./tsresolve.mjs', import.meta.url));

const ROOT = join(import.meta.dirname, '..');

// ---- minimal fake D1 (admin route SQL surface) ----
function fakeDB({ users, rooms }) {
  return {
    prepare(sql) {
      return {
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/SELECT is_admin FROM users/.test(sql)) {
            const row = users.find((u) => u.id === this._args?.[0]);
            return row ? { is_admin: row.is_admin } : null;
          }
          if (/FROM users WHERE id/.test(sql)) {
            const row = users.find((u) => u.id === this._args?.[0]);
            return row || null;
          }
          if (/COUNT\(\*\) AS n FROM users/.test(sql)) {
            const since = this._args?.[0];
            return { n: since ? users.filter((u) => u.created_at > since).length : users.length };
          }
          if (/COUNT\(\*\) AS n FROM rooms_created/.test(sql)) {
            const since = this._args?.[0];
            return { n: since ? rooms.filter((r) => r.created_at > since).length : rooms.length };
          }
          return null;
        },
        async all() {
          if (/FROM users ORDER BY created_at DESC/.test(sql)) {
            return { results: [...users].sort((a, b) => b.created_at - a.created_at).slice(0, 50) };
          }
          if (/FROM rooms_created ORDER BY created_at DESC/.test(sql)) {
            return { results: [...rooms].sort((a, b) => b.created_at - a.created_at).slice(0, 50) };
          }
          return { results: [] };
        },
        async run() {},
      };
    },
  };
}

function fakeKV(presences) {
  return {
    async list({ prefix }) {
      return { keys: Object.keys(presences).map((name) => ({ name })), list_complete: true };
    },
    async get(name) {
      return presences[name] ?? null;
    },
  };
}

const NOW = Date.now();
const USERS = [
  { id: 'u-admin', username: 'jeff', display_name: 'Jeff', avatar_url: '', created_at: NOW - 10 * 86400e3, last_seen_at: NOW, is_admin: 1 },
  { id: 'u-2', username: 'ramadhan', display_name: 'Ramadhan', avatar_url: '', created_at: NOW - 3 * 3600e3, last_seen_at: NOW - 60e3, is_admin: 0 },
  { id: 'u-3', username: 'silver', display_name: 'Silver Ember', avatar_url: '', created_at: NOW - 5 * 86400e3, last_seen_at: 0, is_admin: 0 },
];
const ROOMS = [
  { room_id: 'room-aaa', owner_id: 'u-admin', owner_username: 'jeff', created_at: NOW - 3600e3 },
  { room_id: 'room-bbb', owner_id: 'u-2', owner_username: 'ramadhan', created_at: NOW - 2 * 86400e3 },
];
const PRESENCES = {
  'presence:user:u-admin': JSON.stringify({ status: 'WATCHING_PARTY', room_id: 'room-aaa' }),
  'presence:user:u-2': JSON.stringify({ status: 'WATCHING_PARTY', room_id: 'room-aaa' }),
  'presence:user:u-3': JSON.stringify({ status: 'WATCHING_SOLO', room_id: 'room-bbb' }),
};

const { handleAdminOverview } = await import(pathToFileURL(join(ROOT, 'src/routes/admin.ts')).href + '?v=' + Date.now());
const { issueToken } = await import(pathToFileURL(join(ROOT, 'src/auth.ts')).href + '?v=' + Date.now());
const env = { DB: fakeDB({ users: USERS, rooms: ROOMS }), PRESENCE_KV: fakeKV(PRESENCES) };
const req = (token) => new Request('https://x/api/admin/overview', { headers: token ? { Authorization: 'Bearer ' + token } : {} });

test('admin overview: anon gets 401', async () => {
  const res = await handleAdminOverview(req(null), env);
  assert.equal(res.status, 401);
});

test('admin overview: non-admin gets 403', async () => {
  const token = await issueToken({}, { id: 'u-2', username: 'ramadhan' });
  const res = await handleAdminOverview(req(token), env);
  assert.equal(res.status, 403);
});

test('admin overview: admin gets users+rooms+live', async () => {
  const token = await issueToken({}, { id: 'u-admin', username: 'jeff' });
  const res = await handleAdminOverview(req(token), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.users.total, 3);
  assert.equal(data.users.today, 1); // only ramadhan (<24h)
  assert.equal(data.users.week, 2);
  assert.equal(data.rooms.total, 2);
  assert.equal(data.rooms.today, 1);
  assert.equal(data.live.rooms, 2);
  assert.equal(data.live.viewers, 3);
  assert.equal(data.live.byRoom['room-aaa'], 2);
  assert.equal(data.users.recent[0].username, 'ramadhan'); // newest signup
  assert.equal(data.rooms.recent[0].room_id, 'room-aaa');
});

test('schema: is_admin column, rooms_created registry, jeff seed all present', () => {
  const schema = readFileSync(join(ROOT, 'src/schema.ts'), 'utf8');
  assert.match(schema, /is_admin INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rooms_created/);
  assert.match(schema, /UPDATE users SET is_admin = 1 WHERE username = 'jeff' AND is_admin = 0/);
});

test('room mint registers the room (INSERT OR IGNORE in /api/rooms handler)', () => {
  const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  const handler = worker.slice(worker.indexOf("path === '/api/rooms'"), worker.indexOf('const roomMatch'));
  assert.match(handler, /INSERT OR IGNORE INTO rooms_created/);
  assert.match(handler, /sessionUser/, 'registry records the creator');
});

test('admin UI: nav item (hidden), drawer, export and wiring exist', () => {
  const html = readFileSync(join(ROOT, 'dist/index.html'), 'utf8');
  assert.match(html, /data-nav="admin"[^>]*hidden/, 'sidenav item exists and is hidden by default');
  const app = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  assert.match(app, /WP\.Social\.toggleAdminPanel/);
  const social = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(social, /function toggleAdminPanel/);
  assert.match(social, /toggleAdminPanel,/, 'exported from WP.Social');
  assert.match(social, /applyAdminNav\(meData\.user\)/, 'nav reveal hooks into /api/auth/me');
  const me = readFileSync(join(ROOT, 'src/routes/auth.ts'), 'utf8');
  assert.match(me, /is_admin: !!row\.is_admin/, 'handleMe exposes is_admin');
  assert.doesNotMatch(me, /USER_COLS, is_admin FROM[\s\S]*search/i, 'is_admin not leaked into search projections');
});

test('admin route is routed + health advertises it', () => {
  const router = readFileSync(join(ROOT, 'src/router.ts'), 'utf8');
  assert.match(router, /path === '\/api\/admin\/overview'/);
  assert.match(router, /'admin'/);
});
