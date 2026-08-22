import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { memoizeDecrypt, clearDecryptCache, __INTERNAL } from './decrypt-cache';

describe('decrypt cache', () => {
  beforeEach(() => {
    clearDecryptCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses concurrent identical decrypts into one signer call', async () => {
    const run = vi.fn(async () => 'plaintext');
    // The three consumers of a gift wrap fire together — none has resolved
    // when the others start, which is why the *promise* is what's cached.
    const results = await Promise.all([
      memoizeDecrypt('nip44', 'peer', 'ct', run),
      memoizeDecrypt('nip44', 'peer', 'ct', run),
      memoizeDecrypt('nip44', 'peer', 'ct', run),
    ]);
    expect(results).toEqual(['plaintext', 'plaintext', 'plaintext']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('serves a settled result without re-invoking the signer', async () => {
    const run = vi.fn(async () => 'plaintext');
    await memoizeDecrypt('nip44', 'peer', 'ct', run);
    await expect(memoizeDecrypt('nip44', 'peer', 'ct', run)).resolves.toBe('plaintext');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keys on scheme, peer and ciphertext independently', async () => {
    const run = vi.fn(async () => 'x');
    await memoizeDecrypt('nip44', 'peer', 'ct', run);
    await memoizeDecrypt('nip04', 'peer', 'ct', run);
    await memoizeDecrypt('nip44', 'other', 'ct', run);
    await memoizeDecrypt('nip44', 'peer', 'other-ct', run);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does not cache rejections — a locked signer must not poison the key', async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('extension locked'))
      .mockResolvedValueOnce('plaintext');

    await expect(memoizeDecrypt('nip44', 'peer', 'ct', run)).rejects.toThrow('extension locked');
    // The retry must actually reach the signer, not replay the failure.
    await expect(memoizeDecrypt('nip44', 'peer', 'ct', run)).resolves.toBe('plaintext');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers of a failing decrypt all see the rejection', async () => {
    const run = vi.fn(async () => {
      throw new Error('nope');
    });
    const a = memoizeDecrypt('nip44', 'peer', 'ct', run);
    const b = memoizeDecrypt('nip44', 'peer', 'ct', run);
    await expect(a).rejects.toThrow('nope');
    await expect(b).rejects.toThrow('nope');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => 'plaintext');
    await memoizeDecrypt('nip44', 'peer', 'ct', run);
    vi.advanceTimersByTime(__INTERNAL.TTL_MS + 1);
    await memoizeDecrypt('nip44', 'peer', 'ct', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entries past the cap', async () => {
    const run = vi.fn(async () => 'x');
    for (let i = 0; i < __INTERNAL.MAX_ENTRIES + 10; i++) {
      await memoizeDecrypt('nip44', 'peer', `ct${i}`, run);
    }
    expect(__INTERNAL.size()).toBeLessThanOrEqual(__INTERNAL.MAX_ENTRIES);
    // The oldest key is gone, so it costs a fresh call.
    const before = run.mock.calls.length;
    await memoizeDecrypt('nip44', 'peer', 'ct0', run);
    expect(run.mock.calls.length).toBe(before + 1);
  });

  it('clearDecryptCache drops plaintext held for the outgoing identity', async () => {
    const run = vi.fn(async () => 'plaintext');
    await memoizeDecrypt('nip44', 'peer', 'ct', run);
    clearDecryptCache();
    expect(__INTERNAL.size()).toBe(0);
    await memoizeDecrypt('nip44', 'peer', 'ct', run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
