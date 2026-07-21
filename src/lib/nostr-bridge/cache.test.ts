/**
 * Tests for the bridge's stale-while-revalidate cache module.
 *
 * Uses jsdom's localStorage; resets between tests so individual cases
 * are independent. The fixture relay URL contains `:` and `/` to verify
 * the cache key format tolerates them without encoding.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cacheGet, cacheSet, cacheDelete, cacheClearAll, cacheListIds, cacheListIdsByKind } from './cache';

const RELAY = 'wss://relay.example.com';
const KIND = 39001;

beforeEach(() => {
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cache', () => {
  it('round-trips a value through set/get', () => {
    cacheSet(RELAY, KIND, 'group-1', ['pk-a', 'pk-b']);
    const entry = cacheGet<string[]>(RELAY, KIND, 'group-1');
    expect(entry).not.toBeNull();
    expect(entry!.value).toEqual(['pk-a', 'pk-b']);
    expect(entry!.relay).toBe(RELAY);
    expect(entry!.kind).toBe(KIND);
    expect(entry!.id).toBe('group-1');
    expect(typeof entry!.createdAt).toBe('number');
  });

  it('returns null for a missing key', () => {
    expect(cacheGet(RELAY, KIND, 'never-stored')).toBeNull();
  });

  it('returns null on corrupt JSON without throwing', () => {
    window.localStorage.setItem(`obelisk-cache/${RELAY}/${KIND}/garbage`, '{not json');
    expect(cacheGet(RELAY, KIND, 'garbage')).toBeNull();
  });

  it('returns null on non-cache-shaped JSON', () => {
    window.localStorage.setItem(`obelisk-cache/${RELAY}/${KIND}/wrongshape`, JSON.stringify({ foo: 'bar' }));
    expect(cacheGet(RELAY, KIND, 'wrongshape')).toBeNull();
  });

  it('overwrites on a second set', () => {
    cacheSet(RELAY, KIND, 'group-1', ['old']);
    cacheSet(RELAY, KIND, 'group-1', ['new', 'list']);
    expect(cacheGet<string[]>(RELAY, KIND, 'group-1')!.value).toEqual(['new', 'list']);
  });

  it('skips rewriting an identical value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    cacheSet(RELAY, KIND, 'group-1', ['same']);

    vi.setSystemTime(2_000);
    cacheSet(RELAY, KIND, 'group-1', ['same']);

    const entry = cacheGet<string[]>(RELAY, KIND, 'group-1');
    expect(entry).not.toBeNull();
    expect(entry!.value).toEqual(['same']);
    expect(entry!.createdAt).toBe(1_000);
  });

  it('isolates by relay — same kind/id on different relays do not collide', () => {
    cacheSet('wss://a.example', KIND, 'g', ['from-a']);
    cacheSet('wss://b.example', KIND, 'g', ['from-b']);
    expect(cacheGet<string[]>('wss://a.example', KIND, 'g')!.value).toEqual(['from-a']);
    expect(cacheGet<string[]>('wss://b.example', KIND, 'g')!.value).toEqual(['from-b']);
  });

  it('isolates by kind — same relay/id on different kinds do not collide', () => {
    cacheSet(RELAY, 39001, 'g', ['admins']);
    cacheSet(RELAY, 39002, 'g', ['members']);
    expect(cacheGet<string[]>(RELAY, 39001, 'g')!.value).toEqual(['admins']);
    expect(cacheGet<string[]>(RELAY, 39002, 'g')!.value).toEqual(['members']);
  });

  it('cacheDelete with all three args removes only that entry', () => {
    cacheSet(RELAY, KIND, 'a', ['list-a']);
    cacheSet(RELAY, KIND, 'b', ['list-b']);
    cacheDelete(RELAY, KIND, 'a');
    expect(cacheGet(RELAY, KIND, 'a')).toBeNull();
    expect(cacheGet<string[]>(RELAY, KIND, 'b')).not.toBeNull();
  });

  it('cacheDelete with relay+kind wipes all ids for that combo', () => {
    cacheSet(RELAY, 39001, 'g1', ['x']);
    cacheSet(RELAY, 39001, 'g2', ['y']);
    cacheSet(RELAY, 39002, 'g1', ['z']);
    cacheDelete(RELAY, 39001);
    expect(cacheGet(RELAY, 39001, 'g1')).toBeNull();
    expect(cacheGet(RELAY, 39001, 'g2')).toBeNull();
    expect(cacheGet<string[]>(RELAY, 39002, 'g1')).not.toBeNull();
  });

  it('cacheDelete with only relay wipes all kinds for that relay', () => {
    cacheSet(RELAY, 39001, 'g', ['x']);
    cacheSet(RELAY, 39002, 'g', ['y']);
    cacheSet('wss://other.example', 39001, 'g', ['keep-me']);
    cacheDelete(RELAY);
    expect(cacheGet(RELAY, 39001, 'g')).toBeNull();
    expect(cacheGet(RELAY, 39002, 'g')).toBeNull();
    expect(cacheGet<string[]>('wss://other.example', 39001, 'g')).not.toBeNull();
  });

  it('cacheClearAll wipes every cache entry but leaves unrelated localStorage alone', () => {
    cacheSet(RELAY, KIND, 'g', ['x']);
    cacheSet('wss://other.example', 39002, 'h', ['y']);
    window.localStorage.setItem('unrelated-key', 'preserve');
    cacheClearAll();
    expect(cacheGet(RELAY, KIND, 'g')).toBeNull();
    expect(cacheGet('wss://other.example', 39002, 'h')).toBeNull();
    expect(window.localStorage.getItem('unrelated-key')).toBe('preserve');
  });

  it('cacheListIds enumerates ids for a relay+kind', () => {
    cacheSet(RELAY, KIND, 'g1', ['a']);
    cacheSet(RELAY, KIND, 'g2', ['b']);
    cacheSet(RELAY, 39002, 'g3', ['c']);
    const ids = cacheListIds(RELAY, KIND).sort();
    expect(ids).toEqual(['g1', 'g2']);
  });

  it('cacheListIds returns [] for an unseen relay+kind', () => {
    expect(cacheListIds('wss://nope.example', 12345)).toEqual([]);
  });

  it('indexes several kinds in one relay-scoped pass', () => {
    cacheSet(RELAY, 39000, 'group-a', { name: 'A' });
    cacheSet(RELAY, 39001, 'group-a', ['admin']);
    cacheSet(RELAY, 39002, 'group-b', ['member']);
    cacheSet('wss://other.example', 39000, 'other', {});
    localStorage.setItem('unrelated-key', 'keep');

    const index = cacheListIdsByKind(RELAY, [39000, 39001]);
    expect(index.get(39000)).toEqual(['group-a']);
    expect(index.get(39001)).toEqual(['group-a']);
    expect(index.has(39002)).toBe(false);
  });

  it('survives groupId values containing colons and dots', () => {
    const groupId = 'group:weird.id-1';
    cacheSet(RELAY, KIND, groupId, ['pk']);
    expect(cacheGet<string[]>(RELAY, KIND, groupId)!.value).toEqual(['pk']);
    expect(cacheListIds(RELAY, KIND)).toContain(groupId);
  });

  it('round-trips a kind 0 user-metadata entry in the shape ingestUserMetadata writes', () => {
    const pubkey = 'a'.repeat(64);
    const meta = {
      pubkey,
      name: 'alice',
      displayName: 'Alice',
      picture: 'https://example.com/a.png',
      about: 'hello',
      nip05: 'alice@example.com',
      banner: null,
      lud16: null,
      website: null,
    };
    cacheSet(RELAY, 0, pubkey, { meta, createdAt: 1700_000_000 });
    const entry = cacheGet<{ meta: typeof meta; createdAt: number }>(RELAY, 0, pubkey);
    expect(entry).not.toBeNull();
    expect(entry!.value.meta.displayName).toBe('Alice');
    expect(entry!.value.createdAt).toBe(1700_000_000);
    expect(cacheListIds(RELAY, 0)).toContain(pubkey);
  });
});
