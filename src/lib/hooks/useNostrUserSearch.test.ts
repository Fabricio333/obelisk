import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useNostrUserSearch } from './useNostrUserSearch';

// Mock the underlying NIP-50 hook so tests don't open real WebSockets.
const mockUseNostrQuery = vi.fn();
vi.mock('@nostr-wot/data/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@nostr-wot/data/react')>()),
  useNostrQuery: (...args: unknown[]) => mockUseNostrQuery(...args),
}));

beforeEach(() => {
  mockUseNostrQuery.mockReset();
  mockUseNostrQuery.mockReturnValue({ events: [], loading: false, error: null });
  global.fetch = vi.fn();
});

describe('useNostrUserSearch', () => {
  it('decodes a 64-hex pubkey as a directHit (no NIP-50 fired)', async () => {
    const hex = 'a'.repeat(64);
    const { result } = renderHook(() => useNostrUserSearch(hex));
    await waitFor(() => expect(result.current.directHit?.pubkey).toBe(hex));
    // When directHit is set, NIP-50 search is disabled.
    const lastCallFilters = mockUseNostrQuery.mock.calls.at(-1)?.[0] as unknown[];
    expect(lastCallFilters).toEqual([]);
  });

  it('passes a NIP-50 kind:0 search filter to useNostrQuery for free text', async () => {
    renderHook(() => useNostrUserSearch('alice'));
    await waitFor(() => {
      const calls = mockUseNostrQuery.mock.calls;
      const last = calls.at(-1);
      expect(last?.[0]).toEqual([{ kinds: [0], search: 'alice', limit: 10 }]);
      expect(last?.[1].relays).toContain('wss://relay.nostr.band');
    });
  });

  it('debounces input changes', async () => {
    const { rerender } = renderHook(({ q }: { q: string }) => useNostrUserSearch(q), {
      initialProps: { q: 'a' },
    });
    rerender({ q: 'al' });
    rerender({ q: 'ali' });
    // Right after typing, debounced query is still the initial value (or empty),
    // so useNostrQuery has not yet been called with `ali`.
    const earlyHasAli = mockUseNostrQuery.mock.calls.some(
      (c) => Array.isArray(c[0]) && (c[0] as Array<{ search?: string }>)[0]?.search === 'ali',
    );
    expect(earlyHasAli).toBe(false);
    await waitFor(() => {
      const hit = mockUseNostrQuery.mock.calls.some(
        (c) => Array.isArray(c[0]) && (c[0] as Array<{ search?: string }>)[0]?.search === 'ali',
      );
      expect(hit).toBe(true);
    }, { timeout: 1000 });
  });

  it('parses kind:0 events from useNostrQuery into nostrResults, deduped by pubkey', async () => {
    const ev = (pk: string, name: string) => ({
      id: 'x',
      pubkey: pk,
      kind: 0,
      created_at: 1,
      tags: [],
      sig: 'sig',
      content: JSON.stringify({ name, picture: 'p' }),
    });
    const events = [
      ev('b'.repeat(64), 'Alice'),
      ev('b'.repeat(64), 'Alice (dup)'),
      ev('c'.repeat(64), 'Bob'),
    ];
    mockUseNostrQuery.mockReturnValue({ events, loading: false, error: null });
    const { result } = renderHook(() => useNostrUserSearch('alice'));
    await waitFor(() => {
      expect(result.current.nostrResults).toHaveLength(2);
      expect(result.current.nostrResults[0].displayName).toBe('Alice');
      expect(result.current.nostrResults[0].picture).toBe('p');
    });
  });

  it('resolves NIP-05 identifiers via .well-known/nostr.json', async () => {
    const pk = 'd'.repeat(64);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ names: { alice: pk } }),
    });
    const { result } = renderHook(() => useNostrUserSearch('alice@example.com'));
    await waitFor(() => {
      expect(result.current.nip05Hit?.pubkey).toBe(pk);
      expect(result.current.nip05Hit?.nip05).toBe('alice@example.com');
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/.well-known/nostr.json?name=alice'),
      expect.objectContaining({ mode: 'cors' }),
    );
  });

  it('returns no results for an empty / too-short query', async () => {
    const { result } = renderHook(() => useNostrUserSearch(''));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.directHit).toBeNull();
    expect(result.current.nip05Hit).toBeNull();
    expect(result.current.nostrResults).toEqual([]);
  });
});
