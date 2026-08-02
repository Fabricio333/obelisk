import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/store/chat';
import type { JsGroup } from '@/lib/nostr-bridge';
import type { ChannelLayout } from '@/lib/channel-layout';
import { LocaleProvider } from '@/i18n/context';
import { useNotificationsStore, NOTIFICATIONS_INITIAL } from '@/store/notifications';
import { useReadStateStore, READ_STATE_INITIAL } from '@/store/read-state';
import { ManageLayoutModal, RelayBrandingModal, RelaySettingsModal, RelayTopBar, SidebarMe } from './DesktopShell';

vi.mock('@/lib/nostr-bridge', () => ({
  useMyPubkey: () => 'a'.repeat(64),
  useUserMetadata: () => ({ displayName: 'Alice', picture: null }),
  getBridgeImpl: () => null,
}));

vi.mock('@/lib/relay-info', () => ({
  faviconFor: (url: string) => `https://favicon/${url}`,
  fetchRelayInfo: vi.fn().mockResolvedValue(null),
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
    render(<RelaySettingsModal onClose={vi.fn()} onBranding={vi.fn()} onEmojis={vi.fn()} onLayout={vi.fn()} onMembers={vi.fn()} onRoles={vi.fn()} />);

    expect(screen.getAllByTestId(/^server-settings-icon-/)).toHaveLength(5);
    expect(screen.getAllByTestId(/^server-settings-icon-/).every((icon) => icon.querySelector('svg'))).toBe(true);
  });

  it('routes the roles entry to the roles admin surface', () => {
    const onRoles = vi.fn();
    render(<RelaySettingsModal onClose={vi.fn()} onBranding={vi.fn()} onEmojis={vi.fn()} onLayout={vi.fn()} onMembers={vi.fn()} onRoles={onRoles} />);

    fireEvent.click(screen.getByText('Roles & ranks'));

    expect(onRoles).toHaveBeenCalled();
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


describe('RelayTopBar help popover', () => {
  const RELAY = 'wss://relay.test';

  function renderTopBar() {
    return render(
      <LocaleProvider initialLocale="en">
        <RelayTopBar relay={RELAY} />
      </LocaleProvider>,
    );
  }

  beforeEach(() => {
    useNotificationsStore.setState({ ...NOTIFICATIONS_INITIAL });
    useReadStateStore.setState({ ...READ_STATE_INITIAL });
  });

  it('opens an in-place panel instead of navigating away to /help', () => {
    renderTopBar();
    expect(screen.queryByTestId('help-popover')).toBeNull();

    fireEvent.click(screen.getByLabelText('Help'));

    expect(screen.getByTestId('help-popover')).toBeTruthy();
  });

  it('lists the four help topics and a view-more pill', () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText('Help'));

    const topics = screen.getAllByTestId(/^help-popover-topic-/);
    expect(topics).toHaveLength(4);
    expect(topics.map((a) => a.getAttribute('href'))).toEqual([
      '/guides/what-is-obelisk',
      '/guides/how-obelisk-works',
      '/guides/admin-cli',
      '/guides/bitcoin-zaps',
    ]);

    const viewMore = screen.getByTestId('help-popover-view-more');
    expect(viewMore.getAttribute('href')).toBe('/guides');
    // "pill" == fully rounded, per the La Crypta convention.
    expect(viewMore.className).toContain('rounded-full');
  });

  it('wraps each topic in its own card container', () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText('Help'));

    const topics = screen.getAllByTestId(/^help-popover-topic-/);
    expect(topics).toHaveLength(4);
    // Each option is a discrete lc-card, not a flat menu row.
    expect(topics.every((a) => a.className.includes('lc-card'))).toBe(true);
    // Cards need a recessed well behind them, otherwise .lc-card's #171717
    // is identical to the popover's own bg-lc-dark and they vanish.
    const well = topics[0].closest('[data-help-popover] > div');
    expect(well?.className).toContain('bg-lc-black');
  });

  it('closes on Escape', () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText('Help'));
    expect(screen.getByTestId('help-popover')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('help-popover')).toBeNull();
  });

  it('never shows the help and notification panels at once', () => {
    renderTopBar();

    fireEvent.click(screen.getByLabelText('Notifications'));
    expect(screen.getByTestId('notif-tabs')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Help'));

    expect(screen.getByTestId('help-popover')).toBeTruthy();
    expect(screen.queryByTestId('notif-tabs')).toBeNull();
  });
});

describe('RelayTopBar notification controls', () => {
  const RELAY = 'wss://relay.test';

  function renderTopBar() {
    return render(
      <LocaleProvider initialLocale="en">
        <RelayTopBar relay={RELAY} />
      </LocaleProvider>,
    );
  }

  beforeEach(() => {
    useNotificationsStore.setState({ ...NOTIFICATIONS_INITIAL });
    useReadStateStore.setState({ ...READ_STATE_INITIAL });
  });

  it('renders mark-read and clear as pills when there is something to act on', () => {
    useNotificationsStore.setState({
      mentionsByRelay: {
        [RELAY]: [{
          id: 'm1',
          relay: RELAY,
          channelId: 'ch1',
          senderPubkey: 'b'.repeat(64),
          preview: 'hey @me',
          createdAt: Date.now(),
        }],
      },
    });

    renderTopBar();
    fireEvent.click(screen.getByLabelText('Notifications'));

    expect(screen.getByTestId('notif-mark-read').className).toContain('rounded-full');
    expect(screen.getByTestId('notif-clear').className).toContain('rounded-full');
  });

  it('hides both controls when the visible stream is empty', () => {
    renderTopBar();
    fireEvent.click(screen.getByLabelText('Notifications'));

    expect(screen.queryByTestId('notif-mark-read')).toBeNull();
    expect(screen.queryByTestId('notif-clear')).toBeNull();
  });
});
