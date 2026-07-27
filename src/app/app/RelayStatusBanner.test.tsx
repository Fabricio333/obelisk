import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBridge = vi.hoisted(() => ({
  isLoggedIn: true,
  connectionState: 'Connected',
  relayAccess: 'ok',
  loginMethod: 'nsec' as 'nsec' | 'nip07' | 'bunker' | null,
  relayUrl: 'wss://public.obelisk.ar',
}));

vi.mock('@/lib/nostr-bridge', () => ({
  useIsLoggedIn: () => mockBridge.isLoggedIn,
  useConnectionState: () => mockBridge.connectionState,
  useRelayAccess: () => mockBridge.relayAccess,
  useMyLoginMethod: () => mockBridge.loginMethod,
  useCurrentRelayUrl: () => mockBridge.relayUrl,
}));

import RelayStatusBanner from './RelayStatusBanner';

describe('RelayStatusBanner test ids', () => {
  beforeEach(() => {
    mockBridge.isLoggedIn = true;
    mockBridge.connectionState = 'Connected';
    mockBridge.relayAccess = 'ok';
    mockBridge.loginMethod = 'nsec';
    mockBridge.relayUrl = 'wss://public.obelisk.ar';
  });

  it('surfaces restricted relay access through the e2e relay-access banner selector', () => {
    mockBridge.relayAccess = 'restricted';

    render(<RelayStatusBanner />);

    const banner = screen.getByTestId('relay-access-banner');
    expect(banner).toHaveAttribute('data-state', 'restricted');
    expect(banner).toHaveTextContent('Not whitelisted');
    expect(banner).toHaveClass('rounded-xl');
    expect(banner).not.toHaveClass('border-b');
  });

  it('lets the mobile top signer status own authentication notices', () => {
    mockBridge.relayAccess = 'authenticating';
    const { rerender } = render(<RelayStatusBanner hideAuthenticating />);
    expect(screen.queryByTestId('relay-access-banner')).toBeNull();

    mockBridge.relayAccess = 'auth-required';
    rerender(<RelayStatusBanner hideAuthenticating />);
    expect(screen.queryByTestId('relay-access-banner')).toBeNull();

    mockBridge.connectionState = 'Disconnected';
    rerender(<RelayStatusBanner hideAuthenticating />);
    expect(screen.getByTestId('connection-loss-banner')).toHaveTextContent('Connection lost');
  });

  it('surfaces offline mode with cached-content guidance', () => {
    mockBridge.connectionState = 'Offline';

    render(<RelayStatusBanner />);

    const banner = screen.getByTestId('connection-loss-banner');
    expect(banner).toHaveAttribute('data-state', 'offline');
    expect(banner).toHaveTextContent('You’re offline');
    expect(banner).toHaveTextContent('Cached channels and messages remain available');
  });

  it('surfaces socket loss through the e2e connection-loss banner selector', () => {
    mockBridge.connectionState = 'Disconnected';

    render(<RelayStatusBanner />);

    const banner = screen.getByTestId('connection-loss-banner');
    expect(banner).toHaveAttribute('data-state', 'disconnected');
    expect(banner).toHaveTextContent('Connection lost');
  });
});
