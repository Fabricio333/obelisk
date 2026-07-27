import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  mediaFavoriteTags,
  mediaItemsFromPacks,
  mediaPackAddress,
  mediaPackTags,
  parseMediaFavorites,
  parseMediaPack,
} from './media-packs';

const author = 'a'.repeat(64);
const event = (kind: number, tags: string[][]): NostrEvent => ({
  id: 'id',
  sig: 'sig',
  pubkey: author,
  created_at: 42,
  kind,
  tags,
  content: '',
});

describe('media packs', () => {
  it('round-trips editable NIP-51 packs with emoji, GIF, and sticker types', () => {
    const tags = mediaPackTags({
      identifier: 'party',
      title: 'Party pack',
      description: 'For loud chats',
      image: '',
      items: [
        { name: 'wave', url: 'https://cdn.example/wave.webp', kind: 'emoji' },
        { name: 'dance', url: 'https://cdn.example/dance.gif', kind: 'gif' },
        { name: 'cat', url: 'https://cdn.example/cat.webp', kind: 'sticker' },
      ],
    }, author);

    expect(parseMediaPack(event(30030, tags))).toMatchObject({
      address: mediaPackAddress(author, 'party'),
      title: 'Party pack',
      items: [
        { name: 'cat', kind: 'sticker' },
        { name: 'dance', kind: 'gif' },
        { name: 'wave', kind: 'emoji' },
      ],
    });
  });

  it('stores individual favorites and whole-pack references in kind 10030 tags', () => {
    const address = mediaPackAddress(author, 'party');
    const tags = mediaFavoriteTags({
      packAddresses: [address],
      items: [{ name: 'only_this', url: 'https://cdn.example/one.webp', kind: 'sticker', packAddress: address }],
      createdAt: 0,
    });
    const parsed = parseMediaFavorites(event(10030, tags));

    expect(parsed.packAddresses).toEqual([address]);
    expect(parsed.items).toEqual([
      { name: 'only_this', url: 'https://cdn.example/one.webp', kind: 'sticker', packAddress: address },
    ]);
  });

  it('flattens favorited packs without duplicating the same asset', () => {
    const address = mediaPackAddress(author, 'party');
    const item = { name: 'wave', url: 'https://cdn.example/wave.webp', kind: 'emoji' as const };
    expect(mediaItemsFromPacks([address, address], {
      [address]: {
        address,
        identifier: 'party',
        author,
        title: 'Party',
        description: '',
        image: '',
        items: [item],
        createdAt: 1,
      },
    })).toEqual([item]);
  });
});
