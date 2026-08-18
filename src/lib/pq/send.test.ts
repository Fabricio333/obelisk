import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PqAttestation } from '@nostr-wot/pq';

const getAttestation = vi.fn();
vi.mock('./attestations', () => ({
  getAttestation: (pk: string) => getAttestation(pk),
  // `selfPqState` (not mocked here — we drive it through `window.nostr`)
  // calls this one.
  hasUsableKeys: async (pk: string) => (await getAttestation(pk))?.usable === true,
}));

import { setPreference } from '@/lib/preferences';
import { resolvePqSend } from './send';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

/** 32 bytes is not a real ML-KEM-1024 key, but nothing here parses it. */
const KEM = new Uint8Array(32).fill(7);
const KEM_B64 = Buffer.from(KEM).toString('base64');

function attestation(over: Partial<PqAttestation> = {}): PqAttestation {
  return {
    pubkey: PEER,
    kem: KEM,
    dsa: null,
    origin: 'derived',
    seedStrength: '256',
    profile: null,
    popValid: null,
    problems: [],
    usable: true,
    ...over,
  };
}

/** The only state in which `selfPqState().canSend` is true. */
function withSupportingExtension() {
  // @ts-expect-error partial extension shape is enough here
  globalThis.window.nostr = { nip44: { schemes: ['nip44', 'pq'] } };
}

beforeEach(() => {
  getAttestation.mockReset();
  getAttestation.mockImplementation(async () => attestation());
  setPreference('postQuantumEnabled', true);
});

afterEach(() => {
  delete globalThis.window.nostr;
  setPreference('postQuantumEnabled', false);
});

describe('resolvePqSend', () => {
  it('returns the peer KEM key, base64, when every condition holds', async () => {
    withSupportingExtension();

    const plan = await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER });

    expect(plan).toEqual({ recipientKemKey: KEM_B64, selfKemKey: KEM_B64 });
  });

  it('carries our own KEM key too, for the sender-addressed second wrap', async () => {
    // The self-copy's seal is encrypted *to us*, so its envelope has to be
    // encapsulated to our key. Sealing it with the peer's would publish a
    // copy of our own message that only the peer could ever open.
    withSupportingExtension();
    const myKem = new Uint8Array(32).fill(9);
    getAttestation.mockImplementation(async (pk: string) =>
      pk === ME ? attestation({ pubkey: ME, kem: myKem }) : attestation(),
    );

    const plan = await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER });

    expect(plan?.recipientKemKey).toBe(KEM_B64);
    expect(plan?.selfKemKey).toBe(Buffer.from(myKem).toString('base64'));
  });

  it('leaves selfKemKey null when our own attestation carries no KEM key', async () => {
    // The self-copy then falls back to a classic seal — readable, just not
    // post-quantum — rather than being unpublishable or unreadable.
    withSupportingExtension();
    let calls = 0;
    getAttestation.mockImplementation(async (pk: string) => {
      // `selfPqState` reads our attestation first (usable), then the send
      // path reads it again; simulate it going stale in between.
      if (pk !== ME) return attestation();
      calls += 1;
      return calls === 1 ? attestation({ pubkey: ME }) : null;
    });

    const plan = await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER });

    expect(plan).toEqual({ recipientKemKey: KEM_B64, selfKemKey: null });
  });

  it('sends classic when the postQuantumEnabled preference is off', async () => {
    withSupportingExtension();
    setPreference('postQuantumEnabled', false);

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic when the peer publishes no attestation', async () => {
    withSupportingExtension();
    getAttestation.mockImplementation(async (pk: string) => (pk === ME ? attestation() : null));

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic when the peer attestation is unusable', async () => {
    withSupportingExtension();
    getAttestation.mockImplementation(async (pk: string) =>
      pk === ME ? attestation() : attestation({ usable: false }),
    );

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic when the peer attestation carries no KEM key', async () => {
    withSupportingExtension();
    getAttestation.mockImplementation(async (pk: string) =>
      pk === ME ? attestation() : attestation({ kem: null }),
    );

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic under capabilityUnknown rather than risking a silent downgrade', async () => {
    // No `nip44.schemes` marker: post-quantum support is unobservable. An
    // unaware extension would ignore the third argument and hand back classic
    // ciphertext that we would then record as pq — a false security claim.
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic when the extension positively declares no pq support', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['nip44'] } };

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic on an nsec login, which has no post-quantum path', async () => {
    withSupportingExtension();

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'nsec', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic on a bunker login, whose NIP-46 request has no KEM field', async () => {
    withSupportingExtension();

    expect(await resolvePqSend({ myPubkey: ME, loginMethod: 'bunker', recipientPubkey: PEER })).toBeNull();
  });

  it('sends classic when not logged in', async () => {
    withSupportingExtension();

    expect(await resolvePqSend({ myPubkey: null, loginMethod: null, recipientPubkey: PEER })).toBeNull();
  });

  it('never throws: a rejected lookup degrades to a classic send', async () => {
    withSupportingExtension();
    getAttestation.mockImplementation(async (pk: string) => {
      if (pk === ME) return attestation();
      throw new Error('relay exploded');
    });

    await expect(
      resolvePqSend({ myPubkey: ME, loginMethod: 'nip07', recipientPubkey: PEER }),
    ).resolves.toBeNull();
  });
});
