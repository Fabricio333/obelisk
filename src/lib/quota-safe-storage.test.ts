/**
 * Tests for the quota-safe Zustand persist storage adapter.
 *
 * Regression suite for the "Failed to execute 'setItem' on 'Storage':
 * Setting the value of 'obelisk-read-state:<pubkey>' exceeded the quota"
 * loop: once the (silently-failing) bridgeCache filled localStorage, every
 * read-cursor persist threw on every click. The adapter must (1) evict
 * disposable bridgeCache entries and retry, and (2) never throw even when
 * the origin stays full.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { quotaSafeLocalStorage } from './quota-safe-storage';
import { cacheSet, cacheGet } from './nostr-bridge/cache';

const RELAY = 'wss://relay.example.com';

function quotaError(): DOMException {
  return new DOMException('quota', 'QuotaExceededError');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('quotaSafeLocalStorage', () => {
  it('round-trips a value', () => {
    quotaSafeLocalStorage.setItem('obelisk-test-key', '{"a":1}');
    expect(quotaSafeLocalStorage.getItem('obelisk-test-key')).toBe('{"a":1}');
    quotaSafeLocalStorage.removeItem('obelisk-test-key');
    expect(quotaSafeLocalStorage.getItem('obelisk-test-key')).toBeNull();
  });

  it('evicts bridgeCache entries and retries when the first write hits quota', () => {
    cacheSet(RELAY, 0, 'a'.repeat(64), { meta: { name: 'hog' }, createdAt: 1 });

    const spy = vi.spyOn(Storage.prototype, 'setItem');
    spy.mockImplementationOnce(() => {
      throw quotaError();
    });

    quotaSafeLocalStorage.setItem('obelisk-read-state:pk', '{"groupCursors":{}}');

    // The vital write landed on retry; the disposable cache paid for it.
    expect(localStorage.getItem('obelisk-read-state:pk')).toBe('{"groupCursors":{}}');
    expect(cacheGet(RELAY, 0, 'a'.repeat(64))).toBeNull();
  });

  it('does not retry when there is no cache to evict, and does not throw', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    spy.mockImplementationOnce(() => {
      throw quotaError();
    });

    expect(() =>
      quotaSafeLocalStorage.setItem('obelisk-read-state:pk', '{"x":1}'),
    ).not.toThrow();
    // Only the initial attempt — no cache entries meant no retry.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never throws even when storage stays full after eviction', () => {
    cacheSet(RELAY, 0, 'b'.repeat(64), { meta: { name: 'hog' }, createdAt: 1 });
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quotaError();
    });

    expect(() =>
      quotaSafeLocalStorage.setItem('obelisk-read-state:pk', '{"x":1}'),
    ).not.toThrow();
    spy.mockRestore();
    expect(localStorage.getItem('obelisk-read-state:pk')).toBeNull();
  });

  it('getItem and removeItem swallow storage errors', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw quotaError();
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw quotaError();
    });
    expect(quotaSafeLocalStorage.getItem('k')).toBeNull();
    expect(() => quotaSafeLocalStorage.removeItem('k')).not.toThrow();
  });
});
