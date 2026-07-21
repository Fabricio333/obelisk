/**
 * Tiny stale-while-revalidate cache for relay-derived state.
 *
 * Why this exists: the bridge re-fetches everything from the relay on every
 * page load. For data that's small and rarely-changing (admin/member lists,
 * profile metadata, channel layout, relay branding), the round-trip is
 * latency the user feels — even after the login-race fix lands. Painting
 * stale-but-correct values from disk while the relay re-confirms makes the
 * sidebar appear instantly on reload.
 *
 * Contract:
 *   - Stale-while-revalidate. Callers `cacheGet` for instant paint, then
 *     let the live relay subscription overwrite the in-memory store via the
 *     usual `StateStore.update` path. There is no TTL — relays are the
 *     source of truth and arriving events monotonically replace the cache
 *     via `cacheSet`.
 *   - Keyed by `relay + kind + id`. The relay scoping prevents cross-relay
 *     leakage (a server's admin list is meaningful only for that relay).
 *   - localStorage-backed. Synchronous, ~5MB cap per origin. Entries stay
 *     small by capping the cached window per kind (MESSAGE_CACHE_LIMIT,
 *     REACTION_CACHE_LIMIT in client.ts); even a heavy account with 20+
 *     channels stays well under quota.
 *   - Invalidation: explicit only. {@link cacheClearAll} on logout.
 *     {@link cacheDelete} for surgical removal. We deliberately do NOT
 *     invalidate on relay-switch — caches for the previous relay stay on
 *     disk and re-paint instantly if the user switches back.
 *
 * Currently wired (every entry pairs an ingest writer with a seed reader):
 *   - kind 0             (user profile)         — `client.ts:ingestUserMetadata` + `seedCacheForRelay`
 *   - kind 7             (reactions)            — `client.ts:ingestReaction` (debounced) + `seedCacheForRelay`
 *   - kind 9             (group messages)       — `client.ts:ingestMessage` (debounced) + `seedCacheForRelay`
 *   - kind 9007          (group creators)       — `client.ts:ingestGroupCreator` + `seedCacheForRelay`
 *   - kind 39000         (group metadata)       — `client.ts:ingestGroupMetadata` + `seedCacheForRelay`
 *   - kind 39001 / 39002 (admin/member lists)   — `client.ts:ingestAdminMember` + `seedCacheForRelay`
 *   - kind 30078 layout   (channel layout)      — `channel-layout.ts:subscribeLayout`
 *   - kind 30078 branding (relay branding)      — `relay-branding.ts:subscribeBranding`
 *
 * Deliberately NOT cached:
 *   - kind 4 DMs — already persisted by the DM store with its own per-account key.
 *
 * Note on messages + reactions: the on-disk window is the last
 * MESSAGE_CACHE_LIMIT messages and REACTION_CACHE_LIMIT reactions per
 * channel (50 and 500 respectively today). The live REQ still runs and
 * its echoes overwrite the in-memory store; the cache exists purely to
 * give the chat pane something to paint before the relay round-trips.
 */

// v3 — bumped to evict cache entries written by the pre-bleed-fix bridge,
// where in-flight events from a markClosed sub on the previous relay's
// still-open WebSocket were ingested under the new relay's cache key (via
// `cacheSet(currentRelayUrl, ...)`). Those entries persist forever because
// no fresh event from the actual relay ever overwrites them — symptom is
// channels from another relay sticking in "Uncategorized" across page
// reloads. Wiping the namespace is the cheapest correctness-restoring
// migration; relays repopulate within seconds on next paint.
//
// Older `obelisk-cache/` (v1) and `obelisk-cache-v2/` keys are now
// orphaned. Both prefixes are evicted on module load.
const KEY_PREFIX = 'obelisk-cache-v3/';
const LEGACY_KEY_PREFIXES = ['obelisk-cache/', 'obelisk-cache-v2/'] as const;

export interface CachedEntry<T> {
  readonly value: T;
  readonly createdAt: number;
  readonly relay: string;
  readonly kind: number;
  readonly id: string;
}

interface Storable<T> {
  v: T;
  /** Wall-clock ms when cacheSet was called. Used for telemetry only. */
  t: number;
}

import { normalizeRelayUrl } from './relay-url';

function buildKey(relay: string, kind: number, id: string): string {
  // The relay URL can contain `:` and `/` which are fine in localStorage keys.
  // We don't encode them — collisions across relays already require identical
  // protocol+host+path which would be the same relay anyway.
  return `${KEY_PREFIX}${normalizeRelayUrl(relay)}/${kind}/${id}`;
}

function isAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * Read a cached entry. Returns `null` when:
 *   - localStorage is unavailable (SSR)
 *   - the key was never written
 *   - the stored payload failed to parse (corruption — silently dropped)
 */
export function cacheGet<T>(relay: string, kind: number, id: string): CachedEntry<T> | null {
  if (!isAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(buildKey(relay, kind, id));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Storable<T>;
    if (typeof parsed !== 'object' || parsed === null || !('v' in parsed) || !('t' in parsed)) {
      return null;
    }
    return {
      value: parsed.v,
      createdAt: parsed.t,
      relay,
      kind,
      id,
    };
  } catch {
    return null;
  }
}

/**
 * Write a cached entry. Quietly no-ops if localStorage throws (quota, private
 * browsing, etc.) — the live store is still authoritative; cache is a UX
 * optimization, not durability.
 */
export function cacheSet<T>(relay: string, kind: number, id: string, value: T): void {
  if (!isAvailable()) return;
  try {
    const key = buildKey(relay, kind, id);
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined) return;

    const raw = window.localStorage.getItem(key);
    if (raw !== null) {
      try {
        const existing = JSON.parse(raw) as Storable<T>;
        if (
          existing
          && typeof existing === 'object'
          && 'v' in existing
          && JSON.stringify(existing.v) === valueJson
        ) {
          return;
        }
      } catch {
        // Corrupt entries are overwritten below.
      }
    }

    window.localStorage.setItem(key, `{"v":${valueJson},"t":${Date.now()}}`);
  } catch {
    // Quota exceeded, private mode, etc. — degrade silently.
  }
}

/**
 * Delete one or more entries. Calling shapes:
 *   - `cacheDelete(relay, kind, id)`     → single entry
 *   - `cacheDelete(relay, kind)`         → wipe all ids for that relay+kind
 *   - `cacheDelete(relay)`               → wipe all entries for that relay
 */
export function cacheDelete(relay: string, kind?: number, id?: string): void {
  if (!isAvailable()) return;
  if (kind !== undefined && id !== undefined) {
    try { window.localStorage.removeItem(buildKey(relay, kind, id)); } catch { /* ignore */ }
    return;
  }
  // Prefix wipe: enumerate keys and remove matches.
  const prefix = kind !== undefined
    ? `${KEY_PREFIX}${normalizeRelayUrl(relay)}/${kind}/`
    : `${KEY_PREFIX}${normalizeRelayUrl(relay)}/`;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) toRemove.push(key);
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

/**
 * Wipe every cache entry (any relay, any kind). Used on logout — leaving
 * cached data on disk after a session ends would let the next user briefly
 * see the previous identity's admin/member lists.
 */
export function cacheClearAll(): void {
  if (!isAvailable()) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(KEY_PREFIX) || LEGACY_KEY_PREFIXES.some((p) => key.startsWith(p))) {
        toRemove.push(key);
      }
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore
  }
}

// One-shot eviction of legacy cache entries on module load. Each version
// bump leaves the previous prefix orphaned; this clears it (and any older
// generations) so stale data — including entries written by the pre-bleed-fix
// bridge under the wrong relay's key — can't keep painting after the upgrade.
// Idempotent: once nothing matches a legacy prefix, the loop exits cheaply.
(function evictLegacyCache() {
  if (!isAvailable()) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(KEY_PREFIX)) continue;
      if (LEGACY_KEY_PREFIXES.some((p) => key.startsWith(p))) {
        toRemove.push(key);
      }
    }
    toRemove.forEach((k) => window.localStorage.removeItem(k));
  } catch {
    // ignore
  }
})();

/**
 * Enumerate cached ids for a relay+kind. Used during bridge construction to
 * seed in-memory stores without knowing the id list ahead of time.
 *
 * Returns ids only — callers `cacheGet` each one to pull the value. This
 * keeps the function cheap to scan (no JSON.parse) and avoids a giant
 * payload in memory all at once.
 */
export function cacheListIds(relay: string, kind: number): string[] {
  return cacheListIdsByKind(relay, [kind]).get(kind) ?? [];
}

/** Index several cached kinds with one localStorage scan. */
export function cacheListIdsByKind(relay: string, kinds: readonly number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (!isAvailable() || kinds.length === 0) return result;
  const wanted = new Set(kinds);
  const prefix = `${KEY_PREFIX}${normalizeRelayUrl(relay)}/`;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const suffix = key.slice(prefix.length);
      const slash = suffix.indexOf('/');
      if (slash < 1) continue;
      const kind = Number(suffix.slice(0, slash));
      if (!wanted.has(kind)) continue;
      const ids = result.get(kind) ?? [];
      ids.push(suffix.slice(slash + 1));
      result.set(kind, ids);
    }
  } catch {
    // ignore
  }
  return result;
}
