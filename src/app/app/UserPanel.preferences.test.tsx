import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/context';
import { DM_OPT_IN_STORAGE_KEY } from '@/lib/dm/opt-in';

const mockLogout = vi.hoisted(() => vi.fn());
const mockSelfPqState = vi.hoisted(() => vi.fn());

vi.mock('@/components/settings/WotSettings', () => ({
  default: () => <div data-testid="wot-settings" />,
}));

vi.mock('@/lib/nostr-bridge/cache-clear', () => ({
  clearAllClientCacheExceptSession: () => 0,
}));

vi.mock('@/lib/pq/capability', () => ({
  selfPqState: (...args: unknown[]) => mockSelfPqState(...args),
}));

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    ensureUserMetadata: vi.fn().mockResolvedValue(undefined),
    editUserMetadata: vi.fn(),
    logout: (...args: unknown[]) => mockLogout(...args),
  },
  useSignerReady: () => true,
  useMyPubkey: () => 'a'.repeat(64),
  useMyLoginMethod: () => 'nip07',
  useUserMetadata: () => ({
    displayName: 'Alice', name: 'Alice',
    picture: 'https://cdn.example/alice.jpg',
    banner: 'https://cdn.example/banner.jpg',
    about: null,
    nip05: null, website: null, lud16: null, pubkey: 'a'.repeat(64),
  }),
}));

vi.mock('@/components/media/MediaLibraryModal', () => ({
  default: ({ embedded }: { embedded?: boolean }) => <div data-testid="media-library-stub" data-embedded={embedded ? 'true' : 'false'} />,
}));

beforeEach(() => {
  mockSelfPqState.mockReset();
  mockSelfPqState.mockResolvedValue({
    canSend: false, capabilityUnknown: false, hasKeys: false, attestationPublished: false,
  });
});

describe('UserPanel personal media access', () => {
  beforeEach(() => mockLogout.mockClear());
  it('opens the media library inside the desktop settings workspace', async () => {
    const { default: UserPanel } = await import('./UserPanel');
    render(
      <LocaleProvider initialLocale="en">
        <UserPanel pubkey={'a'.repeat(64)} isMe initialEditing onClose={() => {}} />
      </LocaleProvider>,
    );

    fireEvent.click(screen.getByTestId('desktop-media-library'));
    expect(screen.getByTestId('media-library-stub')).toHaveAttribute('data-embedded', 'true');
    expect(screen.getByTestId('user-edit-modal')).toContainElement(screen.getByTestId('media-library-stub'));
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
    expect(screen.getByTestId('save-profile-button')).toHaveClass('lc-pill-primary');
    expect(screen.getByTestId('desktop-logout')).toHaveClass('bg-red-500/20', 'text-red-300', 'hover:bg-red-500/30');

    fireEvent.click(screen.getByTestId('desktop-logout'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mockLogout).toHaveBeenCalledOnce();
  });

  it('closes settings on Escape instead of falling back to the legacy profile card', async () => {
    const { default: UserPanel } = await import('./UserPanel');
    const onClose = vi.fn();
    render(
      <LocaleProvider initialLocale="en">
        <UserPanel pubkey={'a'.repeat(64)} isMe initialEditing onClose={onClose} />
      </LocaleProvider>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
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

    expect(screen.queryByTestId('appearance-accent-color')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('desktop-appearance-submenu'));
    expect(screen.getByTestId('appearance-accent-color')).toBeInTheDocument();
    expect(screen.getByTestId('appearance-background-color')).toBeInTheDocument();
    expect(screen.getByTestId('appearance-button-color')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-download-backup')).toBeInTheDocument();
    expect(screen.getByTestId('developer-signature-test')).toBeInTheDocument();
    expect(screen.getByTestId('clear-cache-button')).toHaveClass('bg-red-600', 'text-white');
    expect(screen.getByTestId('desktop-developer-settings')).toBe(screen.getByTestId('desktop-developer-settings').parentElement?.lastElementChild);
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

describe('post-quantum status row', () => {
  it('shows a checking state before selfPqState resolves', async () => {
    let resolve!: (v: unknown) => void;
    mockSelfPqState.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="en">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    expect(screen.getByText('Checking for post-quantum keys…')).toBeInTheDocument();
    resolve({ canSend: false, capabilityUnknown: false, hasKeys: false, attestationPublished: false });
  });

  it('reports detected keys once selfPqState resolves with hasKeys', async () => {
    mockSelfPqState.mockResolvedValue({
      canSend: false, capabilityUnknown: true, hasKeys: true, attestationPublished: true,
    });
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="en">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Post-quantum keys detected on this account.')).toBeInTheDocument();
    });
    expect(mockSelfPqState).toHaveBeenCalledWith('a'.repeat(64), 'nip07');
  });

  it('links to the guide when no keys are detected', async () => {
    mockSelfPqState.mockResolvedValue({
      canSend: false, capabilityUnknown: false, hasKeys: false, attestationPublished: false,
    });
    const { PreferencesPanel } = await import('./UserPanel');

    render(
      <LocaleProvider initialLocale="en">
        <PreferencesPanel />
      </LocaleProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('No post-quantum keys detected on this account.')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Set up post-quantum keys' })).toHaveAttribute(
      'href',
      '/guides/quantum-safe-dms',
    );
  });
});
