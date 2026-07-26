import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Bridge actions live behind a singleton + IndexedDB-backed cache. The
// admin-sheet tests only care that:
//   1. The right rows render given the isAdmin flag
//   2. Tapping the "Create channel" submit calls nostrActions.createGroup
// so we mock the bridge module wholesale here.

const mockCreateGroup = vi.fn();
const mockEditGroupMetadata = vi.fn();
const mockSwitchRelay = vi.fn();
const mockRemoveRelay = vi.fn();

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

import { ChannelSettingsSheet, CreateChannelSheet, RelayMenuSheet } from './PhoneShell';

afterEach(() => {
  mockCreateGroup.mockReset();
  mockEditGroupMetadata.mockReset();
  mockSwitchRelay.mockReset();
  mockRemoveRelay.mockReset();
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
    expect(screen.queryByText('Custom emojis')).toBeNull();
    expect(screen.queryByText('Categories & order')).toBeNull();
    expect(screen.queryByText('Admins & members')).toBeNull();
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
    expect(screen.getByText('Custom emojis')).toBeTruthy();
    expect(screen.getByText('Categories & order')).toBeTruthy();
    expect(screen.getByText('Admins & members')).toBeTruthy();
  });

  it('opens the emoji admin panel when the admin taps "Custom emojis"', () => {
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
    fireEvent.click(screen.getByText('Custom emojis'));
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
