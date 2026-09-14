// Stability audit pins: async replies must be validated against current UI
// state, and no unhandled-rejection landmines on daily-use paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT } from './dompath.mjs';

test('stability: late async replies never paint stale UI state', async () => {
  const app = readFileSync(join(ROOT, 'dist/js/app.js'), 'utf8');
  const cat = readFileSync(join(ROOT, 'dist/js/catalog.js'), 'utf8');

  // Player like: hydrate + toggle success/failure all compare the video the
  // reply is FOR against the video that is CURRENT before painting.
  assert.equal(
    (app.match(/String\(state\.video\.id\) === vid0?/g) || []).length,
    4,
    'all four like paths validate the reply against the current video'
  );

  // Catalog card hearts: detached cards (feed swapped mid-flight) skip paint.
  assert.match(cat, /if \(likeBtn\.isConnected\) syncHeart\(/, 'card heart ignores detached nodes');

  // Hover trailer preview: fetch failure must not raise an unhandled rejection.
  assert.match(cat, /fetchTrailerKey\(item\)\.then\([\s\S]*?\)\n\s*\.catch\(\(\) => \{\}\);/, 'trailer preview fetch has a catch');
});

test('stability: worker API routes fail as JSON 500, never a raw error page', async () => {
  const worker = readFileSync(join(ROOT, 'src/worker.ts'), 'utf8');
  const call = worker.indexOf("routed = await routeApi(request, env, path);");
  assert.ok(call > -1, 'routeApi call site exists');
  const before = worker.lastIndexOf('try {', call);
  assert.ok(before > -1 && call - before < 200, 'routeApi call is wrapped in try');
  assert.match(worker, /json\(\{ error: 'Internal error', detail: String\(e\) \}, 500\)/, 'thrown handlers return parseable JSON 500');
});

test('stability: no unguarded JSON.parse on localStorage/boot paths', async () => {
  // Every JSON.parse in client JS sits inside a try block (corrupt storage
  // must degrade to defaults, never break boot).
  for (const f of ['api.js', 'catalog.js', 'social.js', 'utils.js']) {
    const src = readFileSync(join(ROOT, 'dist/js', f), 'utf8');
    for (const m of src.matchAll(/JSON\.parse/g)) {
      const pre = src.slice(Math.max(0, m.index - 400), m.index);
      assert.match(pre, /try\s*\{[^}]*$/, `${f}: JSON.parse at ${m.index} is inside a try block`);
    }
  }
});
