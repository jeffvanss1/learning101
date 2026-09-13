// router.ts — dispatch for the profile/search/presence API surface.
//
// The worker entry (src/worker.ts) delegates every /api request here first;
// room + TMDB + AniList routes stay in the entry for continuity with the
// existing app.

import type { Env, AuthedUser } from './types.js';
import { errorJson } from './http.js';
import { sessionUser } from './auth.js';
import { handleSessionCreate, handleMe } from './routes/auth.js';
import { handleUserSearch } from './routes/search.js';
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
} from './routes/presence.js';

const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function requireUser(request: Request, env: Env): Promise<AuthedUser | Response> {
  const me = await sessionUser(request, env);
  if (!me) return errorJson(401, 'Sign in to do that.');
  return me;
}

/** Returns a Response for any /api route this module owns, or null to fall through. */
export async function routeApi(request: Request, env: Env, path: string): Promise<Response | null> {
  const method = request.method;

  // ---- Auth -----------------------------------------------------------------
  if (path === '/api/auth/session' && method === 'POST') {
    return handleSessionCreate(request, env);
  }
  if (path === '/api/auth/me' && method === 'GET') {
    return handleMe(request, env);
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
  const presenceMatch = path.match(/^\/api\/presence\/([^/]+)\/?$/);
  if (presenceMatch && method === 'GET') {
    return handlePresenceGet(request, env, decodeURIComponent(presenceMatch[1]));
  }

  return null;
}
