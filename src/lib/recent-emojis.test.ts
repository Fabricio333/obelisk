import { beforeEach, describe, expect, it } from 'vitest';
import { loadRecentEmojis, pushRecentEmoji, saveRecentEmojis } from './recent-emojis';

const KEY = 'obelisk:recent-emojis';

describe('recent-emojis', () => {
  beforeEach(() => localStorage.clear());

  it('remembers the media URL of custom picks', () => {
    pushRecentEmoji(':party_cat:', { url: 'https://cdn.example/party_cat.gif', packAddress: '30078:abc:pack' });

    expect(loadRecentEmojis()).toEqual([
      { char: ':party_cat:', url: 'https://cdn.example/party_cat.gif', packAddress: '30078:abc:pack' },
    ]);
  });

  it('reads legacy string-only entries', () => {
    localStorage.setItem(KEY, JSON.stringify(['😀', ':wave:', '', 42]));

    expect(loadRecentEmojis()).toEqual([{ char: '😀' }, { char: ':wave:' }]);
  });

  it('keeps unicode picks stored as plain strings', () => {
    pushRecentEmoji('😀');

    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['😀']);
  });

  it('moves a repeated pick to the front without duplicating it', () => {
    pushRecentEmoji('😀');
    pushRecentEmoji(':wave:', { url: 'https://cdn.example/wave.webp' });
    const next = pushRecentEmoji('😀');

    expect(next.map((entry) => entry.char)).toEqual(['😀', ':wave:']);
  });

  it('caps the list at 24 entries', () => {
    saveRecentEmojis(Array.from({ length: 40 }, (_, index) => ({ char: `e${index}` })));

    expect(loadRecentEmojis()).toHaveLength(24);
  });
});
