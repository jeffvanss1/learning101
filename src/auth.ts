// auth.ts — minimal HMAC-signed session tokens.
//
// The demo app has no passwords: `POST /api/auth/session` issues a signed
// token (userId.username.expiry + HMAC-SHA256) that the client stores in
// localStorage and attaches as `Authorization: Bearer <token>`. Signature
// verification is the only gate, so tokens are tamper-proof but not
// revocable — swap `verifyToken`/`issueToken` for real auth later without
// touching the route handlers.

import type { Env, SessionClaims, AuthedUser } from './types.js';

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function secret(env: Env): string {
  // Stable dev fallback so local dev works without extra setup; production
  // must set SESSION_SECRET via `wrangler secret put`.
  return env.SESSION_SECRET || 'watchparty-dev-secret';
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
  return b64urlEncode(new Uint8Array(sig));
}

/** Sign claims into `base64(payload).signature`. */
export async function issueToken(env: Env, user: AuthedUser): Promise<string> {
  const claims: SessionClaims = {
    sub: user.id,
    username: user.username,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sig = await hmac(payload, secret(env));
  return `${payload}.${sig}`;
}

/** Verify a bearer token; returns the claims or null. */
export async function verifyToken(env: Env, token: string): Promise<SessionClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, sig] = parts;
  const expected = await hmac(payload, secret(env));
  // Constant-time-ish comparison (lengths fixed by HMAC-SHA256 output).
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;

  let claims: SessionClaims;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    claims = JSON.parse(json) as SessionClaims;
  } catch {
    return null;
  }
  if (!claims || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
  if (Date.now() > claims.exp) return null;
  return claims;
}

/** Extract + verify the session from a request; null when anonymous. */
export async function sessionUser(request: Request, env: Env): Promise<AuthedUser | null> {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const claims = await verifyToken(env, token);
  return claims ? { id: claims.sub, username: claims.username } : null;
}

export { TOKEN_TTL_MS };
