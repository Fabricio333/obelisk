/**
 * Quota-safe `localStorage` adapter for Zustand `persist` stores.
 *
 * Why this exists: the bridgeCache (`obelisk-cache-v4/*`) swallows quota
 * errors silently, so it can fill the origin's ~5MB localStorage to the
 * brim without any symptom. Once it does, every *other* writer starts
 * throwing `QuotaExceededError` — most visibly the read-state store, which
 * persists on nearly every click (read cursors advance on channel/DM
 * focus). Those small per-account stores are exactly the state we can't
 * afford to lose, while the bridgeCache is by contract disposable
 * (stale-while-revalidate — the relay repopulates it).
 *
 * This adapter encodes that priority: on a failed write it evicts the
 * oldest bridgeCache entries via {@link cacheFreeSpaceForQuota} and
 * retries once. It never throws; if the retry also fails the in-memory
 * store stays live and persistence degrades until space frees up.
 *
 * Also owns the SSR fallback (in-memory Map) that the stores used to
 * inline individually.
 */
import type { StateStorage } from 'zustand/middleware';
import { cacheFreeSpaceForQuota } from '@/lib/nostr-bridge/cache';

const memoryFallback = new Map<string, string>();

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export const quotaSafeLocalStorage: StateStorage = {
  getItem: (name) => {
    if (!hasLocalStorage()) return memoryFallback.get(name) ?? null;
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (!hasLocalStorage()) {
      memoryFallback.set(name, value);
      return;
    }
    try {
      localStorage.setItem(name, value);
      return;
    } catch {
      // Quota exceeded — fall through to evict-and-retry.
    }
    try {
      if (cacheFreeSpaceForQuota()) localStorage.setItem(name, value);
    } catch {
      // Still full (or storage disabled) — degrade silently; the live
      // Zustand state is unaffected, only this persist write is lost.
    }
  },
  removeItem: (name) => {
    if (!hasLocalStorage()) {
      memoryFallback.delete(name);
      return;
    }
    try {
      localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};
