/**
 * Per-account ledger of NIP-59 gift wraps we have already opened.
 *
 * ## Why
 *
 * The kind-1059 subscriptions replay history on every connect: the DM wrap
 * sub asks for `limit: 200`, and the read-state subs ask with no limit at
 * all. Without a memory of what we've already opened, every page reload
 * re-decrypts the entire backlog — on a remote signer that is hundreds of
 * round-trips spent re-deriving state we already have on disk.
 *
 * `decrypt-cache.ts` collapses the concurrent fan-out *within* a session;
 * this is what survives the reload.
 *
 * ## Why it is scoped, not global
 *
 * Three consumers see every wrap and each wants a different subset:
 *
 *   | scope              | keeps                                       |
 *   |--------------------|---------------------------------------------|
 *   | `dm`               | NIP-17 chat rumors (kind 14/15)             |
 *   | `readstate:groups` | kind 30078 rumors, `d=obelisk:readstate:v1` |
 *   | `readstate:dms`    | kind 30078 rumors, `d=obelisk:dm-readstate:v1` |
 *
 * A single global "seen" set would let whichever consumer happened to reach
 * a replayed wrap first suppress it for the other two. Their subscriptions
 * are established at different moments against different relays, so that
 * order is not something we control. Each scope therefore tracks its own
 * progress — stored as a bitmask per wrap id so all three cost one entry,
 * not three.
 *
 * ## Why skipping is safe
 *
 * A wrap's effects are already persisted by the time we mark it seen:
 * DM messages live in the DM store, and read-state cursors are written to
 * the bridgeCache under `(relay, KIND_GIFT_WRAP, dTag)`, which
 * `subscribeAndIngest` re-seeds from on mount. Skipping the wrap does not
 * skip its outcome.
 *
 * That invariant is why **`clearAllClientCacheExceptSession` must wipe this
 * ledger too** (see the `obelisk-wrap-ledger:` prefix in `cache-clear.ts`).
 * "Clear cache" removes the persisted cursors; a ledger that survived would
 * suppress the only events that could rebuild them.
 *
 * It also does not interfere with the rumor-level dedupe in `ingestDM`: the
 * recipient copy and the self copy of one DM are distinct *wrap* ids
 * carrying the same rumor id, so both still reach `ingestDM`, which dedupes
 * them exactly as before.
 */

import { createLocalStore, type LocalStore } from '@/lib/local-store';

const KEY_PREFIX = 'obelisk-wrap-ledger:';

export type WrapLedgerScope = 'dm' | 'readstate:groups' | 'readstate:dms';

const SCOPE_BIT: Record<WrapLedgerScope, number> = {
  dm: 1,
  'readstate:groups': 2,
  'readstate:dms': 4,
};

/**
 * Wrap ids retained per account, across all scopes. An id plus its mask
 * costs ~70 bytes of JSON, so 2000 is ~140KB against the origin's ~5MB
 * budget. Ids are kept whole rather than truncated: the space a prefix would
 * save isn't worth reasoning about collisions in a structure whose whole job
 * is to suppress message delivery.
 */
const MAX_IDS = 2000;

/** Coalesce the write burst when a connect-time backlog drains. */
const PERSIST_DEBOUNCE_MS = 1_000;

type Persisted = Record<string, number>;

let store: LocalStore<Persisted> | null = null;
let masks = new Map<string, number>();
/** Insertion order, oldest first — the eviction queue. */
let order: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  timer = null;
  if (!store) return;
  const out: Persisted = {};
  for (const id of order) {
    const mask = masks.get(id);
    if (mask) out[id] = mask;
  }
  store.save(out);
}

function schedulePersist(): void {
  if (timer) return;
  timer = setTimeout(persist, PERSIST_DEBOUNCE_MS);
}

/**
 * Point the ledger at `pubkey`'s storage, loading what's already there.
 * Passing `null` (logout) drops the in-memory state and stops persisting.
 *
 * Follows the per-account LocalStorage convention in CLAUDE.md:
 * `obelisk-{store}:{myPubkey}`.
 */
export function resetWrapLedger(pubkey: string | null): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  masks = new Map();
  order = [];
  if (!pubkey) {
    store = null;
    return;
  }
  store = createLocalStore<Persisted>(`${KEY_PREFIX}${pubkey}`, {});
  const loaded = store.load();
  if (loaded && typeof loaded === 'object') {
    for (const [id, mask] of Object.entries(loaded)) {
      if (typeof mask !== 'number' || mask <= 0) continue;
      masks.set(id, mask);
      order.push(id);
    }
    if (order.length > MAX_IDS) {
      for (const old of order.splice(0, order.length - MAX_IDS)) masks.delete(old);
    }
  }
}

/**
 * Has `scope` already opened and ingested this wrap? Check this **before**
 * any decrypt — the whole point is to not pay the signer round-trip.
 *
 * Returns `false` when no account is active, so a wrap arriving before login
 * completes is processed rather than silently dropped.
 */
export function hasSeenWrap(scope: WrapLedgerScope, id: string): boolean {
  return ((masks.get(id) ?? 0) & SCOPE_BIT[scope]) !== 0;
}

/** Record a wrap as fully processed by `scope`. No-op with no active account. */
export function markWrapSeen(scope: WrapLedgerScope, id: string): void {
  if (!store) return;
  const prev = masks.get(id) ?? 0;
  const next = prev | SCOPE_BIT[scope];
  if (next === prev) return;
  if (prev === 0) order.push(id);
  masks.set(id, next);
  if (order.length > MAX_IDS) {
    for (const old of order.splice(0, order.length - MAX_IDS)) masks.delete(old);
  }
  schedulePersist();
}

/** @internal test hook */
export const __INTERNAL = {
  KEY_PREFIX,
  MAX_IDS,
  PERSIST_DEBOUNCE_MS,
  SCOPE_BIT,
  flush: persist,
  size: () => order.length,
};
