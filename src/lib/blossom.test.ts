import { getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadToBlossom } from './blossom';

const { signEventTemplate } = vi.hoisted(() => ({ signEventTemplate: vi.fn() }));
vi.mock('@/lib/nostr-bridge', () => ({ nostrActions: { signEventTemplate } }));

describe('uploadToBlossom', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs pre-login uploads with the generated secret key', async () => {
    const secretKey = new Uint8Array(32).fill(1);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ url: 'https://cdn.example/avatar.jpg' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const file = {
      type: 'image/png',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as File;

    await expect(uploadToBlossom(file, secretKey)).resolves.toBe('https://cdn.example/avatar.jpg');
    const authorization = fetchMock.mock.calls[0][1].headers.Authorization as string;
    const event = JSON.parse(atob(authorization.slice('Nostr '.length)));
    expect(event.kind).toBe(24242);
    expect(event.pubkey).toBe(getPublicKey(secretKey));
    expect(signEventTemplate).not.toHaveBeenCalled();
  });
});
