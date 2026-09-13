// presence.ts — the real-time "currently watching" engine.
//
// State lives in KV under `presence:user:<user_id>` with a short TTL, so a
// vanished client's status expires on its own even if no disconnect event
// fires (tab crash, network drop). Writers:
//
//   - WatchRoom DO: forwards `presenceSync` messages from the room socket and
//     clears presence in `webSocketClose`/`webSocketError` (see WatchRoom.js).
//   - Worker: `PUT/DELETE /api/presence` for the IDLE heartbeat on the home
//     surface and `sendBeacon` cleanup on page unload.
//
// Readers: search + profile endpoints merge presence into responses. A missing
// or expired key reads back as `OFFLINE`.

import type { Env, PresencePayload, PresenceStatus } from './types.js';
import { formatClock } from './lib/format.js';

export const PRESENCE_TTL_S = 90; // heartbeat every ~30s; 3 missed beats = offline
const VALID_STATUSES: PresenceStatus[] = [
  'WATCHING_PARTY',
  'WATCHING_SOLO',
  'IDLE',
  'OFFLINE',
];

export function presenceKey(userId: string): string {
  return `presence:user:${userId}`;
}

/** Coerce arbitrary input (WS message / REST body) into a safe partial payload. */
export function sanitizePresenceInput(
  raw: unknown
): Partial<PresencePayload> & { status: PresenceStatus } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = VALID_STATUSES.includes(r.status as PresenceStatus)
    ? (r.status as PresenceStatus)
    : 'IDLE';
  const seconds = Number(r.current_timestamp_seconds);

  const out: Partial<PresencePayload> & { status: PresenceStatus } = {
    status,
    room_id: status === 'IDLE' || status === 'OFFLINE' ? '' : String(r.room_id ?? '').slice(0, 128),
    media_title: String(r.media_title ?? '').slice(0, 300),
    media_id: String(r.media_id ?? '').slice(0, 128),
    current_timestamp: Number.isFinite(seconds)
      ? formatClock(seconds)
      : String(r.current_timestamp ?? '').slice(0, 12),
    is_host: !!r.is_host,
  };
  return out;
}

/** Upsert presence for a user (merges with the previous payload). */
export async function setPresence(
  env: Env,
  userId: string,
  input: unknown
): Promise<PresencePayload> {
  const patch = sanitizePresenceInput(input);
  const previous = await getRawPresence(env, userId);
  // Room/media context survives heartbeat refreshes that omit it — but only
  // while the user is watching; IDLE/OFFLINE resets it (a home-surface
  // heartbeat must never advertise a room the user already left).
  const watching = patch.status === 'WATCHING_PARTY' || patch.status === 'WATCHING_SOLO';
  const payload: PresencePayload = {
    status: patch.status,
    room_id: watching ? patch.room_id || previous?.room_id || '' : '',
    media_title: watching ? patch.media_title || previous?.media_title || '' : '',
    media_id: watching ? patch.media_id || previous?.media_id || '' : '',
    current_timestamp: watching ? patch.current_timestamp || previous?.current_timestamp || '' : '',
    is_host: watching ? patch.is_host ?? previous?.is_host ?? false : false,
    last_updated: Date.now(),
  };
  await env.PRESENCE_KV.put(presenceKey(userId), JSON.stringify(payload), {
    expirationTtl: PRESENCE_TTL_S,
  });
  return payload;
}

/** Remove presence immediately (explicit disconnect / pagehide beacon). */
export async function clearPresence(env: Env, userId: string): Promise<void> {
  await env.PRESENCE_KV.delete(presenceKey(userId));
}

/**
 * Clear presence only when it still points at `roomId`. Used by the room DO
 * on disconnect: if the user already joined a different room from another
 * tab, that room's (newer) state must survive.
 */
export async function clearPresenceIfRoom(
  env: Env,
  userId: string,
  roomId: string
): Promise<void> {
  const current = await getRawPresence(env, userId);
  if (!current) return; // nothing (or already expired)
  if (!current.room_id || current.room_id === roomId) {
    await env.PRESENCE_KV.delete(presenceKey(userId));
  }
}

/** Raw read: payload or null when missing (or unparsable). */
export async function getRawPresence(
  env: Env,
  userId: string
): Promise<PresencePayload | null> {
  let raw: unknown;
  try {
    raw = await env.PRESENCE_KV.get(presenceKey(userId), 'json');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!VALID_STATUSES.includes(p.status as PresenceStatus)) return null;
  return {
    status: p.status as PresenceStatus,
    room_id: typeof p.room_id === 'string' ? p.room_id : '',
    media_title: typeof p.media_title === 'string' ? p.media_title : '',
    media_id: typeof p.media_id === 'string' ? p.media_id : '',
    current_timestamp: typeof p.current_timestamp === 'string' ? p.current_timestamp : '',
    is_host: !!p.is_host,
    last_updated: typeof p.last_updated === 'number' ? p.last_updated : 0,
  };
}

/** Public read: missing/stale presence is synthesized as OFFLINE. */
export async function getPresence(env: Env, userId: string): Promise<PresencePayload> {
  const p = await getRawPresence(env, userId);
  if (!p) return OFFLINE;
  return p;
}

const OFFLINE: PresencePayload = {
  status: 'OFFLINE',
  room_id: '',
  media_title: '',
  media_id: '',
  current_timestamp: '',
  is_host: false,
  last_updated: 0,
};

/**
 * Batch presence for many users (search results). KV allows 128 keys per
 * call, so chunk. Returns a map of userId -> payload (OFFLINE when absent).
 */
export async function getPresences(
  env: Env,
  userIds: string[]
): Promise<Map<string, PresencePayload>> {
  const result = new Map<string, PresencePayload>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const CHUNK = 128;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    let pairs: Map<string, string | null>;
    try {
      pairs = await env.PRESENCE_KV.get(chunk.map(presenceKey), 'text');
    } catch {
      pairs = new Map();
    }
    for (const id of chunk) {
      const raw = pairs.get(presenceKey(id));
      let payload: PresencePayload = OFFLINE;
      if (raw) {
        try {
          const p = JSON.parse(raw) as PresencePayload;
          if (p && VALID_STATUSES.includes(p.status)) payload = { ...OFFLINE, ...p };
        } catch {
          // fall through to OFFLINE
        }
      }
      result.set(id, payload);
    }
  }
  return result;
}
