/**
 * types.js — frontend mirrors of the API contract (src/types.ts).
 *
 * This file intentionally has no imports/exports: the app is a no-build,
 * script-tag app, so these typedefs stay global and are picked up by
 * `tsc --noEmit -p tsconfig.frontend.json` (checkJs). Keep in sync with the
 * backend payloads produced by src/routes/*.
 *
 * @typedef {'WATCHING_PARTY'|'WATCHING_SOLO'|'IDLE'|'OFFLINE'} PresenceStatus
 *
 * @typedef {Object} PresencePayload
 * @property {PresenceStatus} status
 * @property {string} room_id           Durable Object room id ('' when idle)
 * @property {string} media_title
 * @property {string} media_id
 * @property {string} current_timestamp 'HH:MM:SS' / 'MM:SS'
 * @property {boolean} is_host
 * @property {number} last_updated      unix ms
 *
 * @typedef {Object} Badge
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 *
 * @typedef {Object} PublicUser
 * @property {string} id
 * @property {string} username
 * @property {string} displayName
 * @property {string} avatarUrl
 * @property {string} avatarFrameId
 * @property {string} bio
 * @property {number} createdAt
 * @property {number} level
 * @property {string} levelTitle
 * @property {Badge[]} badges
 * @property {{watchCount:number, friendCount:number, favoritesCount:number}} stats
 *
 * @typedef {Object} FavoriteItem
 * @property {string} mediaId
 * @property {string} mediaType
 * @property {string} mediaTitle
 * @property {string} posterUrl
 * @property {number} displayOrder
 *
 * @typedef {Object} HistoryItem
 * @property {string} mediaId
 * @property {string} mediaType
 * @property {string} mediaTitle
 * @property {string} posterUrl
 * @property {number|null} season
 * @property {number|null} episode
 * @property {boolean} completed
 * @property {number} watchedAt
 *
 * @typedef {'self'|'none'|'accepted'|'pending-in'|'pending-out'|'blocked'} FriendshipState
 *
 * @typedef {Object} UserSearchHit
 * @property {PublicUser} user
 * @property {PresencePayload} presence
 * @property {FriendshipState} friendship
 *
 * @typedef {Object} FriendUser
 * @property {string} id
 * @property {string} username
 * @property {string} displayName
 * @property {string} avatarUrl
 * @property {string} avatarFrameId
 *
 * @typedef {Object} FriendEntry
 * @property {FriendUser} user
 * @property {PresencePayload} presence
 *
 * @typedef {Object} UserProfileResponse
 * @property {PublicUser} user
 * @property {PresencePayload} presence
 * @property {FavoriteItem[]} favorites
 * @property {HistoryItem[]} history
 * @property {FriendEntry[]} friends  accepted friends, presence merged
 * @property {FriendshipState} friendship
 *
 * @typedef {Object} SessionState
 * @property {string} token
 * @property {PublicUser} user
 */
