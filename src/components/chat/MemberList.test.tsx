import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
