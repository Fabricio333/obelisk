import type { DMProtocol } from '@/store/dm';

export interface JsForumTag {
  /** Short opaque slug. Stable across edits — threads reference this id. */
  readonly id: string;
  readonly name: string;
  /** Single emoji char (or short pictograph). `null` when the admin didn't set one. */
  readonly emoji: string | null;
}

export interface JsGroup {
  readonly id: string;
  readonly name: string | null;
  readonly about: string | null;
  readonly picture: string | null;
  /**
   * Server banner (image or animated gif URL). Non-standard NIP-29 extension —
   * carried as a `["banner", <url>]` tag on kind 39000/9002. See
   * docs/server-banner.md.
   */
  readonly banner: string | null;
  readonly isPublic: boolean;
  readonly isHidden: boolean;
  readonly isRestricted: boolean;
  readonly isOpen: boolean;
  readonly parent: string | null;
  /**
   * Channel variant marker carried as a `["t",<kind>]` tag on kind 39000
   * metadata. `'voice'` → small mesh call (see `src/lib/voice/`);
   * `'voice-sfu'` → big-room call that prefers SFU routing (same UI surface
   * as `'voice'`, but the channel signals to operators "expect ≥10 people,
   * spin up an SFU"); `'forum'` → container channel whose "posts" are
   * themselves child NIP-29 groups — see `ForumView.tsx`. `'text'` is the
   * default for channels with no `t` marker, so existing groups keep
   * rendering as regular chat. The relay needs no special handling — the
   * marker is just another tag.
   */
  readonly kind: 'text' | 'voice' | 'voice-sfu' | 'forum';
  /**
   * Curated forum tags. Only meaningful when `kind === 'forum'` — defined by
   * the forum's admin and carried as `["forum-tag", id, name, emoji?]` tags
   * on the container's kind 9002/39000 metadata. Threads under the forum
   * reference these by id via their own `topics` field. Empty for non-forum
   * channels (and for forums that haven't defined any tags yet).
   */
  readonly forumTags: ReadonlyArray<JsForumTag>;
  /**
   * Topic ids this thread is tagged with — references entries in the parent
   * forum container's `forumTags`. Carried as `["topic", id]` tags on the
   * thread's kind 9002/39000 metadata. Empty for channels that aren't a
   * forum thread or that the OP didn't tag.
   */
  readonly topics: ReadonlyArray<string>;
}

export interface JsMessage {
  readonly id: string;
  readonly pubkey: string;
  readonly content: string;
  readonly createdAt: number;
  readonly kind: number;
  readonly replyToId: string | null;
  /**
   * Pubkeys (hex) explicitly tagged or referenced by this message. Computed
   * once at ingest from `extractMentionPubkeysFromMessage(content, tags)` —
   * the union of `nostr:npub…` tokens in content and `["p", <hex>]` tags.
   * Empty array when there are none.
   */
  readonly mentions: ReadonlyArray<string>;
  /**
   * NIP-30 custom emoji tags carried on the source event, normalized as
   * shortcode name -> image URL. Renderers merge this with the relay's
   * current emoji set so older messages stay portable even if the relay list
   * changes later.
   */
  readonly customEmojis?: Readonly<Record<string, string>>;
  /** Obelisk `["sticker", name, url]` extension; NIP-30 remains the fallback. */
  readonly sticker?: { readonly name: string; readonly url: string };
  /** Obelisk `["voice", url, durationSeconds]` extension. */
  readonly voiceNote?: { readonly url: string; readonly durationSeconds: number };
  /**
   * Optimistic-send fields. Present only on placeholders the bridge inserted
   * for an in-flight or just-failed publish from this client. Once the relay
   * echo ingest replaces the placeholder, all three are absent.
   *
   * - `pending: true` while {@link sendMessage} is awaiting the
   *   relay ack — render the bubble grayed out with a spinner.
   * - `failed: true` after the publish rejected — keep the bubble visible and
   *   surface a retry button bound to {@link retryMessage}.
   * - `clientTag` is the opaque id used by the bridge to correlate retries
   *   and cancellations (also embedded as the message `id` in the form
   *   `pending:<tag>` so React key props stay stable across the lifecycle).
   */
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly clientTag?: string;
}

export interface JsUserMetadata {
  readonly pubkey: string;
  readonly name: string | null;
  readonly displayName: string | null;
  readonly picture: string | null;
  readonly about: string | null;
  readonly nip05: string | null;
  readonly banner: string | null;
  readonly lud16: string | null;
  readonly website: string | null;
}

export interface JsReaction {
  readonly id: string;
  readonly pubkey: string;
  readonly emoji: string;
  /** NIP-30 custom emoji tags carried on the reaction event. */
  readonly customEmojis?: Readonly<Record<string, string>>;
  readonly targetEventId: string;
  readonly createdAt: number;
}

export interface JsDirectMessage {
  readonly id: string;
  /** The other party's pubkey (counterparty), regardless of direction. */
  readonly counterparty: string;
  /** True if the local user authored this message. */
  readonly outgoing: boolean;
  readonly content: string;
  readonly createdAt: number;
  /**
   * Which wire protocol carried this message. Every ingest path (NIP-04
   * decrypt, NIP-17 unwrap, and the optimistic-send placeholder) sets this
   * explicitly. Optional only so a message built before this field existed
   * reads as the historical default — plain NIP-04 — rather than `undefined`
   * rendering as some third state.
   */
  readonly protocol?: DMProtocol;
  /**
   * Whether this specific message was sealed with `@nostr-wot/pq`'s hybrid
   * post-quantum envelope. Only meaningful when `protocol === 'nip17'`.
   * `undefined`/`false` both read as classic (non-post-quantum). Obelisk
   * does not send with a `pq` envelope yet (no ML-KEM key material wired
   * through — see `src/lib/pq/`); inbound detection is live regardless, so
   * a post-quantum sender is still recognized even before Obelisk can reply
   * in kind.
   */
  readonly pq?: boolean;
  /**
   * Optimistic-send fields, set only on outgoing placeholders the bridge
   * inserted for an in-flight or failed publish. See {@link JsMessage} for
   * the full contract; same semantics here.
   */
  readonly pending?: boolean;
  readonly failed?: boolean;
  readonly clientTag?: string;
}

export type JsMediaKind = 'emoji' | 'gif' | 'sticker';

export interface JsMediaItem {
  readonly name: string;
  readonly url: string;
  readonly kind: JsMediaKind;
  /** NIP-30/NIP-51 address of the pack this item came from, when known. */
  readonly packAddress?: string;
}

export interface JsMediaPack {
  readonly address: string;
  readonly identifier: string;
  readonly author: string;
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly items: ReadonlyArray<JsMediaItem>;
  readonly createdAt: number;
}

export interface JsMediaFavorites {
  readonly items: ReadonlyArray<JsMediaItem>;
  readonly packAddresses: ReadonlyArray<string>;
  readonly createdAt: number;
}

export type Unsubscribe = () => void;

/**
 * Per-relay access state, surfaced from NIP-42 AUTH callbacks, CLOSED reasons,
 * and publish rejections.
 * - `'unknown'`        — no signal yet (still connecting, or relay hasn't responded)
 * - `'authenticating'` — relay sent a NIP-42 AUTH challenge; signer is being asked
 *   to sign a kind 22242 event.
 * - `'ok'`             — relay delivered an event/EOSE; reads are flowing
 * - `'auth-required'`  — relay requires NIP-42 AUTH and our signer didn't satisfy it
 *   (signer never ran, was rejected by user, or relay still refused after sign)
 * - `'restricted'`     — relay accepted AUTH but refused us (e.g. pubkey not whitelisted)
 * - `'unreachable'`    — WebSocket handshake failed (DNS, refused, timeout, TLS) or
 *   the socket dropped after connecting and the reconnect attempts are still failing.
 *   Distinct from `'error'` so the UI can say "Cannot reach {host}" instead of
 *   "Relay rejected the request".
 * - `'error'`          — relay sent an unrecognized rejection (publish or subscribe)
 */
export type RelayAccessState =
  | 'unknown'
  | 'authenticating'
  | 'ok'
  | 'auth-required'
  | 'restricted'
  | 'unreachable'
  | 'error';

/**
 * Per-group confidence enum for the kind 9 messages stream. See
 * `subscribeMessagesStatus` for the contract.
 */
export type MessagesStatus =
  | 'loading'
  | 'empty-unconfirmed'
  | 'empty-confirmed'
  | 'has-messages';

export type LoadMoreMessagesResult =
  | 'added'
  | 'end'
  | 'unavailable';
