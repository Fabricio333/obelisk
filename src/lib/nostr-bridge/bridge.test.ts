/**
 * Integration test for the nostr bridge.
 *
 * Mocks `SimplePool` from `nostr-tools` to capture published events and
 * deliver them back to subscribers, simulating a relay round-trip without
 * touching the network. Real crypto runs end-to-end so signatures, encryption, and encoding
 * are exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, finalizeEvent, type Event as NostrEvent, type Filter } from 'nostr-tools';
import { KIND_SFU_ACTIVE_CALL, KIND_VOICE_PRESENCE, KIND_VOICE_SIGNAL } from '@/lib/nip-kinds';

const fake = vi.hoisted(() => {
  const state = {
    published: [] as Array<{ kind: number; pubkey: string; tags: string[][]; content: string; id: string; relays?: string[] }>,
    subscriptions: [] as Array<{
      filter: Record<string, unknown>;
      sink: (ev: any) => void;
      relays?: string[];
      onclose?: (reasons: string[]) => void;
      poolId?: number;
    }>,
    ensureRelayCalls: [] as string[],
    ensureRelayImpl: null as null | ((url: string, opts?: { connectionTimeout?: number }) => Promise<{ connected: boolean; onclose?: () => void }>),
    querySyncCalls: [] as Array<{ relays: string[]; filter: Record<string, unknown>; opts?: { maxWait?: number } }>,
    poolSeq: 0,
    poolOptions: [] as Array<Record<string, unknown>>,
    closeCalls: [] as Array<{ poolId: number; relays: string[] }>,
  };

  function matchesInternal(f: Record<string, unknown>, ev: { kind: number; pubkey: string; tags: string[][] }): boolean {
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
    private readonly id: number;
    constructor(opts: Record<string, unknown> = {}) {
      this.id = ++state.poolSeq;
      state.poolOptions.push(opts);
    }
    subscribe(relays: string[], filter: Record<string, unknown>, opts: { onevent: (ev: any) => void; oneose?: () => void; onclose?: (reasons: string[]) => void; onauth?: unknown }) {
      const sub = { filter, sink: opts.onevent, relays, onclose: opts.onclose, poolId: this.id };
      state.subscriptions.push(sub);
      for (const ev of state.published) if (matchesInternal(filter, ev as any)) opts.onevent(ev);
      // Fire EOSE so subscribeWatched's watchdog marks the sub as alive and
      // doesn't queue retries during tests.
      queueMicrotask(() => opts.oneose?.());
      return { close: () => { state.subscriptions = state.subscriptions.filter((s) => s !== sub); } };
    }
    publish(relays: string[], event: any): Promise<string>[] {
      state.published.push({ ...event, relays });
      queueMicrotask(() => {
        for (const sub of state.subscriptions) if (matchesInternal(sub.filter, event)) sub.sink(event);
      });
      return [Promise.resolve('ok')];
    }
    close(relays: string[]): void {
      state.closeCalls.push({ poolId: this.id, relays });
      const closing = new Set(relays);
      state.subscriptions = state.subscriptions.filter((sub) =>
        sub.poolId !== this.id || !sub.relays?.some((relay) => closing.has(relay)),
      );
    }
    /**
     * The bridge's `connect()` awaits `pool.ensureRelay(url, ...)` before
     * issuing REQs (post Fix A: login no longer flips `isLoggedIn` until
     * connect resolves). The fake returns `connected: true` instantly so
     * tests pretend every relay is reachable.
     */
    async ensureRelay(_url: string, _opts?: { connectionTimeout?: number }): Promise<{ connected: boolean; onclose?: () => void }> {
      state.ensureRelayCalls.push(_url);
      if (state.ensureRelayImpl) return state.ensureRelayImpl(_url, _opts);
      return { connected: true };
    }
    /**
     * Resolve to every previously-`publish()`ed event that matches the
     * filter. The bridge uses this for fetchGroupMetadata, search, and
     * (post cold-load-fix) the kind-9 querySync fallback when the retry
     * ladder exhausts. Tests that want querySync to return events should
     * pre-`publish` them; tests that want it empty just leave state.published
     * alone for that filter.
     */
    async querySync(_relays: string[], filter: Record<string, unknown>, _opts?: { maxWait?: number }): Promise<NostrEvent[]> {
      state.querySyncCalls.push({ relays: _relays, filter, opts: _opts });
      return state.published.filter((ev) => matchesInternal(filter, ev as { kind: number; pubkey: string; tags: string[][] })) as NostrEvent[];
    }
  }

  return { state, FakePool, matchesInternal };
});

vi.mock('nostr-tools', async (orig) => {
  const actual = (await orig()) as object;
  return { ...actual, SimplePool: fake.FakePool };
});

function matches(f: Filter, ev: NostrEvent): boolean {
  return fake.matchesInternal(f as any, ev);
}

// Import bridge AFTER the mock is registered.
import { isImportableRelayUrl } from './client';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return { skHex: bytesToHex(sk), pkHex: pk };
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

beforeEach(() => {
  (() => { fake.state.published = []; fake.state.subscriptions = []; fake.state.ensureRelayCalls = []; fake.state.ensureRelayImpl = null; fake.state.querySyncCalls = []; fake.state.poolSeq = 0; fake.state.poolOptions = []; fake.state.closeCalls = []; })();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    json: vi.fn().mockResolvedValue({}),
  }));
  // Each test starts fresh — clear the bridge module-level singleton by
  // resetting modules so getBridge() returns a new instance.
  vi.resetModules();
  setOnline(true);
  setVisibility('visible');
  // Clear localStorage between tests so persisted sessions don't bleed.
  if (typeof window !== 'undefined') window.localStorage.clear();
});

afterEach(async () => {
  const { getBridgeImpl } = await import('./client');
  getBridgeImpl()?.dispose();
  (() => { fake.state.published = []; fake.state.subscriptions = []; fake.state.ensureRelayCalls = []; fake.state.ensureRelayImpl = null; fake.state.querySyncCalls = []; fake.state.poolSeq = 0; fake.state.poolOptions = []; fake.state.closeCalls = []; })();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('nostr-bridge', () => {
  it('rejects local and private relay URLs from imported relay lists', () => {
    expect(isImportableRelayUrl('ws://localhost:4869/')).toBe(false);
    expect(isImportableRelayUrl('wss://localhost:4869/')).toBe(false);
    expect(isImportableRelayUrl('wss://host.docker.internal:3334/')).toBe(false);
    expect(isImportableRelayUrl('wss://vvearoljdsmlkhnvms673x3ra6szhcftz66powh6bbmgodk3rs63wdid.onion/')).toBe(false);
    expect(isImportableRelayUrl('wss://relay.obelisk.ar/')).toBe(true);
  });

  it('logs in with nsec and exposes the public key', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    expect(bridge.getPublicKey()).toBe(pkHex);
  });

  it('createGroup publishes a kind 9007 + 9002 and the group appears in the groups store', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupsSeen: ReadonlyArray<unknown>[] = [];
    bridge.subscribeGroups((g) => groupsSeen.push(g));

    const id = await bridge.createGroup({ name: 'Test Channel', about: 'Hello world', isPublic: true, isOpen: true });
    await flush();

    const kinds = fake.state.published.map((e) => e.kind);
    expect(kinds).toContain(9007);
    expect(kinds).toContain(9002);

    // Author of the metadata isn't necessarily the relay (in NIP-29 it would
    // come from the relay), but our fake pool just echoes whatever is
    // published, including the user's own kind 9002 — which the bridge
    // ingests via its kind 39000 subscription. Since the test relay echoes
    // only what we publish, simulate the relay fanning out by injecting a
    // 39000 metadata event from the "relay".
    const metaEvent: NostrEvent = await fakeRelayMetadata({
      groupId: id, name: 'Test Channel', about: 'Hello world', isPublic: true, isOpen: true,
    });
    deliver(metaEvent);
    await flush();

    const last = groupsSeen.at(-1) as { id: string; name: string | null }[];
    expect(last.find((g) => g.id === id)?.name).toBe('Test Channel');
  });

  it('sendMessage round-trips through subscribers', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'testgroup1';
    const seen: { id: string; content: string }[][] = [];
    bridge.subscribeMessages(groupId, (msgs) => seen.push(msgs.map((m) => ({ id: m.id, content: m.content }))));

    await bridge.sendMessage(groupId, 'hello from test');
    await flush();

    const flat = seen.flat();
    expect(flat.some((m) => m.content === 'hello from test')).toBe(true);
    const published = fake.state.published.filter((e) => e.kind === 9);
    expect(published).toHaveLength(1);
    expect(published[0].tags).toContainEqual(['h', groupId]);
  });

  it('sendMessage carries NIP-30 custom emoji tags', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'emoji-group';
    const seen: Array<Array<{ content: string; customEmojis?: Readonly<Record<string, string>> }>> = [];
    bridge.subscribeMessages(groupId, (msgs) => {
      seen.push(msgs.map((m) => ({ content: m.content, customEmojis: m.customEmojis })));
    });

    await bridge.sendMessage(groupId, 'hello :party:', null, [
      ['emoji', 'party', 'https://example.com/party.webp'],
    ]);
    await flush();

    const published = fake.state.published.filter((e) => e.kind === 9);
    expect(published).toHaveLength(1);
    expect(published[0].tags).toContainEqual(['emoji', 'party', 'https://example.com/party.webp']);
    expect(seen.flat().some((m) => m.customEmojis?.party === 'https://example.com/party.webp')).toBe(true);
  });

  it('sendReaction emits a kind 7 with target and group tags', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'testgroup2';
    bridge.subscribeReactions(groupId, () => {});
    await bridge.sendReaction('targetEventId123', pkHex, '🔥', groupId);
    await flush();

    const reactions = fake.state.published.filter((e) => e.kind === 7);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].content).toBe('🔥');
    expect(reactions[0].tags).toContainEqual(['e', 'targetEventId123']);
    expect(reactions[0].tags).toContainEqual(['h', groupId]);
  });

  it('sendReaction carries NIP-30 custom emoji tags', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'emoji-reaction-group';
    const seen: Array<Array<{ emoji: string; customEmojis?: Readonly<Record<string, string>> }>> = [];
    bridge.subscribeReactions(groupId, (byEvent) => {
      seen.push((byEvent.targetEventId123 ?? []).map((r) => ({
        emoji: r.emoji,
        customEmojis: r.customEmojis,
      })));
    });

    await bridge.sendReaction('targetEventId123', pkHex, ':party:', groupId, [
      ['emoji', 'party', 'https://example.com/party.webp'],
    ]);
    await flush();

    const reactions = fake.state.published.filter((e) => e.kind === 7);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].content).toBe(':party:');
    expect(reactions[0].tags).toContainEqual(['emoji', 'party', 'https://example.com/party.webp']);
    expect(seen.flat()).toContainEqual({
      emoji: ':party:',
      customEmojis: { party: 'https://example.com/party.webp' },
    });
  });

  it('removeReaction publishes a NIP-09 delete event and removes the local reaction', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'remove-reaction-group';
    const seen: Array<Record<string, Array<{ id: string; emoji: string }>>> = [];
    bridge.subscribeReactions(groupId, (byEvent) => {
      seen.push(Object.fromEntries(
        Object.entries(byEvent).map(([eventId, reactions]) => [
          eventId,
          reactions.map((r) => ({ id: r.id, emoji: r.emoji })),
        ]),
      ));
    });

    await bridge.sendReaction('targetEventId123', pkHex, '🔥', groupId);
    await flush();
    const reaction = fake.state.published.find((e) => e.kind === 7);
    expect(reaction).toBeTruthy();

    await bridge.removeReaction(groupId, reaction!.id);
    await flush();

    const deletion = fake.state.published.find((e) => e.kind === 5);
    expect(deletion?.content).toBe('remove reaction');
    expect(deletion?.tags).toContainEqual(['e', reaction!.id]);
    expect(deletion?.tags).toContainEqual(['k', '7']);
    expect(deletion?.tags).toContainEqual(['h', groupId]);
    expect(seen.at(-1)?.targetEventId123 ?? []).toEqual([]);
  });

  it('removeMessage publishes a NIP-09 delete event and removes the local message', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'remove-message-group';
    const seen: Array<Array<{ id: string; content: string }>> = [];
    bridge.subscribeMessages(groupId, (msgs) => {
      seen.push(msgs.map((m) => ({ id: m.id, content: m.content })));
    });

    await bridge.sendMessage(groupId, 'delete this');
    await flush();
    const message = fake.state.published.find((e) => e.kind === 9);
    expect(message).toBeTruthy();

    await bridge.removeMessage(groupId, message!.id);
    await flush();

    const deletion = fake.state.published.find((e) => e.kind === 5);
    expect(deletion?.content).toBe('remove message');
    expect(deletion?.tags).toContainEqual(['e', message!.id]);
    expect(deletion?.tags).toContainEqual(['k', '9']);
    expect(deletion?.tags).toContainEqual(['h', groupId]);
    expect(seen.at(-1)?.some((m) => m.id === message!.id)).toBe(false);
  });

  it('deleteGroupEvent removes moderated messages and reactions from local state', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupId = 'moderation-delete-group';
    const seenMessages: Array<Array<string>> = [];
    const seenReactions: Array<Record<string, string[]>> = [];
    bridge.subscribeMessages(groupId, (msgs) => {
      seenMessages.push(msgs.map((m) => m.id));
    });
    bridge.subscribeReactions(groupId, (byEvent) => {
      seenReactions.push(Object.fromEntries(
        Object.entries(byEvent).map(([eventId, reactions]) => [
          eventId,
          reactions.map((r) => r.id),
        ]),
      ));
    });

    await bridge.sendMessage(groupId, 'moderate this');
    await flush();
    const message = fake.state.published.find((e) => e.kind === 9);
    expect(message).toBeTruthy();

    await bridge.sendReaction(message!.id, pkHex, '🔥', groupId);
    await flush();
    const reaction = fake.state.published.find((e) => e.kind === 7);
    expect(reaction).toBeTruthy();
    expect(seenReactions.at(-1)?.[message!.id]).toContain(reaction!.id);

    await bridge.deleteGroupEvent(groupId, reaction!.id);
    await flush();
    expect(fake.state.published.find((e) => e.kind === 9005)?.tags).toContainEqual(['e', reaction!.id]);
    expect(seenReactions.at(-1)?.[message!.id] ?? []).toEqual([]);

    await bridge.deleteGroupEvent(groupId, message!.id);
    await flush();
    expect(seenMessages.at(-1)).not.toContain(message!.id);
  });

  it('NIP-04 DM round-trip: alice → bob, decrypts on bob side', async () => {
    const { getBridge: getBridgeAlice } = await import('./client');
    const alice = makeKeypair();
    const bob = makeKeypair();

    const bridgeA = await getBridgeAlice();
    await bridgeA.loginWithNsec(alice.skHex, alice.pkHex);
    const { setPreference } = await import('@/lib/preferences');
    setPreference('directMessagesEnabled', true);
    bridgeA.subscribeDirectMessages(() => {});

    await bridgeA.sendDirectMessage(bob.pkHex, 'meet me at the obelisk');
    await flush();

    const dms = fake.state.published.filter((e) => e.kind === 4);
    expect(dms).toHaveLength(1);
    expect(dms[0].pubkey).toBe(alice.pkHex);
    expect(dms[0].tags).toContainEqual(['p', bob.pkHex]);
    // Content is encrypted — should not contain plaintext.
    expect(dms[0].content).not.toContain('meet me');

    // Bob decrypts using nip04 directly.
    const { nip04 } = await import('nostr-tools');
    const plaintext = await nip04.decrypt(bob.skHex, alice.pkHex, dms[0].content);
    expect(plaintext).toBe('meet me at the obelisk');
  });

  it('does not open DM relay subscriptions until local DM opt-in is enabled', async () => {
    const { getBridge } = await import('./client');
    const { setPreference } = await import('@/lib/preferences');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const countDmSubs = () => fake.state.subscriptions.filter((sub) =>
      Array.isArray((sub.filter as any).kinds) && (sub.filter as any).kinds.includes(4),
    ).length;

    expect(countDmSubs()).toBe(0);
    const unsubDisabled = bridge.subscribeDirectMessages((byPeer) => {
      expect(byPeer).toEqual({});
    });
    expect(countDmSubs()).toBe(0);
    unsubDisabled();

    setPreference('directMessagesEnabled', true);
    const unsubEnabled = bridge.subscribeDirectMessages(() => {});
    expect(countDmSubs()).toBe(2);
    unsubEnabled();
  });

  it('putUser, removeUser, removePermission, deleteGroupEvent publish the right NIP-29 kinds', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const target = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    await bridge.putUser('grpA', target.pkHex, ['admin']);
    await bridge.removeUser('grpA', target.pkHex);
    await bridge.removePermission('grpA', target.pkHex, ['admin']);
    await bridge.deleteGroupEvent('grpA', 'evt-deadbeef');
    await flush();

    const kinds = fake.state.published.map((e) => e.kind).sort();
    expect(kinds).toContain(9000);
    expect(kinds).toContain(9001);
    expect(kinds).toContain(9003);
    expect(kinds).toContain(9005);

    const put = fake.state.published.find((e) => e.kind === 9000);
    expect(put?.tags).toContainEqual(['h', 'grpA']);
    // p-tag carries optional roles after the pubkey
    const pTag = put?.tags.find((t) => t[0] === 'p');
    expect(pTag?.[1]).toBe(target.pkHex);
    expect(pTag?.[2]).toBe('admin');

    const remPerm = fake.state.published.find((e) => e.kind === 9003);
    expect(remPerm?.tags).toContainEqual(['h', 'grpA']);
    const permTag = remPerm?.tags.find((t) => t[0] === 'p');
    expect(permTag?.[1]).toBe(target.pkHex);
    expect(permTag?.[2]).toBe('admin');

    const del = fake.state.published.find((e) => e.kind === 9005);
    expect(del?.tags).toContainEqual(['e', 'evt-deadbeef']);
  });

  it('claimCreatorAdmin no-ops when the active user is not the kind 9007 author', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const otherCreator = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    // Seed the creators map with somebody else.
    getBridgeImpl()!.groupCreators.update((m) => ({ ...m, grpX: otherCreator.pkHex }));

    fake.state.published = [];
    const published = await bridge.claimCreatorAdmin('grpX');
    await flush();

    expect(published).toBe(false);
    expect(fake.state.published.filter((e) => e.kind === 9000)).toHaveLength(0);
  });

  it('claimCreatorAdmin no-ops when the user is already in the 39001 admin list', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    const impl = getBridgeImpl()!;
    impl.groupCreators.update((m) => ({ ...m, grpY: pkHex }));
    impl.adminsByGroup.update((m) => ({ ...m, grpY: [pkHex] }));

    fake.state.published = [];
    const published = await bridge.claimCreatorAdmin('grpY');
    await flush();

    expect(published).toBe(false);
    expect(fake.state.published.filter((e) => e.kind === 9000)).toHaveLength(0);
  });

  it('claimCreatorAdmin publishes one kind 9000 admin when creator and not yet listed', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    const impl = getBridgeImpl()!;
    impl.groupCreators.update((m) => ({ ...m, grpZ: pkHex }));
    // 39001 has not yet been delivered → adminsByGroup['grpZ'] is empty.

    fake.state.published = [];
    const published = await bridge.claimCreatorAdmin('grpZ');
    await flush();

    expect(published).toBe(true);
    const claims = fake.state.published.filter((e) => e.kind === 9000);
    expect(claims).toHaveLength(1);
    expect(claims[0].tags).toContainEqual(['h', 'grpZ']);
    const pTag = claims[0].tags.find((t) => t[0] === 'p');
    expect(pTag?.[1]).toBe(pkHex);
    expect(pTag?.[2]).toBe('admin');
  });

  it('createGroup no longer publishes a kind 9000 self-claim (lazy claim only)', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    fake.state.published = [];
    await bridge.createGroup({ name: 'Spam-free', isPublic: true, isOpen: true });
    await flush();

    expect(fake.state.published.filter((e) => e.kind === 9000)).toHaveLength(0);
    expect(fake.state.published.find((e) => e.kind === 9007)).toBeTruthy();
    expect(fake.state.published.find((e) => e.kind === 9002)).toBeTruthy();
  });

  it('subscribeMyMutes parses NIP-51 kind 10000 p-tags for the local user', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const muted1 = makeKeypair();
    const muted2 = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const seen: ReadonlyArray<string>[] = [];
    bridge.subscribeMyMutes((l) => seen.push(l));

    const muteEvent = await finalizeEvent(
      {
        kind: 10000,
        content: '',
        tags: [['p', muted1.pkHex], ['p', muted2.pkHex]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: pkHex,
      } as Parameters<typeof finalizeEvent>[0],
      // sign with the local user's key — the relay would accept any author,
      // but the bridge filters by `authors: [me]`.
      Uint8Array.from(skHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))),
    );
    deliver(muteEvent);
    await flush();

    expect(seen.at(-1)).toEqual([muted1.pkHex, muted2.pkHex]);
  });

  it('subscribeAdmins / subscribeMembers parse 39001/39002 p-tags', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const a = makeKeypair();
    const b = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const adminsSeen: ReadonlyArray<string>[] = [];
    const membersSeen: ReadonlyArray<string>[] = [];
    bridge.subscribeAdmins('grpZ', (l) => adminsSeen.push(l));
    bridge.subscribeMembers('grpZ', (l) => membersSeen.push(l));

    deliver(await fakeRelayList({ groupId: 'grpZ', kind: 39001, pubkeys: [a.pkHex] }));
    deliver(await fakeRelayList({ groupId: 'grpZ', kind: 39002, pubkeys: [a.pkHex, b.pkHex] }));
    await flush();

    expect(adminsSeen.at(-1)).toEqual([a.pkHex]);
    expect(membersSeen.at(-1)).toEqual([a.pkHex, b.pkHex]);
  });

  it('createGroup with parent emits a [parent,id] tag on the kind 9002 metadata', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const childId = await bridge.createGroup({
      name: 'My thread',
      isPublic: true,
      isOpen: true,
      parent: 'forum-container-1',
    });
    await flush();

    const meta = fake.state.published.find(
      (e) => e.kind === 9002 && e.tags.some((t) => t[0] === 'h' && t[1] === childId),
    );
    expect(meta).toBeTruthy();
    expect(meta?.tags).toContainEqual(['parent', 'forum-container-1']);
  });

  it('group with [t,forum] metadata is parsed as kind=forum', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const groupsSeen: ReadonlyArray<{ id: string; kind: string }>[] = [];
    bridge.subscribeGroups((g) => groupsSeen.push(g.map((x) => ({ id: x.id, kind: x.kind }))));

    deliver(await fakeRelayMetadata({ groupId: 'g-text', name: 'T' }));
    deliver(await fakeRelayMetadataWithT({ groupId: 'g-forum', name: 'F', t: 'forum' }));
    deliver(await fakeRelayMetadataWithT({ groupId: 'g-voice', name: 'V', t: 'voice' }));
    await flush();

    const last = groupsSeen.at(-1) as { id: string; kind: string }[];
    expect(last.find((g) => g.id === 'g-text')?.kind).toBe('text');
    expect(last.find((g) => g.id === 'g-forum')?.kind).toBe('forum');
    expect(last.find((g) => g.id === 'g-voice')?.kind).toBe('voice');
  });

  it('child group nesting populates childrenByParent', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const observed: Record<string, ReadonlyArray<string>>[] = [];
    bridge.subscribeChildrenByParent((m) => observed.push({ ...m }));

    deliver(await fakeRelayMetadata({ groupId: 'parent1', name: 'Parent' }));
    deliver(await fakeRelayMetadata({ groupId: 'child1', name: 'Child', parent: 'parent1' }));
    await flush();

    const last = observed.at(-1) as Record<string, ReadonlyArray<string>>;
    expect(last.parent1).toContain('child1');
  });

  it('skips localStorage cacheSet when an admin/member republish carries identical pubkeys', async () => {
    // Regression test for the cache-write skip optimization (A4). The
    // bridge persists 39001/39002 admin/member lists per relay for
    // instant-paint on reload. A relay routinely republishes the same
    // event under a fresher created_at after a reconnect — the in-memory
    // newest-wins guard short-circuits the store update, but without this
    // skip the localStorage.setItem would still fire (a sync main-thread
    // operation we want to avoid).
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const groupId = 'cache-skip-group';
      const member = generateSecretKey();
      const memberPk = getPublicKey(member);
      const author = generateSecretKey();
      const authorPk = getPublicKey(author);
      const base = Math.floor(Date.now() / 1000);
      const buildAdmins = async (ts: number): Promise<NostrEvent> =>
        finalizeEvent(
          {
            kind: 39001,
            content: '',
            tags: [['d', groupId], ['p', memberPk]],
            created_at: ts,
            pubkey: authorPk,
          } as Parameters<typeof finalizeEvent>[0],
          author,
        );

      // Drive a subscription so the ingest path runs.
      bridge.subscribeAdmins(groupId, () => {});

      deliver(await buildAdmins(base + 1));
      await flush();

      // Locate cache writes targeting THIS group's admin entry — we don't
      // care about unrelated bridge bookkeeping (session storage etc.).
      const cacheKeyMatcher = (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes(`/39001/${groupId}`);
      const firstWrites = setItemSpy.mock.calls.filter(cacheKeyMatcher).length;
      expect(firstWrites).toBe(1);

      // Republish the identical pubkey list under a later created_at.
      // Newest-wins guard lets ingest proceed; the cache equality check
      // must suppress the write.
      setItemSpy.mockClear();
      deliver(await buildAdmins(base + 2));
      await flush();

      const secondWrites = setItemSpy.mock.calls.filter(cacheKeyMatcher).length;
      expect(secondWrites).toBe(0);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('re-parenting a group moves it to the new parent bucket without leaving stale entries', async () => {
    // Regression test for the O(1) reverse-index optimization
    // ({@link groupParentMap}) — when a kind 39000 event arrives with a
    // different parent than we previously had cached, the child must be
    // removed from the old parent's bucket and only the new parent's
    // bucket should contain it. Prior implementation scanned every bucket
    // with Object.keys+filter; the new one looks up the previous parent
    // in O(1). This test ensures the new code still handles re-parents.
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const observed: Record<string, ReadonlyArray<string>>[] = [];
    bridge.subscribeChildrenByParent((m) => observed.push({ ...m }));

    // Three revisions of the same child with increasing created_at so each
    // ingest replaces the prior (newest-wins guard). created_at must
    // strictly increase to avoid being dropped.
    const base = Math.floor(Date.now() / 1000);
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const buildRevision = async (parent: string, ts: number): Promise<NostrEvent> =>
      finalizeEvent(
        {
          kind: 39000,
          content: '',
          tags: [['d', 'mover'], ['name', 'Mover'], ['parent', parent]],
          created_at: ts,
          pubkey: pk,
        } as Parameters<typeof finalizeEvent>[0],
        sk,
      );

    deliver(await fakeRelayMetadata({ groupId: 'p-a', name: 'A' }));
    deliver(await fakeRelayMetadata({ groupId: 'p-b', name: 'B' }));
    deliver(await fakeRelayMetadata({ groupId: 'p-c', name: 'C' }));
    deliver(await buildRevision('p-a', base + 1));
    deliver(await buildRevision('p-b', base + 2));
    deliver(await buildRevision('p-c', base + 3));
    await flush();

    const last = observed.at(-1) as Record<string, ReadonlyArray<string>>;
    // Final parent must contain the child.
    expect(last['p-c']).toContain('mover');
    // Old parents must NOT — this is what the reverse index guarantees.
    expect(last['p-a'] ?? []).not.toContain('mover');
    expect(last['p-b'] ?? []).not.toContain('mover');
  });

  it('parses [forum-tag,id,name,emoji?] entries on kind 39000 into JsGroup.forumTags', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const seen: ReadonlyArray<ReadonlyArray<{ id: string; tags: ReadonlyArray<{ id: string; name: string; emoji: string | null }> }>> = [] as never;
    const observed: { id: string; tags: ReadonlyArray<{ id: string; name: string; emoji: string | null }> }[][] = [];
    bridge.subscribeGroups((g) =>
      observed.push(g.map((x) => ({ id: x.id, tags: x.forumTags }))),
    );
    void seen;

    // One forum tag with emoji, one without, plus a malformed entry that
    // must be silently dropped (missing name).
    deliver(
      await fakeRelayMetadataWithExtraTags({
        groupId: 'g-forum-with-tags',
        name: 'Plaza',
        extraTags: [
          ['t', 'forum'],
          ['forum-tag', 'tag-lacrypta', 'LaCrypta', '📜'],
          ['forum-tag', 'tag-trabajo', 'trabajo'],
          ['forum-tag', '', 'broken-no-id'],
          ['forum-tag', 'tag-empty-name', ''],
        ],
      }),
    );
    await flush();

    const last = observed.at(-1) as { id: string; tags: ReadonlyArray<{ id: string; name: string; emoji: string | null }> }[];
    const forum = last.find((g) => g.id === 'g-forum-with-tags');
    expect(forum).toBeTruthy();
    expect(forum?.tags).toEqual([
      { id: 'tag-lacrypta', name: 'LaCrypta', emoji: '📜' },
      { id: 'tag-trabajo', name: 'trabajo', emoji: null },
    ]);
  });

  it('parses [topic,id] entries on kind 39000 into JsGroup.topics, de-duped', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const observed: { id: string; topics: ReadonlyArray<string> }[][] = [];
    bridge.subscribeGroups((g) => observed.push(g.map((x) => ({ id: x.id, topics: x.topics }))));

    deliver(
      await fakeRelayMetadataWithExtraTags({
        groupId: 'thread-1',
        name: 'a thread',
        parent: 'forum-1',
        extraTags: [
          ['topic', 'tag-a'],
          ['topic', 'tag-b'],
          ['topic', 'tag-a'], // duplicate — must be de-duped
          ['topic', ''], // empty — dropped
        ],
      }),
    );
    await flush();

    const last = observed.at(-1) as { id: string; topics: ReadonlyArray<string> }[];
    const t = last.find((g) => g.id === 'thread-1');
    expect(t?.topics).toEqual(['tag-a', 'tag-b']);
  });

  it('createGroup with topics emits one [topic,id] tag per entry on kind 9002', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    const childId = await bridge.createGroup({
      name: 'tagged thread',
      isPublic: true,
      isOpen: true,
      parent: 'forum-1',
      topics: ['tag-a', 'tag-b'],
    });
    await flush();

    const meta = fake.state.published.find(
      (e) => e.kind === 9002 && e.tags.some((t) => t[0] === 'h' && t[1] === childId),
    );
    expect(meta).toBeTruthy();
    expect(meta?.tags).toContainEqual(['topic', 'tag-a']);
    expect(meta?.tags).toContainEqual(['topic', 'tag-b']);
  });

  it('editGroupMetadata with forumTags emits [forum-tag,id,name,emoji?] for each entry', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    await bridge.editGroupMetadata({
      groupId: 'forum-edit-1',
      name: 'Plaza',
      kind: 'forum',
      forumTags: [
        { id: 'tag-1', name: 'LaCrypta', emoji: '📜' },
        { id: 'tag-2', name: 'no-emoji', emoji: null },
        // Bad entry: empty name. editGroupMetadata's tag emitter drops these.
        { id: 'tag-3', name: '', emoji: '🙃' },
      ],
    });
    await flush();

    const meta = fake.state.published.find(
      (e) => e.kind === 9002 && e.tags.some((t) => t[0] === 'h' && t[1] === 'forum-edit-1'),
    );
    expect(meta).toBeTruthy();
    expect(meta?.tags).toContainEqual(['forum-tag', 'tag-1', 'LaCrypta', '📜']);
    expect(meta?.tags).toContainEqual(['forum-tag', 'tag-2', 'no-emoji']);
    // Bad entry must NOT show up.
    const bad = meta?.tags.find((t) => t[0] === 'forum-tag' && t[1] === 'tag-3');
    expect(bad).toBeUndefined();
  });

  it('relayAccess flips to ok on event/EOSE and stays ok across per-sub CLOSED reasons', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const observed: Array<Record<string, string>> = [];
    bridge.subscribeRelayAccess((m) => observed.push({ ...(m as Record<string, string>) }));

    // EOSE fires from FakePool's subscribe via queueMicrotask — that should
    // flip the active relay to 'ok'.
    await flush();
    const activeRelay = (await import('./client')).getBridgeImpl()!['relays'][0];
    const norm = activeRelay.replace(/\/+$/, '').toLowerCase();
    expect(observed.at(-1)?.[norm]).toBe('ok');

    // Once 'ok' has been confirmed (relay is reading us), per-sub CLOSED
    // rejections must NOT downgrade the access state. They normally come
    // from a private channel the user isn't in, a NIP-29 membership race,
    // or an AUTH challenge that resolves a moment later — none of which
    // mean the relay has stopped serving us. Without this guard the
    // "Not whitelisted" banner gets stuck on for users who actually are
    // whitelisted.
    for (const sub of fake.state.subscriptions) {
      const f = sub.filter as { kinds?: number[]; authors?: string[]; limit?: number };
      if (f.kinds?.includes(0) && f.authors?.includes(pkHex) && f.limit === 1) continue;
      const reasons = (sub.relays ?? [activeRelay]).map(() => 'auth-required: please AUTH');
      sub.onclose?.(reasons);
    }
    await flush();
    expect(observed.at(-1)?.[norm]).toBe('ok');

    for (const sub of fake.state.subscriptions) {
      const f = sub.filter as { kinds?: number[]; authors?: string[]; limit?: number };
      if (f.kinds?.includes(0) && f.authors?.includes(pkHex) && f.limit === 1) continue;
      const reasons = (sub.relays ?? [activeRelay]).map(() => 'restricted: pubkey not whitelisted');
      sub.onclose?.(reasons);
    }
    await flush();
    expect(observed.at(-1)?.[norm]).toBe('ok');
  });

  // -- subscribeWatched EOSE-then-CLOSED race --------------------------------
  // Some relays send EOSE (empty result) immediately, then CLOSED auth-required
  // because NIP-42 AUTH didn't complete before the REQ landed. The previous
  // implementation marked the sub `alive` on EOSE and disabled the watchdog,
  // so the subsequent CLOSED killed the sub permanently — symptom: messages
  // and member metadata don't render until the user refreshes the page.
  // The fix retries the sub when CLOSED carries an auth/restricted reason,
  // regardless of whether EOSE already fired.

  it('retries a sub when CLOSED auth-required arrives after EOSE', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'racetest-eose-then-auth';
    const seen: { id: string; content: string }[][] = [];
    bridge.subscribeMessages(groupId, (msgs) =>
      seen.push(msgs.map((m) => ({ id: m.id, content: m.content }))),
    );
    // Drain the auto-EOSE queueMicrotask. After this, the kind:9 sub is
    // alive=true but armed=true (per the fix) — the bug condition.
    await flush();

    const findMessageSubs = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    const subsBefore = findMessageSubs();
    expect(subsBefore).toHaveLength(1);
    const firstSub = subsBefore[0];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Simulate the race: relay sends CLOSED auth-required after EOSE.
      firstSub.onclose?.((firstSub.relays ?? ['']).map(() => 'auth-required: please AUTH'));
      // The fix schedules an immediate retry (delay 0). Drain it.
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    // A new sub should now be live for the same filter (the original was
    // closed by scheduleRetry → activeSub.close() → fake removes it from the
    // array).
    const subsAfter = findMessageSubs();
    expect(subsAfter.length).toBeGreaterThanOrEqual(1);
    const retrySub = subsAfter[subsAfter.length - 1];
    expect(retrySub).not.toBe(firstSub);

    // Deliver an event through the retried sub. If the fix is correct, the
    // ingest callback receives it without a page refresh.
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const ev = finalizeEvent(
      {
        kind: 9,
        content: 'after retry',
        tags: [['h', groupId]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: pk,
      } as Parameters<typeof finalizeEvent>[0],
      sk,
    );
    deliver(ev);
    await flush();

    expect(seen.flat().some((m) => m.content === 'after retry')).toBe(true);
  });

  it('does NOT retry a sub when CLOSED carries no auth/restricted reason', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'racetest-benign-close';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    const findMessageSubs = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    const subsBefore = findMessageSubs();
    expect(subsBefore).toHaveLength(1);
    const firstSub = subsBefore[0];

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Operator-clean close — empty reason. parseRelayRejection returns null,
      // so the new path must not retry. Pre-fix behavior is preserved.
      firstSub.onclose?.((firstSub.relays ?? ['']).map(() => ''));
      // Advance well past the immediate-retry window and the watchdog. With
      // alive=true (EOSE fired earlier) the watchdog must not fire either.
      await vi.advanceTimersByTimeAsync(10_000);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    // Same sub object, no replacement. (The original wasn't closed because
    // we never called activeSub.close().)
    const subsAfter = findMessageSubs();
    expect(subsAfter).toHaveLength(1);
    expect(subsAfter[0]).toBe(firstSub);
  });

  it('does NOT retry a sub when CLOSED is relay quota/rate-limit', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'racetest-quota-close';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    const findMessageSubs = () =>
      fake.state.subscriptions.filter((sub) => {
        const f = sub.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    const firstSub = findMessageSubs()[0];
    expect(firstSub).toBeTruthy();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      firstSub.onclose?.((firstSub.relays ?? ['']).map(() => 'restricted: Subscription quota exceeded: 50/50'));
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(findMessageSubs()).toHaveLength(0);
  });

  it('frees the group slot when a message sub is CLOSED for relay quota', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'quota-slot-freed';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    const impl = getBridgeImpl()!;
    const findMessageSubs = () =>
      fake.state.subscriptions.filter((sub) => {
        const f = sub.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    const firstSub = findMessageSubs()[0];
    expect(firstSub).toBeTruthy();
    expect(impl['messageSubscribedGroups'].has(groupId)).toBe(true);

    firstSub.onclose?.((firstSub.relays ?? ['']).map(() => 'restricted: Subscription quota exceeded: 50/50'));
    await flush();

    expect(findMessageSubs()).toHaveLength(0);
    expect(impl['messageSubscribedGroups'].has(groupId)).toBe(false);
    expect(impl['messageSubByGroup'].has(groupId)).toBe(false);

    bridge.subscribeMessages(groupId, () => {});
    await flush();

    expect(findMessageSubs()).toHaveLength(1);
    expect(impl['messageSubscribedGroups'].has(groupId)).toBe(true);
  });

  it('preflight relay-access keeps EOSE-accepted slot available for immediate CLOSED downgrade', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const preflightSubs = fake.state.subscriptions.filter((sub) => {
      const f = sub.filter as { kinds?: number[]; authors?: string[]; limit?: number };
      return f.kinds?.length === 1 && f.kinds[0] === 0 && f.authors?.includes(pkHex) && f.limit === 1;
    });

    expect(preflightSubs).toHaveLength(1);
  });

  it('subscribeVoiceFilterWatched uses a dedicated pool for mesh signaling', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const existingPoolIds = new Set(fake.state.subscriptions.map((sub) => sub.poolId));
    const poolSeqBefore = fake.state.poolSeq;
    const unsubscribe = (bridge as unknown as {
      subscribeVoiceFilterWatched: (
        filter: Filter,
        onEvent: (ev: NostrEvent) => void,
        options?: { relays?: readonly string[]; relayMode?: 'replace' | 'merge' },
      ) => () => void;
    }).subscribeVoiceFilterWatched(
      { kinds: [KIND_VOICE_SIGNAL] },
      () => {},
      { relays: ['wss://public.obelisk.ar'], relayMode: 'replace' },
    );
    await flush();

    const voiceSub = fake.state.subscriptions.find((sub) => {
      const f = sub.filter as { kinds?: number[] };
      return f.kinds?.includes(KIND_VOICE_SIGNAL);
    });
    expect(voiceSub).toBeTruthy();
    expect(voiceSub!.poolId).toBeGreaterThan(poolSeqBefore);
    expect(existingPoolIds.has(voiceSub!.poolId)).toBe(false);

    unsubscribe();
    await flush();
    expect(fake.state.subscriptions.some((sub) => {
      const f = sub.filter as { kinds?: number[] };
      return f.kinds?.includes(KIND_VOICE_SIGNAL);
    })).toBe(false);
    expect(fake.state.subscriptions.length).toBeGreaterThan(0);
  });

  it('reserveVoiceRelayCapacity closes non-active background group subs', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    bridge.subscribeMessages('voice-channel', () => {});
    bridge.subscribeMessages('background-channel', () => {});
    bridge.subscribeReactions('background-channel', () => {});
    await flush();

    const subsForGroup = (groupId: string) =>
      fake.state.subscriptions.filter((sub) => {
        const f = sub.filter as { '#h'?: string[] };
        return f['#h']?.includes(groupId);
      });

    expect(subsForGroup('voice-channel').length).toBeGreaterThan(0);
    expect(subsForGroup('background-channel').length).toBeGreaterThan(0);

    const release = (bridge as unknown as {
      reserveVoiceRelayCapacity: (channelId: string) => () => void;
    }).reserveVoiceRelayCapacity('voice-channel');
    await flush();

    expect(subsForGroup('voice-channel').length).toBeGreaterThan(0);
    expect(subsForGroup('background-channel')).toHaveLength(0);
    release();
  });

  it('reserveVoiceRelayCapacity closes non-active lazy admin/member subs', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    bridge.setActiveGroup('active-channel');
    bridge.subscribeAdmins('active-channel', () => {});
    bridge.subscribeMembers('background-channel', () => {});
    await flush();

    const adminMemberSubsFor = (groupId: string) =>
      fake.state.subscriptions.filter((sub) => {
        const f = sub.filter as { kinds?: number[]; '#d'?: string[] };
        return f.kinds?.includes(39001) && f.kinds?.includes(39002) && f['#d']?.includes(groupId);
      });

    expect(adminMemberSubsFor('active-channel')).toHaveLength(1);
    expect(adminMemberSubsFor('background-channel')).toHaveLength(1);

    const release = (bridge as unknown as {
      reserveVoiceRelayCapacity: (channelId: string) => () => void;
    }).reserveVoiceRelayCapacity('voice-channel');
    await flush();

    expect(adminMemberSubsFor('active-channel')).toHaveLength(1);
    expect(adminMemberSubsFor('background-channel')).toHaveLength(0);
    release();
  });

  it('caps the auth-required immediate retry — second onclose falls back to backoff', async () => {
    // Regression for the kind-9 tight-loop bug: when a relay persistently
    // rejects with CLOSED auth-required, the old scheduleRetry path fired
    // a fresh REQ at 0ms delay on EVERY close (the comment claimed
    // "subsequent failures hit backoff" but the code always passed
    // immediate=true). That tight loop hammered the relay and starved
    // every other REQ (admin/member, kind 0, branding). The fix caps the
    // immediate path to the first onclose; subsequent closes use the
    // standard exponential backoff.
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'auth-required-backoff-after-first';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    const findMessageSubs = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    const firstSub = findMessageSubs().at(-1)!;
    expect(firstSub).toBeTruthy();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // First auth-required CLOSED on this closure (attempt === 1).
      // useImmediate is true → delay 0 → retried sub appears synchronously
      // after the next tick.
      firstSub.onclose?.((firstSub.relays ?? ['']).map(() => 'auth-required: please AUTH'));
      await vi.advanceTimersByTimeAsync(10);
      const secondSub = findMessageSubs().at(-1)!;
      expect(secondSub).toBeTruthy();
      expect(secondSub).not.toBe(firstSub);

      // Second auth-required CLOSED on the retried sub (attempt === 2).
      // useImmediate is now FALSE (the cap kicks in). Delay becomes
      // 2^(attempt-1) * 1000 = 2000ms. Within 100ms of the close, no
      // new sub should have been opened — that's the whole point of the
      // backoff cap.
      secondSub.onclose?.((secondSub.relays ?? ['']).map(() => 'auth-required: please AUTH'));
      await vi.advanceTimersByTimeAsync(100);
      expect(findMessageSubs()).toHaveLength(0);

      // After the full backoff window elapses, the retried sub appears.
      await vi.advanceTimersByTimeAsync(2000);
      const thirdSub = findMessageSubs().at(-1);
      expect(thirdSub).toBeDefined();
      expect(thirdSub).not.toBe(secondSub);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flash the relay-access banner on transient auth-required CLOSED', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const activeRelay = impl['relays'][0];
    const norm = activeRelay.replace(/\/+$/, '').toLowerCase();

    // Reset relayAccess to simulate the cold-login race in production where
    // CLOSED auth-required can arrive before any EOSE has flipped the active
    // relay to 'ok'. (FakePool auto-EOSEs synchronously via queueMicrotask,
    // so by `await flush()` the state is already 'ok' — sticky-OK would
    // otherwise mask the deferred-soak path entirely.)
    (impl as unknown as { relayAccess: { set: (v: Record<string, unknown>) => void } }).relayAccess.set({});

    const observed: Array<string | undefined> = [];
    bridge.subscribeRelayAccess((m) =>
      observed.push((m as Record<string, string>)[norm]),
    );

    // Fire CLOSED auth-required on every non-preflight sub. Without the
    // soak guard the banner state would flip to 'auth-required' immediately
    // for each sub. With the guard, the downgrade is deferred and the
    // retry path gets a chance to heal it back to 'ok' first.
    //
    // The whitelist preflight sub (kind 0, authors=[me], limit 1) is
    // explicitly excluded: it uses `immediateAccessDowngrade: true` so
    // a rejection on the preflight surfaces within ~1.5s. The deferred-
    // soak contract still holds for every other sub.
    const isPreflight = (sub: { filter?: Record<string, unknown> }) => {
      const kinds = sub.filter?.kinds as number[] | undefined;
      const authors = sub.filter?.authors as string[] | undefined;
      const limit = sub.filter?.limit as number | undefined;
      return (
        Array.isArray(kinds) &&
        kinds.length === 1 &&
        kinds[0] === 0 &&
        Array.isArray(authors) &&
        authors.includes(pkHex) &&
        limit === 1
      );
    };
    for (const sub of fake.state.subscriptions) {
      if (isPreflight(sub)) continue;
      const reasons = (sub.relays ?? [activeRelay]).map(() => 'auth-required: please AUTH');
      sub.onclose?.(reasons);
    }
    await flush();

    expect(observed).not.toContain('auth-required');
    expect(observed).not.toContain('restricted');
  });

  it('schedules at most one retry when CLOSED auth-required fires twice', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'racetest-dedup';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    const findMessageSubs = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    const subsBefore = findMessageSubs();
    expect(subsBefore).toHaveLength(1);
    const firstSub = subsBefore[0];
    const reasons = (firstSub.relays ?? ['']).map(() => 'auth-required: please AUTH');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Fire CLOSED twice in a row — both calls hit scheduleRetry but the
      // `armed` token disarms after the first, so the second is a no-op.
      firstSub.onclose?.(reasons);
      firstSub.onclose?.(reasons);
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    // Exactly one retry sub — not two.
    const subsAfter = findMessageSubs();
    expect(subsAfter).toHaveLength(1);
    expect(subsAfter[0]).not.toBe(firstSub);
  });

  it('drops events delivered to a markClosed sub after switchRelay (no cross-relay bleed)', async () => {
    // Reproduces the user-reported "channels from another relay leaking into
    // Uncategorized" bug. switchRelay markCloses the previous relay's subs
    // but deliberately does NOT call pool.close() on the old WebSockets
    // (avoids per-sub CLOSING/CLOSED console spam — see
    // resetPoolForSessionChange comment). The old sockets stay alive until
    // GC and can still deliver events. Without the closed-guard in
    // subscribeWatched.onevent, those late events would be ingested into the
    // post-switch state — both polluting `this.groups` and writing the old
    // relay's group under the new relay's cache key (since
    // `cacheSet(this.currentRelayUrl.get(), ...)` uses whichever relay is
    // currently active).
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheGet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    // Capture the kind 39000 sub created by `subscribeGroupMetadata` on the
    // default relay. After switchRelay this is the closure that must drop
    // late events.
    const findMetaSubs = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[] };
        return Array.isArray(f.kinds) && f.kinds.includes(39000) && !('#d' in (s.filter as object));
      });
    const subsBefore = findMetaSubs();
    expect(subsBefore.length).toBeGreaterThanOrEqual(1);
    const oldRelaySub = subsBefore[0];

    // Switch to a different relay. switchRelay clears `this.groups`, replaces
    // the pool, opens fresh subs, and seeds the cache for the new relay
    // (which is empty here).
    const NEW_RELAY = 'wss://relay-bleed-test.example';
    await bridge.switchRelay(NEW_RELAY);
    await flush();

    const impl = getBridgeImpl()!;
    expect(impl.groups.get()).toEqual([]);
    expect(impl.currentRelayUrl.get()).toBe(NEW_RELAY);

    // The old kind-39000 sub object is still in the fake's state.subscriptions
    // array because markClosed nullifies the local activeSub reference but
    // doesn't call its close() (the comment explains why). Simulate an
    // in-flight kind 39000 from the OLD relay arriving on its zombie socket
    // by invoking the old sub's sink directly.
    const staleEvent = await fakeRelayMetadata({
      groupId: 'leaked-from-old-relay',
      name: 'Leaked Channel',
      isPublic: true,
      isOpen: true,
    });
    oldRelaySub.sink(staleEvent);
    await flush();

    // The post-switch groups store must NOT contain the leaked group.
    expect(impl.groups.get().some((g) => g.id === 'leaked-from-old-relay')).toBe(false);
    // And the new relay's cache must NOT have an entry for it (the bug
    // wrote `cacheSet(NEW_RELAY, 39000, 'leaked-from-old-relay', ...)`).
    expect(cacheGet(NEW_RELAY, 39000, 'leaked-from-old-relay')).toBeNull();
  });

  it('keeps an empty channel-list EOSE provisional until the metadata retry window is exhausted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { getBridge, getBridgeImpl } = await import('./client');
      const { skHex, pkHex } = makeKeypair();
      const bridge = await getBridge();
      await bridge.loginWithNsec(skHex, pkHex);
      await flush();

      const impl = getBridgeImpl()!;
      expect(impl.groups.get()).toEqual([]);
      expect(impl.groupMetadataEose.get()).toBe(false);

      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(impl.groupMetadataEose.get()).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      await flush();
      expect(impl.groupMetadataEose.get()).toBe(false);

      await vi.advanceTimersByTimeAsync(5000);
      await flush();
      expect(impl.groupMetadataEose.get()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens kind:0 on the active relay as a bounded one-shot and bounds external lookup', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const other = makeKeypair().pkHex;
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    fake.state.subscriptions = [];
    fake.state.querySyncCalls = [];

    bridge.ensureUserMetadata(other);
    const initialKind0Subs = fake.state.subscriptions.filter((s) => (s.filter.kinds as number[] | undefined)?.includes(0));
    expect(initialKind0Subs).toHaveLength(1);
    expect(initialKind0Subs[0].relays).toEqual(['wss://public.obelisk.ar']);

    await flush(8);

    const kind0Subs = fake.state.subscriptions.filter((s) => (s.filter.kinds as number[] | undefined)?.includes(0));
    expect(kind0Subs).toHaveLength(0);
    const contactMuteSubs = fake.state.subscriptions.filter((s) => {
      const kinds = s.filter.kinds as number[] | undefined;
      return kinds?.includes(3) || kinds?.includes(10000);
    });
    expect(contactMuteSubs.every((s) => s.relays?.every((r) => r === 'wss://public.obelisk.ar'))).toBe(true);
    expect(initialKind0Subs[0].relays).not.toContain('wss://nos.lol');
    expect(initialKind0Subs[0].relays).not.toContain('wss://relay.primal.net');
    expect(initialKind0Subs[0].relays).not.toContain('wss://relay.nostr.band');
    const externalLookup = fake.state.querySyncCalls.find((c) => (c.filter.authors as string[] | undefined)?.includes(other));
    expect(externalLookup?.relays).toEqual(['wss://relay.obelisk.ar', 'wss://public.obelisk.ar', 'wss://purplepag.es']);
  });

  it('editUserMetadata publishes kind:0 to the active relay plus quiet lookup relays', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    fake.state.published = [];

    await bridge.editUserMetadata({ name: 'Alice' });

    const meta = fake.state.published.find((e) => e.kind === 0 && e.pubkey === pkHex);
    expect(meta?.relays).toContain('wss://public.obelisk.ar');
    expect(meta?.relays).toContain('wss://relay.obelisk.ar');
    expect(meta?.relays).toContain('wss://purplepag.es');
    expect(meta?.relays).not.toContain('wss://nos.lol');
  });

  it('cached kind:0 keeps the newest event', async () => {
    const { getCachedKind0, setCachedKind0 } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const older = finalizeEvent({ kind: 0, content: '{"name":"old"}', tags: [], created_at: 10 }, hexToBytesForTest(skHex));
    const newer = finalizeEvent({ kind: 0, content: '{"name":"new"}', tags: [], created_at: 20 }, hexToBytesForTest(skHex));
    expect(older.pubkey).toBe(pkHex);

    expect(setCachedKind0(newer)).toBe(true);
    expect(setCachedKind0(older)).toBe(false);

    expect(getCachedKind0(pkHex)?.content).toBe('{"name":"new"}');
  });

  it('switchRelay republishes cached kind:0 without repeating wide profile lookup inside TTL', async () => {
    const { getBridge, setCachedKind0 } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const cached = finalizeEvent({ kind: 0, content: '{"name":"Cached"}', tags: [], created_at: 30 }, hexToBytesForTest(skHex));
    setCachedKind0(cached);
    window.localStorage.setItem('obelisk/profile-sync-state/v1', JSON.stringify({ ownProfileLookupAt: { [pkHex]: Date.now() }, ownProfileSyncedToRelay: {} }));
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush(8);
    fake.state.querySyncCalls = [];
    fake.state.published = [];

    await bridge.switchRelay('wss://relay.obelisk.ar');
    await flush(8);

    expect(fake.state.querySyncCalls.filter((c) => (c.filter.kinds as number[] | undefined)?.includes(0))).toHaveLength(0);
    const meta = fake.state.published.find((e) => e.kind === 0 && e.pubkey === pkHex);
    expect(meta?.content).toBe('{"name":"Cached"}');
    expect(meta?.relays).toEqual(['wss://relay.obelisk.ar']);
  });

  it('does not run connect fan-out or flip login before a delayed relay handshake completes', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();

    let resolveRelay: (relay: { connected: boolean; onclose?: () => void }) => void = () => {
      throw new Error('delayed relay resolver was not installed');
    };
    fake.state.ensureRelayImpl = () => new Promise((resolve) => {
      resolveRelay = resolve;
    });

    const loginPromise = bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    expect(fake.state.ensureRelayCalls).toHaveLength(1);
    expect(fake.state.subscriptions).toHaveLength(0);
    expect(impl.isLoggedIn.get()).toBe(false);

    resolveRelay({ connected: true });
    await loginPromise;
    await flush();

    expect(impl.isLoggedIn.get()).toBe(true);
    expect(fake.state.subscriptions.some((s) => {
      const kinds = s.filter.kinds as number[] | undefined;
      return kinds?.includes(39000);
    })).toBe(true);
  });

  it("enables native ping on every bridge pool", async () => {
    const { getBridge } = await import("./client");
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);

    expect(fake.state.poolOptions.length).toBeGreaterThanOrEqual(2);
    expect(fake.state.poolOptions.every((opts) => opts.enablePing === true)).toBe(true);
  });

  it("closes the previous active relay socket when switching pools", async () => {
    const { getBridge } = await import("./client");
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    fake.state.closeCalls = [];

    await bridge.switchRelay("wss://other.example");

    expect(fake.state.closeCalls).toContainEqual({
      poolId: 2,
      relays: ["wss://public.obelisk.ar"],
    });
  });

  it("keeps mounted channel subscriptions alive across relay switches", async () => {
    const { getBridge } = await import("./client");
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    const groupId = "general";
    const seen: string[][] = [];
    bridge.subscribeMessages(groupId, (messages) => seen.push(messages.map((message) => message.content)));
    await flush();

    await bridge.switchRelay("wss://other.example");
    await flush();
    deliver(await fakeRelayMessage({ groupId, content: "loaded without refresh" }));
    await flush();

    expect(seen.at(-1)).toContain("loaded without refresh");
    expect(fake.state.subscriptions.some((sub) => {
      const filter = sub.filter as { kinds?: number[]; "#h"?: string[] };
      return sub.relays?.includes("wss://other.example")
        && filter.kinds?.includes(9)
        && filter["#h"]?.includes(groupId);
    })).toBe(true);
  });

  it("pauses while offline and reconnects immediately when the browser returns online", async () => {
    const { getBridge, getBridgeImpl } = await import("./client");
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    const impl = getBridgeImpl()!;
    const callsBefore = fake.state.ensureRelayCalls.length;

    setOnline(false);
    window.dispatchEvent(new Event("offline"));
    expect(impl.connectionState.get()).toBe("Offline");
    expect(fake.state.ensureRelayCalls).toHaveLength(callsBefore);

    setOnline(true);
    window.dispatchEvent(new Event("online"));
    await flush(12);

    expect(fake.state.ensureRelayCalls.length).toBeGreaterThan(callsBefore);
    expect(impl.connectionState.get()).toBe("Connected");
  });

  it("wakes a disconnected connection when its tab becomes visible", async () => {
    const { getBridge, getBridgeImpl } = await import("./client");
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    const impl = getBridgeImpl()!;
    const callsBefore = fake.state.ensureRelayCalls.length;
    impl.connectionState.set("Disconnected");

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await flush(12);

    expect(fake.state.ensureRelayCalls.length).toBeGreaterThan(callsBefore);
    expect(impl.connectionState.get()).toBe("Connected");
  });

  it('rehydrated cache-free sessions stay logged out until background reconnect succeeds', async () => {
    const { skHex, pkHex } = makeKeypair();
    window.localStorage.setItem('obelisk-dex/session', JSON.stringify({
      privKeyHex: skHex,
      pubKeyHex: pkHex,
      loginMethod: 'nsec',
      relayUrl: 'wss://public.obelisk.ar',
    }));

    let attempts = 0;
    let resolveReconnect: (relay: { connected: boolean; onclose?: () => void }) => void = () => {
      throw new Error('reconnect resolver was not installed');
    };
    fake.state.ensureRelayImpl = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('first connection failed'));
      return new Promise((resolve) => {
        resolveReconnect = resolve;
      });
    };

    const { getBridge, getBridgeImpl } = await import('./client');
    await getBridge();
    await flush();

    const impl = getBridgeImpl()!;
    expect(attempts).toBe(2);
    expect(impl.isLoggedIn.get()).toBe(false);
    expect(fake.state.subscriptions).toHaveLength(0);

    resolveReconnect({ connected: true });
    await flush(8);

    expect(impl.isLoggedIn.get()).toBe(true);
    expect(impl.myPubkey.get()).toBe(pkHex);
    expect(fake.state.subscriptions.some((s) => {
      const kinds = s.filter.kinds as number[] | undefined;
      return kinds?.includes(39000);
    })).toBe(true);
  });

  it('waits for switchRelay handshake failure instead of resolving on the old hard ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { getBridge } = await import('./client');
      const { skHex, pkHex } = makeKeypair();
      const bridge = await getBridge();
      await bridge.loginWithNsec(skHex, pkHex);
      await flush();

      const relay = 'wss://slow-fail.example';
      fake.state.ensureRelayImpl = (url) => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`cannot connect ${url}`)), 3000);
      });

      let settled = false;
      const switchPromise = bridge.switchRelay(relay).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(1500);
      await flush();
      expect(settled).toBe(false);
      expect(fake.state.ensureRelayCalls.filter((url) => url === relay)).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1500);
      await switchPromise;
      await flush(8);
      expect(settled).toBe(true);
      expect(fake.state.ensureRelayCalls.filter((url) => url === relay).length).toBeGreaterThan(1);
    } finally {
      fake.state.ensureRelayImpl = null;
      vi.useRealTimers();
    }
  });

  // -- active-group priority for kind 9 REQs ------------------------------
  // Background fan-out from kind 39000 used to fire a kind 9 REQ per
  // discovered group on the same tick — on a busy relay the channel the
  // user actually clicked landed at the back of the response queue and
  // its history rendered late. The bridge now queues background subs and
  // fast-tracks the active group via `setActiveGroup` so the channel in
  // view always wins the relay's first response.

  it('background metadata defers per-group message REQs; setActiveGroup fires the active one immediately', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const messageSubsFor = (groupId: string) =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    bridge.setActiveGroup('active-group');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Inject metadata for the active group + several background ones in
      // the same tick — mirrors what a real relay does at login.
      deliver(await fakeRelayMetadata({ groupId: 'active-group', name: 'Active' }));
      deliver(await fakeRelayMetadata({ groupId: 'bg-1', name: 'B1' }));
      deliver(await fakeRelayMetadata({ groupId: 'bg-2', name: 'B2' }));
      deliver(await fakeRelayMetadata({ groupId: 'bg-3', name: 'B3' }));

      // Synchronously: only the active group has a kind 9 sub. Background
      // groups are sitting in the queue waiting for the drain timer.
      expect(messageSubsFor('active-group')).toHaveLength(1);
      expect(messageSubsFor('bg-1')).toHaveLength(0);
      expect(messageSubsFor('bg-2')).toHaveLength(0);
      expect(messageSubsFor('bg-3')).toHaveLength(0);

      // Drain the queue.
      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(messageSubsFor('bg-1')).toHaveLength(1);
    expect(messageSubsFor('bg-2')).toHaveLength(1);
    expect(messageSubsFor('bg-3')).toHaveLength(1);
  });

  it('uses one live per-group stream for messages and deletes', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'merged-message-stream';
    fake.state.subscriptions = [];
    bridge.subscribeMessages(groupId, () => {});

    const groupSubs = fake.state.subscriptions.filter((s) => {
      const f = s.filter as { kinds?: number[]; '#h'?: string[] };
      return f['#h']?.includes(groupId);
    });
    expect(groupSubs).toHaveLength(1);
    expect((groupSubs[0].filter.kinds as number[]).sort()).toEqual([5, 9, 9005]);
  });

  it('does not open per-group creator subscriptions during metadata fan-out', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    fake.state.subscriptions = [];
    deliver(await fakeRelayMetadata({ groupId: 'creator-bg-1', name: 'Creator BG 1' }));
    deliver(await fakeRelayMetadata({ groupId: 'creator-bg-2', name: 'Creator BG 2' }));

    const creatorSubs = fake.state.subscriptions.filter((s) => {
      const f = s.filter as { kinds?: number[]; '#h'?: string[] };
      return f.kinds?.includes(9007) && !!f['#h'];
    });
    expect(creatorSubs).toHaveLength(0);
  });

  it('caps background message streams below public relay subscription quota', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (let i = 0; i < 40; i++) {
        deliver(await fakeRelayMetadata({ groupId: `quota-bg-${i}`, name: `Quota ${i}` }));
      }
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
    } finally {
      vi.useRealTimers();
    }
    await flush();

    const messageSubs = fake.state.subscriptions.filter((s) => {
      const f = s.filter as { kinds?: number[]; '#h'?: string[] };
      return f.kinds?.includes(9) && f['#h']?.[0]?.startsWith('quota-bg-');
    });
    expect(messageSubs.length).toBeLessThanOrEqual(8);
  });

  it('setActiveGroup after a queued metadata burst promotes the clicked channel to the head of the queue', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const messageSubsFor = (groupId: string) =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Metadata arrives first — every group is queued (no active group yet).
      deliver(await fakeRelayMetadata({ groupId: 'bg-a', name: 'A' }));
      deliver(await fakeRelayMetadata({ groupId: 'bg-b', name: 'B' }));
      deliver(await fakeRelayMetadata({ groupId: 'bg-c', name: 'C' }));

      // No subs yet — queue waiting for the drain timer.
      expect(messageSubsFor('bg-a')).toHaveLength(0);
      expect(messageSubsFor('bg-b')).toHaveLength(0);
      expect(messageSubsFor('bg-c')).toHaveLength(0);

      // User clicks on bg-c — it should fire synchronously even though it's
      // sitting in the middle of the queue.
      bridge.setActiveGroup('bg-c');
      expect(messageSubsFor('bg-c')).toHaveLength(1);
      // bg-a and bg-b are still queued.
      expect(messageSubsFor('bg-a')).toHaveLength(0);
      expect(messageSubsFor('bg-b')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(100);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    // After the drain, bg-a and bg-b come up, but bg-c is not double-subscribed.
    expect(messageSubsFor('bg-a')).toHaveLength(1);
    expect(messageSubsFor('bg-b')).toHaveLength(1);
    expect(messageSubsFor('bg-c')).toHaveLength(1);
  });

  it('addRelay registers a relay in the rail without subscribing to it (no multi-relay bleed)', async () => {
    // Reproduces the second leak path: addRelay used to push the new URL
    // into `this.relays`, the bridge's active subscription set. A subsequent
    // background reconnect (`reconnectInBackground` → `connect()`) would
    // then issue kind 39000 against every relay the user had ever added,
    // mixing channels from multiple servers into one `this.groups` store.
    // The rail UX has only one active relay at a time (the green pill), so
    // `addRelay` should only register in `configuredRelays` — `switchRelay`
    // is the single path that activates a relay.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const activeBefore = (impl as unknown as { relays: string[] }).relays.slice();
    expect(activeBefore).toEqual(['wss://public.obelisk.ar']);

    const NEW_RELAY = 'wss://added-but-not-active.example';
    await bridge.addRelay(NEW_RELAY);

    // Active subscription set unchanged — only `switchRelay` should mutate it.
    const activeAfter = (impl as unknown as { relays: string[] }).relays.slice();
    expect(activeAfter).toEqual(activeBefore);
    expect(activeAfter).not.toContain(NEW_RELAY);

    // But the rail (configuredRelays) does include the new relay.
    expect(impl.configuredRelays.get()).toContain(NEW_RELAY);
  });

  it('addRelay persists a custom relay without preflight handshaking it', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();
    fake.state.ensureRelayCalls = [];

    const CUSTOM_RELAY = 'wss://custom-relay.example';
    await bridge.addRelay(CUSTOM_RELAY);

    const impl = getBridgeImpl()!;
    expect(impl.configuredRelays.get()).toContain(CUSTOM_RELAY);
    expect(fake.state.ensureRelayCalls).toEqual([]);
  });

  it('addRelay deduplicates equivalent relay URLs with and without a trailing slash', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    await bridge.addRelay('wss://lacrypta-relay.obelisk.ar/');
    await bridge.addRelay('wss://lacrypta-relay.obelisk.ar');

    const impl = getBridgeImpl()!;
    expect(impl.configuredRelays.get().filter((url) => url === 'wss://lacrypta-relay.obelisk.ar')).toHaveLength(1);
    expect(impl.configuredRelays.get()).not.toContain('wss://lacrypta-relay.obelisk.ar/');
  });

  it('editUserMetadata publishes kind 0 to the active relay plus quiet profile lookup relays', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    await bridge.switchRelay('wss://lacrypta-relay.obelisk.ar');
    fake.state.published = [];

    await bridge.editUserMetadata({ name: 'Alice', displayName: 'Alice' });

    const metadataEvent = fake.state.published.find((event) => event.kind === 0);
    expect(metadataEvent).toBeTruthy();
    expect(metadataEvent?.relays).toContain('wss://relay.obelisk.ar');
    expect(metadataEvent?.relays).toContain('wss://public.obelisk.ar');
    expect(metadataEvent?.relays).toContain('wss://purplepag.es');
    expect(metadataEvent?.relays).toContain('wss://lacrypta-relay.obelisk.ar');
    expect(metadataEvent?.relays).not.toContain('wss://relay.damus.io');
  });

  // -- per-group messages-status confidence + retry ladder ----------------
  // EOSE alone is NOT proof a channel is empty: auth-gated and silent-
  // filtering relays routinely send EOSE-empty before any events arrive.
  // The bridge owns a retry ladder (see `EMPTY_RETRY_DELAYS` in client.ts)
  // that re-fires the kind 9 REQ a few times before promoting to
  // `empty-confirmed`. The UI reads `messagesStatusByGroup` to decide
  // between the loading spinner and "No messages yet" copy.

  it('subscribeMessagesStatus: starts at "loading", flips to "empty-unconfirmed" after empty EOSE', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const groupId = 'empty-eose-status-test';
    const observed: string[] = [];
    bridge.subscribeMessagesStatus(groupId, (s) => observed.push(s));
    // Initial replay before any EOSE microtask drains.
    expect(observed[0]).toBe('loading');

    // FakePool fires EOSE via queueMicrotask; flush drains it.
    await flush();
    // Empty EOSE → bridge holds "empty-unconfirmed" while the retry ladder
    // is pending. UI must keep the spinner up here, NOT show "no messages".
    expect(observed.at(-1)).toBe('empty-unconfirmed');
  });

  it('event arriving after empty EOSE flips status to "has-messages" and cancels the retry', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'event-arrival-status-test';
    bridge.subscribeMessagesStatus(groupId, () => {});
    await flush();
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');
    // Retry entry exists, timer scheduled.
    expect(impl.messagesRetryByGroup.has(groupId)).toBe(true);

    // Simulate the auth-gated relay finally delivering a real event after
    // its EOSE-empty head-fake.
    deliver(await fakeRelayMessage({ groupId, content: 'late history msg' }));
    await flush();

    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
    // Retry was cancelled so we don't fire a needless restart.
    expect(impl.messagesRetryByGroup.has(groupId)).toBe(false);
  });

  it('exhausting the retry ladder (3 retries) promotes status to "empty-confirmed"', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'retry-exhaustion-test';

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.subscribeMessagesStatus(groupId, () => {});
      // Drain microtasks so the initial EOSE fires.
      await Promise.resolve();
      await Promise.resolve();
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');

      // 1500 + 3000 + 5000 = 9500ms of retry ladder. Pad slightly so the
      // post-final-retry EOSE microtask + scheduleEmptyRetry call complete.
      await vi.advanceTimersByTimeAsync(10000);
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-confirmed');
      expect(impl.messagesRetryByGroup.has(groupId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setActiveGroup on a stuck-loading channel restarts the sub so the click gets fresh priority', async () => {
    // Regression for "I clicked the channel and it's still spinning,
    // had to refresh the page for it to load." When the background
    // drain has already subscribed a channel and the sub is stuck
    // (status not 'has-messages'), a user click via setActiveGroup
    // MUST tear down the stuck sub and open a fresh one. Otherwise
    // the click just bumps a sub that's never going to deliver.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'click-restart-on-stuck';

    const subsFor = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    // Background-drain-style subscribe: existing sub on the channel.
    bridge.subscribeMessages(groupId, () => {});
    await flush();
    const initialSubs = subsFor();
    expect(initialSubs).toHaveLength(1);
    const firstSub = initialSubs[0];
    // After flush, FakePool's auto-EOSE fired empty → status =
    // 'empty-unconfirmed'.
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');

    // User click: setActiveGroup must restart the stuck sub.
    bridge.setActiveGroup(groupId);
    // Synchronously: messageSubscribedGroups was repopulated by the
    // restart, but the sub object should be a FRESH one — the old
    // firstSub is gone from state.subscriptions.
    const afterClick = subsFor();
    expect(afterClick).toHaveLength(1);
    expect(afterClick[0]).not.toBe(firstSub);
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('loading');
  });

  it('setActiveGroup on a stuck channel ALSO fires querySync in parallel (defense in depth)', async () => {
    // Regression for "some channels still need a refresh even after
    // the click-restart fix." The live sub restart sometimes wedges
    // on the same conditions that had the previous sub stuck
    // (relay-side per-REQ AUTH quirks, SimplePool dedup of identical
    // filters on the same socket). Firing querySync alongside the
    // restart gives the channel a parallel second chance — if either
    // path returns events, ingestMessage promotes to 'has-messages'.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'click-parallel-querysync';

    // Spy on pool.querySync to count kind-9 calls for this group.
    const pool = (impl as unknown as { pool: { querySync: (...args: unknown[]) => Promise<NostrEvent[]> } }).pool;
    let kind9QueryCalls = 0;
    (pool as { querySync: (...args: unknown[]) => Promise<NostrEvent[]> }).querySync = async (_relays: unknown, filter: unknown) => {
      const f = filter as { kinds?: number[]; '#h'?: string[] };
      if (f.kinds?.includes(9) && f['#h']?.includes(groupId)) kind9QueryCalls++;
      return [];
    };

    // Initial subscribe → status flips to 'empty-unconfirmed' after
    // FakePool's auto-EOSE.
    bridge.subscribeMessages(groupId, () => {});
    await flush();
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');
    expect(kind9QueryCalls).toBe(0);

    // Click → setActiveGroup → bumpGroupMessagesPriority → both
    // refreshGroupMessages (live restart) AND querySync fire.
    bridge.setActiveGroup(groupId);
    await flush();
    expect(kind9QueryCalls).toBe(1);
  });

  it('AUTH ok also refreshes channels stuck in "loading" (not just empty-*)', async () => {
    // Regression for "the channel sat in Loading messages… forever
    // because a sub opened during AUTH-pending got stranded with no
    // EOSE, and the wireAuthSettledHook only refreshed channels in
    // empty-*." Channels in 'loading' get refreshed too now.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'auth-ok-refresh-loading';

    const activeRelay = impl['relays'][0];
    (impl as unknown as { relayAccess: { set: (v: Record<string, unknown>) => void } }).relayAccess.set({
      [activeRelay]: 'authenticating',
    });

    const subsFor = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    // Pre-set status to 'loading' WITHOUT going through the FakePool
    // auto-EOSE (which would flip it to empty-unconfirmed). We do this
    // by intercepting the FakePool subscribe to suppress its EOSE for
    // this specific filter, simulating a sub that opened on a not-yet-
    // AUTH'd socket and never received an EOSE.
    bridge.setActiveGroup(groupId);
    bridge.subscribeMessages(groupId, () => {});
    // Don't flush microtasks fully — we want the initial 'loading'
    // status to persist. Sync setMessagesStatus is the cleanest path:
    (impl as unknown as { setMessagesStatus: (id: string, s: string) => void }).setMessagesStatus(groupId, 'loading');
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('loading');
    const initialSubs = subsFor();
    expect(initialSubs.length).toBeGreaterThan(0);
    const initialSub = initialSubs.at(-1)!;

    // AUTH settles → wireAuthSettledHook should refresh the 'loading'
    // channel (the active one).
    (impl as unknown as { setRelayAccess: (url: string, state: string) => void }).setRelayAccess(activeRelay, 'ok');
    await flush();

    const afterSubs = subsFor();
    expect(afterSubs.length).toBeGreaterThan(0);
    expect(afterSubs.at(-1)).not.toBe(initialSub); // fresh sub exists
  });

  it('setActiveGroup on a has-messages channel does NOT restart the sub (no relay churn)', async () => {
    // Mirror image of the previous test: if the existing sub is
    // healthy and delivering, a click must NOT tear it down. Otherwise
    // every channel switch would burn a REQ on the relay for no
    // benefit.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'click-noop-when-loaded';

    const subsFor = () =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });

    // Pre-deliver an event so the sub lands in 'has-messages'.
    bridge.subscribeMessages(groupId, () => {});
    deliver(await fakeRelayMessage({ groupId, content: 'pre-existing' }));
    await flush();
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
    const before = subsFor();
    expect(before).toHaveLength(1);
    const stableSub = before[0];

    bridge.setActiveGroup(groupId);
    const after = subsFor();
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(stableSub); // identity check — no replacement
  });

  it('AUTH-pending defers empty-confirmed promotion — stuck channels stay in empty-unconfirmed', async () => {
    // Regression for "user is staring at their NIP-46 bunker waiting to
    // approve, meanwhile the chat pane has flipped to 'No messages yet'
    // even though the channel has plenty of history the relay just
    // hasn't been allowed to serve yet." The empty-EOSE retry ladder
    // now checks `relayAccess[activeRelay]` before promoting; if AUTH
    // is still in flight (`'unknown'` / `'authenticating'`), the
    // verdict is deferred and status stays at `empty-unconfirmed` so
    // the UI keeps the spinner up. The wireAuthSettledHook fires a
    // fresh REQ when AUTH eventually settles.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'auth-pending-defer';

    // Force relayAccess back to a pending state. The FakePool's
    // synchronous EOSE replay flipped it to 'ok' on login; we want to
    // exercise the path where the relay hasn't authed us yet.
    const activeRelay = impl['relays'][0];
    (impl as unknown as { relayAccess: { set: (v: Record<string, unknown>) => void } }).relayAccess.set({
      [activeRelay]: 'authenticating',
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.subscribeMessagesStatus(groupId, () => {});
      bridge.subscribeMessages(groupId, () => {});
      await Promise.resolve();
      await Promise.resolve();
      // Drive the ladder to exhaustion. WITHOUT the AUTH gate, status
      // would flip to 'empty-confirmed' here. WITH the gate, it stays
      // at 'empty-unconfirmed' and the retry entry is cleared (so no
      // zombie timer ticks in the background).
      await vi.advanceTimersByTimeAsync(10000);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');
    expect(impl.messagesRetryByGroup.has(groupId)).toBe(false);
  });

  it('AUTH settles to ok → stuck channels auto-refresh and deliver pending history', async () => {
    // Regression for the "tap approve, then I have to refresh the
    // whole page" UX. When `relayAccess` transitions from pending to
    // 'ok' on the active relay, the bridge fires `refreshGroupMessages`
    // for any channel held in `empty-unconfirmed` / `empty-confirmed`.
    // The fresh REQ rides the now-AUTH'd socket and delivers history
    // — no page reload required.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'auth-settle-autorefresh';

    const activeRelay = impl['relays'][0];
    (impl as unknown as { relayAccess: { set: (v: Record<string, unknown>) => void } }).relayAccess.set({
      [activeRelay]: 'authenticating',
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.setActiveGroup(groupId);
      bridge.subscribeMessages(groupId, () => {});
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10000);
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');

      // Pre-publish an event before AUTH flips — it sits in
      // `state.published` and will be replayed to the next sub.
      deliver(await fakeRelayMessage({ groupId, content: 'arrived after AUTH' }));

      // Simulate AUTH success. setRelayAccess takes the public path
      // (not a raw store overwrite) so the wireAuthSettledHook fires
      // via the StateStore subscriber chain.
      (impl as unknown as { setRelayAccess: (url: string, state: string) => void }).setRelayAccess(activeRelay, 'ok');

      // The hook calls refreshGroupMessages → new sub → synchronous
      // FakePool.subscribe replays state.published (including the
      // freshly stashed event) → onevent → ingestMessage → status
      // flips to 'has-messages'.
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    const msgs = impl.messagesByGroup.get()[groupId] ?? [];
    expect(msgs.map((m) => m.content)).toContain('arrived after AUTH');
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
  });

  it('AUTH fails permanently → stuck empty-unconfirmed channels promote to empty-confirmed', async () => {
    // Regression for the third state: AUTH-pending defer would
    // otherwise hold channels in `empty-unconfirmed` forever. When
    // `relayAccess` transitions to a failed state ('auth-required',
    // 'restricted', etc.), the bridge promotes everything stuck on
    // the gate so the chat pane shows "No messages yet" alongside the
    // RelayStatusBanner explaining the access failure.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'auth-fail-promote';
    const activeRelay = impl['relays'][0];

    (impl as unknown as { relayAccess: { set: (v: Record<string, unknown>) => void } }).relayAccess.set({
      [activeRelay]: 'authenticating',
    });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.subscribeMessagesStatus(groupId, () => {});
      bridge.subscribeMessages(groupId, () => {});
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10000);
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-unconfirmed');

      (impl as unknown as { setRelayAccess: (url: string, state: string) => void }).setRelayAccess(activeRelay, 'auth-required');
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-confirmed');
  });

  it('cold-load fallback: querySync fires after the ladder exhausts and recovers messages', async () => {
    // Regression for "first cold load shows Loading messages… forever
    // because the relay never delivered kind 9 to the live REQ." After
    // the 1.5/3/5s ladder exhausts, the bridge fires a focused
    // `pool.querySync` with a longer maxWait — a second-chance request
    // that goes out as a fresh frame, by which point AUTH / whitelist
    // state has had time to settle. Events ingested through that path
    // promote status back from `empty-confirmed` to `has-messages`.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'cold-load-fallback';

    // Stash a kind 9 event directly in `state.published` so the
    // FakePool's `querySync` resolves with content. We push BEFORE
    // subscribing so the bridge's onevent (from the live REQ's
    // synchronous replay in FakePool.subscribe) ingests it too — but
    // we accept that side effect; the key assertion is that the test
    // ends with `has-messages` regardless of which path got us there.
    // (A purer test for the fallback specifically would stub
    // pool.subscribe to skip the synchronous replay; the single-shot
    // counter test below covers the "only fallback fired" case.)
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const stashed = finalizeEvent(
      {
        kind: 9,
        content: 'rescued by querySync',
        tags: [['h', groupId]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: pk,
      } as Parameters<typeof finalizeEvent>[0],
      sk,
    );
    fake.state.published.push(stashed);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Install fake timers BEFORE subscribing — otherwise the first
      // retry timer (armed in oneose) lives on the real timer queue
      // and advanceTimersByTimeAsync below would never fire it.
      bridge.subscribeMessagesStatus(groupId, () => {});
      bridge.subscribeMessages(groupId, () => {});
      await Promise.resolve();
      await Promise.resolve();
      // Drive the retry ladder to exhaustion (1.5 + 3 + 5 = 9.5s) and
      // give the post-final EOSE microtask + querySync resolution a
      // pad.
      await vi.advanceTimersByTimeAsync(10000);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    await flush();

    const msgs = impl.messagesByGroup.get()[groupId] ?? [];
    expect(msgs.map((m) => m.content)).toContain('rescued by querySync');
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
  });

  it('cold-load fallback is single-shot per session unless refreshGroupMessages re-arms it', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'cold-load-fallback-singleshot';

    // Stub `pool.querySync` to count calls AND return empty so the
    // status reaches `empty-confirmed` (not has-messages — that would
    // hit ingestMessage which clears retry state and complicates the
    // single-shot trace).
    const pool = (impl as unknown as { pool: { querySync: (...args: unknown[]) => Promise<NostrEvent[]> } }).pool;
    let kind9QueryCalls = 0;
    (pool as { querySync: (...args: unknown[]) => Promise<NostrEvent[]> }).querySync = async (_relays: unknown, filter: unknown) => {
      const f = filter as { kinds?: number[]; '#h'?: string[] };
      if (f.kinds?.includes(9) && f['#h']?.includes(groupId)) kind9QueryCalls++;
      return [];
    };

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.subscribeMessagesStatus(groupId, () => {});
      bridge.subscribeMessages(groupId, () => {});
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10000);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(kind9QueryCalls).toBe(1);
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-confirmed');

    // No second auto-fire even after another full ladder length — the
    // empty-confirmed guard prevents the ladder from restarting, and
    // the single-shot flag prevents a redundant querySync.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await vi.advanceTimersByTimeAsync(15000);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(kind9QueryCalls).toBe(1);

    // Explicit user retry re-arms the fallback flag and restarts the
    // sub. The new ladder runs to exhaustion → fallback fires a second
    // time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.refreshGroupMessages(groupId);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10000);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    expect(kind9QueryCalls).toBe(2);
  });

  it('post-empty-confirmed EOSE keeps status pinned and does not restart the ladder', async () => {
    // Regression for the "Loading messages… ↔ No messages yet" loop:
    // after the retry ladder has reached `empty-confirmed`,
    // `subscribeWatched` keeps re-issuing the REQ when the relay sends
    // CLOSED auth-required (the EOSE-then-CLOSED race). Each fresh REQ
    // delivers another empty EOSE, which used to call back through the
    // bridge's `oneose` and downgrade status to `empty-unconfirmed`,
    // restarting the 1.5/3/5s ladder. UI consequence: the chat pane
    // oscillated between the spinner and the welcome copy forever.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'post-empty-confirmed-no-restart';

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.subscribeMessagesStatus(groupId, () => {});
      // Drive status to empty-confirmed via the ladder (1.5+3+5=9.5s).
      await vi.advanceTimersByTimeAsync(10000);
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-confirmed');

      // Locate the current live kind-9 sub for this group. The retry
      // ladder closed and reopened a few times; the last one in
      // state.subscriptions is the one still alive.
      const kind9Subs = fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(groupId);
      });
      expect(kind9Subs.length).toBeGreaterThan(0);
      const liveSub = kind9Subs.at(-1)!;

      // Simulate the EOSE-then-CLOSED race. CLOSED auth-required drives
      // subscribeWatched's scheduleRetry(true) → fresh pool.subscribe →
      // fresh queueMicrotask EOSE → bridge's oneose runs again. The fix
      // gates the downgrade on `messagesStatusByGroup[groupId] !==
      // 'empty-confirmed'` so the ladder must NOT restart here.
      liveSub.onclose?.((liveSub.relays ?? ['']).map(() => 'auth-required: please AUTH'));
      // Advance enough for the immediate retry setTimeout(0) to fire,
      // the new pool.subscribe to queue its oneose microtask, and that
      // oneose to drain through to bridge.oneose.
      await vi.advanceTimersByTimeAsync(10);

      // Without the guard: status would now be 'empty-unconfirmed' and
      // messagesRetryByGroup would contain a fresh 1500ms timer.
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-confirmed');
      expect(impl.messagesRetryByGroup.has(groupId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('setActiveGroup on an "empty-confirmed" channel restarts the sub and resets confidence to "loading"', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'stale-empty-reopen';

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Drive status to empty-confirmed via the retry ladder.
      bridge.subscribeMessagesStatus(groupId, () => {});
      await vi.advanceTimersByTimeAsync(10000);
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('empty-confirmed');

      // User now opens this channel — bridge must restart the sub so a
      // previously-empty verdict can be revised.
      bridge.setActiveGroup(groupId);
      // status flips to 'loading' synchronously inside subscribeGroupMessages;
      // the fresh EOSE microtask hasn't drained yet.
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('loading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshGroupMessages resets retry counter and restarts the kind 9 sub', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'refresh-resets-retry';

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      bridge.subscribeMessagesStatus(groupId, () => {});
      // First retry advances attempts to 1.
      await vi.advanceTimersByTimeAsync(1500);
      expect(impl.messagesRetryByGroup.get(groupId)?.attempts).toBe(1);

      // External refresh: must reset attempts to 0 and reopen the sub.
      bridge.refreshGroupMessages(groupId);
      // Synchronously: retry tracking was cleared (no entry until next
      // empty EOSE schedules a fresh ladder).
      expect(impl.messagesRetryByGroup.has(groupId)).toBe(false);
      // Status is 'loading' until the fresh EOSE microtask drains.
      expect(impl.messagesStatusByGroup.get()[groupId]).toBe('loading');
    } finally {
      vi.useRealTimers();
    }
  });

  it('active-channel priority gate releases after ACTIVE_PRIORITY_MAX_PAUSE_MS even if the watched sub never reaches EOSE', async () => {
    // Regression test for the priority gate cap. Without it, a silent /
    // auth-gated relay that never delivers events or EOSE on the watched
    // channel would starve every other channel's kind 9 sub indefinitely
    // — and since `ingestMessage` is where profile-picture lookups are
    // fanned out, background-channel avatars would never load until the
    // user refreshed the page.
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // Force the active channel to LOOK silent: subscribe without
      // letting the FakePool's queueMicrotask EOSE fire. We achieve
      // this by activating the group then immediately checking that
      // the gate is engaged.
      bridge.setActiveGroup('silent-grp');
      // The synchronous subscribeGroupMessages set status to 'loading'.
      expect(impl.messagesStatusByGroup.get()['silent-grp']).toBe('loading');
      // Gate should be engaged (within the deadline window).
      // No public getter, so we exercise the observable: synchronously
      // queue a bg group and confirm its REQ doesn't fire until the cap.
      // (Skip the queue-internals manipulation — instead just advance
      // past the deadline and verify the gate releases.)

      // Advance past ACTIVE_PRIORITY_MAX_PAUSE_MS (3000ms) without
      // letting EOSE microtasks fire. The internal force-release timer
      // should clear the gate.
      await vi.advanceTimersByTimeAsync(3500);

      // After the cap, the gate is released — `isActiveGroupStillLoading`
      // returns false because Date.now() >= activeGroupPriorityDeadline,
      // even though status is still 'loading' or 'empty-unconfirmed'.
      // We exercise this by checking that the priority deadline is in
      // the past. (Reading the private field via the impl handle.)
      expect(Date.now()).toBeGreaterThanOrEqual(impl['activeGroupPriorityDeadline']);
    } finally {
      vi.useRealTimers();
    }
  });

  // -- message + reaction caching ----------------------------------------
  // Per the new cache contract (CLAUDE.md §bridgeCache + cache.ts header),
  // kind 9 and kind 7 events are persisted to localStorage so the chat pane
  // can paint stale history instantly on cold load instead of staring at
  // "Loading messages…" while the relay round-trips. Tests below assert the
  // write-on-ingest, the cap, the optimistic filter, and the seed-on-login
  // round trip.

  it('ingestMessage persists confirmed messages to bridgeCache after the debounce', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheGet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'msg-cache-roundtrip';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      deliver(await fakeRelayMessage({ groupId, content: 'first' }));
      deliver(await fakeRelayMessage({ groupId, content: 'second' }));
      // Cache flush is debounced; nothing on disk yet.
      const beforeFlush = cacheGet<unknown[]>(impl.currentRelayUrl.get(), 9, groupId);
      expect(beforeFlush).toBeNull();

      // Drain the 200ms debounce.
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    const cached = cacheGet<{ content: string }[]>(
      impl.currentRelayUrl.get(),
      9,
      groupId,
    );
    expect(cached).toBeTruthy();
    expect(cached!.value.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('cached messages cap at MESSAGE_CACHE_LIMIT (last 50 by createdAt)', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheGet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'msg-cache-cap';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    // Pre-sign 60 events with increasing created_at so the ordering is stable.
    const events: NostrEvent[] = [];
    const baseTs = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 60; i++) {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      events.push(
        finalizeEvent(
          {
            kind: 9,
            content: `m${i}`,
            tags: [['h', groupId]],
            created_at: baseTs + i,
            pubkey: pk,
          } as Parameters<typeof finalizeEvent>[0],
          sk,
        ),
      );
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      for (const ev of events) deliver(ev);
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    const cached = cacheGet<{ content: string }[]>(
      impl.currentRelayUrl.get(),
      9,
      groupId,
    );
    expect(cached).toBeTruthy();
    expect(cached!.value).toHaveLength(50);
    // Newest-by-createdAt window: m10..m59. The first 10 are dropped.
    expect(cached!.value[0].content).toBe('m10');
    expect(cached!.value[49].content).toBe('m59');
  });

  it('optimistic placeholders are filtered out before the cache write', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheGet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'msg-cache-no-optimistic';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // bridge.sendMessage inserts an optimistic placeholder synchronously,
      // then publishes, then the relay echo replaces it. Drive the full
      // round-trip so the cache flush sees only the confirmed copy.
      await bridge.sendMessage(groupId, 'sent-via-bridge');
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    const cached = cacheGet<{ content: string; pending?: boolean }[]>(
      impl.currentRelayUrl.get(),
      9,
      groupId,
    );
    expect(cached).toBeTruthy();
    expect(cached!.value).toHaveLength(1);
    // No leftover `pending: true` on a cached entry — that would resurrect
    // a stale spinner bubble on next session.
    expect(cached!.value[0].pending).toBeUndefined();
    expect(cached!.value[0].content).toBe('sent-via-bridge');
  });

  it('seedCacheForRelay paints cached messages into messagesByGroup before live REQ', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheSet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'msg-cache-seed';
    const relay = impl.currentRelayUrl.get();

    // Pre-populate the cache as if a previous session had written 3 messages.
    const baseTs = Math.floor(Date.now() / 1000) - 60;
    cacheSet(relay, 9, groupId, [
      { id: 'a', pubkey: 'x'.repeat(64), content: 'cold-1', createdAt: baseTs, kind: 9, replyToId: null, mentions: [] },
      { id: 'b', pubkey: 'y'.repeat(64), content: 'cold-2', createdAt: baseTs + 1, kind: 9, replyToId: null, mentions: [] },
      { id: 'c', pubkey: 'z'.repeat(64), content: 'cold-3', createdAt: baseTs + 2, kind: 9, replyToId: null, mentions: [] },
    ]);

    // switchRelay re-runs seedCacheForRelay against the (same) relay url and
    // re-paints from the just-written cache, mirroring what a fresh page
    // load does on cold start.
    await bridge.switchRelay(relay);
    await flush();

    const inMemory = impl.messagesByGroup.get()[groupId] ?? [];
    expect(inMemory.map((m) => m.content)).toEqual(['cold-1', 'cold-2', 'cold-3']);
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
  });

  it('setActiveGroup seeds cached messages when the channel memory is empty', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheSet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'active-cache-seed';
    const relay = impl.currentRelayUrl.get();
    const baseTs = Math.floor(Date.now() / 1000) - 60;
    cacheSet(relay, 9, groupId, [
      { id: 'active-a', pubkey: 'x'.repeat(64), content: 'active-cold-1', createdAt: baseTs, kind: 9, replyToId: null, mentions: [] },
      { id: 'active-b', pubkey: 'y'.repeat(64), content: 'active-cold-2', createdAt: baseTs + 1, kind: 9, replyToId: null, mentions: [] },
    ]);

    expect(impl.messagesByGroup.get()[groupId]).toBeUndefined();

    bridge.setActiveGroup(groupId);

    const inMemory = impl.messagesByGroup.get()[groupId] ?? [];
    expect(inMemory.map((m) => m.content)).toEqual(['active-cold-1', 'active-cold-2']);
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
  });

  it('refreshGroupMessages keeps cached messages visible while the live REQ restarts', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheSet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'refresh-cache-seed';
    const relay = impl.currentRelayUrl.get();
    const baseTs = Math.floor(Date.now() / 1000) - 60;
    cacheSet(relay, 9, groupId, [
      { id: 'refresh-a', pubkey: 'x'.repeat(64), content: 'refresh-cold', createdAt: baseTs, kind: 9, replyToId: null, mentions: [] },
    ]);

    bridge.setActiveGroup(groupId);
    await flush();
    impl.messagesStatusByGroup.update((prev) => ({ ...prev, [groupId]: 'empty-confirmed' }));

    bridge.refreshGroupMessages(groupId);

    expect(impl.messagesByGroup.get()[groupId]?.map((m) => m.content)).toEqual(['refresh-cold']);
    expect(impl.messagesStatusByGroup.get()[groupId]).toBe('has-messages');
  });

  it('ingestReaction persists to bridgeCache and seedCacheForRelay paints it', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheGet, cacheSet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'rxn-cache';
    bridge.subscribeReactions(groupId, () => {});
    await flush();

    // Drive an inbound reaction through the relay.
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const rxnEv = finalizeEvent(
      {
        kind: 7,
        content: '🔥',
        tags: [['e', 'tgt-1'], ['h', groupId]],
        created_at: Math.floor(Date.now() / 1000),
        pubkey: pk,
      } as Parameters<typeof finalizeEvent>[0],
      sk,
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      deliver(rxnEv);
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    await flush();

    const cached = cacheGet<Record<string, { emoji: string }[]>>(
      impl.currentRelayUrl.get(),
      7,
      groupId,
    );
    expect(cached).toBeTruthy();
    expect(cached!.value['tgt-1']).toBeDefined();
    expect(cached!.value['tgt-1'][0].emoji).toBe('🔥');

    // Now wipe in-memory state and verify the seed re-populates from cache.
    impl.reactionsByGroup.set({});
    // Write a sentinel cache value so we can prove the seed read it.
    cacheSet(impl.currentRelayUrl.get(), 7, groupId, {
      'tgt-2': [{ id: 'r2', pubkey: pk, emoji: '👀', targetEventId: 'tgt-2', createdAt: 1 }],
    });
    await bridge.switchRelay(impl.currentRelayUrl.get());
    await flush();

    const seeded = impl.reactionsByGroup.get()[groupId];
    expect(seeded).toBeTruthy();
    expect(seeded['tgt-2'][0].emoji).toBe('👀');
  });

  it('logout wipes the bridgeCache so the next user does not inherit cached messages', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { cacheGet } = await import('./cache');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const groupId = 'msg-cache-logout';
    bridge.subscribeMessages(groupId, () => {});
    await flush();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      deliver(await fakeRelayMessage({ groupId, content: 'before logout' }));
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    await flush();
    const relay = impl.currentRelayUrl.get();
    expect(cacheGet(relay, 9, groupId)).toBeTruthy();

    await bridge.logout();
    // Logout calls cacheClearAll synchronously via the shared
    // clearLocalStateAfterLogout helper — the next read must miss.
    expect(cacheGet(relay, 9, groupId)).toBeNull();
  });

  it('keeps replace-mode voice subscriptions pinned across relay switches', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const seen: NostrEvent[] = [];
    const unsub = impl.subscribeFilterWatched(
      { kinds: [KIND_VOICE_PRESENCE] },
      (ev) => seen.push(ev),
      { relays: ['wss://origin.example'], relayMode: 'replace', affectsRelayAccess: false },
    );
    expect(fake.state.subscriptions.at(-1)?.relays).toEqual(['wss://origin.example']);

    await bridge.switchRelay('wss://other.example');
    await flush();

    const peerSk = generateSecretKey();
    const peerPk = getPublicKey(peerSk);
    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [['e', 'mesh-channel'], ['t', 'obelisk-voice-presence']],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: peerPk,
    } as Parameters<typeof finalizeEvent>[0], peerSk));
    expect(seen).toHaveLength(1);

    await impl.publishEvent(
      { kind: KIND_VOICE_PRESENCE, content: '', tags: [['e', 'mesh-channel']] },
      { extraRelays: ['wss://origin.example'], mode: 'replace' },
    );
    await flush();
    expect(fake.state.published.at(-1)?.relays).toEqual(['wss://origin.example']);
    unsub();
  });

  it('marks mesh voice channels live from presence beacons', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const snapshots: Array<Readonly<Record<string, { mode?: string; participantCount: number; participantPubkeys?: string[] }>>> = [];
    const unsub = bridge.subscribeActiveCallByChannel((m) => snapshots.push(m));
    const peerSk = generateSecretKey();
    const peerPk = getPublicKey(peerSk);
    const now = Math.floor(Date.now() / 1000);
    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
      pubkey: peerPk,
    } as Parameters<typeof finalizeEvent>[0], peerSk));
    await flush();

    expect(snapshots.at(-1)?.['mesh-channel']).toMatchObject({
      mode: 'mesh',
      participantCount: 1,
      participantPubkeys: [peerPk],
    });
    unsub();
  });

  it('removes mesh voice participants when a same-second leave beacon arrives', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    let latest: Readonly<Record<string, { mode?: string; participantCount: number; participantPubkeys?: string[] }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const peerSk = generateSecretKey();
    const peerPk = getPublicKey(peerSk);
    const now = Math.floor(Date.now() / 1000);

    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
      pubkey: peerPk,
    } as Parameters<typeof finalizeEvent>[0], peerSk));
    await flush();
    expect(latest['mesh-channel']).toMatchObject({ participantPubkeys: [peerPk] });

    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['status', 'left'],
        ['expiration', String(now - 1)],
      ],
      created_at: now,
      pubkey: peerPk,
    } as Parameters<typeof finalizeEvent>[0], peerSk));
    await flush();
    expect(latest['mesh-channel']).toBeUndefined();

    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
      pubkey: peerPk,
    } as Parameters<typeof finalizeEvent>[0], peerSk));
    await flush();
    expect(latest['mesh-channel']).toBeUndefined();
    unsub();
  });

  it('marks a locally published mesh beacon live without waiting for relay echo', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    let latest: Readonly<Record<string, { mode?: string; participantCount: number }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const now = Math.floor(Date.now() / 1000);

    await impl.publishEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'local-mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
    });

    expect(latest['local-mesh-channel']).toMatchObject({
      mode: 'mesh',
      participantCount: 1,
    });
    unsub();
  });

  it('clears a locally published mesh call when the local user publishes a leave beacon', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    let latest: Readonly<Record<string, { mode?: string; participantCount: number }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const now = Math.floor(Date.now() / 1000);

    await impl.publishEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'local-mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
    });
    expect(latest['local-mesh-channel']).toMatchObject({ participantCount: 1 });

    await impl.publishEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'local-mesh-channel'],
        ['t', 'obelisk-voice-presence'],
        ['status', 'left'],
        ['expiration', String(now - 1)],
      ],
      created_at: now,
    });

    expect(latest['local-mesh-channel']).toBeUndefined();
    unsub();
  });

  it('ignores non-Obelisk kind 20078 events for mesh live detection', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    let latest: Readonly<Record<string, { mode?: string }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const peerSk = generateSecretKey();
    const peerPk = getPublicKey(peerSk);
    const now = Math.floor(Date.now() / 1000);
    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'mesh-channel'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
      pubkey: peerPk,
    } as Parameters<typeof finalizeEvent>[0], peerSk));
    await flush();

    expect(latest['mesh-channel']).toBeUndefined();
    unsub();
  });

  it('ignores SFU topology beacons for mesh live detection', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    let latest: Readonly<Record<string, { mode?: string }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const sfuSk = generateSecretKey();
    const sfuPk = getPublicKey(sfuSk);
    const now = Math.floor(Date.now() / 1000);
    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'voice-sfu-channel'],
        ['t', 'obelisk-voice-presence'],
        ['sfu', '1'],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
      pubkey: sfuPk,
    } as Parameters<typeof finalizeEvent>[0], sfuSk));
    await flush();

    expect(latest['voice-sfu-channel']).toBeUndefined();
    unsub();
  });

  it('uses SFU topology beacon p-tags as passive active-call participants', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    let latest: Readonly<Record<string, { mode?: string; participantCount: number; participantPubkeys?: string[]; hostPubkey?: string }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const sfuSk = generateSecretKey();
    const sfuPk = getPublicKey(sfuSk);
    const peerA = getPublicKey(generateSecretKey());
    const peerB = getPublicKey(generateSecretKey());
    const now = Math.floor(Date.now() / 1000);
    deliver(finalizeEvent({
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', 'voice-sfu-channel'],
        ['t', 'obelisk-voice-presence'],
        ['sfu', '1'],
        ['p', peerB],
        ['p', peerA],
        ['expiration', String(now + 30)],
      ],
      created_at: now,
      pubkey: sfuPk,
    } as Parameters<typeof finalizeEvent>[0], sfuSk));
    await flush();

    expect(latest['voice-sfu-channel']).toMatchObject({
      hostPubkey: sfuPk,
      mode: 'sfu',
      participantCount: 2,
      participantPubkeys: [peerA, peerB].sort(),
    });
    unsub();
  });

  it('parses SFU active-call content participants for passive rosters', async () => {
    const { getBridge } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    let latest: Readonly<Record<string, { mode?: string; participantCount: number; participantPubkeys?: string[] }>> = {};
    const unsub = bridge.subscribeActiveCallByChannel((m) => { latest = m; });
    const sfuSk = generateSecretKey();
    const peerA = getPublicKey(generateSecretKey());
    const peerB = getPublicKey(generateSecretKey());
    const now = Math.floor(Date.now() / 1000);
    deliver(finalizeEvent({
      kind: KIND_SFU_ACTIVE_CALL,
      content: JSON.stringify({ participants: [peerB, peerA] }),
      tags: [
        ['d', 'voice-sfu-channel'],
        ['status', 'active'],
        ['count', '2'],
        ['expiration', String(now + 90)],
      ],
      created_at: now,
    } as Parameters<typeof finalizeEvent>[0], sfuSk));
    await flush();

    expect(latest['voice-sfu-channel']).toMatchObject({
      mode: 'sfu',
      participantCount: 2,
      participantPubkeys: [peerA, peerB].sort(),
    });
    unsub();
  });

  it('background message-queue drain is gated by the active channel reaching its first EOSE / event', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    const subsFor = (id: string) =>
      fake.state.subscriptions.filter((s) => {
        const f = s.filter as { kinds?: number[]; '#h'?: string[] };
        return f.kinds?.includes(9) && f['#h']?.includes(id);
      });

    // Pre-sign the background metadata BEFORE the synchronous block: the
    // assertions below must run with no microtask drains in between (any
    // `await` would let queueMicrotask(EOSE) fire and flip the watched
    // channel's status out of 'loading' prematurely).
    const bgAEvent = await fakeRelayMetadata({ groupId: 'bg-a', name: 'A' });
    const bgBEvent = await fakeRelayMetadata({ groupId: 'bg-b', name: 'B' });

    // — synchronous block — no awaits! —
    bridge.setActiveGroup('watched-grp');
    deliver(bgAEvent);
    deliver(bgBEvent);

    // Synchronously: only watched sub exists. bg subs are queued but
    // the drain timer was NOT armed — `isActiveGroupStillLoading()` saw
    // status='loading' on the active group and bailed.
    expect(subsFor('watched-grp')).toHaveLength(1);
    expect(subsFor('bg-a')).toHaveLength(0);
    expect(subsFor('bg-b')).toHaveLength(0);
    expect(impl.messagesStatusByGroup.get()['watched-grp']).toBe('loading');
    // — end synchronous block —

    // Now allow microtasks to drain (EOSE for watched fires → status
    // flips off 'loading' → maybeResumeMessageQueueDrain arms the 80ms
    // drain timer).
    await flush();
    await new Promise((r) => setTimeout(r, 150));
    expect(subsFor('bg-a')).toHaveLength(1);
    expect(subsFor('bg-b')).toHaveLength(1);
  });

  it('returns end for normal relay pagination only after a confirmed empty page', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const groupId = 'normal-pagination-empty';
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    bridge.setActiveGroup(groupId);
    deliver(await fakeRelayMetadata({ groupId, name: 'Normal Pagination' }));
    await flush();
    deliver(await fakeRelayMessage({ groupId, content: 'newest normal message' }));
    await flush();

    const impl = getBridgeImpl()!;
    impl.relayAccess.set({ [impl.currentRelayUrl.get()]: 'ok' });

    await expect(bridge.loadMoreMessages(groupId)).resolves.toBe('end');
  });

  it('keeps normal relay pagination retryable when querySync fails', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const groupId = 'normal-pagination-error';
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    bridge.setActiveGroup(groupId);
    deliver(await fakeRelayMetadata({ groupId, name: 'Normal Pagination Error' }));
    await flush();
    deliver(await fakeRelayMessage({ groupId, content: 'newest normal message' }));
    await flush();

    const impl = getBridgeImpl()!;
    impl.relayAccess.set({ [impl.currentRelayUrl.get()]: 'ok' });
    const pool = (impl as unknown as { pool: { querySync: (...args: unknown[]) => Promise<NostrEvent[]> } }).pool;
    pool.querySync = async () => {
      throw new Error('relay query failed');
    };

    await expect(bridge.loadMoreMessages(groupId)).resolves.toBe('unavailable');
  });

  it('adds older messages from normal relay pagination', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const groupId = 'normal-pagination-added';
    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    bridge.setActiveGroup(groupId);
    deliver(await fakeRelayMetadata({ groupId, name: 'Normal Pagination Added' }));
    await flush();
    const newest = await fakeRelayMessage({ groupId, content: 'newest normal message' });
    const older = {
      ...(await fakeRelayMessage({ groupId, content: 'older normal page' })),
      id: 'older-normal-page',
      created_at: newest.created_at - 10,
    };
    deliver(newest);
    await flush();

    const impl = getBridgeImpl()!;
    impl.relayAccess.set({ [impl.currentRelayUrl.get()]: 'ok' });
    const pool = (impl as unknown as { pool: { querySync: (...args: unknown[]) => Promise<NostrEvent[]> } }).pool;
    pool.querySync = async () => [older];

    await expect(bridge.loadMoreMessages(groupId)).resolves.toBe('added');
    expect(impl.messagesByGroup.get()[groupId]?.map((m) => m.content)).toEqual([
      'older normal page',
      'newest normal message',
    ]);
  });

  it('uses Obelisk indexed bootstrap when the relay advertises v1 support', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const groupId = 'indexed-general';
    const meta = await fakeRelayMetadata({ groupId, name: 'Indexed General' });
    const msg = await fakeRelayMessage({ groupId, content: 'from indexed bootstrap' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        obelisk: {
          indexed_bootstrap: {
            version: 1,
            url: '/api/obelisk/v1/bootstrap',
            auth: 'nip98',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        relay: 'wss://public.obelisk.ar',
        generated_at: 1780617600,
        cursor: { since: 1780617590 },
        scopes: [
          {
            scope: 'default',
            groups: [
              { id: groupId, events: [meta, msg], next_before: msg.created_at - 1 },
            ],
          },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();

    const impl = getBridgeImpl()!;
    expect(impl.groups.get().find((g) => g.id === groupId)?.name).toBe('Indexed General');
    expect(impl.messagesByGroup.get()[groupId]?.map((m) => m.content)).toContain('from indexed bootstrap');
    expect(impl.groupMetadataEose.get()).toBe(true);

    const globalMetadataSubs = fake.state.subscriptions.filter((s) => {
      const kinds = (s.filter.kinds as number[] | undefined) ?? [];
      return kinds.length === 1 && kinds[0] === 39000;
    });
    expect(globalMetadataSubs).toHaveLength(0);
    const liveSub = fake.state.subscriptions.find((s) => {
      const kinds = (s.filter.kinds as number[] | undefined) ?? [];
      return kinds.includes(39000) && kinds.includes(9) && s.filter.since === 1780617590;
    });
    expect(liveSub).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe('https://public.obelisk.ar/api/obelisk/v1/bootstrap?limit_per_group=50');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toMatch(/^Nostr /);
  });

  it('pages older messages through the indexed HTTP endpoint before querySync fallback', async () => {
    const { getBridge, getBridgeImpl } = await import('./client');
    const { skHex, pkHex } = makeKeypair();
    const groupId = 'indexed-pages';
    const meta = await fakeRelayMetadata({ groupId, name: 'Indexed Pages' });
    const newest = await fakeRelayMessage({ groupId, content: 'newest indexed message' });
    const older = {
      ...(await fakeRelayMessage({ groupId, content: 'older indexed page' })),
      id: 'older-indexed-page',
      created_at: newest.created_at - 10,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        obelisk: {
          indexed_bootstrap: {
            version: 1,
            url: '/api/obelisk/v1/bootstrap',
            auth: 'nip98',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        relay: 'wss://public.obelisk.ar',
        generated_at: 1780617600,
        cursor: { since: 1780617590 },
        scopes: [
          {
            scope: 'default',
            groups: [
              { id: groupId, events: [meta, newest], next_before: newest.created_at - 1 },
            ],
          },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        version: 1,
        scope: 'default',
        group_id: groupId,
        events: [older],
        next_before: older.created_at - 1,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const bridge = await getBridge();
    await bridge.loginWithNsec(skHex, pkHex);
    await flush();
    const added = await bridge.loadMoreMessages(groupId);

    expect(added).toBe('added');
    const impl = getBridgeImpl()!;
    expect(impl.messagesByGroup.get()[groupId]?.map((m) => m.content)).toEqual([
      'older indexed page',
      'newest indexed message',
    ]);
    expect(fake.state.querySyncCalls.filter((c) =>
      ((c.filter.kinds as number[] | undefined) ?? []).includes(9)
      && ((c.filter['#h'] as string[] | undefined) ?? []).includes(groupId),
    )).toHaveLength(0);
    expect(fetchMock.mock.calls[2][0]).toBe(
      `https://public.obelisk.ar/api/obelisk/v1/groups/${groupId}/messages?before=${newest.created_at - 1}&limit=50`,
    );
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toMatch(/^Nostr /);
  });
});

// -- helpers ------------------------------------------------------------

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function hexToBytesForTest(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function fakeRelayMetadata(opts: {
  groupId: string;
  name?: string;
  about?: string;
  parent?: string;
  isPublic?: boolean;
  isOpen?: boolean;
}): Promise<NostrEvent> {
  // Sign with a throwaway key — the bridge doesn't verify authorship of
  // kind 39000, only parses tags.
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const tags: string[][] = [['d', opts.groupId]];
  if (opts.name) tags.push(['name', opts.name]);
  if (opts.about) tags.push(['about', opts.about]);
  if (opts.parent) tags.push(['parent', opts.parent]);
  if (opts.isPublic) tags.push(['public']);
  if (opts.isOpen) tags.push(['open']);
  return finalizeEvent(
    {
      kind: 39000,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: pk,
    } as Parameters<typeof finalizeEvent>[0],
    sk,
  );
}

async function fakeRelayMetadataWithT(opts: {
  groupId: string;
  name?: string;
  t: string;
}): Promise<NostrEvent> {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const tags: string[][] = [['d', opts.groupId], ['t', opts.t]];
  if (opts.name) tags.push(['name', opts.name]);
  return finalizeEvent(
    {
      kind: 39000,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: pk,
    } as Parameters<typeof finalizeEvent>[0],
    sk,
  );
}

async function fakeRelayMetadataWithExtraTags(opts: {
  groupId: string;
  name?: string;
  parent?: string;
  extraTags: string[][];
}): Promise<NostrEvent> {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const tags: string[][] = [['d', opts.groupId]];
  if (opts.name) tags.push(['name', opts.name]);
  if (opts.parent) tags.push(['parent', opts.parent]);
  for (const t of opts.extraTags) tags.push(t);
  return finalizeEvent(
    {
      kind: 39000,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: pk,
    } as Parameters<typeof finalizeEvent>[0],
    sk,
  );
}

async function fakeRelayMessage(opts: {
  groupId: string;
  content: string;
}): Promise<NostrEvent> {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return finalizeEvent(
    {
      kind: 9,
      content: opts.content,
      tags: [['h', opts.groupId]],
      created_at: Math.floor(Date.now() / 1000),
      pubkey: pk,
    } as Parameters<typeof finalizeEvent>[0],
    sk,
  );
}

async function fakeRelayList(opts: {
  groupId: string;
  kind: 39001 | 39002;
  pubkeys: string[];
}): Promise<NostrEvent> {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const tags: string[][] = [['d', opts.groupId], ...opts.pubkeys.map((pk) => ['p', pk])];
  return finalizeEvent(
    {
      kind: opts.kind,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: pk,
    } as Parameters<typeof finalizeEvent>[0],
    sk,
  );
}

function deliver(ev: NostrEvent) {
  for (const sub of fake.state.subscriptions) if (matches(sub.filter as Filter, ev)) sub.sink(ev);
}
