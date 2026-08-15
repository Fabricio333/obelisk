import { describe, it, expect, vi, beforeEach } from 'vitest';

const { querySync, mockParseAttestation } = vi.hoisted(() => {
  return {
    querySync: vi.fn(),
    mockParseAttestation: vi.fn(),
  };
});

vi.mock('@nostr-wot/data', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nostr-wot/data')>(),
  getPool: () => ({ querySync }),
  getDefaultRelays: () => ['wss://r.example'],
}));

vi.mock('@nostr-wot/pq', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nostr-wot/pq')>(),
  parseAttestation: mockParseAttestation,
}));

import { getAttestation, hasUsableKeys, clearAttestationCache } from './attestations';

const PUBKEY = 'a'.repeat(64);

// A well-formed kind:10203 carrying a 1568-byte ML-KEM key, base64-encoded.
function attestationEvent(pubkey = PUBKEY) {
  const kem = Buffer.from(new Uint8Array(1568).fill(7)).toString('base64');
  return {
    id: 'e'.repeat(64),
    pubkey,
    kind: 10203,
    created_at: 1_700_000_000,
    tags: [
      ['profile', 'nip-pqc/v1'],
      ['kem', 'ml-kem-1024', kem],
    ],
    content: '',
  };
}

beforeEach(() => {
  clearAttestationCache();
  querySync.mockReset();
  mockParseAttestation.mockReset();
  // By default, parseAttestation returns a usable attestation
  mockParseAttestation.mockImplementation((event: any) => ({
    pubkey: event.pubkey,
    kem: new Uint8Array(1568).fill(7),
    dsa: new Uint8Array(2592).fill(8),
    origin: 'derived',
    seedStrength: '256',
    profile: 'nip-pqc/v1',
    popValid: true,
    problems: [],
    usable: true,
  }));
});

describe('getAttestation', () => {
  it('returns a parsed attestation when the relay has one', async () => {
    querySync.mockResolvedValue([attestationEvent()]);
    const att = await getAttestation(PUBKEY);
    expect(att?.pubkey).toBe(PUBKEY);
    expect(att?.usable).toBe(true);
  });

  it('returns null when the relay has none', async () => {
    querySync.mockResolvedValue([]);
    expect(await getAttestation(PUBKEY)).toBeNull();
  });

  it('serves the second call from cache without re-querying', async () => {
    querySync.mockResolvedValue([attestationEvent()]);
    await getAttestation(PUBKEY);
    await getAttestation(PUBKEY);
    expect(querySync).toHaveBeenCalledTimes(1);
  });

  it('returns null and does not throw when the relay query fails', async () => {
    querySync.mockRejectedValue(new Error('relay down'));
    expect(await getAttestation(PUBKEY)).toBeNull();
  });
});

describe('hasUsableKeys', () => {
  it('is true for a usable attestation', async () => {
    querySync.mockResolvedValue([attestationEvent()]);
    expect(await hasUsableKeys(PUBKEY)).toBe(true);
  });

  it('is false when there is no attestation', async () => {
    querySync.mockResolvedValue([]);
    expect(await hasUsableKeys(PUBKEY)).toBe(false);
  });

  it('is false when the attestation carries no usable KEM key', async () => {
    const bad = attestationEvent();
    bad.tags = [['profile', 'nip-pqc/v1']];
    querySync.mockResolvedValue([bad]);
    // Mock parseAttestation to return an unusable attestation for this case
    mockParseAttestation.mockImplementationOnce((event: any) => ({
      pubkey: event.pubkey,
      kem: null,
      dsa: null,
      origin: null,
      seedStrength: null,
      profile: 'nip-pqc/v1',
      popValid: null,
      problems: [{ code: 'noKem' }],
      usable: false,
    }));
    expect(await hasUsableKeys(PUBKEY)).toBe(false);
  });
});
