import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/app/RelayStatusBanner', () => ({ default: () => 'relay status' }));

describe('ActivityIndicator', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('prioritizes typed signing waits and renders the event kind description', async () => {
    const { pushActivity } = await import('@/lib/activity-log');
    const { default: ActivityIndicator } = await import('./ActivityIndicator');

    pushActivity('Publishing to relays', 'kind 9', { operation: 'publish', eventKind: 9 });
    pushActivity('Waiting for extension signature', 'kind 22242', {
      operation: 'sign',
      eventKind: 22242,
      description: 'NIP-42 relay auth',
    });

    render(<ActivityIndicator />);

    expect(screen.getByTestId('activity-indicator')).toHaveClass('hidden', 'lg:flex');
    expect(screen.getByText('Waiting for extension signature')).toBeInTheDocument();
    expect(screen.getByText('NIP-42 relay auth · kind 22242')).toBeInTheDocument();
    expect(screen.queryByText('Publishing to relays')).toBeNull();
    expect(screen.getByText('relay status')).toBeInTheDocument();
  });

  it('hides the signing and publishing lifecycle on mobile', async () => {
    const { pushActivity } = await import('@/lib/activity-log');
    const { default: ActivityIndicator } = await import('./ActivityIndicator');
    pushActivity('Waiting for extension signature', undefined, { operation: 'sign' });
    pushActivity('Publishing to relays', undefined, { operation: 'publish' });

    render(<ActivityIndicator hideSigning />);

    expect(screen.queryByText('Waiting for extension signature')).toBeNull();
    expect(screen.queryByText('Publishing to relays')).toBeNull();
    expect(screen.getByText('relay status')).toBeInTheDocument();
  });
});
