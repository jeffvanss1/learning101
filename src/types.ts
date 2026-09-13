// types.ts — shared domain + environment types for the WatchParty worker.
//
// The runtime bindings (D1, KV, Durable Object namespace, static assets) are
// declared in wrangler.toml; this interface is the TypeScript mirror of it.

import type { WatchRoom } from './WatchRoom.js';

/** KV namespace holding `presence:user:<user_id>` keys (short TTL). */
export interface PresenceKV {
  get(key: string, type?: 'text'): Promise<string | null>;
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** Batch read — up to 128 keys per call. */
  get(keys: string[], type?: 'text'): Promise<Map<string, string | null>>;
}

/** Worker bindings, as configured in wrangler.toml. */
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  WATCH_ROOM: {
    idFromString(id: string): { toString(): string };
    idFromName(name: string): { toString(): string };
    newUniqueId(): { toString(): string };
    get(id: { toString(): string }): { fetch(request: Request | string): Promise<Response> };
  };
  /** D1 database with the profile schema (see migrations/0001_profiles.sql). */
  DB: D1Database;
  /** KV namespace for the presence engine (see src/presence.ts). */
  PRESENCE_KV: PresenceKV;
  /** TMDB catalog key (secret in production, .dev.vars locally). */
  TMDB_API_KEY?: string;
  /** HMAC secret for session tokens (`wrangler secret put SESSION_SECRET`). */
  SESSION_SECRET?: string;
}

// -- D1 row shapes -----------------------------------------------------------

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string;
  avatar_frame_id: string;
  bio: string;
  created_at: number;
  last_seen_at: number;
}

export interface FavoriteRow {
  user_id: string;
  media_id: string;
  media_type: string;
  media_title: string;
  poster_url: string;
  display_order: number;
  created_at: number;
}

export interface HistoryRow {
  id: number;
  user_id: string;
  media_id: string;
  media_type: string;
  media_title: string;
  poster_url: string;
  season: number | null;
  episode: number | null;
  /** 0/1 in D1 (SQLite has no real boolean). */
  completed: number;
  watched_at: number;
}

export type FriendshipStatus = 'pending' | 'accepted' | 'blocked';

/**
 * Directional friendship state for API consumers: a raw 'pending' row is
 * ambiguous, so responses disambiguate incoming vs outgoing requests.
 */
export type FriendshipState =
  | 'self'
  | 'none'
  | 'accepted'
  | 'pending-in'
  | 'pending-out'
  | 'blocked';

export interface FriendshipRow {
  user_id: string;
  friend_id: string;
  status: FriendshipStatus;
  created_at: number;
}

// -- Presence ----------------------------------------------------------------

export type PresenceStatus =
  | 'WATCHING_PARTY'
  | 'WATCHING_SOLO'
  | 'IDLE'
  | 'OFFLINE';

/**
 * Payload stored under `presence:user:<user_id>` (JSON, short TTL so
 * disappeared clients expire automatically — see PRESENCE_TTL_S).
 */
export interface PresencePayload {
  status: PresenceStatus;
  /** Durable Object room id, when watching. */
  room_id: string;
  media_title: string;
  media_id: string;
  /** Playback position formatted as `H:MM:SS` / `MM:SS`. */
  current_timestamp: string;
  is_host: boolean;
  last_updated: number;
}

// -- API response shapes -----------------------------------------------------

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  avatarFrameId: string;
  bio: string;
  createdAt: number;
  level: number;
  levelTitle: string;
  badges: Badge[];
  stats: { watchCount: number; friendCount: number; favoritesCount: number };
}

export interface Badge {
  id: string;
  label: string;
  icon: string;
}

export interface FavoriteItem {
  mediaId: string;
  mediaType: string;
  mediaTitle: string;
  posterUrl: string;
  displayOrder: number;
}

export interface HistoryItem {
  mediaId: string;
  mediaType: string;
  mediaTitle: string;
  posterUrl: string;
  season: number | null;
  episode: number | null;
  completed: boolean;
  watchedAt: number;
}

/** A user card in search results: profile metadata merged with live presence. */
export interface UserSearchHit {
  user: PublicUser;
  presence: PresencePayload;
  friendship: FriendshipState;
}

export interface UserProfileResponse {
  user: PublicUser;
  presence: PresencePayload;
  favorites: FavoriteItem[];
  history: HistoryItem[];
  friendship: FriendshipState;
}

// -- Session -----------------------------------------------------------------

export interface SessionClaims {
  /** User id. */
  sub: string;
  /** Username at issue time (informational). */
  username: string;
  /** Expiry, unix ms. */
  exp: number;
}

export interface AuthedUser {
  id: string;
  username: string;
}

/** A `Badge`/frame catalog entry for avatar frames. */
export interface AvatarFrame {
  id: string;
  label: string;
}

/** Typed error carrying an HTTP status through route handlers. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// The DO class is imported only so its type is resolvable for `Env.WATCH_ROOM`;
// re-exported by worker.ts at runtime.
export type { WatchRoom };
