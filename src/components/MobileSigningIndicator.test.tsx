import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('MobileSigningIndicator', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('shows green while idle because signing is healthy', async () => {
    const { default: MobileSigningIndicator } = await import('./MobileSigningIndicator');
    const { LocaleProvider } = await import('@/i18n/context');

    render(
      <LocaleProvider initialLocale="en">
        <MobileSigningIndicator />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('mobile-signing-indicator').firstElementChild)
      .toHaveClass('bg-lc-green');
  });

  it('changes color state and explains the event being signed', async () => {
    const { pushActivity, resolveActivity } = await import('@/lib/activity-log');
    const { default: MobileSigningIndicator } = await import('./MobileSigningIndicator');
    const { LocaleProvider } = await import('@/i18n/context');
    const id = pushActivity('Waiting for bunker signature', 'kind 9', {
      operation: 'sign',
      eventKind: 9,
      description: 'Send message',
    });

    render(
      <LocaleProvider initialLocale="en">
        <MobileSigningIndicator />
      </LocaleProvider>,
    );
    const indicator = screen.getByTestId('mobile-signing-indicator');
    expect(indicator).toHaveAttribute('data-status', 'pending');
    fireEvent.click(indicator);
    expect(screen.getByText('Waiting for bunker signature')).toBeInTheDocument();
    expect(screen.getByText('Send message · kind 9')).toBeInTheDocument();

    resolveActivity(id);
    await waitFor(() => expect(indicator).toHaveAttribute('data-status', 'ok'));
  });
});
