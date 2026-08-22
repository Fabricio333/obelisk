import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hasSeenWrap,
  markWrapSeen,
  resetWrapLedger,
  __INTERNAL,
} from './wrap-ledger';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const key = (pk: string) => `${__INTERNAL.KEY_PREFIX}${pk}`;

describe('wrap ledger', () => {
  beforeEach(() => {
    localStorage.clear();
    resetWrapLedger(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    resetWrapLedger(null);
  });

  it('is inert with no active account so pre-login wraps are still processed', () => {
    markWrapSeen('dm', 'wrap1');
    expect(hasSeenWrap('dm', 'wrap1')).toBe(false);
  });

  it('remembers a wrap once an account is active', () => {
    resetWrapLedger(ALICE);
    expect(hasSeenWrap('dm', 'wrap1')).toBe(false);
    markWrapSeen('dm', 'wrap1');
    expect(hasSeenWrap('dm', 'wrap1')).toBe(true);
  });

  it('tracks scopes independently — one consumer cannot starve another', () => {
    resetWrapLedger(ALICE);
    // The DM path opens a wrap first; both read-state scopes must still get it.
    markWrapSeen('dm', 'wrap1');
    expect(hasSeenWrap('dm', 'wrap1')).toBe(true);
    expect(hasSeenWrap('readstate:groups', 'wrap1')).toBe(false);
    expect(hasSeenWrap('readstate:dms', 'wrap1')).toBe(false);

    markWrapSeen('readstate:groups', 'wrap1');
    expect(hasSeenWrap('readstate:groups', 'wrap1')).toBe(true);
    expect(hasSeenWrap('readstate:dms', 'wrap1')).toBe(false);
  });

  it('stores all scopes of one wrap as a single entry', () => {
    resetWrapLedger(ALICE);
    markWrapSeen('dm', 'wrap1');
    markWrapSeen('readstate:groups', 'wrap1');
    markWrapSeen('readstate:dms', 'wrap1');
    expect(__INTERNAL.size()).toBe(1);
  });

  it('survives a reload', () => {
    vi.useFakeTimers();
    resetWrapLedger(ALICE);
    markWrapSeen('dm', 'wrap1');
    markWrapSeen('readstate:groups', 'wrap2');
    vi.advanceTimersByTime(__INTERNAL.PERSIST_DEBOUNCE_MS + 1);

    // Simulate a fresh page: in-memory state gone, same localStorage.
    resetWrapLedger(null);
    resetWrapLedger(ALICE);

    expect(hasSeenWrap('dm', 'wrap1')).toBe(true);
    expect(hasSeenWrap('readstate:groups', 'wrap2')).toBe(true);
    expect(hasSeenWrap('dm', 'wrap2')).toBe(false);
  });

  it('is per account — switching identity does not inherit the other one', () => {
    vi.useFakeTimers();
    resetWrapLedger(ALICE);
    markWrapSeen('dm', 'wrap1');
    vi.advanceTimersByTime(__INTERNAL.PERSIST_DEBOUNCE_MS + 1);

    resetWrapLedger(BOB);
    expect(hasSeenWrap('dm', 'wrap1')).toBe(false);

    resetWrapLedger(ALICE);
    expect(hasSeenWrap('dm', 'wrap1')).toBe(true);
  });

  it('logout clears the in-memory view', () => {
    resetWrapLedger(ALICE);
    markWrapSeen('dm', 'wrap1');
    resetWrapLedger(null);
    expect(hasSeenWrap('dm', 'wrap1')).toBe(false);
  });

  it('evicts the oldest ids past the cap', () => {
    resetWrapLedger(ALICE);
    for (let i = 0; i < __INTERNAL.MAX_IDS + 50; i++) markWrapSeen('dm', `wrap${i}`);
    expect(__INTERNAL.size()).toBe(__INTERNAL.MAX_IDS);
    expect(hasSeenWrap('dm', 'wrap0')).toBe(false);
    expect(hasSeenWrap('dm', `wrap${__INTERNAL.MAX_IDS + 49}`)).toBe(true);
  });

  it('persists debounced rather than on every mark', () => {
    vi.useFakeTimers();
    resetWrapLedger(ALICE);
    markWrapSeen('dm', 'wrap1');
    expect(localStorage.getItem(key(ALICE))).toBeNull();
    vi.advanceTimersByTime(__INTERNAL.PERSIST_DEBOUNCE_MS + 1);
    expect(localStorage.getItem(key(ALICE))).not.toBeNull();
  });

  it('tolerates a corrupted payload', () => {
    localStorage.setItem(key(ALICE), 'not json');
    resetWrapLedger(ALICE);
    expect(hasSeenWrap('dm', 'wrap1')).toBe(false);
    markWrapSeen('dm', 'wrap1');
    expect(hasSeenWrap('dm', 'wrap1')).toBe(true);
  });

  it('marking the same scope twice is idempotent', () => {
    resetWrapLedger(ALICE);
    markWrapSeen('dm', 'wrap1');
    markWrapSeen('dm', 'wrap1');
    expect(__INTERNAL.size()).toBe(1);
  });
});
