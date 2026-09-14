// Likes + For You suggestions: DB behavior, ranking logic, UI wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { ROOT } from './dompath.mjs';

register(new URL('./tsresolve.mjs', import.meta.url));

/** Minimal fake D1 with the tables likes.ts touches. */
function fakeDB(initialLikes) {
  const likes = new Map(); // "uid:mid" -> row
  for (const l of initialLikes) likes.set(l.user_id + ':' + l.media_id, l);
  const history = new Set(['movie:999']); // user watched movie 999
  return {
    _likes: likes,
    _history: history,
    prepare(sql) {
      const api = {
        bind(...args) {
          api._args = args;
          return api;
        },
        async first() {
          if (/SELECT user_id FROM user_likes WHERE user_id = \?1 AND media_id = \?2/.test(sql)) {
            const [uid, mid] = api._args;
            return likes.has(uid + ':' + mid) ? { user_id: uid } : null;
          }
          if (/COUNT\(\*\) AS n FROM user_likes WHERE user_id = \?1$/.test(sql)) {
            const [uid] = api._args;
            let n = 0;
            for (const k of likes.keys()) if (k.startsWith(uid + ':')) n++;
            return { n };
          }
          return null;
        },
        async run() {
          if (/INSERT OR IGNORE INTO user_likes/.test(sql)) {
            const [uid, mid, type, title, poster, ts] = api._args;
            likes.set(uid + ':' + mid, { user_id: uid, media_id: mid, media_type: type, media_title: title, poster_url: poster, created_at: ts });
          } else if (/DELETE FROM user_likes WHERE user_id = \?1 AND media_id = \?2/.test(sql)) {
            const [uid, mid] = api._args;
            likes.delete(uid + ':' + mid);
          }
          return {};
        },
        async all() {
          if (/SELECT media_id FROM user_likes WHERE user_id = \?1/.test(sql)) {
            const [uid] = api._args;
            const ids = [];
            for (const [k, v] of likes) if (k.startsWith(uid + ':')) ids.push({ media_id: v.media_id });
            return { results: ids };
          }
          if (/SELECT media_id, media_type FROM user_likes/.test(sql)) {
            const [uid] = api._args;
            const rows = [];
            for (const [k, v] of likes) if (k.startsWith(uid + ':')) rows.push({ media_id: v.media_id, media_type: v.media_type });
            return { results: rows };
          }
          if (/FROM watch_history WHERE user_id/.test(sql)) {
            const [uid] = api._args;
            const rows = [];
            for (const key of history) {
              const [t, id] = key.split(':');
              rows.push({ media_id: id, media_type: t });
            }
            return { results: rows };
          }
          if (/FROM user_likes WHERE user_id = \?1 ORDER BY created_at DESC/.test(sql)) {
            const [uid] = api._args;
            const rows = [];
            for (const [k, v] of likes) if (k.startsWith(uid + ':')) rows.push(v);
            rows.sort((a, b) => b.created_at - a.created_at);
            return { results: rows };
          }
          return { results: [] };
        },
      };
      return api;
    },
  };
}

const me = { id: 'u1', username: 'jeff' };
const env = (likes, kv) => ({ DB: fakeDB(likes), PRESENCE_KV: kv || null, TMDB_API_KEY: '' });
const req = (body) => new Request('https://x/toggle', { method: 'POST', body: JSON.stringify(body) });

const { handleToggleLike, handleLikeIds, rankSuggestions } = await import(
  pathToFileURL(join(ROOT, 'src/routes/likes.ts')).href + '?v=' + Date.now()
);

test('likes: toggle inserts then deletes; count follows', async () => {
  const e = env([]);
  const on = await (await handleToggleLike(req({ mediaId: '123', mediaType: 'movie', mediaTitle: 'The Martian', posterUrl: 'p.jpg' }), e, me)).json();
  assert.equal(on.liked, true);
  assert.equal(on.likesCount, 1);
  const off = await (await handleToggleLike(req({ mediaId: '123', mediaType: 'movie', mediaTitle: 'The Martian' }), e, me)).json();
  assert.equal(off.liked, false);
  assert.equal(off.likesCount, 0);
});

test('likes: ids endpoint reflects the set; invalid mediaId rejected', async () => {
  const e = env([{ user_id: 'u1', media_id: '42', media_type: 'movie', media_title: 'T', poster_url: '', created_at: 1 }]);
  const ids = await (await handleLikeIds(new Request('https://x/ids'), e, me)).json();
  assert.deepEqual(ids.ids, ['42']);
  const bad = await handleToggleLike(req({ mediaId: '../etc' }), e, me);
  assert.equal(bad.status, 422);
});

test('rankSuggestions: merges, dedupes, excludes, ranks by seed overlap', () => {
  const exclude = new Set(['movie:1', 'tv:5', 'movie:999']);
  const recA = [
    { id: 1, type: 'movie', title: 'seed itself', poster: '' }, // excluded (seed)
    { id: 2, type: 'movie', title: 'Both like this', poster: 'a.jpg' },
    { id: 3, type: 'movie', title: 'Only A', poster: '' },
    { id: 999, type: 'movie', title: 'already watched', poster: '' }, // excluded
  ];
  const recB = [
    { id: 5, type: 'tv', title: 'seed tv', poster: '' }, // excluded
    { id: 2, type: 'movie', title: 'Both like this', poster: 'a.jpg' }, // dup -> score 2
    { id: 4, type: 'tv', title: 'Only B', poster: '' },
  ];
  const out = rankSuggestions([recA, recB], exclude, 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].mediaId, '2');
  assert.equal(out[0].score, 2, 'recommended by BOTH seeds ranks first');
  assert.ok(out.slice(1).every((x) => x.score === 1));
  assert.ok(!out.some((x) => x.mediaId === '1' || x.mediaId === '999' || x.mediaId === '5'), 'seeds + watched excluded');
});

test('likes wiring: routes, health, card hearts, For You row, profile Liked section', () => {
  const router = readFileSync(join(ROOT, 'src/router.ts'), 'utf8');
  assert.match(router, /\/api\/user\/likes\/toggle/);
  assert.match(router, /\/api\/suggestions/);
  assert.match(router, /'likes'/);
  const schema = readFileSync(join(ROOT, 'src/schema.ts'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS user_likes/);
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');
  assert.match(cat, /card-item__like/, 'heart on cards');
  assert.match(cat, /getSuggestions/, 'For You row fetch');
  assert.match(cat, /For you/, 'row title');
  const soc = readFileSync(join(ROOT, 'dist/js/social.js'), 'utf8');
  assert.match(soc, /liked-section/, 'profile Liked section');
  assert.match(soc, /toggleLike/);
  const users = readFileSync(join(ROOT, 'src/routes/users.ts'), 'utf8');
  assert.match(users, /FROM user_likes WHERE user_id = \?1 ORDER BY created_at DESC LIMIT 24/);
});
