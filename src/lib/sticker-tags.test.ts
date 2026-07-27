import { describe, expect, it } from 'vitest';
import { stickerFromTags, stickerTagsForContent } from './sticker-tags';

const packAddress = '30030:' + 'a'.repeat(64) + ':cats';

describe('sticker tags', () => {
  it('adds a sticker marker plus a NIP-30 fallback', () => {
    expect(stickerTagsForContent(':party_cat:', {
      name: 'party_cat',
      url: 'https://cdn.example/party.webp',
      packAddress,
    })).toEqual([
      ['emoji', 'party_cat', 'https://cdn.example/party.webp', packAddress],
      ['sticker', 'party_cat', 'https://cdn.example/party.webp', packAddress],
    ]);
  });

  it('only parses exact sticker-only messages with safe HTTP URLs', () => {
    const tags = [['sticker', 'party_cat', 'https://cdn.example/party.webp']];
    expect(stickerFromTags(':party_cat:', tags)).toEqual({
      name: 'party_cat',
      url: 'https://cdn.example/party.webp',
    });
    expect(stickerFromTags(':party_cat:', [['sticker', 'party_cat', 'https://cdn.example/party.webp', packAddress]])).toEqual({
      name: 'party_cat',
      url: 'https://cdn.example/party.webp',
      packAddress,
    });
    expect(stickerFromTags(`hello :party_cat:`, tags)).toBeNull();
    expect(stickerFromTags(':party_cat:', [['sticker', 'party_cat', 'javascript:alert(1)']])).toBeNull();
  });
});
