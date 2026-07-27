/**
 * Regression tests for the "needs 3 refreshes after login" bug.
 *
 * Cover:
 *   Fix A — `isLoggedIn` flips only after `connect()` resolves.
 *   Fix B — `ingestGroupMetadata` eagerly subscribes to admin/member events
 *           for every discovered group (kinds 39001 + 39002 with `#d` filter).
 *   Fix C — bunker pre-warm: `ensureBunkerSigner()` runs during `initialize`
 *           when the persisted session uses NIP-46.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools';

const fake = vi.hoisted(() => {
  const state = {
    published: [] as NostrEvent[],
    subscriptions: [] as Array<{ filter: Record<string, unknown>; sink: (ev: NostrEvent) => void }>,
    connectOrder: [] as string[],
    bunkerConnectCount: 0,
    bunkerGetPublicKeyCount: 0,
    bunkerFromBunkerCount: 0,
    bunkerSignPending: false,
    bunkerSignCount: 0,
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
    subscribe(_relays: string[], filter: Record<string, unknown>, opts: { onevent: (ev: NostrEvent) => void; oneose?: () => void; onauth?: unknown }) {
      const sub = { filter, sink: opts.onevent };
      state.subscriptions.push(sub);
      for (const ev of state.published) if (matches(filter, ev)) opts.onevent(ev);
      queueMicrotask(() => opts.oneose?.());
      return { close: () => { state.subscriptions = state.subscriptions.filter((s) => s !== sub); } };
    }
    publish(_relays: string[], event: NostrEvent): Promise<string>[] {
      state.published.push(event);
      queueMicrotask(() => {
        for (const sub of state.subscriptions) if (matches(sub.filter, event)) sub.sink(event);
      });
      return [Promise.resolve('ok')];
    }
    close(_relays: string[]): void {
      state.subscriptions = [];
    }
    async ensureRelay(url: string, _opts?: { connectionTimeout?: number }) {
      state.connectOrder.push(`ensureRelay:${url}`);
      return { connected: true };
    }
    async querySync(_relays: string[], filter: Record<string, unknown>, _opts?: { maxWait?: number }): Promise<NostrEvent[]> {
      return state.published.filter((ev) => matches(filter, ev));
    }
  }

  return { state, FakePool, matches };
});

vi.mock('nostr-tools', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, SimplePool: fake.FakePool };
});

// Bunker mock for Fix C. The real BunkerSigner.fromBunker constructs a signer
// that only handshakes when `signer.connect()` is awaited. We mock it so the
// test can assert connect is called exactly once during initialize.
vi.mock('nostr-tools/nip46', () => {
  class BunkerSigner {
    bp: { pubkey: string; relays: string[]; secret: string | null };
    closed = false;
    constructor(bp = { pubkey: 'bunker-remote-pk', relays: ['wss://relay.nsec.app'] as string[], secret: 'sec' as string | null }) {
      this.bp = bp;
    }
    static fromBunker(_secret: Uint8Array, bp: { pubkey: string; relays: string[]; secret: string | null }, _opts: unknown) {
      fake.state.bunkerFromBunkerCount++;
      return new BunkerSigner(bp);
    }
    static async fromURI(): Promise<BunkerSigner> { return new BunkerSigner(); }
    async connect(): Promise<void> {
      fake.state.bunkerConnectCount++;
    }
    async getPublicKey(): Promise<string> {
      fake.state.bunkerGetPublicKeyCount++;
      return 'a'.repeat(64);
    }
    async signEvent(evt: { kind: number; tags: string[][]; content: string; created_at?: number; pubkey?: string }) {
      if (this.closed) throw new Error('this signer is not open anymore, create a new one');
      fake.state.bunkerSignCount++;
      if (fake.state.bunkerSignPending) return new Promise(() => {});
      return {
        ...evt,
        id: 'mocked-id',
        sig: 'mocked-sig',
        pubkey: 'a'.repeat(64),
        created_at: evt.created_at ?? Math.floor(Date.now() / 1000),
      };
    }
    close(): void { this.closed = true; }
  }
  return {
    BunkerSigner,
    parseBunkerInput: async (url: string) => ({
      pubkey: 'bunker-remote-pk',
      relays: ['wss://relay.nsec.app'],
      secret: url.includes('secret=') ? 'sec' : null,
    }),
    createNostrConnectURI: () => 'nostrconnect://test',
  };
});

import { STORAGE_KEY } from './client';

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const skHex = Array.from(sk).map((x) => x.toString(16).padStart(2, '0')).join('');
  return { skHex, pkHex: pk };
}

beforeEach(() => {
  fake.state.published = [];
  fake.state.subscriptions = [];
  fake.state.connectOrder = [];
  fake.state.bunkerConnectCount = 0;
  fake.state.bunkerGetPublicKeyCount = 0;
  fake.state.bunkerFromBunkerCount = 0;
  fake.state.bunkerSignPending = false;
  fake.state.bunkerSignCount = 0;
  vi.resetModules();
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(() => {
  fake.state.published = [];
  fake.state.subscriptions = [];
});

describe('Fix A — login → render race', () => {
  it('isLoggedIn flips only after connect completes', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();

    // Snapshot isLoggedIn at every change so we can compare against the
    // moment ensureRelay finished.
    const transitions: { value: boolean; afterEnsure: boolean }[] = [];
    bridge.subscribeIsLoggedIn((v) => {
      transitions.push({
        value: v,
        afterEnsure: fake.state.connectOrder.length > 0,
      });
    });

    await bridge.loginWithNsec(skHex, pkHex);

    // First subscription event is the initial value (false). The second is
    // the post-connect flip to true.
    const flipToTrue = transitions.find((t) => t.value === true);
    expect(flipToTrue).toBeDefined();
    expect(flipToTrue!.afterEnsure).toBe(true);
  });

  it('global subscriptions are open by the time isLoggedIn fires true', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();

    let subsCountAtFlip = -1;
    bridge.subscribeIsLoggedIn((v) => {
      if (v && subsCountAtFlip === -1) {
        subsCountAtFlip = fake.state.subscriptions.length;
      }
    });

    await bridge.loginWithNsec(skHex, pkHex);
    // At least: group metadata, kind 3 contact list, own kind 0. DM kind 4
    // subscriptions are intentionally gated behind the local DM opt-in.
    expect(subsCountAtFlip).toBeGreaterThanOrEqual(3);
    expect(fake.state.subscriptions.some((s) => (s.filter.kinds as number[] | undefined)?.includes(4))).toBe(false);
  });
});

describe('Fix B (revised) — admin/member subscription is lazy', () => {
  // Original Fix B fanned out kind 39001+39002 REQs on every kind 39000
  // ingest. That made the sidebar "I'm an admin" badge paint without
  // opening the channel, but slowed login on accounts in many channels
  // and slowed setup of recently created groups. The new contract:
  // ingest does NOT fan out admin/member; per-group REQs open lazily on
  // first useAdmins / useMembers / subscribeAdmins / subscribeMembers
  // call from the chat panel. See docs/data-system.md.
  it('does NOT subscribe to kinds 39001+39002 on kind 39000 ingest', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const metaEvent: NostrEvent = {
      id: 'meta-1', pubkey: 'relay-pk', created_at: 1, kind: 39000, sig: '',
      content: '',
      tags: [
        ['d', 'test-group'],
        ['name', 'Test Group'],
      ],
    };
    fake.state.published.push(metaEvent);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, metaEvent)) sub.sink(metaEvent);
    }

    const adminMemberSubs = fake.state.subscriptions.filter((s) => {
      const kinds = s.filter.kinds as number[] | undefined;
      const dTag = (s.filter['#d'] as string[] | undefined) ?? [];
      return Array.isArray(kinds)
        && kinds.includes(39001)
        && dTag.includes('test-group');
    });
    expect(adminMemberSubs.length).toBe(0);
  });

  it('opens the per-group admin/member REQ on first subscribeAdmins call', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const metaEvent: NostrEvent = {
      id: 'meta-1', pubkey: 'relay-pk', created_at: 1, kind: 39000, sig: '',
      content: '', tags: [['d', 'test-group'], ['name', 'X']],
    };
    fake.state.published.push(metaEvent);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, metaEvent)) sub.sink(metaEvent);
    }
    bridge.subscribeAdmins('test-group', () => {});

    const after = fake.state.subscriptions.filter((s) => {
      const kinds = s.filter.kinds as number[] | undefined;
      const dTag = (s.filter['#d'] as string[] | undefined) ?? [];
      return Array.isArray(kinds) && kinds.includes(39001) && dTag.includes('test-group');
    }).length;
    expect(after).toBeGreaterThanOrEqual(1);

    // Idempotent — a second call doesn't open a duplicate sub.
    bridge.subscribeAdmins('test-group', () => {});
    const after2 = fake.state.subscriptions.filter((s) => {
      const kinds = s.filter.kinds as number[] | undefined;
      const dTag = (s.filter['#d'] as string[] | undefined) ?? [];
      return Array.isArray(kinds) && kinds.includes(39001) && dTag.includes('test-group');
    }).length;
    expect(after2).toBe(after);
  });
});

describe('Fix C — bunker pre-warm on initialize', () => {
  it('pre-warms BunkerSigner during initialize when persisted session is bunker', async () => {
    // Seed a bunker-shaped session in localStorage so initialize() rehydrates it.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pubKeyHex: 'a'.repeat(64),
        loginMethod: 'bunker',
        relayUrl: 'wss://relay.example.com',
        bunkerUrl: 'bunker://abc?relay=wss://relay.nsec.app&secret=s',
        bunkerLocalSecretHex: 'b'.repeat(64),
      }),
    );

    const { getBridge } = await import('./client');
    await getBridge();
    // Pre-warm is fire-and-forget; allow microtasks to drain.
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.state.bunkerConnectCount).toBeGreaterThanOrEqual(1);
  });

  it('pre-warms SDK QR bunker sessions without replaying connect when no secret is stored', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        pubKeyHex: 'a'.repeat(64),
        loginMethod: 'bunker',
        relayUrl: 'wss://relay.example.com',
        bunkerUrl: 'bunker://abc?relay=wss://relay.nsec.app',
        bunkerLocalSecretHex: 'b'.repeat(64),
      }),
    );

    const { getBridge } = await import('./client');
    await getBridge();
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.state.bunkerConnectCount).toBe(0);
    expect(fake.state.bunkerGetPublicKeyCount).toBeGreaterThanOrEqual(1);
  });

  it('does not replay connect for SDK-paired loginWithBunker handoff', async () => {
    const { getBridge } = await import('./client');
    const bridge = await getBridge();

    await bridge.loginWithBunker('bunker://abc?relay=wss://relay.nsec.app', {
      clientSecretHex: 'b'.repeat(64),
    });

    expect(bridge.getPublicKey()).toBe('a'.repeat(64));
    expect(fake.state.bunkerConnectCount).toBe(0);
    expect(fake.state.bunkerGetPublicKeyCount).toBeGreaterThanOrEqual(1);
  });

  it('keeps a bridge-owned signer alive after the SDK closes its paired signer', async () => {
    const { getBridge } = await import('./client');
    const bridge = await getBridge();
    const { BunkerSigner } = await import('nostr-tools/nip46');
    const signer = BunkerSigner.fromBunker(
      new Uint8Array(32),
      { pubkey: 'a'.repeat(64), relays: ['wss://relay.nsec.app'], secret: null },
    );
    fake.state.bunkerFromBunkerCount = 0;

    await bridge.loginWithBunker('bunker://abc?relay=wss://relay.nsec.app', {
      clientSecretHex: 'b'.repeat(64),
      signer,
    });

    expect(fake.state.bunkerFromBunkerCount).toBe(1);
    expect(fake.state.bunkerConnectCount).toBe(0);
    expect(fake.state.bunkerGetPublicKeyCount).toBe(1);

    signer.close();
    await expect(bridge.publishEvent({ kind: 20078, content: '', tags: [['e', 'voice']] }))
      .resolves.toMatchObject({ kind: 20078, pubkey: 'a'.repeat(64) });
  });

  it('evicts a timed-out NIP-42 signature so the same challenge can retry', async () => {
    const { BUNKER_AUTH_SIGNATURE_TIMEOUT_MS, getBridge } = await import('./client');
    const bridge = await getBridge();
    await bridge.loginWithBunker('bunker://abc?relay=wss://relay.nsec.app', {
      clientSecretHex: 'b'.repeat(64),
    });
    const signAuthEvent = (bridge as unknown as {
      signAuthEvent: (event: { kind: number; content: string; tags: string[][]; created_at: number }) => Promise<NostrEvent>;
    }).signAuthEvent.bind(bridge);
    const challenge = { kind: 22242, content: 'challenge', tags: [['relay', 'wss://relay.test']], created_at: 1 };

    vi.useFakeTimers();
    try {
      fake.state.bunkerSignPending = true;
      const first = signAuthEvent(challenge);
      const timedOut = expect(first).rejects.toThrow(/did not answer NIP-42/i);
      await vi.advanceTimersByTimeAsync(BUNKER_AUTH_SIGNATURE_TIMEOUT_MS);
      await timedOut;

      fake.state.bunkerSignPending = false;
      await expect(signAuthEvent(challenge)).resolves.toMatchObject({ kind: 22242 });
      expect(fake.state.bunkerSignCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT pre-warm BunkerSigner for nsec sessions', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        privKeyHex: 'a'.repeat(64),
        pubKeyHex: 'b'.repeat(64),
        loginMethod: 'nsec',
        relayUrl: 'wss://relay.example.com',
      }),
    );

    const { getBridge } = await import('./client');
    await getBridge();
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.state.bunkerConnectCount).toBe(0);
  });
});

describe('Fix E — re-login does not strand kind 39000 behind newest-wins guard', () => {
  // The bridge instance survives logout (only `getBridge()` resets it, which
  // happens on a hard page reload). `groupMetadataLatestAt` is an in-memory
  // Map on that instance. Without the fix, logging out and back in on the
  // same browser leaves the Map populated with `groupId → created_at` from
  // the prior session — and because kind 39000 is replaceable, the new
  // session's REQ delivers events with the SAME `created_at` the guard just
  // memorized, so `if (ev.created_at <= prevAt) return;` drops every one and
  // the sidebar reads "No channels found" until the user toggles relays.
  // resetPoolForSessionChange now clears the Map.
  it('re-ingests kind 39000 with the same created_at after logout + login', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();

    const metaEvent: NostrEvent = {
      id: 'meta-1', pubkey: 'relay-pk', created_at: 1234, kind: 39000, sig: '',
      content: '', tags: [['d', 'persistent-group'], ['name', 'Persistent']],
    };

    let groups: ReadonlyArray<{ id: string }> = [];
    bridge.subscribeGroups((g) => { groups = g; });

    await bridge.loginWithNsec(skHex, pkHex);
    fake.state.published.push(metaEvent);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, metaEvent)) sub.sink(metaEvent);
    }
    expect(groups.find((g) => g.id === 'persistent-group')).toBeDefined();

    await bridge.logout();
    expect(groups.find((g) => g.id === 'persistent-group')).toBeUndefined();

    // metaEvent is still in fake.state.published. FakePool replays it to any
    // matching new subscription, so we don't need to fan out manually — the
    // post-login subscribeGroupMetadata sub picks it up synchronously.
    await bridge.loginWithNsec(skHex, pkHex);
    expect(groups.find((g) => g.id === 'persistent-group')).toBeDefined();
  });
});

describe('Fix D — bridgeCache integration: admin/member persistence', () => {
  it('persists admin list to cache when the relay delivers kind 39001', async () => {
    const clientMod = await import('./client');
    const { cacheGet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    // Discover the group so admin/member subs open.
    const metaEvent: NostrEvent = {
      id: 'meta-1', pubkey: 'relay-pk', created_at: 1, kind: 39000, sig: '',
      content: '', tags: [['d', 'group-x'], ['name', 'X']],
    };
    fake.state.published.push(metaEvent);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, metaEvent)) sub.sink(metaEvent);
    }
    // Admin/member is now lazy — trigger it the way the chat panel does.
    bridge.subscribeAdmins('group-x', () => {});

    // Now deliver an admin list (kind 39001) for that group.
    const adminEvent: NostrEvent = {
      id: 'admin-1', pubkey: 'relay-pk', created_at: 2, kind: 39001, sig: '',
      content: '',
      tags: [['d', 'group-x'], ['p', 'pk-admin-1', 'admin']],
    };
    fake.state.published.push(adminEvent);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, adminEvent)) sub.sink(adminEvent);
    }

    const impl = clientMod.getBridgeImpl();
    const relay = impl!.currentRelayUrl.get();
    const cached = cacheGet<string[]>(relay, 39001, 'group-x');
    expect(cached).not.toBeNull();
    expect(cached!.value).toEqual(['pk-admin-1']);
  });
});
