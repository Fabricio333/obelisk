/**
 * Regression tests for the NIP-42 `'authenticating'` relay-access state.
 *
 * The bug these guard against: after login the bridge could paint cached
 * relay-scoped state (groups, members, messages) before the relay had
 * confirmed AUTH, so users saw "channels with zero messages" until they
 * pressed F5. The fix surfaces the in-flight AUTH as a distinct relay-
 * access state so the UI can gate cached data on a positive AUTH signal.
 *
 * Covered:
 *   1. The `automaticallyAuth` callback flips relay-access to
 *      `'authenticating'` synchronously when the relay challenges us.
 *   2. A successful read on the relay (event delivered) flips it to
 *      `'ok'` and clears the in-flight state.
 *   3. Sticky-OK guard: once the relay is `'ok'`, a later AUTH challenge
 *      does NOT downgrade to `'authenticating'`.
 *   4. CLOSED `auth-required` after `'authenticating'` flips to
 *      `'auth-required'` once the soak window elapses (so the banner
 *      surfaces a real AUTH failure, not a transient race).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, type Event as NostrEvent } from 'nostr-tools';

const fake = vi.hoisted(() => {
  const state = {
    pools: [] as Array<{
      authHandler: ((relayUrl: string) => ((evt: any) => Promise<any>) | null) | null;
    }>,
    published: [] as NostrEvent[],
    subscriptions: [] as Array<{
      filter: Record<string, unknown>;
      sink: (ev: NostrEvent) => void;
      relays: string[];
      onclose?: (reasons: string[]) => void;
      oneose?: () => void;
    }>,
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

  /**
   * Stand-in for `nostr-tools` `SimplePool` that captures the
   * `automaticallyAuth` callback so tests can simulate a NIP-42 AUTH
   * challenge by invoking it directly with the active relay URL.
   *
   * Deliberately does NOT auto-fire EOSE. The real watchdog uses EOSE/
   * onevent to flip relays to `'ok'`; auto-firing would race past the
   * `'authenticating'` window we're trying to observe. Tests drive
   * deliveries explicitly via `state.published` + `sub.sink`.
   */
  class FakePool {
    authHandler: ((relayUrl: string) => ((evt: any) => Promise<any>) | null) | null = null;

    constructor(opts?: any) {
      this.authHandler = opts?.automaticallyAuth ?? null;
      state.pools.push(this);
    }

    subscribe(
      relays: string[],
      filter: Record<string, unknown>,
      opts: {
        onevent: (ev: NostrEvent) => void;
        oneose?: () => void;
        onclose?: (reasons: string[]) => void;
        onauth?: unknown;
      },
    ) {
      const sub = {
        filter,
        sink: opts.onevent,
        relays,
        onclose: opts.onclose,
        oneose: opts.oneose,
      };
      state.subscriptions.push(sub);
      for (const ev of state.published) if (matches(filter, ev)) opts.onevent(ev);
      return {
        close: () => {
          state.subscriptions = state.subscriptions.filter((s) => s !== sub);
        },
      };
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

    async ensureRelay(_url: string, _opts?: { connectionTimeout?: number }) {
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

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const skHex = Array.from(sk).map((x) => x.toString(16).padStart(2, '0')).join('');
  return { skHex, pkHex: pk };
}

function normalizeRelayUrl(u: string): string {
  return u.replace(/\/+$/, '').toLowerCase();
}

beforeEach(() => {
  fake.state.pools = [];
  fake.state.published = [];
  fake.state.subscriptions = [];
  vi.resetModules();
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(() => {
  fake.state.pools = [];
  fake.state.published = [];
  fake.state.subscriptions = [];
  vi.useRealTimers();
});

describe('relay-access "authenticating" state', () => {
  it('flips to "authenticating" the moment the relay challenges AUTH', async () => {
    const clientMod = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const impl = clientMod.getBridgeImpl()!;
    const url = impl.currentRelayUrl.get();
    const key = normalizeRelayUrl(url);

    // No AUTH yet — relay starts unknown (no entry in the map).
    expect(impl.relayAccess.get()[key]).toBeUndefined();

    // The session pool is the most recently constructed FakePool —
    // resetPoolForSessionChange built a fresh one on login.
    const pool = fake.state.pools.at(-1)!;
    expect(pool.authHandler).not.toBeNull();

    // Simulate the relay sending a NIP-42 AUTH challenge: the pool
    // resolves automaticallyAuth(url) to obtain a signer.
    const signer = pool.authHandler!(url);
    expect(signer).not.toBeNull();

    // The bridge must surface the in-flight AUTH synchronously so the
    // sidebar/chat-panel gates can hide cached groups/messages BEFORE
    // any signer round-trip — that's the whole point of the new state.
    expect(impl.relayAccess.get()[key]).toBe('authenticating');
  });

  it('flips from "authenticating" to "ok" when the relay starts delivering events', async () => {
    const clientMod = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const impl = clientMod.getBridgeImpl()!;
    const url = impl.currentRelayUrl.get();
    const key = normalizeRelayUrl(url);

    const pool = fake.state.pools.at(-1)!;
    const signer = pool.authHandler!(url);

    // Sanity: the nsec signer can sign the AUTH challenge — this proves
    // the bridge didn't break the existing signer path.
    const signed = await signer!({
      kind: 22242,
      content: '',
      tags: [],
      created_at: 1,
      pubkey: pkHex,
    });
    expect((signed as any).sig).toBeTruthy();

    expect(impl.relayAccess.get()[key]).toBe('authenticating');

    // Deliver a kind 39000 group-metadata event matching the global
    // metadata sub. The bridge's onevent path calls
    // setRelayAccess(url, 'ok'), which is the proof-of-read flag.
    const ev: NostrEvent = {
      id: 'meta-1',
      pubkey: 'relay-pk',
      created_at: 1,
      kind: 39000,
      sig: '',
      content: '',
      tags: [['d', 'group-x'], ['name', 'X']],
    };
    fake.state.published.push(ev);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, ev)) sub.sink(ev);
    }

    expect(impl.relayAccess.get()[key]).toBe('ok');
  });

  it('sticky-OK: once the relay is "ok", a later AUTH challenge does not downgrade', async () => {
    const clientMod = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const impl = clientMod.getBridgeImpl()!;
    const url = impl.currentRelayUrl.get();
    const key = normalizeRelayUrl(url);

    // Move the relay to 'ok' first by delivering an event.
    const ev: NostrEvent = {
      id: 'meta-1',
      pubkey: 'relay-pk',
      created_at: 1,
      kind: 39000,
      sig: '',
      content: '',
      tags: [['d', 'group-x'], ['name', 'X']],
    };
    fake.state.published.push(ev);
    for (const sub of fake.state.subscriptions) {
      if (fake.matches(sub.filter, ev)) sub.sink(ev);
    }
    expect(impl.relayAccess.get()[key]).toBe('ok');

    // Now another AUTH challenge — should be a no-op for state. Sticky-
    // OK exists because periodic AUTH refreshes (some relays do this)
    // would otherwise cause the UI to flicker channels off, then on.
    const pool = fake.state.pools.at(-1)!;
    pool.authHandler!(url);
    expect(impl.relayAccess.get()[key]).toBe('ok');
  });

  it('CLOSED auth-required during "authenticating" flips to "auth-required" after the soak elapses', async () => {
    const clientMod = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const impl = clientMod.getBridgeImpl()!;
    const url = impl.currentRelayUrl.get();
    const key = normalizeRelayUrl(url);

    const pool = fake.state.pools.at(-1)!;
    pool.authHandler!(url);
    expect(impl.relayAccess.get()[key]).toBe('authenticating');

    // Switch to fake timers AFTER login so the connect() handshake
    // (which uses microtasks + a synchronous ensureRelay) isn't held up.
    vi.useFakeTimers();

    // Simulate the relay sending CLOSED with an auth-required reason
    // on a sub. This drives setRelayAccessDeferred — the soak window
    // is the bridge's mechanism for hiding transient AUTH races.
    const sub = fake.state.subscriptions.find((s) =>
      Array.isArray((s.filter as any).kinds) && (s.filter as any).kinds.includes(39000),
    );
    expect(sub).toBeTruthy();
    sub!.onclose?.(['auth-required: please sign']);

    // During the soak window, state stays 'authenticating' — we don't
    // want to flash a "Not authenticated" banner if the very next retry
    // is going to succeed.
    expect(impl.relayAccess.get()[key]).toBe('authenticating');

    // Advance past RELAY_ACCESS_SOAK_MS (4000ms). The deferred timer
    // re-evaluates state and routes through setRelayAccess, which
    // detects the 'authenticating' → 'auth-required' transition and
    // marks the activity-log entry failed in the same step.
    vi.advanceTimersByTime(4500);

    expect(impl.relayAccess.get()[key]).toBe('auth-required');
  });


  it('does not AUTH an override relay used by a watched subscription', async () => {
    const clientMod = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const impl = clientMod.getBridgeImpl()!;
    const pool = fake.state.pools.at(-1)!;
    const auxUrl = 'wss://relay.extra.example';
    const stop = impl.subscribeFilterWatched(
      { kinds: [1] },
      () => {},
      { relays: [auxUrl], relayMode: 'replace' },
    );

    expect(fake.state.subscriptions.at(-1)?.relays).toEqual([auxUrl]);
    expect(pool.authHandler!(auxUrl)).toBeNull();
    expect(impl.relayAccess.get()[normalizeRelayUrl(auxUrl)]).toBeUndefined();
    stop();
  });


  it('does not enter "authenticating" for an auxiliary (non-active) relay', async () => {
    const clientMod = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await clientMod.getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const impl = clientMod.getBridgeImpl()!;
    const pool = fake.state.pools.at(-1)!;
    const auxUrl = 'wss://relay.damus.io';

    expect(pool.authHandler!(auxUrl)).toBeNull();

    const activeKey = normalizeRelayUrl(impl.currentRelayUrl.get());
    expect(impl.relayAccess.get()[activeKey]).toBeUndefined();
  });
});
