/**
 * Tests for the kind-0 profile-sync cache cap.
 *
 * `lookupExternalUserMetadata` funnels every profile the UI renders
 * through `setCachedKind0`, so the single `obelisk/profile-sync-cache/v1`
 * blob used to grow one full signed event per pubkey ever seen — the main
 * driver of the localStorage quota exhaustion. The cache must stay at or
 * under PROFILE_SYNC_CACHE_LIMIT entries, evicting least-recently-written
 * first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  setCachedKind0,
  getCachedKind0,
  PROFILE_SYNC_CACHE_KEY,
  PROFILE_SYNC_CACHE_LIMIT,
  type CachedKind0Event,
} from './client';

function makeEvent(pubkey: string, created_at: number): CachedKind0Event {
  return {
    id: `id-${pubkey}-${created_at}`,
    pubkey,
    created_at,
    content: JSON.stringify({ name: pubkey.slice(0, 8) }),
    tags: [],
    sig: 's'.repeat(128),
  };
}

function storedPubkeys(): string[] {
  const raw = localStorage.getItem(PROFILE_SYNC_CACHE_KEY);
  if (!raw) return [];
  return Object.keys((JSON.parse(raw) as { byPubkey: Record<string, unknown> }).byPubkey);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('profile-sync cache', () => {
  it('round-trips an event through set/get', () => {
    const ev = makeEvent('pk-alice', 100);
    expect(setCachedKind0(ev)).toBe(true);
    expect(getCachedKind0('pk-alice')?.id).toBe(ev.id);
  });

  it('rejects an older event for the same pubkey', () => {
    setCachedKind0(makeEvent('pk-alice', 200));
    expect(setCachedKind0(makeEvent('pk-alice', 100))).toBe(false);
    expect(getCachedKind0('pk-alice')?.created_at).toBe(200);
  });

  it('caps the cache at PROFILE_SYNC_CACHE_LIMIT, evicting least-recently-written', () => {
    vi.useFakeTimers();
    for (let i = 0; i < PROFILE_SYNC_CACHE_LIMIT + 10; i++) {
      vi.setSystemTime(1_000 + i);
      setCachedKind0(makeEvent(`pk-${String(i).padStart(4, '0')}`, 100));
    }

    const kept = storedPubkeys();
    expect(kept.length).toBe(PROFILE_SYNC_CACHE_LIMIT);
    // The 10 earliest writes were evicted; the newest survive.
    expect(getCachedKind0('pk-0000')).toBeNull();
    expect(getCachedKind0('pk-0009')).toBeNull();
    expect(getCachedKind0('pk-0010')).not.toBeNull();
    expect(getCachedKind0(`pk-${String(PROFILE_SYNC_CACHE_LIMIT + 9).padStart(4, '0')}`)).not.toBeNull();
  });

  it('evicts legacy entries without a savedAt stamp first', () => {
    // Simulate a blob written before the cap existed: entries but no savedAt.
    const byPubkey: Record<string, CachedKind0Event> = {};
    for (let i = 0; i < PROFILE_SYNC_CACHE_LIMIT; i++) {
      const pk = `legacy-${String(i).padStart(4, '0')}`;
      byPubkey[pk] = makeEvent(pk, 100);
    }
    localStorage.setItem(PROFILE_SYNC_CACHE_KEY, JSON.stringify({ byPubkey }));

    setCachedKind0(makeEvent('pk-fresh', 100));

    const kept = storedPubkeys();
    expect(kept.length).toBe(PROFILE_SYNC_CACHE_LIMIT);
    expect(getCachedKind0('pk-fresh')).not.toBeNull();
    // Exactly one legacy entry made room for the fresh one.
    expect(kept.filter((k) => k.startsWith('legacy-')).length).toBe(PROFILE_SYNC_CACHE_LIMIT - 1);
  });

  it('does not throw when localStorage is full', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => setCachedKind0(makeEvent('pk-alice', 100))).not.toThrow();
    spy.mockRestore();
  });
});
