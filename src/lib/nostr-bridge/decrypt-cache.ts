/**
 * Promise-coalescing memo for signer decrypt calls.
 *
 * ## Why
 *
 * A single inbound NIP-59 gift wrap is opened by three independent consumers:
 *
 *   1. `BridgeImpl.ingestIncomingGiftWrap` — the NIP-17 DM path.
 *   2. The groups-scope read-state sync (`read-state/relay-sync.ts`).
 *   3. The DM-scope read-state sync, once per relay in the NIP-65 union.
 *
 * Each opens the wrap layer *and* the seal layer, so one wrap cost up to six
 * signer round-trips — and on a remote signer (NIP-07 extension, NIP-46
 * bunker) a round-trip is the expensive part, not the crypto. None of the
 * three knows about the others, and each must apply its own verification
 * (`unwrapGiftWrap` checks the seal's signature; `unwrapForSelf` requires
 * self-authorship), so they cannot simply share a parsed result.
 *
 * Memoizing one layer down — at the decrypt call itself — fixes it without
 * touching any verification logic: all three consumers keep their own
 * checks, and the ciphertext they each hand the signer resolves from one
 * shared call. ~6 round-trips per wrap becomes ~2.
 *
 * ## Why the promise and not the value
 *
 * The three consumers fire *concurrently* — they are separate subscription
 * callbacks reacting to the same relay event. Caching only settled values
 * would miss every one of them, since none has resolved when the others
 * start. Storing the in-flight promise is what actually collapses the
 * fan-out.
 *
 * ## Scope
 *
 * This is a fan-out collapser, not a persistent cache: a short TTL and a
 * small LRU. Surviving a reload is `wrap-ledger.ts`'s job. Entries hold
 * decrypted plaintext, so the cache is cleared on logout alongside the rest
 * of the per-identity state.
 */

/** Max distinct ciphertexts held. Bounds memory; wrap contents are ~1-3KB. */
const MAX_ENTRIES = 500;

/**
 * How long a memoized result stays valid. Long enough to span the arrival of
 * the same wrap across several relay subscriptions, short enough that this
 * never becomes a de-facto message store.
 */
const TTL_MS = 5 * 60 * 1000;

interface Entry {
  promise: Promise<string>;
  expiresAt: number;
}

/**
 * Insertion-ordered (Map preserves it), so the oldest key is the first one
 * `keys().next()` yields — that's the LRU victim.
 */
const entries = new Map<string, Entry>();

function evictIfNeeded(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) return;
    entries.delete(oldest.value);
  }
}

/**
 * Return the in-flight or recently-settled decrypt for this exact
 * `(scheme, peer, ciphertext)` triple, invoking `run` only if there isn't
 * one. Rejections are **not** cached: a locked extension, a declined bunker
 * prompt, or a transient relay failure must not poison the key for the next
 * five minutes.
 */
export function memoizeDecrypt(
  scheme: 'nip04' | 'nip44',
  peer: string,
  ciphertext: string,
  run: () => Promise<string>,
): Promise<string> {
  const key = `${scheme}:${peer}:${ciphertext}`;
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) return hit.promise;

  const promise = run().catch((error: unknown) => {
    if (entries.get(key)?.promise === promise) entries.delete(key);
    throw error;
  });
  entries.set(key, { promise, expiresAt: now + TTL_MS });
  evictIfNeeded();
  return promise;
}

/**
 * Drop every memoized plaintext. Called on logout / session change — these
 * entries are decrypted message content belonging to the outgoing identity.
 */
export function clearDecryptCache(): void {
  entries.clear();
}

/** @internal test hook */
export const __INTERNAL = { MAX_ENTRIES, TTL_MS, size: () => entries.size };
