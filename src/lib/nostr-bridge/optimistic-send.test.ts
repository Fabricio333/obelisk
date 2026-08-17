/**
 * Optimistic-send contract tests for the bridge.
 *
 * The bridge is supposed to insert a `pending: true` placeholder in
 * `messagesByGroup` / `dmsByPeer` synchronously, then either replace it with
 * the real event on publish-ack or flip it to `failed: true` on rejection.
 * Retries should re-publish the same payload and round-trip through the same
 * placeholder slot.
 *
 * Mirrors the FakePool pattern from `bridge.test.ts` so a publish round-trip
 * is observable without touching the network. One difference: we hand a
 * `publish` function that can either resolve OK or reject, controlled per
 * test, so the failure / retry paths can be exercised deterministically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event as NostrEvent } from 'nostr-tools';

type PublishOutcome = 'ok' | { reject: string };

const fake = vi.hoisted(() => {
  const state = {
    published: [] as NostrEvent[],
    subscriptions: [] as Array<{
      filter: Record<string, unknown>;
      sink: (ev: NostrEvent) => void;
    }>,
    /**
     * Queue of outcomes for the next N publishes, oldest first. When the
     * queue empties, defaults to 'ok'. Tests `enqueue('reject')` before
     * triggering `sendMessage` to deterministically fail the publish.
     */
    nextOutcomes: [] as PublishOutcome[],
  };

  function matches(f: Record<string, unknown>, ev: NostrEvent): boolean {
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
      _relays: string[],
      filter: Record<string, unknown>,
      opts: {
        onevent: (ev: NostrEvent) => void;
        oneose?: () => void;
        onclose?: (reasons: string[]) => void;
      },
    ) {
      const sub = { filter, sink: opts.onevent };
      state.subscriptions.push(sub);
      for (const ev of state.published) if (matches(filter, ev)) opts.onevent(ev);
      queueMicrotask(() => opts.oneose?.());
      return {
        close: () => { state.subscriptions = state.subscriptions.filter((s) => s !== sub); },
      };
    }
    publish(_relays: string[], event: NostrEvent): Promise<string>[] {
      const outcome = state.nextOutcomes.shift() ?? 'ok';
      if (outcome === 'ok') {
        state.published.push(event);
        queueMicrotask(() => {
          for (const sub of state.subscriptions) if (matches(sub.filter, event)) sub.sink(event);
        });
        return [Promise.resolve('ok')];
      }
      return [Promise.reject(new Error(outcome.reject))];
    }
    close(_relays: string[]): void {
      state.subscriptions = [];
    }
    async ensureRelay(_url: string): Promise<{ connected: boolean }> {
      return { connected: true };
    }
    async querySync(_relays: string[], filter: Record<string, unknown>, _opts?: { maxWait?: number }): Promise<NostrEvent[]> {
      return state.published.filter((ev) => matches(filter, ev));
    }
  }

  return { state, FakePool };
});

vi.mock('nostr-tools', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, SimplePool: fake.FakePool };
});

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const nsec = nip19.nsecEncode(sk);
  return { skHex: bytesToHex(sk), pkHex: pk, nsec };
}

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Wait until `n` NIP-17 gift wraps have landed on the fake relay. */
async function waitForWraps(n: number) {
  return vi.waitFor(
    () => {
      const wraps = fake.state.published.filter((e) => e.kind === 1059);
      if (wraps.length < n) throw new Error(`only ${wraps.length} of ${n} gift wraps published`);
      return wraps;
    },
    { timeout: 5000, interval: 5 },
  );
}

beforeEach(() => {
  fake.state.published = [];
  fake.state.subscriptions = [];
  fake.state.nextOutcomes = [];
  vi.resetModules();
  delete window.nostr;
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(() => {
  fake.state.published = [];
  fake.state.subscriptions = [];
  fake.state.nextOutcomes = [];
});

describe('optimistic group messages', () => {
  it('serializes a NIP-07 join request before a pubkey-free kind-9 template', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const sk = Uint8Array.from(skHex.match(/../g)!.map((byte) => parseInt(byte, 16)));
    let signing = false;
    const signEvent = vi.fn(async (template: Parameters<typeof finalizeEvent>[0]) => {
      if ('pubkey' in template) throw new Error('NIP-07 templates must not include pubkey');
      if (signing) throw new Error('concurrent extension signature request');
      signing = true;
      await Promise.resolve();
      const event = finalizeEvent(template, sk);
      signing = false;
      return event;
    });
    Object.defineProperty(window, 'nostr', {
      configurable: true,
      value: { getPublicKey: vi.fn().mockResolvedValue(pkHex), signEvent },
    });
    const bridge = await getBridge();
    await bridge.loginWithNip07(pkHex);

    await bridge.joinGroup('nip07-group');
    await bridge.sendMessage('nip07-group', 'signed by extension');
    await flush();

    expect(signEvent.mock.calls.map(([template]) => template.kind)).toEqual([9021, 9]);
    expect(signEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 9,
      content: 'signed by extension',
      tags: [['h', 'nip07-group']],
    }));
    expect(fake.state.published.some((event) => event.kind === 9)).toBe(true);
  });

  it('treats an already-member join rejection as success', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    fake.state.nextOutcomes.push({ reject: 'duplicate: User is already a member' });

    await expect(bridge.joinGroup('existing-member-group')).resolves.toBeUndefined();
  });

  it('inserts a pending placeholder synchronously, then replaces it with the real event on publish-ack', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'optimistic-group-1';
    const snapshots: { id: string; content: string; pending?: boolean; failed?: boolean; clientTag?: string }[][] = [];
    bridge.subscribeMessages(groupId, (msgs) =>
      snapshots.push(msgs.map((m) => ({
        id: m.id,
        content: m.content,
        pending: m.pending,
        failed: m.failed,
        clientTag: m.clientTag,
      }))),
    );

    // Resolves immediately after the placeholder lands in the store; the
    // publish itself runs in the background.
    await bridge.sendMessage(groupId, 'hello world');

    // First non-empty snapshot must show the pending placeholder.
    const pendingSnap = snapshots.find((s) => s.length > 0);
    expect(pendingSnap).toBeDefined();
    expect(pendingSnap![0].pending).toBe(true);
    expect(pendingSnap![0].content).toBe('hello world');
    expect(pendingSnap![0].id.startsWith('pending:')).toBe(true);
    expect(pendingSnap![0].clientTag).toBeDefined();

    // After the publish round-trips, the placeholder is replaced in place.
    await flush();
    const lastSnap = snapshots.at(-1)!;
    expect(lastSnap).toHaveLength(1);
    expect(lastSnap[0].pending).toBeFalsy();
    expect(lastSnap[0].failed).toBeFalsy();
    expect(lastSnap[0].id.startsWith('pending:')).toBe(false);
    expect(lastSnap[0].content).toBe('hello world');
    // Exactly one publish (no duplicate from the placeholder + relay echo).
    expect(fake.state.published.filter((e) => e.kind === 9)).toHaveLength(1);
  });

  it('flips the placeholder to failed when the publish rejects, then retry republishes the same content', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'optimistic-group-2';
    type Snap = { id: string; content: string; pending?: boolean; failed?: boolean; clientTag?: string };
    const snaps: Snap[][] = [];
    let last: Snap[] = [];
    bridge.subscribeMessages(groupId, (msgs) => {
      const next = msgs.map((m) => ({
        id: m.id,
        content: m.content,
        pending: m.pending,
        failed: m.failed,
        clientTag: m.clientTag,
      }));
      snaps.push(next);
      last = next;
    });

    fake.state.nextOutcomes.push({ reject: 'restricted: not whitelisted' });
    await bridge.sendMessage(groupId, 'will fail');
    await flush();

    expect(last).toHaveLength(1);
    expect(last[0].failed).toBe(true);
    expect(last[0].pending).toBeFalsy();
    expect(last[0].content).toBe('will fail');
    const tag = last[0].clientTag;
    expect(tag).toBeDefined();
    // Failed publish is NOT in the published list (FakePool rejects without
    // pushing).
    expect(fake.state.published.filter((e) => e.kind === 9)).toHaveLength(0);

    // Retry — this time let it succeed. The "back to pending" state is
    // observable in the snapshot history (not necessarily the final
    // `last`), because the publish ack microtask fires before the test's
    // own `await` continuation runs.
    const snapsBefore = snaps.length;
    await bridge.retryMessage(groupId, tag!);
    await flush();

    const snapsAfter = snaps.slice(snapsBefore);
    expect(snapsAfter[0]?.[0]?.pending).toBe(true);
    expect(snapsAfter[0]?.[0]?.failed).toBeFalsy();

    expect(last).toHaveLength(1);
    expect(last[0].pending).toBeFalsy();
    expect(last[0].failed).toBeFalsy();
    expect(last[0].id.startsWith('pending:')).toBe(false);
    expect(last[0].content).toBe('will fail');
    expect(fake.state.published.filter((e) => e.kind === 9)).toHaveLength(1);
  });

  it('cancelPendingMessage drops a failed placeholder from the store', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'optimistic-group-3';
    let last: ReadonlyArray<{ failed?: boolean; clientTag?: string }> = [];
    bridge.subscribeMessages(groupId, (msgs) => {
      last = msgs.map((m) => ({ failed: m.failed, clientTag: m.clientTag }));
    });

    fake.state.nextOutcomes.push({ reject: 'nope' });
    await bridge.sendMessage(groupId, 'goodbye');
    await flush();

    expect(last).toHaveLength(1);
    expect(last[0].failed).toBe(true);
    const tag = last[0].clientTag!;

    bridge.cancelPendingMessage(groupId, tag);
    expect(last).toHaveLength(0);
  });

  it('does not duplicate the message when the relay echo arrives between insert and publish-ack', async () => {
    // The race we worry about: signAndPublish queues a microtask that
    // delivers the event to subscribers (ingestMessage) BEFORE the
    // signAndPublish promise resolves and replacePendingGroupMessage runs.
    // The fake reproduces this exactly — it queues sub.sink(event) before
    // resolving the publish promise. The test asserts no duplicate and the
    // bubble's id transitions cleanly from `pending:<tag>` to the real id.
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'optimistic-group-4';
    let last: ReadonlyArray<{ id: string; pending?: boolean }> = [];
    bridge.subscribeMessages(groupId, (msgs) => {
      last = msgs.map((m) => ({ id: m.id, pending: m.pending }));
    });

    await bridge.sendMessage(groupId, 'race me');
    await flush();
    expect(last).toHaveLength(1);
    expect(last[0].pending).toBeFalsy();
    expect(last[0].id.startsWith('pending:')).toBe(false);
  });
});

describe('optimistic direct messages', () => {
  it('inserts a pending DM placeholder, then replaces it on publish-ack', async () => {
    const { getBridge } = await import('./client');
    const me = makeKeypair();
    const peer = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(me.skHex, me.pkHex);
    const { setPreference } = await import('@/lib/preferences');
    setPreference('directMessagesEnabled', true);

    let last: Readonly<Record<string, ReadonlyArray<{ id: string; outgoing: boolean; pending?: boolean; failed?: boolean; content: string; clientTag?: string }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => {
      const out: Record<string, ReadonlyArray<{ id: string; outgoing: boolean; pending?: boolean; failed?: boolean; content: string; clientTag?: string }>> = {};
      for (const [k, v] of Object.entries(byPeer)) {
        out[k] = v.map((m) => ({
          id: m.id,
          outgoing: m.outgoing,
          pending: m.pending,
          failed: m.failed,
          content: m.content,
          clientTag: m.clientTag,
        }));
      }
      last = out;
    });

    await bridge.sendDirectMessage(peer.pkHex, 'hi peer');

    // Pending placeholder shows up immediately under the peer's bucket.
    expect(last[peer.pkHex]?.[0]?.pending).toBe(true);
    expect(last[peer.pkHex]?.[0]?.content).toBe('hi peer');
    expect(last[peer.pkHex]?.[0]?.id.startsWith('pending:')).toBe(true);

    await flush();
    const final = last[peer.pkHex] ?? [];
    expect(final).toHaveLength(1);
    expect(final[0].pending).toBeFalsy();
    expect(final[0].failed).toBeFalsy();
    expect(final[0].content).toBe('hi peer');
    expect(final[0].id.startsWith('pending:')).toBe(false);
    // NIP-17 is the default protocol: two gift wraps (kind 1059) published —
    // the recipient's and the sender-addressed self-copy that keeps our own
    // outgoing history alive across a reload — both fully opaque on the wire
    // (no kind-4 fallback). See `dm-nip17.test.ts` for the full contract.
    // The self-copy resolves our own inbox relays first, so it lands a few
    // relay round trips after the message itself settles.
    await waitForWraps(2);
    const wraps = fake.state.published.filter((e) => e.kind === 1059);
    expect(wraps).toHaveLength(2);
    for (const w of wraps) expect(w.content).not.toContain('hi peer');
    expect(fake.state.published.filter((e) => e.kind === 4)).toHaveLength(0);
    // The self-copy comes straight back through our own kind-1059
    // subscription; it must not render as a second message.
    expect(last[peer.pkHex]).toHaveLength(1);
  });

  it('marks a DM as failed on publish reject and retryDirectMessage republishes', async () => {
    const { getBridge } = await import('./client');
    const me = makeKeypair();
    const peer = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(me.skHex, me.pkHex);
    const { setPreference } = await import('@/lib/preferences');
    setPreference('directMessagesEnabled', true);

    let last: Readonly<Record<string, ReadonlyArray<{ pending?: boolean; failed?: boolean; clientTag?: string }>>> = {};
    bridge.subscribeDirectMessages((byPeer) => {
      const out: Record<string, ReadonlyArray<{ pending?: boolean; failed?: boolean; clientTag?: string }>> = {};
      for (const [k, v] of Object.entries(byPeer)) {
        out[k] = v.map((m) => ({ pending: m.pending, failed: m.failed, clientTag: m.clientTag }));
      }
      last = out;
    });

    // Deliberately NOT an `auth-required` rejection: a gift wrap refused for
    // want of NIP-42 now escalates to one authenticated retry rather than
    // failing the send (see `publishSignedEvent`'s `authMode: 'last-resort'`,
    // covered in `dm-nip17.test.ts`). A flat refusal is the case that must
    // still surface as a failed message the user can retry by hand.
    fake.state.nextOutcomes.push({ reject: 'blocked: relay is not accepting events right now' });
    await bridge.sendDirectMessage(peer.pkHex, 'will fail');
    await flush();

    const failedList = last[peer.pkHex] ?? [];
    expect(failedList).toHaveLength(1);
    expect(failedList[0].failed).toBe(true);
    const tag = failedList[0].clientTag!;
    expect(fake.state.published.filter((e) => e.kind === 1059)).toHaveLength(0);

    await bridge.retryDirectMessage(peer.pkHex, tag);
    await flush();
    const retriedList = last[peer.pkHex] ?? [];
    expect(retriedList).toHaveLength(1);
    expect(retriedList[0].pending).toBeFalsy();
    expect(retriedList[0].failed).toBeFalsy();
    // NIP-17 is the default protocol: retry re-publishes as a gift wrap,
    // plus the sender-addressed self-copy.
    await waitForWraps(2);
    expect(fake.state.published.filter((e) => e.kind === 1059)).toHaveLength(2);
  });
});
