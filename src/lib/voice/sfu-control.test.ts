/**
 * Tests for the SFU control + discovery surface.
 *
 * The bridge (`@/lib/nostr-bridge/client`) is mocked with a thin in-memory
 * version that captures `publishEvent` calls and feeds back any events
 * "delivered" through `bridgeFake.inject`. This mirrors the pattern in
 * `transport.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KIND_SFU_ADVERTISE, KIND_SFU_CONTROL } from '@/lib/nip-kinds';

interface FakeEvent {
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  id: string;
  sig: string;
}

interface SubFilter { kinds?: number[]; '#e'?: string[]; '#p'?: string[]; since?: number }

const bridgeFake = vi.hoisted(() => {
  const subs: { filter: SubFilter; sink: (ev: FakeEvent) => void }[] = [];
  const publishCalls: { template: { kind: number; content: string; tags: string[][] }; extraRelays: string[] }[] = [];
  let publishImpl: (() => Promise<void>) | null = null;

  function matches(filter: SubFilter, ev: FakeEvent): boolean {
    if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
    return true;
  }

  const impl = {
    getPublicKey: () => 'self-pk',
    publishEvent: vi.fn(async (
      template: { kind: number; content: string; tags: string[][] },
      opts: { extraRelays?: string[]; mode?: string } | string[] = {},
    ) => {
      // Bridge contract evolved from positional `string[]` → opts object.
      // Unwrap so existing assertions keep reading `extraRelays` as an array.
      const extraRelays = Array.isArray(opts) ? opts : (opts.extraRelays ?? []);
      publishCalls.push({ template, extraRelays });
      if (publishImpl) await publishImpl();
    }),
    subscribeFilter: vi.fn((filter: SubFilter, sink: (ev: FakeEvent) => void) => {
      const sub = { filter, sink };
      subs.push(sub);
      return () => { const i = subs.indexOf(sub); if (i >= 0) subs.splice(i, 1); };
    }),
    subscribeFilterWatched: vi.fn((filter: SubFilter, sink: (ev: FakeEvent) => void) => {
      const sub = { filter, sink };
      subs.push(sub);
      return () => { const i = subs.indexOf(sub); if (i >= 0) subs.splice(i, 1); };
    }),
  };

  return {
    impl,
    publishCalls,
    inject: (ev: FakeEvent) => {
      for (const s of subs) if (matches(s.filter, ev)) s.sink(ev);
    },
    setPublishImpl: (fn: (() => Promise<void>) | null) => { publishImpl = fn; },
    reset: () => {
      subs.length = 0;
      publishCalls.length = 0;
      publishImpl = null;
      impl.publishEvent.mockClear();
      impl.subscribeFilter.mockClear();
      impl.subscribeFilterWatched.mockClear();
    },
  };
});

vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: vi.fn(async () => bridgeFake.impl),
  getBridgeImpl: vi.fn(() => bridgeFake.impl),
  // Test mock — accept anything that looks like a wss URL. The real
  // helper rejects localhost/loopback/RFC-1918; the test fixtures
  // already use public wss:// hosts so any reasonable filter passes.
  isImportableRelayUrl: vi.fn((u: string) => typeof u === 'string' && u.startsWith('wss://')),
}));

import {
  __testing,
  ensureSfuRoomStarted,
  parseAdvertisement,
  pickSfu,
  publishSfuStart,
} from './sfu-control';

const SFU_PUBKEY = 'a'.repeat(64);
const CHANNEL_ID = 'b'.repeat(64);

function makeAdvertisement(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    pubkey: SFU_PUBKEY,
    kind: KIND_SFU_ADVERTISE,
    content: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', 'obelisk-sfu'],
      ['url', 'https://sfu.obelisk.ar'],
      ['relay', 'wss://public.obelisk.ar'],
      ['trusted_relay', 'wss://lacrypta-relay.obelisk.ar'],
      ['cap', '50'],
      ['region', 'eu-central'],
    ],
    id: 'ad-1',
    sig: 'fake-sig',
    ...overrides,
  };
}

beforeEach(() => {
  bridgeFake.reset();
  __testing.reset();
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseAdvertisement', () => {
  it('extracts url, region, cap, and relay tag arrays', () => {
    const ev = makeAdvertisement();
    const ad = parseAdvertisement(ev);
    expect(ad.pubkey).toBe(SFU_PUBKEY);
    expect(ad.url).toBe('https://sfu.obelisk.ar');
    expect(ad.region).toBe('eu-central');
    expect(ad.cap).toBe(50);
    expect(ad.trustedRelays).toEqual(['wss://lacrypta-relay.obelisk.ar']);
    expect(ad.generalRelays).toEqual(['wss://public.obelisk.ar']);
  });

  it('returns null fields and empty arrays when tags absent', () => {
    const ev = makeAdvertisement({ tags: [['d', 'obelisk-sfu']] });
    const ad = parseAdvertisement(ev);
    expect(ad.url).toBeNull();
    expect(ad.region).toBeNull();
    expect(ad.cap).toBeNull();
    expect(ad.trustedRelays).toEqual([]);
    expect(ad.generalRelays).toEqual([]);
  });

  it('preserves multiple trusted_relay / relay tags', () => {
    const ev = makeAdvertisement({
      tags: [
        ['d', 'obelisk-sfu'],
        ['trusted_relay', 'wss://relay.a'],
        ['trusted_relay', 'wss://relay.b'],
        ['relay', 'wss://r1'],
        ['relay', 'wss://r2'],
      ],
    });
    const ad = parseAdvertisement(ev);
    expect(ad.trustedRelays).toEqual(['wss://relay.a', 'wss://relay.b']);
    expect(ad.generalRelays).toEqual(['wss://r1', 'wss://r2']);
  });
});

describe('pickSfu', () => {
  it('returns null when no advertisement has been seen', async () => {
    const promise = pickSfu();
    // Cold-cache wait fires inside pickSfu; skip past it.
    await vi.advanceTimersByTimeAsync(2000);
    const ad = await promise;
    expect(ad).toBeNull();
  });

  it('returns an advertisement once it is ingested', async () => {
    __testing.ingest(makeAdvertisement());
    const ad = await pickSfu();
    expect(ad?.pubkey).toBe(SFU_PUBKEY);
  });

  it('returns the newest of multiple advertisements', async () => {
    __testing.ingest(makeAdvertisement({ pubkey: 'old', created_at: 100, id: 'old' }));
    __testing.ingest(makeAdvertisement({ pubkey: 'new', created_at: 200, id: 'new' }));
    const ad = await pickSfu();
    expect(ad?.pubkey).toBe('new');
  });

  it('keeps the newest advertisement per pubkey on re-ingest', async () => {
    __testing.ingest(makeAdvertisement({ created_at: 100, tags: [['url', 'https://old']] }));
    __testing.ingest(makeAdvertisement({ created_at: 200, tags: [['url', 'https://new']] }));
    const ad = await pickSfu();
    expect(ad?.url).toBe('https://new');
  });

  it('opens a single subscription regardless of how many callers ask', async () => {
    __testing.ingest(makeAdvertisement());
    await Promise.all([pickSfu(), pickSfu(), pickSfu()]);
    expect(bridgeFake.impl.subscribeFilter).toHaveBeenCalledTimes(1);
  });
});

describe('publishSfuStart', () => {
  it('publishes kind 25052 with the expected tags and content', async () => {
    const ok = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    expect(ok).toBe(true);
    expect(bridgeFake.publishCalls).toHaveLength(1);
    const { template, extraRelays } = bridgeFake.publishCalls[0];
    expect(template.kind).toBe(KIND_SFU_CONTROL);

    // Tag set must include p, e, t, expiration.
    const tagMap = new Map(template.tags.map((t) => [t[0], t[1]] as const));
    expect(tagMap.get('p')).toBe(SFU_PUBKEY);
    expect(tagMap.get('e')).toBe(CHANNEL_ID);
    expect(tagMap.get('t')).toBe('obelisk-sfu-control');
    const exp = Number(tagMap.get('expiration'));
    const now = Math.floor(Date.now() / 1000);
    expect(exp).toBeGreaterThan(now);
    expect(exp).toBeLessThanOrEqual(now + 120);

    const body = JSON.parse(template.content);
    expect(body.action).toBe('start');
    expect(body.params).toMatchObject({ video: true, screen: true, maxParticipants: 50 });

    // No advertised trustedRelays passed in → falls back to lacrypta-relay.obelisk.ar.
    expect(extraRelays).toEqual(['wss://lacrypta-relay.obelisk.ar']);
  });

  it('respects an explicit trustedRelays override', async () => {
    await publishSfuStart(CHANNEL_ID, SFU_PUBKEY, {
      trustedRelays: ['wss://my.relay', 'wss://another.relay'],
    });
    expect(bridgeFake.publishCalls[0].extraRelays).toEqual([
      'wss://my.relay',
      'wss://another.relay',
    ]);
  });

  it('rate-limits repeat publishes within 30 seconds', async () => {
    const first = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    const second = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(bridgeFake.publishCalls).toHaveLength(1);
  });

  it('does not rate-limit a different channel', async () => {
    await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    const ok = await publishSfuStart('c'.repeat(64), SFU_PUBKEY);
    expect(ok).toBe(true);
    expect(bridgeFake.publishCalls).toHaveLength(2);
  });

  it('does not rate-limit a different SFU', async () => {
    await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    const ok = await publishSfuStart(CHANNEL_ID, 'd'.repeat(64));
    expect(ok).toBe(true);
    expect(bridgeFake.publishCalls).toHaveLength(2);
  });

  it('returns false and frees the rate-limit slot on publish failure', async () => {
    bridgeFake.setPublishImpl(async () => { throw new Error('relay down'); });
    const first = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    expect(first).toBe(false);

    // Slot was freed → next attempt is allowed (and it succeeds because we
    // clear the failure injection).
    bridgeFake.setPublishImpl(null);
    const second = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    expect(second).toBe(true);
  });

  it('passes through video/screen/maxParticipants params to content', async () => {
    await publishSfuStart(CHANNEL_ID, SFU_PUBKEY, {
      params: { video: false, screen: false, maxParticipants: 12 },
    });
    const body = JSON.parse(bridgeFake.publishCalls[0].template.content);
    expect(body.params).toEqual({ video: false, screen: false, maxParticipants: 12 });
  });
});

describe('ensureSfuRoomStarted', () => {
  // `pickSfu(channelId)` waits twice for a cold cache: once inside
  // `resolveSfuPin` (kind 30078 channel pin) and once inside its own kind
  // 31313 advertisement gate. Both are 1500 ms with `setTimeout`, so 3500
  // ms covers both with headroom — the test fake timers don't advance
  // unless we explicitly tick them.
  const COLD_WAIT_MS = 3500;

  it('returns null and does not publish when no SFU is known', async () => {
    const promise = ensureSfuRoomStarted(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const result = await promise;
    expect(result).toBeNull();
    expect(bridgeFake.publishCalls).toHaveLength(0);
  });

  it('discovers an SFU and publishes a start to its trusted relays', async () => {
    __testing.ingest(makeAdvertisement({
      tags: [
        ['url', 'https://sfu.obelisk.ar'],
        ['trusted_relay', 'wss://lacrypta-relay.obelisk.ar'],
        ['cap', '50'],
      ],
    }));
    const promise = ensureSfuRoomStarted(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const sfu = await promise;
    expect(sfu).toBe(SFU_PUBKEY);
    expect(bridgeFake.publishCalls).toHaveLength(1);
    const call = bridgeFake.publishCalls[0];
    expect(call.template.kind).toBe(KIND_SFU_CONTROL);
    expect(call.extraRelays).toEqual(['wss://lacrypta-relay.obelisk.ar']);
  });

  it('rate-limited second call returns null (already-started case)', async () => {
    __testing.ingest(makeAdvertisement());
    const aPromise = ensureSfuRoomStarted(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const a = await aPromise;
    const bPromise = ensureSfuRoomStarted(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const b = await bPromise;
    expect(a).toBe(SFU_PUBKEY);
    expect(b).toBeNull();
    expect(bridgeFake.publishCalls).toHaveLength(1);
  });

  it('forces a publish past the rate-limit when {force:true} is passed', async () => {
    __testing.ingest(makeAdvertisement());
    const aPromise = ensureSfuRoomStarted(CHANNEL_ID);
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const a = await aPromise;
    const bPromise = ensureSfuRoomStarted(CHANNEL_ID, undefined, { force: true });
    await vi.advanceTimersByTimeAsync(COLD_WAIT_MS);
    const b = await bPromise;
    expect(a).toBe(SFU_PUBKEY);
    expect(b).toBe(SFU_PUBKEY);
    expect(bridgeFake.publishCalls).toHaveLength(2);
  });
});

describe('publishSfuStart force', () => {
  it('bypasses the rate-limit when force=true', async () => {
    const a = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY);
    const b = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY); // rate-limited
    const c = await publishSfuStart(CHANNEL_ID, SFU_PUBKEY, { force: true });
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(c).toBe(true);
    expect(bridgeFake.publishCalls).toHaveLength(2);
  });
});
