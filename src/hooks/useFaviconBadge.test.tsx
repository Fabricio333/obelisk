import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the bridge so we control what messages and pubkey the hook sees.
const mockState = {
  myPubkey: 'me' as string | null,
  dmsByPeer: {} as Record<string, Array<{ id: string; counterparty: string; outgoing: boolean; content: string; createdAt: number }>>,
  channelMessages: {} as Record<string, Array<{ id: string; pubkey: string; content: string; createdAt: number; kind: number; replyToId: string | null }>>,
};

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => mockState.myPubkey,
  useDirectMessages: () => mockState.dmsByPeer,
  useMessages: (groupId: string | null) =>
    (groupId ? mockState.channelMessages[groupId] ?? [] : []),
  useMessagesByGroup: () => mockState.channelMessages,
}));

// Spy on favicon-badge so we don't exercise the canvas path here.
vi.mock('@/lib/favicon-badge', () => ({
  setBadgeCount: vi.fn(() => Promise.resolve()),
  clearBadge: vi.fn(() => Promise.resolve()),
}));

import * as faviconBadge from '@/lib/favicon-badge';
import { useFaviconBadge } from './useFaviconBadge';
import { useReadStateStore, READ_STATE_INITIAL } from '@/store/read-state';
import { useChatStore } from '@/store/chat';

const ORIGINAL_TITLE = 'Obelisk';

describe('useFaviconBadge', () => {
  beforeEach(() => {
    document.title = ORIGINAL_TITLE;
    mockState.myPubkey = 'me';
    mockState.dmsByPeer = {};
    mockState.channelMessages = {};
    useReadStateStore.setState({ ...READ_STATE_INITIAL });
    useChatStore.setState({ activeChannelId: null, isNearBottom: true } as any);
    (faviconBadge.setBadgeCount as any).mockClear();
    (faviconBadge.clearBadge as any).mockClear();
  });

  afterEach(() => {
    document.title = ORIGINAL_TITLE;
  });

  it('keeps base title and calls clearBadge when nothing is unread', () => {
    // Cursor is "now" so even-recent messages are read.
    const now = Date.now();
    useReadStateStore.setState({
      dmCursors: { alice: now },
      groupCursors: { ch1: now },
    });
    mockState.dmsByPeer = {
      alice: [{ id: 'a', counterparty: 'alice', outgoing: false, content: 'hi', createdAt: Math.floor(now / 1000) - 100 }],
    };
    mockState.channelMessages = {
      ch1: [{ id: 'm', pubkey: 'someone', content: 'hi', createdAt: Math.floor(now / 1000) - 100, kind: 9, replyToId: null }],
    };

    renderHook(() => useFaviconBadge());

    expect(document.title).toBe(ORIGINAL_TITLE);
    expect(faviconBadge.clearBadge).toHaveBeenCalled();
  });

  it('counts unread DMs in the badge', () => {
    // Cursor at 0 → all messages are unread (within the 24h fallback window).
    mockState.dmsByPeer = {
      alice: [
        { id: 'a', counterparty: 'alice', outgoing: false, content: 'hi', createdAt: Math.floor(Date.now() / 1000) - 100 },
        { id: 'b', counterparty: 'alice', outgoing: false, content: 'hi', createdAt: Math.floor(Date.now() / 1000) - 50 },
      ],
    };

    renderHook(() => useFaviconBadge());

    expect(faviconBadge.setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(document.title).toBe(`(2) ${ORIGINAL_TITLE}`);
  });

  it('counts unread channel messages, skipping own', () => {
    mockState.channelMessages = {
      ch1: [
        { id: 'a', pubkey: 'me', content: 'mine', createdAt: Math.floor(Date.now() / 1000) - 100, kind: 9, replyToId: null },
        { id: 'b', pubkey: 'someone', content: 'theirs', createdAt: Math.floor(Date.now() / 1000) - 50, kind: 9, replyToId: null },
      ],
    };

    renderHook(() => useFaviconBadge());

    expect(faviconBadge.setBadgeCount).toHaveBeenLastCalledWith(1);
  });

  it('updates when the cursor advances', () => {
    mockState.dmsByPeer = {
      alice: [{ id: 'a', counterparty: 'alice', outgoing: false, content: 'hi', createdAt: Math.floor(Date.now() / 1000) - 50 }],
    };

    const { rerender } = renderHook(() => useFaviconBadge());
    expect(document.title).toBe(`(1) ${ORIGINAL_TITLE}`);

    act(() => {
      useReadStateStore.getState().setDmCursor('alice', Date.now());
    });
    rerender();
    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it('caps the visible label at 99+', () => {
    const list = [];
    for (let i = 0; i < 150; i++) {
      list.push({
        id: `m${i}`,
        counterparty: 'spammer',
        outgoing: false,
        content: 'hi',
        createdAt: Math.floor(Date.now() / 1000) - 100,
      });
    }
    mockState.dmsByPeer = { spammer: list };

    renderHook(() => useFaviconBadge());

    expect(document.title).toBe(`(99+) ${ORIGINAL_TITLE}`);
    expect(faviconBadge.setBadgeCount).toHaveBeenLastCalledWith(150);
  });

  it('strips a pre-badged title when capturing the base title', () => {
    document.title = '(7) Obelisk';
    const { unmount } = renderHook(() => useFaviconBadge());

    expect(document.title).toBe(ORIGINAL_TITLE);

    unmount();
    expect(document.title).toBe(ORIGINAL_TITLE);
  });
});
