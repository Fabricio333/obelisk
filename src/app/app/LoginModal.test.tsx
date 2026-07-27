import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import LoginModal from './LoginModal';

const loginWithNsec = vi.fn();
const loginWithBunker = vi.fn();
const publish = vi.fn((_relays: string[], _event: unknown) => [Promise.resolve('ok')]);
let updateDraft: ((patch: Record<string, string>) => void) | undefined;
let sdkProps: Record<string, unknown> = {};

vi.mock('@/lib/nostr-bridge', () => ({
  nostrActions: {
    loginWithNsec: (...args: unknown[]) => loginWithNsec(...args),
    loginWithNip07: vi.fn(),
    loginWithBunker: (...args: unknown[]) => loginWithBunker(...args),
  },
}));

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
      return React.createElement('div', { 'data-testid': 'sdk-login' });
    },
    Modal: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
  };
});

describe('LoginModal generated identity flow', () => {
  beforeEach(() => {
    sdkProps = {};
    updateDraft = undefined;
    publish.mockClear();
    loginWithNsec.mockReset().mockResolvedValue(undefined);
    loginWithBunker.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('publishes the complete profile before the npub step and enters without another write', async () => {
    render(<LoginModal />);

    expect(sdkProps.profileSetup).toBe(true);
    expect(sdkProps.showRememberToggle).toBe(true);
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
});
