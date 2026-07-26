import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { LocaleProvider } from '@/i18n/context';

const poolMocks = vi.hoisted(() => ({
  subscriptions: [] as Array<{
    relays: string[];
    filter: Filter;
    handlers: {
      onevent?: (event: NostrEvent) => void;
      oneose?: () => void;
      onclose?: () => void;
    };
    close: ReturnType<typeof vi.fn>;
  }>,
  destroy: vi.fn(),
}));
const bridgeMocks = vi.hoisted(() => ({
  ensureUserMetadata: vi.fn().mockResolvedValue(undefined),
  publishEvent: vi.fn(),
  myPubkey: 'b'.repeat(64),
}));

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>();
  return {
    ...actual,
    SimplePool: class {
      subscribe(relays: string[], filter: Filter, handlers: object) {
        const subscription = {
          relays,
          filter,
          handlers: handlers as typeof poolMocks.subscriptions[number]['handlers'],
          close: vi.fn(),
        };
        poolMocks.subscriptions.push(subscription);
        return subscription;
      }
      destroy() {
        poolMocks.destroy();
      }
    },
  };
});

vi.mock('@/lib/nostr-bridge', () => ({
  getBridge: async () => ({ publishEvent: bridgeMocks.publishEvent }),
  nostrActions: { ensureUserMetadata: bridgeMocks.ensureUserMetadata },
  useMyPubkey: () => bridgeMocks.myPubkey,
  useUserMetadata: () => ({
    displayName: 'Alice',
    name: 'alice',
    picture: 'https://example.com/avatar.jpg',
    banner: 'https://example.com/banner.jpg',
    nip05: 'alice@example.com',
    about: 'hello from nostr',
  }),
}));

vi.mock('./MessageContent', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

import NostrProfile from './NostrProfile';

const PROFILE = 'a'.repeat(64);
const note = (id: string, content: string, tags: string[][] = [], createdAt = 1) => ({
  id,
  content,
  tags,
  kind: 1,
  pubkey: PROFILE,
  created_at: createdAt,
  sig: 'c'.repeat(128),
}) as NostrEvent;

beforeEach(() => {
  localStorage.clear();
  poolMocks.subscriptions.length = 0;
  poolMocks.destroy.mockReset();
  bridgeMocks.ensureUserMetadata.mockClear();
  bridgeMocks.myPubkey = 'b'.repeat(64);
  bridgeMocks.publishEvent.mockReset().mockImplementation(async (template: {
    kind: number;
    content: string;
    tags: string[][];
  }) => note('contacts-new', template.content, template.tags, 10));
});

describe('NostrProfile', () => {
  it('streams the three configured relays and filters posts, replies, and media', () => {
    const { unmount } = render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('profile-feed-loading')).toBeInTheDocument();
    expect(poolMocks.subscriptions).toHaveLength(2);
    expect(poolMocks.subscriptions[0].relays).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
    ]);
    expect(poolMocks.subscriptions[0].filter).toMatchObject({ kinds: [1], authors: [PROFILE], limit: 100 });

    act(() => {
      poolMocks.subscriptions[0].handlers.onevent?.(note('post', 'plain post', [], 3));
      poolMocks.subscriptions[0].handlers.onevent?.(note('reply', 'reply note', [['e', 'parent']], 2));
      poolMocks.subscriptions[0].handlers.onevent?.(note('media', 'https://example.com/photo.jpg', [], 1));
      poolMocks.subscriptions[0].handlers.oneose?.();
    });

    expect(screen.getByText('plain post')).toBeInTheDocument();
    expect(screen.queryByText('reply note')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('profile-tab-replies'));
    expect(screen.getByText('reply note')).toBeInTheDocument();
    expect(screen.queryByText('plain post')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('profile-tab-media'));
    expect(screen.getByTestId('profile-media-grid').querySelector('img'))
      .toHaveAttribute('src', 'https://example.com/photo.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Open media' }));
    expect(screen.getByTestId('profile-media-lightbox')).toBeInTheDocument();

    unmount();
    expect(poolMocks.subscriptions.every((subscription) => subscription.close.mock.calls.length === 1)).toBe(true);
    expect(poolMocks.destroy).toHaveBeenCalledOnce();
  });

  it('publishes follow changes as kind 3 without dropping unrelated tags', async () => {
    render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={vi.fn()} />
      </LocaleProvider>,
    );

    act(() => {
      poolMocks.subscriptions[1].handlers.onevent?.(
        note('contacts', 'legacy relay map', [['p', 'existing'], ['relay', 'wss://legacy.example']], 5),
      );
    });
    expect(screen.getByTestId('profile-follow-button')).toBeDisabled();
    act(() => poolMocks.subscriptions[1].handlers.oneose?.());
    fireEvent.click(screen.getByTestId('profile-follow-button'));

    await waitFor(() => expect(bridgeMocks.publishEvent).toHaveBeenCalledWith(
      {
        kind: 3,
        content: 'legacy relay map',
        tags: [['p', 'existing'], ['relay', 'wss://legacy.example'], ['p', PROFILE]],
        created_at: expect.any(Number),
      },
      {
        extraRelays: [
          'wss://relay.damus.io',
          'wss://nos.lol',
          'wss://relay.primal.net',
        ],
        mode: 'replace',
      },
    ));
    expect(screen.getByTestId('profile-follow-button')).toHaveTextContent('Unfollow');
  });

  it('treats a closed contact subscription with no kind 3 as an empty follow list', async () => {
    render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={vi.fn()} />
      </LocaleProvider>,
    );

    act(() => poolMocks.subscriptions[1].handlers.onclose?.());
    expect(screen.queryByText('Could not update your follow list.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('profile-follow-button'));

    await waitFor(() => expect(bridgeMocks.publishEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 3, content: '', tags: [['p', PROFILE]] }),
      expect.any(Object),
    ));
  });

  it('does not flash a relay error before late notes and accepts an empty EOSE', () => {
    const { unmount } = render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={vi.fn()} />
      </LocaleProvider>,
    );
    act(() => poolMocks.subscriptions[0].handlers.onclose?.());
    expect(screen.queryByText('The profile relays could not load this feed.')).not.toBeInTheDocument();
    act(() => poolMocks.subscriptions[0].handlers.onevent?.(note('late', 'arrived later')));
    expect(screen.getByText('arrived later')).toBeInTheDocument();
    unmount();

    render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={vi.fn()} />
      </LocaleProvider>,
    );
    act(() => poolMocks.subscriptions.at(-2)?.handlers.oneose?.());
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('publishes reactions and NIP-10 replies to only the profile relays', async () => {
    render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={vi.fn()} />
      </LocaleProvider>,
    );
    act(() => {
      poolMocks.subscriptions[0].handlers.onevent?.(note('post', 'hello #nostr', [], 3));
      poolMocks.subscriptions[0].handlers.oneose?.();
    });

    fireEvent.click(screen.getByTestId('profile-note-react'));
    await waitFor(() => expect(bridgeMocks.publishEvent).toHaveBeenCalledWith(
      { kind: 7, content: '❤️', tags: [['e', 'post'], ['p', PROFILE]] },
      { extraRelays: expect.any(Array), mode: 'replace' },
    ));

    fireEvent.click(screen.getByTestId('profile-note-reply'));
    fireEvent.change(screen.getByTestId('profile-reply-input'), { target: { value: 'reply #Nostr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(bridgeMocks.publishEvent).toHaveBeenCalledWith(
      {
        kind: 1,
        content: 'reply #Nostr',
        tags: [
          ['e', 'post', '', 'root'],
          ['e', 'post', '', 'reply'],
          ['p', PROFILE],
          ['t', 'nostr'],
        ],
      },
      { extraRelays: expect.any(Array), mode: 'replace' },
    ));
  });

  it('lets the owner create a formatted kind-1 post and closes from the desktop X', async () => {
    bridgeMocks.myPubkey = PROFILE;
    const onClose = vi.fn();
    render(
      <LocaleProvider initialLocale="en">
        <NostrProfile pubkey={PROFILE} onClose={onClose} />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByTestId('profile-explore-close'));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('profile-create-post'));
    fireEvent.change(screen.getByTestId('profile-post-input'), { target: { value: 'My **post** #Nostr' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(bridgeMocks.publishEvent).toHaveBeenCalledWith(
      { kind: 1, content: 'My **post** #Nostr', tags: [['t', 'nostr']] },
      { extraRelays: expect.any(Array), mode: 'replace' },
    ));
  });
});
