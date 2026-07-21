/** Relay-only nostr-tools bridge singleton. */
import { SimplePool, type Filter, type Event as NostrEvent, type EventTemplate, type VerifiedEvent, finalizeEvent, getPublicKey, nip04 } from 'nostr-tools';
import { KIND_VOICE_PRESENCE } from '@/lib/nip-kinds';
import { BunkerSigner, parseBunkerInput, createNostrConnectURI } from 'nostr-tools/nip46';
import { generateSecretKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import type { NipSigner } from '@/lib/nip-59';
import { parseRelayList, parseInboxRelayList } from '@nostr-wot/data';
import { TextCoercingWebSocket } from '@nostr-wot/data';
import { cacheGet, cacheSet, cacheDelete, cacheClearAll, cacheListIdsByKind } from './cache';
import { normalizeRelayUrl } from './relay-url';
import { wotEngine } from '@/lib/wot/engine';
import { useModerationStore } from '@/store/moderation';
import { resetAllClientState } from '@/lib/reset';
import { pushActivity, resolveActivity, failActivity, trackActivity, dismissActivity } from '@/lib/activity-log';
import { getPreferences } from '@/lib/preferences';
import { pushRelayDebug } from './relay-debug';
import { useReadStateStore } from '@/store/read-state';
import { isUserWatchingDM, isUserWatchingChannel } from '@/lib/read-gates';
import { extractMentionPubkeysFromMessage } from '@/lib/mentions';
import { customEmojiMapFromTags } from '@/lib/custom-emoji-tags';
import type {
  JsGroup,
  JsForumTag,
  JsMessage,
  JsUserMetadata,
  JsReaction,
  JsDirectMessage,
  LoadMoreMessagesResult,
  MessagesStatus,
  RelayAccessState,
  Unsubscribe,
} from './types';

/**
 * Map a CLOSED reason or publish-rejection message to a RelayAccessState.
 * Returns `null` if the reason is benign (e.g. local close) so callers leave
 * the existing state untouched. Pattern bank derives from common relay
 * implementations: strfry, nostream, nostrudel, gnost-relay.
 */
function isRelayQuotaOrRateLimit(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    r.includes('rate limit') ||
    r.includes('rate-limit') ||
    r.includes('too many') ||
    r.includes('slow down') ||
    r.includes('quota') ||
    r.includes('concurrent')
  );
}

function parseRelayRejection(reason: string): RelayAccessState | null {
  const r = reason.toLowerCase();
  // Rate-limit / quota messages often ship with the "restricted:" prefix
  // (e.g. "restricted: connection rate limit exceeded", "restricted:
  // Subscription quota exceeded: 50/50", "ERROR: too many concurrent REQs").
  // They are transient — not a pubkey-allowlist signal — and classifying
  // them as 'restricted' would wrongly flash "Not whitelisted" to legitimate
  // users.
  if (isRelayQuotaOrRateLimit(reason)) return null;
  if (r.includes('auth-required') || r.includes('auth_required') || r.includes('auth required')) {
    return 'auth-required';
  }
  if (
    r.includes('restricted') ||
    r.includes('blocked') ||
    r.includes('not allowed') ||
    r.includes('not whitelisted') ||
    r.includes('whitelist') ||
    r.includes('forbidden')
  ) {
    return 'restricted';
  }
  return null;
}

/**
 * Options for {@link BridgeImpl.publishEvent}. `mode: 'merge'` (default)
 * publishes to the union of `this.relays` and `extraRelays`; `mode: 'replace'`
 * publishes ONLY to `extraRelays`. Used by per-relay state events that must
 * not leak to the user's other relays.
 */
export interface PublishOpts {
  readonly extraRelays?: readonly string[];
  readonly mode?: 'merge' | 'replace';
}

/**
 * First value of the first tag whose name matches, or `undefined`. Equivalent
 * to `ev.tags.find((t) => t[0] === name)?.[1]` but single-pass and avoids the
 * intermediate closure allocation per ingest.
 *
 * For tags that carry a marker as a fourth element (e.g. NIP-10
 * `["e", id, relay, "reply"]`), use the explicit `.find()` form — the marker
 * predicate doesn't fit a generic helper.
 */
function getTag(ev: NostrEvent, name: string): string | undefined {
  for (const t of ev.tags) {
    if (t[0] === name) return t[1];
  }
  return undefined;
}

/**
 * Values of every tag matching `name`, in document order, skipping entries
 * whose value is empty. Equivalent to
 * `ev.tags.filter((t) => t[0] === name).map((t) => t[1])` but single-pass.
 */
function getAllTags(ev: NostrEvent, name: string): string[] {
  const out: string[] = [];
  for (const t of ev.tags) {
    if (t[0] === name && typeof t[1] === 'string' && t[1].length > 0) out.push(t[1]);
  }
  return out;
}

function eventKindDescription(kind: number): string {
  if (kind === 22242) return 'NIP-42 relay auth';
  if (kind === 9) return 'Send message';
  if (kind === 4) return 'Direct message';
  if (kind === 39000) return 'Group metadata';
  if (kind === 39001) return 'Group admins';
  if (kind === 39002) return 'Group members';
  if (kind === 7) return 'Reaction';
  return 'Nostr event';
}

/**
 * Single-pass parser for NIP-29 kind 39000 (group metadata) tag arrays.
 * Replaces ~9 separate `ev.tags.find / .some / for-of` scans with one loop.
 *
 * Semantics preserved bit-for-bit from the previous open-coded version:
 *  - `d`, `parent`, `name`, `about`, `picture`, `banner`: first occurrence wins
 *    (matches the old `tag(name)` lambda which used `ev.tags.find`).
 *  - `public` / `open`: presence-as-boolean flags.
 *  - `t`: channel-kind hint with `voice-sfu > voice > forum > text` precedence.
 *  - `forum-tag`: id-keyed map, last entry wins; malformed entries (missing
 *    id or name) are skipped silently.
 *  - `topic`: deduped via Set, document order preserved.
 *
 * Hot path — runs on every kind 39000 event in the fan-out at login, and
 * the relay can deliver hundreds of these back-to-back.
 */
function parseGroupMetadataTags(tags: NostrEvent['tags']): {
  d?: string;
  parent?: string;
  name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  isPublic: boolean;
  isOpen: boolean;
  channelKind: 'voice-sfu' | 'voice' | 'forum' | 'text';
  forumTags: JsForumTag[];
  topics: string[];
} {
  let d: string | undefined;
  let parent: string | undefined;
  let name: string | undefined;
  let about: string | undefined;
  let picture: string | undefined;
  let banner: string | undefined;
  let isPublic = false;
  let isOpen = false;
  let hasVoiceSfu = false;
  let hasVoice = false;
  let hasForum = false;
  const forumTagMap = new Map<string, JsForumTag>();
  const topicSet = new Set<string>();

  for (const t of tags) {
    const k = t[0];
    if (k === 'd') { if (d === undefined) d = t[1]; continue; }
    if (k === 'name') { if (name === undefined) name = t[1]; continue; }
    if (k === 'parent') { if (parent === undefined) parent = t[1]; continue; }
    if (k === 'about') { if (about === undefined) about = t[1]; continue; }
    if (k === 'picture') { if (picture === undefined) picture = t[1]; continue; }
    if (k === 'banner') { if (banner === undefined) banner = t[1]; continue; }
    if (k === 'public') { isPublic = true; continue; }
    if (k === 'open') { isOpen = true; continue; }
    if (k === 't') {
      const v = t[1];
      if (v === 'voice-sfu') hasVoiceSfu = true;
      else if (v === 'voice') hasVoice = true;
      else if (v === 'forum') hasForum = true;
      continue;
    }
    if (k === 'forum-tag') {
      const id = t[1];
      const ftName = t[2];
      if (!id || !ftName) continue;
      const emoji = t[3] && t[3].length > 0 ? t[3] : null;
      forumTagMap.set(id, { id, name: ftName, emoji });
      continue;
    }
    if (k === 'topic') {
      if (t[1]) topicSet.add(t[1]);
      continue;
    }
  }

  const channelKind: 'voice-sfu' | 'voice' | 'forum' | 'text' =
    hasVoiceSfu ? 'voice-sfu' : hasVoice ? 'voice' : hasForum ? 'forum' : 'text';

  return {
    d, parent, name, about, picture, banner,
    isPublic, isOpen, channelKind,
    forumTags: Array.from(forumTagMap.values()),
    topics: Array.from(topicSet),
  };
}

/**
 * Strict equality on string arrays. Used to skip redundant cacheSet writes
 * when an admin/member list republished by the relay matches the
 * already-cached snapshot.
 */
function arraysEqualStrict(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Deep equality on `JsGroup`. Two groups are equal iff every scalar field
 * matches and the `forumTags` / `topics` arrays match positionally. Used to
 * skip redundant cacheSet writes when a kind 39000 republish carries the
 * same payload.
 */
function groupEqual(a: JsGroup, b: JsGroup): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.name !== b.name || a.about !== b.about
      || a.picture !== b.picture || a.banner !== b.banner
      || a.isPublic !== b.isPublic || a.isOpen !== b.isOpen
      || a.parent !== b.parent || a.kind !== b.kind) return false;
  if (a.forumTags.length !== b.forumTags.length) return false;
  for (let i = 0; i < a.forumTags.length; i++) {
    const x = a.forumTags[i];
    const y = b.forumTags[i];
    if (!x || !y) return false;
    if (x.id !== y.id || x.name !== y.name || x.emoji !== y.emoji) return false;
  }
  if (a.topics.length !== b.topics.length) return false;
  for (let i = 0; i < a.topics.length; i++) {
    if (a.topics[i] !== b.topics[i]) return false;
  }
  return true;
}

/**
 * Shallow equality on `JsUserMetadata`. All fields are flat scalars. Used
 * to skip redundant cacheSet writes when a kind 0 republish carries the
 * same fields under a newer `created_at`.
 */
function userMetadataEqual(a: JsUserMetadata, b: JsUserMetadata): boolean {
  if (a === b) return true;
  return a.pubkey === b.pubkey
    && a.name === b.name
    && a.displayName === b.displayName
    && a.picture === b.picture
    && a.about === b.about
    && a.nip05 === b.nip05
    && a.banner === b.banner
    && a.lud16 === b.lud16
    && a.website === b.website;
}

// -- NIP-29 kinds --------------------------------------------------------
const KIND_GROUP_MESSAGE = 9;
const KIND_GROUP_METADATA = 39000;
const KIND_GROUP_JOIN_REQUEST = 9021;
const KIND_GROUP_LEAVE_REQUEST = 9022;
const KIND_USER_METADATA = 0;
const KIND_EVENT_DELETION = 5;
const KIND_REACTION = 7;
const KIND_DIRECT_MESSAGE = 4;
const KIND_GROUP_CREATE = 9007;
const KIND_GROUP_EDIT_METADATA = 9002;
const KIND_GROUP_PUT_USER = 9000;
const KIND_GROUP_REMOVE_USER = 9001;
const KIND_GROUP_REMOVE_PERMISSION = 9003;
const KIND_GROUP_DELETE_EVENT = 9005;
const KIND_GROUP_ADMINS = 39001;
const KIND_GROUP_MEMBERS = 39002;
const KIND_MUTE_LIST = 10000;
/**
 * Obelisk SFU active-call announcement (kind 31314, parameterized
 * replaceable). Emitted by an SFU when a room is live, with `d=<channelId>`,
 * `host=<hostPubkey>`, `status=<active|closed>`, and `expiration=<unix>`.
 * Sidebar and channel headers subscribe to this so a "LIVE" badge appears
 * even for users who aren't currently in the call.
 */
const KIND_SFU_ACTIVE_CALL = 31314;

export const STORAGE_KEY = 'obelisk-dex/session';
export const RELAYS_KEY = 'obelisk-dex/relays';
const LEGACY_STORAGE_KEY = 'obeliskord/session';
const LEGACY_RELAYS_KEY = 'obeliskord/relays';
const DEFAULT_RELAY = 'wss://public.obelisk.ar';
const DEFAULT_RELAYS = ['wss://public.obelisk.ar'];

// Per-channel message backfill cap. Only this many of the most recent kind 9
// events are pulled into `messagesByGroup` on the live REQ; older messages
// are paged in on demand via `loadMoreMessages`. Keeps the initial fan-out
// cheap when the user belongs to many channels and trims memory growth on
// long-lived sessions. See docs/data-system.md.
const BACKGROUND_MESSAGE_LIMIT = 50;
const LOAD_MORE_PAGE_SIZE = 50;

// How many of the most recent confirmed messages per channel get persisted to
// `bridgeCache`. Matched to BACKGROUND_MESSAGE_LIMIT so a cold load paints the
// same window the live REQ is about to request — stale-while-revalidate, with
// no visible "jump" when the relay echo lands.
const MESSAGE_CACHE_LIMIT = 50;
// Hard cap on cached reactions per channel. Reactions are tiny (~80 bytes
// each), so 500 fits well under 50KB per channel. When the live store grows
// past this, the cache flush drops the oldest by createdAt.
const REACTION_CACHE_LIMIT = 500;
// Debounce delay for message / reaction cache flushes. A backfill burst from
// the relay (kind 9 limit:50) lands as N synchronous ingest calls in the same
// tick; the debounce coalesces them into a single localStorage.setItem at the
// end. Short enough that a steady-state message arriving on its own still
// reaches disk well before the next reload window.
const CACHE_FLUSH_DELAY_MS = 200;

// How long to wait before flipping the relay-access banner from 'unknown' to
// a non-ok state on retryable rejections (auth-required/restricted). The
// `subscribeWatched` retry path heals most NIP-42 AUTH races in <1s; a 4s
// soak hides the banner for those, while still surfacing genuinely persistent
// auth/whitelist problems within a few seconds.
const RELAY_ACCESS_SOAK_MS = 4000;

/**
 * Read a localStorage value under the current key, falling back to the legacy
 * key (one-time migration: writes the value under the new key and deletes the
 * legacy entry).
 */
function readMigrated(key: string, legacyKey: string): string | null {
  if (typeof window === 'undefined') return null;
  const cur = window.localStorage.getItem(key);
  if (cur !== null) return cur;
  const legacy = window.localStorage.getItem(legacyKey);
  if (legacy !== null) {
    window.localStorage.setItem(key, legacy);
    window.localStorage.removeItem(legacyKey);
    return legacy;
  }
  return null;
}

// Quiet outbox/profile relays for bounded kind:0 metadata lookups. Keep this
// list intentionally small: normal channel browsing must not open persistent
// subscriptions against broad public profile relays.
export const DEFAULT_PROFILE_LOOKUP_RELAYS = [
  'wss://relay.obelisk.ar',
  'wss://public.obelisk.ar',
  'wss://purplepag.es',
] as const;
const PROFILE_RELAYS = DEFAULT_PROFILE_LOOKUP_RELAYS;

export const PROFILE_SYNC_CACHE_KEY = 'obelisk/profile-sync-cache/v1';
export const PROFILE_SYNC_STATE_KEY = 'obelisk/profile-sync-state/v1';
export const PROFILE_LOOKUP_RELAYS_KEY = 'obelisk/profile-lookup-relays/v1';
const OWN_PROFILE_LOOKUP_TTL_MS = 12 * 60 * 60 * 1000;
const OTHER_PROFILE_LOOKUP_TTL_MS = 6 * 60 * 60 * 1000;
const PROFILE_LOOKUP_MAX_WAIT_MS = 3500;

export interface CachedKind0Event {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

interface ProfileSyncCache {
  byPubkey: Record<string, CachedKind0Event>;
}

interface ProfileSyncState {
  ownProfileLookupAt: Record<string, number>;
  ownProfileSyncedToRelay: Record<string, number>;
}

function profileRelayKey(pubkey: string, relay: string): string {
  return `${pubkey}|${normalizeRelayUrl(relay)}`;
}

function emptyProfileSyncCache(): ProfileSyncCache {
  return { byPubkey: {} };
}

function emptyProfileSyncState(): ProfileSyncState {
  return { ownProfileLookupAt: {}, ownProfileSyncedToRelay: {} };
}

function loadProfileSyncCache(): ProfileSyncCache {
  if (typeof window === 'undefined') return emptyProfileSyncCache();
  try {
    const raw = window.localStorage.getItem(PROFILE_SYNC_CACHE_KEY);
    if (!raw) return emptyProfileSyncCache();
    const parsed = JSON.parse(raw) as ProfileSyncCache;
    return parsed && typeof parsed === 'object' && parsed.byPubkey ? parsed : emptyProfileSyncCache();
  } catch {
    return emptyProfileSyncCache();
  }
}

function saveProfileSyncCache(cache: ProfileSyncCache): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PROFILE_SYNC_CACHE_KEY, JSON.stringify(cache));
}

function loadProfileSyncState(): ProfileSyncState {
  if (typeof window === 'undefined') return emptyProfileSyncState();
  try {
    const raw = window.localStorage.getItem(PROFILE_SYNC_STATE_KEY);
    if (!raw) return emptyProfileSyncState();
    const parsed = JSON.parse(raw) as ProfileSyncState;
    return {
      ownProfileLookupAt: parsed?.ownProfileLookupAt ?? {},
      ownProfileSyncedToRelay: parsed?.ownProfileSyncedToRelay ?? {},
    };
  } catch {
    return emptyProfileSyncState();
  }
}

function saveProfileSyncState(state: ProfileSyncState): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PROFILE_SYNC_STATE_KEY, JSON.stringify(state));
}

export function getCachedKind0(pubkey: string): CachedKind0Event | null {
  return loadProfileSyncCache().byPubkey[pubkey] ?? null;
}

function toCachedKind0(ev: NostrEvent): CachedKind0Event {
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    content: ev.content,
    tags: ev.tags.map((t) => [...t]),
    sig: ev.sig,
  };
}

function newestEvent<T extends { created_at: number }>(events: readonly T[]): T | null {
  let newest: T | null = null;
  for (const ev of events) {
    if (!newest || ev.created_at > newest.created_at) newest = ev;
  }
  return newest;
}

function cachedKind0ToEvent(ev: CachedKind0Event): NostrEvent {
  return { ...ev, kind: KIND_USER_METADATA } as NostrEvent;
}

export function setCachedKind0(ev: NostrEvent | CachedKind0Event): boolean {
  const cache = loadProfileSyncCache();
  const prev = cache.byPubkey[ev.pubkey];
  if (prev && prev.created_at >= ev.created_at) return false;
  cache.byPubkey[ev.pubkey] = {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    content: ev.content,
    tags: ev.tags.map((t) => [...t]),
    sig: ev.sig,
  };
  saveProfileSyncCache(cache);
  return true;
}

interface PersistedSession {
  privKeyHex?: string;     // optional: only nsec login persists this
  pubKeyHex: string;
  loginMethod: 'nsec' | 'nip07' | 'bunker';
  relayUrl: string;
  /** NIP-46: full bunker:// URL — used to rehydrate the signer on reload. */
  bunkerUrl?: string;
  /** NIP-46: hex-encoded local client secret key for the bunker channel. */
  bunkerLocalSecretHex?: string;
}

const NOSTRCONNECT_RELAYS = ['wss://relay.nsec.app', 'wss://relay.damus.io', 'wss://nos.lol'];

type Listener<T> = (value: T) => void;

class StateStore<T> {
  private value: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (next === this.value) return;
    this.value = next;
    this.listeners.forEach((l) => l(next));
  }

  update(fn: (prev: T) => T): void {
    this.set(fn(this.value));
  }

  subscribe(cb: Listener<T>): Unsubscribe {
    this.listeners.add(cb);
    cb(this.value);
    return () => {
      this.listeners.delete(cb);
    };
  }
}

function updatePending<T extends { clientTag?: string }>(
  store: StateStore<Record<string, T[]>>,
  key: string,
  clientTag: string,
  patch: Partial<T> | null,
): void {
  store.update((prev) => {
    const existing = prev[key];
    if (!existing) return prev;
    if (patch === null) {
      const next = existing.filter((msg) => msg.clientTag !== clientTag);
      return next.length === existing.length ? prev : { ...prev, [key]: next };
    }
    let touched = false;
    const next = existing.map((msg) => {
      if (msg.clientTag !== clientTag) return msg;
      touched = true;
      return { ...msg, ...patch };
    });
    return touched ? { ...prev, [key]: next } : prev;
  });
}

export class BridgeImpl {
  private pool: SimplePool;
  private relays: string[] = [DEFAULT_RELAY];

  /**
   * Per-relay timers for deferred relay-access downgrades. See
   * {@link setRelayAccessDeferred}. Cleared on session change.
   */
  private deferredAccessDowngrades = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Activity-log id of the persistent "Authenticating with {host}" entry
   * tied to a relay's `'authenticating'` access state. Created when the
   * relay first sends a NIP-42 AUTH challenge (in `automaticallyAuth`),
   * resolved when access flips to `'ok'`, failed when it flips to
   * `'auth-required'` / `'restricted'` / `'error'`. Driven entirely from
   * inside {@link setRelayAccess} so any code path that mutates access state
   * keeps the bottom-right indicator in sync.
   */
  private authActivityIds = new Map<string, number>();

  /**
   * True if `url` is the relay the user is currently viewing — the only
   * relay we should answer NIP-42 AUTH challenges for. nostr-tools may pass
   * URLs with or without a trailing slash, so compare normalized.
   */
  private isActiveRelay(url: string): boolean {
    const target = normalizeRelayUrl(url);
    if (this.relays.some((r) => normalizeRelayUrl(r) === target)) return true;
    return this.authAllowedRelays.has(target);
  }

  /** DM relay NIP-42 allow-list. Only populated from subscribeIncomingDMs() after DM opt-in. */
  private authAllowedRelays = new Set<string>();

  /**
   * Update the relay-access store for the active relay. No-op for any URL
   * that isn't the currently-opened relay — we only surface auth/whitelist
   * state for the relay the user is actually looking at.
   *
   * Sticky upgrade to 'ok' guards against transient AUTH refreshes (some
   * relays re-challenge mid-session): once the relay has confirmed it reads
   * us, we don't flip back to 'authenticating' for a refresh round-trip.
   *
   * Pass `{ override: true }` for explicit relay rejections — CLOSED with
   * `auth-required:` / `restricted:` reason, ensureRelay handshake failure,
   * or a socket drop. Those are authoritative about loss of access and must
   * be allowed to downgrade from 'ok'; otherwise the banner never surfaces
   * a non-whitelisted user who first saw an EOSE on an empty filter.
   */
  private setRelayAccess(url: string, state: RelayAccessState, opts?: { override?: boolean }): void {
    if (!this.isActiveRelay(url)) return;
    const key = normalizeRelayUrl(url);
    const cur = this.relayAccess.get();
    if (cur[key] === state) return;
    // Sticky-OK: once the relay has confirmed it reads us, never downgrade
    // back to a non-'ok' state. Per-channel CLOSED rejections (private
    // channels the user isn't a member of, NIP-29 publish races) are normal
    // mid-session noise — letting them flip the banner causes flashing.
    if (cur[key] === 'ok' && state !== 'ok' && !opts?.override) return;
    // Any state transition supersedes a pending deferred downgrade — most
    // importantly, a flip to 'ok' must cancel a pending 'auth-required' so
    // the banner never appears for transient AUTH races that healed via
    // retry within the soak window.
    const pending = this.deferredAccessDowngrades.get(key);
    if (pending) {
      clearTimeout(pending);
      this.deferredAccessDowngrades.delete(key);
    }
    // Manage the persistent "Authenticating with {host}" activity entry
    // that backs the bottom-right indicator. Entering 'authenticating'
    // pushes a pending entry; leaving it resolves (→ ok) or fails
    // (→ auth-required / restricted / unreachable / error).
    if (state === 'authenticating' && cur[key] !== 'authenticating') {
      const host = (() => {
        try { return new URL(url).host; } catch { return url; }
      })();
      const id = pushActivity(`Authenticating with ${host}`, 'NIP-42 relay AUTH — approve in your signer');
      this.authActivityIds.set(key, id);
    } else if (cur[key] === 'authenticating' && state !== 'authenticating') {
      const id = this.authActivityIds.get(key);
      if (id != null) {
        if (state === 'ok') {
          resolveActivity(id);
        } else if (state === 'auth-required') {
          failActivity(id, 'AUTH was not accepted by the relay');
        } else if (state === 'restricted') {
          failActivity(id, 'pubkey is not whitelisted on this relay');
        } else if (state === 'unreachable') {
          // Transient: the socket dropped mid-AUTH. The reconnect path
          // will fire a fresh AUTH activity if it actually re-authenticates.
          // Marking this one as failed surfaces a misleading "relay is
          // unreachable" toast even when the next round-trip succeeds.
          dismissActivity(id);
        } else if (state === 'error') {
          failActivity(id, 'relay rejected the request');
        } else {
          dismissActivity(id);
        }
        this.authActivityIds.delete(key);
      }
    }
    this.relayAccess.set({ ...cur, [key]: state });
  }

  /**
   * Schedule a downgrade to a non-'ok' relay-access state after a soak
   * window. Used when CLOSED carries `auth-required` / `restricted` reasons
   * but `subscribeWatched` is about to retry: most of those rejections are
   * transient (the relay sent CLOSED before NIP-42 AUTH fully completed) and
   * heal in milliseconds. Calling `setRelayAccess` immediately would flash
   * the banner during the AUTH race.
   *
   * The deferred call bypasses sticky-OK because by the time the timer fires
   * (after RELAY_ACCESS_SOAK_MS), the relay has had multiple opportunities to
   * deliver an event/EOSE that would have cancelled the downgrade. A
   * persistent CLOSED auth-required/restricted is the relay's authoritative
   * answer, even if an earlier EOSE on a different filter said 'ok'.
   *
   * - First failure starts the timer; subsequent failures while the timer is
   *   pending do NOT reset it (we want a fixed bound on how long the banner
   *   stays hidden, not "indefinite as long as failures keep arriving").
   * - A successful read (`setRelayAccess(url, 'ok')`) cancels the pending
   *   downgrade — that's the happy path: retry succeeded, banner never shown.
   * - On session change, `resetPoolForSessionChange` clears all timers.
   */
  private setRelayAccessDeferred(url: string, state: RelayAccessState): void {
    if (!this.isActiveRelay(url)) return;
    const key = normalizeRelayUrl(url);
    const cur = this.relayAccess.get();
    if (cur[key] === 'ok') return; // sticky-OK
    if (cur[key] === state) return;
    if (this.deferredAccessDowngrades.has(key)) return; // don't extend window
    const t = setTimeout(() => {
      this.deferredAccessDowngrades.delete(key);
      const now = this.relayAccess.get();
      if (now[key] === 'ok') return;
      if (now[key] === state) return;
      this.setRelayAccess(url, state);
    }, RELAY_ACCESS_SOAK_MS);
    this.deferredAccessDowngrades.set(key, t);
  }
  private session: PersistedSession | null = null;
  private subs: Array<{ close: () => void; markClosed?: () => void }> = [];
  private activeGroupId: string | null = null;
  /** Active NIP-46 signer (when loginMethod === 'bunker'). Reconstructed lazily. */
  private bunkerSigner: BunkerSigner | null = null;
  /** Set by the modal so it can show the auth-challenge URL. */
  private bunkerOnAuth: ((url: string) => void) | null = null;

  private browserConnectionEventsWired = false;
  private isBrowserOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }
  private onBrowserOffline = (): void => {
    if (!this.session) return;
    this.cancelReconnectTimer();
    this.reconnectAttempt = 0;
    this.connectionState.set("Offline");
  };
  private onBrowserOnline = (): void => {
    if (this.session) this.retryConnectionNow();
  };
  private onVisibilityChange = (): void => {
    if (
      this.session
      && document.visibilityState === "visible"
      && this.connectionState.get() !== "Connected"
      && !this.isBrowserOffline()
    ) {
      this.retryConnectionNow();
    }
  };
  private wireBrowserConnectionEvents(): void {
    if (typeof window === "undefined" || this.browserConnectionEventsWired) return;
    this.browserConnectionEventsWired = true;
    window.addEventListener("offline", this.onBrowserOffline);
    window.addEventListener("online", this.onBrowserOnline);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }
  private unwireBrowserConnectionEvents(): void {
    if (typeof window === "undefined" || !this.browserConnectionEventsWired) return;
    this.browserConnectionEventsWired = false;
    window.removeEventListener("offline", this.onBrowserOffline);
    window.removeEventListener("online", this.onBrowserOnline);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  constructor() {
    this.pool = this.createPool();
    this.wireWotEngine();
    this.wireAuthSettledHook();
  }

  /**
   * Detect `relayAccess` transitions to `'ok'` on the active relay and
   * refresh kind 9 channels that were stuck waiting on AUTH. Without
   * this, a user who taps "approve" in their NIP-46 bunker 20s after
   * page load would still see "Loading messages…" forever because:
   *   - The empty-EOSE retry ladder exhausted before AUTH settled
   *     ({@link scheduleEmptyRetry}'s exhaustion path now defers
   *     promotion-to-`empty-confirmed` while access is
   *     `'authenticating'` / `'unknown'`), so channels sit in
   *     `'empty-unconfirmed'` waiting for a signal.
   *   - `subscribeWatched`'s inner retry loop continues at backoff, but
   *     it can't re-paint stale messages because there's nothing in
   *     `messagesByGroup` yet.
   * The hook below provides that signal: AUTH just settled → refresh
   * the active channel (and a small batch of background stuck channels)
   * so the fresh REQ rides the now-AUTH'd socket.
   *
   * Cap on background refreshes: many-channel accounts (50+) could
   * otherwise blast the relay with N parallel kind 9 restarts. 5 is
   * arbitrary but bounded; channels the user actually opens still get
   * a direct refresh via setActiveGroup's re-entry path.
   */
  private lastRelayAccessByUrl = new Map<string, RelayAccessState>();
  private wireAuthSettledHook(): void {
    this.relayAccess.subscribe((byRelay) => {
      const active = this.currentRelayUrl.get();
      const cur = byRelay[active];
      const prev = this.lastRelayAccessByUrl.get(active);
      this.lastRelayAccessByUrl.set(active, cur ?? 'unknown');
      // We only care about the *first* time AUTH leaves the in-flight
      // state for the active relay — i.e., transitions out of
      // 'unknown' / 'authenticating' / undefined. Transitions between
      // non-pending states (e.g., 'ok' → 'unreachable' on a socket
      // drop) are handled by the reconnect path elsewhere.
      const wasPending = prev === undefined || prev === 'unknown' || prev === 'authenticating';
      if (!wasPending) return;
      if (cur === 'unknown' || cur === 'authenticating' || cur === undefined) return;
      if (cur === 'ok') {
        // Happy path: AUTH succeeded. Refresh stuck channels so the
        // fresh kind 9 REQs ride the now-AUTH'd socket and deliver
        // history without the user manually reloading.
        this.refreshStuckChannelsAfterAuthOk();
      } else {
        // 'auth-required' / 'restricted' / 'unreachable' / 'error' —
        // AUTH definitively failed. Any channel held in
        // `empty-unconfirmed` by the ladder's AUTH-pending defer
        // promotes to `empty-confirmed` now so the UI shows the
        // honest "No messages yet" instead of a forever spinner.
        // The RelayStatusBanner explains the failure separately.
        this.promoteStuckChannelsAfterAuthFail();
      }
    });
  }

  private refreshStuckChannelsAfterAuthOk(): void {
    // "Stuck" here means anything not yet `has-messages`. Channels in
    // `'loading'` matter too: a sub opened during AUTH-pending often
    // hits the EOSE-then-CLOSED auth-required race AND never reaches
    // EOSE again on its current closure, so it gets stranded in
    // 'loading' (no events, no EOSE, no error to retry on). Refreshing
    // tears down that zombie and opens a fresh REQ on the now-AUTH'd
    // socket.
    const isStuck = (status: MessagesStatus | undefined): boolean =>
      status === 'loading'
      || status === 'empty-unconfirmed'
      || status === 'empty-confirmed';
    const statuses = this.messagesStatusByGroup.get();
    const activeGroup = this.activeGroupId;
    if (activeGroup && isStuck(statuses[activeGroup])) {
      this.refreshGroupMessages(activeGroup);
    }
    let batched = 0;
    for (const [id, status] of Object.entries(statuses)) {
      if (id === activeGroup) continue;
      if (isStuck(status)) {
        this.refreshGroupMessages(id);
        batched++;
        if (batched >= 5) break;
      }
    }
  }

  private promoteStuckChannelsAfterAuthFail(): void {
    const statuses = this.messagesStatusByGroup.get();
    for (const [id, status] of Object.entries(statuses)) {
      if (status === 'empty-unconfirmed') {
        this.setMessagesStatus(id, 'empty-confirmed');
        this.clearMessagesRetry(id);
      }
    }
  }

  /**
   * Connect the WoT engine to the bridge:
   *   - Consensual-DM exemption: any peer we have a cached DM thread with
   *     bypasses the gate (you opted in by talking to them).
   *   - Synced mute list (NIP-51 kind 10000) + local zustand mute list →
   *     engine's union via {@link syncMutesToEngine}.
   *   - Local zustand block list → engine's hard denylist.
   *
   * Important: WoT/mute/block verdicts are non-destructive. They gate future
   * ingestion/rendering decisions, but they must not wipe cached messages,
   * DMs, metadata, channels, admins, or members. Only explicit relay/user
   * delete/moderation events are allowed to remove user-visible data.
   */
  private wireWotEngine(): void {
    this.myPubkey.subscribe((pk) => wotEngine.setOwnPubkey(pk));
    wotEngine.setConsensualDmPredicate((pubkey) => {
      const peers = this.dmsByPeer.get();
      return Object.prototype.hasOwnProperty.call(peers, pubkey);
    });
    this.myMutes.subscribe(() => this.syncMutesToEngine());
    if (typeof window !== 'undefined') {
      useModerationStore.subscribe(() => this.syncMutesToEngine());
      this.syncMutesToEngine();
    }
  }

  private syncMutesToEngine(): void {
    const local = (typeof window !== 'undefined') ? useModerationStore.getState() : null;
    const synced = this.myMutes.get();
    const muteUnion = new Set<string>([...(synced ?? []), ...(local?.mutedPubkeys ?? [])]);
    wotEngine.setMutedPubkeys(Array.from(muteUnion));
    wotEngine.setBlockedPubkeys(local?.blockedPubkeys ?? []);
  }

  /**
   * Create a SimplePool with NIP-42 automatic authentication.
   * When the relay sends an AUTH challenge, the pool signs a kind-22242
   * event with the current session key and sends it back automatically.
   */
  private createPool(): SimplePool {
    return new SimplePool({
      // Some relays (or compressing proxies) push EVENT/EOSE frames as
      // binary. nostr-tools' default parser does `json.slice(...).indexOf(...)`
      // unconditionally and crashes on any non-string payload, silently
      // dropping events. TextCoercingWebSocket UTF-8-decodes binary frames
      // before the parser sees them. Normalize relay URLs before opening sockets.
      websocketImplementation: TextCoercingWebSocket as unknown as typeof WebSocket,
      enablePing: true,
      automaticallyAuth: (relayUrl: string) => {
        if (!this.session) return null;
        // Only sign NIP-42 AUTH challenges for the relay the user has
        // currently opened. Auxiliary relays (profile lookup, NostrConnect
        // rendezvous, NIP-65 DM relays) may issue AUTH too, but we don't
        // want to leak the user's pubkey to relays they're not browsing —
        // and a slow/unresponsive auxiliary signer should not block reads.
        if (!this.isActiveRelay(relayUrl)) return null;
        // Flip the relay into 'authenticating' synchronously so the UI can
        // gate cached groups/messages on a positive AUTH signal before any
        // signer round-trip. The activity-log entry tied to this state
        // (managed by setRelayAccess) keeps the bottom-right indicator
        // visible until the relay accepts/rejects us.
        this.setRelayAccess(relayUrl, 'authenticating');
        return async (evt: EventTemplate): Promise<VerifiedEvent> => {
          if (this.session?.loginMethod === 'nsec' && this.session.privKeyHex) {
            const sk = hexToBytes(this.session.privKeyHex);
            return finalizeEvent(evt, sk) as VerifiedEvent;
          }
          if (this.session?.loginMethod === 'nip07') {
            const win = (window as any).nostr;
            if (!win) throw new Error('NIP-07 extension unavailable');
            return (await win.signEvent(evt)) as VerifiedEvent;
          }
          if (this.session?.loginMethod === 'bunker') {
            const b = await this.ensureBunkerSigner();
            return (await b.signEvent(evt as unknown as EventTemplate & { pubkey: string })) as VerifiedEvent;
          }
          throw new Error('Cannot sign auth event with current login method');
        };
      },
    } as ConstructorParameters<typeof SimplePool>[0]);
  }

  /**
   * `true` when the active relay's WebSocket is currently in OPEN state.
   * Set in `connect()` after `ensureRelay` reports `connected`, cleared in
   * the `relay.onclose` handler. Used to short-circuit `pool.close()` and
   * per-sub `activeSub.close()` calls when the socket has already dropped —
   * sending a CLOSE frame on a non-OPEN WebSocket is a noisy browser
   * warning ("WebSocket is already in CLOSING or CLOSED state") logged
   * once per sub and once per pool.close, which spams the console during
   * a normal reconnect cycle.
   */
  private poolSocketAlive = false;
  /** Dedicated pool for latency-sensitive mesh voice roster/signaling REQs.
   *  Kept off the chat bridge socket so public-relay per-WebSocket REQ caps
   *  cannot starve a call after the app shell opens message/profile streams. */
  private voicePool: SimplePool | null = null;
  private voicePoolRefs = 0;
  private voicePoolRelays = new Set<string>();
  // Reactive state
  isLoggedIn = new StateStore(false);
  /**
   * Per-relay access state (NIP-42 / whitelist) for the active relay only.
   * Keyed by `normalizeRelayUrl(url)`. Updated from CLOSED reasons in
   * `subscribeWatched` and from rejected publishes in `signAndPublish`.
   * Reset on `switchRelay` / `resetPoolForSessionChange`.
   */
  relayAccess = new StateStore<Record<string, RelayAccessState>>({});
  connectionState = new StateStore<string>('Disconnected');
  currentRelayUrl = new StateStore<string>(DEFAULT_RELAY);
  configuredRelays = new StateStore<string[]>([...DEFAULT_RELAYS]);
  groups = new StateStore<JsGroup[]>([]);
  /**
   * `true` once the relay has emitted EOSE for the global kind 39000 sub on
   * the active relay. Lets the empty-state UI distinguish "still loading"
   * from "relay confirmed zero groups visible to me" — the latter is the
   * classic whitelist symptom on relays that don't send a CLOSED reason.
   */
  groupMetadataEose = new StateStore<boolean>(false);
  messagesByGroup = new StateStore<Record<string, JsMessage[]>>({});
  userMetadata = new StateStore<Record<string, JsUserMetadata>>({});
  reactionsByGroup = new StateStore<Record<string, Record<string, JsReaction[]>>>({});
  private deletedEventIdsByGroup = new Map<string, Map<string, string>>();
  private moderatedEventIdsByGroup = new Map<string, Set<string>>();
  childrenByParent = new StateStore<Record<string, string[]>>({});
  dmsByPeer = new StateStore<Record<string, JsDirectMessage[]>>({});
  /**
   * Original send arguments for in-flight or just-failed group-message
   * publishes, keyed by `clientTag`. Survives the publish itself so a retry
   * can replay the exact same content / replyTo / created_at — replaying
   * with a fresh `created_at` would let two NIP-29 events with different ids
   * both reach the relay, leaving a duplicate behind.
   */
  private pendingGroupSends = new Map<string, {
    groupId: string;
    content: string;
    replyTo: { id: string; pubkey: string } | null;
    emojiTags: string[][];
    createdAt: number;
  }>();
  /** Same as {@link pendingGroupSends} for NIP-04 DMs. */
  private pendingDMSends = new Map<string, {
    recipientPubkey: string;
    content: string;
    createdAt: number;
  }>();
  adminsByGroup = new StateStore<Record<string, string[]>>({});
  membersByGroup = new StateStore<Record<string, string[]>>({});
  /**
   * Map of `groupId -> creator pubkey hex`, derived from the kind 9007 event
   * that created each group. Used by {@link claimCreatorAdmin} to know whether
   * the local user is the creator of a group (so we should publish a kind 9000
   * with `['admin']` if the relay didn't auto-promote them) without spamming
   * kind 9000 publishes for every group on every login.
   */
  groupCreators = new StateStore<Record<string, string>>({});
  /**
   * Per-group flag flipped to `true` once the relay has delivered at least
   * one kind 39001 (admins) or 39002 (members) event for that group. The
   * voice-channel membership gate uses this as positive evidence the relay
   * is actually responding before deciding "not-a-member" — without it, a
   * slow NIP-42 round-trip looks identical to "user is not a member" and
   * users have to refresh to recover.
   */
  membershipReadyByGroup = new StateStore<Record<string, boolean>>({});
  /**
   * Per-group confidence enum for the kind 9 messages stream. See
   * {@link MessagesStatus} for transitions. The chat pane reads this to
   * decide between "Loading messages…" (loading | empty-unconfirmed) and
   * "No messages yet" (empty-confirmed). Empty-unconfirmed exists because
   * auth-gated relays routinely send EOSE-empty fast and trickle real
   * events afterwards; the bridge stays in that state through up to
   * {@link EMPTY_RETRY_DELAYS}.length restarts before promoting to
   * empty-confirmed, so the UI never falsely flashes "No messages".
   */
  messagesStatusByGroup = new StateStore<Record<string, MessagesStatus>>({});
  /**
   * SFU active-call state per channel id. Populated from kind 31314 events
   * the SFU publishes when a room is live. The UI reads this to show a
   * "LIVE" indicator on voice channels in the sidebar — even for users
   * who aren't currently joined. `null` (or missing entry) means no active
   * call known. Entries auto-expire client-side once `expiresAt` passes
   * so a stale advertisement doesn't pin "LIVE" forever after an SFU
   * crash that never published `status=closed`.
   */
  activeCallByChannel = new StateStore<Record<string, { hostPubkey: string; status: string; participantCount: number; expiresAt: number; createdAt: number; mode?: 'sfu' | 'mesh'; participantPubkeys?: string[] }>>({});
  private sfuActiveCalls = new Map<string, { hostPubkey: string; status: string; participantCount: number; expiresAt: number; createdAt: number; mode: 'sfu'; participantPubkeys?: string[] }>();
  private sfuPresenceByChannel = new Map<string, Map<string, { expiresAt: number; createdAt: number; participantPubkeys: string[] }>>();
  private meshPresenceByChannel = new Map<string, Map<string, { expiresAt: number; createdAt: number }>>();
  /** Newest mesh presence event seen per channel/pubkey, including leave tombstones. */
  private meshPresenceSeenAtByChannel = new Map<string, Map<string, number>>();
  private meshPresenceSweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * NIP-51 kind 10000 mute list — pubkeys the local user has muted (public
   * `p` tags only; encrypted entries in `content` are not yet decrypted).
   * Consumers filter messages and DMs against this set so muted authors'
   * content disappears from the UI without affecting relay storage.
   */
  myMutes = new StateStore<string[]>([]);
  /**
   * `true` once the active NIP-46 bunker signer has completed its handshake
   * with the bunker relay (or the user logged in via nsec/NIP-07 — those
   * methods don't have an external signer to wait for, so they never set this
   * to `true`; consumers that need a generic "ready to publish" flag should
   * derive it from `(loginMethod !== 'bunker') || bunkerSignerReady`).
   * Pre-warmed during {@link initialize} on page reload to avoid a cold
   * `BunkerSigner.connect()` round-trip during the first NIP-42 AUTH.
   */
  bunkerSignerReady = new StateStore<boolean>(false);
  /**
   * Reactive mirror of `session?.pubKeyHex`. Plain `getPublicKey()` is a
   * one-shot read; this store lets React components subscribe so they
   * re-render on login/logout without manual wiring.
   */
  myPubkey = new StateStore<string | null>(null);
  /**
   * Reactive mirror of `session?.loginMethod`. Lets components derive
   * "do I need to wait for a remote signer?" without reaching into
   * the bridge's private session.
   */
  myLoginMethod = new StateStore<'nsec' | 'nip07' | 'bunker' | null>(null);

  // Pubkeys we've already requested kind:0 for, to avoid duplicate subscriptions.
  private metadataRequested = new Set<string>();
  // Group ids we already have a message subscription for.
  private messageSubscribedGroups = new Set<string>();
  /**
   * Per-group kind 9 subscription handles. Tracked so
   * {@link refreshGroupMessages} can close the previous sub before opening
   * a fresh one — without this the bridge would leak stale subs every time
   * a chat panel re-mounts a stale channel.
   */
  private messageSubByGroup = new Map<string, { close: () => void; markClosed?: () => void }>();
  // Group ids we already have a reaction subscription for.
  private reactionSubscribedGroups = new Set<string>();
  private reactionSubByGroup = new Map<string, { close: () => void; markClosed?: () => void }>();
  private eventDeletionSubscribedGroups = new Set<string>();
  private eventDeletionSubByGroup = new Map<string, { close: () => void; markClosed?: () => void }>();
  private groupModerationDeletionSubscribedGroups = new Set<string>();
  private groupModerationDeletionSubByGroup = new Map<string, { close: () => void; markClosed?: () => void }>();
  private dmSubscribed = false;
  private dmSubHandles: Array<{ close: () => void; markClosed?: () => void }> = [];
  private adminMemberSubscribedGroups = new Set<string>();
  private adminMemberSubByGroup = new Map<string, { close: () => void; markClosed?: () => void }>();
  private creatorSubscribedGroups = new Set<string>();
  private creatorSubByGroup = new Map<string, { close: () => void; markClosed?: () => void }>();
  private voiceRelayCapacityReservations = 0;
  // Newest `created_at` we've seen for kind-39001 (admins) / kind-39002
  // (members) per group id. Used to drop out-of-order ingests so an older
  // revision arriving second from a slower relay can't clobber the newer
  // list — the symptom of that race is the admin badge / settings gear /
  // members rail flickering on/off until the user refreshes.
  private adminMemberLatestAt = new Map<string, number>();
  // Same newest-wins guard for kind 39000 (group metadata) so an older
  // revision from a slow relay can't overwrite a fresher one. Also lets
  // the cached seed survive against stale events still in flight.
  private groupMetadataLatestAt = new Map<string, number>();
  /**
   * Reverse index for {@link childrenByParent}: groupId → its current parent
   * (or `null` if root). Used by {@link ingestGroupMetadata} to update the
   * children map in O(1) on every kind 39000 ingest instead of scanning
   * every parent bucket for the groupId — the relay can deliver hundreds of
   * 39000 events back-to-back at login, and the old `Object.keys(prev)` +
   * `.filter()` per ingest was O(parents × children) on a hot path.
   * Lifecycle mirrors {@link childrenByParent}.
   */
  private groupParentMap = new Map<string, string | null>();
  // Newest-wins guard for kind 0 (user metadata). Without this, an older
  // revision returned by a slow profile relay overwrites a newer one from a
  // faster relay — the symptom is the member rail's names/avatars loading
  // and then "unloading" back to the npub a moment later.
  private userMetadataLatestAt = new Map<string, number>();
  /**
   * After {@link resetPoolForSessionChange} rebuilds the pool, the global
   * subscriptions get re-issued by {@link connect}, but per-group REQs
   * (messages, reactions, admin/member, kind-0 metadata) are owned by mounted
   * components that already called `subscribeMessages` / `subscribeAdminMember`
   * / `ensureUserMetadata` once on mount. Components don't re-call those after
   * login — their store listeners are still wired up — so without this
   * snapshot the new pool has no REQs for any of them and the user has to
   * refresh until the relay is asked again. We capture the previously-active
   * per-group subscriptions before reset and re-issue them after reconnect.
   */
  private pendingResubscribe: {
    messages: string[];
    reactions: string[];
    adminMember: string[];
    metadata: string[];
  } | null = null;
  /**
   * Background queue for kind 9 message subscriptions discovered via
   * `ingestGroupMetadata`. The relay typically streams hundreds of kind
   * 39000 events back-to-back at login; firing N message REQs in the same
   * tick floods the relay's per-connection sub limit and the channel the
   * user is actually looking at ends up at the back of the response queue.
   * Instead, we queue background subs here and process them in small
   * batches — the active group is always fast-tracked via
   * {@link setActiveGroup} or {@link bumpGroupMessagesPriority} so the
   * channel currently in view gets its history first.
   *
   * Maintained as both an ordered array (for FIFO drain) and a Set (for
   * O(1) dedup). Cleared on relay switch / logout alongside
   * `messageSubscribedGroups` so old work doesn't leak into a new pool.
   */
  private pendingMessageQueue: string[] = [];
  private pendingMessageSet = new Set<string>();
  private pendingMessageTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Upper bound on how long the background message-queue drain stays
   * paused waiting for the active channel's first EOSE / event. Without
   * this, an active channel that never responds (silent socket,
   * auth-gated relay that never delivers, watchdog-thrashing sub) would
   * starve every other channel's kind 9 sub indefinitely — and since
   * `ingestMessage` is where `ensureUserMetadata` is fanned out, that
   * also starves the profile-picture lookups for those channels'
   * authors. {@link ACTIVE_PRIORITY_MAX_PAUSE_MS} caps the pause; after
   * it elapses, the queue drains even if the active sub is still
   * `loading`. Tuned to give the watched channel a healthy head start
   * without leaving background data stranded for noticeably long.
   */
  private static readonly ACTIVE_PRIORITY_MAX_PAUSE_MS = 3000;
  /**
   * Passive background message streams are useful for unread badges, but every
   * open group consumes a relay subscription. Keep a hard ceiling well under
   * public.obelisk.ar's 50-sub limit so global REQs, voice signaling, and the
   * currently-open channel have room. Active channels bypass this cap.
   */
  private static readonly MAX_BACKGROUND_MESSAGE_STREAMS = 8;
  /**
   * Wall-clock deadline after which the active-channel priority gate
   * stops pausing the background drain. Set on every {@link setActiveGroup}
   * call; reset to 0 on logout / relay switch / pool reset.
   */
  private activeGroupPriorityDeadline = 0;
  /**
   * Single-shot timer that fires at {@link activeGroupPriorityDeadline}
   * and force-releases the gate. Without an explicit fire, a queue that
   * arrived while the gate was engaged would sit forever if the active
   * sub never produced an EOSE / event to trigger
   * {@link maybeResumeMessageQueueDrain}.
   */
  private activeGroupPriorityTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-group retry tracking for the kind 9 stream. Populated on the first
   * empty EOSE; cleared on first event ingest, channel logout, or after
   * {@link EMPTY_RETRY_DELAYS}.length restarts (whichever comes first).
   *
   * `attempts` counts the number of retries already executed (0 = just got
   * first EOSE-empty, no retry yet). `sawEvent` is currently informational
   * — the authoritative event check happens against `messagesByGroup` on
   * retry-fire so we don't race the StateStore.
   */
  private messagesRetryByGroup = new Map<string, {
    attempts: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  /**
   * Per-group flag for the cold-load `querySync` fallback. The bridge
   * fires one explicit `pool.querySync` after the empty-EOSE retry
   * ladder exhausts — bypasses the live REQ retry loop and gives the
   * relay a last shot to deliver kind 9 once AUTH / whitelist state
   * has had time to settle. Single-shot per groupId per session;
   * cleared on logout / relay switch / dispose, and reset by
   * {@link refreshGroupMessages} so an explicit user retry can fire
   * it again.
   */
  private querySyncFallbackFired = new Set<string>();
  /**
   * Per-group debounce timers for message-cache flushes. Coalesces a burst
   * of `ingestMessage` calls (typical of a kind 9 limit:50 backfill arriving
   * in one tick) into a single localStorage.setItem at the end of the
   * burst. Cleared on logout / dispose / relay switch — see
   * {@link clearAllCacheFlushers}.
   */
  private messageCacheFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Per-group debounce timers for reaction-cache flushes. Same shape and
   * lifecycle as {@link messageCacheFlushTimers}.
   */
  private reactionCacheFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Empty kind-39000 EOSE is provisional. Some relays answer the global
   * channel-list REQ before AUTH / whitelist evaluation has fully settled,
   * then deliver metadata on a later request. Keep the sidebar in
   * "Loading channels..." for a bounded retry window instead of painting the
   * "No channels" empty state immediately.
   */
  private groupMetadataEmptyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private groupMetadataEmptyRetryAttempts = 0;
  private static readonly GROUP_METADATA_EMPTY_RETRY_DELAYS = [1500, 3000, 5000] as const;
  /**
   * Backoff schedule for empty-EOSE retries. Tuned so the worst-case time
   * before declaring a channel empty is the sum of all delays plus the
   * relay's own response time (≈9.5s + EOSE latency). Auth-gated relays
   * that send EOSE-empty before AUTH completes typically deliver real
   * events within the first 1500ms; the longer tail covers slow relays
   * and transient network hiccups.
   */
  private static readonly EMPTY_RETRY_DELAYS = [1500, 3000, 5000] as const;
  // Per-pubkey cache of recipient NIP-65 read relays (where they read DMs).
  // Populated on first sendDirectMessage to that pubkey; TTL'd to avoid
  // requerying every send.
  private recipientReadRelaysCache = new Map<string, { relays: string[]; fetchedAt: number }>();
  private profileLookupInFlight = new Map<string, Promise<void>>();
  private profileLookupAt = new Map<string, number>();
  // Own NIP-17 inbox + NIP-65 relays — wider than `this.relays`. Used to
  // subscribe for incoming DMs published to relays the user actually reads.
  private myDmRelays: string[] = [];

  async initialize(): Promise<void> {
    if (typeof window !== 'undefined') {
      const rawRelays = readMigrated(RELAYS_KEY, LEGACY_RELAYS_KEY);
      if (rawRelays) {
        try {
          const list = JSON.parse(rawRelays) as string[];
          if (Array.isArray(list) && list.length > 0) {
            const merged = uniqueRelayUrls(list);
            let mutated = merged.length !== list.length || merged.some((url, i) => url !== list[i]);
            for (const def of DEFAULT_RELAYS) {
              const normalizedDefault = normalizeRelayUrl(def);
              if (!merged.includes(normalizedDefault)) {
                merged.push(normalizedDefault);
                mutated = true;
              }
            }
            this.configuredRelays.set(merged);
            if (mutated) {
              window.localStorage.setItem(RELAYS_KEY, JSON.stringify(merged));
            }
          }
        } catch {
          // ignore
        }
      }
    }
    const raw = readMigrated(STORAGE_KEY, LEGACY_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as PersistedSession;
      parsed.relayUrl = normalizeRelayUrl(parsed.relayUrl);
      if (!isImportableRelayUrl(parsed.relayUrl)) parsed.relayUrl = DEFAULT_RELAY;
      this.session = parsed;
      this.wireBrowserConnectionEvents();
      this.currentRelayUrl.set(parsed.relayUrl);
      this.relays = [parsed.relayUrl];
      // Make sure the session relay is in the configured list.
      this.ensureRelayInList(parsed.relayUrl);
      // Seed admin/member StateStores from localStorage so the sidebar paints
      // last-known admin status instantly while the live REQ catches up.
      // Stale-while-revalidate: arriving relay events overwrite via the
      // newest-wins logic in ingestAdminMember.
      const hasRenderableCache = this.seedCacheForRelay(parsed.relayUrl);
      // For NIP-46 (bunker) sessions: pre-warm the BunkerSigner so the first
      // NIP-42 AUTH challenge from the relay doesn't trigger a cold
      // BunkerSigner.fromBunker + first RPC round-trip from inside
      // the auth-signing callback. Many relays time out the AUTH window
      // before the cold path completes, the REQ is dropped silently, the
      // watchdog retries, and the user sees the "needs 2-3 refreshes" bug.
      // Fire-and-forget on purpose: a flaky bunker relay must not block
      // chat render — the lazy fallback in getAuthSigner still works.
      if (parsed.loginMethod === 'bunker') {
        void this.ensureBunkerSigner()
          .then(() => this.bunkerSignerReady.set(true))
          .catch((err) => {
            console.warn(
              '[bridge] bunker pre-warm failed; will retry lazily on first AUTH',
              err,
            );
          });
      }
      // Order matters: connect() opens subscriptions, then we flip the gate.
      // If we set isLoggedIn=true first, AppShell mounts and fires per-group
      // REQs against an unauthenticated socket — relays drop them silently
      // and the user is left needing 2-3 manual refreshes. See finalizeLogin
      // and docs/data-system.md.
      try {
        await this.connect();
      } catch {
        // First connect attempt failed (relay unreachable, AUTH timeout,
        // etc.). Keep the session in memory and silently retry in the
        // background with capped exponential backoff so the user doesn't
        // have to refresh. If seedCacheForRelay found renderable channel
        // state, keep the cached shell mounted; otherwise leave the app
        // behind useIsRehydrating so a cache-free user never sees an empty
        // chat shell as the "successful" first paint.
        if (hasRenderableCache) {
          this.myPubkey.set(parsed.pubKeyHex);
          this.myLoginMethod.set(parsed.loginMethod);
          this.isLoggedIn.set(true);
        }
        void this.reconnectInBackground();
        return;
      }
      this.myPubkey.set(parsed.pubKeyHex);
      this.myLoginMethod.set(parsed.loginMethod);
      this.isLoggedIn.set(true);
      void this.syncOwnProfileToActiveRelay('login');
    } catch {
      // Corrupt storage: drop both the current and legacy session entries so
      // `useIsRehydrating` doesn't latch true forever on the next paint
      // (the LoginModal would never appear and the user would be locked out
      // looking at a permanent "Reconnecting…" screen).
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
  }

  private ensureRelayInList(url: string): void {
    const normalized = normalizeRelayUrl(url);
    const list = this.configuredRelays.get();
    if (list.includes(normalized)) return;
    const next = uniqueRelayUrls([...list, normalized]);
    this.configuredRelays.set(next);
    this.persistRelays();
  }

  private persistRelays(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(RELAYS_KEY, JSON.stringify(this.configuredRelays.get()));
  }

  private closeVoicePool(): void {
    const pool = this.voicePool;
    if (!pool) return;
    const relays = this.voicePoolRelays.size > 0 ? Array.from(this.voicePoolRelays) : this.relays;
    this.voicePool = null;
    this.voicePoolRefs = 0;
    this.voicePoolRelays.clear();
    try { pool.close(relays); } catch { /* ignore */ }
  }

  dispose(): void {
    this.unwireBrowserConnectionEvents();
    this.cancelReconnectTimer();
    this.reconnectInFlight = false;
    this.connectGeneration++;
    const pool = this.pool;
    const relays = [...this.relays];
    // Close REQs first, then close the socket on the next microtask so
    // nostr-tools can flush its queued CLOSE frames while it is still open.
    this.subs.forEach((s) => s.close());
    this.subs = [];
    this.dmSubHandles = [];
    if (this.poolSocketAlive) {
      queueMicrotask(() => {
        try { pool.close(relays); } catch { /* ignore */ }
      });
    }
    this.closeVoicePool();
    this.poolSocketAlive = false;
    // Clear auto-auth allow-list so the next session doesn't sign AUTH
    // for relays the previous user happened to subscribe to.
    this.authAllowedRelays.clear();
    // Drop debounced cache flushes — even though scheduleXxxCacheFlush is
    // session-gated, a flusher armed just before dispose would otherwise
    // fire after the pool is gone.
    this.clearAllCacheFlushers();
    this.querySyncFallbackFired.clear();
    this.clearActiveCallState();
    this.deletedEventIdsByGroup.clear();
    this.moderatedEventIdsByGroup.clear();
  }

  // -- Auth --------------------------------------------------------------

  async loginWithNsec(privKeyHex: string, pubKeyHex: string): Promise<void> {
    this.session = {
      privKeyHex,
      pubKeyHex,
      loginMethod: 'nsec',
      relayUrl: this.currentRelayUrl.get(),
    };
    await this.finalizeLogin();
  }

  async loginWithNip07(pubkeyHex: string): Promise<void> {
    if (typeof window === 'undefined' || !(window as any).nostr) {
      throw new Error('No NIP-07 browser extension detected');
    }
    this.session = {
      pubKeyHex: pubkeyHex,
      loginMethod: 'nip07',
      relayUrl: this.currentRelayUrl.get(),
    };
    await this.finalizeLogin();
  }

  /**
   * Seed in-memory admin/member stores from {@link cacheGet} for `relay`.
   *
   * Called by {@link initialize} (page reload) and {@link switchRelay} (relay
   * switch) so the sidebar paints last-known admin/member status instantly,
   * before the relay's response to the live REQ has arrived. The live event
   * (when it lands in {@link ingestAdminMember}) then overwrites the cache
   * value via the existing `created_at`-newest-wins logic.
   *
   * Relay-scoped: each relay has its own admin/member lists, so we only seed
   * for the active relay. Caches for other relays stay on disk untouched
   * (they re-paint instantly if the user switches back).
   */
  private seedCacheForRelay(relay: string): boolean {
    const ids = cacheListIdsByKind(relay, [
      KIND_GROUP_METADATA,
      KIND_GROUP_ADMINS,
      KIND_GROUP_MEMBERS,
      KIND_GROUP_CREATE,
      KIND_USER_METADATA,
      KIND_GROUP_MESSAGE,
      KIND_REACTION,
    ]);
    const idsFor = (kind: number) => ids.get(kind) ?? [];
    let hasRenderableCache = false;

    const cachedGroups: JsGroup[] = [];
    const cachedChildren: Record<string, string[]> = {};
    for (const groupId of idsFor(KIND_GROUP_METADATA)) {
      const entry = cacheGet<{ group: JsGroup; createdAt: number }>(relay, KIND_GROUP_METADATA, groupId);
      if (!entry) continue;
      const { group: cached, createdAt } = entry.value;
      const group: JsGroup = {
        ...cached,
        forumTags: cached.forumTags ?? [],
        topics: cached.topics ?? [],
      };
      this.groupMetadataLatestAt.set(
        groupId,
        Math.max(this.groupMetadataLatestAt.get(groupId) ?? 0, createdAt),
      );
      this.groupParentMap.set(groupId, group.parent ?? null);
      cachedGroups.push(group);
      hasRenderableCache = true;
      if (group.parent) (cachedChildren[group.parent] ??= []).push(groupId);
    }
    if (cachedGroups.length > 0) {
      this.groups.update((prev) => {
        const present = new Set(prev.map((group) => group.id));
        const added = cachedGroups.filter((group) => !present.has(group.id));
        return added.length === 0
          ? prev
          : [...prev, ...added].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
      });
      this.childrenByParent.update((prev) => {
        const next = { ...prev };
        for (const [parent, children] of Object.entries(cachedChildren)) {
          next[parent] = Array.from(new Set([...(prev[parent] ?? []), ...children])).sort();
        }
        return next;
      });
    }

    const cachedAdmins: Record<string, string[]> = {};
    const cachedMembers: Record<string, string[]> = {};
    for (const groupId of idsFor(KIND_GROUP_ADMINS)) {
      const entry = cacheGet<string[]>(relay, KIND_GROUP_ADMINS, groupId);
      if (entry) cachedAdmins[groupId] = entry.value;
    }
    for (const groupId of idsFor(KIND_GROUP_MEMBERS)) {
      const entry = cacheGet<string[]>(relay, KIND_GROUP_MEMBERS, groupId);
      if (entry) cachedMembers[groupId] = entry.value;
    }
    if (Object.keys(cachedAdmins).length > 0) {
      this.adminsByGroup.update((prev) => ({ ...cachedAdmins, ...prev }));
    }
    if (Object.keys(cachedMembers).length > 0) {
      this.membersByGroup.update((prev) => ({ ...cachedMembers, ...prev }));
    }
    const readyIds = [...Object.keys(cachedAdmins), ...Object.keys(cachedMembers)];
    if (readyIds.length > 0) {
      this.membershipReadyByGroup.update((prev) => {
        const next = { ...prev };
        for (const groupId of readyIds) next[groupId] = true;
        return next;
      });
    }

    const cachedCreators: Record<string, string> = {};
    for (const groupId of idsFor(KIND_GROUP_CREATE)) {
      const entry = cacheGet<string>(relay, KIND_GROUP_CREATE, groupId);
      if (entry) cachedCreators[groupId] = entry.value;
    }
    if (Object.keys(cachedCreators).length > 0) {
      this.groupCreators.update((prev) => ({ ...cachedCreators, ...prev }));
    }

    const cachedMetadata: Record<string, JsUserMetadata> = {};
    for (const pubkey of idsFor(KIND_USER_METADATA).slice(0, 500)) {
      const entry = cacheGet<{ meta: JsUserMetadata; createdAt: number }>(relay, KIND_USER_METADATA, pubkey);
      if (!entry) continue;
      const { meta, createdAt } = entry.value;
      if ((this.userMetadataLatestAt.get(pubkey) ?? 0) >= createdAt) continue;
      cachedMetadata[pubkey] = meta;
      this.userMetadataLatestAt.set(pubkey, createdAt);
    }
    if (Object.keys(cachedMetadata).length > 0) {
      this.userMetadata.update((prev) => ({ ...prev, ...cachedMetadata }));
    }

    const currentMessages = this.messagesByGroup.get();
    const cachedMessages: Record<string, JsMessage[]> = {};
    for (const groupId of idsFor(KIND_GROUP_MESSAGE)) {
      if ((currentMessages[groupId]?.length ?? 0) > 0) continue;
      const entry = cacheGet<JsMessage[]>(relay, KIND_GROUP_MESSAGE, groupId);
      if (!entry || entry.value.length === 0) continue;
      cachedMessages[groupId] = entry.value.map((message) => ({
        ...message,
        mentions: message.mentions ?? [],
        customEmojis: message.customEmojis ?? {},
      }));
      hasRenderableCache = true;
    }
    if (Object.keys(cachedMessages).length > 0) {
      this.messagesByGroup.update((prev) => {
        const next = { ...prev };
        for (const [groupId, messages] of Object.entries(cachedMessages)) {
          if ((prev[groupId]?.length ?? 0) === 0) next[groupId] = messages;
        }
        return next;
      });
      this.messagesStatusByGroup.update((prev) => {
        const next = { ...prev };
        for (const groupId of Object.keys(cachedMessages)) next[groupId] = "has-messages";
        return next;
      });
    }

    const cachedReactions: Record<string, Record<string, JsReaction[]>> = {};
    const currentReactions = this.reactionsByGroup.get();
    for (const groupId of idsFor(KIND_REACTION)) {
      if (currentReactions[groupId]) continue;
      const entry = cacheGet<Record<string, JsReaction[]>>(relay, KIND_REACTION, groupId);
      if (entry) cachedReactions[groupId] = entry.value;
    }
    if (Object.keys(cachedReactions).length > 0) {
      this.reactionsByGroup.update((prev) => ({ ...cachedReactions, ...prev }));
    }
    return hasRenderableCache;
  }

  private seedCachedMessagesForGroup(relay: string, groupId: string): boolean {
    const existing = this.messagesByGroup.get()[groupId];
    if (existing && existing.length > 0) {
      this.setMessagesStatus(groupId, 'has-messages');
      return true;
    }
    const entry = cacheGet<JsMessage[]>(relay, KIND_GROUP_MESSAGE, groupId);
    if (!entry || entry.value.length === 0) return false;
    // Backfill optional fields added after the cache was written so older
    // entries don't surface `undefined` for a now-required field.
    const msgs: JsMessage[] = entry.value.map((m) => ({
      ...m,
      mentions: m.mentions ?? [],
      customEmojis: m.customEmojis ?? {},
    }));
    this.messagesByGroup.update((prev) => {
      const cur = prev[groupId];
      if (cur && cur.length > 0) return prev;
      return { ...prev, [groupId]: msgs };
    });
    this.setMessagesStatus(groupId, 'has-messages');
    return true;
  }

  /**
   * Run the post-credential install sequence shared by all four login methods
   * (nsec, NIP-07, bunker URL, NostrConnect QR) and the page-reload rehydration
   * path in {@link initialize}.
   *
   * Order matters:
   *   1. `persist()` — write session to localStorage so a refresh during the
   *      connect handshake doesn't lose the credentials.
   *   2. `resetPoolForSessionChange()` — fresh sockets so NIP-42 AUTH
   *      renegotiates with the new key (see that method's JSDoc).
   *   3. `await connect()` — relay handshake + open the global subscriptions
   *      (group metadata, contact list, own profile). DM subscriptions open
   *      later only after the local DM opt-in is enabled. Resolves only
   *      once at least one relay has handshaken and the global REQs are
   *      issued. Throws on total failure.
   *   4. `isLoggedIn.set(true)` — flip the gate **last**. AppShell mounts
   *      with subscriptions already feeding store state, so there is no
   *      empty-sidebar flash and components never fire REQs into an
   *      unauthenticated socket.
   *
   * Pre-fix history: the old order set `isLoggedIn=true` *before* awaiting
   * `connect()`. AppShell rendered the chat UI immediately, components
   * subscribed to admin/member/messages while NIP-42 was still being
   * negotiated, the relay dropped those REQs silently, and the user had to
   * refresh 2-3 times for everything to populate. See
   * `docs/data-system.md`.
   */
  private async finalizeLogin(): Promise<void> {
    this.wireBrowserConnectionEvents();
    this.persist();
    this.resetPoolForSessionChange();
    // Pin `this.relays` to the session's relay before connect(). Without this,
    // any drift between `currentRelayUrl` (what the UI shows as active) and
    // `this.relays` (what subs subscribe against) would silently put kind
    // 39000 on the wrong relay — symptom is "I logged in, the rail shows
    // public.obelisk.ar selected, but no channels arrive until I switch and
    // come back" because switchRelay is the only path that hard-resets
    // `this.relays = [url]`.
    const sessionRelay = this.currentRelayUrl.get();
    this.relays = [sessionRelay];
    // Paint cached groups/admins/members for `sessionRelay` instantly. On a
    // first login (cache empty after cacheClearAll on the prior logout, or
    // on a fresh device) this is a no-op and the live REQ fills the sidebar.
    // On re-login within the same browser session it gives the same instant
    // first paint that switchRelay does, so "fresh login" and "switch to
    // this relay" produce identical UX.
    this.seedCacheForRelay(sessionRelay);
    await this.connect();
    this.myPubkey.set(this.session?.pubKeyHex ?? null);
    this.myLoginMethod.set(this.session?.loginMethod ?? null);
    this.isLoggedIn.set(true);
    void this.syncOwnProfileToActiveRelay('login');
  }

  /**
   * Tear down sockets and rebuild the pool when the session changes.
   * SimplePool resolves `automaticallyAuth(relayUrl)` per challenge, but the
   * underlying Relay caches AUTH-handshake state on the open socket. If the
   * pool was opened earlier without a session, the relay can settle into a
   * no-auth state and silently filter out auth-required reads — symptom is
   * "channels load but messages inside don't". A fresh socket forces a new
   * AUTH round-trip with the just-installed session.
   */
  private resetPoolForSessionChange(): void {
    this.closeVoicePool();
    const previousPool = this.pool;
    const previousRelays = [...this.relays];
    const shouldClosePool = this.poolSocketAlive;
    this.connectGeneration++;
    // Capture the per-group REQs that were live on the old pool so connect()
    // can reopen them on the new one. Without this, components mounted before
    // login keep their store listeners but have nothing feeding them.
    this.pendingResubscribe = {
      messages: Array.from(this.messageSubscribedGroups),
      reactions: Array.from(this.reactionSubscribedGroups),
      adminMember: Array.from(this.adminMemberSubscribedGroups),
      metadata: Array.from(this.metadataRequested),
    };
    // Close REQs while the old socket is still open; the pool closes on the
    // next microtask after nostr-tools flushes those queued CLOSE frames.
    this.subs.forEach((s) => s.close());
    this.subs = [];
    this.dmSubHandles = [];
    this.poolSocketAlive = false;
    if (shouldClosePool) {
      queueMicrotask(() => {
        try { previousPool.close(previousRelays); } catch { /* ignore */ }
      });
    }
    this.pool = this.createPool();
    this.messageSubscribedGroups.clear();
    this.messageSubByGroup.clear();
    this.reactionSubscribedGroups.clear();
    this.reactionSubByGroup.clear();
    this.eventDeletionSubscribedGroups.clear();
    this.eventDeletionSubByGroup.clear();
    this.groupModerationDeletionSubscribedGroups.clear();
    this.groupModerationDeletionSubByGroup.clear();
    this.adminMemberSubscribedGroups.clear();
    this.adminMemberSubByGroup.clear();
    this.adminMemberLatestAt.clear();
    this.metadataRequested.clear();
    // The new pool's per-group REQs haven't been issued yet — drop any
    // EOSE bits captured from the old pool so the chat pane shows its
    // loading spinner until the resub completes (see `pendingResubscribe`
    // handling in `connect()`).
    this.messagesStatusByGroup.set({});
    this.clearAllMessagesRetry();
    // Drop the background queue: it's tied to the dead pool's filters
    // and the new pool will receive a fresh kind 39000 fan-out which
    // will repopulate it.
    this.pendingMessageQueue = [];
    this.pendingMessageSet.clear();
    if (this.pendingMessageTimer) {
      clearTimeout(this.pendingMessageTimer);
      this.pendingMessageTimer = null;
    }
    if (this.activeGroupPriorityTimer) {
      clearTimeout(this.activeGroupPriorityTimer);
      this.activeGroupPriorityTimer = null;
    }
    this.activeGroupPriorityDeadline = 0;
    // Cancel any debounced cache flushes that were armed against the dead
    // pool's `currentRelayUrl` — the new pool may target a different relay,
    // and a stale flush would write under the wrong key. The next ingest
    // re-arms flushers cleanly.
    this.clearAllCacheFlushers();
    this.querySyncFallbackFired.clear();
    // Re-login on the same browser keeps the in-memory bridge instance, so
    // the kind 39000 newest-wins guard retains every `groupId → created_at`
    // pair from the previous session. Kind 39000 is replaceable: the new
    // session's REQ delivers the SAME events with the SAME created_at the
    // guard just memorized, and `if (ev.created_at <= prevAt) return;` drops
    // every one of them — the sidebar stays empty until the user toggles
    // relays (switchRelay clears the Map) or refreshes (fresh bridge
    // instance). Same reason `creatorSubscribedGroups` must reset: its
    // entries are tied to the dead pool's per-group kind 9007 subs, so the
    // guard short-circuits `subscribeGroupCreator` and the new pool never
    // re-opens them.
    this.groupMetadataLatestAt.clear();
    this.creatorSubscribedGroups.clear();
    this.creatorSubByGroup.clear();
    // Clear the per-group readiness flags too — the new pool has not seen
    // 39001/39002 yet, so consumers must wait for fresh evidence before
    // deciding "not a member".
    this.membershipReadyByGroup.set({});
    // Reset the kind 39000 EOSE flag so the empty-state UI shows
    // "Channels loading…" while the new pool's REQ is in flight, not the
    // stale "No channels found" / "Whitelisting required" text computed off
    // a previous session's EOSE. switchRelay already does this; without it
    // here, fresh login or background reconnect could paint the wrong
    // empty-state copy in the gap before the new EOSE arrives.
    this.groupMetadataEose.set(false);
    this.clearGroupMetadataEmptyRetry();
    this.dmSubscribed = false;
    this.dmSubHandles = [];
    // Forget any auth/whitelist signal we'd captured against the previous
    // pool — the next REQ on the fresh sockets must re-prove access.
    this.relayAccess.set({});
    // Drop any pending deferred banner downgrades from the old pool — the
    // new socket starts at 'unknown' and must earn its own state.
    for (const t of this.deferredAccessDowngrades.values()) clearTimeout(t);
    this.deferredAccessDowngrades.clear();
    // Stale "Authenticating with {host}" entries from the old pool are no
    // longer load-bearing — the new pool will push its own entries on first
    // AUTH challenge. Dismiss rather than fail so we don't flash an error
    // toast on legitimate reconnects.
    for (const id of this.authActivityIds.values()) dismissActivity(id);
    this.authActivityIds.clear();
  }

  /**
   * NIP-46 login from a `bunker://` URL.
   * The local client secret is generated fresh per login and persisted in
   * localStorage so the signer can be rehydrated on page reload.
   */
  async loginWithBunker(
    bunkerUrl: string,
    options?: { onAuthUrl?: (url: string) => void; clientSecretHex?: string },
  ): Promise<string> {
    const bp = await parseBunkerInput(bunkerUrl);
    if (!bp) throw new Error('Invalid bunker URL');
    // When a host pre-paired the remote signer (e.g. the @nostr-wot/ui
    // QR / paste flow), it must hand us the SAME client secret it paired
    // with — otherwise the bunker rejects our connect request because
    // this client pubkey was never authorized. Falling back to a fresh
    // key is correct when we *are* the pairing party.
    const pairedByHost = Boolean(options?.clientSecretHex);
    const localSecret = options?.clientSecretHex
      ? hexToBytes(options.clientSecretHex)
      : generateSecretKey();
    this.bunkerOnAuth = options?.onAuthUrl ?? null;
    const signer = BunkerSigner.fromBunker(localSecret, bp, {
      onauth: (url) => {
        if (this.bunkerOnAuth) this.bunkerOnAuth(url);
        else if (typeof window !== 'undefined') window.open(url, '_blank', 'width=600,height=700');
      },
    });
    const connectId = pushActivity('Connecting to bunker', 'waiting for remote signer');
    let pubKeyHex: string;
    try {
      // If the SDK hands us a client secret, it already completed the
      // NostrConnect/bunker pairing with that client identity. Re-running
      // `connect()` here can send an empty/mismatched secret for QR-created
      // bunker URLs and make remote signers reject with "no secret".
      if (!pairedByHost) await signer.connect();
      pubKeyHex = await signer.getPublicKey();
    } catch (e) {
      failActivity(connectId, e instanceof Error ? e.message : String(e));
      throw e;
    }
    resolveActivity(connectId);
    this.bunkerSigner = signer;
    this.session = {
      pubKeyHex,
      loginMethod: 'bunker',
      relayUrl: this.currentRelayUrl.get(),
      bunkerUrl,
      bunkerLocalSecretHex: bytesToHex(localSecret),
    };
    this.bunkerSignerReady.set(true);
    await this.finalizeLogin();
    return pubKeyHex;
  }

  /**
   * NIP-46 NostrConnect (QR) flow — generates a `nostrconnect://` URI for the
   * remote signer to scan. Caller is expected to render the URI as a QR code
   * and `await waitForConnection()` to resolve once the signer connects.
   */
  createNostrConnectSession(options?: { relay?: string; onAuthUrl?: (url: string) => void }): {
    uri: string;
    waitForConnection: () => Promise<string>;
    cancel: () => void;
  } {
    const localSecret = generateSecretKey();
    const localPubkey = getPublicKey(localSecret);
    const connectRelay = options?.relay || NOSTRCONNECT_RELAYS[0];
    const uri = createNostrConnectURI({
      clientPubkey: localPubkey,
      relays: [connectRelay, ...NOSTRCONNECT_RELAYS],
      secret: Math.random().toString(36).substring(2, 15),
      name: 'Obelisk',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://obelisk.ar',
    });

    let cancelled = false;
    const scanId = pushActivity('Waiting for QR scan', 'open your Nostr signer to approve');
    const waitForConnection = async (): Promise<string> => {
      this.bunkerOnAuth = options?.onAuthUrl ?? null;
      let signer;
      try {
        signer = await BunkerSigner.fromURI(localSecret, uri, {
          onauth: (url) => {
            if (this.bunkerOnAuth) this.bunkerOnAuth(url);
          },
        }, 60000);
      } catch (e) {
        failActivity(scanId, e instanceof Error ? e.message : String(e));
        throw e;
      }
      resolveActivity(scanId, 'signer connected');
      if (cancelled) {
        try { signer.close(); } catch { /* ignore */ }
        throw new Error('NostrConnect cancelled');
      }
      const pubKeyHex = await signer.getPublicKey();
      // Reconstruct a bunker:// URL from the signer's resolved BunkerPointer
      // so we can persist + rehydrate later.
      const bp = (signer as unknown as { bp: { pubkey: string; relays: string[]; secret?: string } }).bp;
      const params = new URLSearchParams();
      bp.relays.forEach((r) => params.append('relay', r));
      if (bp.secret) params.set('secret', bp.secret);
      const bunkerUrl = `bunker://${bp.pubkey}?${params.toString()}`;
      this.bunkerSigner = signer;
      this.session = {
        pubKeyHex,
        loginMethod: 'bunker',
        relayUrl: this.currentRelayUrl.get(),
        bunkerUrl,
        bunkerLocalSecretHex: bytesToHex(localSecret),
      };
      this.bunkerSignerReady.set(true);
      await this.finalizeLogin();
      return pubKeyHex;
    };

    return {
      uri,
      waitForConnection,
      cancel: () => { cancelled = true; failActivity(scanId, 'cancelled'); },
    };
  }

  /**
   * Lazily (re)construct the active BunkerSigner from the persisted session.
   *
   * Contract:
   *   - On a fresh login (`loginWithBunker` / `createNostrConnectSession`),
   *     the signer is constructed and connected eagerly before this method is
   *     ever consulted; `this.bunkerSigner` is already set.
   *   - On page reload, `initialize()` pre-warms by calling this method once
   *     fire-and-forget. After it resolves, subsequent NIP-42 AUTH callbacks
   *     hit the cached signer instantly.
   *   - If pre-warm failed (bunker relay down) or `initialize` hasn't run yet,
   *     the first NIP-42 AUTH triggers this lazy path: parse bunker URL,
   *     reconstruct localSecret, build BunkerSigner, warm the RPC channel,
   *     then sign. This adds 1-3s of latency but is the fallback of last
   *     resort.
   */
  private async ensureBunkerSigner(): Promise<BunkerSigner> {
    if (this.bunkerSigner) return this.bunkerSigner;
    if (!this.session || this.session.loginMethod !== 'bunker' || !this.session.bunkerUrl || !this.session.bunkerLocalSecretHex) {
      throw new Error('No bunker session to rehydrate');
    }
    const bp = await parseBunkerInput(this.session.bunkerUrl);
    if (!bp) throw new Error('Invalid stored bunker URL');
    const localSecret = hexToBytes(this.session.bunkerLocalSecretHex);
    const signer = BunkerSigner.fromBunker(localSecret, bp, {
      onauth: (url) => {
        if (this.bunkerOnAuth) this.bunkerOnAuth(url);
        else if (typeof window !== 'undefined') window.open(url, '_blank', 'width=600,height=700');
      },
    });
    if (bp.secret) {
      await signer.connect();
    } else {
      // SDK QR logins persist a bunker URL synthesized from the paired signer
      // and relays; the original nostrconnect secret is not recoverable from
      // the SDK's public API. The client secret is the durable authorization,
      // so warm the RPC channel with get_public_key instead of sending a
      // bogus connect request with an empty secret.
      await signer.getPublicKey();
    }
    this.bunkerSigner = signer;
    this.bunkerSignerReady.set(true);
    return signer;
  }

  async logout(): Promise<void> {
    if (this.bunkerSigner) {
      try { this.bunkerSigner.close(); } catch { /* ignore */ }
      this.bunkerSigner = null;
    }
    this.session = null;
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      // Wipe relay-scoped caches so the next identity doesn't paint with
      // the previous one's admin/member lists. See cache.ts.
      cacheClearAll();
    }
    this.dispose();
    this.pool = this.createPool();
    this.isLoggedIn.set(false);
    this.bunkerSignerReady.set(false);
    this.myPubkey.set(null);
    this.myLoginMethod.set(null);
    this.connectionState.set('Disconnected');
    this.groups.set([]);
    this.groupMetadataEose.set(false);
    this.clearGroupMetadataEmptyRetry();
    this.messagesByGroup.set({});
    this.pendingGroupSends.clear();
    this.pendingDMSends.clear();
    this.adminsByGroup.set({});
    this.membersByGroup.set({});
    this.membershipReadyByGroup.set({});
    this.messagesStatusByGroup.set({});
    this.clearAllMessagesRetry();
    this.clearActiveCallState();
    // Drop the background message-subscription queue too — pending work
    // is scoped to the previous session's authored REQs.
    this.pendingMessageQueue = [];
    this.pendingMessageSet.clear();
    if (this.pendingMessageTimer) {
      clearTimeout(this.pendingMessageTimer);
      this.pendingMessageTimer = null;
    }
    if (this.activeGroupPriorityTimer) {
      clearTimeout(this.activeGroupPriorityTimer);
      this.activeGroupPriorityTimer = null;
    }
    this.activeGroupPriorityDeadline = 0;
    this.activeGroupId = null;
    // Cancel pending cache flushes. The next session's relay scope may
    // differ; let fresh ingests re-arm flushers from scratch.
    this.clearAllCacheFlushers();
    this.querySyncFallbackFired.clear();
    // Forget any in-flight relay-access state and tear down dangling
    // "Authenticating with {host}" entries — the next session must
    // re-prove access from scratch.
    this.relayAccess.set({});
    for (const t of this.deferredAccessDowngrades.values()) clearTimeout(t);
    this.deferredAccessDowngrades.clear();
    for (const id of this.authActivityIds.values()) dismissActivity(id);
    this.authActivityIds.clear();
    // Clear chat / notification / voice / DM stores so the next user logging
    // in on this browser doesn't inherit the previous account's data. See
    // src/lib/reset.ts for the full enumeration.
    resetAllClientState();
  }

  getPublicKey(): string | null {
    return this.session?.pubKeyHex ?? null;
  }

  // -- Connection --------------------------------------------------------

  async connect(): Promise<void> {
    if (this.isBrowserOffline()) {
      this.connectionState.set("Offline");
      throw new Error("browser offline");
    }
    const generation = ++this.connectGeneration;
    const relaySnapshot = [...this.relays];
    this.connectionState.set('Connecting');
    const activityId = pushActivity(
      'Connecting to relays',
      this.relays.length === 1 ? this.relays[0] : String(this.relays.length) + " relays",
      { operation: 'connect' },
    );
    pushRelayDebug({ kind: 'connect-start', relays: relaySnapshot });
    try {
      // SimplePool.subscribe is lazy and synchronous — it doesn't wait for
      // the WebSocket handshake, so previously every relay (even bogus
      // ones) appeared "Connected" instantly. ensureRelay actually awaits
      // the handshake and rejects on timeout / refused / DNS failure.
      //
      // First-response wins: resolve as soon as ONE relay handshakes. Slower
      // relays continue handshaking in the background; their subscriptions
      // queue on the pool and fire as each socket comes online. If every
      // relay rejects, we throw and `initialize()` falls through to background
      // reconnect with capped backoff.
      //
      // Per-relay `connectionTimeout` is intentionally tighter than the
      // 5000 ms used previously — a single slow relay used to stall the
      // entire login by holding `Promise.allSettled` open. First-response
      // wins keeps successful relays fast, while this cap gets stragglers
      // marked `unreachable` promptly. Do not run the subscription fan-out
      // before the first successful handshake: on an empty cache that mounts
      // the app shell with REQs queued against a not-yet-ready pool, that
      // reproduces the "refresh twice before content appears" cold-load
      // failure.
      const PER_RELAY_TIMEOUT_MS = 3000;
      const handles = relaySnapshot.map((url) =>
        (async () => {
          validateRelayUrl(url);
          pushRelayDebug({ kind: 'handshake-start', relay: url });
          const relay = await this.pool.ensureRelay(url, { connectionTimeout: PER_RELAY_TIMEOUT_MS });
          if (!relay.connected) throw new Error("relay " + url + " did not complete handshake");
          pushRelayDebug({ kind: 'handshake-ok', relay: url });
          // Mark the pool's socket alive so subsequent close() calls
          // attempt the network CLOSE; cleared in the onclose handler.
          this.poolSocketAlive = true;
          // Flip status back if the socket drops later, and trigger a
          // silent background reconnect so the user doesn't have to
          // refresh when the relay or network blips.
          relay.onclose = () => {
            this.poolSocketAlive = false;
            if (generation === this.connectGeneration && this.relays.includes(url) && this.session) {
              this.connectionState.set(this.isBrowserOffline() ? "Offline" : "Disconnected");
              // Don't override sticky-OK on transient drops — a brief socket
              // bounce shouldn't flash "Cannot reach". connectionState
              // already surfaces the reconnect attempt.
              this.setRelayAccess(url, 'unreachable');
              this.reconnectInBackground();
            }
          };
          return url;
        })(),
      );
      // Mark each relay `unreachable` as its handshake fails, in the
      // background. Doesn't await — banner updates as we get news; the UI
      // proceeds only after the first successful handshake.
      handles.forEach((p, i) => {
        const url = relaySnapshot[i];
        p.catch((e) => {
          if (generation !== this.connectGeneration) return;
          pushRelayDebug({ kind: 'handshake-error', relay: url, reason: e instanceof Error ? e.message : String(e) });
          this.setRelayAccess(url, 'unreachable');
        });
      });
      try {
        await Promise.any(handles);
      } catch {
        throw new Error('no relays connected');
      }
      // The standard relay path is authoritative and must not wait behind
      // optional HTTP bootstrap discovery/signing.
      this.preflightRelayAccess();
      this.subscribeGroupMetadata();
      // Reopen any per-group REQs that were live on the previous pool.
      // Components that mounted pre-login (or pre-relay-switch) still have
      // their store listeners wired up; without this re-issue the new pool
      // has no subscriptions feeding them and the data only appears after
      // a manual refresh. Reapply them after the global subscriptions open.
      const pending = this.pendingResubscribe;
      this.pendingResubscribe = null;
      if (this.session) this.ensureUserMetadata(this.session.pubKeyHex);
      queueMicrotask(() => {
        this.subscribeAllAdminMember();
        this.subscribeMyMuteList();
        this.subscribeMyAuthoredGroups();
        this.subscribeActiveCalls();
        this.applyPendingResubscribe(pending);
      });
      this.connectionState.set('Connected');
      this.cancelReconnectTimer();
      this.reconnectAttempt = 0;
      // Activity message reflects the snapshot at the moment the gate
      // flipped, not the final count — slower relays may still be
      // handshaking. Approximate by resolving "1+/N" rather than tracking
      // the exact count, which would require awaiting all handles.
      resolveActivity(activityId, `connected to ${relaySnapshot.length === 1 ? relaySnapshot[0] : `${relaySnapshot.length} relays`}`);
    } catch (e: unknown) {
      this.connectionState.set(this.isBrowserOffline() ? "Offline" : "Error:" + (e as Error).message);
      failActivity(activityId, (e as Error).message);
      throw e;
    }
  }

  /**
   * Retry `connect()` silently in the background with capped exponential
   * backoff. Used when the initial rehydrate connect fails or a relay socket
   * drops after login — we keep the chat UI mounted (with cached state from
   * seedCacheForRelay) and heal the connection without forcing the user to
   * refresh. Idempotent: a second call while one is already pending is a
   * no-op.
   */
  private reconnectAttempt = 0;
  private reconnectInFlight = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectGeneration = 0;

  private cancelReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private retryConnectionNow(): void {
    if (!this.session) return;
    if (this.isBrowserOffline()) {
      this.connectionState.set("Offline");
      return;
    }
    this.cancelReconnectTimer();
    this.reconnectInBackground();
  }

  private reconnectInBackground(): void {
    if (!this.session || this.reconnectInFlight || this.reconnectTimer) return;
    if (this.isBrowserOffline()) {
      this.connectionState.set("Offline");
      return;
    }
    this.reconnectInFlight = true;
    this.reconnectAttempt++;
    void (async () => {
      try {
        this.resetPoolForSessionChange();
        await this.connect();
        if (this.session) {
          this.myPubkey.set(this.session.pubKeyHex);
          this.myLoginMethod.set(this.session.loginMethod);
          this.isLoggedIn.set(true);
        }
        this.reconnectAttempt = 0;
      } catch {
        if (!this.session) return;
        if (this.isBrowserOffline()) {
          this.reconnectAttempt = 0;
          this.connectionState.set("Offline");
          return;
        }
        const base = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), 30_000);
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.reconnectInBackground();
        }, delay);
      } finally {
        this.reconnectInFlight = false;
      }
    })();
  }

  async switchRelay(url: string): Promise<void> {
    this.cancelReconnectTimer();
    const normalized = normalizeRelayUrl(url);
    validateRelayUrl(normalized);
    if (!isImportableRelayUrl(normalized)) throw new Error("relay URL must be a public wss:// hostname");
    const previousPool = this.pool;
    const previousRelays = [...this.relays];
    const shouldClosePool = this.poolSocketAlive;
    this.connectGeneration++;
    // Preserve only the mounted channel. Background subscriptions belong to
    // the old relay and reopening them here can exhaust the new relay quota.
    const activeGroup = this.activeGroupId;
    this.pendingResubscribe = activeGroup ? {
      messages: [activeGroup],
      reactions: this.reactionSubscribedGroups.has(activeGroup) ? [activeGroup] : [],
      adminMember: this.adminMemberSubscribedGroups.has(activeGroup) ? [activeGroup] : [],
      metadata: [],
    } : null;
    this.subs.forEach((s) => s.close());
    this.subs = [];
    this.dmSubHandles = [];
    this.poolSocketAlive = false;
    if (shouldClosePool) {
      queueMicrotask(() => {
        try { previousPool.close(previousRelays); } catch { /* ignore */ }
      });
    }
    this.pool = this.createPool();
    this.relays = [normalized];
    this.currentRelayUrl.set(normalized);
    this.ensureRelayInList(normalized);
    if (this.session) this.session.relayUrl = normalized;
    this.persist();
    this.groups.set([]);
    this.messagesByGroup.set({});
    this.pendingGroupSends.clear();
    // `dmsByPeer` is not reset on a relay switch (DMs follow the user across
    // relays via NIP-65), so `pendingDMSends` is left intact too — a DM in
    // flight when the user pivots to a new relay can still finish there.
    // Reset per-group caches: they're scoped to one relay.
    this.messageSubscribedGroups.clear();
    this.messageSubByGroup.clear();
    this.reactionSubscribedGroups.clear();
    this.reactionSubByGroup.clear();
    this.eventDeletionSubscribedGroups.clear();
    this.eventDeletionSubByGroup.clear();
    this.groupModerationDeletionSubscribedGroups.clear();
    this.groupModerationDeletionSubByGroup.clear();
    this.adminMemberSubscribedGroups.clear();
    this.adminMemberSubByGroup.clear();
    this.adminMemberLatestAt.clear();
    this.metadataRequested.clear();
    this.adminsByGroup.set({});
    this.membersByGroup.set({});
    // Reset readiness too — the new relay hasn't delivered evidence yet.
    // Without this, voice gates and member rails would still be marked
    // "loaded" from the previous relay's data.
    this.membershipReadyByGroup.set({});
    // Same reset as logout: the new relay hasn't delivered EOSE for any
    // per-group kind 9 REQ yet, so the message pane should show its
    // loading spinner rather than the cached "ok, empty" state.
    this.messagesStatusByGroup.set({});
    this.clearAllMessagesRetry();
    this.clearActiveCallState();
    // Drop background queue — pending entries point at filters bound to
    // the old pool. The new relay's kind 39000 fan-out will repopulate.
    this.pendingMessageQueue = [];
    this.pendingMessageSet.clear();
    if (this.pendingMessageTimer) {
      clearTimeout(this.pendingMessageTimer);
      this.pendingMessageTimer = null;
    }
    if (this.activeGroupPriorityTimer) {
      clearTimeout(this.activeGroupPriorityTimer);
      this.activeGroupPriorityTimer = null;
    }
    this.activeGroupPriorityDeadline = 0;
    // Discard pending message/reaction cache flushes — they were armed
    // against the old relay URL. The seed for the new relay paints any
    // previously-cached entries; fresh ingests rebuild the on-disk state
    // for the new relay scope.
    this.clearAllCacheFlushers();
    this.querySyncFallbackFired.clear();
    // Per-relay state that previously bled across switches: parent→children
    // index, group-creator map, reactions, the newest-wins guard cursor for
    // group metadata, and the per-group creator-sub set. Without clearing
    // these, switching from relay A → B kept A's category nesting visible,
    // dropped legitimate B-side metadata events whose `created_at` happened
    // to be older than A's (the same NIP-29 `d`-tag can exist on two relays
    // independently), and left A's reactions painted on B's messages. The
    // user-visible symptom was channels and structure from different relays
    // appearing mixed. See docs/data-system.md.
    this.childrenByParent.set({});
    this.groupParentMap.clear();
    this.groupCreators.set({});
    this.reactionsByGroup.set({});
    this.deletedEventIdsByGroup.clear();
    this.moderatedEventIdsByGroup.clear();
    this.groupMetadataLatestAt.clear();
    this.creatorSubscribedGroups.clear();
    this.creatorSubByGroup.clear();
    this.groupMetadataEose.set(false);
    this.clearGroupMetadataEmptyRetry();
    this.dmSubscribed = false;
    this.dmSubHandles = [];
    // Auth/whitelist state is per-relay; the new one hasn't been probed yet.
    this.relayAccess.set({});
    // Drop any pending downgrade timers + auth-activity entries scoped to
    // the previous relay so a stale "Authenticating with old-host" toast
    // doesn't linger after the user has already moved on.
    for (const t of this.deferredAccessDowngrades.values()) clearTimeout(t);
    this.deferredAccessDowngrades.clear();
    for (const id of this.authActivityIds.values()) dismissActivity(id);
    this.authActivityIds.clear();
    // Re-paint instantly from disk for the new relay; live events will
    // overwrite as they arrive. See {@link seedCacheForRelay}.
    this.seedCacheForRelay(normalized);
    try {
      await this.connect();
      void this.syncOwnProfileToActiveRelay('switch');
    } catch {
      void this.reconnectInBackground();
    }
  }

  async addRelay(url: string): Promise<void> {
    const trimmed = normalizeRelayUrl(url);
    if (!trimmed) return;
    validateRelayUrl(trimmed);
    if (!isImportableRelayUrl(trimmed)) throw new Error("relay URL must be a public wss:// hostname");
    // Register in the rail only — do NOT push into `this.relays` (the active
    // subscription set). NIP-29 channels are per-relay, so subscribing to
    // multiple relays simultaneously mixes channels from different servers
    // into the same `this.groups` store and the "Uncategorized" bucket.
    // `switchRelay(url)` is the single path that activates a relay; the rail
    // tile click-handler calls it explicitly. Without this scoping, a
    // background reconnect (`reconnectInBackground` → `connect()`) would
    // subscribe kind 39000 against every relay the user had ever added.
    this.ensureRelayInList(trimmed);
  }

  async removeRelay(url: string): Promise<void> {
    const normalized = normalizeRelayUrl(url);
    const list = this.configuredRelays.get().filter((u) => normalizeRelayUrl(u) !== normalized);
    if (list.length === 0) return; // never empty the rail
    this.configuredRelays.set(list);
    this.persistRelays();
    if (normalizeRelayUrl(this.currentRelayUrl.get()) === normalized) {
      await this.switchRelay(list[0]);
    }
  }

  subscribeConfiguredRelays(cb: (urls: ReadonlyArray<string>) => void): Unsubscribe {
    return this.configuredRelays.subscribe(cb);
  }

  // -- Subscriptions -----------------------------------------------------

  subscribeIsLoggedIn(cb: (v: boolean) => void): Unsubscribe {
    return this.isLoggedIn.subscribe(cb);
  }
  subscribeRelayAccess(cb: (byRelay: Readonly<Record<string, RelayAccessState>>) => void): Unsubscribe {
    return this.relayAccess.subscribe(cb);
  }

  /**
   * Resolve once the **current** relay reports `'ok'` (NIP-42 AUTH
   * completed and the first read succeeded), or after `timeoutMs`
   * elapses. The mesh voice transport awaits this before publishing
   * the first beacon so the bringup burst doesn't fire into a
   * still-handshaking socket. Always resolves — never rejects — so
   * callers can `.catch(() => null)` without special-casing the
   * timeout path.
   *
   * Returns `'ok'` on success, `'timeout'` on deadline, or whatever
   * non-ok state the relay landed on if the deadline elapses while
   * the relay is in a terminal state like `'auth-required'` or
   * `'restricted'`.
   */
  waitForRelayAuth(timeoutMs: number): Promise<'ok' | 'timeout' | RelayAccessState> {
    return new Promise((resolve) => {
      const currentKey = () => normalizeRelayUrl(this.currentRelayUrl.get());
      const initial = this.relayAccess.get()[currentKey()];
      if (initial === 'ok') return resolve('ok');
      let unsub: Unsubscribe | null = null;
      const timer = setTimeout(() => {
        if (unsub) unsub();
        const cur = this.relayAccess.get()[currentKey()];
        resolve(cur === 'ok' ? 'ok' : (cur ?? 'timeout'));
      }, timeoutMs);
      unsub = this.relayAccess.subscribe((byRelay) => {
        const state = byRelay[currentKey()];
        if (state === 'ok') {
          clearTimeout(timer);
          if (unsub) unsub();
          resolve('ok');
        }
      });
    });
  }

  reserveVoiceRelayCapacity(channelId: string): Unsubscribe {
    this.voiceRelayCapacityReservations += 1;
    this.trimBackgroundSubscriptionsForVoice(channelId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.voiceRelayCapacityReservations = Math.max(0, this.voiceRelayCapacityReservations - 1);
    };
  }

  subscribeConnectionState(cb: (label: string) => void): Unsubscribe {
    return this.connectionState.subscribe(cb);
  }
  subscribeCurrentRelayUrl(cb: (url: string) => void): Unsubscribe {
    return this.currentRelayUrl.subscribe(cb);
  }
  subscribeMyPubkey(cb: (pubkey: string | null) => void): Unsubscribe {
    return this.myPubkey.subscribe(cb);
  }
  subscribeMyLoginMethod(cb: (m: 'nsec' | 'nip07' | 'bunker' | null) => void): Unsubscribe {
    return this.myLoginMethod.subscribe(cb);
  }
  subscribeBunkerSignerReady(cb: (ready: boolean) => void): Unsubscribe {
    return this.bunkerSignerReady.subscribe(cb);
  }
  subscribeGroups(cb: (groups: ReadonlyArray<JsGroup>) => void): Unsubscribe {
    return this.groups.subscribe(cb);
  }
  subscribeGroupMetadataEose(cb: (eose: boolean) => void): Unsubscribe {
    return this.groupMetadataEose.subscribe(cb);
  }
  subscribeMessages(groupId: string, cb: (msgs: ReadonlyArray<JsMessage>) => void): Unsubscribe {
    // Belt-and-braces: messages start streaming as soon as group metadata
    // arrives (see ingestGroupMetadata). This call is idempotent and only
    // matters for groups the user opens via deep link before metadata lands.
    this.subscribeGroupMessages(groupId);
    const adapter: Listener<Record<string, JsMessage[]>> = (byGroup) => cb(byGroup[groupId] ?? []);
    return this.messagesByGroup.subscribe(adapter);
  }
  subscribeMessagesByGroup(
    cb: (byGroup: Readonly<Record<string, ReadonlyArray<JsMessage>>>) => void,
  ): Unsubscribe {
    return this.messagesByGroup.subscribe(cb);
  }
  /**
   * Per-group confidence enum for the kind 9 messages stream. The chat
   * pane reads this to decide between "Loading messages…" and
   * "No messages yet". See {@link MessagesStatus} for transitions.
   * Subscribing also fast-tracks the underlying REQ, matching
   * {@link subscribeMessagesEose}'s behavior.
   */
  subscribeMessagesStatus(
    groupId: string,
    cb: (status: MessagesStatus) => void,
  ): Unsubscribe {
    this.subscribeGroupMessages(groupId);
    const adapter: Listener<Record<string, MessagesStatus>> = (m) => cb(m[groupId] ?? 'loading');
    return this.messagesStatusByGroup.subscribe(adapter);
  }
  subscribeUserMetadata(pubkey: string, cb: (meta: JsUserMetadata | null) => void): Unsubscribe {
    this.ensureUserMetadata(pubkey);
    const adapter: Listener<Record<string, JsUserMetadata>> = (m) => cb(m[pubkey] ?? null);
    return this.userMetadata.subscribe(adapter);
  }
  subscribeUserMetadataMap(cb: (meta: Readonly<Record<string, JsUserMetadata>>) => void): Unsubscribe {
    return this.userMetadata.subscribe(cb);
  }

  subscribeReactions(
    groupId: string,
    cb: (byTarget: Readonly<Record<string, ReadonlyArray<JsReaction>>>) => void,
  ): Unsubscribe {
    this.subscribeGroupReactions(groupId);
    const adapter: Listener<Record<string, Record<string, JsReaction[]>>> = (all) =>
      cb(all[groupId] ?? {});
    return this.reactionsByGroup.subscribe(adapter);
  }

  subscribeChildrenByParent(
    cb: (byParent: Readonly<Record<string, ReadonlyArray<string>>>) => void,
  ): Unsubscribe {
    return this.childrenByParent.subscribe(cb);
  }

  subscribeDirectMessages(
    cb: (byPeer: Readonly<Record<string, ReadonlyArray<JsDirectMessage>>>) => void,
  ): Unsubscribe {
    if (!getPreferences().directMessagesEnabled) {
      cb({});
      return () => {};
    }
    if (!this.dmSubscribed) this.subscribeIncomingDMs();
    return this.dmsByPeer.subscribe(cb);
  }

  disableDirectMessages(): void {
    for (const sub of this.dmSubHandles) {
      this.closeTrackedSub(sub);
    }
    this.dmSubHandles = [];
    this.dmSubscribed = false;
    this.authAllowedRelays.clear();
    this.myDmRelays = [];
  }

  subscribeMyMutes(cb: (pubkeys: ReadonlyArray<string>) => void): Unsubscribe {
    return this.myMutes.subscribe(cb);
  }

  subscribeAdmins(groupId: string, cb: (admins: ReadonlyArray<string>) => void): Unsubscribe {
    this.subscribeAdminMember(groupId);
    const adapter: Listener<Record<string, string[]>> = (byGroup) => cb(byGroup[groupId] ?? []);
    return this.adminsByGroup.subscribe(adapter);
  }

  subscribeAdminsByGroup(
    cb: (byGroup: Readonly<Record<string, ReadonlyArray<string>>>) => void,
  ): Unsubscribe {
    return this.adminsByGroup.subscribe(cb);
  }

  subscribeMembers(groupId: string, cb: (members: ReadonlyArray<string>) => void): Unsubscribe {
    this.subscribeAdminMember(groupId);
    const adapter: Listener<Record<string, string[]>> = (byGroup) => cb(byGroup[groupId] ?? []);
    return this.membersByGroup.subscribe(adapter);
  }

  subscribeMembersByGroup(
    cb: (byGroup: Readonly<Record<string, ReadonlyArray<string>>>) => void,
  ): Unsubscribe {
    return this.membersByGroup.subscribe(cb);
  }

  /**
   * Subscribe to the "relay has delivered at least one 39001/39002 for this
   * group" signal. Fires `false` immediately on subscribe (or `true` if a
   * membership event was already observed), then `true` when the first event
   * lands. Callers should also call {@link subscribeMembers} /
   * {@link subscribeAdmins} so the underlying REQ is open.
   */
  subscribeMembershipReady(groupId: string, cb: (ready: boolean) => void): Unsubscribe {
    this.subscribeAdminMember(groupId);
    const adapter: Listener<Record<string, boolean>> = (m) => cb(!!m[groupId]);
    return this.membershipReadyByGroup.subscribe(adapter);
  }

  ensureUserMetadata(pubkey: string): void {
    if (this.metadataRequested.has(pubkey)) return;
    // Skip the kind:0 REQ for resolved-deny pubkeys to avoid amplifying
    // unwanted authors into our outbound subscription set. Unknown verdicts
    // still get a REQ — they may resolve to allow later.
    if (wotEngine.isResolvedDeny(pubkey)) return;
    this.metadataRequested.add(pubkey);
    this.subscribeKind0(pubkey);
  }

  // -- Group operations --------------------------------------------------

  async sendMessage(
    groupId: string,
    content: string,
    replyTo?: { id: string; pubkey: string } | null,
    emojiTags: ReadonlyArray<ReadonlyArray<string>> = [],
  ): Promise<void> {
    if (!this.session) throw new Error('Not logged in');
    const clientTag = generateClientTag();
    const createdAt = Math.floor(Date.now() / 1000);
    const replyToCopy = replyTo ? { id: replyTo.id, pubkey: replyTo.pubkey } : null;
    const emojiTagsCopy = emojiTags.map((tag) => [...tag]);
    const pendingMsg: JsMessage = {
      id: `pending:${clientTag}`,
      pubkey: this.session.pubKeyHex,
      content,
      createdAt,
      kind: KIND_GROUP_MESSAGE,
      replyToId: replyToCopy?.id ?? null,
      mentions: [],
      customEmojis: customEmojiMapFromTags(emojiTagsCopy),
      pending: true,
      clientTag,
    };
    this.pendingGroupSends.set(clientTag, { groupId, content, replyTo: replyToCopy, emojiTags: emojiTagsCopy, createdAt });
    this.upsertPendingGroupMessage(groupId, pendingMsg);
    void this.publishGroupMessage(groupId, content, replyToCopy, emojiTagsCopy, clientTag, createdAt);
  }

  async sendReaction(
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    groupId: string,
    emojiTags: ReadonlyArray<ReadonlyArray<string>> = [],
  ): Promise<void> {
    const emojiTagsCopy = emojiTags.map((tag) => [...tag]);
    const event = await this.signAndPublish({
      kind: KIND_REACTION,
      content: emoji,
      tags: [
        ...emojiTagsCopy,
        ['e', targetEventId],
        ['p', targetPubkey],
        ['h', groupId],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    this.ingestReaction(groupId, event);
  }

  async removeReaction(groupId: string, reactionEventId: string): Promise<void> {
    const event = await this.signAndPublish({
      kind: KIND_EVENT_DELETION,
      content: 'remove reaction',
      tags: [
        ['e', reactionEventId],
        ['k', String(KIND_REACTION)],
        ['h', groupId],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    this.ingestEventDeletion(groupId, event);
  }

  async removeMessage(groupId: string, eventId: string): Promise<void> {
    const event = await this.signAndPublish({
      kind: KIND_EVENT_DELETION,
      content: 'remove message',
      tags: [
        ['e', eventId],
        ['k', String(KIND_GROUP_MESSAGE)],
        ['h', groupId],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
    this.ingestEventDeletion(groupId, event);
  }

  async sendDirectMessage(recipientPubkey: string, content: string): Promise<void> {
    if (!this.session) throw new Error('Not logged in');
    const clientTag = generateClientTag();
    const createdAt = Math.floor(Date.now() / 1000);
    const pendingMsg: JsDirectMessage = {
      id: `pending:${clientTag}`,
      counterparty: recipientPubkey,
      outgoing: true,
      content,
      createdAt,
      pending: true,
      clientTag,
    };
    this.pendingDMSends.set(clientTag, { recipientPubkey, content, createdAt });
    this.upsertPendingDM(recipientPubkey, pendingMsg);
    void this.publishDirectMessage(recipientPubkey, content, clientTag, createdAt);
  }

  private async publishDirectMessage(
    recipientPubkey: string,
    content: string,
    clientTag: string,
    createdAt: number,
  ): Promise<void> {
    try {
      const cipher = await this.encryptNip04(recipientPubkey, content);
      // NIP-04 DMs are delivered to the recipient's NIP-65 read relays; without
      // this, sends to anyone whose read set doesn't include `this.relays` will
      // never reach them. Failure to look up just falls back to `this.relays`.
      const extraRelays = await this.fetchRecipientReadRelays(recipientPubkey).catch(() => [] as string[]);
      const event = await this.signAndPublish(
        {
          kind: KIND_DIRECT_MESSAGE,
          content: cipher,
          tags: [['p', recipientPubkey]],
          created_at: createdAt,
        },
        extraRelays,
      );
      this.replacePendingDM(recipientPubkey, clientTag, event, content);
    } catch {
      this.markDMFailed(recipientPubkey, clientTag);
    }
  }

  private async publishGroupMessage(
    groupId: string,
    content: string,
    replyTo: { id: string; pubkey: string } | null,
    emojiTags: string[][],
    clientTag: string,
    createdAt: number,
  ): Promise<void> {
    const tags: string[][] = [...emojiTags, ['h', groupId]];
    if (replyTo) {
      tags.push(['e', replyTo.id, '', 'reply']);
      tags.push(['p', replyTo.pubkey]);
    }
    try {
      const event = await this.signAndPublish({
        kind: KIND_GROUP_MESSAGE,
        content,
        tags,
        created_at: createdAt,
      });
      this.replacePendingGroupMessage(groupId, clientTag, event);
    } catch {
      this.markGroupMessageFailed(groupId, clientTag);
    }
  }

  async retryMessage(groupId: string, clientTag: string): Promise<void> {
    const args = this.pendingGroupSends.get(clientTag);
    if (!args) return;
    // Only retry from a failed state — prevents double-publishing if the
    // user double-taps Retry while a previous attempt is still in flight.
    const list = this.messagesByGroup.get()[groupId] ?? [];
    const msg = list.find((m) => m.clientTag === clientTag);
    if (!msg || !msg.failed) return;
    this.flipPendingGroupMessageToPending(groupId, clientTag);
    void this.publishGroupMessage(args.groupId, args.content, args.replyTo, args.emojiTags, clientTag, args.createdAt);
  }

  async retryDirectMessage(counterparty: string, clientTag: string): Promise<void> {
    const args = this.pendingDMSends.get(clientTag);
    if (!args) return;
    const list = this.dmsByPeer.get()[counterparty] ?? [];
    const msg = list.find((m) => m.clientTag === clientTag);
    if (!msg || !msg.failed) return;
    this.flipPendingDMToPending(counterparty, clientTag);
    void this.publishDirectMessage(args.recipientPubkey, args.content, clientTag, args.createdAt);
  }

  cancelPendingMessage(groupId: string, clientTag: string): void {
    this.pendingGroupSends.delete(clientTag);
    updatePending(this.messagesByGroup, groupId, clientTag, null);
  }

  cancelPendingDirectMessage(counterparty: string, clientTag: string): void {
    this.pendingDMSends.delete(clientTag);
    updatePending(this.dmsByPeer, counterparty, clientTag, null);
  }

  private upsertPendingGroupMessage(groupId: string, msg: JsMessage): void {
    this.messagesByGroup.update((prev) => {
      const existing = prev[groupId] ?? [];
      const next = [...existing, msg].sort((a, b) => a.createdAt - b.createdAt);
      return { ...prev, [groupId]: next };
    });
  }

  private replacePendingGroupMessage(groupId: string, clientTag: string, ev: NostrEvent): void {
    // Once the relay returns the real event, drop the args — a retry from
    // here would re-publish a finalized message.
    this.pendingGroupSends.delete(clientTag);
    const replyTo = ev.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] ?? null;
    const mentions = extractMentionPubkeysFromMessage(ev.content, ev.tags);
    const realMsg: JsMessage = {
      id: ev.id,
      pubkey: ev.pubkey,
      content: ev.content,
      createdAt: ev.created_at,
      kind: ev.kind,
      replyToId: replyTo,
      mentions,
      customEmojis: customEmojiMapFromTags(ev.tags),
    };
    this.messagesByGroup.update((prev) => {
      const existing = prev[groupId] ?? [];
      const realPresent = existing.some((m) => m.id === realMsg.id);
      // The relay echo may have raced through ingestMessage first — in that
      // case the placeholder is already gone (ingestMessage replaces it by
      // tuple match) so this update is a no-op.
      if (realPresent) {
        const filtered = existing.filter((m) => m.clientTag !== clientTag);
        if (filtered.length === existing.length) return prev;
        return { ...prev, [groupId]: filtered };
      }
      let replaced = false;
      const swapped = existing.map((m) => {
        if (m.clientTag === clientTag) {
          replaced = true;
          return realMsg;
        }
        return m;
      });
      if (!replaced) {
        // Placeholder was canceled before the publish ack landed — append
        // the real event so the user sees the message they sent.
        return { ...prev, [groupId]: [...existing, realMsg].sort((a, b) => a.createdAt - b.createdAt) };
      }
      swapped.sort((a, b) => a.createdAt - b.createdAt);
      return { ...prev, [groupId]: swapped };
    });
    this.ensureUserMetadata(ev.pubkey);
  }

  private markGroupMessageFailed(groupId: string, clientTag: string): void {
    updatePending(this.messagesByGroup, groupId, clientTag, { pending: false, failed: true });
  }

  private flipPendingGroupMessageToPending(groupId: string, clientTag: string): void {
    updatePending(this.messagesByGroup, groupId, clientTag, { pending: true, failed: false });
  }

  private upsertPendingDM(counterparty: string, msg: JsDirectMessage): void {
    this.dmsByPeer.update((prev) => {
      const existing = prev[counterparty] ?? [];
      const next = [...existing, msg].sort((a, b) => a.createdAt - b.createdAt);
      return { ...prev, [counterparty]: next };
    });
  }

  private replacePendingDM(
    counterparty: string,
    clientTag: string,
    ev: NostrEvent,
    plaintext: string,
  ): void {
    this.pendingDMSends.delete(clientTag);
    const realMsg: JsDirectMessage = {
      id: ev.id,
      counterparty,
      outgoing: true,
      content: plaintext,
      createdAt: ev.created_at,
    };
    this.dmsByPeer.update((prev) => {
      const existing = prev[counterparty] ?? [];
      const realPresent = existing.some((m) => m.id === realMsg.id);
      if (realPresent) {
        const filtered = existing.filter((m) => m.clientTag !== clientTag);
        if (filtered.length === existing.length) return prev;
        return { ...prev, [counterparty]: filtered };
      }
      let replaced = false;
      const swapped = existing.map((m) => {
        if (m.clientTag === clientTag) {
          replaced = true;
          return realMsg;
        }
        return m;
      });
      if (!replaced) {
        return { ...prev, [counterparty]: [...existing, realMsg].sort((a, b) => a.createdAt - b.createdAt) };
      }
      swapped.sort((a, b) => a.createdAt - b.createdAt);
      return { ...prev, [counterparty]: swapped };
    });
    this.ensureUserMetadata(counterparty);
  }

  private markDMFailed(counterparty: string, clientTag: string): void {
    updatePending(this.dmsByPeer, counterparty, clientTag, { pending: false, failed: true });
  }

  private flipPendingDMToPending(counterparty: string, clientTag: string): void {
    updatePending(this.dmsByPeer, counterparty, clientTag, { pending: true, failed: false });
  }

  async joinGroup(groupId: string): Promise<void> {
    await this.signAndPublish({
      kind: KIND_GROUP_JOIN_REQUEST,
      content: '',
      tags: [['h', groupId]],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  async leaveGroup(groupId: string): Promise<void> {
    await this.signAndPublish({
      kind: KIND_GROUP_LEAVE_REQUEST,
      content: '',
      tags: [['h', groupId]],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  async createGroup(opts: {
    groupId?: string;
    name: string;
    about?: string;
    picture?: string;
    banner?: string;
    isPublic?: boolean;
    isOpen?: boolean;
    kind?: 'text' | 'voice' | 'voice-sfu' | 'forum';
    parent?: string;
    forumTags?: ReadonlyArray<JsForumTag>;
    topics?: ReadonlyArray<string>;
  }): Promise<string> {
    const groupId = opts.groupId ?? generateGroupId();
    await this.signAndPublish({
      kind: KIND_GROUP_CREATE,
      content: '',
      tags: [['h', groupId]],
      created_at: Math.floor(Date.now() / 1000),
    });
    // Optimistically record the creator locally so claimCreatorAdmin works
    // without waiting for the relay to round-trip our own kind 9007 back. The
    // explicit creator-admin claim used to live here as an unconditional
    // putUser; that fired a kind 9000 even on relays that already auto-promoted
    // the creator, polluting the moderation log. The claim is now lazy —
    // ManageGroup / settings-open paths call `claimCreatorAdmin` only if 39001
    // doesn't already include the local user.
    if (this.session) {
      this.groupCreators.update((m) => ({ ...m, [groupId]: this.session!.pubKeyHex }));
      cacheSet(this.currentRelayUrl.get(), KIND_GROUP_CREATE, groupId, this.session.pubKeyHex);
    }
    await this.editGroupMetadata({ ...opts, groupId });
    return groupId;
  }

  async putUser(
    groupId: string,
    pubkey: string,
    roles?: ReadonlyArray<string>,
    opts?: { quiet?: boolean },
  ): Promise<void> {
    const pTag: string[] = ['p', pubkey];
    if (roles && roles.length > 0) pTag.push(...roles);
    await this.signAndPublish(
      {
        kind: KIND_GROUP_PUT_USER,
        content: '',
        tags: [['h', groupId], pTag],
        created_at: Math.floor(Date.now() / 1000),
      },
      [],
      opts,
    );
  }

  async removeUser(groupId: string, pubkey: string): Promise<void> {
    await this.signAndPublish({
      kind: KIND_GROUP_REMOVE_USER,
      content: '',
      tags: [['h', groupId], ['p', pubkey]],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * NIP-29 9003 remove-permission. Strips one or more roles from a user's
   * `p` entry on the next 39001/39002 broadcast without removing them from
   * the group. The most common use is demoting an admin to a plain member
   * (`permissions = ['admin']`).
   */
  async removePermission(
    groupId: string,
    pubkey: string,
    permissions: ReadonlyArray<string>,
  ): Promise<void> {
    if (permissions.length === 0) return;
    const pTag: string[] = ['p', pubkey, ...permissions];
    await this.signAndPublish({
      kind: KIND_GROUP_REMOVE_PERMISSION,
      content: '',
      tags: [['h', groupId], pTag],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * One-shot kind 9000 admin claim, only fired when:
   *   - we know the kind 9007 author of `groupId` (from {@link groupCreators}),
   *     and it equals the active session pubkey, AND
   *   - the local user is not already in the relay-published 39001 admin list.
   *
   * Replaces the previous blanket login-time auto-claim loop in AppShell which
   * published a kind 9000 admin for every visible group on every login. This
   * helper is meant to be called from settings-open / create-group flows where
   * the user's intent to administer the channel is explicit. Returns `true`
   * when an event was published, `false` when the call was a no-op (not the
   * creator, already an admin, or no session).
   */
  async claimCreatorAdmin(groupId: string): Promise<boolean> {
    if (!this.session) return false;
    const me = this.session.pubKeyHex;
    if (this.groupCreators.get()[groupId] !== me) return false;
    const admins = this.adminsByGroup.get()[groupId] ?? [];
    if (admins.includes(me)) return false;
    // Best-effort background write: if the relay accepts it the local
    // creator becomes a relay-confirmed admin on the next 39001 broadcast;
    // if the relay declines (whitelist, "not authorized to add users"),
    // the user's actual settings/ManageGroup actions will surface the
    // real error. Don't toast for this background attempt.
    await this.putUser(groupId, me, ['admin'], { quiet: true });
    return true;
  }

  /** Reactive subscription over the kind 9007 creator map (groupId -> pubkey). */
  subscribeGroupCreators(cb: (byGroup: Readonly<Record<string, string>>) => void): Unsubscribe {
    return this.groupCreators.subscribe(cb);
  }

  async deleteGroupEvent(groupId: string, eventId: string): Promise<void> {
    const event = await this.signAndPublish({
      kind: KIND_GROUP_DELETE_EVENT,
      content: '',
      tags: [['h', groupId], ['e', eventId]],
      created_at: Math.floor(Date.now() / 1000),
    });
    this.ingestGroupEventDeletion(groupId, event);
  }

  async editGroupMetadata(opts: {
    groupId: string;
    name?: string;
    about?: string;
    picture?: string;
    banner?: string;
    isPublic?: boolean;
    isOpen?: boolean;
    kind?: 'text' | 'voice' | 'voice-sfu' | 'forum';
    parent?: string;
    forumTags?: ReadonlyArray<JsForumTag>;
    topics?: ReadonlyArray<string>;
  }): Promise<void> {
    const tags: string[][] = [['h', opts.groupId]];
    if (opts.name !== undefined) tags.push(['name', opts.name]);
    if (opts.about !== undefined) tags.push(['about', opts.about]);
    if (opts.picture !== undefined) tags.push(['picture', opts.picture]);
    if (opts.banner !== undefined) tags.push(['banner', opts.banner]);
    if (opts.isPublic !== undefined) tags.push([opts.isPublic ? 'public' : 'private']);
    if (opts.isOpen !== undefined) tags.push([opts.isOpen ? 'open' : 'closed']);
    if (opts.parent !== undefined && opts.parent) tags.push(['parent', opts.parent]);
    // The variant marker is "just another tag" on kind 9002; the relay
    // reflects it on kind 39000 like name/about. Omitting the tag
    // (kind: 'text') makes a previously-voice/forum channel revert to a
    // regular text channel.
    if (opts.kind === 'voice') tags.push(['t', 'voice']);
    else if (opts.kind === 'voice-sfu') tags.push(['t', 'voice-sfu']);
    else if (opts.kind === 'forum') tags.push(['t', 'forum']);
    // Curated forum tags (admin) + thread topic references. Kind 9002 is a
    // full replacement, so callers MUST pass the full intended set on every
    // edit. The new ForumView chrome and ChannelSettingsModal both load the
    // current set into local state and pass it back on save to preserve it.
    if (opts.forumTags) {
      for (const ft of opts.forumTags) {
        if (!ft.id || !ft.name) continue;
        tags.push(ft.emoji ? ['forum-tag', ft.id, ft.name, ft.emoji] : ['forum-tag', ft.id, ft.name]);
      }
    }
    if (opts.topics) {
      for (const id of opts.topics) {
        if (id) tags.push(['topic', id]);
      }
    }
    await this.signAndPublish({
      kind: KIND_GROUP_EDIT_METADATA,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  async searchMessages(opts: {
    query?: string;
    groupIds?: ReadonlyArray<string>;
    authors?: ReadonlyArray<string>;
    mentions?: ReadonlyArray<string>;
    has?: ReadonlyArray<'link' | 'image' | 'file'>;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<ReadonlyArray<JsMessage & { groupId: string | null }>> {
    const filter: Filter & { search?: string } = {
      kinds: [KIND_GROUP_MESSAGE],
      limit: opts.limit ?? 50,
    };
    if (opts.query && opts.query.trim()) filter.search = opts.query.trim();
    if (opts.authors && opts.authors.length > 0) filter.authors = [...opts.authors];
    if (opts.mentions && opts.mentions.length > 0) (filter as Record<string, unknown>)['#p'] = [...opts.mentions];
    if (opts.groupIds && opts.groupIds.length > 0) (filter as Record<string, unknown>)['#h'] = [...opts.groupIds];
    if (opts.since) filter.since = opts.since;
    if (opts.until) filter.until = opts.until;
    const events = await this.pool.querySync(this.relays, filter, { maxWait: 4000 });
    const has = new Set(opts.has ?? []);
    const URL_RE = /https?:\/\/\S+/i;
    const IMG_RE = /https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|svg)(?:\?\S*)?/i;
    const FILE_RE = /https?:\/\/\S+\.(?:pdf|zip|tar|gz|mp3|mp4|mov|webm|wav|csv|json|txt|md)(?:\?\S*)?/i;
    const matches = (content: string) => {
      if (has.size === 0) return true;
      if (has.has('image') && !IMG_RE.test(content)) return false;
      if (has.has('file') && !FILE_RE.test(content)) return false;
      if (has.has('link') && !URL_RE.test(content)) return false;
      return true;
    };
    return events
      .filter((e) => matches(e.content))
      .map((e) => ({
        id: e.id,
        pubkey: e.pubkey,
        content: e.content,
        createdAt: e.created_at,
        kind: e.kind,
        replyToId: getTag(e, 'e') ?? null,
        mentions: extractMentionPubkeysFromMessage(e.content, e.tags),
        customEmojis: customEmojiMapFromTags(e.tags),
        groupId: getTag(e, 'h') ?? null,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async editUserMetadata(opts: {
    name?: string;
    displayName?: string;
    about?: string;
    picture?: string;
    banner?: string;
    nip05?: string;
    website?: string;
    lud16?: string;
  }): Promise<void> {
    if (!this.session) throw new Error('Not logged in');
    const me = this.session.pubKeyHex;
    const profileRelays = Array.from(new Set([...this.relays, ...DEFAULT_PROFILE_LOOKUP_RELAYS]));

    let existing: Record<string, unknown> = {};
    try {
      const events = await this.pool.querySync(profileRelays, { kinds: [KIND_USER_METADATA], authors: [me], limit: 5 }, { maxWait: PROFILE_LOOKUP_MAX_WAIT_MS });
      const ev = newestEvent(events.filter((e) => e.kind === KIND_USER_METADATA && e.pubkey === me));
      if (ev) existing = JSON.parse(ev.content) as Record<string, unknown>;
    } catch {
      // ignore — start from empty
    }

    const merged: Record<string, unknown> = { ...existing };
    if (opts.name !== undefined) merged.name = opts.name;
    if (opts.displayName !== undefined) merged.display_name = opts.displayName;
    if (opts.about !== undefined) merged.about = opts.about;
    if (opts.picture !== undefined) merged.picture = opts.picture;
    if (opts.banner !== undefined) merged.banner = opts.banner;
    if (opts.nip05 !== undefined) merged.nip05 = opts.nip05;
    if (opts.website !== undefined) merged.website = opts.website;
    if (opts.lud16 !== undefined) merged.lud16 = opts.lud16;

    const event = await this.signAndPublish(
      {
        kind: KIND_USER_METADATA,
        content: JSON.stringify(merged),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      { extraRelays: Array.from(DEFAULT_PROFILE_LOOKUP_RELAYS) },
    );
    setCachedKind0(event);
    this.ingestUserMetadata(event, { cacheRelayScoped: true });
    const state = loadProfileSyncState();
    for (const relay of profileRelays) state.ownProfileSyncedToRelay[profileRelayKey(me, relay)] = event.created_at;
    state.ownProfileLookupAt[me] = Date.now();
    saveProfileSyncState(state);
  }

  /**
   * Add or remove a pubkey from the local user's NIP-51 kind 10000 mute list.
   * Fetches the latest kind 10000 first so unrelated entries (events,
   * hashtags, encrypted content) are preserved, then republishes with the
   * adjusted `p` tags. Updates `myMutes` optimistically so the UI reflects
   * the change without waiting for the relay echo.
   */
  async setMuted(pubkey: string, muted: boolean): Promise<void> {
    if (!this.session) throw new Error('Not logged in');
    const me = this.session.pubKeyHex;
    const muteRelays = Array.from(new Set([...this.relays, ...PROFILE_RELAYS]));

    // Pull the latest kind 10000 so we don't drop encrypted content or
    // non-`p` tags published by other clients.
    let existingTags: string[][] = [];
    let existingContent = '';
    try {
      const ev = await this.pool.get(muteRelays, { kinds: [KIND_MUTE_LIST], authors: [me] });
      if (ev) {
        existingTags = ev.tags;
        existingContent = ev.content;
      }
    } catch {
      // ignore — start from empty
    }

    const otherTags = existingTags.filter((t) => !(t[0] === 'p' && t[1] === pubkey));
    const nextTags = muted ? [...otherTags, ['p', pubkey]] : otherTags;

    // Optimistic update so mute/unmute UI reflects immediately; the relay
    // echo will overwrite this with the canonical list via
    // subscribeMyMuteList. This is intentionally non-destructive: existing
    // messages/DMs/metadata stay in the local stores.
    const current = this.myMutes.get();
    const optimistic = muted
      ? current.includes(pubkey) ? current : [...current, pubkey]
      : current.filter((p) => p !== pubkey);
    this.myMutes.set(optimistic);

    await this.signAndPublish(
      {
        kind: KIND_MUTE_LIST,
        content: existingContent,
        tags: nextTags,
        created_at: Math.floor(Date.now() / 1000),
      },
      PROFILE_RELAYS,
    );
  }

  async loadMoreMessages(groupId: string): Promise<LoadMoreMessagesResult> {
    // Page older messages on demand. Live REQ stays capped at
    // BACKGROUND_MESSAGE_LIMIT; "Load earlier" calls this with the oldest
    // currently-rendered message as the upper bound.
    //
    // Result contract:
    // - 'added'       — at least one previously-unseen event was ingested.
    // - 'end'         — the active relay/index returned an authoritative
    //                   empty older page while relay access was confirmed.
    // - 'unavailable' — no safe conclusion (missing anchor, auth still
    //                   settling, transport error, duplicate-only page).
    //
    // The UI must only show "no earlier messages" for 'end'. Everything
    // else remains retryable so AUTH races and normal relay hiccups do not
    // become false history-end signals.
    const existing = this.messagesByGroup.get()[groupId] ?? [];
    if (existing.length === 0) return 'unavailable';
    const oldest = existing.reduce((a, m) => (m.createdAt < a ? m.createdAt : a), existing[0].createdAt);
    const relayKey = normalizeRelayUrl(this.currentRelayUrl.get());
    const accessBefore = this.relayAccess.get()[relayKey] ?? 'unknown';
    if (accessBefore === 'authenticating') {
      const settled = await this.waitForRelayAuth(3500);
      if (settled !== 'ok') return 'unavailable';
    }
    const filter: Filter = {
      kinds: [KIND_GROUP_MESSAGE],
      '#h': [groupId],
      until: oldest - 1,
      limit: LOAD_MORE_PAGE_SIZE,
    };
    let events: NostrEvent[];
    try {
      events = await this.pool.querySync(this.relays, filter, { maxWait: 5000 });
    } catch {
      return 'unavailable';
    }
    const accessAfter = this.relayAccess.get()[relayKey] ?? 'unknown';
    if (events.length === 0) return accessAfter === 'ok' ? 'end' : 'unavailable';
    let added = 0;
    for (const ev of events) {
      const before = this.messagesByGroup.get()[groupId]?.length ?? 0;
      this.ingestMessage(groupId, ev);
      const after = this.messagesByGroup.get()[groupId]?.length ?? 0;
      if (after > before) added++;
    }
    return added > 0 ? 'added' : 'unavailable';
  }


  /**
   * Fetch a single group's kind 39000 metadata on demand. Used by the chat
   * pane when it mounts onto a `groupId` that isn't in the bridge's
   * `groups` store yet — the global metadata stream is supposed to catch
   * every group, but slow / silent-filtering relays can miss specific ids
   * for a session. A focused `querySync` with `#d:[groupId]` gives the
   * relay exactly one event to deliver and unblocks the chat pane without
   * waiting for a full page refresh.
   *
   * Returns `true` when at least one previously-unseen 39000 event was
   * ingested.
   */
  async fetchGroupMetadata(groupId: string): Promise<boolean> {
    if (!groupId) return false;
    const filter: Filter = {
      kinds: [KIND_GROUP_METADATA],
      '#d': [groupId],
      limit: 1,
    };
    let events: NostrEvent[];
    try {
      events = await this.pool.querySync(this.relays, filter, { maxWait: 4000 });
    } catch {
      return false;
    }
    let added = 0;
    for (const ev of events) {
      const before = this.groups.get().length;
      this.ingestGroupMetadata(ev);
      const after = this.groups.get().length;
      if (after > before) added++;
    }
    return added > 0;
  }

  setActiveGroup(groupId: string | null): void {
    const previousActive = this.activeGroupId;
    this.activeGroupId = groupId;
    // Reset the priority deadline + arm a force-release timer. See
    // {@link ACTIVE_PRIORITY_MAX_PAUSE_MS} for the rationale.
    if (this.activeGroupPriorityTimer) {
      clearTimeout(this.activeGroupPriorityTimer);
      this.activeGroupPriorityTimer = null;
    }
    if (groupId) {
      this.activeGroupPriorityDeadline = Date.now() + BridgeImpl.ACTIVE_PRIORITY_MAX_PAUSE_MS;
      this.activeGroupPriorityTimer = setTimeout(() => {
        this.activeGroupPriorityTimer = null;
        // Deadline passed — release the gate even if status is still
        // 'loading'. If there's pending background work, drain it now;
        // otherwise this is a no-op.
        this.maybeResumeMessageQueueDrain();
      }, BridgeImpl.ACTIVE_PRIORITY_MAX_PAUSE_MS);
    } else {
      this.activeGroupPriorityDeadline = 0;
    }
    // Switching away from a still-loading channel? Resume the background
    // queue drain so other channels' subs aren't held forever.
    if (previousActive && previousActive !== groupId) {
      this.maybeResumeMessageQueueDrain();
    }
    if (!groupId) return;
    this.seedCachedMessagesForGroup(this.currentRelayUrl.get(), groupId);
    // Re-entering a channel that was previously declared empty-confirmed
    // is the canonical "stale empty" recovery path. The bridge owns this
    // restart so the UI never has to fire its own refresh effect.
    const msgs = this.messagesByGroup.get()[groupId] ?? [];
    const currentStatus = this.messagesStatusByGroup.get()[groupId];
    if (currentStatus === 'empty-confirmed' && msgs.length === 0) {
      this.clearMessagesRetry(groupId);
      this.internalRestartMessageSub(groupId);
      return;
    }
    // Fast-track the channel the user just clicked: if the kind 9 REQ
    // hasn't been fired yet (because metadata is still streaming or this
    // group was sitting in the background queue from the kind 39000
    // fan-out), promote it now so the relay's first response is the
    // channel actually in view.
    this.bumpGroupMessagesPriority(groupId);
  }

  // -- Voice channels ---------------------------------------------------

  /** Read-once snapshot of admins for a group; subscribes if not already. */
  getAdmins(groupId: string): readonly string[] {
    this.subscribeAdminMember(groupId);
    return this.adminsByGroup.get()[groupId] ?? [];
  }

  /** Read-once snapshot of members for a group; subscribes if not already. */
  getMembers(groupId: string): readonly string[] {
    this.subscribeAdminMember(groupId);
    return this.membersByGroup.get()[groupId] ?? [];
  }

  // -- Voice / ephemeral primitives -------------------------------------

  /**
   * Publish a pre-built event template as the active session, returning the
   * signed event. Same machinery as `signAndPublish` but exposed for callers
   * (e.g. voice presence beacons, gift-wrapped voice signaling) that need to
   * publish events outside the NIP-29 group flow.
   */
  async publishEvent(template: {
    kind: number;
    content: string;
    tags: string[][];
    created_at?: number;
  }, opts: PublishOpts = {}): Promise<NostrEvent> {
    return this.signAndPublish(
      {
        kind: template.kind,
        content: template.content,
        tags: template.tags,
        created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      },
      opts,
    );
  }

  /**
   * Subscribe to events on the configured relays matching `filter`. Returns
   * an unsubscribe function. NIP-42 auth is handled by the same signer the
   * rest of the pool uses. Used by voice for presence beacons and incoming
   * gift wraps. Filters apply per-relay; standard nostr-tools semantics.
   */
  subscribeFilter(filter: Filter, onEvent: (ev: NostrEvent) => void): () => void {
    const sub = this.pool.subscribe(this.relays, filter, {
      onevent: onEvent,
      onauth: this.getAuthSigner(),
    });
    return () => sub.close();
  }

  /**
   * Watched variant of {@link subscribeFilter}. Use this for any non-message
   * data that paints the chrome of the app — relay branding, channel layout,
   * group metadata fan-out — so a NIP-42 AUTH race or transient blip doesn't
   * silently drop the REQ and force the user to refresh. Wraps the sub with
   * the same watchdog the per-group subscriptions use.
   */
  subscribeVoiceFilterWatched(
    filter: Filter,
    onEvent: (ev: NostrEvent) => void,
    options?: {
      watchdogMs?: number;
      maxAttempts?: number;
      relays?: readonly string[];
      relayMode?: 'merge' | 'replace';
      affectsRelayAccess?: boolean;
    },
  ): () => void {
    const targetRelays = options?.relays && options.relays.length > 0
      ? Array.from(new Set(options.relayMode === 'replace'
          ? [...options.relays]
          : [...this.relays, ...options.relays]))
      : this.relays;
    const pool = this.voicePool ?? (this.voicePool = this.createPool());
    for (const r of targetRelays) this.voicePoolRelays.add(r);
    this.voicePoolRefs += 1;
    const sub = this.subscribeWatched(
      targetRelays,
      filter,
      onEvent,
      undefined,
      { ...options, affectsRelayAccess: options?.affectsRelayAccess ?? false },
      pool,
      () => true,
    );

    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      sub.close();
      this.voicePoolRefs = Math.max(0, this.voicePoolRefs - 1);
      if (this.voicePoolRefs === 0 && this.voicePool === pool) {
        this.closeVoicePool();
      }
    };
  }

  subscribeFilterWatched(
    filter: Filter,
    onEvent: (ev: NostrEvent) => void,
    options?: {
      watchdogMs?: number;
      maxAttempts?: number;
      relays?: readonly string[];
      relayMode?: 'merge' | 'replace';
      affectsRelayAccess?: boolean;
    },
  ): () => void {
    if (options?.relays && options.relayMode === "replace") {
      return this.subscribeVoiceFilterWatched(filter, onEvent, options);
    }
    // Optional `relays` override merges with the bridge's default relay
    // list. Used by callers that need to listen on relays the bridge
    // hasn't been switched to — e.g. the SFU RPC client, where the SFU
    // only publishes responses to its trusted relays (relay.obelisk.ar)
    // while the dex tab might be on public.obelisk.ar. Without the
    // override, getRouterRtpCapabilities responses never reach the
    // browser and `start()` times out at 8s.
    const targetRelays = options?.relays && options.relays.length > 0
      ? Array.from(new Set(options.relayMode === 'replace'
          ? [...options.relays]
          : [...this.relays, ...options.relays]))
      : this.relays;
    const start = () => {
      const sub = this.subscribeWatched(targetRelays, filter, onEvent, undefined, options);
      this.subs.push(sub);
      return sub;
    };
    if (!options?.relays && !this.poolSocketAlive) {
      let closed = false;
      let sub: ReturnType<typeof start> | null = null;
      let stopWaiting: () => void = () => {};
      stopWaiting = this.connectionState.subscribe((state) => {
        if (closed || sub || state !== "Connected" || !this.poolSocketAlive) return;
        sub = start();
        stopWaiting();
      });
      if (sub) stopWaiting();
      return () => {
        closed = true;
        stopWaiting();
        if (sub) this.closeTrackedSub(sub);
      };
    }
    const sub = start();
    return () => this.closeTrackedSub(sub);
  }

  // -- Internals ---------------------------------------------------------

  /**
   * Wrap `pool.subscribe` with a per-subscription watchdog.
   *
   * On first load (and after relay/session resets) a relay's NIP-42 AUTH
   * round-trip can race past the initial REQ, or a transient network blip
   * can drop the sub silently. Symptoms: categories render but channels
   * don't; messages stay empty until the user refreshes 2-3 times.
   *
   * If neither an EVENT nor an EOSE arrives within `watchdogMs`, we close
   * the sub and re-issue it (with backoff, up to `maxAttempts`). EOSE alone
   * is enough to consider the sub alive — even if the relay has nothing
   * stored, EOSE proves the REQ is live and live events will stream.
   *
   * Tunable rationale:
   *   - `watchdogMs`: how long to wait for *any* response before assuming
   *     the REQ was dropped. 5000ms is a conservative default that tolerates
   *     a slow NIP-42 round-trip + initial query on a backed-up relay. Lower
   *     this for non-critical paths where a missed retry just means stale
   *     UX for a few seconds.
   *   - `maxAttempts`: how many times to retry before giving up. Defaults
   *     to `Infinity` for critical paths (group metadata, messages,
   *     admin/member, DMs, contact list) — losing those means an empty UI
   *     and the user shouldn't have to refresh to recover. Backoff still
   *     applies (1s/2s/4s/8s, capped at 30s) so a permanently-broken relay
   *     doesn't burn CPU. Non-critical paths (kind:0 metadata, reactions)
   *     override with `maxAttempts: 2` since a missed retry there just
   *     delays a display-name resolve or an emoji badge.
   */
  private subscribeWatched(
    relays: string[],
    filter: Filter,
    onevent: (ev: NostrEvent) => void,
    oneose?: () => void,
    options?: {
      watchdogMs?: number;
      maxAttempts?: number;
      affectsRelayAccess?: boolean;
      /**
       * When true, an `auth-required` / `restricted` CLOSED for this sub
       * downgrades relay-access state **immediately** (no 4s soak). Used
       * by the dedicated preflight REQ in {@link preflightRelayAccess} so
       * the user sees a "Not whitelisted" banner within ~1.5s instead of
       * waiting through the deferred soak window. Other subs keep the
       * soak so transient AUTH races don't flash the banner.
       */
      immediateAccessDowngrade?: boolean;
      onQuotaOrRateLimitClose?: () => void;
    },
    pool: SimplePool = this.pool,
    isPoolSocketAlive: () => boolean = () => this.poolSocketAlive,
  ): { close: () => void; markClosed: () => void } {
    const WATCHDOG_MS = options?.watchdogMs ?? 5000;
    const MAX_ATTEMPTS = options?.maxAttempts ?? Infinity;
    // Per-channel / per-pubkey subs (group messages, admin/member, single
    // user metadata) get CLOSED for normal "you can't see this one" reasons
    // — private channels you aren't a member of, profile relays that don't
    // serve the queried pubkey, etc. Those CLOSEDs must NOT flip the
    // relay-wide access banner; otherwise the user sees "Not whitelisted"
    // even when their global metadata sub is delivering everything fine.
    const AFFECTS_ACCESS = options?.affectsRelayAccess ?? true;
    const IMMEDIATE_ACCESS_DOWNGRADE = options?.immediateAccessDowngrade ?? false;
    const MAX_BACKOFF_MS = 30_000;
    let attempt = 0;
    let activeSub: { close: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let alive = false;
    // Single retry token shared by the watchdog and the onclose-driven retry.
    // Whichever path acts first flips it to false so the same failure event
    // can never schedule two retries. Disarmed by `onevent` (a delivered event
    // proves success) but NOT by `oneose` — empty EOSE before NIP-42 AUTH
    // completes is exactly the bug we're guarding against here.
    let armed = false;

    const clearTimer = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    // Common funnel for "this attempt is dead, schedule the next start()".
    // `immediate` requests skipping backoff so nostr-tools can attach AUTH
    // and re-deliver in the next tick. The caller signals this for
    // auth-required / restricted CLOSED — but we only honour it on the
    // first onclose-driven retry. A relay that keeps rejecting with
    // auth-required after the first immediate retry isn't going to be
    // unstuck by another 0-delay round-trip; without this cap, that
    // closure would fire REQ → EOSE → CLOSED → REQ in a tight loop that
    // hammers the relay, starves other REQs (admin/member, kind 0,
    // branding), and on auth-gated channels causes the message pane to
    // oscillate "Loading messages…" ↔ "No messages yet".
    const scheduleRetry = (immediate: boolean) => {
      if (closed || !armed) return;
      armed = false;
      clearTimer();
      try { activeSub?.close(); } catch { /* ignore */ }
      activeSub = null;
      if (attempt >= MAX_ATTEMPTS) return;
      // attempt is incremented at the top of start(), so attempt === 1
      // means we just finished the very first attempt — the only one
      // eligible for the immediate retry. Subsequent failures fall
      // through to exponential backoff.
      const useImmediate = immediate && attempt <= 1;
      const delay = useImmediate ? 0 : Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      timer = setTimeout(start, delay);
    };

    let authPending = false;
    const baseSigner = this.getAuthSigner();
    // Wrap the onauth signer so the watchdog can pause while the user is
    // approving a NIP-42 AUTH challenge in their extension / bunker. Without
    // this, a slow human approval (>watchdogMs) closes the sub before
    // nostr-tools can re-fire the REQ on the now-authed socket — and each
    // watchdog retry triggers a fresh extension prompt instead of riding
    // the existing AUTH. Symptom: user approves the signature, then has to
    // refresh the page for channels/messages to populate.
    const wrappedSigner = baseSigner
      ? async (evt: EventTemplate): Promise<VerifiedEvent> => {
          authPending = true;
          clearTimer();
          try {
            return await baseSigner(evt);
          } finally {
            authPending = false;
            // Give the relay a moment to deliver EVENT/EOSE on the retried
            // REQ before the watchdog can decide the sub is dead.
            if (!closed && !alive) {
              timer = setTimeout(onWatchdog, WATCHDOG_MS);
            }
          }
        }
      : undefined;

    const onWatchdog = () => {
      if (closed || alive || !armed) return;
      if (authPending) {
        // Don't kill the sub while a human is staring at an approval popup.
        timer = setTimeout(onWatchdog, WATCHDOG_MS);
        return;
      }
      scheduleRetry(false);
    };

    const start = () => {
      if (closed) return;
      attempt++;
      alive = false;
      armed = true;
      pushRelayDebug({ kind: "sub-start", relays, filter, payload: { attempt } });
      const sub = pool.subscribe(relays, filter, {
        onevent: (ev) => {
          // switchRelay / resetPoolForSessionChange / dispose call markClosed
          // on every active sub but deliberately skip pool.close() to avoid
          // per-sub CLOSING/CLOSED console spam (see resetPoolForSessionChange
          // comment). The old pool's WebSockets stay open until GC, so events
          // can still be delivered here after `closed = true`. Without this
          // guard, an in-flight kind 39000 from relay A would be ingested
          // into the post-switch state for relay B — both polluting
          // `this.groups` and writing A's group under B's cache key via
          // `cacheSet(this.currentRelayUrl.get(), ...)` in the ingest
          // functions. That's the "channels from another relay leaking into
          // Uncategorized" bug.
          if (closed) { pushRelayDebug({ kind: "sub-stale-event", relays, filter, eventKind: ev.kind }); return; }
          alive = true;
          armed = false;
          clearTimer();
          // Any event delivered means the relay is reading us — auth (if
          // required) succeeded and we're not whitelist-blocked. Mark the
          // active relay 'ok' (helper no-ops for non-active relays).
          if (AFFECTS_ACCESS) {
            for (const url of relays) this.setRelayAccess(url, 'ok');
          }
          // WoT / mute / block gate. The engine fails-open until a verdict
          // resolves; resolved-deny events are dropped here so they never
          // reach ingest, the cache, or `messagesByGroup`. When the engine
          // is disabled the predicate is a constant `true` and this is a
          // no-op. See docs/wot-integration-plan.md.
          if (!wotEngine.isAllowed(ev.pubkey, ev.kind)) return;
          pushRelayDebug({ kind: "sub-event", relays, filter, eventKind: ev.kind });
          onevent(ev);
        },
        oneose: () => {
          // Same staleness guard as onevent — a late EOSE on a markClosed sub
          // would otherwise flip flags like `groupMetadataEose` for the new
          // relay based on the old relay's response.
          if (closed) { pushRelayDebug({ kind: "sub-stale-eose", relays, filter }); return; }
          pushRelayDebug({ kind: "sub-eose", relays, filter });
          alive = true;
          // Intentionally do NOT disarm here. EOSE alone is not proof of
          // success on auth-gated relays — they routinely send EOSE (empty
          // result) before CLOSED auth-required. Leaving `armed` true lets
          // the onclose handler below schedule a retry.
          clearTimer();
          if (AFFECTS_ACCESS) {
            for (const url of relays) this.setRelayAccess(url, 'ok');
          }
          oneose?.();
        },
        onclose: (reasons: string[]) => {
          // Stale onclose from the old pool's WebSocket finally tearing down
          // shouldn't update relay-access state or trigger retries against
          // the new pool. `scheduleRetry` already short-circuits via
          // `closed`, but bail early so we don't even classify reasons.
          if (closed) { pushRelayDebug({ kind: "sub-stale-close", relays, filter, payload: { reasons } }); return; }
          pushRelayDebug({ kind: "sub-close", relays, filter, payload: { reasons } });
          // nostr-tools fires onclose with one reason string per relay,
          // index-aligned with the `relays` array. Local closes look like
          // 'closed by caller' and yield no rejection match — we leave the
          // existing state alone in that case.
          let shouldRetry = false;
          let unknownClose = false;
          let quotaOrRateLimitClose = false;
          reasons.forEach((reason, i) => {
            if (!reason) return;
            const url = relays[i];
            const state = parseRelayRejection(reason);
            if (state) {
              if (state === 'auth-required' || state === 'restricted') {
                // A per-channel CLOSED ("you can't read this one") still
                // schedules a retry, but it does NOT update the relay-wide
                // banner — see AFFECTS_ACCESS comment above.
                if (AFFECTS_ACCESS) {
                  if (IMMEDIATE_ACCESS_DOWNGRADE) {
                    // Preflight path — surface "Not whitelisted" within the
                    // sub's own watchdog window, no 4s soak.
                    this.setRelayAccess(url, state, { override: true });
                  } else {
                    this.setRelayAccessDeferred(url, state);
                  }
                }
                shouldRetry = true;
              } else if (AFFECTS_ACCESS) {
                this.setRelayAccess(url, state);
              }
            } else if (isRelayQuotaOrRateLimit(reason)) {
              // Quota/rate-limit CLOSED means the relay is explicitly telling
              // us it cannot accept another live REQ. Retrying from every
              // watched sub turns a full connection into a retry storm, and
              // voice signaling is usually the first thing starved. Leave
              // recovery to the caller opening a fresh, higher-priority sub.
              quotaOrRateLimitClose = true;
            } else {
              // Reason carried but didn't classify. Treat it as a transient
              // transport close and retry with backoff.
              unknownClose = true;
            }
          });
          // Retry on auth-required/restricted immediately — EOSE-then-CLOSED
          // race. `scheduleRetry` short-circuits via `armed` if onevent
          // already succeeded or the watchdog already fired.
          if (shouldRetry) scheduleRetry(true);
          else if (unknownClose) scheduleRetry(false);
          else if (quotaOrRateLimitClose) {
            armed = false;
            clearTimer();
            try { activeSub?.close(); } catch { /* ignore */ }
            activeSub = null;
            options?.onQuotaOrRateLimitClose?.();
          }
        },
        onauth: wrappedSigner,
      });
      activeSub = sub;
      timer = setTimeout(onWatchdog, WATCHDOG_MS);
    };

    start();

    return {
      close: () => {
        if (closed) return;
        closed = true;
        clearTimer();
        // Only attempt the network CLOSE frame if the pool's socket is
        // still alive — calling close() on a dead WebSocket throws a
        // browser warning per sub ("WebSocket is already in CLOSING or
        // CLOSED state") that the try/catch can't suppress because it's
        // logged at the WebSocket layer, not raised as an exception.
        if (!isPoolSocketAlive()) {
          activeSub = null;
          return;
        }
        try { activeSub?.close(); } catch { /* ignore */ }
        activeSub = null;
      },
      // Emergency teardown for a socket that is already dead: stop local
      // retry logic without attempting another network CLOSE.
      markClosed: () => {
        closed = true;
        clearTimer();
        activeSub = null;
      },
    };
  }

  /**
   * Return a signing function suitable for `onauth` params in pool.subscribe
   * and pool.publish. When the relay sends CLOSED "auth-required:…" the pool
   * uses this to authenticate and retry the operation automatically.
   */
  /**
   * Sign an arbitrary event template with the active session's signer
   * (nsec → finalizeEvent, nip07 → window.nostr.signEvent). Used by callers
   * that need a signed event without publishing it — e.g. Blossom BUD-01
   * upload-auth events that travel in the HTTP Authorization header.
   */
  async signEventTemplate(
    template: { kind: number; content: string; tags: string[][]; created_at?: number },
  ): Promise<NostrEvent> {
    if (!this.session) throw new Error('Not logged in');
    const fullTemplate = {
      kind: template.kind,
      content: template.content,
      tags: template.tags,
      created_at: template.created_at ?? Math.floor(Date.now() / 1000),
      pubkey: this.session.pubKeyHex,
    } as EventTemplate & { pubkey: string };
    if (this.session.loginMethod === 'nsec' && this.session.privKeyHex) {
      const sk = hexToBytes(this.session.privKeyHex);
      return finalizeEvent(fullTemplate, sk) as NostrEvent;
    }
    if (this.session.loginMethod === 'nip07') {
      const win = (window as any).nostr;
      if (!win) throw new Error('NIP-07 extension unavailable');
      return await trackActivity(
        'Waiting for extension signature',
        () => win.signEvent(fullTemplate) as Promise<NostrEvent>,
        `kind ${template.kind}`,
      );
    }
    if (this.session.loginMethod === 'bunker') {
      const b = await this.ensureBunkerSigner();
      return await trackActivity(
        'Waiting for bunker signature',
        () => b.signEvent(fullTemplate) as Promise<NostrEvent>,
        `kind ${template.kind}`,
      );
    }
    throw new Error(`Login method ${this.session.loginMethod} cannot sign events in this build`);
  }

  private getAuthSigner(): ((evt: EventTemplate) => Promise<VerifiedEvent>) | undefined {
    if (!this.session) return undefined;
    return async (evt: EventTemplate): Promise<VerifiedEvent> => {
      if (this.session?.loginMethod === 'nsec' && this.session.privKeyHex) {
        const sk = hexToBytes(this.session.privKeyHex);
        return finalizeEvent(evt, sk) as VerifiedEvent;
      }
      // Surface NIP-42 AUTH prompts in the activity log so the
      // "Waiting for signature" toast persists for the entire round-trip
      // — without this, the only visible toast was "Publishing to relays"
      // even though the user was being asked to approve a sign in their
      // extension or bunker.
      if (this.session?.loginMethod === 'nip07') {
        const win = (window as any).nostr;
        if (!win) throw new Error('NIP-07 extension unavailable');
        return await trackActivity(
          'Waiting for extension signature',
          () => win.signEvent(evt) as Promise<VerifiedEvent>,
          'NIP-42 relay auth',
          { operation: 'sign', eventKind: evt.kind, description: eventKindDescription(evt.kind) },
        );
      }
      if (this.session?.loginMethod === 'bunker') {
        const b = await this.ensureBunkerSigner();
        return await trackActivity(
          'Waiting for bunker signature',
          () => b.signEvent(evt as unknown as EventTemplate & { pubkey: string }) as Promise<VerifiedEvent>,
          'NIP-42 relay auth',
          { operation: 'sign', eventKind: evt.kind, description: eventKindDescription(evt.kind) },
        );
      }
      throw new Error('Cannot sign auth event with current login method');
    };
  }

  /**
   * P0 whitelist preflight — fires a tight kind:0 `authors:[me]` REQ on the
   * active relay so an `auth-required:` or `restricted:` rejection downgrades
   * `relayAccess` within ~1.5s, well before the rest of the fan-out hits
   * the 4s deferred soak. EOSE on this filter is harmless (the relay
   * just doesn't have my kind:0 yet) and still flips `relayAccess` to
   * 'ok' through the standard onevent/oneose path.
   *
   * `maxAttempts: 1` so a rejection doesn't trigger exponential-backoff
   * retries that would extend the perceived rejection window.
   */
  private preflightRelayAccess(): void {
    if (!this.session) return;
    const filter: Filter = {
      kinds: [KIND_USER_METADATA],
      authors: [this.session.pubKeyHex],
      limit: 1,
    };
    let sub: { close: () => void; markClosed?: () => void } | undefined;
    sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => {
        this.ingestUserMetadata(ev);
        if (sub) this.closeTrackedSub(sub);
      },
      () => {
        // EOSE proves the relay accepted the query, but keep the preflight
        // handle alive until CLOSED/event so an immediate EOSE-then-CLOSED
        // auth-required can still downgrade relayAccess.
      },
      {
        watchdogMs: 1500,
        maxAttempts: 1,
        affectsRelayAccess: true,
        immediateAccessDowngrade: true,
      },
    );
    this.subs.push(sub);
  }

  /**
   * Reapply the per-group REQs captured by {@link resetPoolForSessionChange}.
   * The active group is bumped to the head of the messages list so that —
   * after a relay or session swap — the channel currently in view gets the
   * relay's first per-group response. No-op when there is no pending state.
   */
  private applyPendingResubscribe(
    pending: { messages: string[]; reactions: string[]; adminMember: string[]; metadata: string[] } | null,
  ): void {
    if (!pending) return;
    const messages = [...pending.messages];
    if (this.activeGroupId) {
      const idx = messages.indexOf(this.activeGroupId);
      if (idx > 0) {
        messages.splice(idx, 1);
        messages.unshift(this.activeGroupId);
      }
    }
    messages.forEach((id) => this.subscribeGroupMessages(id));
    pending.reactions.forEach((id) => this.subscribeGroupReactions(id));
    pending.adminMember.forEach((id) => this.subscribeAdminMember(id));
    pending.metadata.forEach((pk) => this.ensureUserMetadata(pk));
  }

  private subscribeGroupMetadata() {
    const filter: Filter = { kinds: [KIND_GROUP_METADATA] };
    const sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => this.ingestGroupMetadata(ev),
      () => this.handleGroupMetadataEose(),
    );
    this.subs.push(sub);
    return sub;
  }

  /**
   * Single relay-wide subscription for kinds 39001 (admins) and 39002
   * (members) with no `#d` filter. Replaces the per-group fan-out that
   * `ingestGroupMetadata` used to do on every kind 39000 — one REQ
   * instead of N. Used to bootstrap the channel-layout author set so
   * operator-or-admin-authored layouts paint without waiting for the
   * user to open every channel. The lazy per-group REQ on
   * useAdmins/useMembers still runs, and is idempotent.
   */
  private subscribeAllAdminMember(): void {
    const filter: Filter = { kinds: [KIND_GROUP_ADMINS, KIND_GROUP_MEMBERS] };
    const sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => this.ingestAdminMember(ev),
      undefined,
      { affectsRelayAccess: false },
    );
    this.subs.push(sub);
  }

  private closeTrackedSub(sub: { close: () => void; markClosed?: () => void } | undefined): void {
    if (!sub) return;
    try { sub.close(); } catch { /* ignore */ }
    this.subs = this.subs.filter((s) => s !== sub);
  }

  private closePerGroupSub(
    groupId: string,
    subscribed: Set<string>,
    byGroup: Map<string, { close: () => void; markClosed?: () => void }>,
  ): void {
    const sub = byGroup.get(groupId);
    this.closeTrackedSub(sub);
    byGroup.delete(groupId);
    subscribed.delete(groupId);
  }

  private forgetPerGroupSub(
    groupId: string,
    subscribed: Set<string>,
    byGroup: Map<string, { close: () => void; markClosed?: () => void }>,
  ): void {
    const sub = byGroup.get(groupId);
    if (sub) this.subs = this.subs.filter((s) => s !== sub);
    byGroup.delete(groupId);
    subscribed.delete(groupId);
  }

  /**
   * Mesh voice needs two live REQs on the active relay (presence + directed
   * signaling). Background message/creator streams are useful for snappy chat
   * preload, but on public relays with a 50-subscription cap they can consume
   * every slot before the user joins a call. When a mesh client starts, drop
   * non-active background group streams and pause future metadata fan-out so
   * the media signaling path can claim stable relay capacity.
   */
  private trimBackgroundSubscriptionsForVoice(channelId: string): void {
    const keep = new Set<string>([channelId]);
    if (this.activeGroupId) keep.add(this.activeGroupId);

    if (this.pendingMessageTimer) {
      clearTimeout(this.pendingMessageTimer);
      this.pendingMessageTimer = null;
    }
    this.pendingMessageQueue = this.pendingMessageQueue.filter((id) => keep.has(id));
    this.pendingMessageSet = new Set(this.pendingMessageQueue);

    for (const groupId of Array.from(this.messageSubByGroup.keys())) {
      if (keep.has(groupId)) continue;
      this.clearMessagesRetry(groupId);
      this.closePerGroupSub(groupId, this.messageSubscribedGroups, this.messageSubByGroup);
      this.closePerGroupSub(groupId, this.eventDeletionSubscribedGroups, this.eventDeletionSubByGroup);
      this.closePerGroupSub(groupId, this.groupModerationDeletionSubscribedGroups, this.groupModerationDeletionSubByGroup);
    }
    for (const groupId of Array.from(this.reactionSubByGroup.keys())) {
      if (keep.has(groupId)) continue;
      this.closePerGroupSub(groupId, this.reactionSubscribedGroups, this.reactionSubByGroup);
      this.closePerGroupSub(groupId, this.eventDeletionSubscribedGroups, this.eventDeletionSubByGroup);
    }
    for (const groupId of Array.from(this.creatorSubByGroup.keys())) {
      if (keep.has(groupId)) continue;
      this.closePerGroupSub(groupId, this.creatorSubscribedGroups, this.creatorSubByGroup);
    }
    for (const groupId of Array.from(this.adminMemberSubByGroup.keys())) {
      if (keep.has(groupId)) continue;
      this.closePerGroupSub(groupId, this.adminMemberSubscribedGroups, this.adminMemberSubByGroup);
    }
  }

  /**
   * Background entry-point used by {@link ingestGroupMetadata} for groups
   * the user has *not* explicitly opened. Defers the kind 9 REQ to a small
   * batch processed off-tick so the channel currently in view gets the
   * relay's first response. Already-subscribed and currently-active groups
   * are no-ops here — they're handled by direct {@link subscribeGroupMessages}
   * calls.
   */
  private queueGroupMessages(groupId: string): void {
    if (this.messageSubscribedGroups.has(groupId)) return;
    if (this.pendingMessageSet.has(groupId)) return;
    if (groupId === this.activeGroupId) {
      // The active group always gets its REQ immediately, even if metadata
      // arrived later than the user's click — this is the whole point of
      // the queue.
      this.subscribeGroupMessages(groupId);
      return;
    }
    if (this.backgroundMessageStreamCount() >= BridgeImpl.MAX_BACKGROUND_MESSAGE_STREAMS) return;
    this.pendingMessageSet.add(groupId);
    this.pendingMessageQueue.push(groupId);
    this.scheduleMessageQueueDrain();
  }

  private scheduleMessageQueueDrain(): void {
    if (this.pendingMessageTimer) return;
    // Strict active-channel priority: while the watched channel's kind 9
    // sub is still in `loading` (no EOSE, no events), hold all background
    // REQs back. The active sub's own EOSE / first-event handler calls
    // {@link maybeResumeMessageQueueDrain} to release the queue. Without
    // this gate, the relay's response queue interleaves the active
    // channel's history with N background channels' histories — making
    // the user wait visibly while watching one channel that already has
    // the data in flight.
    if (this.isActiveGroupStillLoading()) return;
    // Small delay so the active group's REQ (fired synchronously when the
    // user clicks a channel) lands before the relay sees a flood of
    // background REQs. Longer than a microtask so React's render commit
    // can settle first; short enough that background unread badges still
    // populate within ~1s on a heavy relay.
    this.pendingMessageTimer = setTimeout(() => {
      this.pendingMessageTimer = null;
      this.drainMessageQueue();
    }, 80);
  }

  /**
   * Re-arm the background drain when the active channel transitions out
   * of `loading` (its EOSE arrived, or its first event was ingested).
   * No-op if the queue is empty or the active channel is still loading.
   */
  private maybeResumeMessageQueueDrain(): void {
    if (this.pendingMessageQueue.length === 0) return;
    if (this.isActiveGroupStillLoading()) return;
    this.scheduleMessageQueueDrain();
  }

  /**
   * True iff the user is watching a channel whose kind 9 stream has not
   * yet produced either an EOSE or a message AND the priority deadline
   * has not yet elapsed. Used to gate background REQs so the watched
   * channel always gets the relay's first attention — but bounded by
   * {@link ACTIVE_PRIORITY_MAX_PAUSE_MS} so a silent active sub can't
   * starve every other channel.
   */
  private isActiveGroupStillLoading(): boolean {
    const id = this.activeGroupId;
    if (!id) return false;
    if (Date.now() >= this.activeGroupPriorityDeadline) return false;
    const status = this.messagesStatusByGroup.get()[id];
    return !status || status === 'loading';
  }

  private drainMessageQueue(): void {
    // Race guard: the active group's status may have flipped back to
    // 'loading' while the 80ms drain timer was pending (e.g. user clicked
    // a new channel just before the timer fired). Bail in that case;
    // {@link maybeResumeMessageQueueDrain} will pick up when the new
    // active channel's EOSE / first event lands.
    if (this.isActiveGroupStillLoading()) return;
    // Always promote the active group to the head of the queue if it
    // happens to be sitting in there — handles the case where the user
    // switched channels while a background batch was in flight.
    if (this.activeGroupId && this.pendingMessageSet.has(this.activeGroupId)) {
      this.pendingMessageSet.delete(this.activeGroupId);
      this.pendingMessageQueue = this.pendingMessageQueue.filter((id) => id !== this.activeGroupId);
      if (!this.messageSubscribedGroups.has(this.activeGroupId)) {
        this.subscribeGroupMessages(this.activeGroupId);
      }
    }
    const BATCH = 4;
    let processed = 0;
    while (this.pendingMessageQueue.length > 0 && processed < BATCH) {
      if (this.backgroundMessageStreamCount() >= BridgeImpl.MAX_BACKGROUND_MESSAGE_STREAMS) {
        this.pendingMessageQueue = [];
        this.pendingMessageSet.clear();
        break;
      }
      const id = this.pendingMessageQueue.shift()!;
      this.pendingMessageSet.delete(id);
      if (!this.messageSubscribedGroups.has(id)) {
        this.subscribeGroupMessages(id);
        processed++;
      }
    }
    if (this.pendingMessageQueue.length > 0) {
      this.scheduleMessageQueueDrain();
    }
  }

  private backgroundMessageStreamCount(): number {
    let count = 0;
    for (const groupId of this.messageSubscribedGroups) {
      if (groupId !== this.activeGroupId) count++;
    }
    return count;
  }

  /**
   * Move `groupId` to the head of the pending message queue (or fire its
   * REQ immediately if it isn't queued yet). Called by {@link setActiveGroup}
   * when the user clicks a channel — it ensures the channel currently in
   * view always wins the relay's attention, even if hundreds of other
   * groups are queued ahead of it from the kind 39000 fan-out.
   *
   * If the channel is already subscribed but hasn't loaded ("loading" /
   * "empty-unconfirmed" / "empty-confirmed"), the existing sub is torn
   * down and a fresh one is opened. The background drain typically
   * subscribes every visible channel from kind 39000 fan-out — those
   * subs land on a still-AUTH-ing socket and routinely get stuck in
   * the EOSE-then-CLOSED auth-required race. The user's click is the
   * canonical signal to retry from scratch with the active-channel
   * priority gate engaged. Channels in 'has-messages' are left alone —
   * a successful sub is delivering live updates and replacing it would
   * just churn the relay.
   */
  private bumpGroupMessagesPriority(groupId: string): void {
    if (this.messageSubscribedGroups.has(groupId)) {
      const status = this.messagesStatusByGroup.get()[groupId];
      if (status === 'has-messages') return;
      // Stuck — restart so the user's click gets a fresh REQ on the
      // (likely now AUTH'd) socket. refreshGroupMessages also resets
      // the retry counter and re-arms the querySync fallback flag.
      this.refreshGroupMessages(groupId);
      // Defense in depth: fire a parallel `querySync` immediately,
      // don't wait for the retry ladder to exhaust. The live REQ
      // restart above sometimes wedges on the same conditions that
      // had the previous sub stuck (relay-side per-REQ AUTH quirks,
      // SimplePool dedup of identical filters on the same socket,
      // etc.). A querySync goes out as a separate frame and has its
      // own response window — events it returns flow through
      // ingestMessage and unstick the chat pane without the user
      // having to refresh the page.
      this.querySyncFallbackFired.add(groupId);
      void this.querySyncFallbackForGroup(groupId);
      return;
    }
    if (this.pendingMessageSet.has(groupId)) {
      this.pendingMessageSet.delete(groupId);
      this.pendingMessageQueue = this.pendingMessageQueue.filter((id) => id !== groupId);
    }
    this.subscribeGroupMessages(groupId);
  }

  private subscribeGroupMessages(groupId: string): void {
    if (this.messageSubscribedGroups.has(groupId)) return;
    this.messageSubscribedGroups.add(groupId);
    // Initial status: if the bridge already has cached messages for this
    // group (e.g. a returning subscriber after a relay switch), keep
    // 'has-messages'; otherwise enter 'loading' so the UI shows a spinner
    // until the bridge confirms emptiness or events arrive.
    const seedMsgs = this.messagesByGroup.get()[groupId] ?? [];
    this.setMessagesStatus(groupId, seedMsgs.length > 0 ? 'has-messages' : 'loading');
    const filter: Filter = {
      kinds: [KIND_GROUP_MESSAGE, KIND_EVENT_DELETION, KIND_GROUP_DELETE_EVENT],
      '#h': [groupId],
      limit: BACKGROUND_MESSAGE_LIMIT,
    };
    const sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => {
        if (ev.kind === KIND_GROUP_MESSAGE) this.ingestMessage(groupId, ev);
        else if (ev.kind === KIND_EVENT_DELETION) this.ingestEventDeletion(groupId, ev);
        else if (ev.kind === KIND_GROUP_DELETE_EVENT) this.ingestGroupEventDeletion(groupId, ev);
      },
      () => {
        // Decide confidence: events already ingested? Trust the relay
        // and stop retrying. Empty? Drop to 'empty-unconfirmed' and let
        // the retry ladder run before the UI ever sees "No messages".
        const msgs = this.messagesByGroup.get()[groupId] ?? [];
        if (msgs.length > 0) {
          this.setMessagesStatus(groupId, 'has-messages');
          this.clearMessagesRetry(groupId);
        } else if (this.messagesStatusByGroup.get()[groupId] !== 'empty-confirmed') {
          // Once the ladder has promoted status to `empty-confirmed`, additional
          // empty EOSEs (typically caused by `subscribeWatched` re-issuing the
          // REQ after an `auth-required` CLOSED race) MUST NOT bounce status
          // back to `empty-unconfirmed` — that would restart the ladder and the
          // UI would oscillate "No messages yet" ↔ "Loading messages…" forever.
          // A late real message still promotes status via `ingestMessage →
          // setMessagesStatus('has-messages')`, so this doesn't trap a stale
          // empty verdict against future arrivals.
          this.setMessagesStatus(groupId, 'empty-unconfirmed');
          this.scheduleEmptyRetry(groupId);
        }
        // If this is the watched channel, release any background REQs we
        // were holding back to give it priority bandwidth.
        if (groupId === this.activeGroupId) this.maybeResumeMessageQueueDrain();
      },
      {
        affectsRelayAccess: false,
        onQuotaOrRateLimitClose: () => {
          this.clearMessagesRetry(groupId);
          this.forgetPerGroupSub(groupId, this.messageSubscribedGroups, this.messageSubByGroup);
        },
      },
    );
    this.subs.push(sub);
    this.messageSubByGroup.set(groupId, sub);
  }

  /**
   * Write `status` to `messagesStatusByGroup[groupId]` only if it changed,
   * so React subscribers don't churn on redundant writes.
   */
  private setMessagesStatus(groupId: string, status: MessagesStatus): void {
    this.messagesStatusByGroup.update((prev) => {
      if (prev[groupId] === status) return prev;
      return { ...prev, [groupId]: status };
    });
  }

  /**
   * Drop any pending retry timer for `groupId`. Called when a message
   * arrives (we've proven the channel isn't empty), when the user logs
   * out / switches relay (the sub is going away), and when the retry
   * ladder is exhausted.
   */
  private clearMessagesRetry(groupId: string): void {
    const entry = this.messagesRetryByGroup.get(groupId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.messagesRetryByGroup.delete(groupId);
  }

  private clearGroupMetadataEmptyRetry(): void {
    if (this.groupMetadataEmptyRetryTimer) {
      clearTimeout(this.groupMetadataEmptyRetryTimer);
      this.groupMetadataEmptyRetryTimer = null;
    }
    this.groupMetadataEmptyRetryAttempts = 0;
  }

  private handleGroupMetadataEose(): void {
    if (this.groups.get().length > 0) {
      this.clearGroupMetadataEmptyRetry();
      this.groupMetadataEose.set(true);
      return;
    }
    if (this.groupMetadataEmptyRetryAttempts >= BridgeImpl.GROUP_METADATA_EMPTY_RETRY_DELAYS.length) {
      this.clearGroupMetadataEmptyRetry();
      this.groupMetadataEose.set(true);
      return;
    }
    this.groupMetadataEose.set(false);
    const delay = BridgeImpl.GROUP_METADATA_EMPTY_RETRY_DELAYS[this.groupMetadataEmptyRetryAttempts];
    this.groupMetadataEmptyRetryAttempts += 1;
    if (this.groupMetadataEmptyRetryTimer) clearTimeout(this.groupMetadataEmptyRetryTimer);
    this.groupMetadataEmptyRetryTimer = setTimeout(() => {
      this.groupMetadataEmptyRetryTimer = null;
      void this.querySyncFallbackForGroupMetadata();
    }, delay);
  }

  private async querySyncFallbackForGroupMetadata(): Promise<void> {
    if (!this.session) return;
    const relay = this.currentRelayUrl.get();
    const pool = this.pool;
    const relays = [...this.relays];
    let events: NostrEvent[];
    try {
      events = await pool.querySync(relays, { kinds: [KIND_GROUP_METADATA] }, { maxWait: 6000 });
    } catch {
      if (!this.session || this.currentRelayUrl.get() !== relay || this.pool !== pool) return;
      this.handleGroupMetadataEose();
      return;
    }
    if (!this.session || this.currentRelayUrl.get() !== relay || this.pool !== pool) return;
    for (const ev of events) this.ingestGroupMetadata(ev);
    if (this.groups.get().length > 0) {
      this.clearGroupMetadataEmptyRetry();
      this.groupMetadataEose.set(true);
      return;
    }
    this.handleGroupMetadataEose();
  }

  /**
   * Drop every pending retry timer. Called on logout / pool reset /
   * relay switch — pending retries are tied to the old pool's filters.
   */
  private clearAllMessagesRetry(): void {
    for (const entry of this.messagesRetryByGroup.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.messagesRetryByGroup.clear();
  }

  /**
   * Schedule a debounced write of `messagesByGroup[groupId]` to the
   * stale-while-revalidate cache. A burst of ingest calls (e.g. the
   * initial kind 9 limit:50 backfill) collapses into a single
   * localStorage.setItem at the end of the burst — cheap, and the
   * worst-case data loss on tab close is whatever arrived in the last
   * 200ms which the relay will re-deliver next session anyway.
   *
   * No-ops while logged out so a late ingest (e.g. an in-flight event on
   * a markClosed sub from the previous session) can't write under the
   * old account's relay key. See `cacheClearAll` on logout.
   */
  private scheduleMessageCacheFlush(groupId: string): void {
    if (!this.session) return;
    const existing = this.messageCacheFlushTimers.get(groupId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.messageCacheFlushTimers.delete(groupId);
      this.flushMessageCache(groupId);
    }, CACHE_FLUSH_DELAY_MS);
    this.messageCacheFlushTimers.set(groupId, timer);
  }

  /**
   * Synchronous write of the last {@link MESSAGE_CACHE_LIMIT} confirmed
   * messages for `groupId` to localStorage. Filters out optimistic
   * placeholders — a cached pending bubble would resurrect on cold load
   * even though the publish actually finished hours ago.
   */
  private flushMessageCache(groupId: string): void {
    if (!this.session) return;
    const all = this.messagesByGroup.get()[groupId] ?? [];
    const confirmed = all.filter((m) => !m.pending && !m.failed);
    if (confirmed.length === 0) {
      // Nothing worth caching (only optimistic placeholders, or store
      // emptied between schedule and flush). Drop any stale on-disk entry
      // so a previous larger snapshot doesn't ghost-paint after the user
      // saw the channel empty.
      cacheDelete(this.currentRelayUrl.get(), KIND_GROUP_MESSAGE, groupId);
      return;
    }
    const trimmed = confirmed.length > MESSAGE_CACHE_LIMIT
      ? confirmed.slice(confirmed.length - MESSAGE_CACHE_LIMIT)
      : confirmed;
    cacheSet(this.currentRelayUrl.get(), KIND_GROUP_MESSAGE, groupId, trimmed);
  }

  /** Mirror of {@link scheduleMessageCacheFlush} for kind 7 reactions. */
  private scheduleReactionCacheFlush(groupId: string): void {
    if (!this.session) return;
    const existing = this.reactionCacheFlushTimers.get(groupId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.reactionCacheFlushTimers.delete(groupId);
      this.flushReactionCache(groupId);
    }, CACHE_FLUSH_DELAY_MS);
    this.reactionCacheFlushTimers.set(groupId, timer);
  }

  /**
   * Synchronous write of the reaction map for `groupId`. Caps total
   * reactions at {@link REACTION_CACHE_LIMIT} by dropping the oldest by
   * `createdAt`. Cheaper than per-target caps and avoids favouring a
   * single high-reaction message.
   */
  private flushReactionCache(groupId: string): void {
    if (!this.session) return;
    const byTarget = this.reactionsByGroup.get()[groupId];
    if (!byTarget) {
      cacheDelete(this.currentRelayUrl.get(), KIND_REACTION, groupId);
      return;
    }
    let total = 0;
    for (const arr of Object.values(byTarget)) total += arr.length;
    if (total === 0) {
      cacheDelete(this.currentRelayUrl.get(), KIND_REACTION, groupId);
      return;
    }
    let toCache: Record<string, JsReaction[]> = byTarget;
    if (total > REACTION_CACHE_LIMIT) {
      const flat: JsReaction[] = [];
      for (const arr of Object.values(byTarget)) flat.push(...arr);
      flat.sort((a, b) => a.createdAt - b.createdAt);
      const kept = flat.slice(flat.length - REACTION_CACHE_LIMIT);
      const regrouped: Record<string, JsReaction[]> = {};
      for (const r of kept) {
        const cur = regrouped[r.targetEventId] ?? [];
        regrouped[r.targetEventId] = [...cur, r];
      }
      toCache = regrouped;
    }
    cacheSet(this.currentRelayUrl.get(), KIND_REACTION, groupId, toCache);
  }

  /**
   * Drop every pending cache-flush timer. Called on logout / dispose /
   * relay switch so a debounce that armed under the previous relay can't
   * fire after `currentRelayUrl` flipped and write to the wrong key.
   */
  private clearAllCacheFlushers(): void {
    for (const t of this.messageCacheFlushTimers.values()) clearTimeout(t);
    this.messageCacheFlushTimers.clear();
    for (const t of this.reactionCacheFlushTimers.values()) clearTimeout(t);
    this.reactionCacheFlushTimers.clear();
  }

  /**
   * Empty-EOSE retry ladder. Auth-gated and silent-filtering relays
   * routinely send EOSE-empty fast (before AUTH completes, or after a
   * NIP-29 ACL filter dropped every event). Without this, the UI flashes
   * "No messages yet" on a channel that genuinely has history.
   *
   * Each call advances the attempt counter. After
   * {@link EMPTY_RETRY_DELAYS}.length attempts the status is promoted to
   * `empty-confirmed`. If a message arrives at any point, the timer is
   * cancelled and status flips to `has-messages`.
   */
  private scheduleEmptyRetry(groupId: string): void {
    if (!this.session) return; // logged out — drop the work
    const prior = this.messagesRetryByGroup.get(groupId);
    const attempts = prior?.attempts ?? 0;
    if (attempts >= BridgeImpl.EMPTY_RETRY_DELAYS.length) {
      // Hold off on the verdict while NIP-42 AUTH is still in flight on
      // the active relay. The user might be staring at their NIP-46
      // bunker waiting to tap "approve" — the chat pane should keep
      // showing the spinner (status = 'empty-unconfirmed' is the right
      // signal for that), not flip to "No messages yet" and bait them
      // into thinking the channel is empty. When AUTH settles,
      // {@link wireAuthSettledHook} fires a fresh REQ via
      // refreshGroupMessages and the verdict will be re-evaluated then.
      // Failed AUTH states ('auth-required', 'restricted', etc.) bypass
      // the gate — there the relay banner explains the situation and
      // 'empty-confirmed' is honest.
      const relay = this.currentRelayUrl.get();
      const access = this.relayAccess.get()[relay];
      if (access === 'unknown' || access === 'authenticating') {
        this.clearMessagesRetry(groupId);
        return;
      }
      this.setMessagesStatus(groupId, 'empty-confirmed');
      this.clearMessagesRetry(groupId);
      // Last shot: fire one focused `querySync` for this channel. The
      // live REQ has exhausted its retries against the EOSE-then-CLOSED
      // auth-required race; a fresh querySync goes out as a separate
      // request, by which point the relay's AUTH / whitelist evaluation
      // for this socket has had time to settle. If it returns events,
      // {@link ingestMessage} flips status from `empty-confirmed` back
      // to `has-messages`. If it returns empty, the verdict stands.
      // Single-shot per groupId per session — `refreshGroupMessages`
      // clears the flag so an explicit user retry gets another shot.
      if (!this.querySyncFallbackFired.has(groupId)) {
        this.querySyncFallbackFired.add(groupId);
        void this.querySyncFallbackForGroup(groupId);
      }
      return;
    }
    const delay = BridgeImpl.EMPTY_RETRY_DELAYS[attempts];
    if (prior?.timer) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      const entry = this.messagesRetryByGroup.get(groupId);
      if (!entry) return; // cleared by a concurrent message / logout
      entry.timer = null;
      entry.attempts += 1;
      this.messagesRetryByGroup.set(groupId, entry);
      // If a message arrived between scheduling and firing, the entry
      // would already be cleared by `clearMessagesRetry`. Guard anyway.
      const msgs = this.messagesByGroup.get()[groupId] ?? [];
      if (msgs.length > 0) {
        this.setMessagesStatus(groupId, 'has-messages');
        this.clearMessagesRetry(groupId);
        return;
      }
      // Restart the sub so the relay sees a fresh REQ — most likely to
      // unstick auth-gated relays whose AUTH handshake finished after
      // the initial EOSE-empty.
      this.internalRestartMessageSub(groupId);
    }, delay);
    this.messagesRetryByGroup.set(groupId, { attempts, timer });
  }

  /**
   * Cold-load fallback for the kind 9 stream. Fires after the retry
   * ladder has exhausted (status is currently `empty-confirmed`). Sends
   * one focused `pool.querySync` with a longer maxWait than the live
   * REQ retries used, so the relay gets a final chance to serve history
   * once AUTH and whitelist evaluation have had time to settle.
   *
   * On success: events are ingested through {@link ingestMessage}, which
   * flips status to `has-messages`, clears the retry tracking, AND
   * triggers a cache write so subsequent reloads paint instantly.
   * On empty / error: the `empty-confirmed` verdict already set by the
   * caller stands — no further action needed.
   */
  private async querySyncFallbackForGroup(groupId: string): Promise<void> {
    if (!this.session) return;
    const filter: Filter = {
      kinds: [KIND_GROUP_MESSAGE],
      '#h': [groupId],
      limit: BACKGROUND_MESSAGE_LIMIT,
    };
    let events: NostrEvent[];
    try {
      events = await this.pool.querySync(this.relays, filter, { maxWait: 6000 });
    } catch {
      return;
    }
    // Session may have ended between dispatch and resolution — silently
    // drop any results that arrived for a dead pool. Also bail if the
    // user has since switched to a different active channel and an
    // unrelated path already flipped status (don't fight ingest races).
    if (!this.session) return;
    if (events.length === 0) return;
    for (const ev of events) this.ingestMessage(groupId, ev);
  }

  /**
   * Close any existing kind 9 sub for `groupId` and open a fresh one.
   * Does NOT reset the retry counter — used by both the retry ladder
   * (continuing attempts) and {@link refreshGroupMessages} (which resets
   * the counter before calling this).
   */
  private internalRestartMessageSub(groupId: string): void {
    if (!this.session) return;
    const existing = this.messageSubByGroup.get(groupId);
    if (existing) {
      try {
        // `close()` only — do NOT also call `markClosed()`. Both run
        // synchronously and `markClosed` zeros `activeSub` before
        // `close()` can hand it the network CLOSE frame, leaving the
        // old REQ alive on the pool. The result: every restart left
        // a zombie kind-9 sub hammering the relay, AND the user's
        // click was answered by whichever sub the relay served next
        // (frequently the stuck one, since it had been waiting first).
        // markClosed is only correct for pool-replacement paths
        // (resetPoolForSessionChange / switchRelay / dispose) where
        // the WebSocket is going away wholesale.
        existing.close();
      } catch {
        // ignore — relay may already have torn the socket down
      }
      this.messageSubByGroup.delete(groupId);
      this.subs = this.subs.filter((s) => s !== existing);
    }
    this.messageSubscribedGroups.delete(groupId);
    this.seedCachedMessagesForGroup(this.currentRelayUrl.get(), groupId);
    const seedMsgs = this.messagesByGroup.get()[groupId] ?? [];
    this.setMessagesStatus(groupId, seedMsgs.length > 0 ? 'has-messages' : 'loading');
    this.subscribeGroupMessages(groupId);
  }

  /**
   * Force-restart the kind 9 subscription for `groupId` and reset the
   * empty-EOSE retry counter so the user gets a fresh budget of attempts.
   * Use when an external surface needs to recover a stale-empty channel
   * (e.g. a "Reload" button). The active-group switch path also calls
   * this implicitly via {@link setActiveGroup} when re-entering an
   * empty-confirmed channel.
   */
  refreshGroupMessages(groupId: string): void {
    if (!groupId) return;
    this.clearMessagesRetry(groupId);
    // An explicit user-driven refresh should also re-arm the querySync
    // fallback — otherwise a channel that was already declared
    // `empty-confirmed` (and fallback-fired) in this session would never
    // get a second querySync shot from a "Reload" tap.
    this.querySyncFallbackFired.delete(groupId);
    this.internalRestartMessageSub(groupId);
  }

  private subscribeKind0(pubkey: string): void {
    const filter: Filter = { kinds: [KIND_USER_METADATA], authors: [pubkey] };
    // Active-relay profile REQs are bounded one-shots. External profile
    // relays are queried separately as querySync one-shots below.
    let sub: { close: () => void; markClosed?: () => void } | undefined;
    sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => this.ingestUserMetadata(ev, { cacheRelayScoped: true }),
      () => {
        if (sub) this.closeTrackedSub(sub);
      },
      { watchdogMs: 3000, maxAttempts: 2, affectsRelayAccess: false },
    );
    this.subs.push(sub);
    const cached = getCachedKind0(pubkey);
    if (cached) this.ingestUserMetadata(cachedKind0ToEvent(cached), { cacheRelayScoped: false });
    void this.lookupExternalUserMetadata(pubkey);
  }

  private getProfileLookupRelays(): string[] {
    if (typeof window === 'undefined') return Array.from(DEFAULT_PROFILE_LOOKUP_RELAYS);
    try {
      const raw = window.localStorage.getItem(PROFILE_LOOKUP_RELAYS_KEY);
      if (!raw) return Array.from(DEFAULT_PROFILE_LOOKUP_RELAYS);
      const parsed = JSON.parse(raw) as string[];
      const imported = Array.isArray(parsed) ? parsed.filter(isImportableRelayUrl) : [];
      return imported.length > 0 ? uniqueRelayUrls(imported) : Array.from(DEFAULT_PROFILE_LOOKUP_RELAYS);
    } catch {
      return Array.from(DEFAULT_PROFILE_LOOKUP_RELAYS);
    }
  }

  private async findNewestOwnProfileFromLookupRelays(pubkey: string): Promise<NostrEvent | null> {
    const relays = uniqueRelayUrls([...this.getProfileLookupRelays(), ...this.relays]);
    const events = await this.pool.querySync(
      relays,
      { kinds: [KIND_USER_METADATA], authors: [pubkey], limit: 5 },
      { maxWait: PROFILE_LOOKUP_MAX_WAIT_MS },
    );
    return newestEvent(events.filter((e) => e.kind === KIND_USER_METADATA && e.pubkey === pubkey));
  }

  private async publishSignedEventToRelays(ev: NostrEvent, relays: readonly string[]): Promise<string[]> {
    const targets = uniqueRelayUrls(Array.from(relays));
    const publishes = this.pool.publish(targets, ev, { onauth: this.getAuthSigner() });
    const results = await Promise.allSettled(publishes);
    return targets.filter((_, i) => results[i]?.status === 'fulfilled');
  }

  private async syncOwnProfileToActiveRelay(reason: 'login' | 'switch' | 'edit' | 'manual'): Promise<void> {
    if (!this.session) return;
    const me = this.session.pubKeyHex;
    const state = loadProfileSyncState();
    let cached = getCachedKind0(me);
    const now = Date.now();
    const lastLookup = state.ownProfileLookupAt[me] ?? 0;
    const shouldLookup = !cached || now - lastLookup >= OWN_PROFILE_LOOKUP_TTL_MS || reason === 'manual' || reason === 'edit';
    if (shouldLookup) {
      try {
        const newest = await this.findNewestOwnProfileFromLookupRelays(me);
        state.ownProfileLookupAt[me] = now;
        if (newest) {
          setCachedKind0(newest);
          cached = toCachedKind0(newest);
          this.ingestUserMetadata(newest, { cacheRelayScoped: false });
        }
      } catch {
        state.ownProfileLookupAt[me] = now;
      }
      saveProfileSyncState(state);
    }
    if (!cached) return;
    const relay = this.currentRelayUrl.get();
    const key = profileRelayKey(me, relay);
    if ((state.ownProfileSyncedToRelay[key] ?? 0) >= cached.created_at) return;
    const ok = await this.publishSignedEventToRelays(cachedKind0ToEvent(cached), [relay]);
    if (ok.length > 0) {
      const next = loadProfileSyncState();
      next.ownProfileLookupAt[me] = state.ownProfileLookupAt[me] ?? lastLookup;
      next.ownProfileSyncedToRelay[key] = cached.created_at;
      saveProfileSyncState(next);
    }
  }

  private async lookupExternalUserMetadata(pubkey: string): Promise<void> {
    const now = Date.now();
    const state = this.session?.pubKeyHex === pubkey ? loadProfileSyncState() : null;
    const last = state?.ownProfileLookupAt[pubkey] ?? this.profileLookupAt.get(pubkey) ?? 0;
    const ttl = this.session?.pubKeyHex === pubkey ? OWN_PROFILE_LOOKUP_TTL_MS : OTHER_PROFILE_LOOKUP_TTL_MS;
    if (now - last < ttl) return;
    const inFlight = this.profileLookupInFlight.get(pubkey);
    if (inFlight) return inFlight;
    const p = (async () => {
      this.profileLookupAt.set(pubkey, now);
      try {
        const events = await this.pool.querySync(
          this.getProfileLookupRelays(),
          { kinds: [KIND_USER_METADATA], authors: [pubkey], limit: 5 },
          { maxWait: PROFILE_LOOKUP_MAX_WAIT_MS },
        );
        if (state) {
          const next = loadProfileSyncState();
          next.ownProfileLookupAt[pubkey] = now;
          saveProfileSyncState(next);
        }
        const newest = newestEvent(events.filter((e) => e.kind === KIND_USER_METADATA && e.pubkey === pubkey));
        if (!newest) return;
        setCachedKind0(newest);
        this.ingestUserMetadata(newest, { cacheRelayScoped: false });
      } catch {
        if (state) {
          const next = loadProfileSyncState();
          next.ownProfileLookupAt[pubkey] = now;
          saveProfileSyncState(next);
        }
        // best-effort only
      } finally {
        this.profileLookupInFlight.delete(pubkey);
      }
    })();
    this.profileLookupInFlight.set(pubkey, p);
    return p;
  }

  private subscribeGroupReactions(groupId: string): void {
    if (this.reactionSubscribedGroups.has(groupId)) return;
    this.reactionSubscribedGroups.add(groupId);
    const reactionFilter: Filter = { kinds: [KIND_REACTION], '#h': [groupId], limit: 500 };
    const reactionSub = this.subscribeWatched(
      this.relays,
      reactionFilter,
      (ev) => this.ingestReaction(groupId, ev),
      undefined,
      {
        watchdogMs: 3000,
        affectsRelayAccess: false,
        onQuotaOrRateLimitClose: () => {
          this.forgetPerGroupSub(groupId, this.reactionSubscribedGroups, this.reactionSubByGroup);
        },
      },
    );
    this.subs.push(reactionSub);
    this.reactionSubByGroup.set(groupId, reactionSub);
    this.subscribeGroupEventDeletions(groupId);
  }

  private subscribeGroupEventDeletions(groupId: string): void {
    if (this.eventDeletionSubscribedGroups.has(groupId)) return;
    this.eventDeletionSubscribedGroups.add(groupId);
    const deletionFilter: Filter = { kinds: [KIND_EVENT_DELETION], '#h': [groupId], limit: 500 };
    const deletionSub = this.subscribeWatched(
      this.relays,
      deletionFilter,
      (ev) => this.ingestEventDeletion(groupId, ev),
      undefined,
      {
        watchdogMs: 3000,
        affectsRelayAccess: false,
        onQuotaOrRateLimitClose: () => {
          this.forgetPerGroupSub(groupId, this.eventDeletionSubscribedGroups, this.eventDeletionSubByGroup);
        },
      },
    );
    this.subs.push(deletionSub);
    this.eventDeletionSubByGroup.set(groupId, deletionSub);
  }

  private subscribeGroupModerationDeletions(groupId: string): void {
    if (this.groupModerationDeletionSubscribedGroups.has(groupId)) return;
    this.groupModerationDeletionSubscribedGroups.add(groupId);
    const deletionFilter: Filter = { kinds: [KIND_GROUP_DELETE_EVENT], '#h': [groupId], limit: 500 };
    const deletionSub = this.subscribeWatched(
      this.relays,
      deletionFilter,
      (ev) => this.ingestGroupEventDeletion(groupId, ev),
      undefined,
      {
        watchdogMs: 3000,
        affectsRelayAccess: false,
        onQuotaOrRateLimitClose: () => {
          this.forgetPerGroupSub(
            groupId,
            this.groupModerationDeletionSubscribedGroups,
            this.groupModerationDeletionSubByGroup,
          );
        },
      },
    );
    this.subs.push(deletionSub);
    this.groupModerationDeletionSubByGroup.set(groupId, deletionSub);
  }

  private subscribeAdminMember(groupId: string): void {
    if (this.adminMemberSubscribedGroups.has(groupId)) return;
    this.adminMemberSubscribedGroups.add(groupId);
    const filter: Filter = {
      kinds: [KIND_GROUP_ADMINS, KIND_GROUP_MEMBERS],
      '#d': [groupId],
    };
    const sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => this.ingestAdminMember(ev),
      undefined,
      {
        affectsRelayAccess: false,
        onQuotaOrRateLimitClose: () => {
          this.forgetPerGroupSub(groupId, this.adminMemberSubscribedGroups, this.adminMemberSubByGroup);
        },
      },
    );
    this.subs.push(sub);
    this.adminMemberSubByGroup.set(groupId, sub);
  }

  /**
   * Subscribe to the kind 9007 (create-group) event for `groupId` so we know
   * who originally created the channel. The author of that event is the
   * canonical creator and is used by {@link claimCreatorAdmin} to decide
   * whether to publish a one-shot kind 9000 admin claim — without this, we
   * would have to either trust the relay to auto-promote (many don't) or
   * blindly publish a kind 9000 admin for every group on every login (the
   * exact spam this refactor exists to eliminate).
   */
  private subscribeGroupCreator(groupId: string): void {
    if (this.creatorSubscribedGroups.has(groupId)) return;
    this.creatorSubscribedGroups.add(groupId);
    const filter: Filter = { kinds: [KIND_GROUP_CREATE], '#h': [groupId], limit: 1 };
    const sub = this.subscribeWatched(
      this.relays,
      filter,
      (ev) => this.ingestGroupCreator(ev),
      undefined,
      {
        affectsRelayAccess: false,
        onQuotaOrRateLimitClose: () => {
          this.forgetPerGroupSub(groupId, this.creatorSubscribedGroups, this.creatorSubByGroup);
        },
      },
    );
    this.subs.push(sub);
    this.creatorSubByGroup.set(groupId, sub);
  }

  /**
   * Single-REQ pull of every kind 9007 the local user has signed on this
   * relay. Per-group subs cover the general case but rate-limit-shaped
   * relays sometimes drop the burst of 1k+ per-group filters at once,
   * leaving the user's own channels without a known creator. This
   * authors-scoped filter is one REQ regardless of group count and
   * populates `groupCreators` for every group the user actually created
   * — the load-bearing input for the WoT rail's "show my own channels"
   * exemption.
   */
  private subscribeMyAuthoredGroups(): void {
    if (!this.session) return;
    const filter: Filter = { kinds: [KIND_GROUP_CREATE], authors: [this.session.pubKeyHex] };
    const sub = this.subscribeWatched(this.relays, filter, (ev) => this.ingestGroupCreator(ev));
    this.subs.push(sub);
  }

  private ingestGroupCreator(ev: NostrEvent): void {
    const groupId = getTag(ev, 'h');
    if (!groupId) return;
    // Newest-wins isn't meaningful for kind 9007 (a group is created exactly
    // once), but we still guard against mid-flight duplicates so we don't
    // thrash the store.
    const prev = this.groupCreators.get()[groupId];
    if (prev === ev.pubkey) return;
    this.groupCreators.update((m) => ({ ...m, [groupId]: ev.pubkey }));
    cacheSet(this.currentRelayUrl.get(), KIND_GROUP_CREATE, groupId, ev.pubkey);
  }

  private ingestAdminMember(ev: NostrEvent): void {
    const groupId = getTag(ev, 'd');
    if (!groupId) return;
    // Drop older revisions arriving out-of-order from slower relays. Without
    // this, admins/members lists oscillate as different relays return
    // different snapshots and the React UI flickers (gear icon disappears,
    // members rail empties, etc.) until a refresh.
    const cacheKey = `${ev.kind}:${groupId}`;
    const prevAt = this.adminMemberLatestAt.get(cacheKey) ?? 0;
    if (ev.created_at <= prevAt) return;
    this.adminMemberLatestAt.set(cacheKey, ev.created_at);

    const pubkeys = getAllTags(ev, 'p');
    const store = ev.kind === KIND_GROUP_ADMINS ? this.adminsByGroup : this.membersByGroup;
    store.update((prev) => ({ ...prev, [groupId]: pubkeys }));
    // Persist for next reload — paints instantly before the relay round-trip
    // completes. See cache.ts. Scoped by relay so cross-relay browsing
    // doesn't leak admin lists. Skip the write if the list matches what's
    // already on disk — relays republish identical 39001/39002 events
    // routinely after a reconnect, and localStorage.setItem is a
    // main-thread blocker we'd rather avoid.
    const relay = this.currentRelayUrl.get();
    const cached = cacheGet<string[]>(relay, ev.kind, groupId);
    if (!cached || !arraysEqualStrict(cached.value, pubkeys)) {
      cacheSet(relay, ev.kind, groupId, pubkeys);
    }
    // Positive signal: the relay has delivered membership data for this
    // group, even if the list is empty. Consumers (voice gate) can now
    // distinguish "not loaded yet" from "loaded and you're not in it".
    this.membershipReadyByGroup.update((prev) =>
      prev[groupId] ? prev : { ...prev, [groupId]: true },
    );
    pubkeys.forEach((pk) => this.ensureUserMetadata(pk));
  }

  private subscribeMyMuteList(): void {
    if (!this.session) return;
    const filter: Filter = { kinds: [KIND_MUTE_LIST], authors: [this.session.pubKeyHex], limit: 1 };
    // Like kind 3, mute lists may live on profile/outbox relays. Do not keep
    // persistent external subscriptions open during normal server browsing.
    let latestCreatedAt = 0;
    const sub = this.subscribeWatched(this.relays, filter, (ev) => {
      if (ev.created_at <= latestCreatedAt) return;
      latestCreatedAt = ev.created_at;
      this.myMutes.set(getAllTags(ev, 'p'));
    });
    this.subs.push(sub);
  }

  /**
   * Global subscriptions for voice-channel liveness. SFU calls publish kind
   * 31314 active-call announcements; mesh calls publish short-lived kind
   * 20078 presence beacons. Both feed activeCallByChannel so desktop
   * and mobile channel rows can render one consistent LIVE indicator.
   *
   * affectsRelayAccess: false because absence of live-call traffic is
   * normal and should not influence the relay-wide AUTH banner.
   */
  private subscribeActiveCalls(): void {
    const sfuSub = this.subscribeWatched(
      this.relays,
      { kinds: [KIND_SFU_ACTIVE_CALL] },
      (ev) => this.ingestActiveCall(ev),
      undefined,
      { affectsRelayAccess: false },
    );
    this.subs.push(sfuSub);

    const meshSub = this.subscribeWatched(
      this.relays,
      { kinds: [KIND_VOICE_PRESENCE] } as Filter,
      (ev) => this.ingestMeshVoicePresence(ev),
      undefined,
      { affectsRelayAccess: false },
    );
    this.subs.push(meshSub);
    this.ensureMeshPresenceSweep();
  }

  private parseSfuParticipantPubkeys(ev: NostrEvent): string[] {
    const fromTags = getAllTags(ev, 'p');
    let fromContent: string[] = [];
    if (ev.content.trim().length > 0) {
      try {
        const parsed = JSON.parse(ev.content) as { participants?: unknown };
        if (Array.isArray(parsed?.participants)) {
          fromContent = parsed.participants.filter((pk): pk is string => typeof pk === 'string' && pk.length > 0);
        }
      } catch {
        // Older SFU builds used empty content; malformed content should not
        // discard the tag-sourced roster.
      }
    }
    return this.mergePubkeys(fromTags, fromContent);
  }

  private mergePubkeys(...sets: Array<readonly string[] | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const set of sets) {
      if (!set) continue;
      for (const pk of set) {
        if (!pk || seen.has(pk)) continue;
        seen.add(pk);
        out.push(pk);
      }
    }
    return out.sort();
  }

  private ingestActiveCall(ev: NostrEvent): void {
    const channelId = getTag(ev, 'd');
    if (!channelId) return;
    const status = getTag(ev, 'status') ?? 'active';
    const hostPubkey = getTag(ev, 'host') ?? ev.pubkey;
    const expirationStr = getTag(ev, 'expiration');
    const expiresAt = expirationStr ? parseInt(expirationStr, 10) || 0 : 0;
    const participantPubkeys = this.parseSfuParticipantPubkeys(ev);
    // Participant count: SFU started tagging this so consumers can
    // distinguish "live call with people" from "room still open during
    // empty-grace." Older SFU builds don't tag - treat absent as -1
    // (unknown, render badge to preserve back-compat) unless the event
    // content/tags include a passive participant roster.
    const countStr = getTag(ev, 'count');
    const participantCount = countStr === undefined
      ? (participantPubkeys.length > 0 ? participantPubkeys.length : -1)
      : (parseInt(countStr, 10) || 0);
    const prev = this.sfuActiveCalls.get(channelId);
    // Newest-wins: replaceable kind, stale duplicates from slow relays
    // shouldn't overwrite a fresher announcement.
    if (prev && prev.createdAt >= ev.created_at) return;
    if (status === 'closed') {
      this.sfuActiveCalls.delete(channelId);
      this.sfuPresenceByChannel.delete(channelId);
      this.recomputeActiveCallByChannel();
      return;
    }
    this.sfuActiveCalls.set(channelId, {
      hostPubkey,
      status,
      participantCount,
      expiresAt,
      createdAt: ev.created_at,
      mode: 'sfu',
      participantPubkeys: participantPubkeys.length > 0 ? participantPubkeys : undefined,
    });
    this.recomputeActiveCallByChannel();
  }

  private ingestMeshVoicePresence(ev: NostrEvent): void {
    if (!ev.tags.some((t) => t[0] === 't' && t[1] === 'obelisk-voice-presence')) return;
    const channelId = getTag(ev, 'e');
    if (!channelId) return;
    const expirationStr = getTag(ev, 'expiration');
    const expiresAt = expirationStr
      ? parseInt(expirationStr, 10) || 0
      : ev.created_at + 30;
    if (!Number.isFinite(expiresAt)) return;

    const status = getTag(ev, 'status');
    const expired = expiresAt <= Math.floor(Date.now() / 1000);
    const terminal = status === 'left' || status === 'closed' || expired;
    let seenByPubkey = this.meshPresenceSeenAtByChannel.get(channelId);
    if (!seenByPubkey) {
      seenByPubkey = new Map();
      this.meshPresenceSeenAtByChannel.set(channelId, seenByPubkey);
    }
    const seenAt = seenByPubkey.get(ev.pubkey) ?? 0;
    if (seenAt > ev.created_at) return;
    if (seenAt === ev.created_at && !terminal) return;
    seenByPubkey.set(ev.pubkey, ev.created_at);

    // SFU infrastructure publishes kind 20078 with ["sfu","1"] and p-tags
    // for users it has live PCs to. Those p-tags are passive roster evidence
    // for the Join Channel view, but the SFU pubkey itself is not a mesh
    // participant and must not be counted as one.
    if (ev.tags.some((t) => t[0] === 'sfu' && t[1] === '1')) {
      this.ingestSfuVoicePresence(ev, channelId, expiresAt);
      return;
    }

    let byPubkey = this.meshPresenceByChannel.get(channelId);
    if (terminal) {
      byPubkey?.delete(ev.pubkey);
      if (byPubkey && byPubkey.size === 0) this.meshPresenceByChannel.delete(channelId);
      this.recomputeActiveCallByChannel();
      return;
    }

    if (!byPubkey) {
      byPubkey = new Map();
      this.meshPresenceByChannel.set(channelId, byPubkey);
    }
    byPubkey.set(ev.pubkey, { expiresAt, createdAt: ev.created_at });
    this.recomputeActiveCallByChannel();
  }

  private ingestSfuVoicePresence(ev: NostrEvent, channelId: string, expiresAt: number): void {
    let bySfu = this.sfuPresenceByChannel.get(channelId);
    if (!bySfu) {
      bySfu = new Map();
      this.sfuPresenceByChannel.set(channelId, bySfu);
    }
    const prev = bySfu.get(ev.pubkey);
    if (prev && prev.createdAt >= ev.created_at) return;

    const participantPubkeys = this.mergePubkeys(getAllTags(ev, 'p'));
    if (participantPubkeys.length === 0) {
      bySfu.delete(ev.pubkey);
      if (bySfu.size === 0) this.sfuPresenceByChannel.delete(channelId);
      this.recomputeActiveCallByChannel();
      return;
    }

    bySfu.set(ev.pubkey, { expiresAt, createdAt: ev.created_at, participantPubkeys });
    this.recomputeActiveCallByChannel();
  }

  private ensureMeshPresenceSweep(): void {
    if (this.meshPresenceSweepTimer) return;
    this.meshPresenceSweepTimer = setInterval(() => {
      if (this.pruneMeshPresence()) this.recomputeActiveCallByChannel();
    }, 15_000);
  }

  private pruneMeshPresence(): boolean {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const [channelId, byPubkey] of Array.from(this.meshPresenceByChannel.entries())) {
      for (const [pubkey, presence] of Array.from(byPubkey.entries())) {
        if (presence.expiresAt > now) continue;
        byPubkey.delete(pubkey);
        changed = true;
      }
      if (byPubkey.size === 0) {
        this.meshPresenceByChannel.delete(channelId);
        changed = true;
      }
    }
    for (const [channelId, bySfu] of Array.from(this.sfuPresenceByChannel.entries())) {
      for (const [sfuPubkey, presence] of Array.from(bySfu.entries())) {
        if (presence.expiresAt > now) continue;
        bySfu.delete(sfuPubkey);
        changed = true;
      }
      if (bySfu.size === 0) {
        this.sfuPresenceByChannel.delete(channelId);
        changed = true;
      }
    }
    return changed;
  }

  private recomputeActiveCallByChannel(): void {
    this.pruneMeshPresence();
    const next: Record<string, {
      hostPubkey: string;
      status: string;
      participantCount: number;
      expiresAt: number;
      createdAt: number;
      mode?: 'sfu' | 'mesh';
      participantPubkeys?: string[];
    }> = {};

    for (const [channelId, byPubkey] of this.meshPresenceByChannel.entries()) {
      const pubkeys = Array.from(byPubkey.keys()).sort();
      if (pubkeys.length === 0) continue;
      let createdAt = 0;
      let expiresAt = Number.MAX_SAFE_INTEGER;
      for (const presence of byPubkey.values()) {
        createdAt = Math.max(createdAt, presence.createdAt);
        expiresAt = Math.min(expiresAt, presence.expiresAt);
      }
      next[channelId] = {
        hostPubkey: pubkeys[0],
        status: 'active',
        participantCount: pubkeys.length,
        expiresAt,
        createdAt,
        mode: 'mesh',
        participantPubkeys: pubkeys,
      };
    }

    const sfuPresence: Record<string, {
      hostPubkey: string;
      participantPubkeys: string[];
      expiresAt: number;
      createdAt: number;
    }> = {};
    for (const [channelId, bySfu] of this.sfuPresenceByChannel.entries()) {
      let createdAt = 0;
      let expiresAt = Number.MAX_SAFE_INTEGER;
      let hostPubkey = '';
      let participantPubkeys: string[] = [];
      for (const [sfuPubkey, presence] of bySfu.entries()) {
        if (!hostPubkey || presence.createdAt > createdAt) hostPubkey = sfuPubkey;
        createdAt = Math.max(createdAt, presence.createdAt);
        expiresAt = Math.min(expiresAt, presence.expiresAt);
        participantPubkeys = this.mergePubkeys(participantPubkeys, presence.participantPubkeys);
      }
      if (participantPubkeys.length === 0) continue;
      sfuPresence[channelId] = { hostPubkey, participantPubkeys, expiresAt, createdAt };
      next[channelId] = {
        hostPubkey,
        status: 'active',
        participantCount: participantPubkeys.length,
        expiresAt,
        createdAt,
        mode: 'sfu',
        participantPubkeys,
      };
    }

    for (const [channelId, call] of this.sfuActiveCalls.entries()) {
      const presence = sfuPresence[channelId];
      const participantPubkeys = this.mergePubkeys(call.participantPubkeys, presence?.participantPubkeys);
      const participantCount = call.participantCount >= 0
        ? Math.max(call.participantCount, participantPubkeys.length)
        : (participantPubkeys.length > 0 ? participantPubkeys.length : call.participantCount);
      next[channelId] = {
        ...call,
        participantCount,
        participantPubkeys: participantPubkeys.length > 0 ? participantPubkeys : call.participantPubkeys,
      };
    }

    this.activeCallByChannel.set(next);
  }

  private clearActiveCallState(): void {
    this.sfuActiveCalls.clear();
    this.sfuPresenceByChannel.clear();
    this.meshPresenceByChannel.clear();
    this.meshPresenceSeenAtByChannel.clear();
    if (this.meshPresenceSweepTimer) {
      clearInterval(this.meshPresenceSweepTimer);
      this.meshPresenceSweepTimer = null;
    }
    this.activeCallByChannel.set({});
  }

  /** Subscribe to the active-call state for any channel. */
  subscribeActiveCallByChannel(
    cb: (byChannel: Readonly<Record<string, { hostPubkey: string; status: string; participantCount: number; expiresAt: number; createdAt: number; mode?: 'sfu' | 'mesh'; participantPubkeys?: string[] }>>) => void,
  ): Unsubscribe {
    return this.activeCallByChannel.subscribe(cb);
  }

  private subscribeIncomingDMs(): void {
    if (!getPreferences().directMessagesEnabled) return;
    if (!this.session || this.dmSubscribed) return;
    this.dmSubscribed = true;
    const me = this.session.pubKeyHex;
    // DMs to me (kind 4 with #p = me) and from me (authored by me).
    const filterIn: Filter = { kinds: [KIND_DIRECT_MESSAGE], '#p': [me], limit: 200 };
    const filterOut: Filter = { kinds: [KIND_DIRECT_MESSAGE], authors: [me], limit: 200 };
    for (const f of [filterIn, filterOut]) {
      const sub = this.subscribeWatched(this.relays, f, (ev) => this.ingestIncomingDM(ev));
      this.subs.push(sub);
      this.dmSubHandles.push(sub);
    }
    // Wide-net pickup: other clients publish DMs to the user's own NIP-17
    // (10050) inbox or NIP-65 (10002) read/write relays — not necessarily
    // `this.relays`. Resolve those, then add a parallel subscription.
    void this.fetchMyDmRelays().then((urls) => {
      if (!this.dmSubscribed || !this.session || this.session.pubKeyHex !== me) return;
      const extras = urls.filter((u) => !this.relays.includes(u));
      if (extras.length === 0) return;
      this.myDmRelays = extras;
      for (const r of extras) this.authAllowedRelays.add(normalizeRelayUrl(r));
      for (const f of [filterIn, filterOut]) {
        const sub = this.subscribeWatched(extras, f, (ev) => this.ingestIncomingDM(ev));
        this.subs.push(sub);
        this.dmSubHandles.push(sub);
      }
    });
  }

  private ingestGroupMetadata(ev: NostrEvent): void {
    // Single-pass parse — see {@link parseGroupMetadataTags} for the
    // tag-precedence rules (preserved bit-for-bit from the previous
    // multi-scan version).
    const t = parseGroupMetadataTags(ev.tags);
    const groupId = t.d;
    if (!groupId) return;
    // Drop older revisions arriving out-of-order from slower relays so the
    // sidebar doesn't oscillate. The cached seed (with its own created_at)
    // also participates in this guard.
    const prevAt = this.groupMetadataLatestAt.get(groupId) ?? 0;
    if (ev.created_at <= prevAt) return;
    this.groupMetadataLatestAt.set(groupId, ev.created_at);
    const next: JsGroup = {
      id: groupId,
      name: t.name ?? null,
      about: t.about ?? null,
      picture: t.picture ?? null,
      banner: t.banner ?? null,
      isPublic: t.isPublic,
      isOpen: t.isOpen,
      parent: t.parent ?? null,
      kind: t.channelKind,
      forumTags: t.forumTags,
      topics: t.topics,
    };
    const parent = next.parent;
    this.groups.update((prev) => {
      const filtered = prev.filter((g) => g.id !== groupId);
      return [...filtered, next].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
    });
    this.clearGroupMetadataEmptyRetry();
    // Persist for next reload — the sidebar paints channels instantly before
    // the live REQ round-trip completes. Store the snapshot together with
    // its created_at so the seed can re-establish the newest-wins guard.
    // Skip the write when the on-disk payload already matches — a
    // republished 39000 with the same fields under a newer created_at is
    // common (admin re-publishes for liveness), and avoiding the
    // localStorage.setItem keeps the main thread from blocking.
    {
      const relay = this.currentRelayUrl.get();
      const cached = cacheGet<{ group: JsGroup; createdAt: number }>(relay, KIND_GROUP_METADATA, groupId);
      if (!cached || !groupEqual(cached.value.group, next)) {
        cacheSet(relay, KIND_GROUP_METADATA, groupId, {
          group: next,
          createdAt: ev.created_at,
        });
      }
    }
    // Start streaming messages immediately so opening the channel doesn't
    // wait on a fresh REQ round-trip — the store already has them. The
    // per-group REQ caps at BACKGROUND_MESSAGE_LIMIT; older history is
    // paged via loadMoreMessages. Queued (rather than fired inline) so
    // the channel the user is actively viewing wins the relay's first
    // response — see {@link queueGroupMessages}.
    if (this.voiceRelayCapacityReservations === 0) {
      this.queueGroupMessages(groupId);
    }
    // Admin/member (39001/39002) is intentionally NOT fanned out here.
    // Subscribing to every discovered group on login was expensive on
    // accounts that belong to many channels and slowed setup of recently
    // created groups (the user wants those to feel instant). Per-group
    // admin/member REQs now open lazily on first useAdmins / useMembers
    // call from the chat panel. Tradeoff: the sidebar's "I'm an admin of
    // X" badge no longer paints before opening each channel — acceptable
    // given the load-time win. See docs/data-system.md.
    // Per-group creator REQs are intentionally not fanned out here. The
    // global authored-groups subscription covers the only write path that
    // needs this eagerly (claiming admin on groups the local user created).
    // Maintain parent → children index so the sidebar can render nesting.
    // O(1) update via {@link groupParentMap}: look up the previous parent
    // for this groupId in the reverse map and only touch the affected
    // buckets. Fast path when the parent didn't change is a no-op.
    const oldParent = this.groupParentMap.get(groupId) ?? null;
    if (oldParent !== parent) {
      this.childrenByParent.update((prev) => {
        let nextMap = prev;
        if (oldParent && prev[oldParent]) {
          const filtered = prev[oldParent].filter((id) => id !== groupId);
          if (filtered.length !== prev[oldParent].length) {
            if (filtered.length === 0) {
              const { [oldParent]: _drop, ...rest } = nextMap;
              void _drop;
              nextMap = rest;
            } else {
              nextMap = { ...nextMap, [oldParent]: filtered };
            }
          }
        }
        if (parent) {
          const arr = nextMap[parent] ?? [];
          if (!arr.includes(groupId)) {
            nextMap = { ...nextMap, [parent]: [...arr, groupId].sort() };
          }
        }
        return nextMap;
      });
      this.groupParentMap.set(groupId, parent);
    }
  }

  private isEventModerated(groupId: string, eventId: string): boolean {
    return this.moderatedEventIdsByGroup.get(groupId)?.has(eventId) ?? false;
  }

  private isEventDeletedByAuthor(groupId: string, eventId: string, pubkey: string): boolean {
    return this.deletedEventIdsByGroup.get(groupId)?.get(eventId) === pubkey;
  }

  private ingestMessage(groupId: string, ev: NostrEvent): void {
    if (this.isEventModerated(groupId, ev.id)) return;
    if (this.isEventDeletedByAuthor(groupId, ev.id, ev.pubkey)) return;
    const replyTo = ev.tags.find((t) => t[0] === 'e' && t[3] === 'reply')?.[1] ?? null;
    const mentions = extractMentionPubkeysFromMessage(ev.content, ev.tags);
    const msg: JsMessage = {
      id: ev.id,
      pubkey: ev.pubkey,
      content: ev.content,
      createdAt: ev.created_at,
      kind: ev.kind,
      replyToId: replyTo,
      mentions,
      customEmojis: customEmojiMapFromTags(ev.tags),
    };
    let isNew = false;
    let replacedClientTag: string | null = null;
    this.messagesByGroup.update((prev) => {
      const existing = prev[groupId] ?? [];
      if (existing.some((m) => m.id === msg.id)) return prev;
      // Relay echo of an optimistic placeholder we sent — replace in place
      // so the bubble's React key (msg.id) only changes once. Match on the
      // tuple we control end-to-end (pubkey, content, created_at) since the
      // pre-sign placeholder doesn't have an id yet.
      const pendingIdx = existing.findIndex(
        (m) =>
          m.pending === true
          && m.pubkey === msg.pubkey
          && m.content === msg.content
          && m.createdAt === msg.createdAt,
      );
      if (pendingIdx >= 0) {
        replacedClientTag = existing[pendingIdx].clientTag ?? null;
        const next = [...existing];
        next[pendingIdx] = msg;
        next.sort((a, b) => a.createdAt - b.createdAt);
        isNew = true;
        return { ...prev, [groupId]: next };
      }
      isNew = true;
      const next = [...existing, msg].sort((a, b) => a.createdAt - b.createdAt);
      return { ...prev, [groupId]: next };
    });
    if (replacedClientTag) this.pendingGroupSends.delete(replacedClientTag);
    // Lazy metadata fetch for any author we haven't seen yet.
    this.ensureUserMetadata(ev.pubkey);
    // A real event arrived: the channel is definitively non-empty. Cancel
    // any pending empty-EOSE retry and flip status. Doing this here
    // (rather than only in the EOSE callback) covers the case where
    // events arrive AFTER an empty EOSE but BEFORE the retry timer fires
    // — without it the bridge would still schedule a needless restart.
    if (isNew) {
      this.setMessagesStatus(groupId, 'has-messages');
      this.clearMessagesRetry(groupId);
      if (groupId === this.activeGroupId) this.maybeResumeMessageQueueDrain();
      // Persist for next reload — stale-while-revalidate paint of the last
      // window of messages so the chat pane has something to show before
      // the live REQ round-trips. See {@link MESSAGE_CACHE_LIMIT} and
      // {@link flushMessageCache} for the cap + sanitization.
      this.scheduleMessageCacheFlush(groupId);
    }
    // Inbox card for @-mentions. Unread badges are derived in the UI from
    // `useReadStateStore.groupCursors[groupId]` vs `messages[].createdAt`,
    // so this path only needs to surface the mention as an inbox event
    // (the bell / mobile inbox UI). Historical backfill is filtered by the
    // user's existing inbox cursor — a cached event older than
    // `inboxLastReadAt` is read by definition.
    if (!isNew) return;
    const me = this.session?.pubKeyHex ?? null;
    if (!me || ev.pubkey === me) return;
    if (isUserWatchingChannel(groupId)) return;
    const mentioned = mentions.includes(me);
    // Reply-to-me detection: NIP-10 strict — `["e", id, "", "reply"]` whose
    // parent is one of MY messages in this channel. Resolved against the
    // already-ingested message list so we only fire when we can prove
    // authorship; backfill that arrives before the parent gets dropped.
    const replyToMe = (() => {
      if (!replyTo) return false;
      const list = this.messagesByGroup.get()[groupId] ?? [];
      const parent = list.find((m) => m.id === replyTo);
      return !!parent && parent.pubkey === me;
    })();
    if (!mentioned && !replyToMe) return;
    const evMs = ev.created_at * 1000;
    if (evMs <= useReadStateStore.getState().inboxLastReadAt) return;
    useReadStateStore.getState().pushInboxEvent({
      // Mentions take precedence over replies in the inbox card type — if
      // a message is both, surfacing it as a "mention" matches user
      // intent (the @ was the explicit ping).
      type: mentioned ? 'mention' : 'reply',
      channelId: groupId,
      messageId: ev.id,
      senderPubkey: ev.pubkey,
      preview: ev.content.slice(0, 280),
      createdAt: new Date(evMs).toISOString(),
    });
  }

  private ingestReaction(groupId: string, ev: NostrEvent): void {
    const targetEventId = getTag(ev, 'e');
    if (!targetEventId) return;
    if (this.isEventModerated(groupId, ev.id)) return;
    if (this.isEventDeletedByAuthor(groupId, ev.id, ev.pubkey)) return;
    if (this.isEventModerated(groupId, targetEventId)) return;
    const reaction: JsReaction = {
      id: ev.id,
      pubkey: ev.pubkey,
      emoji: ev.content || '+',
      customEmojis: customEmojiMapFromTags(ev.tags),
      targetEventId,
      createdAt: ev.created_at,
    };
    let changed = false;
    this.reactionsByGroup.update((all) => {
      const forGroup = { ...(all[groupId] ?? {}) };
      const existing = forGroup[targetEventId] ?? [];
      if (existing.some((r) => r.id === reaction.id)) return all;
      changed = true;
      forGroup[targetEventId] = [...existing, reaction];
      return { ...all, [groupId]: forGroup };
    });
    // Persist reactions so emoji badges paint instantly on cold load — same
    // motivation as message caching above. Skipping when nothing changed
    // avoids a write storm on re-ingest of already-known reactions (typical
    // after a relay reconnect).
    if (changed) this.scheduleReactionCacheFlush(groupId);
  }

  private ingestEventDeletion(groupId: string, ev: NostrEvent): void {
    const ids = ev.tags
      .filter((tag) => tag[0] === 'e' && tag[1])
      .map((tag) => tag[1]);
    if (ids.length === 0) return;

    let tombstones = this.deletedEventIdsByGroup.get(groupId);
    if (!tombstones) {
      tombstones = new Map<string, string>();
      this.deletedEventIdsByGroup.set(groupId, tombstones);
    }
    for (const id of ids) tombstones.set(id, ev.pubkey);

    const idSet = new Set(ids);
    const deletedMessageIds = new Set<string>();
    let messagesChanged = false;
    this.messagesByGroup.update((all) => {
      const existing = all[groupId];
      if (!existing) return all;
      const next = existing.filter((msg) => {
        if (!idSet.has(msg.id) || msg.pubkey !== ev.pubkey) return true;
        deletedMessageIds.add(msg.id);
        return false;
      });
      if (next.length === existing.length) return all;
      messagesChanged = true;
      return { ...all, [groupId]: next };
    });
    if (messagesChanged) this.scheduleMessageCacheFlush(groupId);

    let reactionsChanged = false;
    this.reactionsByGroup.update((all) => {
      const forGroup = all[groupId];
      if (!forGroup) return all;
      const nextGroup: Record<string, JsReaction[]> = {};
      for (const [targetEventId, reactions] of Object.entries(forGroup)) {
        if (deletedMessageIds.has(targetEventId)) {
          reactionsChanged = true;
          continue;
        }
        const nextReactions = reactions.filter((reaction) => {
          if (!idSet.has(reaction.id)) return true;
          // NIP-09 delete events are accepted here only from the reaction
          // author. Group moderation uses NIP-29 kind 9005 instead.
          return reaction.pubkey !== ev.pubkey;
        });
        if (nextReactions.length !== reactions.length) reactionsChanged = true;
        if (nextReactions.length > 0) nextGroup[targetEventId] = nextReactions;
      }
      if (!reactionsChanged) return all;
      return { ...all, [groupId]: nextGroup };
    });
    if (reactionsChanged || messagesChanged) this.scheduleReactionCacheFlush(groupId);
  }

  private ingestGroupEventDeletion(groupId: string, ev: NostrEvent): void {
    const ids = ev.tags
      .filter((tag) => tag[0] === 'e' && tag[1])
      .map((tag) => tag[1]);
    if (ids.length === 0) return;

    let tombstones = this.moderatedEventIdsByGroup.get(groupId);
    if (!tombstones) {
      tombstones = new Set<string>();
      this.moderatedEventIdsByGroup.set(groupId, tombstones);
    }
    for (const id of ids) tombstones.add(id);

    const idSet = new Set(ids);
    let messagesChanged = false;
    this.messagesByGroup.update((all) => {
      const existing = all[groupId];
      if (!existing) return all;
      const next = existing.filter((msg) => !idSet.has(msg.id));
      if (next.length === existing.length) return all;
      messagesChanged = true;
      return { ...all, [groupId]: next };
    });
    if (messagesChanged) this.scheduleMessageCacheFlush(groupId);

    let reactionsChanged = false;
    this.reactionsByGroup.update((all) => {
      const forGroup = all[groupId];
      if (!forGroup) return all;
      const nextGroup: Record<string, JsReaction[]> = {};
      for (const [targetEventId, reactions] of Object.entries(forGroup)) {
        if (idSet.has(targetEventId)) {
          reactionsChanged = true;
          continue;
        }
        const nextReactions = reactions.filter((reaction) => !idSet.has(reaction.id));
        if (nextReactions.length !== reactions.length) reactionsChanged = true;
        if (nextReactions.length > 0) nextGroup[targetEventId] = nextReactions;
      }
      if (!reactionsChanged) return all;
      return { ...all, [groupId]: nextGroup };
    });
    if (reactionsChanged) this.scheduleReactionCacheFlush(groupId);
  }

  private async ingestIncomingDM(ev: NostrEvent): Promise<void> {
    if (!this.session) return;
    const me = this.session.pubKeyHex;
    const recipient = getTag(ev, 'p');
    const isOutgoing = ev.pubkey === me;
    const counterparty = isOutgoing ? (recipient ?? '') : ev.pubkey;
    if (!counterparty) return;
    let plaintext: string;
    try {
      plaintext = await this.decryptNip04(counterparty, ev.content);
    } catch {
      return; // can't decrypt → skip silently
    }
    this.ingestDM(ev, plaintext, isOutgoing, counterparty);
  }

  private ingestDM(ev: NostrEvent, plaintext: string, outgoing: boolean, counterparty: string): void {
    const dm: JsDirectMessage = {
      id: ev.id,
      counterparty,
      outgoing,
      content: plaintext,
      createdAt: ev.created_at,
    };
    let isNew = false;
    let replacedClientTag: string | null = null;
    this.dmsByPeer.update((all) => {
      const existing = all[counterparty] ?? [];
      if (existing.some((m) => m.id === dm.id)) return all;
      if (outgoing) {
        // See `ingestMessage` for the rationale — replace our own optimistic
        // placeholder in place rather than appending the relay-echoed copy
        // alongside it.
        const pendingIdx = existing.findIndex(
          (m) =>
            m.pending === true
            && m.outgoing === true
            && m.content === plaintext
            && m.createdAt === dm.createdAt,
        );
        if (pendingIdx >= 0) {
          replacedClientTag = existing[pendingIdx].clientTag ?? null;
          const next = [...existing];
          next[pendingIdx] = dm;
          next.sort((a, b) => a.createdAt - b.createdAt);
          isNew = true;
          return { ...all, [counterparty]: next };
        }
      }
      isNew = true;
      return {
        ...all,
        [counterparty]: [...existing, dm].sort((a, b) => a.createdAt - b.createdAt),
      };
    });
    if (replacedClientTag) this.pendingDMSends.delete(replacedClientTag);
    this.ensureUserMetadata(counterparty);
    // Inbox card for incoming DMs the user isn't actively watching. Unread
    // badges are derived from the read-state cursor + bridge `dmsByPeer`, so
    // we don't bump any counter here — only push a card for the bell/inbox.
    if (!isNew || outgoing) return;
    if (isUserWatchingDM(counterparty)) return;
    const evMs = ev.created_at * 1000;
    if (evMs <= useReadStateStore.getState().inboxLastReadAt) return;
    useReadStateStore.getState().pushInboxEvent({
      type: 'dm',
      senderPubkey: counterparty,
      preview: plaintext.slice(0, 280),
      createdAt: new Date(evMs).toISOString(),
    });
  }

  /**
   * Build a {@link NipSigner} backed by the active session — sign + NIP-44
   * encrypt/decrypt routed through whichever login method the user picked.
   * Used by the read-state relay-sync engine to NIP-59 gift-wrap state
   * events. Returns `null` when there is no active session.
   *
   * Bunker NIP-44 round-trips can be slow (the remote signer signs and
   * encrypts on every call); callers should debounce publish bursts.
   */
  getNipSigner(): NipSigner | null {
    if (!this.session) return null;
    const session = this.session;
    const pubkey = session.pubKeyHex;
    return {
      pubkey,
      signEvent: async (template) => {
        if (session.loginMethod === 'nsec' && session.privKeyHex) {
          const sk = hexToBytes(session.privKeyHex);
          return finalizeEvent({ ...template }, sk);
        }
        if (session.loginMethod === 'nip07') {
          const w = (window as unknown as { nostr?: { signEvent: (e: unknown) => Promise<NostrEvent> } }).nostr;
          if (!w) throw new Error('NIP-07 extension unavailable');
          return w.signEvent({ ...template, pubkey });
        }
        if (session.loginMethod === 'bunker') {
          const b = await this.ensureBunkerSigner();
          return b.signEvent(template) as Promise<NostrEvent>;
        }
        throw new Error(`Cannot sign with login method ${session.loginMethod}`);
      },
      nip44Encrypt: async (recipientPubkey, plaintext) => {
        if (session.loginMethod === 'nsec' && session.privKeyHex) {
          const sk = hexToBytes(session.privKeyHex);
          const key = nip44.utils.getConversationKey(sk, recipientPubkey);
          return nip44.encrypt(plaintext, key);
        }
        if (session.loginMethod === 'nip07') {
          const w = (window as unknown as {
            nostr?: { nip44?: { encrypt: (p: string, t: string) => Promise<string> } };
          }).nostr;
          if (!w?.nip44?.encrypt) throw new Error('Extension does not support NIP-44 encryption');
          return w.nip44.encrypt(recipientPubkey, plaintext);
        }
        if (session.loginMethod === 'bunker') {
          const b = await this.ensureBunkerSigner();
          return b.nip44Encrypt(recipientPubkey, plaintext);
        }
        throw new Error(`Cannot NIP-44 encrypt with login method ${session.loginMethod}`);
      },
      nip44Decrypt: async (senderPubkey, ciphertext) => {
        if (session.loginMethod === 'nsec' && session.privKeyHex) {
          const sk = hexToBytes(session.privKeyHex);
          const key = nip44.utils.getConversationKey(sk, senderPubkey);
          return nip44.decrypt(ciphertext, key);
        }
        if (session.loginMethod === 'nip07') {
          const w = (window as unknown as {
            nostr?: { nip44?: { decrypt: (p: string, c: string) => Promise<string> } };
          }).nostr;
          if (!w?.nip44?.decrypt) throw new Error('Extension does not support NIP-44 decryption');
          return w.nip44.decrypt(senderPubkey, ciphertext);
        }
        if (session.loginMethod === 'bunker') {
          const b = await this.ensureBunkerSigner();
          return b.nip44Decrypt(senderPubkey, ciphertext);
        }
        throw new Error(`Cannot NIP-44 decrypt with login method ${session.loginMethod}`);
      },
    };
  }

  private async encryptNip04(recipientPubkey: string, content: string): Promise<string> {
    if (!this.session) throw new Error('Not logged in');
    if (this.session.loginMethod === 'nsec' && this.session.privKeyHex) {
      return nip04.encrypt(this.session.privKeyHex, recipientPubkey, content);
    }
    if (this.session.loginMethod === 'nip07') {
      const w = (window as any).nostr;
      if (!w?.nip04?.encrypt) throw new Error('Extension does not support NIP-04 encryption');
      return w.nip04.encrypt(recipientPubkey, content);
    }
    if (this.session.loginMethod === 'bunker') {
      const b = await this.ensureBunkerSigner();
      return b.nip04Encrypt(recipientPubkey, content);
    }
    throw new Error('Cannot encrypt with current login method');
  }

  private async decryptNip04(senderPubkey: string, ciphertext: string): Promise<string> {
    if (!this.session) throw new Error('Not logged in');
    if (this.session.loginMethod === 'nsec' && this.session.privKeyHex) {
      return nip04.decrypt(this.session.privKeyHex, senderPubkey, ciphertext);
    }
    if (this.session.loginMethod === 'nip07') {
      const w = (window as any).nostr;
      if (!w?.nip04?.decrypt) throw new Error('Extension does not support NIP-04 decryption');
      return w.nip04.decrypt(senderPubkey, ciphertext);
    }
    if (this.session.loginMethod === 'bunker') {
      const b = await this.ensureBunkerSigner();
      return b.nip04Decrypt(senderPubkey, ciphertext);
    }
    throw new Error('Cannot decrypt with current login method');
  }

  private ingestUserMetadata(ev: NostrEvent, opts: { cacheRelayScoped?: boolean } = { cacheRelayScoped: true }): void {
    const prevAt = this.userMetadataLatestAt.get(ev.pubkey) ?? 0;
    if (ev.created_at <= prevAt) return;
    try {
      const data = JSON.parse(ev.content) as Record<string, unknown>;
      const meta: JsUserMetadata = {
        pubkey: ev.pubkey,
        name: (data.name as string) ?? null,
        displayName: (data.display_name as string) ?? null,
        picture: (data.picture as string) ?? null,
        about: (data.about as string) ?? null,
        nip05: (data.nip05 as string) ?? null,
        banner: (data.banner as string) ?? null,
        lud16: (data.lud16 as string) ?? null,
        website: (data.website as string) ?? null,
      };
      this.userMetadata.update((prev) => ({ ...prev, [ev.pubkey]: meta }));
      this.userMetadataLatestAt.set(ev.pubkey, ev.created_at);
      // Skip the write when the cached profile already matches — kind 0
      // events are republished often (nip-05 verifier handshakes, profile
      // editor saves with the same fields, multi-relay re-broadcast) and
      // localStorage.setItem on a popular profile is a real cost.
      if (opts.cacheRelayScoped !== false) {
        const relay = this.currentRelayUrl.get();
        const cached = cacheGet<{ meta: JsUserMetadata; createdAt: number }>(relay, KIND_USER_METADATA, ev.pubkey);
        if (!cached || !userMetadataEqual(cached.value.meta, meta)) {
          cacheSet(relay, KIND_USER_METADATA, ev.pubkey, {
            meta,
            createdAt: ev.created_at,
          });
        }
      }
    } catch {
      // ignore malformed kind:0 content
    }
  }

  /**
   * Look up a recipient's NIP-65 (kind 10002) read relays so we can publish
   * DMs to relays they actually subscribe to. Cached per-pubkey for 6h.
   * Returns an empty list on miss/timeout — caller falls back to `this.relays`.
   */
  private async fetchRecipientReadRelays(pubkey: string): Promise<string[]> {
    const TTL_MS = 6 * 3600 * 1000;
    const cached = this.recipientReadRelaysCache.get(pubkey);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.relays;
    const searchRelays = Array.from(new Set([...this.relays, ...PROFILE_RELAYS]));
    let event: NostrEvent | null = null;
    try {
      event = await this.pool.get(searchRelays, { kinds: [10002], authors: [pubkey] }, { maxWait: 4000 });
    } catch {
      event = null;
    }
    const read = event ? parseRelayList(event, 'public').read.filter(isImportableRelayUrl) : [];
    this.recipientReadRelaysCache.set(pubkey, { relays: read, fetchedAt: Date.now() });
    return read;
  }

  /**
   * Fetch the user's own kind 10050 (NIP-17 inbox) + kind 10002 (NIP-65)
   * relay lists across a wide search net. Used after connect to extend the
   * incoming-DM subscription onto the relays where other clients (Damus,
   * Amethyst, Primal, …) actually deliver DMs addressed to us.
   */
  private async fetchMyDmRelays(): Promise<string[]> {
    if (!this.session) return [];
    const me = this.session.pubKeyHex;
    const searchRelays = Array.from(new Set([...this.relays, ...PROFILE_RELAYS]));
    const out = new Set<string>();
    try {
      const events = await this.pool.querySync(
        searchRelays,
        { kinds: [10002, 10050], authors: [me] },
        { maxWait: 4000 },
      );
      // Pick the newest of each kind.
      const newest = new Map<number, NostrEvent>();
      for (const ev of events) {
        const cur = newest.get(ev.kind);
        if (!cur || ev.created_at > cur.created_at) newest.set(ev.kind, ev);
      }
      const meta = newest.get(10002);
      if (meta) {
        const { read, write } = parseRelayList(meta, 'public');
        read.forEach((u) => { if (isImportableRelayUrl(u)) out.add(u); });
        write.forEach((u) => { if (isImportableRelayUrl(u)) out.add(u); });
      }
      const inbox = newest.get(10050);
      if (inbox) parseInboxRelayList(inbox, 'public').forEach((u) => { if (isImportableRelayUrl(u)) out.add(u); });
    } catch {
      // best-effort — fall through to whatever we have
    }
    return Array.from(out);
  }

  private async signAndPublish(
    template: { kind: number; content: string; tags: string[][]; created_at: number },
    relayOpts: PublishOpts | readonly string[] = {},
    opts?: { quiet?: boolean },
  ): Promise<NostrEvent> {
    // Two call shapes: legacy `string[]` (merge with this.relays) and the new
    // `{ extraRelays, mode }` opts. Internal callers in this file still pass
    // arrays — translate here so the publish path below has one shape.
    const normalized: PublishOpts = Array.isArray(relayOpts)
      ? { extraRelays: relayOpts }
      : (relayOpts as PublishOpts);
    const extraRelays = normalized.extraRelays ?? [];
    const mode = normalized.mode ?? 'merge';
    if (!this.session) throw new Error('Not logged in');

    const signLabel =
      this.session.loginMethod === 'nip07'
        ? 'Waiting for extension signature'
        : this.session.loginMethod === 'bunker'
          ? 'Waiting for bunker signature'
          : 'Signing event';
    // `quiet`: best-effort background publish (e.g. lazy member self-add).
    // Suppress the activity-bar lifecycle so the user doesn't see a
    // Publishing/Failed toast for a write the relay routinely declines.
    const signId = opts?.quiet ? null : pushActivity(
      signLabel,
      "kind " + template.kind,
      { operation: "sign", eventKind: template.kind, description: eventKindDescription(template.kind) },
    );
    pushRelayDebug({ kind: "sign-start", eventKind: template.kind, status: eventKindDescription(template.kind) });
    let event: NostrEvent;
    try {
      if (this.session.loginMethod === 'nsec' && this.session.privKeyHex) {
        const sk = hexToBytes(this.session.privKeyHex);
        event = finalizeEvent(template, sk);
      } else if (this.session.loginMethod === 'nip07') {
        const win = (window as any).nostr;
        if (!win) throw new Error('NIP-07 extension unavailable');
        event = (await win.signEvent({ ...template, pubkey: this.session.pubKeyHex })) as NostrEvent;
      } else if (this.session.loginMethod === 'bunker') {
        const b = await this.ensureBunkerSigner();
        event = (await b.signEvent(template)) as NostrEvent;
      } else {
        throw new Error(`Login method ${this.session.loginMethod} cannot sign events in this build`);
      }
      if (template.kind === KIND_VOICE_PRESENCE) {
        this.ingestMeshVoicePresence(event);
      }
      if (signId != null) resolveActivity(signId);
      pushRelayDebug({ kind: "sign-ok", eventKind: template.kind, status: eventKindDescription(template.kind) });
    } catch (e) {
      if (signId != null) failActivity(signId, e instanceof Error ? e.message : String(e));
      pushRelayDebug({ kind: "sign-error", eventKind: template.kind, status: eventKindDescription(template.kind), reason: e instanceof Error ? e.message : String(e) });
      throw e;
    }

    const targetRelays = mode === 'replace'
      ? Array.from(new Set(extraRelays))
      : Array.from(new Set([...this.relays, ...extraRelays]));
    const pubId = opts?.quiet ? null : pushActivity(
      'Publishing to relays',
      "kind " + template.kind + " -> " + targetRelays.length + " relay(s)",
      { operation: "publish", eventKind: template.kind, description: eventKindDescription(template.kind) },
    );
    pushRelayDebug({ kind: "publish-start", relays: targetRelays, eventKind: template.kind, status: eventKindDescription(template.kind) });
    const publishes = this.pool.publish(targetRelays, event, { onauth: this.getAuthSigner() });

    // Ephemeral events (NIP-01: kinds 20000-29999) are not stored and some
    // relays don't even send OK for them — strfry/relay.obelisk.ar in
    // particular times out the publish promise instead of acknowledging.
    // The bytes are already on the wire by the time pool.publish returns;
    // waiting for OK just produces "publish time out" errors that mislead
    // users into thinking voice is broken. Treat these as fire-and-forget
    // and let any per-relay rejection surface as a console swallow.
    const isEphemeral = event.kind >= 20000 && event.kind < 30000;
    if (isEphemeral) {
      for (const p of publishes) {
        p.catch((e) => console.debug('[bridge] ephemeral publish skip', event.kind, e instanceof Error ? e.message : e));
      }
      if (pubId != null) resolveActivity(pubId, `ephemeral → ${targetRelays.length} relay(s)`);
      return event;
    }

    const results = await Promise.allSettled(publishes);
    // Surface NIP-42 / whitelist signals from the active relay. We only flip
    // state on rejections — successful publishes already get marked 'ok' via
    // the read path's onevent/oneose, so no need to overwrite here.
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      pushRelayDebug({ kind: "publish-reject", relay: targetRelays[i], eventKind: event.kind, reason });
      const state = parseRelayRejection(reason);
      if (!state) return;
      // Same logic as the read-path onclose: auth/whitelist rejections during
      // a publish are usually transient (NIP-42 AUTH not yet completed for
      // the session, NIP-29 membership write race). Defer the banner flip so
      // the soak window can absorb the transient failure.
      if (state === 'auth-required' || state === 'restricted') {
        this.setRelayAccessDeferred(targetRelays[i], state);
      } else {
        this.setRelayAccess(targetRelays[i], state);
      }
    });
    let accepted = results.filter((r) => r.status === 'fulfilled');
    let finalResults = results;
    // First publish after a relay switch often times out because NIP-42 AUTH
    // hasn't completed yet — the AUTH challenge fires in parallel with the
    // EVENT and the publish promise loses the race. By the time the user
    // sees the timeout the socket is authed, so a single retry succeeds and
    // the user doesn't have to manually click Create again.
    const allTimedOut =
      accepted.length === 0 &&
      results.every((r) => {
        if (r.status === 'fulfilled') return false;
        const reason = (r.reason instanceof Error ? r.reason.message : String(r.reason)).toLowerCase();
        return reason.includes('time') && reason.includes('out');
      });
    if (allTimedOut) {
      pushRelayDebug({ kind: "publish-retry", relays: targetRelays, eventKind: event.kind, reason: "all relays timed out" });
      const retry = this.pool.publish(targetRelays, event, { onauth: this.getAuthSigner() });
      finalResults = await Promise.allSettled(retry);
      finalResults.forEach((r, i) => {
        if (r.status !== 'rejected') return;
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        const state = parseRelayRejection(reason);
        if (state) this.setRelayAccess(targetRelays[i], state);
      });
      accepted = finalResults.filter((r) => r.status === 'fulfilled');
    }
    if (accepted.length === 0) {
      const reasons = finalResults
        .map((r, i) => {
          if (r.status === 'fulfilled') return null;
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          return `${targetRelays[i]}: ${reason}`;
        })
        .filter(Boolean)
        .join('; ');
      const msg = `Relay rejected event (kind ${event.kind}). ${reasons || 'no relay accepted'}`;
      if (pubId != null) failActivity(pubId, msg);
      pushRelayDebug({ kind: "publish-error", relays: targetRelays, eventKind: event.kind, reason: msg });
      throw new Error(msg);
    }
    if (pubId != null) resolveActivity(pubId, "accepted by " + accepted.length + "/" + targetRelays.length);
    pushRelayDebug({ kind: "publish-ok", relays: targetRelays, eventKind: event.kind, payload: { accepted: accepted.length, total: targetRelays.length } });
    return event;
  }

  private persist(): void {
    if (typeof window === 'undefined' || !this.session) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.session));
  }
}

/**
 * Reject obviously-bogus relay URLs *before* opening a WebSocket. Browsers
 * will happily DNS-search single-label hosts (e.g. `pindonga` →
 * `pindonga.<search-domain>`) and corporate networks may serve a captive
 * page on TCP connect, so the WebSocket can occasionally appear to "open"
 * for typos. Require: ws/wss scheme + a hostname containing at least one
 * dot (or a literal IP / localhost).
 */
/**
 * Strict client-side filter for relay URLs imported from remote events
 * (NIP-65 kind 10002, NIP-17 kind 10050, etc.). The browser's CSP only
 * allows `wss:` in `connect-src`, and localhost/loopback URLs published
 * by some clients (Coracle / dev setups) trigger a noisy CSP violation
 * AND a `WebSocket connection failed` per page-load. Drop them at
 * ingestion so they never reach `new WebSocket()`.
 *
 * Rules:
 *   - Must parse as a URL.
 *   - Must use `wss:` scheme. Plain `ws:` is rejected — browsers refuse
 *     mixed-content WebSockets from an https origin anyway, and any
 *     `ws://` entry in a published relay list is almost certainly a
 *     leftover from a local-dev relay an upstream client forgot to
 *     scrub before broadcasting.
 *   - Hostname can't be `localhost`, `*.localhost`, `*.local`, or an
 *     IPv4 literal in the loopback / RFC-1918 / link-local ranges.
 */
export function isImportableRelayUrl(url: string): boolean {
  let p: URL;
  try { p = new URL(url); } catch { return false; }
  if (p.protocol !== 'wss:') return false;
  const host = p.hostname.toLowerCase();
  if (!host) return false;
  if (host.endsWith('.onion')) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === 'host.docker.internal') return false;
  // IPv4 ranges that have no business in a relay list.
  if (/^127\./.test(host)) return false;
  if (/^10\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return false;
  if (host === '0.0.0.0') return false;
  // IPv6 loopback / link-local literals.
  if (host === '::1' || host === '[::1]') return false;
  if (host.startsWith('fe80:')) return false;
  return true;
}

function validateRelayUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`relay URL must use ws:// or wss:// (got ${parsed.protocol})`);
  }
  const host = parsed.hostname;
  if (!host) throw new Error('relay URL has no hostname');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':'); // v4 or v6
  const isLocalhost = host === 'localhost';
  if (!isIp && !isLocalhost && !host.includes('.')) {
    throw new Error(`"${host}" is not a valid relay hostname (single-label hosts are not allowed)`);
  }
}

function uniqueRelayUrls(urls: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    try {
      const normalized = normalizeRelayUrl(raw);
      validateRelayUrl(normalized);
      if (!isImportableRelayUrl(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      // Ignore corrupted persisted relay entries; users can re-add them.
    }
  }
  return out;
}

function generateGroupId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Opaque client-side tag for an optimistic message placeholder. Lives in
 * the message's `clientTag` field and is mirrored as `pending:<tag>` in the
 * `id` field while the publish is in flight. 16 hex chars = 64 bits of
 * entropy — more than enough to avoid collisions across the few hundred
 * placeholders a session might accumulate.
 */
function generateClientTag(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

let bridgePromise: Promise<BridgeImpl> | null = null;
let bridgeInstance: BridgeImpl | null = null;

export function getBridge(): Promise<BridgeImpl> {
  if (!bridgePromise) {
    bridgePromise = (async () => {
      bridgeInstance = new BridgeImpl();
      await bridgeInstance.initialize();
      return bridgeInstance;
    })();
  }
  return bridgePromise;
}

export function getBridgeSync(): BridgeImpl | null {
  return bridgeInstance;
}

/** Returns the initialized singleton without creating it. */
export function getBridgeImpl(): BridgeImpl | null {
  return bridgeInstance;
}
