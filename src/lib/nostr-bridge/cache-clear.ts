/**
 * "Clear local cache" implementation backing the Settings → Preferences button.
 *
 * Scope (decided in `the-priority-should-be-snug-brooks.md`): wipe every
 * per-account and per-relay client-side cache, BUT keep the login session
 * and the user's preferences. The next paint after this runs re-fetches
 * everything from the relay and rebuilds local stores from scratch.
 *
 * Preserved keys (NOT wiped):
 *   - `obelisk-dex/session` — the active session; wiping it would log the
 *     user out, which is not what "clear cache" should do.
 *   - `obelisk-dex/relays`  — the configured relay list; tied to the session.
 *   - `obelisk:preferences` — explicit settings the user just chose.
 *
 * Wiped (prefix scans, account-agnostic):
 *   - `obelisk-cache-v4/*`             — `bridgeCache` namespace (every kind on every relay).
 *   - `obelisk-cache/*`, `obelisk-cache-v2/*`, `obelisk-cache-v3/*` — legacy bridgeCache prefixes (defensive).
 *   - `obelisk:relay-info-v2`          — NIP-11 relay-info cache (singleton key).
 *   - `obelisk-read-state:*`           — per-account read cursors + inbox events.
 *   - `obelisk-dm-store:*`             — per-account DM store.
 *   - `obelisk-forum-follow:*`         — per-account forum-follow store.
 *   - `obelisk-dex/forum-collapsed/*`  — per-group collapsed-state flag.
 *   - `obelisk-dex/mobile-setup-seen/*` — per-account "tutorial seen" flag.
 *   - `obelisk-dex/just-generated/*`   — per-account "fresh nsec" flag.
 *   - `obelisk:voice-chat-width`       — sidebar panel width.
 *
 * The function never throws — localStorage can be unavailable (SSR) or
 * quota-limited (private mode); silent degradation matches the rest of the
 * cache surface. The return value is the number of keys removed, surfaced
 * to the UI so the "Cleared N keys" toast is honest.
 */

const PRESERVED_EXACT = new Set<string>([
  'obelisk-dex/session',
  'obelisk-dex/relays',
  'obelisk:preferences',
]);

const WIPED_PREFIXES = [
  'obelisk-cache-v4/',
  'obelisk-cache-v3/',
  'obelisk-cache-v2/',
  'obelisk-cache/',
  'obelisk-read-state:',
  'obelisk-read-state',
  'obelisk-dm-store:',
  'obelisk-dm-store',
  'obelisk-forum-follow:',
  'obelisk-forum-follow',
  'obelisk-dex/forum-collapsed/',
  'obelisk-dex/mobile-setup-seen/',
  'obelisk-dex/just-generated/',
];

const WIPED_EXACT = new Set<string>([
  'obelisk:relay-info-v2',
  'obelisk:voice-chat-width',
]);

function isAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function shouldWipe(key: string): boolean {
  if (PRESERVED_EXACT.has(key)) return false;
  if (WIPED_EXACT.has(key)) return true;
  return WIPED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Wipe every client-side cache except the session and preferences.
 * Returns the number of keys removed (or `0` when localStorage is unavailable).
 */
export function clearAllClientCacheExceptSession(): number {
  if (!isAvailable()) return 0;
  let removed = 0;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (shouldWipe(key)) toRemove.push(key);
    }
    for (const key of toRemove) {
      try {
        window.localStorage.removeItem(key);
        removed += 1;
      } catch {
        // ignore — quota / private mode races
      }
    }
  } catch {
    // ignore — best-effort
  }
  return removed;
}
