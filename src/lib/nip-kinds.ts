/**
 * Named constants for the Nostr event kinds Obelisk publishes and consumes.
 * Centralizing these here prevents typos (the numbers look alike — 1059 vs
 * 1069 is a silent bug) and gives each kind a single place to document the
 * NIP spec it comes from.
 *
 * Keep this file the single source of truth — grep `event.kind = \d` should
 * only turn up matches inside this module.
 */

/** NIP-01 — user metadata (profile). */
export const KIND_METADATA = 0;

/** NIP-01 — short text note. */
export const KIND_TEXT_NOTE = 1;

/** NIP-04 — legacy encrypted direct message. Deprecated in favor of NIP-17. */
export const KIND_ENCRYPTED_DM = 4;

/** NIP-29 — group chat message. */
export const KIND_GROUP_CHAT_MESSAGE = 9;

/** NIP-29 — group create (admin event). */
export const KIND_GROUP_CREATE = 9007;

/** NIP-29 — group metadata (replaceable, addressable by `["d", groupId]`). */
export const KIND_GROUP_METADATA = 39000;

/** NIP-29 — group admins list. */
export const KIND_GROUP_ADMINS = 39001;

/** NIP-29 — group members list. */
export const KIND_GROUP_MEMBERS = 39002;

/** NIP-17 — private message rumor (the inner unsigned event inside a 1059 gift wrap). */
export const KIND_DM_RUMOR = 14;

/** NIP-59 — seal (kind 13), the inner signed event between rumor and gift wrap. */
export const KIND_SEAL = 13;

/** NIP-65 — relay list metadata (user's preferred relays). */
export const KIND_RELAY_LIST = 10002;

/** NIP-17 — DM inbox relays. */
export const KIND_DM_INBOX_RELAYS = 10050;

/** NIP-51 — user's preferred emojis and referenced emoji/media packs. */
export const KIND_EMOJI_FAVORITES = 10030;

/** NIP-51 / NIP-30 — addressable custom emoji set. */
export const KIND_EMOJI_SET = 30030;

/** NIP-59 — gift-wrapped event, transport for NIP-17 DMs. */
export const KIND_GIFT_WRAP = 1059;

/** NIP-46 — Nostr Connect request/response (bunker signer protocol). */
export const KIND_NOSTR_CONNECT = 24133;

/**
 * NIP-78 — application-specific replaceable parameterized event. Obelisk
 * stores channel layout, relay branding, encrypted multi-device read state,
 * and per-channel SFU pins under this kind, distinguished by their `d` tag.
 */
export const KIND_NIP78_APP_DATA = 30078;

/** BUD-01 — Blossom auth event for media server uploads. */
export const KIND_BLOSSOM_AUTH = 24242;

/** NIP-98 — HTTP auth event (used by backend challenge/response). */
export const KIND_HTTP_AUTH = 27235;

/**
 * Obelisk voice — ephemeral presence beacon for voice-channel rosters.
 * Re-published every ~15s while a peer is in a voice channel; tagged with
 * `["e", channelId]` and `["expiration", now+30]` so any compliant relay
 * drops it shortly after the peer leaves. See docs/voice/mesh-protocol.md.
 */
export const KIND_VOICE_PRESENCE = 20078;

/**
 * Obelisk voice — signaling event (offer / answer / ICE / bye) directed at a
 * specific peer via `["p", recipientPubkey]`. v1 ships these as plaintext
 * signed ephemeral events (kind in 2xxxx range, relays don't persist) — the
 * channel id and recipient are already public to relay subscribers, and SDP
 * payloads aren't privacy-sensitive. Future versions may upgrade to NIP-59
 * gift-wrapped rumors once we have a NIP-07-compatible NIP-44 path.
 */
export const KIND_VOICE_SIGNAL = 25050;

/**
 * Obelisk voice — moderator force action (mute / camera-off / screen-off)
 * targeting another participant. Same plaintext-ephemeral wire as
 * `KIND_VOICE_SIGNAL`; receivers verify the signer's pubkey is a channel
 * admin/owner before acting on it.
 */
export const KIND_VOICE_MOD_ACTION = 25051;

/**
 * Obelisk SFU — control event addressed to an SFU pubkey via `["p", sfu]`.
 * Carries `{action, params}` JSON in content; `action` is one of
 * `start | end | reset | drain`. Authorization is the SFU's job: arrival
 * via a trusted-author relay (the relay's write-whitelist is the auth)
 * OR pubkey listed in the SFU's local allow.json. See docs/sfu-system.md.
 */
export const KIND_SFU_CONTROL = 25052;

/**
 * Obelisk SFU — replaceable advertisement (kind 31313) published by every
 * running SFU on its general relays. Tags carry `url`, `relay`,
 * `trusted_relay`, `cap`, `version`, `operator`, `codec`. Voice clients
 * read this to discover which SFU to address kind 25052 at when the user
 * joins a `voice-sfu` channel.
 */
export const KIND_SFU_ADVERTISE = 31313;

/**
 * Obelisk SFU — replaceable active-call announcement (kind 31314) published
 * by the SFU once a room has accepted a `start`. Tagged with `["d",
 * channelId]` so it replaces previous status for the same channel.
 * v0 dex doesn't read this (the SFU's `["sfu","1"]` voice beacon is what
 * flips client topology), but it's documented here for parity.
 */
export const KIND_SFU_ACTIVE_CALL = 31314;

/**
 * Obelisk games — every turn-based game event (create / join / start / move /
 * timeout / resign / cancel) rides this single stored kind, scoped to a
 * channel with `["h", channelId]` and to a table with `["e", gameId]`.
 *
 * Why a stored (regular) kind and not the ephemeral 25xxx voice signaling
 * uses: a game's state IS its event log. A player who opens the tab
 * mid-match replays the log through the pure engine to rebuild the board,
 * so the relay has to keep the events. Voice signaling can be ephemeral
 * because SDP is worthless a second after it's sent.
 *
 * 2390 sits in the regular range (1000-9999, relays persist) and is
 * unclaimed by any NIP — 2003/2004 (torrents) are the nearest neighbours.
 * See docs/games.md for the wire format.
 */
export const KIND_GAME = 2390;
