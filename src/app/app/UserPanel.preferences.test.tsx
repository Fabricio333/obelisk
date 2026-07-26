import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import { DM_OPT_IN_STORAGE_KEY } from '@/lib/dm/opt-in';

vi.mock('@/components/settings/WotSettings', () => ({
  default: () => <div data-testid="wot-settings" />,
}));

vi.mock('@/lib/nostr-bridge/cache-clear', () => ({
  clearAllClientCacheExceptSession: () => 0,
}));

describe('PreferencesPanel appearance controls', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('includes shared app appearance controls', async () => {
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="en">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('appearance-accent-color')).toBeInTheDocument();
    expect(screen.getByTestId('appearance-background-color')).toBeInTheDocument();
    expect(screen.getByTestId('appearance-button-color')).toBeInTheDocument();
  });

  it('includes a direct-message opt-in reset toggle', async () => {
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="en">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    const label = screen.getByText('Direct messages');
    const button = label.closest('label')?.querySelector('button');
    expect(button).toBeTruthy();

    fireEvent.click(button!);
    expect(JSON.parse(localStorage.getItem(DM_OPT_IN_STORAGE_KEY) ?? '{}')).toMatchObject({
      directMessagesEnabled: true,
    });
  });

  it('saves exactly three profile-feed relays', async () => {
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="en">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    fireEvent.change(screen.getByLabelText('Profile feed relay 1'), { target: { value: 'wss://one.example' } });
    fireEvent.change(screen.getByLabelText('Profile feed relay 2'), { target: { value: 'wss://two.example' } });
    fireEvent.change(screen.getByLabelText('Profile feed relay 3'), { target: { value: 'wss://three.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(JSON.parse(localStorage.getItem('obelisk:preferences') ?? '{}')).toMatchObject({
      profileFeedRelays: ['wss://one.example', 'wss://two.example', 'wss://three.example'],
    });
  });

  it('renders preference labels from the configured language', async () => {
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="es">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    expect(screen.getByText('Idioma')).toBeInTheDocument();
    expect(screen.getByText('Mensajes directos')).toBeInTheDocument();
    expect(screen.getByText(/DMs encriptados de Nostr/i)).toBeInTheDocument();
  });
});
