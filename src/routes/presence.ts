// routes/presence.ts — REST presence surface (the room socket path is the
// primary writer; these endpoints cover the home surface and page unload).
//
//   PUT    /api/presence  { status, ... }  upsert heartbeat (auth)
//   DELETE /api/presence                   clear now (auth) — pagehide beacon
//
// Auth note: `navigator.sendBeacon` cannot set headers, so both mutations
// also accept the session token inside the JSON body.

import type { Env, AuthedUser } from '../types.js';
import { json, errorJson, readJson, publicPresence } from '../http.js';
import { setPresence, clearPresence, getPresence } from '../presence.js';
import { sessionUser, verifyToken } from '../auth.js';

/** Session from the Authorization header or a body `token` (beacon path). */
async function authAny(
  request: Request,
  env: Env,
  body: Record<string, unknown> | null
): Promise<AuthedUser | null> {
  const fromHeader = await sessionUser(request, env);
  if (fromHeader) return fromHeader;
  const token = body && typeof body.token === 'string' ? body.token : '';
  if (!token) return null;
  const claims = await verifyToken(env, token);
  return claims ? { id: claims.sub, username: claims.username } : null;
}

export async function handlePresencePut(request: Request, env: Env): Promise<Response> {
  // NEVER let an exception escape: the worker has no outer catch for this
  // route, so a raw throw surfaced as Cloudflare's PLAINTEXT 500 (the client
  // then reported 'Request failed (500)' with zero diagnostics). Name the
  // failure instead — one deploy, and the console says the exact cause.
  try {
    const body = await readJson(request);
    const me = await authAny(request, env, body);
    if (!me) return errorJson(401, 'Sign in to update presence.');

    // Validate BEFORE any KV write — otherwise a rejected WATCHING_* status
    // would already have been persisted (presence poisoning).
    const requested = body && typeof body.status === 'string' ? body.status : 'IDLE';
    if (requested === 'WATCHING_PARTY' || requested === 'WATCHING_SOLO') {
      return errorJson(422, 'Room statuses are managed by the room socket.');
    }

    const payload = await setPresence(env, me.id, {
      status: 'IDLE',
      is_host: false,
      room_id: '',
      media_title: '',
      media_id: '',
      current_timestamp: '',
      ...(body ?? {}),
    });
    return json({ presence: publicPresence(payload) }, 200);
  } catch (e) {
    return json(
      { error: 'presence beat failed', detail: String((e instanceof Error ? e.stack || e.message : String(e)) || e) },
      500
    );
  }
}

/**
 * GET /api/presence/self — auth'd storage health check: verifies the token,
 * then performs a REAL put/get/delete roundtrip on the caller's own key and
 * reports every step. (A truthy binding can still be a broken namespace —
 * this tells them apart.)
 */
export async function handlePresenceSelf(request: Request, env: Env): Promise<Response> {
  const me = await sessionUser(request, env);
  if (!me) return errorJson(401, 'Sign in for the presence self-check.');
  const steps: Record<string, string> = { auth: 'ok' };
  const key = 'presence:selftest:' + me.id;
  try {
    await env.PRESENCE_KV.put(key, String(Date.now()), { expirationTtl: 120 });
    steps.kvPut = 'ok';
  } catch (e) {
    steps.kvPut = 'FAILED: ' + String((e instanceof Error ? e.message : String(e)) || e);
  }
  try {
    const v = await env.PRESENCE_KV.get(key);
    steps.kvGet = v ? 'ok' : 'FAILED: nil read';
  } catch (e) {
    steps.kvGet = 'FAILED: ' + String((e instanceof Error ? e.message : String(e)) || e);
  }
  try {
    await env.PRESENCE_KV.delete(key);
    steps.kvDelete = 'ok';
  } catch (e) {
    steps.kvDelete = 'FAILED: ' + String((e instanceof Error ? e.message : String(e)) || e);
  }
  const ok = steps.kvPut === 'ok' && steps.kvGet === 'ok';
  return json({ ok, steps }, 200, { 'Cache-Control': 'no-store' });
}

export async function handlePresenceDelete(request: Request, env: Env): Promise<Response> {
  try {
    // The pagehide beacon sends no body; reading it is safe either way.
    const body = await readJson(request);
    const me = await authAny(request, env, body);
    if (!me) return errorJson(401, 'Sign in to update presence.');
    await clearPresence(env, me.id);
    return json({ ok: true }, 200);
  } catch (e) {
    return json(
      { error: 'presence clear failed', detail: String((e instanceof Error ? e.stack || e.message : String(e)) || e) },
      500
    );
  }
}

export async function handlePresenceGet(request: Request, env: Env, userId: string): Promise<Response> {
  const presence = await getPresence(env, userId);
  return json({ presence: publicPresence(presence) }, 200, { 'Cache-Control': 'no-store' });
}
