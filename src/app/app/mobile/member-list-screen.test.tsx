import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import { useChatStore } from '@/store/chat';

// PhoneShell pulls in the whole bridge at module scope; this screen only needs
// the membership hooks, so the rest are stubbed to satisfy the named imports.
const roster = vi.hoisted(() => ({ admins: [] as string[], members: [] as string[] }));

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {},
  useConfiguredRelays: () => ['wss://relay.test'],
  useIsLoggedIn: () => true,
  useIsRehydrating: () => false,
  useGroups: () => [{ id: 'group-1', name: 'general', parent: null }],
  useChildrenByParent: () => ({}),
  useMessages: () => [],
  useLoadEarlier: () => ({ loadEarlier: vi.fn(), loading: false, reachedStart: true }),
  useDirectMessages: () => [],
  useAdmins: () => roster.admins,
  useAdminsByGroup: () => ({}),
  useMembers: () => roster.members,
  useMembershipReady: () => true,
  useUserMetadata: (pubkey: string) => ({ displayName: pubkey }),
  useReactions: () => ({}),
  useCurrentRelayUrl: () => 'wss://relay.test',
  useRelayAccess: () => ({ status: 'ok' }),
  useConnectionState: () => 'connected',
  useGroupMetadataEose: () => true,
  useActiveCallByChannel: () => ({}),
}));

vi.mock('@/hooks/chat/useNostrPresence', () => ({
  useNostrPresence: () => undefined,
  PRESENCE_WINDOW_MS: 15 * 60 * 1000,
  presenceActivityKey: (relay: string, pubkey: string) => `${relay}:${pubkey}`,
}));

vi.mock('@/lib/hooks/useNostrUserSearch', () => ({ useNostrUserSearch: () => ({ results: [], loading: false }) }));
vi.mock('@/lib/relay-info', () => ({ faviconFor: () => '', fetchRelayInfo: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/relay-branding', () => ({ useRelayBranding: () => ({}), publishBranding: vi.fn() }));
vi.mock('@/lib/relay-emojis', () => ({
  useRelayEmojiSet: () => ({ title: '', emojis: [], updatedAt: 0 }),
  relayEmojiMap: () => ({}),
  relayMediaKindMap: () => ({}),
  resolveRelayEmojiSet: (set: unknown) => set,
  publishRelayEmojiSet: vi.fn(),
}));
vi.mock('@/lib/channel-layout', () => ({
  useChannelLayout: () => ({ categories: [], channels: [], updatedAt: 0 }),
  useRelayOperatorPubkey: () => null,
  applyLayout: () => ({ categories: [], uncategorized: [] }),
  publishLayout: vi.fn(),
  newCategoryId: () => 'cat-test',
}));
vi.mock('@/lib/relay-roles', () => ({
  useRelayRoles: () => ({ roles: [], holders: {}, updatedAt: 0 }),
  rolesByPubkey: () => ({}),
}));
vi.mock('@/components/BlossomImageInput', () => ({
  default: () => null,
  ChannelAppearanceInput: () => null,
}));
vi.mock('@/components/admin/RelayAdminPanel', () => ({ default: () => null }));
vi.mock('@/components/admin/RelayEmojiAdminModal', () => ({ default: () => null }));
vi.mock('@/components/admin/RelayRolesAdminModal', () => ({ default: () => null }));

import { MemberListScreen } from './PhoneShell';

const MOD = { id: 'mod', name: 'Moderator', tier: 5, color: '#ff0000', emoji: '🛡️' };
const OG = { id: 'og', name: 'OG', tier: 2, color: '#00ff00', emoji: '' };

function renderScreen() {
  return render(
    <LocaleProvider>
      <MemberListScreen groupId="group-1" back={() => {}} openProfile={() => {}} />
    </LocaleProvider>,
  );
}

describe('mobile MemberListScreen', () => {
  beforeEach(() => {
    useChatStore.setState(useChatStore.getInitialState());
    roster.admins = ['alice'];
    roster.members = ['alice', 'mallory', 'oscar', 'pia'];
  });

  it('sections members by rank under the admins', () => {
    useChatStore.getState().setRolesByPubkey({
      mallory: [MOD],
      oscar: [OG],
      // An admin's role does not pull them out of the admin section.
      alice: [OG],
    });
    renderScreen();

    const labels = Array.from(document.querySelectorAll('.member-section-label')).map((n) => n.textContent);
    expect(labels).toEqual(['Admins · 1', '🛡️ Moderator · 1', 'OG · 1', 'Members · 1']);
    expect(within(screen.getByTestId('member-section-mod')).getByText('mallory')).toBeInTheDocument();
    expect(within(screen.getByTestId('member-section-og')).getByText('oscar')).toBeInTheDocument();
    expect(within(screen.getByTestId('member-section-member')).getByText('pia')).toBeInTheDocument();
  });

  it('keeps a single members section when nobody holds a role', () => {
    renderScreen();

    const labels = Array.from(document.querySelectorAll('.member-section-label')).map((n) => n.textContent);
    expect(labels).toEqual(['Admins · 1', 'Members · 3']);
  });
});
