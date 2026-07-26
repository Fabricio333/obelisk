import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/store/chat';
import type { JsGroup } from '@/lib/nostr-bridge';
import type { ChannelLayout } from '@/lib/channel-layout';
import { ManageLayoutModal, RelayBrandingModal, RelaySettingsModal, SidebarMe } from './DesktopShell';

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => 'a'.repeat(64),
  useUserMetadata: () => ({ displayName: 'Alice', picture: null }),
}));

describe('SidebarMe', () => {
  beforeEach(() => useChatStore.setState(useChatStore.getInitialState()));

  it('opens my profile in the shared anchored preview', () => {
    render(<SidebarMe />);
    fireEvent.click(screen.getByTestId('sidebar-profile-button'), { clientX: 120, clientY: 700 });

    expect(useChatStore.getState().profilePopupPubkey).toBe('a'.repeat(64));
    expect(useChatStore.getState().profilePopupAnchor).toEqual({ x: 120, y: 700 });
  });
});

describe('RelaySettingsModal', () => {
  it('shows an SVG icon for every server settings destination', () => {
    render(<RelaySettingsModal onClose={vi.fn()} onBranding={vi.fn()} onEmojis={vi.fn()} onLayout={vi.fn()} onMembers={vi.fn()} />);

    expect(screen.getAllByTestId(/^server-settings-icon-/)).toHaveLength(4);
    expect(screen.getAllByTestId(/^server-settings-icon-/).every((icon) => icon.querySelector('svg'))).toBe(true);
  });
});

describe('RelayBrandingModal', () => {
  it('reuses the channel settings appearance layout for relay basics', () => {
    render(
      <RelayBrandingModal
        relayUrl="wss://relay.test"
        branding={{ name: 'Obelisk', description: 'A relay', icon: 'https://cdn/icon.png', banner: 'https://cdn/banner.png', updatedAt: 1 }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('channel-appearance-preview')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Obelisk')).toBeInTheDocument();
    expect(screen.getByDisplayValue('A relay')).toBeInTheDocument();
    expect(screen.queryByText('Access')).not.toBeInTheDocument();
    expect(screen.queryByText('Channel type')).not.toBeInTheDocument();
  });
});

describe('ManageLayoutModal', () => {
  it('moves a grabbed channel into the dropped category', () => {
    const layout: ChannelLayout = {
      categories: [
        { id: 'general', name: 'General', position: 0 },
        { id: 'voice', name: 'Voice', position: 1 },
      ],
      channels: [{ id: 'chat', categoryId: 'general', position: 0 }],
      updatedAt: 0,
    };
    const channels: JsGroup[] = [{
      id: 'chat', name: 'Chat', about: null, picture: null, banner: null,
      isPublic: true, isHidden: false, isRestricted: false, isOpen: true,
      parent: null, kind: 'text', forumTags: [], topics: [],
    }];
    render(<ManageLayoutModal relayUrl="wss://relay.test" layout={layout} channels={channels} onClose={vi.fn()} />);

    const transfer = { effectAllowed: '' };
    fireEvent.dragStart(screen.getByLabelText('Grab channel Chat'), { dataTransfer: transfer });
    fireEvent.dragOver(screen.getByTestId('layout-category-voice'), { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId('layout-category-voice'), { dataTransfer: transfer });

    expect(screen.getByTestId('layout-category-voice')).toContainElement(screen.getByTestId('layout-channel-chat'));
    expect(screen.getByLabelText('Grab category General')).toHaveAttribute('draggable', 'true');
  });
});
