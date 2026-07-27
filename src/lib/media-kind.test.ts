import { describe, expect, it } from 'vitest';
import { inferMediaKind, isStickerLikeImage } from './media-kind';

describe('media kind classification', () => {
  it('uses extensions only as a legacy fallback', () => {
    expect(inferMediaKind('https://cdn.example/reaction.gif?size=small')).toBe('gif');
    expect(inferMediaKind('https://cdn.example/sticker.webp')).toBe('emoji');
  });

  it('recognizes small transparent GIF content as sticker-like', () => {
    const pixels = new Uint8ClampedArray(100 * 4).fill(255);
    for (let index = 3; index < 12 * 4; index += 4) pixels[index] = 0;
    expect(isStickerLikeImage(256, 256, pixels)).toBe(true);
    expect(isStickerLikeImage(800, 256, pixels)).toBe(false);
    expect(isStickerLikeImage(256, 256, new Uint8ClampedArray(100 * 4).fill(255))).toBe(false);
  });
});
