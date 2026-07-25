import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// PhoneShell imports the whole bridge surface. The two components under
// test (ChannelMessage, MessageActionsSheet) only consume a small slice of
// it, so the rest are stubbed wholesale so the module factory satisfies
// every named import.
vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    removeMessage: vi.fn().mockResolvedValue(undefined),
    deleteGroupEvent: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    createGroup: vi.fn(),
    switchRelay: vi.fn(),
    removeRelay: vi.fn(),
  },
  useConfiguredRelays: () => ['wss://lacrypta-relay.obelisk.ar'],
  useIsLoggedIn: () => true,
  useMyPubkey: () => null,
  useSignerReady: () => true,
  useUserMetadata: () => null,
  useIsRehydrating: () => false,
  useGroups: () => [],
  useChildrenByParent: () => ({}),
  useMessages: () => [],
  useLoadEarlier: () => ({ loadEarlier: vi.fn(), loading: false, reachedStart: true }),
  useDirectMessages: () => [],
  useAdmins: () => [],
  useAdminsByGroup: () => ({}),
  useMembers: () => [],
  useReactions: () => ({}),
  useCurrentRelayUrl: () => 'wss://lacrypta-relay.obelisk.ar',
  useRelayAccess: () => ({ status: 'ok' }),
  useConnectionState: () => 'connected',
  useGroupMetadataEose: () => true,
  useActiveCallByChannel: () => ({}),
}));

vi.mock('@/lib/relay-info', () => ({
  faviconFor: (url: string) => `https://favicon/${url}`,
  fetchRelayInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/relay-branding', () => ({
  useRelayBranding: () => ({}),
  publishBranding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channel-layout', () => ({
  useChannelLayout: () => ({ categories: [], channels: [], updatedAt: 0 }),
  useRelayOperatorPubkey: () => null,
  applyLayout: () => ({ categories: [], uncategorized: [] }),
  publishLayout: vi.fn().mockResolvedValue(undefined),
  newCategoryId: () => 'cat-test',
}));

vi.mock('@/components/BlossomImageInput', () => ({
  default: () => <div />,
}));

vi.mock('@/components/admin/RelayAdminPanel', () => ({
  default: () => <div />,
}));

// MessageContent does its own bridge lookups; stub it out so the test
// renders the raw text only.
vi.mock('@/components/chat/MessageContent', () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock('@/components/chat/EmojiPicker', () => ({
  default: ({
    onPick,
    onClose,
  }: {
    onPick: (emoji: string, custom?: { name: string; url: string }) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Emoji picker">
      <button onClick={() => onPick(':party:', { name: 'party', url: 'https://example.com/party.webp' })}>
        Pick custom
      </button>
      <button onClick={onClose}>Close picker</button>
    </div>
  ),
}));

import { nostrActions } from '@/lib/nostr-bridge';
import { ChannelMessage, MessageActionsSheet } from './PhoneShell';

const sampleMsg = {
  id: 'msg-1',
  pubkey: 'a'.repeat(64),
  content: 'hello world',
  createdAt: Math.floor(Date.now() / 1000),
  kind: 9,
  replyToId: null,
  mentions: [] as string[],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChannelMessage kebab button', () => {
  it('renders the three-dots button on every message tile', () => {
    render(
      <ChannelMessage
        msg={sampleMsg}
        myPubkey={null}
        groupId="rly/group"
        reactions={[]}
        onLongPress={() => {}}
        onAvatar={() => {}}
      />,
    );
    expect(screen.getByTestId('mobile-msg-more')).toBeTruthy();
  });

  it('calls onLongPress when the kebab button is tapped (no 500ms hold required)', () => {
    const onLongPress = vi.fn();
    render(
      <ChannelMessage
        msg={sampleMsg}
        myPubkey={null}
        groupId="rly/group"
        reactions={[]}
        onLongPress={onLongPress}
        onAvatar={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('mobile-msg-more'));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('removes my reaction when tapping a reaction I already sent', async () => {
    render(
      <ChannelMessage
        msg={sampleMsg}
        myPubkey={'b'.repeat(64)}
        groupId="rly/group"
        reactions={[{
          id: 'reaction-1',
          pubkey: 'b'.repeat(64),
          emoji: '🔥',
        }]}
        onLongPress={() => {}}
        onAvatar={() => {}}
      />,
    );

    fireEvent.click(screen.getByText(/🔥/));
    await vi.waitFor(() => {
      expect(nostrActions.removeReaction).toHaveBeenCalledWith('rly/group', 'reaction-1');
    });
    expect(nostrActions.sendReaction).not.toHaveBeenCalled();
  });

  it('removes another user reaction for everyone when I am an admin', async () => {
    render(
      <ChannelMessage
        msg={sampleMsg}
        myPubkey={'b'.repeat(64)}
        isAdmin
        groupId="rly/group"
        reactions={[{
          id: 'reaction-2',
          pubkey: 'c'.repeat(64),
          emoji: '👀',
        }]}
        onLongPress={() => {}}
        onAvatar={() => {}}
      />,
    );

    fireEvent.click(screen.getByText(/👀/));
    await vi.waitFor(() => {
      expect(nostrActions.deleteGroupEvent).toHaveBeenCalledWith('rly/group', 'reaction-2');
    });
    expect(nostrActions.removeReaction).not.toHaveBeenCalled();
    expect(nostrActions.sendReaction).not.toHaveBeenCalled();
  });
});

describe('MessageActionsSheet Reply', () => {
  it('dispatches obelisk-mobile:reply with the msg id and closes the sheet', () => {
    const close = vi.fn();
    const onZap = vi.fn();
    const listener = vi.fn();
    window.addEventListener('obelisk-mobile:reply', listener as EventListener);

    try {
      render(
        <MessageActionsSheet
          msg={{ id: 'msg-7', pubkey: 'b'.repeat(64), content: 'hi' }}
          close={close}
          onZap={onZap}
        />,
      );
      fireEvent.click(screen.getByTestId('mobile-msg-actions-reply'));

      expect(listener).toHaveBeenCalledTimes(1);
      const ev = listener.mock.calls[0][0] as CustomEvent<{ msgId: string }>;
      expect(ev.detail.msgId).toBe('msg-7');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('obelisk-mobile:reply', listener as EventListener);
    }
  });
});

describe('MessageActionsSheet reactions', () => {
  it('opens the emoji picker from the + quick reaction and dispatches the picked emoji', () => {
    const close = vi.fn();
    const listener = vi.fn();
    window.addEventListener('obelisk-mobile:react', listener as EventListener);

    try {
      render(
        <MessageActionsSheet
          msg={{ id: 'msg-8', pubkey: 'c'.repeat(64), content: 'hi' }}
          close={close}
          onZap={() => {}}
        />,
      );

      fireEvent.click(screen.getByText('+'));
      expect(screen.getByRole('dialog', { name: 'Emoji picker' })).toBeTruthy();

      fireEvent.click(screen.getByText('Pick custom'));
      expect(listener).toHaveBeenCalledTimes(1);
      const ev = listener.mock.calls[0][0] as CustomEvent<{
        emoji: string;
        customEmojis?: Record<string, string>;
      }>;
      expect(ev.detail.emoji).toBe(':party:');
      expect(ev.detail.customEmojis).toEqual({ party: 'https://example.com/party.webp' });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('obelisk-mobile:react', listener as EventListener);
    }
  });
});

describe('MessageActionsSheet deletion', () => {
  it('deletes a message for everyone when moderation is allowed', async () => {
    const close = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MessageActionsSheet
        msg={{
          id: 'msg-9',
          pubkey: 'c'.repeat(64),
          content: 'hi',
          groupId: 'rly/group',
          canModerate: true,
        }}
        close={close}
        onZap={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('mobile-msg-actions-delete'));
    await vi.waitFor(() => {
      expect(nostrActions.deleteGroupEvent).toHaveBeenCalledWith('rly/group', 'msg-9');
    });
    expect(nostrActions.removeMessage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it('removes my own message with NIP-09 when I am not a moderator', async () => {
    const close = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MessageActionsSheet
        msg={{
          id: 'msg-10',
          pubkey: 'c'.repeat(64),
          content: 'hi',
          groupId: 'rly/group',
          canDeleteOwn: true,
        }}
        close={close}
        onZap={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId('mobile-msg-actions-delete'));
    await vi.waitFor(() => {
      expect(nostrActions.removeMessage).toHaveBeenCalledWith('rly/group', 'msg-10');
    });
    expect(nostrActions.deleteGroupEvent).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
});
