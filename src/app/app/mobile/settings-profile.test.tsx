import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { DM_OPT_IN_STORAGE_KEY, setDmOptInEnabled } from '@/lib/dm/opt-in';

// Bridge identity hooks back the profile screen — mock them so the test can
// drive the rendered values without a real relay connection.
const mockLogout = vi.fn();
const mockPublishProfile = vi.fn().mockResolvedValue(undefined);

let mockMeta: {
  pubkey: string;
  name: string | null;
  displayName: string | null;
  picture: string | null;
  banner: string | null;
  about: string | null;
  nip05: string | null;
  lud16: string | null;
  website: string | null;
} | null = null;
let mockPubkey: string | null = null;

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    logout: (...a: unknown[]) => mockLogout(...a),
    switchRelay: vi.fn(),
    removeRelay: vi.fn(),
    createGroup: vi.fn(),
    signEventTemplate: vi.fn(),
    ensureUserMetadata: vi.fn(),
    editUserMetadata: (...a: unknown[]) => mockPublishProfile(...a),
  },
  useIsLoggedIn: () => true,
  useMyPubkey: () => mockPubkey,
  useSignerReady: () => true,
  useUserMetadata: () => mockMeta,
  useIsRehydrating: () => false,
  useGroups: () => [],
  useChildrenByParent: () => ({}),
  useMessages: () => [],
  useLoadEarlier: () => ({ loadEarlier: vi.fn(), loading: false, reachedStart: true }),
  useDirectMessages: () => [],
  useAdmins: () => [],
  useAdminsByGroup: () => ({}),
  useMembers: () => [],
  useReactions: () => ({}),
  useConfiguredRelays: () => ['wss://lacrypta-relay.obelisk.ar'],
  useCurrentRelayUrl: () => 'wss://lacrypta-relay.obelisk.ar',
  useRelayAccess: () => ({ status: 'ok' }),
  useConnectionState: () => 'connected',
  useGroupMetadataEose: () => true,
  useActiveCallByChannel: () => ({}),
}));

vi.mock('@nostr-wot/data/react', () => ({
  useFollows: () => null,
}));

vi.mock('@/lib/relay-info', () => ({
  faviconFor: (url: string) => `https://favicon/${url}`,
  fetchRelayInfo: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/relay-branding', () => ({
  useRelayBranding: () => ({}),
  publishBranding: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/channel-layout', () => ({
  useChannelLayout: () => ({ categories: [], channels: [], updatedAt: 0 }),
  useRelayOperatorPubkey: () => null,
  applyLayout: () => ({ categories: [], uncategorized: [] }),
  publishLayout: vi.fn().mockResolvedValue(undefined),
  newCategoryId: () => 'cat-test',
}));

vi.mock('@/components/BlossomImageInput', () => ({
  default: ({ label }: { label: string }) => <div data-testid={`blossom-${label.toLowerCase()}`}>{label}</div>,
}));

vi.mock('@/lib/blossom', () => ({
  uploadToBlossom: vi.fn().mockResolvedValue('https://blossom.example/img.jpg'),
}));

vi.mock('@/components/admin/RelayAdminPanel', () => ({
  default: () => <div data-testid="relay-admin-panel-stub" />,
}));

vi.mock('@/components/media/MediaLibraryModal', () => ({
  default: () => <div data-testid="media-library-stub" />,
}));

vi.mock("@/components/chat/NostrProfile", () => ({
  default: ({ pubkey, settingsMode, onEditProfile }: { pubkey: string; settingsMode?: boolean; onEditProfile?: () => void }) => (
    <div data-testid="settings-profile-explorer" data-pubkey={pubkey} data-settings-mode={settingsMode ? "true" : "false"}>
      <button data-testid="edit-profile-btn" onClick={onEditProfile}>Edit profile</button>
      <button data-testid="profile-tab-posts">Posts</button>
      <button data-testid="profile-tab-replies">Replies</button>
      <button data-testid="profile-tab-media">Media</button>
      <button data-testid="profile-create-post">Create post</button>
    </div>
  ),
}));

import { LocaleProvider } from '@/i18n/context';
import type { Locale } from '@/i18n/index';
import { SettingsProfileScreen, EditProfileScreen, SettingsPrefsScreen } from './PhoneShell';

function renderWithLocale(ui: ReactElement, locale: Locale = 'en') {
  return render(<LocaleProvider initialLocale={locale}>{ui}</LocaleProvider>);
}

const PUBKEY = '1'.repeat(64);

beforeEach(() => {
  localStorage.clear();
  setDmOptInEnabled(false);
  mockPubkey = PUBKEY;
  mockMeta = {
    pubkey: PUBKEY,
    name: 'Fabricio',
    displayName: 'Fabricio',
    picture: 'https://example.com/avatar.jpg',
    banner: 'https://example.com/banner.jpg',
    about: 'Building Obelisk on Nostr.',
    nip05: 'fabri@hodl.ar',
    lud16: 'fabri@walletofsatoshi.com',
    website: 'https://obelisk.ar',
  };
});

afterEach(() => {
  mockLogout.mockReset();
  mockPublishProfile.mockReset().mockResolvedValue(undefined);
  vi.useRealTimers();
});

describe("SettingsProfileScreen", () => {
  it("reuses the shared profile explorer with owner controls", () => {
    const go = vi.fn();
    renderWithLocale(<SettingsProfileScreen go={go} />);

    expect(screen.getByTestId("settings-profile-explorer")).toHaveAttribute("data-pubkey", PUBKEY);
    expect(screen.getByTestId("settings-profile-explorer")).toHaveAttribute("data-settings-mode", "true");
    expect(screen.getByTestId("profile-tab-posts")).toBeInTheDocument();
    expect(screen.getByTestId("profile-tab-replies")).toBeInTheDocument();
    expect(screen.getByTestId("profile-tab-media")).toBeInTheDocument();
    expect(screen.getByTestId("profile-create-post")).toBeInTheDocument();
    expect(screen.queryByTestId("mobile-profile-media-library")).not.toBeInTheDocument();
    expect(screen.queryByTestId("disconnect-btn")).not.toBeInTheDocument();
    expect(screen.queryByText("Open in another client")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("edit-profile-btn"));
    expect(go).toHaveBeenCalledWith("profile-edit");
  });
});

describe("SettingsPrefsScreen", () => {
  it('shows language controls in preferences', () => {
    render(
      <LocaleProvider initialLocale="en">
        <SettingsPrefsScreen go={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('language-preference')).toBeTruthy();
    expect(screen.getByTestId('language-option-en')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('mobile-download-backup')).toBeInTheDocument();
    expect(screen.getByTestId('developer-signature-test')).toBeInTheDocument();
  });

  it("keeps media management and disconnect in preferences", () => {
    renderWithLocale(<SettingsPrefsScreen go={vi.fn()} />);

    fireEvent.click(screen.getByTestId("mobile-media-library"));
    expect(screen.getByTestId("media-library-stub")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("disconnect-btn"));
    expect(mockLogout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("disconnect-confirm"));
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("lets users enable or reset DM opt-in from preferences", () => {
    render(
      <LocaleProvider initialLocale="en">
        <SettingsPrefsScreen go={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByTestId('mobile-dm-opt-in-toggle')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByText('Direct messages').closest('button')!);

    expect(screen.getByTestId('mobile-dm-opt-in-toggle')).toHaveAttribute('aria-checked', 'true');
    expect(JSON.parse(localStorage.getItem(DM_OPT_IN_STORAGE_KEY) ?? '{}')).toMatchObject({
      directMessagesEnabled: true,
    });
  });

  it('hides duplicate relay switching and opens appearance as a submenu', () => {
    renderWithLocale(<SettingsPrefsScreen go={vi.fn()} />);

    expect(screen.queryByText('Relays · 1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appearance-controls')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mobile-appearance-submenu'));
    expect(screen.getByTestId('appearance-controls')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('appearance-controls')).not.toBeInTheDocument();
    expect(screen.getByTestId('mobile-appearance-submenu')).toBeInTheDocument();
  });

  it('renders preferences from the configured language', () => {
    render(
      <LocaleProvider initialLocale="es">
        <SettingsPrefsScreen go={vi.fn()} />
      </LocaleProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Vos' })).toBeTruthy();
    expect(screen.queryByText('Relays · 1')).toBeNull();
    expect(screen.getByText('Apariencia')).toBeTruthy();
    expect(screen.getByText('Mensajes directos')).toBeTruthy();
    expect(screen.getByText(/DMs encriptados de Nostr/i)).toBeTruthy();
  });
});

describe('EditProfileScreen', () => {
  it('hydrates inputs from the current user metadata', () => {
    renderWithLocale(<EditProfileScreen go={vi.fn()} />);
    expect((screen.getByTestId('edit-name') as HTMLInputElement).value).toBe('Fabricio');
    expect((screen.getByTestId('edit-about') as HTMLTextAreaElement).value).toBe('Building Obelisk on Nostr.');
  });

  it('publishes via publishProfile and pops back on save', async () => {
    const go = vi.fn();
    renderWithLocale(<EditProfileScreen go={go} />);
    fireEvent.change(screen.getByTestId('edit-name'), { target: { value: 'Fabricio v2' } });
    fireEvent.change(screen.getByTestId('edit-about'), { target: { value: 'New bio' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('save-profile'));
    });
    expect(mockPublishProfile).toHaveBeenCalledTimes(1);
    const opts = mockPublishProfile.mock.calls[0][0];
    expect(opts.name).toBe('Fabricio v2');
    expect(opts.displayName).toBe('Fabricio v2');
    expect(opts.about).toBe('New bio');
    expect(go).toHaveBeenCalledWith('settings-profile', 'back');
  });

  it('blocks save when the display name is empty', () => {
    renderWithLocale(<EditProfileScreen go={vi.fn()} />);
    fireEvent.change(screen.getByTestId('edit-name'), { target: { value: '   ' } });
    const saveBtn = screen.getByTestId('save-profile') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });
});
