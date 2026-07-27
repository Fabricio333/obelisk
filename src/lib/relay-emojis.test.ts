import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  parseRelayEmojiSet,
  relayEmojiMap,
  relayMediaKindMap,
  resolveRelayEmojiSet,
  publishRelayEmojiSet,
  subscribeRelayEmojiSet,
  relayEmojiSetDTag,
  relayEmojiSetFromMap,
  toRelayEmojiSetTags,
} from '@/lib/relay-emojis';

const bridgeMocks = vi.hoisted(() => ({
  publishEvent: vi.fn(async (template: { kind: number; content: string; tags: string[][]; created_at: number }) => ({
    ...template,
    id: 'published-id',
    pubkey: 'b'.repeat(64),
    sig: 'sig',
  })),
  subscribeFilterWatched: vi.fn(),
}));

vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: vi.fn().mockResolvedValue({}),
  getBridgeImpl: () => ({ publishEvent: bridgeMocks.publishEvent, subscribeFilterWatched: bridgeMocks.subscribeFilterWatched }),
}));

function event(tags: string[][]): NostrEvent {
  return {
    id: 'event-id',
    pubkey: 'author-pubkey',
    created_at: 123,
    kind: 30030,
    tags,
    content: '',
    sig: 'sig',
  };
}

describe('relay emoji sets', () => {
  beforeEach(() => {
    localStorage.clear();
    bridgeMocks.publishEvent.mockClear();
    bridgeMocks.subscribeFilterWatched.mockReset();
  });

  it('uses a relay-scoped deterministic d tag', () => {
    expect(relayEmojiSetDTag('wss://relay.example')).toBe('obelisk:emojis:wss://relay.example');
  });

  it('parses NIP-51 emoji set tags into a normalized relay emoji set', () => {
    const set = parseRelayEmojiSet(event([
      ['d', relayEmojiSetDTag('wss://relay.example')],
      ['title', 'Relay pack'],
      ['emoji', 'Party-Parrot', 'https://example.com/party.webp'],
      ['media', 'Party-Parrot', 'sticker'],
      ['emoji', 'wave', 'https://example.com/wave.webp'],
      ['media', 'wave', 'emoji'],
      ['emoji', 'missing-url'],
    ]));

    expect(set).toEqual({
      title: 'Relay pack',
      emojis: [
        { name: 'party_parrot', url: 'https://example.com/party.webp', kind: 'sticker' },
        { name: 'wave', url: 'https://example.com/wave.webp', kind: 'emoji' },
      ],
      packAddresses: [],
      updatedAt: 123,
      author: 'author-pubkey',
      eventId: 'event-id',
    });
    expect(relayEmojiMap(set)).toEqual({
      party_parrot: 'https://example.com/party.webp',
      wave: 'https://example.com/wave.webp',
    });
    expect(relayMediaKindMap(set)).toEqual({ party_parrot: 'sticker', wave: 'emoji' });
  });

  it('serializes a set as NIP-51 emoji tags for the target relay', () => {
    const set = relayEmojiSetFromMap({
      party: 'https://example.com/party.webp',
      Wave: 'https://example.com/wave.webp',
    });

    expect(toRelayEmojiSetTags(set, 'wss://relay-two.example')).toEqual([
      ['d', 'obelisk:emojis:wss://relay-two.example'],
      ['title', 'Obelisk emojis'],
      ['emoji', 'party', 'https://example.com/party.webp'],
      ['media', 'party', 'emoji'],
      ['emoji', 'wave', 'https://example.com/wave.webp'],
      ['media', 'wave', 'emoji'],
    ]);
  });
  it('uses the NIP-01 lowest-id tie-break for same-second relay lists', () => {
    bridgeMocks.subscribeFilterWatched.mockReturnValue(() => {});
    const onChange = vi.fn();
    subscribeRelayEmojiSet('wss://tie.example', ['b'.repeat(64)], onChange);
    const onEvent = bridgeMocks.subscribeFilterWatched.mock.calls[0][1] as (value: NostrEvent) => void;
    const tags = [['d', relayEmojiSetDTag('wss://tie.example')]];

    onEvent({ ...event(tags), id: 'f'.repeat(64), created_at: 500 });
    onEvent({ ...event(tags), id: 'a'.repeat(64), created_at: 500 });
    onEvent({ ...event(tags), id: 'z'.repeat(64), created_at: 500 });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ eventId: 'a'.repeat(64) }));
  });

  it('resolves selected pack addresses to the latest pack contents', () => {
    const address = '30030:' + 'a'.repeat(64) + ':cats';
    const set = parseRelayEmojiSet(event([
      ['d', relayEmojiSetDTag('wss://relay.example')],
      ['a', address],
    ]));
    const resolved = resolveRelayEmojiSet(set, {
      [address]: {
        address,
        identifier: 'cats',
        author: 'a'.repeat(64),
        title: 'Cats',
        description: '',
        image: '',
        items: [{ name: 'new_cat', url: 'https://example.com/new.webp', kind: 'sticker' as const }],
        createdAt: 456,
      },
    });

    expect(set.packAddresses).toEqual([address]);
    expect(resolved.emojis).toEqual([{ name: 'new_cat', url: 'https://example.com/new.webp', kind: 'sticker' }]);
    expect(toRelayEmojiSetTags(set, 'wss://relay.example')).toContainEqual(['a', address]);
  });

  it('publishes every server-list replacement with a strictly newer timestamp', async () => {
    const updatedAt = Math.floor(Date.now() / 1000) + 100;
    const set = { title: 'Server favorites', emojis: [], packAddresses: [], updatedAt };

    await publishRelayEmojiSet('wss://monotonic.example', set);
    await publishRelayEmojiSet('wss://monotonic.example', set);

    expect(bridgeMocks.publishEvent.mock.calls[0][0]).toEqual(expect.objectContaining({ created_at: updatedAt + 1 }));
    expect(bridgeMocks.publishEvent.mock.calls[1][0]).toEqual(expect.objectContaining({ created_at: updatedAt + 2 }));
  });
});
