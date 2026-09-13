// http.ts — tiny response helpers shared by every route module.

import type { PresencePayload } from './types.js';

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extra,
    },
  });
}

export function errorJson(status: number, error: string, detail?: string): Response {
  return json({ error, ...(detail ? { detail } : {}) }, status);
}

/** Parse a JSON request body; null on malformed input. */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as T) : null;
  } catch {
    return null;
  }
}

/** Keep a public payload free of internal columns. */
export function publicPresence(p: PresencePayload): PresencePayload {
  return {
    status: p.status,
    room_id: p.room_id,
    media_title: p.media_title,
    media_id: p.media_id,
    current_timestamp: p.current_timestamp,
    is_host: p.is_host,
    last_updated: p.last_updated,
  };
}
