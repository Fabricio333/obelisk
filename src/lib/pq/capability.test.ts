import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hasUsableKeys = vi.fn();
vi.mock('./attestations', () => ({ hasUsableKeys: (pk: string) => hasUsableKeys(pk) }));

import { signerSupportsPq, selfPqState } from './capability';

const PUBKEY = 'b'.repeat(64);

beforeEach(() => {
  hasUsableKeys.mockReset();
});

afterEach(() => {
  // @ts-expect-error test cleanup
  delete globalThis.window.nostr;
});

describe('signerSupportsPq', () => {
  it('is true when the extension advertises the pq scheme', () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['nip44', 'pq'] } };
    expect(signerSupportsPq()).toBe(true);
  });

  it('is false when the extension advertises schemes without pq', () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['nip44'] } };
    expect(signerSupportsPq()).toBe(false);
  });

  it('is false when there is no extension at all', () => {
    expect(signerSupportsPq()).toBe(false);
  });

  it('is false when the extension publishes no schemes marker', () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };
    expect(signerSupportsPq()).toBe(false);
  });
});

describe('selfPqState', () => {
  it('reports no keys when logged out', async () => {
    expect(await selfPqState(null, null)).toEqual({
      canSend: false, hasKeys: false, attestationPublished: false,
    });
  });

  it('can send on nip07 when the marker is present and keys are published', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['pq'] } };
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'nip07')).toEqual({
      canSend: true, hasKeys: true, attestationPublished: true,
    });
  });

  it('falls back to the attestation when the extension publishes no marker', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'nip07')).toEqual({
      canSend: true, hasKeys: true, attestationPublished: true,
    });
  });

  it('cannot send on nsec even with published keys', async () => {
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'nsec')).toEqual({
      canSend: false, hasKeys: true, attestationPublished: true,
    });
  });

  it('cannot send on bunker even with published keys', async () => {
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'bunker')).toEqual({
      canSend: false, hasKeys: true, attestationPublished: true,
    });
  });

  it('cannot send on nip07 when nothing is published', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };
    hasUsableKeys.mockResolvedValue(false);
    expect(await selfPqState(PUBKEY, 'nip07')).toEqual({
      canSend: false, hasKeys: false, attestationPublished: false,
    });
  });
});
