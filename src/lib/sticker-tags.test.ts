import { describe, expect, it } from 'vitest';
import { stickerFromTags, stickerTagsForContent } from './sticker-tags';

describe('sticker tags', () => {
  it('adds a sticker marker plus a NIP-30 fallback', () => {
    expect(stickerTagsForContent(':party_cat:', {
      name: 'party_cat',
      url: 'https://cdn.example/party.webp',
    })).toEqual([
      ['emoji', 'party_cat', 'https://cdn.example/party.webp'],
      ['sticker', 'party_cat', 'https://cdn.example/party.webp'],
    ]);
  });

  it('only parses exact sticker-only messages with safe HTTP URLs', () => {
    const tags = [['sticker', 'party_cat', 'https://cdn.example/party.webp']];
    expect(stickerFromTags(':party_cat:', tags)).toEqual({
      name: 'party_cat',
      url: 'https://cdn.example/party.webp',
    });
    expect(stickerFromTags(`hello :party_cat:`, tags)).toBeNull();
    expect(stickerFromTags(':party_cat:', [['sticker', 'party_cat', 'javascript:alert(1)']])).toBeNull();
  });
});
