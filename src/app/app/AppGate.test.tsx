import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({ default: () => () => <div data-testid="shell" /> }));
vi.mock('@/lib/nostr-bridge', () => ({ useIsLoggedIn: () => true }));
vi.mock('@/lib/read-state/root', () => ({ default: () => null }));
vi.mock('@/components/ActivityIndicator', () => ({
  default: () => <div data-testid="desktop-activity-indicator" />,
}));

import AppGate from './AppGate';

describe('AppGate activity indicator', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
  });

  it('does not mount the desktop activity notification stack on mobile', async () => {
    render(<AppGate />);

    await waitFor(() => expect(screen.getByTestId('shell')).toBeInTheDocument());
    expect(screen.queryByTestId('desktop-activity-indicator')).toBeNull();
  });
});
