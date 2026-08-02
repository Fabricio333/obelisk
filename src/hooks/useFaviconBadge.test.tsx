import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the bridge so we control what messages, relay, and pubkey the hook sees.
const RELAY = 'wss://relay.example';

const mockState = {
  myPubkey: 'me' as string | null,
  relay: RELAY as string | null,
  dmsByPeer: {} as Record<string, Array<{ id: string; counterparty: string; outgoing: boolean; content: string; createdAt: number }>>,
  channelMessages: {} as Record<string, Array<{ id: string; pubkey: string; content: string; createdAt: number; kind: number; replyToId: string | null }>>,
};

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => mockState.myPubkey,
  useCurrentRelayUrl: () => mockState.relay,
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
import {
  useNotificationsStore,
  NOTIFICATIONS_INITIAL,
  type MentionNotification,
} from '@/store/notifications';
import { useChatStore } from '@/store/chat';

function mention(over: Partial<MentionNotification> = {}): MentionNotification {
  return {
    id: 'm1',
    relay: RELAY,
    channelId: 'ch1',
    senderPubkey: 'someone',
    preview: 'hey @me',
    createdAt: Date.now(),
    ...over,
  };
}

const ORIGINAL_TITLE = 'Obelisk';

describe('useFaviconBadge', () => {
  beforeEach(() => {
    document.title = ORIGINAL_TITLE;
    mockState.myPubkey = 'me';
    mockState.relay = RELAY;
    mockState.dmsByPeer = {};
    mockState.channelMessages = {};
    useReadStateStore.setState({ ...READ_STATE_INITIAL });
    useNotificationsStore.setState({ ...NOTIFICATIONS_INITIAL });
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

  it('does NOT count ordinary channel traffic', () => {
    // Regression: the badge used to sum every unread message in every
    // channel, pinning a busy relay at (99+) permanently. Only things
    // addressed to you badge the tab now.
    mockState.channelMessages = {
      ch1: [
        { id: 'a', pubkey: 'me', content: 'mine', createdAt: Math.floor(Date.now() / 1000) - 100, kind: 9, replyToId: null },
        { id: 'b', pubkey: 'someone', content: 'theirs', createdAt: Math.floor(Date.now() / 1000) - 50, kind: 9, replyToId: null },
      ],
    };

    renderHook(() => useFaviconBadge());

    expect(document.title).toBe(ORIGINAL_TITLE);
    expect(faviconBadge.clearBadge).toHaveBeenCalled();
  });

  it('counts unread mentions on the active relay', () => {
    useNotificationsStore.setState({
      mentionsByRelay: { [RELAY]: [mention({ id: 'a' }), mention({ id: 'b' })] },
    });

    renderHook(() => useFaviconBadge());

    expect(faviconBadge.setBadgeCount).toHaveBeenLastCalledWith(2);
  });

  it('ignores mentions belonging to a relay that is not active', () => {
    // Mentions are only scanned on the active relay; another relay's
    // cached cards must not badge the tab.
    useNotificationsStore.setState({
      mentionsByRelay: { 'wss://other.example': [mention({ relay: 'wss://other.example' })] },
    });

    renderHook(() => useFaviconBadge());

    expect(document.title).toBe(ORIGINAL_TITLE);
  });

  it('sums unread DMs and unread mentions', () => {
    mockState.dmsByPeer = {
      alice: [{ id: 'a', counterparty: 'alice', outgoing: false, content: 'hi', createdAt: Math.floor(Date.now() / 1000) - 100 }],
    };
    useNotificationsStore.setState({
      mentionsByRelay: { [RELAY]: [mention()] },
    });

    renderHook(() => useFaviconBadge());

    expect(faviconBadge.setBadgeCount).toHaveBeenLastCalledWith(2);
  });

  it('drops the mention from the badge once its channel is read', () => {
    useNotificationsStore.setState({
      mentionsByRelay: { [RELAY]: [mention({ createdAt: Date.now() - 5_000 })] },
    });

    const { rerender } = renderHook(() => useFaviconBadge());
    expect(faviconBadge.setBadgeCount).toHaveBeenLastCalledWith(1);

    act(() => {
      useReadStateStore.getState().setGroupCursor('ch1', Date.now());
    });
    rerender();
    expect(document.title).toBe(ORIGINAL_TITLE);
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
