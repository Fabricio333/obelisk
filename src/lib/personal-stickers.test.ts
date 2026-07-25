import { beforeEach, describe, expect, it } from 'vitest';
import { loadPersonalStickers, savePersonalSticker } from './personal-stickers';

describe('personal stickers', () => {
  beforeEach(() => localStorage.clear());

  it('persists normalized, uniquely named stickers', () => {
    savePersonalSticker('Party Cat.webp', 'https://cdn.example/one.webp');
    savePersonalSticker('Party Cat.webp', 'https://cdn.example/two.webp');

    expect(loadPersonalStickers()).toEqual({
      party_cat: 'https://cdn.example/one.webp',
      party_cat_2: 'https://cdn.example/two.webp',
    });
  });
});
