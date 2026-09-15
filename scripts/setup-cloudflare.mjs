#!/usr/bin/env node
/**
 * setup-cloudflare.mjs — one-command remote setup for the profile/presence
 * stack (D1 + KV). Fixes the classic deploy error:
 *
 *   KV namespace 'PRESENCE_KV_PLACEHOLDER' is not valid. [code: 10042]
 *
 * What it does:
 *   1. Checks you are logged in (`npx wrangler login` first).
 *   2. Finds or creates the D1 database `watchparty-db`.
 *   3. Finds or creates the KV namespace `<worker-name>-PRESENCE_KV`.
 *   4. Rewrites the placeholder ids in wrangler.toml with the real ones.
 *
 * Usage:  npm run setup:remote
 * (Idempotent — safe to run again; existing resources are reused.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOML_PATH = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const DB_NAME = 'watchparty-db';
const KV_BINDING = 'PRESENCE_KV';

/** Run a wrangler command, returning { code, stdout, stderr }. */
function wrangle(args, { allowFail = false } = {}) {
  const res = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.status !== 0 && !allowFail) {
    const err = ((res.stderr || '') + '\n' + (res.stdout || '')).trim();
    throw new Error(`wrangler ${args.join(' ')} failed:\n${err.slice(0, 800)}`);
  }
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** Run a wrangler command and parse the JSON embedded in its output. */
function wrangleJson(args) {
  const { stdout, stderr } = wrangle(args);
  const text = stdout + '\n' + stderr;
  const starts = [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) {
    throw new Error(`No JSON in output of "wrangler ${args.join(' ')}":\n${text.slice(0, 400)}`);
  }
  return JSON.parse(text.slice(Math.min(...starts)));
}

/** Worker name from wrangler.toml (KV namespace titles are `<name>-<binding>`). */
export function workerName(toml) {
  const m = String(toml).match(/^name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : 'watchparty-app';
}

/** Replace both placeholder ids in wrangler.toml. Returns the new text. */
export function writeResourceIds(toml, dbId, kvId) {
  let out = String(toml);
  // The trailing "# placeholder" comments are dropped once the real ids land.
  const dbRe = /database_id\s*=\s*"[^"]*"([ \t]*#[^\n]*)?/;
  if (dbRe.test(out)) {
    out = out.replace(dbRe, `database_id = "${dbId}"`);
  } else {
    throw new Error('Could not find database_id in wrangler.toml');
  }
  const kvRe = new RegExp(
    `(binding\\s*=\\s*"${KV_BINDING}"[\\s\\S]{0,200}?id\\s*=\\s*)"[^"]*"([ \\t]*#[^\\n]*)?`
  );
  if (kvRe.test(out)) {
    out = out.replace(kvRe, `$1"${kvId}"`);
  } else {
    throw new Error(`Could not find the ${KV_BINDING} id line in wrangler.toml`);
  }
  return out;
}

function findD1() {
  try {
    const list = wrangleJson(['d1', 'list', '--json']);
    const rows = Array.isArray(list) ? list : [];
    const row = rows.find((d) => d && d.name === DB_NAME);
    return row ? row.uuid || row.id || null : null;
  } catch (_) {
    return null;
  }
}

function findKV(title) {
  try {
    const list = wrangleJson(['kv', 'namespace', 'list', '--json']);
    const rows = Array.isArray(list) ? list : [];
    const row = rows.find((n) => n && n.title === title);
    return row ? row.id || null : null;
  } catch (_) {
    return null;
  }
}

export async function main() {
  // 0. Auth gate — plain `whoami` is the most shape-stable check.
  const who = wrangle(['whoami'], { allowFail: true });
  if (/not authenticated/i.test(who.stdout + who.stderr)) {
    console.error(
      '✗ Not logged in to Cloudflare.\n\n  Run:  npx wrangler login\n  …then re-run: npm run setup:remote'
    );
    process.exit(1);
  }

  const toml = readFileSync(TOML_PATH, 'utf8');
  const kvTitle = `${workerName(toml)}-${KV_BINDING}`;

  // 1. D1 database
  console.log(`• Looking for D1 database "${DB_NAME}"…`);
  let dbId = findD1();
  if (!dbId) {
    console.log(`  not found — creating…`);
    wrangle(['d1', 'create', DB_NAME], { allowFail: true });
    dbId = findD1();
  }
  if (!dbId) {
    console.error(`✗ Could not create or find D1 database "${DB_NAME}". Create it manually:\n  npx wrangler d1 create ${DB_NAME}`);
    process.exit(1);
  }
  console.log(`✔ D1 database: ${DB_NAME} (${dbId})`);

  // 2. KV namespace
  console.log(`• Looking for KV namespace "${kvTitle}"…`);
  let kvId = findKV(kvTitle);
  if (!kvId) {
    console.log(`  not found — creating…`);
    const created = wrangle(['kv', 'namespace', 'create', KV_BINDING], { allowFail: true });
    if (/already exists/i.test(created.stderr + created.stdout)) {
      console.log('  wrangler reports it already exists — matching by title…');
    }
    kvId = findKV(kvTitle);
  }
  if (!kvId) {
    console.error(`✗ Could not create or find KV namespace "${kvTitle}". Create it manually:\n  npx wrangler kv namespace create ${KV_BINDING}`);
    process.exit(1);
  }
  console.log(`✔ KV namespace: ${kvTitle} (${kvId})`);

  // 3. Rewrite wrangler.toml
  const updated = writeResourceIds(toml, dbId, kvId);
  if (updated !== toml) {
    writeFileSync(TOML_PATH, updated);
    console.log('✔ wrangler.toml updated with the real resource ids.');
  } else {
    console.log('• wrangler.toml already up to date.');
  }

  // 4. Next steps
  console.log(
    [
      '',
      'Done. Remaining one-time setup:',
      '  1) npm run db:migrate:remote            # create the profile tables',
      '  2) npx wrangler secret put SESSION_SECRET   # any long random string',
      '  3) npm run deploy',
    ].join('\n')
  );
}

// Only execute when run directly (so helpers stay importable for tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
}
