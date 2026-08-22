/**
 * Post-quantum DM sending, end to end through the bridge.
 *
 * Complements `dm-nip17.test.ts` (which covers classic NIP-17) with the
 * `docs/superpowers/specs/2026-08-15-post-quantum-dms-design.md` send path:
 * when the preference is on, the session can encrypt post-quantum, and the
 * peer publishes a usable `kind:10203`, the seal carries `@nostr-wot/pq`'s
 * hybrid envelope instead of plain NIP-44 ciphertext — and in every other
 * case the message still goes out, classic.
 *
 * Real crypto throughout: real ML-KEM keys, a real attestation on the fake
 * relay, and a `PrivateKeySigner` on the receiving side that opens the wrap
 * independently. `window.nostr` is backed by a `PrivateKeySigner` with
 * `pqKem`, which is exactly the shape a post-quantum-capable extension
 * exposes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, type Event as NostrEvent } from 'nostr-tools';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { derivePqKeys, buildAttestationTags, isPqEnvelope, PQC_KIND, type PqKeys } from '@nostr-wot/pq';

const fake = vi.hoisted(() => {
  const state = {
    published: [] as Array<NostrEvent & { relays?: string[] }>,
    subscriptions: [] as Array<{ filter: Record<string, unknown>; sink: (ev: NostrEvent) => void }>,
  };

  function matches(f: Record<string, unknown>, ev: { kind: number; pubkey: string; tags: string[][] }): boolean {
    if (Array.isArray(f.kinds) && !(f.kinds as number[]).includes(ev.kind)) return false;
    if (Array.isArray(f.authors) && !(f.authors as string[]).includes(ev.pubkey)) return false;
    for (const k of Object.keys(f)) {
      if (!k.startsWith('#')) continue;
      const tag = k.slice(1);
      const wanted = f[k] as string[];
      if (!ev.tags.some((t) => t[0] === tag && wanted.includes(t[1]))) return false;
    }
    return true;
  }

  class FakePool {
    subscribe(
      relays: string[],
      filter: Record<string, unknown>,
      opts: { onevent: (ev: NostrEvent) => void; oneose?: () => void },
    ) {
      const sub = { filter, sink: opts.onevent };
      state.subscriptions.push(sub);
      for (const ev of state.published) if (matches(filter, ev)) opts.onevent(ev);
      queueMicrotask(() => opts.oneose?.());
      return { close: () => { state.subscriptions = state.subscriptions.filter((s) => s !== sub); } };
    }
    publish(relays: string[], event: NostrEvent): Promise<string>[] {
      state.published.push({ ...event, relays });
      queueMicrotask(() => {
        for (const sub of state.subscriptions) if (matches(sub.filter, event)) sub.sink(event);
      });
      return [Promise.resolve('ok')];
    }
    close(): void {
      state.subscriptions = [];
    }
    async ensureRelay(): Promise<{ connected: boolean }> {
      return { connected: true };
    }
    async querySync(_relays: string[], filter: Record<string, unknown>): Promise<NostrEvent[]> {
      return state.published.filter((ev) => matches(filter, ev));
    }
  }

  return { state, FakePool };
});

vi.mock('nostr-tools', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, SimplePool: fake.FakePool };
});

// `src/lib/pq/attestations.ts` deliberately goes through `@nostr-wot/data`'s
// shared pool rather than the bridge's private SimplePool, so point that pool
// at the same fake relay the bridge publishes to.
vi.mock('@nostr-wot/data', async (orig) => {
  const actual = (await orig()) as object;
  const pool = new fake.FakePool();
  return { ...actual, getPool: () => pool, getDefaultRelays: () => ['wss://public.obelisk.ar'] };
});

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function makeKeypair() {
  const sk = generateSecretKey();
  return { sk, skHex: bytesToHex(sk), pkHex: getPublicKey(sk) };
}

/** ML-KEM/ML-DSA pair from a 64-byte BIP-39-shaped seed. */
function makePqKeys(fill: number): PqKeys {
  return derivePqKeys(new Uint8Array(64).fill(fill));
}

function publishAttestation(pubkeyHex: string, sk: Uint8Array, keys: PqKeys) {
  fake.state.published.push(
    finalizeEvent(
      {
        kind: PQC_KIND,
        created_at: 1,
        content: '',
        tags: buildAttestationTags({
          pubkey: pubkeyHex,
          kem: keys.kem.publicKey,
          dsa: keys.dsa.publicKey,
          origin: 'derived',
          dsaSecretKey: keys.dsa.secretKey,
        }),
      },
      sk,
    ),
  );
}

/**
 * A NIP-07 extension backed by real crypto. `schemes` is the marker
 * `selfPqState` requires before it will report `canSend`; omit it to simulate
 * today's extensions, which publish no marker at all.
 */
async function installExtension(opts: {
  sk: Uint8Array;
  pkHex: string;
  pqKem?: PqKeys['kem'];
  schemes?: string[];
  /** Force the post-quantum branch to fail, to exercise the classic fallback. */
  failPq?: boolean;
}) {
  const { PrivateKeySigner } = await import('@nostr-wot/signers');
  const signer = new PrivateKeySigner(opts.sk, opts.pqKem ? { pqKem: opts.pqKem } : undefined);
  const nip44Surface: Record<string, unknown> = {
    encrypt: vi.fn(async (pk: string, text: string, o?: { scheme: 'pq'; recipientKemKey: string }) => {
      if (o && opts.failPq) throw new Error('user rejected the post-quantum prompt');
      return signer.nip44Encrypt(pk, text, o);
    }),
    decrypt: vi.fn(async (pk: string, ct: string) => signer.nip44Decrypt(pk, ct)),
  };
  if (opts.schemes) nip44Surface.schemes = opts.schemes;
  Object.defineProperty(window, 'nostr', {
    configurable: true,
    value: {
      getPublicKey: vi.fn().mockResolvedValue(opts.pkHex),
      signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, opts.sk)),
      nip04: {
        encrypt: vi.fn(async (pk: string, text: string) => signer.nip04Encrypt(pk, text)),
        decrypt: vi.fn(async (pk: string, ct: string) => signer.nip04Decrypt(pk, ct)),
      },
      nip44: nip44Surface,
    },
  });
}

async function flush(times = 30) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * The post-quantum send path does two relay round trips (our attestation and
 * the peer's) plus real ML-KEM encapsulation before it publishes, so
 * microtask flushing is not enough — wait for the wrap to actually land.
 */
async function waitForWrap(): Promise<NostrEvent> {
  return vi.waitFor(
    () => {
      const wrap = fake.state.published.find((e) => e.kind === 1059);
      if (!wrap) throw new Error('no gift wrap published yet');
      return wrap;
    },
    { timeout: 5000, interval: 5 },
  );
}

/** Wait until `n` gift wraps have landed (the send publishes two: see below). */
async function waitForWraps(n: number): Promise<NostrEvent[]> {
  return vi.waitFor(
    () => {
      const wraps = fake.state.published.filter((e) => e.kind === 1059);
      if (wraps.length < n) throw new Error(`only ${wraps.length} of ${n} gift wraps published`);
      return wraps;
    },
    { timeout: 5000, interval: 5 },
  );
}

/**
 * Wait until a peer's thread holds at least `n` messages.
 *
 * Inbound wraps are opened through the bridge's signer queue, which
 * serializes decrypt round-trips so background work can't delay a signature
 * (see `signer-queue.ts`). That makes the number of microtasks between "the
 * wrap is on the relay" and "the message is in the store" a function of how
 * much other signer work is in flight — polling the condition is stable
 * where a fixed tick count is not.
 */
async function waitForThread<T>(
  read: () => ReadonlyArray<T> | undefined,
  n: number,
): Promise<ReadonlyArray<T>> {
  return vi.waitFor(
    () => {
      const thread = read() ?? [];
      if (thread.length < n) throw new Error(`only ${thread.length} of ${n} messages ingested`);
      return thread;
    },
    { timeout: 5000, interval: 5 },
  );
}

const addressedTo = (pubkey: string) => (ev: NostrEvent) =>
  ev.tags.some((t) => t[0] === 'p' && t[1] === pubkey);

/** Peel the gift wrap with the recipient's classic key to inspect the seal. */
function openWrap(wrap: NostrEvent, recipientSk: Uint8Array): NostrEvent {
  const key = nip44.utils.getConversationKey(recipientSk, wrap.pubkey);
  return JSON.parse(nip44.decrypt(wrap.content, key)) as NostrEvent;
}

beforeEach(async () => {
  fake.state.published = [];
  fake.state.subscriptions = [];
  vi.resetModules();
  delete (window as unknown as { nostr?: unknown }).nostr;
  window.localStorage.clear();
  const { clearAttestationCache } = await import('@/lib/pq/attestations');
  clearAttestationCache();
});

afterEach(async () => {
  const { getBridgeImpl } = await import('./client');
  getBridgeImpl()?.dispose();
  const { setPreference } = await import('@/lib/preferences');
  setPreference('postQuantumEnabled', false);
  setPreference('directMessagesEnabled', false);
  delete (window as unknown as { nostr?: unknown }).nostr;
  fake.state.published = [];
  fake.state.subscriptions = [];
});

describe('post-quantum DM sending', () => {
  it('seals with a post-quantum envelope when the conversation qualifies', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { unwrapGiftWrap } = await import('@nostr-wot/dm');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(1);
    const bobPq = makePqKeys(2);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, bobPq);
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);
    await bridge.sendDirectMessage(bob.pkHex, 'quantum safe hello');
    const wrap = await waitForWrap();

    // The seal's content is the hybrid envelope; nothing outside the seal
    // changed, so the wrap is still an ordinary kind-1059.
    const seal = openWrap(wrap, bob.sk);
    expect(seal.kind).toBe(13);
    expect(isPqEnvelope(seal.content)).toBe(true);

    // Bob opens it with his own ML-KEM secret key — no flag needed, the
    // envelope is self-describing.
    const bobSigner = new PrivateKeySigner(bob.sk, { pqKem: bobPq.kem });
    const { message, senderPubkey } = await unwrapGiftWrap(bobSigner, wrap);
    expect(senderPubkey).toBe(alice.pkHex);
    expect(message.content).toBe('quantum safe hello');
  });

  it('records pq: true on the sender\'s own copy of a post-quantum message', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(3);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, makePqKeys(4));
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);

    let last: Record<string, ReadonlyArray<{ pq?: boolean; protocol?: string; pending?: boolean }>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });

    await bridge.sendDirectMessage(bob.pkHex, 'mine too');
    await waitForWrap();
    await flush();

    const settled = (last[bob.pkHex] ?? []).filter((m) => !m.pending);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ protocol: 'nip17', pq: true });
  });

  it('sends classic NIP-17 when the peer publishes no attestation, and never blocks', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(5);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    // Bob publishes nothing.
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);

    let last: Record<string, ReadonlyArray<{ pq?: boolean; pending?: boolean; failed?: boolean }>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });

    await bridge.sendDirectMessage(bob.pkHex, 'still goes out');
    const wrap = await waitForWrap();
    await flush();

    expect(isPqEnvelope(openWrap(wrap, bob.sk).content)).toBe(false);
    const settled = (last[bob.pkHex] ?? []).filter((m) => !m.pending);
    expect(settled).toHaveLength(1);
    expect(settled[0].pq).toBe(false);
    expect(settled[0].failed).toBeFalsy();
  });

  it('sends classic when the preference is off, even with keys on both sides', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(6);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, makePqKeys(7));
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', false);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);
    await bridge.sendDirectMessage(bob.pkHex, 'opted out');
    const wrap = await waitForWrap();

    expect(isPqEnvelope(openWrap(wrap, bob.sk).content)).toBe(false);
  });

  it('sends classic when the extension publishes no capability marker', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(8);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, makePqKeys(9));
    // Capable of post-quantum, but advertises nothing — `capabilityUnknown`.
    // Guessing "supported" here is what would produce a silent downgrade
    // mislabelled as protected.
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);
    await bridge.sendDirectMessage(bob.pkHex, 'unknown capability');
    const wrap = await waitForWrap();

    expect(isPqEnvelope(openWrap(wrap, bob.sk).content)).toBe(false);
  });

  it('falls back to classic, still publishing, when the signer refuses post-quantum', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(10);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, makePqKeys(11));
    // Advertises pq but throws when actually asked — a stale marker, a
    // locked extension, or a rejected prompt. The send must not fail.
    await installExtension({
      sk: alice.sk,
      pkHex: alice.pkHex,
      pqKem: alicePq.kem,
      schemes: ['nip44', 'pq'],
      failPq: true,
    });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);

    let last: Record<string, ReadonlyArray<{ pq?: boolean; pending?: boolean; failed?: boolean }>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });

    await bridge.sendDirectMessage(bob.pkHex, 'downgraded but delivered');
    const wrap = await waitForWrap();
    await flush();

    expect(isPqEnvelope(openWrap(wrap, bob.sk).content)).toBe(false);
    const settled = (last[bob.pkHex] ?? []).filter((m) => !m.pending);
    expect(settled).toHaveLength(1);
    // Recorded honestly as classic, not as the protection we asked for.
    expect(settled[0].pq).toBe(false);
    expect(settled[0].failed).toBeFalsy();
  });
});

/**
 * NIP-17 publishes a second gift wrap addressed to the sender. Its seal is
 * encrypted *to us*, so its post-quantum envelope has to be encapsulated to
 * our own ML-KEM key: built with the recipient's, it would need the peer's
 * secret to open and we would have published a copy of our own message that
 * we can never read again.
 */
describe('post-quantum DM self-copy', () => {
  it('encapsulates the self-copy to our own KEM key, so we can still read it', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { unwrapGiftWrap } = await import('@nostr-wot/dm');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(16);
    const bobPq = makePqKeys(17);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, bobPq);
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);
    bridge.subscribeDirectMessages(() => {});
    await bridge.sendDirectMessage(bob.pkHex, 'both copies protected');
    const wraps = await waitForWraps(2);

    const toSelf = wraps.find(addressedTo(alice.pkHex))!;
    const toBob = wraps.find(addressedTo(bob.pkHex))!;
    expect(toSelf).toBeDefined();
    expect(toBob).toBeDefined();
    // Both seals are hybrid envelopes.
    expect(isPqEnvelope(openWrap(toSelf, alice.sk).content)).toBe(true);
    expect(isPqEnvelope(openWrap(toBob, bob.sk).content)).toBe(true);

    // The load-bearing assertion: alice's own ML-KEM secret opens her copy.
    // Had it been encapsulated to bob's key this would throw.
    const aliceSigner = new PrivateKeySigner(alice.sk, { pqKem: alicePq.kem });
    const { message, senderPubkey } = await unwrapGiftWrap(aliceSigner, toSelf);
    expect(senderPubkey).toBe(alice.pkHex);
    expect(message.content).toBe('both copies protected');
    expect(message.tags).toContainEqual(['p', bob.pkHex]);

    // Bob's ML-KEM secret must NOT open it — the two copies are separately
    // encapsulated, they are not one envelope with two labels.
    const bobSigner = new PrivateKeySigner(bob.sk, { pqKem: bobPq.kem });
    await expect(unwrapGiftWrap(bobSigner, toSelf)).rejects.toThrow();
  });

  it('keeps the self-copy classic when the delivered copy was classic', async () => {
    // Sealing our own copy post-quantum while the message actually travelled
    // classic would make it read as protected after a reload, when it never
    // was. Understating is the only safe direction here.
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(18);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    // Bob publishes no attestation, so the delivered copy is classic.
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);
    bridge.subscribeDirectMessages(() => {});
    await bridge.sendDirectMessage(bob.pkHex, 'classic both ways');
    const wraps = await waitForWraps(2);

    const toSelf = wraps.find(addressedTo(alice.pkHex))!;
    expect(isPqEnvelope(openWrap(toSelf, alice.sk).content)).toBe(false);
  });

  it('still reports pq: true after the self-copy is ingested', async () => {
    // The mark a user sees must be the same before and after a reload.
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(19);
    publishAttestation(alice.pkHex, alice.sk, alicePq);
    publishAttestation(bob.pkHex, bob.sk, makePqKeys(20));
    await installExtension({ sk: alice.sk, pkHex: alice.pkHex, pqKem: alicePq.kem, schemes: ['nip44', 'pq'] });

    setPreference('directMessagesEnabled', true);
    setPreference('postQuantumEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);

    let last: Record<string, ReadonlyArray<{ content: string; pq?: boolean; outgoing: boolean; pending?: boolean }>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });

    await bridge.sendDirectMessage(bob.pkHex, 'still protected on reload');
    await waitForWraps(2);
    await flush(60);

    const thread = last[bob.pkHex] ?? [];
    // One message, not two: the ingested self-copy collapses onto the local
    // copy via the shared rumor id.
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ outgoing: true, pq: true });
  });
});

describe('post-quantum DM receiving', () => {
  it('stamps pq: true on an inbound post-quantum gift wrap', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { buildChatMessage, sealAndGiftWrap } = await import('@nostr-wot/dm');
    const { toBase64 } = await import('@nostr-wot/pq');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(12);
    const bobPq = makePqKeys(13);

    // Alice, a wholly separate post-quantum client, seals to bob.
    const aliceSigner = new PrivateKeySigner(alice.sk, { pqKem: alicePq.kem });
    const inner = buildChatMessage(alice.pkHex, bob.pkHex, 'from a pq client');
    const wrap = await sealAndGiftWrap(aliceSigner, bob.pkHex, inner, {
      pq: { scheme: 'pq', recipientKemKey: toBase64(bobPq.kem.publicKey) },
    });
    fake.state.published.push(wrap);

    await installExtension({ sk: bob.sk, pkHex: bob.pkHex, pqKem: bobPq.kem, schemes: ['nip44', 'pq'] });
    setPreference('directMessagesEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(bob.pkHex);

    let last: Record<string, ReadonlyArray<{ content: string; protocol?: string; pq?: boolean }>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });

    const thread = await waitForThread(() => last[alice.pkHex], 1);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ content: 'from a pq client', protocol: 'nip17', pq: true });
  });

  it('stamps pq: false on an inbound classic gift wrap in the same thread', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { buildChatMessage, sealAndGiftWrap } = await import('@nostr-wot/dm');
    const { toBase64 } = await import('@nostr-wot/pq');

    const alice = makeKeypair();
    const bob = makeKeypair();
    const alicePq = makePqKeys(14);
    const bobPq = makePqKeys(15);
    const aliceSigner = new PrivateKeySigner(alice.sk, { pqKem: alicePq.kem });

    // A mixed conversation: one post-quantum message, one classic.
    fake.state.published.push(
      await sealAndGiftWrap(aliceSigner, bob.pkHex, buildChatMessage(alice.pkHex, bob.pkHex, 'protected'), {
        pq: { scheme: 'pq', recipientKemKey: toBase64(bobPq.kem.publicKey) },
      }),
    );
    fake.state.published.push(
      await sealAndGiftWrap(aliceSigner, bob.pkHex, buildChatMessage(alice.pkHex, bob.pkHex, 'classic')),
    );

    await installExtension({ sk: bob.sk, pkHex: bob.pkHex, pqKem: bobPq.kem, schemes: ['nip44', 'pq'] });
    setPreference('directMessagesEnabled', true);
    const bridge = await getBridge();
    await bridge.loginWithNip07(bob.pkHex);

    let last: Record<string, ReadonlyArray<{ content: string; pq?: boolean }>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });

    const thread = await waitForThread(() => last[alice.pkHex], 2);
    expect(thread).toHaveLength(2);
    expect(thread.find((m) => m.content === 'protected')?.pq).toBe(true);
    expect(thread.find((m) => m.content === 'classic')?.pq).toBe(false);
  });
});
