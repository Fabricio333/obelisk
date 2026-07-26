import { beforeEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: vi.fn().mockResolvedValue({}),
  getBridgeImpl: () => ({ publishEvent: mocks.publishEvent }),
}));
import type { Event as NostrEvent } from 'nostr-tools';
import { publishLayout, relayOperatorAuthors } from './channel-layout';
import { parseBranding, publishBranding, toTags, EMPTY_BRANDING, type RelayBranding } from './relay-branding';

const RELAY = 'wss://relay.example';

function fakeEvent(tags: string[][], created_at = 1000): NostrEvent {
  return {
    id: 'x',
    pubkey: 'p',
    created_at,
    kind: 30078,
    tags,
    content: '',
    sig: 's',
  } as NostrEvent;
}

describe('relay-branding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('trusts only the advertised relay operator for server-wide settings', () => {
    expect(relayOperatorAuthors('operator')).toEqual(['operator']);
    expect(relayOperatorAuthors(null)).toEqual([]);
  });

  it('publishes per-relay kind 30078 documents only to their requested relay', async () => {
    await publishLayout(RELAY, { categories: [], channels: [], updatedAt: 0 });
    await publishBranding(RELAY, EMPTY_BRANDING);

    expect(mocks.publishEvent).toHaveBeenCalledTimes(2);
    expect(mocks.publishEvent.mock.calls.every((call) =>
      call[1]?.mode === 'replace' && call[1]?.extraRelays?.[0] === RELAY
    )).toBe(true);
  });
  it('parses tags into branding fields', () => {
    const ev = fakeEvent([
      ['d', `obelisk:branding:${RELAY}`],
      ['icon', 'https://e/i.png'],
      ['banner', 'https://e/b.png'],
      ['name', 'Relay Name'],
      ['description', 'A relay'],
    ]);
    expect(parseBranding(ev)).toEqual({
      icon: 'https://e/i.png',
      banner: 'https://e/b.png',
      name: 'Relay Name',
      description: 'A relay',
      updatedAt: 1000,
    });
  });

  it('handles missing fields', () => {
    const ev = fakeEvent([['d', `obelisk:branding:${RELAY}`]]);
    expect(parseBranding(ev)).toEqual({ ...EMPTY_BRANDING, updatedAt: 1000 });
  });

  it('round-trips via toTags + parseBranding', () => {
    const b: RelayBranding = {
      icon: 'i', banner: 'b', name: 'n', description: 'd', updatedAt: 42,
    };
    const tags = toTags(b, RELAY);
    expect(tags[0]).toEqual(['d', `obelisk:branding:${RELAY}`]);
    const parsed = parseBranding(fakeEvent(tags, 42));
    expect(parsed).toEqual(b);
  });

  it('omits empty fields from tags', () => {
    const tags = toTags({ ...EMPTY_BRANDING, icon: 'i', updatedAt: 0 }, RELAY);
    const keys = tags.map((t) => t[0]);
    expect(keys).toEqual(['d', 'icon']);
  });
});
