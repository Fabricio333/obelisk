import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';

// Bridge actions live behind a singleton + IndexedDB-backed cache. The
// admin-sheet tests only care that:
//   1. The right rows render given the isAdmin flag
//   2. Tapping the "Create channel" submit calls nostrActions.createGroup
// so we mock the bridge module wholesale here.

const mockCreateGroup = vi.fn();
const mockEditGroupMetadata = vi.fn();
const mockSwitchRelay = vi.fn();
const mockRemoveRelay = vi.fn();
const mockUserSearch = vi.fn();

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    createGroup: (...a: unknown[]) => mockCreateGroup(...a),
    editGroupMetadata: (...a: unknown[]) => mockEditGroupMetadata(...a),
    switchRelay: (...a: unknown[]) => mockSwitchRelay(...a),
    removeRelay: (...a: unknown[]) => mockRemoveRelay(...a),
  },
  useConfiguredRelays: () => ['wss://lacrypta-relay.obelisk.ar'],
  // Stubs for the rest of the bridge hooks the module imports — never
  // exercised by these tests but still need to be defined so the module
  // factory satisfies every named import.
  useIsLoggedIn: () => true,
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

vi.mock('@/lib/hooks/useNostrUserSearch', () => ({
  useNostrUserSearch: (...a: unknown[]) => mockUserSearch(...a),
}));

vi.mock('@/lib/relay-info', () => ({
  faviconFor: (url: string) => `https://favicon/${url}`,
  fetchRelayInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/relay-branding', () => ({
  useRelayBranding: () => ({}),
  publishBranding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/relay-emojis', () => ({
  useRelayEmojiSet: () => ({ title: '', emojis: [], updatedAt: 0 }),
  relayEmojiMap: () => ({}),
  publishRelayEmojiSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channel-layout', () => ({
  useChannelLayout: () => ({ categories: [], channels: [], updatedAt: 0 }),
  useRelayOperatorPubkey: () => null,
  applyLayout: () => ({ categories: [], uncategorized: [] }),
  publishLayout: vi.fn().mockResolvedValue(undefined),
  newCategoryId: () => 'cat-test',
}));

vi.mock('@/components/BlossomImageInput', () => ({
  default: ({ label }: { label: string }) => <div data-testid={`blossom-${label.toLowerCase()}`}>{label}</div>,
  ChannelAppearanceInput: () => <div data-testid="channel-appearance-preview" />,
}));

vi.mock('@/components/admin/RelayAdminPanel', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="relay-admin-panel-stub" onClick={onClose}>panel</div>
  ),
}));

vi.mock('@/components/admin/RelayEmojiAdminModal', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="relay-emoji-admin-stub" onClick={onClose}>emoji panel</div>
  ),
}));

import { ChannelSettingsSheet, ComposeDmScreen, CreateChannelSheet, DmsListScreen, RelayMenuSheet } from './PhoneShell';

afterEach(() => {
  mockCreateGroup.mockReset();
  mockEditGroupMetadata.mockReset();
  mockSwitchRelay.mockReset();
  mockRemoveRelay.mockReset();
  mockUserSearch.mockReset().mockReturnValue({ directHit: null, nip05Hit: null, nostrResults: [], loading: false });
});

describe('CreateChannelSheet', () => {
  it('submits the trimmed name with public+open defaults and routes to the new channel', async () => {
    mockCreateGroup.mockResolvedValueOnce('rly/abc123');
    const onCreated = vi.fn();
    const close = vi.fn();
    render(
      <CreateChannelSheet
        relayLabel="lacrypta-relay.obelisk.ar"
        close={close}
        onCreated={onCreated}
      />,
    );

    const input = screen.getByTestId('mobile-create-channel-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  general ' } });

    const submit = screen.getByTestId('mobile-create-channel-submit');
    fireEvent.click(submit);

    await vi.waitFor(() => expect(mockCreateGroup).toHaveBeenCalledTimes(1));
    expect(mockCreateGroup).toHaveBeenCalledWith({
      name: 'general',
      isPublic: true,
      isOpen: true,
    });
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('rly/abc123'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the submit button disabled while the channel name is empty', () => {
    render(
      <CreateChannelSheet
        relayLabel="lacrypta-relay.obelisk.ar"
        close={() => {}}
        onCreated={() => {}}
      />,
    );
    const submit = screen.getByTestId('mobile-create-channel-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('mobile-create-channel-input')).not.toHaveAttribute('autofocus');
  });
});

describe('ChannelSettingsSheet layout', () => {
  it('shows appearance before name and description', () => {
    render(
      <ChannelSettingsSheet
        close={() => {}}
        group={{
          id: 'channel-1',
          name: 'General',
          about: 'Chat',
          picture: null,
          banner: null,
          isPublic: true,
          isHidden: false,
          isRestricted: false,
          isOpen: true,
          parent: null,
          kind: 'text',
          forumTags: [],
          topics: [],
        }}
      />,
    );

    const preview = screen.getByTestId('channel-appearance-preview');
    const name = screen.getByTestId('mobile-channel-settings-name');
    const description = screen.getByText('Description');
    expect(preview.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(name.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ChannelSettingsSheet access presets', () => {
  it.each([
    ['read-only', 'mobile-channel-access-read-only', { isPublic: true, isHidden: false, isRestricted: true, isOpen: false }],
    ['private', 'mobile-channel-access-private', { isPublic: false, isHidden: true, isRestricted: true, isOpen: false }],
  ])('publishes %s as relay-enforced NIP-29 flags', async (_label, testId, expected) => {
    mockEditGroupMetadata.mockResolvedValueOnce(undefined);
    const close = vi.fn();
    render(
      <ChannelSettingsSheet
        close={close}
        group={{
          id: 'channel-1',
          name: 'General',
          about: null,
          picture: null,
          banner: null,
          isPublic: true,
          isHidden: false,
          isRestricted: false,
          isOpen: true,
          parent: null,
          kind: 'text',
          forumTags: [],
          topics: [],
        }}
      />,
    );

    fireEvent.click(screen.getByTestId(testId));
    fireEvent.click(screen.getByTestId('mobile-channel-settings-save'));

    await vi.waitFor(() => expect(mockEditGroupMetadata).toHaveBeenCalledTimes(1));
    expect(mockEditGroupMetadata).toHaveBeenCalledWith(expect.objectContaining(expected));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('RelayMenuSheet admin gating', () => {
  it('hides the admin section for non-admins', () => {
    render(
      <RelayMenuSheet
        close={() => {}}
        relayUrl="wss://lacrypta-relay.obelisk.ar"
        label="Obelisk"
        isAdmin={false}
      />,
    );
    expect(screen.queryByTestId('mobile-relay-admin-section')).toBeNull();
    expect(screen.queryByText('Edit branding')).toBeNull();
    expect(screen.queryByText('Emoji, GIFs & stickers')).toBeNull();
    expect(screen.queryByText('Categories & order')).toBeNull();
    expect(screen.queryByText('Admins & members')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('relay-menu-close');
  });

  it('renders the relay admin entries for admins', () => {
    render(
      <RelayMenuSheet
        close={() => {}}
        relayUrl="wss://lacrypta-relay.obelisk.ar"
        label="Obelisk"
        isAdmin
        branding={{ icon: '', banner: '', name: '', description: '', updatedAt: 0 }}
        layout={{ categories: [], channels: [], updatedAt: 0 }}
        rootChannels={[]}
      />,
    );
    expect(screen.getByTestId('mobile-relay-admin-section')).toBeTruthy();
    expect(screen.getByText('Edit branding')).toBeTruthy();
    expect(screen.getByText('Emoji, GIFs & stickers')).toBeTruthy();
    expect(screen.getByText('Categories & order')).toBeTruthy();
    expect(screen.getByText('Admins & members')).toBeTruthy();
  });

  it('opens the emoji admin panel when the admin taps "Emoji, GIFs & stickers"', () => {
    render(
      <RelayMenuSheet
        close={() => {}}
        relayUrl="wss://lacrypta-relay.obelisk.ar"
        label="Obelisk"
        isAdmin
        branding={{ icon: '', banner: '', name: '', description: '', updatedAt: 0 }}
        emojiSet={{ title: '', emojis: [], updatedAt: 0 }}
        layout={{ categories: [], channels: [], updatedAt: 0 }}
        rootChannels={[]}
      />,
    );
    fireEvent.click(screen.getByText('Emoji, GIFs & stickers'));
    expect(screen.getByTestId('relay-emoji-admin-stub')).toBeTruthy();
  });

  it('opens the RelayAdminPanel when the admin taps "Admins & members"', () => {
    render(
      <RelayMenuSheet
        close={() => {}}
        relayUrl="wss://lacrypta-relay.obelisk.ar"
        label="Obelisk"
        isAdmin
        branding={{ icon: '', banner: '', name: '', description: '', updatedAt: 0 }}
        layout={{ categories: [], channels: [], updatedAt: 0 }}
        rootChannels={[]}
      />,
    );
    fireEvent.click(screen.getByText('Admins & members'));
    expect(screen.getByTestId('relay-admin-panel-stub')).toBeTruthy();
  });
});

describe('mobile DM search', () => {
  it('opens user search from the DMs search button', () => {
    const go = vi.fn();
    render(<LocaleProvider initialLocale="en"><DmsListScreen go={go} selectPeer={() => {}} myFollows={[]} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(go).toHaveBeenCalledWith('compose-dm');
  });

  it('searches Nostr profiles and opens the selected DM', () => {
    const pubkey = 'a'.repeat(64);
    mockUserSearch.mockReturnValue({
      directHit: null,
      nip05Hit: null,
      nostrResults: [{ pubkey, displayName: 'Alice', picture: null, nip05: 'alice.com' }],
      loading: false,
    });
    const selectPeer = vi.fn();
    render(<LocaleProvider initialLocale="en"><ComposeDmScreen back={() => {}} selectPeer={selectPeer} /></LocaleProvider>);
    fireEvent.change(screen.getByPlaceholderText('Name, NIP-05, or npub'), { target: { value: 'alice' } });
    fireEvent.click(screen.getByTestId('mobile-user-search-result'));
    expect(selectPeer).toHaveBeenCalledWith(pubkey);
  });
});
