import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProfilePopover from './ProfilePopover';
import { useChatStore } from '@/store/chat';
import { LocaleProvider } from '@/i18n/context';

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

function renderProfile(onClose = vi.fn(), onExplore = vi.fn(), onMessage?: (pubkey: string) => void) {
  render(
    <LocaleProvider initialLocale="en">
      <ProfilePopover pubkey={PUBKEY} onClose={onClose} onExplore={onExplore} onMessage={onMessage} />
    </LocaleProvider>,
  );
}

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
    renderProfile();
    expect(screen.getByTestId('profile-name')).toHaveTextContent('AndyCreed');
    expect(screen.getByTestId('profile-handle')).toHaveTextContent('andycreed@example.com');
    expect(screen.getByTestId('profile-about')).toHaveTextContent('Building stuff');
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('renders the kind:0 banner', () => {
    renderProfile();
    expect(screen.getByTestId('profile-banner').style.backgroundImage).toContain('banner.jpg');
  });

  it('falls back to a short npub without relay or profile data', () => {
    bridge.members = [];
    bridge.metadata = null;
    renderProfile();
    expect(screen.getByTestId('profile-handle')).toHaveTextContent('npub1');
  });

  it('closes from the backdrop', () => {
    const onClose = vi.fn();
    renderProfile(onClose);
    fireEvent.click(screen.getByTestId('profile-popover-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not close from panel content', () => {
    const onClose = vi.fn();
    renderProfile(onClose);
    fireEvent.click(screen.getByTestId('profile-popover'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens the full feed only from Explore profile', () => {
    const onClose = vi.fn();
    const onExplore = vi.fn();
    renderProfile(onClose, onExplore);
    fireEvent.click(screen.getByTestId('profile-explore-btn'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onExplore).toHaveBeenCalledWith(PUBKEY);
  });

  it('anchors beside the clicked user and opens messages internally', () => {
    const onClose = vi.fn();
    const onMessage = vi.fn();
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(384);
    useChatStore.getState().openProfilePopup(PUBKEY, { x: 100, y: 700 });
    renderProfile(onClose, vi.fn(), onMessage);

    expect(screen.getByTestId('profile-popover')).toHaveStyle({ left: '112px', top: '392px' });
    fireEvent.click(screen.getByTestId('profile-message-btn'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(PUBKEY);
    height.mockRestore();
    width.mockRestore();
  });

  it('shows the npub ending with a copy icon instead of an njump link', () => {
    renderProfile();
    expect(screen.getByTestId('profile-copy-npub-btn')).toHaveTextContent('npub1aaaaaaa…aaaaaa');
    expect(screen.getByTestId('profile-handle')).toContainElement(screen.getByTestId('profile-copy-npub-btn'));
    expect(screen.getByTestId('profile-popover')).not.toHaveClass('overflow-y-auto');
    expect(screen.queryByTestId('profile-open-nostr-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-name-row')).toContainElement(screen.getByTestId('profile-zap-btn'));
    expect(screen.getByTestId('profile-compact-actions')).toContainElement(screen.getByTestId('profile-mute-btn'));
    expect(screen.getByTestId('profile-compact-actions')).toContainElement(screen.getByTestId('profile-block-btn'));
  });
});
