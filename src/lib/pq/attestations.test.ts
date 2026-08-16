import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const querySync = vi.fn();
vi.mock('@nostr-wot/data', async (importOriginal) => ({
  ...await importOriginal<typeof import('@nostr-wot/data')>(),
  getPool: () => ({ querySync }),
  getDefaultRelays: () => ['wss://r.example'],
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
      ['v', 'nip-pqc/v1'],
      ['alg', 'ml-kem-1024', kem],
    ],
    content: '',
  };
}

beforeEach(() => {
  clearAttestationCache();
  querySync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('retries a failed lookup after the short TTL but caches success for the full TTL', async () => {
    const PUBKEY2 = 'b'.repeat(64);

    // First call: failure (30s TTL)
    querySync.mockRejectedValueOnce(new Error('relay down'));
    const result1 = await getAttestation(PUBKEY2);
    expect(result1).toBeNull();
    expect(querySync).toHaveBeenCalledTimes(1);

    // Immediately call again: failure is cached, no new query
    const result2 = await getAttestation(PUBKEY2);
    expect(result2).toBeNull();
    expect(querySync).toHaveBeenCalledTimes(1);

    // Advance time past failure TTL (31s)
    vi.useFakeTimers();
    vi.advanceTimersByTime(31 * 1000);

    // Now it should retry
    querySync.mockResolvedValueOnce([attestationEvent(PUBKEY2)]);
    const result3 = await getAttestation(PUBKEY2);
    expect(result3?.pubkey).toBe(PUBKEY2);
    expect(querySync).toHaveBeenCalledTimes(2);

    // Advance time by ~1 minute past the success cache entry (far past failure TTL,
    // but comfortably before the 6h success TTL). This proves success is cached at 6h,
    // not 30s.
    vi.advanceTimersByTime(60 * 1000);
    const result4 = await getAttestation(PUBKEY2);
    expect(result4?.pubkey).toBe(PUBKEY2);
    expect(querySync).toHaveBeenCalledTimes(2); // Still 2: success entry not expired yet

    // Advance time past full success TTL (6h)
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1000);

    // Should not be cached anymore
    querySync.mockResolvedValueOnce([attestationEvent(PUBKEY2)]);
    await getAttestation(PUBKEY2);
    expect(querySync).toHaveBeenCalledTimes(3);
  });

  it('applies the short failure TTL when querySync resolves empty (relay outage, no throw)', async () => {
    // nostr-tools' querySync resolves with [] when every relay fails — it
    // does not reject. This must be treated as a negative result and cached
    // at the short TTL, not the 6h success TTL.
    querySync.mockResolvedValue([]);
    const result1 = await getAttestation(PUBKEY);
    expect(result1).toBeNull();
    expect(querySync).toHaveBeenCalledTimes(1);

    // Immediately call again: cached at the short TTL, no new query yet.
    const result2 = await getAttestation(PUBKEY);
    expect(result2).toBeNull();
    expect(querySync).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    vi.advanceTimersByTime(31 * 1000);

    // Past the short TTL: re-queries.
    await getAttestation(PUBKEY);
    expect(querySync).toHaveBeenCalledTimes(2);
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
    bad.tags = [['v', 'nip-pqc/v1']];
    querySync.mockResolvedValue([bad]);
    expect(await hasUsableKeys(PUBKEY)).toBe(false);
  });
});
