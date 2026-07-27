import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import { DM_OPT_IN_STORAGE_KEY } from '@/lib/dm/opt-in';

const mockLogout = vi.hoisted(() => vi.fn());

vi.mock('@/components/settings/WotSettings', () => ({
  default: () => <div data-testid="wot-settings" />,
}));

vi.mock('@/lib/nostr-bridge/cache-clear', () => ({
  clearAllClientCacheExceptSession: () => 0,
}));

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    ensureUserMetadata: vi.fn().mockResolvedValue(undefined),
    editUserMetadata: vi.fn(),
    logout: (...args: unknown[]) => mockLogout(...args),
  },
  useSignerReady: () => true,
  useUserMetadata: () => ({
    displayName: 'Alice', name: 'Alice',
    picture: 'https://cdn.example/alice.jpg',
    banner: 'https://cdn.example/banner.jpg',
    about: null,
    nip05: null, website: null, lud16: null, pubkey: 'a'.repeat(64),
  }),
}));

vi.mock('@/components/media/MediaLibraryModal', () => ({
  default: () => <div data-testid="media-library-stub" />,
}));

describe('UserPanel personal media access', () => {
  beforeEach(() => mockLogout.mockClear());
  it('opens the media library directly from a normal user settings sidebar', async () => {
    const { default: UserPanel } = await import('./UserPanel');
    render(
      <LocaleProvider initialLocale="en">
        <UserPanel pubkey={'a'.repeat(64)} isMe initialEditing onClose={() => {}} />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByTestId('desktop-media-library'));
    expect(screen.getByTestId('media-library-stub')).toBeInTheDocument();
  });

  it('shows the profile artwork together and logs out from settings', async () => {
    const { default: UserPanel } = await import('./UserPanel');
    const onClose = vi.fn();
    render(
      <LocaleProvider initialLocale="en">
        <UserPanel pubkey={'a'.repeat(64)} isMe initialEditing onClose={onClose} />
      </LocaleProvider>,
    );

    const preview = screen.getByTestId('profile-appearance-preview');
    expect(preview.querySelector('img[alt="Banner"]')).toHaveAttribute('src', 'https://cdn.example/banner.jpg');
    expect(preview.querySelector('img[alt="Picture"]')).toHaveAttribute('src', 'https://cdn.example/alice.jpg');

    fireEvent.click(screen.getByTestId('desktop-logout'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mockLogout).toHaveBeenCalledOnce();
  });
});

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
