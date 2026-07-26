import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: vi.fn(),
  getBridgeImpl: vi.fn(),
  isImportableRelayUrl: vi.fn((url: string) => url.startsWith('wss://')),
}));

import { fetchSfuInfo } from './sfu-pin';

const PUBKEY = 'a'.repeat(64);

afterEach(() => vi.unstubAllGlobals());

describe('fetchSfuInfo', () => {
  it('validates an SFU URL and derives its identity and relay fallback', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      service: 'obelisk-sfu',
      pubkey: PUBKEY.toUpperCase(),
      url: 'https://sfu.obelisk.ar',
      relays: ['wss://public.obelisk.ar', 'ws://localhost:4869'],
      trustedAuthorRelays: ['wss://lacrypta-relay.obelisk.ar'],
      cap: 50,
      operator: 'b'.repeat(64),
      region: 'eu-central',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchSfuInfo('https://sfu.obelisk.ar/admin')).resolves.toEqual({
      pubkey: PUBKEY,
      url: 'https://sfu.obelisk.ar',
      relays: ['wss://public.obelisk.ar'],
      trustedRelays: ['wss://lacrypta-relay.obelisk.ar'],
      cap: 50,
      operator: 'b'.repeat(64),
      region: 'eu-central',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://sfu.obelisk.ar/info'),
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it('rejects descriptors whose advertised origin does not match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      service: 'obelisk-sfu',
      pubkey: PUBKEY,
      url: 'https://evil.example',
    }), { status: 200 })));

    await expect(fetchSfuInfo('https://sfu.obelisk.ar')).rejects.toThrow(
      'SFU /info URL does not match',
    );
  });
});
