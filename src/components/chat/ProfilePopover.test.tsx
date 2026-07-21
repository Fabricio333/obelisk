import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePopover from './ProfilePopover';
import { useChatStore } from '@/store/chat';

const bridge = vi.hoisted(() => ({
  members: [] as Array<{ pubkey: string; displayName: string; picture?: string; nip05?: string; role: 'admin' | 'member' }>,
  metadata: null as null | {
    pubkey: string;
    name: string | null;
    displayName: string | null;
    picture: string | null;
    about: string | null;
    nip05: string | null;
    banner: string | null;
    lud16: string | null;
    website: string | null;
  },
}));

vi.mock('@/lib/nostr-bridge', () => ({
  useGroupMemberInfo: () => bridge.members,
  useMyPubkey: () => null,
  useUserMetadata: () => bridge.metadata,
}));

vi.mock('@nostr-wot/data', () => ({
  formatPubkey: vi.fn((pubkey: string) => `${pubkey.slice(0, 8)}…`),
  hexToNpub: vi.fn((pubkey: string) => `npub1${pubkey}`),
}));

const PUBKEY = 'a'.repeat(64);

describe('ProfilePopover', () => {
  beforeEach(() => {
    useChatStore.setState({ ...useChatStore.getInitialState(), activeChannelId: 'group' });
    bridge.members = [{
      pubkey: PUBKEY,
      displayName: 'AndyCreed',
      picture: 'https://example.com/pic.jpg',
      role: 'admin',
    }];
    bridge.metadata = {
      pubkey: PUBKEY,
      name: 'andy',
      displayName: 'AndyCreed',
      picture: 'https://example.com/pic.jpg',
      banner: 'https://example.com/banner.jpg',
      nip05: 'andycreed@example.com',
      about: 'Building stuff',
      lud16: null,
      website: null,
    };
  });

  it('combines relay membership with kind:0 profile metadata', () => {
    render(<ProfilePopover pubkey={PUBKEY} onClose={() => {}} />);
    expect(screen.getByTestId('profile-name')).toHaveTextContent('AndyCreed');
    expect(screen.getByTestId('profile-handle')).toHaveTextContent('andycreed@example.com');
    expect(screen.getByTestId('profile-about')).toHaveTextContent('Building stuff');
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('renders the kind:0 banner', () => {
    render(<ProfilePopover pubkey={PUBKEY} onClose={() => {}} />);
    expect(screen.getByTestId('profile-banner').style.backgroundImage).toContain('banner.jpg');
  });

  it('falls back to a short npub without relay or profile data', () => {
    bridge.members = [];
    bridge.metadata = null;
    render(<ProfilePopover pubkey={PUBKEY} onClose={() => {}} />);
    expect(screen.getByTestId('profile-handle')).toHaveTextContent('npub1');
  });

  it('closes from the backdrop', () => {
    const onClose = vi.fn();
    render(<ProfilePopover pubkey={PUBKEY} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('profile-popover-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close from panel content', () => {
    const onClose = vi.fn();
    render(<ProfilePopover pubkey={PUBKEY} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('profile-popover'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
