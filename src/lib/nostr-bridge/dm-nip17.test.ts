/**
 * NIP-17 DM adoption tests — covers the parts of the
 * `docs/superpowers/specs/2026-08-16-nip17-dms-design.md` migration that
 * `bridge.test.ts` / `optimistic-send.test.ts` don't already exercise:
 *
 *   - NIP-17 is the default send protocol and routes to the recipient's
 *     published kind-10050 inbox relays, not just the relay(s) we're on.
 *   - A received kind-1059 gift wrap ingests into the same `dmsByPeer`
 *     store as NIP-04, stamped `protocol: 'nip17'`.
 *   - The `NostrSigner` adapter (`getDmSigner`, private to the bridge)
 *     dispatches correctly for all three login methods — exercised
 *     indirectly by sending a NIP-17 DM under each and confirming the
 *     wire event is well-formed and independently decryptable.
 *
 * Mirrors `bridge.test.ts`'s FakePool (must implement subscribe, publish,
 * close, ensureRelay — see AGENTS.md's testing conventions) plus a local
 * `nostr-tools/nip46` mock whose BunkerSigner performs *real* crypto against
 * a fixed in-memory keypair, so the bunker path is exercised end-to-end
 * rather than stubbed into meaninglessness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, nip04, type Event as NostrEvent } from 'nostr-tools';
import { v2 as nip44 } from 'nostr-tools/nip44';

const fake = vi.hoisted(() => {
  const state = {
    published: [] as Array<NostrEvent & { relays?: string[] }>,
    subscriptions: [] as Array<{ filter: Record<string, unknown>; sink: (ev: NostrEvent) => void }>,
    /**
     * Per-event publish veto. Returning a string rejects that publish with it
     * as the relay's reason, so a test can fail exactly one of the two gift
     * wraps a NIP-17 send produces.
     */
    rejectPublish: null as null | ((ev: NostrEvent) => string | null),
  };

  function matches(f: Record<string, unknown>, ev: { kind: number; pubkey: string; tags: string[][] }): boolean {
    if (Array.isArray(f.kinds) && !(f.kinds as number[]).includes(ev.kind)) return false;
    if (Array.isArray(f.authors) && !(f.authors as string[]).includes(ev.pubkey)) return false;
    for (const k of Object.keys(f)) {
      if (!k.startsWith('#')) continue;
      const tag = k.slice(1);
      const wanted = f[k] as string[];
      const present = ev.tags.some((t) => t[0] === tag && wanted.includes(t[1]));
      if (!present) return false;
    }
    return true;
  }

  class FakePool {
    subscribe(
      relays: string[],
      filter: Record<string, unknown>,
      opts: { onevent: (ev: NostrEvent) => void; oneose?: () => void; onclose?: (reasons: string[]) => void },
    ) {
      const sub = { filter, sink: opts.onevent };
      state.subscriptions.push(sub);
      for (const ev of state.published) if (matches(filter, ev)) opts.onevent(ev);
      queueMicrotask(() => opts.oneose?.());
      return { close: () => { state.subscriptions = state.subscriptions.filter((s) => s !== sub); } };
    }
    publish(relays: string[], event: NostrEvent): Promise<string>[] {
      const reason = state.rejectPublish?.(event);
      if (reason) return [Promise.reject(new Error(reason))];
      state.published.push({ ...event, relays });
      queueMicrotask(() => {
        for (const sub of state.subscriptions) if (matches(sub.filter, event)) sub.sink(event);
      });
      return [Promise.resolve('ok')];
    }
    close(_relays: string[]): void {
      state.subscriptions = [];
    }
    async ensureRelay(_url: string): Promise<{ connected: boolean }> {
      return { connected: true };
    }
    async querySync(_relays: string[], filter: Record<string, unknown>): Promise<NostrEvent[]> {
      return state.published.filter((ev) => matches(filter, ev));
    }
  }

  return { state, FakePool, matches };
});

vi.mock('nostr-tools', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, SimplePool: fake.FakePool };
});

// A bunker mock that performs real NIP-04/NIP-44/signing crypto against a
// fixed remote keypair, so `withBunkerSigner` round-trips authentically
// instead of returning canned output — the same bar `getDmSigner`'s other
// two branches (nsec, nip07) are held to in this file.
const bunkerFake = vi.hoisted(() => {
  return { remoteSk: null as Uint8Array | null };
});

vi.mock('nostr-tools/nip46', async () => {
  const real = await vi.importActual<typeof import('nostr-tools')>('nostr-tools');
  const { v2: realNip44 } = await vi.importActual<typeof import('nostr-tools/nip44')>('nostr-tools/nip44');
  class BunkerSigner {
    async connect(): Promise<void> {}
    async getPublicKey(): Promise<string> {
      return real.getPublicKey(bunkerFake.remoteSk!);
    }
    async signEvent(template: Parameters<typeof real.finalizeEvent>[0]) {
      return real.finalizeEvent(template, bunkerFake.remoteSk!);
    }
    async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
      return real.nip04.encrypt(bunkerFake.remoteSk!, recipientPubkey, plaintext);
    }
    async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
      return real.nip04.decrypt(bunkerFake.remoteSk!, senderPubkey, ciphertext);
    }
    async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
      const key = realNip44.utils.getConversationKey(bunkerFake.remoteSk!, recipientPubkey);
      return realNip44.encrypt(plaintext, key);
    }
    async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
      const key = realNip44.utils.getConversationKey(bunkerFake.remoteSk!, senderPubkey);
      return realNip44.decrypt(ciphertext, key);
    }
    close(): void {}
    static fromBunker(_secret: Uint8Array, _bp: unknown, _opts: unknown) {
      return new BunkerSigner();
    }
  }
  return {
    BunkerSigner,
    parseBunkerInput: async (input: string) => {
      const match = input.match(/^bunker:\/\/([0-9a-f]{64})(?:\?(.*))?$/);
      if (!match) return null;
      const qs = new URLSearchParams(match[2] ?? '');
      return { pubkey: match[1], relays: qs.getAll('relay'), secret: qs.get('secret') };
    },
    createNostrConnectURI: () => 'nostrconnect://test',
  };
});

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { sk, skHex: bytesToHex(sk), pkHex: pk };
}

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/**
 * The send path awaits a variable number of async hops before it publishes
 * (the post-quantum send-plan check, then whichever signer the login method
 * uses), so counting microtasks is not a reliable way to wait for the wrap.
 */
async function waitForWrap(): Promise<NostrEvent & { relays?: string[] }> {
  return vi.waitFor(
    () => {
      const wrap = fake.state.published.find((e) => e.kind === 1059);
      if (!wrap) throw new Error('no gift wrap published yet');
      return wrap;
    },
    { timeout: 5000, interval: 5 },
  );
}

beforeEach(() => {
  fake.state.published = [];
  fake.state.subscriptions = [];
  fake.state.rejectPublish = null;
  bunkerFake.remoteSk = null;
  vi.resetModules();
  delete (window as unknown as { nostr?: unknown }).nostr;
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(async () => {
  const { getBridgeImpl } = await import('./client');
  getBridgeImpl()?.dispose();
  fake.state.published = [];
  fake.state.subscriptions = [];
  fake.state.rejectPublish = null;
});

/** Wait until `n` gift wraps have landed on the fake relay. */
async function waitForWraps(n: number): Promise<Array<NostrEvent & { relays?: string[] }>> {
  return vi.waitFor(
    () => {
      const wraps = fake.state.published.filter((e) => e.kind === 1059);
      if (wraps.length < n) throw new Error(`only ${wraps.length} of ${n} gift wraps published`);
      return wraps;
    },
    { timeout: 5000, interval: 5 },
  );
}

describe('NIP-17 send/receive', () => {
  it('sends NIP-17 by default and routes to the recipient\'s published inbox relays', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const alice = makeKeypair();
    const bob = makeKeypair();
    const bobInboxRelay = 'wss://bob-inbox.example';

    // Bob has published a kind-10050 pointing somewhere other than the
    // relay alice happens to be connected to.
    fake.state.published.push(
      finalizeEvent(
        { kind: 10050, created_at: 1, content: '', tags: [['relay', bobInboxRelay]] },
        bob.sk,
      ),
    );

    const bridge = await getBridge();
    await bridge.loginWithNsec(alice.skHex, alice.pkHex);
    setPreference('directMessagesEnabled', true);
    bridge.subscribeDirectMessages(() => {});

    await bridge.sendDirectMessage(bob.pkHex, 'meet me at the obelisk');
    await waitForWrap();
    await vi.waitFor(() => {
      if (fake.state.published.filter((e) => e.kind === 1059).length < 2) {
        throw new Error('self-copy not published yet');
      }
    }, { timeout: 5000, interval: 5 });

    const wraps = fake.state.published.filter((e) => e.kind === 1059);
    const toBob = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bob.pkHex));
    expect(toBob).toBeDefined();
    // Routed to bob's advertised inbox, not just alice's own relay.
    expect(toBob!.relays).toContain(bobInboxRelay);
    // Wire content is opaque — no plaintext, no NIP-04 fallback.
    for (const w of wraps) expect(w.content).not.toContain('meet me');
    expect(fake.state.published.filter((e) => e.kind === 4)).toHaveLength(0);
  });

  it('ingests a received gift wrap with protocol: nip17', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { buildChatMessage, sealAndGiftWrap } = await import('@nostr-wot/dm');
    const alice = makeKeypair();
    const bob = makeKeypair();

    // Alice seals + gift-wraps a message to bob using the SDK directly,
    // simulating an inbound DM from a wholly separate NIP-17 client.
    const aliceSigner = new PrivateKeySigner(alice.sk);
    const inner = buildChatMessage(alice.pkHex, bob.pkHex, 'hello bob');
    const wrap = await sealAndGiftWrap(aliceSigner, bob.pkHex, inner);
    fake.state.published.push(wrap);

    const bridge = await getBridge();
    await bridge.loginWithNsec(bob.skHex, bob.pkHex);
    setPreference('directMessagesEnabled', true);

    let last: Readonly<Record<string, ReadonlyArray<{ content: string; outgoing: boolean; protocol?: string; pq?: boolean }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => {
      const out: typeof last = {};
      for (const [k, v] of Object.entries(byPeer)) {
        (out as Record<string, unknown>)[k] = v.map((m) => ({ content: m.content, outgoing: m.outgoing, protocol: m.protocol, pq: m.pq }));
      }
      last = out;
    });
    await flush();

    const thread = last[alice.pkHex] ?? [];
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ content: 'hello bob', outgoing: false, protocol: 'nip17', pq: false });
  });

  it('rejects a gift wrap whose rumor pubkey does not match the seal signer (forged authorship)', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { buildChatMessage, sealAndGiftWrap } = await import('@nostr-wot/dm');
    const alice = makeKeypair();
    const mallory = makeKeypair();
    const bob = makeKeypair();

    // Mallory seals a rumor that CLAIMS to be from alice.
    const mallorySigner = new PrivateKeySigner(mallory.sk);
    const forgedInner = buildChatMessage(alice.pkHex, bob.pkHex, 'not really from alice');
    const wrap = await sealAndGiftWrap(mallorySigner, bob.pkHex, forgedInner);
    fake.state.published.push(wrap);

    const bridge = await getBridge();
    await bridge.loginWithNsec(bob.skHex, bob.pkHex);
    setPreference('directMessagesEnabled', true);

    let last: Readonly<Record<string, ReadonlyArray<{ content: string }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => { last = byPeer as typeof last; });
    await flush();

    expect(last[alice.pkHex]).toBeUndefined();
    expect(last[mallory.pkHex]).toBeUndefined();
  });
});

describe('NIP-17 signer adapter — all three login methods', () => {
  it('nsec: sends a well-formed, independently-decryptable gift wrap', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { unwrapGiftWrap } = await import('@nostr-wot/dm');
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridge = await getBridge();
    await bridge.loginWithNsec(alice.skHex, alice.pkHex);
    setPreference('directMessagesEnabled', true);
    await bridge.sendDirectMessage(bob.pkHex, 'from nsec');
    const wrap = await waitForWrap();

    const bobSigner = new PrivateKeySigner(bob.sk);
    const { message, senderPubkey } = await unwrapGiftWrap(bobSigner, wrap);
    expect(senderPubkey).toBe(alice.pkHex);
    expect(message.content).toBe('from nsec');
  });

  it('nip07: sends a well-formed, independently-decryptable gift wrap', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { unwrapGiftWrap } = await import('@nostr-wot/dm');
    const alice = makeKeypair();
    const bob = makeKeypair();

    // A NIP-07 extension backed by real crypto against alice's key, so the
    // adapter's dispatch through `window.nostr` is exercised for real.
    Object.defineProperty(window, 'nostr', {
      configurable: true,
      value: {
        getPublicKey: vi.fn().mockResolvedValue(alice.pkHex),
        signEvent: vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(template, alice.sk)),
        nip04: {
          encrypt: vi.fn(async (pk: string, text: string) => nip04.encrypt(alice.sk, pk, text)),
          decrypt: vi.fn(async (pk: string, ct: string) => nip04.decrypt(alice.sk, pk, ct)),
        },
        nip44: {
          encrypt: vi.fn(async (pk: string, text: string) =>
            nip44.encrypt(text, nip44.utils.getConversationKey(alice.sk, pk))),
          decrypt: vi.fn(async (pk: string, ct: string) =>
            nip44.decrypt(ct, nip44.utils.getConversationKey(alice.sk, pk))),
        },
      },
    });

    const bridge = await getBridge();
    await bridge.loginWithNip07(alice.pkHex);
    setPreference('directMessagesEnabled', true);
    await bridge.sendDirectMessage(bob.pkHex, 'from nip07');
    const wrap = await waitForWrap();

    const bobSigner = new PrivateKeySigner(bob.sk);
    const { message, senderPubkey } = await unwrapGiftWrap(bobSigner, wrap);
    expect(senderPubkey).toBe(alice.pkHex);
    expect(message.content).toBe('from nip07');
  });

  it('bunker: sends a well-formed, independently-decryptable gift wrap', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { unwrapGiftWrap } = await import('@nostr-wot/dm');
    const alice = makeKeypair();
    const bob = makeKeypair();
    bunkerFake.remoteSk = alice.sk;

    const bridge = await getBridge();
    await bridge.loginWithBunker(`bunker://${alice.pkHex}?relay=wss://relay.nsec.app`);
    setPreference('directMessagesEnabled', true);
    await bridge.sendDirectMessage(bob.pkHex, 'from bunker');
    const wrap = await waitForWrap();

    const bobSigner = new PrivateKeySigner(bob.sk);
    const { message, senderPubkey } = await unwrapGiftWrap(bobSigner, wrap);
    expect(senderPubkey).toBe(alice.pkHex);
    expect(message.content).toBe('from bunker');
  });
});

/**
 * The sender-addressed second gift wrap.
 *
 * A kind-1059 is signed by a fresh ephemeral key, so no `authors: [me]`
 * filter can ever find our own sends. Without a wrap addressed to ourselves,
 * an outgoing NIP-17 message lives only in the session that sent it: reload
 * and it is gone, while the recipient keeps it permanently.
 */
describe('NIP-17 self-copy', () => {
  async function loginAlice(alice: ReturnType<typeof makeKeypair>) {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const bridge = await getBridge();
    await bridge.loginWithNsec(alice.skHex, alice.pkHex);
    setPreference('directMessagesEnabled', true);
    return bridge;
  }

  it('publishes two wraps: different ephemeral keys, different recipients, one shared rumor', async () => {
    const { PrivateKeySigner } = await import('@nostr-wot/signers');
    const { unwrapGiftWrap } = await import('@nostr-wot/dm');
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridge = await loginAlice(alice);
    bridge.subscribeDirectMessages(() => {});
    await bridge.sendDirectMessage(bob.pkHex, 'two copies, one message');
    const wraps = await waitForWraps(2);

    expect(wraps).toHaveLength(2);
    const pTags = wraps.map((w) => w.tags.find((t) => t[0] === 'p')?.[1]).sort();
    expect(pTags).toEqual([alice.pkHex, bob.pkHex].sort());

    // Each wrap gets its own ephemeral key. Sharing one would let any relay
    // link the sender's copy to the recipient's, which is exactly the
    // metadata protection NIP-17 exists to provide.
    expect(wraps[0].pubkey).not.toBe(wraps[1].pubkey);
    expect(wraps.map((w) => w.pubkey)).not.toContain(alice.pkHex);
    expect(wraps.map((w) => w.pubkey)).not.toContain(bob.pkHex);

    // Same rumor in both, byte for byte: same id, same author, same content.
    // That shared id is what deduplicates the copies on ingest.
    const toBob = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === bob.pkHex))!;
    const toSelf = wraps.find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === alice.pkHex))!;
    const bobsView = await unwrapGiftWrap(new PrivateKeySigner(bob.sk), toBob);
    const ourView = await unwrapGiftWrap(new PrivateKeySigner(alice.sk), toSelf);
    expect(ourView.message.id).toBe(bobsView.message.id);
    expect(ourView.message.content).toBe('two copies, one message');
    expect(ourView.senderPubkey).toBe(alice.pkHex);
    // The self-copy still names bob as the chat partner, which is how
    // `ingestIncomingGiftWrap` recovers the counterparty for an outgoing wrap.
    expect(ourView.message.tags).toContainEqual(['p', bob.pkHex]);
  });

  it('renders the ingested self-copy once, not twice, alongside the local copy', async () => {
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridge = await loginAlice(alice);
    let last: Readonly<Record<string, ReadonlyArray<{ id: string; content: string; outgoing: boolean; pending?: boolean; protocol?: string }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => {
      const out: Record<string, ReadonlyArray<{ id: string; content: string; outgoing: boolean; pending?: boolean; protocol?: string }>> = {};
      for (const [k, v] of Object.entries(byPeer)) {
        out[k] = v.map((m) => ({ id: m.id, content: m.content, outgoing: m.outgoing, pending: m.pending, protocol: m.protocol }));
      }
      last = out;
    });

    await bridge.sendDirectMessage(bob.pkHex, 'exactly once');
    await waitForWraps(2);
    await flush(40);

    const thread = last[bob.pkHex] ?? [];
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ content: 'exactly once', outgoing: true, protocol: 'nip17' });
    expect(thread[0].pending).toBeFalsy();
    // Keyed on the rumor id, not on either gift wrap's ephemeral id — that
    // is what lets the two copies collapse into one message.
    const wraps = fake.state.published.filter((e) => e.kind === 1059);
    expect(wraps.map((w) => w.id)).not.toContain(thread[0].id);
    // Nothing leaked into a thread keyed on our own pubkey.
    expect(last[alice.pkHex]).toBeUndefined();
  });

  it('restores the sent message after a reload', async () => {
    // The actual bug: everything the sender sees is in-memory today, so a
    // reload drops their own history. Log out (which clears every DM store)
    // and log back in against the same relay: the message must come back,
    // outgoing, in bob's thread.
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridge = await loginAlice(alice);
    bridge.subscribeDirectMessages(() => {});
    await bridge.sendDirectMessage(bob.pkHex, 'survives a reload');
    await waitForWraps(2);
    await flush(40);

    await bridge.logout();

    const { setPreference } = await import('@/lib/preferences');
    await bridge.loginWithNsec(alice.skHex, alice.pkHex);
    setPreference('directMessagesEnabled', true);
    let last: Readonly<Record<string, ReadonlyArray<{ content: string; outgoing: boolean; protocol?: string }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => {
      const out: Record<string, ReadonlyArray<{ content: string; outgoing: boolean; protocol?: string }>> = {};
      for (const [k, v] of Object.entries(byPeer)) {
        out[k] = v.map((m) => ({ content: m.content, outgoing: m.outgoing, protocol: m.protocol }));
      }
      last = out;
    });

    await vi.waitFor(
      () => {
        if ((last[bob.pkHex] ?? []).length === 0) throw new Error('history not restored yet');
      },
      { timeout: 5000, interval: 5 },
    );

    expect(last[bob.pkHex]).toEqual([
      { content: 'survives a reload', outgoing: true, protocol: 'nip17' },
    ]);
  });

  it('still succeeds the send when the self-copy publish fails', async () => {
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridge = await loginAlice(alice);
    let last: Readonly<Record<string, ReadonlyArray<{ content: string; pending?: boolean; failed?: boolean }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => {
      const out: Record<string, ReadonlyArray<{ content: string; pending?: boolean; failed?: boolean }>> = {};
      for (const [k, v] of Object.entries(byPeer)) {
        out[k] = v.map((m) => ({ content: m.content, pending: m.pending, failed: m.failed }));
      }
      last = out;
    });

    // Reject only the wrap addressed to ourselves. The recipient's copy is
    // the message; losing ours degrades history, it does not lose the send.
    fake.state.rejectPublish = (ev) =>
      ev.kind === 1059 && ev.tags.some((t) => t[0] === 'p' && t[1] === alice.pkHex)
        ? 'blocked: not accepting self-addressed wraps'
        : null;

    await bridge.sendDirectMessage(bob.pkHex, 'delivered anyway');
    await waitForWraps(1);
    await flush(40);

    const thread = last[bob.pkHex] ?? [];
    expect(thread).toHaveLength(1);
    expect(thread[0].content).toBe('delivered anyway');
    expect(thread[0].failed).toBeFalsy();
    expect(thread[0].pending).toBeFalsy();
    // Only the recipient's copy made it to the relay.
    expect(fake.state.published.filter((e) => e.kind === 1059)).toHaveLength(1);
  });

  it('does not publish a self-copy for a NIP-04 thread', async () => {
    const { useDMStore } = await import('@/store/dm');
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridge = await loginAlice(alice);
    bridge.subscribeDirectMessages(() => {});
    useDMStore.setState({ protocolOverrides: { [bob.pkHex]: 'nip04' } });

    await bridge.sendDirectMessage(bob.pkHex, 'legacy thread');
    await vi.waitFor(
      () => {
        if (!fake.state.published.some((e) => e.kind === 4)) throw new Error('no kind 4 yet');
      },
      { timeout: 5000, interval: 5 },
    );
    await flush(40);

    // NIP-04 needs no self-copy: it is authored by us, so the `authors: [me]`
    // subscription already finds it.
    expect(fake.state.published.filter((e) => e.kind === 1059)).toHaveLength(0);
    useDMStore.setState({ protocolOverrides: {} });
  });
});

describe('kind-10050 inbox-list publish on login', () => {
  it('publishes an inbox list on login when DMs are enabled and none exists yet', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    setPreference('directMessagesEnabled', true);
    const alice = makeKeypair();

    const bridge = await getBridge();
    await bridge.loginWithNsec(alice.skHex, alice.pkHex);
    await flush();

    const inboxEvents = fake.state.published.filter((e) => e.kind === 10050 && e.pubkey === alice.pkHex);
    expect(inboxEvents).toHaveLength(1);
    expect(inboxEvents[0].tags).toContainEqual(['relay', 'wss://public.obelisk.ar']);
  });

  it('does not publish an inbox list on login when DMs are disabled (the default)', async () => {
    const { getBridge } = await import('./client');
    const alice = makeKeypair();

    const bridge = await getBridge();
    await bridge.loginWithNsec(alice.skHex, alice.pkHex);
    await flush();

    expect(fake.state.published.some((e) => e.kind === 10050)).toBe(false);
  });
});
