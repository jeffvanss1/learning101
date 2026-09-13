// router.ts — dispatch for the profile/search/presence API surface.
//
// The worker entry (src/worker.ts) delegates every /api request here first;
// room + TMDB + AniList routes stay in the entry for continuity with the
// existing app.

import type { Env, AuthedUser } from './types.js';
import { errorJson, json } from './http.js';
import { sessionUser } from './auth.js';
import { ensureSchema } from './schema.js';
import { handleSessionCreate, handleMe, handleClaim, handleRotateCode } from './routes/auth.js';
import { handleUserSearch } from './routes/search.js';
import { handleAdminOverview } from './routes/admin.js';
import {
  handleGetProfile,
  handleUpdateProfile,
  handleRecordHistory,
  handleListFriends,
  handleFriendRequest,
  handleFriendAccept,
  handleFriendRemove,
} from './routes/users.js';
import {
  handlePresencePut,
  handlePresenceDelete,
  handlePresenceGet,
  handlePresenceSelf,
} from './routes/presence.js';

const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function requireUser(request: Request, env: Env): Promise<AuthedUser | Response> {
  const me = await sessionUser(request, env);
  if (!me) return errorJson(401, 'Sign in to do that.');
  return me;
}

/** Worker build marker — bump alongside the UI stamp (social.js WP.build). */
export const WORKER_BUILD = 'api-2026-09-13.40';

/** Routes that require the D1/KV bindings (the profile/presence surface). */
const STORAGE_ROUTES_RE = /^\/api\/(auth|user|search|friends|presence)(\/|$)/;

/** Returns a Response for any /api route this module owns, or null to fall through. */
export async function routeApi(request: Request, env: Env, path: string): Promise<Response | null> {
  // Helpful 503 (not a raw 500) if the storage bindings are missing — e.g. a
  // deploy where D1/KV were never created. `npm run setup:remote` fixes it.
  // Scoped STRICTLY to the profile routes: /api/tmdb/*, /api/rooms and
  // /api/anilist/* must keep working even without these bindings.
  if (!env.DB || !env.PRESENCE_KV) {
    if (STORAGE_ROUTES_RE.test(path)) {
      // Name WHICH binding is missing — the classic failure is a valid KV id
      // pasted under the wrong binding line in wrangler.toml
      // (binding = "PRESENCE_KV_PLACEHOLDER" instead of "PRESENCE_KV").
      const missing = [
        !env.DB ? 'DB (D1)' : null,
        !env.PRESENCE_KV ? 'PRESENCE_KV (KV)' : null,
      ]
        .filter(Boolean)
        .join(' and ');
      return errorJson(
        503,
        `Profile/presence storage is not configured: missing binding ${missing}.`,
        'In wrangler.toml the KV block must read binding = "PRESENCE_KV" with your namespace id on the NEXT line (and D1: binding = "DB"). Then `npm run deploy`. To create the resources, run `npm run setup:remote`. See README → Setup.'
      );
    }
    return null;
  }

  // Self-provisioning: create any missing tables once per isolate so a
  // fresh/unmigrated D1 can never wedge users into permanent anonymity.
  await ensureSchema(env);

  const method = request.method;

  // ---- Health / build fingerprint -------------------------------------------
  // One URL that answers "which build is deployed?" without any cache
  // ambiguity: if this returns JSON, the worker is current; if it returns
  // HTML, the deployment is stale (SPA fallback = route missing).
  if (path === '/api/health' && method === 'GET') {
    return json({
      ok: true,
      build: WORKER_BUILD,
      routes: ['auth', 'geo', 'subs', 'user', 'search', 'friends', 'presence', 'rooms', 'admin', 'tmdb'],
      storage: { db: !!env.DB, presenceKv: !!env.PRESENCE_KV },
    }, 200, { 'Cache-Control': 'no-store' });
  }

  // ---- Auth -----------------------------------------------------------------
  if (path === '/api/auth/session' && method === 'POST') {
    return handleSessionCreate(request, env);
  }
  if (path === '/api/auth/me' && method === 'GET') {
    return handleMe(request, env);
  }
  if (path === '/api/auth/claim' && method === 'POST') {
    return handleClaim(request, env);
  }
  if (path === '/api/auth/code' && method === 'POST') {
    return handleRotateCode(request, env);
  }

  // ---- Admin (deployment-owner monitoring) -----------------------------------
  if (path === '/api/admin/overview' && method === 'GET') {
    return handleAdminOverview(request, env);
  }

  // ---- Global user search ----------------------------------------------------
  if (path === '/api/search/users' && method === 'GET') {
    return handleUserSearch(request, env);
  }

  // ---- Profile ----------------------------------------------------------------
  if (path === '/api/user/profile' && method === 'PUT') {
    const me = await requireUser(request, env);
    if (me instanceof Response) return me;
    return handleUpdateProfile(request, env, me);
  }
  if (path === '/api/user/history' && method === 'POST') {
    const me = await requireUser(request, env);
    if (me instanceof Response) return me;
    return handleRecordHistory(request, env, me);
  }

  const profileMatch = path.match(/^\/api\/user\/([^/]+)\/?$/);
  if (profileMatch && method === 'GET') {
    const username = decodeURIComponent(profileMatch[1]);
    if (!USERNAME_RE.test(username)) return errorJson(422, 'Invalid username.');
    return handleGetProfile(request, env, username);
  }

  // ---- Friends -----------------------------------------------------------------
  if (path === '/api/friends' && method === 'GET') {
    const me = await requireUser(request, env);
    if (me instanceof Response) return me;
    return handleListFriends(request, env, me);
  }
  const friendMatch = path.match(/^\/api\/friends\/([^/]+)\/?$/);
  if (friendMatch) {
    const username = decodeURIComponent(friendMatch[1]);
    if (!USERNAME_RE.test(username)) return errorJson(422, 'Invalid username.');
    const me = await requireUser(request, env);
    if (me instanceof Response) return me;
    if (method === 'POST') return handleFriendRequest(request, env, me, username);
    if (method === 'PUT') return handleFriendAccept(request, env, me, username);
    if (method === 'DELETE') return handleFriendRemove(request, env, me, username);
  }

  // ---- Presence (REST; room presence flows through the DO socket) -------------
  if (path === '/api/presence') {
    if (method === 'PUT' || method === 'POST') return handlePresencePut(request, env);
    if (method === 'DELETE') return handlePresenceDelete(request, env);
  }
  if (path === '/api/presence/self' && method === 'GET') {
    return handlePresenceSelf(request, env);
  }
  const presenceMatch = path.match(/^\/api\/presence\/([^/]+)\/?$/);
  if (presenceMatch && method === 'GET') {
    return handlePresenceGet(request, env, decodeURIComponent(presenceMatch[1]));
  }

  return null;
}
