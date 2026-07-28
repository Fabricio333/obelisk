import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/store/chat';
import { presenceActivityKey, useNostrPresence } from './useNostrPresence';

const subscribe = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nostr-bridge', () => ({
  getBridgeImpl: () => ({ subscribeFilterWatched: subscribe }),
  isImportableRelayUrl: () => true,
}));

describe('useNostrPresence', () => {
  beforeEach(() => {
    subscribe.mockReset().mockReturnValue(vi.fn());
    useChatStore.getState().reset();
  });

  it('reads NIP-29 activity only from the selected group relay', () => {
    const relay = 'wss://group.relay';
    const pubkey = 'a'.repeat(64);
    renderHook(() => useNostrPresence([pubkey], relay));

    const [filter, onEvent, options] = subscribe.mock.calls[0];
    expect(filter.kinds).toContain(9);
    expect(filter.authors).toEqual([pubkey]);
    expect(options).toEqual({
      relays: [relay],
      relayMode: 'replace',
      affectsRelayAccess: false,
    });

    act(() => onEvent({ pubkey, created_at: 123 }));
    expect(useChatStore.getState().lastActivityAt[presenceActivityKey(relay, pubkey)])
      .toBe(123_000);
  });
});
