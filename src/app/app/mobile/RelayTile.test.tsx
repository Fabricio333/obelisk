import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';

vi.mock('@/lib/relay-info', () => ({
  faviconFor: (url: string) => `https://favicon/${url}`,
  fetchRelayInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/relay-branding', () => ({
  useRelayBranding: () => ({}),
}));

import { MobileServerBanner, MobileServerRail, RelayTile, shouldIgnoreMobileSwipeTarget } from './PhoneShell';

describe('mobile swipe target guard', () => {
  it('ignores search/header chrome so a tap cannot also commit carousel navigation', () => {
    const banner = document.createElement('div');
    banner.className = 'server-banner-actions';
    const search = document.createElement('button');
    search.className = 'icon-btn';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    banner.append(search);
    search.append(svg);

    expect(shouldIgnoreMobileSwipeTarget(svg)).toBe(true);
  });

  it('keeps ordinary content eligible for horizontal swipe navigation', () => {
    const row = document.createElement('button');
    row.className = 'ch-row';
    row.textContent = 'general';

    expect(shouldIgnoreMobileSwipeTarget(row)).toBe(false);
  });

  it('ignores the mention autocomplete so tapping a name cannot seed a swipe', () => {
    // Regression: a thumb tap on a mention row drifts a few px, crossing the
    // 8px horizontal threshold in onTouchMove. The carousel would start
    // dragging and the user landed on a neighbouring screen with the mention
    // never inserted.
    const popup = document.createElement('div');
    popup.className = 'composer-mention-popup';
    const row = document.createElement('button');
    row.className = 'composer-mention-row';
    const name = document.createElement('span');
    row.append(name);
    popup.append(row);

    expect(shouldIgnoreMobileSwipeTarget(row)).toBe(true);
    expect(shouldIgnoreMobileSwipeTarget(name)).toBe(true);
  });
});

describe('RelayTile long-press', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('fires onLongPress after 500ms and suppresses the click', () => {
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(
      <RelayTile
        url="wss://relay.example"
        active={false}
        onClick={onClick}
        onLongPress={onLongPress}
      />,
    );

    const tile = screen.getByRole('button');
    fireEvent.touchStart(tile);
    vi.advanceTimersByTime(600);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'wss://relay.example' }),
    );

    fireEvent.touchEnd(tile);
    fireEvent.click(tile);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not fire onLongPress on a quick tap', () => {
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(
      <RelayTile
        url="wss://relay.example"
        active={false}
        onClick={onClick}
        onLongPress={onLongPress}
      />,
    );

    const tile = screen.getByRole('button');
    fireEvent.touchStart(tile);
    vi.advanceTimersByTime(120);
    fireEvent.touchEnd(tile);
    expect(onLongPress).not.toHaveBeenCalled();

    fireEvent.click(tile);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('cancels the timer when the touch moves (e.g. horizontal scroll drag)', () => {
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    render(
      <RelayTile
        url="wss://relay.example"
        active={false}
        onClick={onClick}
        onLongPress={onLongPress}
      />,
    );

    const tile = screen.getByRole('button');
    fireEvent.touchStart(tile);
    vi.advanceTimersByTime(200);
    fireEvent.touchMove(tile);
    vi.advanceTimersByTime(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('fires onLongPress on right-click and suppresses the native menu', () => {
    const onLongPress = vi.fn();
    render(
      <RelayTile
        url="wss://relay.example"
        active={false}
        onClick={() => {}}
        onLongPress={onLongPress}
      />,
    );

    const tile = screen.getByRole('button');
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    tile.dispatchEvent(evt);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });
});

describe('Mobile server layout pieces', () => {
  it('renders relays in a vertical rail and normalizes the active relay URL', () => {
    const onSelectRelay = vi.fn();
    const onAddRelay = vi.fn();

    render(
      <MobileServerRail
        relays={['wss://relay.one', 'wss://relay.two']}
        activeRelay="wss://relay.one/"
        onSelectRelay={onSelectRelay}
        onAddRelay={onAddRelay}
      />,
    );

    const rail = screen.getByTestId('mobile-server-rail');
    expect(rail.className).toContain('spaces-rail');
    expect(within(rail).getByRole('button', { name: /relay\.one/i }).className).toContain('active');

    fireEvent.click(within(rail).getByRole('button', { name: /relay\.two/i }));
    expect(onSelectRelay).toHaveBeenCalledWith('wss://relay.two');

    fireEvent.click(within(rail).getByRole('button', { name: /add relay/i }));
    expect(onAddRelay).toHaveBeenCalledTimes(1);
  });

  it('shows the active relay banner above the channel menu controls', () => {
    const onSearch = vi.fn();
    const onCreateChannel = vi.fn();
    const onOpenMenu = vi.fn();

    render(
      <LocaleProvider initialLocale="en">
        <MobileServerBanner
          label="La Crypta relay"
          relayUrl="wss://lacrypta-relay.obelisk.ar"
          iconUrl="https://img.example/icon.png"
          bannerUrl="https://img.example/banner.png"
          onSearch={onSearch}
          onCreateChannel={onCreateChannel}
          onOpenMenu={onOpenMenu}
        />
      </LocaleProvider>,
    );

    const banner = screen.getByTestId('mobile-server-banner');
    expect(banner.querySelector('.server-banner-img')).toHaveAttribute('src', 'https://img.example/banner.png');
    expect(screen.getByRole('heading', { name: 'La Crypta relay' })).toBeTruthy();
    expect(screen.getByText('lacrypta-relay.obelisk.ar')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Search this server'));
    fireEvent.click(screen.getByLabelText('Create channel'));
    fireEvent.click(screen.getByLabelText('Space menu'));

    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onCreateChannel).toHaveBeenCalledTimes(1);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
  });
});
