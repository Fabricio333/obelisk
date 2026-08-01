import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import MemberList from './MemberList';
import { useChatStore } from '@/store/chat';

const bridge = vi.hoisted(() => ({
  members: [] as Array<{
    pubkey: string;
    displayName: string;
    picture?: string;
    nip05?: string;
    role: 'admin' | 'member';
  }>,
}));

vi.mock('@/lib/nostr-bridge', () => ({
  useGroupMemberInfo: () => bridge.members,
  useCurrentRelayUrl: () => 'wss://group.relay',
}));

vi.mock('@/hooks/chat/useNostrPresence', () => ({
  useNostrPresence: () => undefined,
  PRESENCE_WINDOW_MS: 15 * 60 * 1000,
  presenceActivityKey: (relay: string, pubkey: string) => relay + ':' + pubkey,
}));

function setOnline(...pubkeys: string[]) {
  for (const pubkey of pubkeys) useChatStore.getState().recordActivity('wss://group.relay:' + pubkey, Date.now());
}

describe('MemberList', () => {
  beforeEach(() => {
    useChatStore.setState(useChatStore.getInitialState());
    bridge.members = [
      { pubkey: 'admin', displayName: 'Alice', role: 'admin' },
      { pubkey: 'member', displayName: 'Bob', role: 'member' },
    ];
  });

  it('renders relay members with presence and base roles', () => {
    setOnline('admin');
    render(<MemberList groupId="group-1" />);

    expect(screen.getByText(/Admin — 1/)).toBeInTheDocument();
    expect(screen.getByText(/Offline — 1/)).toBeInTheDocument();
    expect(screen.getByTitle('Online')).toHaveClass('bg-lc-green');
    expect(screen.getByTitle('Offline')).toHaveClass('bg-lc-muted');
    expect(screen.getByLabelText('Role: Admin')).toBeInTheDocument();
  });

  it('shows each member’s highest relay role beside their name', () => {
    setOnline('admin', 'member');
    useChatStore.getState().setRolesByPubkey({
      admin: [{ id: 'core', name: 'Core', tier: 5, color: '#ff0000', emoji: '' }, { id: 'og', name: 'OG', tier: 1, color: '#00ff00', emoji: '' }],
    });
    render(<MemberList groupId="group-1" />);

    const badges = screen.getAllByTestId('role-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Core');
    expect(badges[0].closest('[data-testid="member-item"]')).toHaveTextContent('Alice');
  });

  it('ranks online members by role under admins', () => {
    bridge.members = [
      { pubkey: 'admin', displayName: 'Alice', role: 'admin' },
      { pubkey: 'mod', displayName: 'Mallory', role: 'member' },
      { pubkey: 'og', displayName: 'Oscar', role: 'member' },
      { pubkey: 'plain', displayName: 'Pia', role: 'member' },
      { pubkey: 'away', displayName: 'Wendy', role: 'member' },
    ];
    setOnline('admin', 'mod', 'og', 'plain');
    useChatStore.getState().setRolesByPubkey({
      mod: [{ id: 'mod', name: 'Moderator', tier: 5, color: '#ff0000', emoji: '🛡️' }],
      og: [{ id: 'og', name: 'OG', tier: 2, color: '#00ff00', emoji: '' }],
      // A role on an admin does not move them out of the admin section.
      admin: [{ id: 'og', name: 'OG', tier: 2, color: '#00ff00', emoji: '' }],
    });
    render(<MemberList groupId="group-1" />);

    const headings = Array.from(
      screen.getByTestId('member-list').querySelectorAll('[data-testid^="member-group-"] > div:first-child'),
    ).map((node) => node.textContent);
    expect(headings).toEqual(['Admin — 1', '🛡️ Moderator — 1', 'OG — 1', 'Member — 1']);
    expect(within(screen.getByTestId('member-group-admin')).getByText('Alice')).toBeInTheDocument();
    expect(within(screen.getByTestId('member-group-mod')).getByText('Mallory')).toBeInTheDocument();
    expect(within(screen.getByTestId('member-group-og')).getByText('Oscar')).toBeInTheDocument();
    expect(within(screen.getByTestId('member-group-member')).getByText('Pia')).toBeInTheDocument();
    // Offline stays one section whatever rank they hold.
    expect(screen.getByText(/Offline — 1/)).toBeInTheDocument();
  });

  it('collapses offline members', () => {
    setOnline('admin');
    render(<MemberList groupId="group-1" />);

    expect(screen.getByText('Bob')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('offline-toggle'));
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('opens the selected bridge profile', () => {
    render(<MemberList groupId="group-1" />);
    fireEvent.click(screen.getByText('Alice'), { clientX: 200, clientY: 300 });
    expect(useChatStore.getState().profilePopupPubkey).toBe('admin');
    expect(useChatStore.getState().profilePopupAnchor).toEqual({ x: 200, y: 300 });
  });

  it('renders an empty list while relay members load', () => {
    bridge.members = [];
    render(<MemberList groupId="group-1" />);
    expect(screen.getByTestId('member-list')).toBeEmptyDOMElement();
  });
});
