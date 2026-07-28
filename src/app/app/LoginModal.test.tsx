import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import { Nip46Signer } from '@nostr-wot/signers';
import LoginModal, { copyConnectionUri, isTransientNip46Error, signerAppHref } from './LoginModal';

const bunkerFromUri = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
const loginWithNsec = vi.fn();
const loginWithBunker = vi.fn();
const publish = vi.fn((_relays: string[], _event: unknown) => [Promise.resolve('ok')]);
let updateDraft: ((patch: Record<string, string>) => void) | undefined;
let sdkProps: Record<string, unknown> = {};

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    loginWithNsec: (...args: unknown[]) => loginWithNsec(...args),
    loginWithNip07: vi.fn(),
    loginWithBunker: (...args: unknown[]) => loginWithBunker(...args),
  },
}));

vi.mock('nostr-tools/nip46', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools/nip46')>();
  return {
    ...actual,
    BunkerSigner: { fromURI: (...args: unknown[]) => bunkerFromUri(...args) },
  };
});

vi.mock('@nostr-wot/data', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nostr-wot/data')>(),
  getPool: () => ({ publish }),
}));

vi.mock('./GeneratedProfileEnhancements', () => ({
  default: ({ onDraftChange }: { onDraftChange: (patch: Record<string, string>) => void }) => {
    updateDraft = onDraftChange;
    return null;
  },
}));

vi.mock('@nostr-wot/ui', async () => {
  const React = await import('react');
  return {
    LoginModal: (props: Record<string, unknown>) => {
      sdkProps = props;
      return React.createElement('div', { className: 'nui-modal-overlay' },
        React.createElement('div', { className: 'nui-modal', 'data-testid': 'sdk-login' },
          React.createElement('button', { 'aria-label': 'Close', onClick: props.onClose }),
          React.createElement('div', { className: 'nui-qr-wrap' },
            React.createElement('div', { className: 'nui-qr', 'data-testid': 'sdk-qr' }),
            React.createElement('div', { className: 'nui-key-display' }, 'nostrconnect://test'),
          ),
        ),
      );
    },
    Modal: ({ children, classes }: { children: React.ReactNode; classes?: { modal?: string } }) =>
      React.createElement('div', { className: classes?.modal }, children),
  };
});

describe('LoginModal generated identity flow', () => {
  beforeEach(() => {
    sdkProps = {};
    push.mockReset();
    updateDraft = undefined;
    publish.mockClear();
    loginWithNsec.mockReset().mockResolvedValue(undefined);
    loginWithBunker.mockReset().mockResolvedValue(undefined);
    bunkerFromUri.mockReset().mockResolvedValue({ close: vi.fn() });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('navigates home when the SDK close button is pressed', () => {
    render(<LoginModal />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(push).toHaveBeenCalledWith('/');
  });

  it('publishes the complete profile before the npub step and enters without another write', async () => {
    render(<LoginModal />);

    expect(sdkProps.profileSetup).toBe(true);
    expect(sdkProps.showRememberToggle).toBe(true);
    expect(sdkProps.nip46Relays).toEqual(['wss://public.obelisk.ar']);
    const permissions = (sdkProps.nip46Perms as string).split(',');
    expect(permissions).toContain('sign_event:22242');
    expect(permissions).not.toContain('nip:42');
    expect(permissions).toContain('nip:29');
    expect(permissions).toContain('sign_event:25052');
    expect(permissions).not.toContain('sign_event');
    expect(sdkProps.nip46Metadata).toEqual({
      name: 'Obelisk',
      url: 'https://obelisk.ar',
    });
    act(() => updateDraft?.({
      name: 'Cosmic Fox',
      picture: 'https://cdn.example/avatar.jpg',
      banner: 'https://cdn.example/banner.jpg',
    }));

    await act(async () => {
      await (sdkProps.onLogin as (args: unknown) => Promise<void>)({
        method: 'generate',
        pubkey: '1'.repeat(64),
        nsec: nip19.nsecEncode(new Uint8Array(32).fill(1)),
      });
    });

    const publishedEvent = publish.mock.calls[0][1] as { content: string };
    expect(JSON.parse(publishedEvent.content)).toMatchObject({
      name: 'Cosmic Fox',
      picture: 'https://cdn.example/avatar.jpg',
      banner: 'https://cdn.example/banner.jpg',
    });
    expect(screen.getByTestId('generated-npub-step')).toBeInTheDocument();
    expect(loginWithNsec).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy my npub' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^npub1/));

    fireEvent.click(screen.getByRole('button', { name: 'Enter Obelisk' }));
    await waitFor(() => expect(loginWithNsec).toHaveBeenCalledOnce());
  });

  it('uses the nostr-tools handshake and advertises the Obelisk relay', async () => {
    render(<LoginModal />);
    const handle = Nip46Signer.startNostrConnect({
      relays: ['wss://public.obelisk.ar'],
      clientSecretKey: new Uint8Array(32).fill(3),
      perms: sdkProps.nip46Perms as string,
      metadata: sdkProps.nip46Metadata as { name: string; url: string },
    });

    await handle.ready;

    const params = new URL(handle.uri).searchParams;
    expect(params.get('relay')).toBe('wss://public.obelisk.ar');
    expect(params.get('perms')).toBe(sdkProps.nip46Perms);
    expect(params.get('name')).toBe('Obelisk');
    expect(params.get('url')).toBe('https://obelisk.ar');
    expect(params.has('image')).toBe(false);
    expect(handle.uri.length).toBeLessThan(600);
    expect(bunkerFromUri).toHaveBeenCalledOnce();
  });

  it('hands the SDK-paired remote signer to the bridge', async () => {
    render(<LoginModal />);
    const signer = { getPublicKey: vi.fn(), signEvent: vi.fn() };

    await act(async () => {
      await (sdkProps.onLogin as (args: unknown) => Promise<void>)({
        method: 'nip46',
        pubkey: '1'.repeat(64),
        bunkerUri: 'bunker://remote?relay=wss://relay.nsec.app',
        clientNsec: nip19.nsecEncode(new Uint8Array(32).fill(2)),
        signer,
      });
    });

    expect(loginWithBunker).toHaveBeenCalledWith(
      'bunker://remote?relay=wss://relay.nsec.app',
      expect.objectContaining({ signer, clientSecretHex: '02'.repeat(32) }),
    );
  });

  it('places the mobile signer handoff directly below the QR', async () => {
    render(<LoginModal />);

    await waitFor(() => expect(screen.getByText('Open in signer app')).toBeInTheDocument());

    expect(screen.getByText('Open in signer app').closest('.nui-signer-actions')?.previousElementSibling)
      .toBe(screen.getByTestId('sdk-qr'));
  });

  it('copies the exact QR URI for Amber manual import', async () => {
    render(<LoginModal />);
    const copy = await screen.findByRole('button', { name: 'Copy connection URI' });

    fireEvent.click(copy);

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('nostrconnect://test'));
    expect(copy).toHaveTextContent('Copied');
  });

  it('falls back to a temporary textarea when the Clipboard API rejects', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    document.execCommand = vi.fn().mockReturnValue(true);

    await expect(copyConnectionUri('nostrconnect://complete')).resolves.toBe(true);

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('hands Android the complete QR URI through Amber', () => {
    const uri = 'nostrconnect://abc123?relay=wss%3A%2F%2Fpublic.obelisk.ar&name=Obelisk&perms=sign_event%3A1';

    expect(signerAppHref(uri, 'Mozilla/5.0 (Linux; Android 15)')).toBe(
      'intent://abc123?relay=wss%3A%2F%2Fpublic.obelisk.ar&name=Obelisk&perms=sign_event%3A1#Intent;scheme=nostrconnect;package=com.greenart7c3.nostrsigner;end',
    );
    expect(signerAppHref(uri, 'Mozilla/5.0 (iPhone)')).toBe(uri);
  });

  it('silently rotates the QR after a transient subscription close', async () => {
    expect(isTransientNip46Error('subscription closed before connection was established.')).toBe(true);
    expect(isTransientNip46Error('Remote signer rejected the request')).toBe(false);
    render(<LoginModal />);
    const oldQr = screen.getByTestId('sdk-login');

    act(() => {
      (sdkProps.onError as (message: string) => void)('subscription closed before connection was established.');
    });

    expect(sdkProps.styles).toEqual({ error: { display: 'none' } });
    await waitFor(() => expect(screen.getByTestId('sdk-login')).not.toBe(oldQr), { timeout: 1_000 });
    await waitFor(() => expect(screen.getByText('Open in signer app')).toBeInTheDocument());
  });

  it('shows an aligned back control on the final generated-profile screen', async () => {
    render(<LoginModal />);

    await act(async () => {
      await (sdkProps.onLogin as (args: unknown) => Promise<void>)({
        method: 'generate',
        pubkey: '1'.repeat(64),
        nsec: nip19.nsecEncode(new Uint8Array(32).fill(1)),
      });
    });

    expect(screen.getByTestId('generated-npub-step').parentElement)
      .toHaveClass('obelisk-login-modal', 'obelisk-share-modal');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('sdk-login')).toBeInTheDocument();
  });
});
