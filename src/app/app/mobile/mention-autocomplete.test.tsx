import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// PhoneShell imports the entire bridge surface as a side effect of the
// module evaluation; stub every named import so this focused test on the
// mention popup can render without a relay connection.
vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    sendReaction: vi.fn(),
    sendMessage: vi.fn(),
    createGroup: vi.fn(),
    switchRelay: vi.fn(),
    removeRelay: vi.fn(),
  },
  getBridge: vi.fn().mockResolvedValue({}),
  getBridgeImpl: vi.fn().mockReturnValue(null),
  useConfiguredRelays: () => ['wss://lacrypta-relay.obelisk.ar'],
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
  useMembersByGroup: () => ({}),
  useGroupCreators: () => ({}),
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

vi.mock('@/components/chat/MessageContent', () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

import { MobileMentionAutocomplete } from './PhoneShell';
import type { MemberInfo } from '@/lib/mentions';

const ALICE: MemberInfo = {
  pubkey: 'a'.repeat(64),
  displayName: 'Alice',
};

const BOB: MemberInfo = {
  pubkey: 'b'.repeat(64),
  displayName: 'Bob',
  picture: 'https://example.com/bob.png',
};

describe('MobileMentionAutocomplete', () => {
  it('renders nothing when the candidate list is empty', () => {
    const { container } = render(
      <MobileMentionAutocomplete
        members={[]}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one row per candidate with display name and short pubkey', () => {
    render(
      <MobileMentionAutocomplete
        members={[ALICE, BOB]}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('mobile-mention-option');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Alice');
    expect(rows[0].textContent).toContain('aaaaaaaa');
    expect(rows[1].textContent).toContain('Bob');
  });

  it('marks the selected row with the active class', () => {
    render(
      <MobileMentionAutocomplete
        members={[ALICE, BOB]}
        selectedIndex={1}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('mobile-mention-option');
    expect(rows[0].className).not.toContain('active');
    expect(rows[1].className).toContain('active');
  });

  it('fires onSelect with the tapped member on click', () => {
    // Selection deliberately hangs off `click`, not `mousedown`: on touch the
    // synthesized mousedown is unreliable and never arrives at all when the
    // gesture gets claimed elsewhere, whereas click fires for mouse and tap
    // alike and is suppressed after a real scroll.
    const onSelect = vi.fn();
    render(
      <MobileMentionAutocomplete
        members={[ALICE, BOB]}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('mobile-mention-option');
    fireEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(BOB);
  });

  it('preventDefaults mousedown without selecting, so focus and the soft keyboard survive', () => {
    const onSelect = vi.fn();
    render(
      <MobileMentionAutocomplete
        members={[ALICE, BOB]}
        selectedIndex={0}
        onSelect={onSelect}
        onHover={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('mobile-mention-option');
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    rows[1].dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    // Must NOT select here — otherwise a mouse tap fires onSelect twice.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('uses the picture when present and falls back to an initial otherwise', () => {
    render(
      <MobileMentionAutocomplete
        members={[ALICE, BOB]}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('mobile-mention-option');
    // Alice has no picture — fallback initial.
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[0].textContent).toContain('A');
    // Bob has a picture — img is rendered.
    expect(rows[1].querySelector('img')?.getAttribute('src')).toBe(BOB.picture);
  });

  it('reports hover with the row index', () => {
    const onHover = vi.fn();
    render(
      <MobileMentionAutocomplete
        members={[ALICE, BOB]}
        selectedIndex={0}
        onSelect={() => {}}
        onHover={onHover}
      />,
    );
    const rows = screen.getAllByTestId('mobile-mention-option');
    fireEvent.mouseEnter(rows[1]);
    expect(onHover).toHaveBeenCalledWith(1);
  });
});
