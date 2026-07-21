import { describe, it, expect } from 'vitest';
import {
  resolveUnicodeShortcode,
  replaceShortcodes,
  searchShortcodes,
  resolveReactionEmoji,
  groupReactions,
  CUSTOM_EMOJI_PLACEHOLDER_REGEX,
} from './emoji-shortcodes';

describe('resolveUnicodeShortcode', () => {
  it('resolves curated aliases', () => {
    expect(resolveUnicodeShortcode('+1')).toBe('👍');
    expect(resolveUnicodeShortcode('thumbsup')).toBe('👍');
    expect(resolveUnicodeShortcode('heart')).toBe('❤️');
    expect(resolveUnicodeShortcode('fire')).toBe('🔥');
  });

  it('returns null for unknown names', () => {
    expect(resolveUnicodeShortcode('definitely-not-a-real-emoji')).toBe(null);
  });

  it('is case-insensitive', () => {
    expect(resolveUnicodeShortcode('FIRE')).toBe('🔥');
    expect(resolveUnicodeShortcode('Fire')).toBe('🔥');
  });
});

describe('replaceShortcodes', () => {
  it('replaces unicode shortcodes inline', () => {
    expect(replaceShortcodes('this is :fire: today')).toBe('this is 🔥 today');
  });

  it('replaces multiple shortcodes on one line', () => {
    expect(replaceShortcodes(':fire: and :heart: and :thumbsup:')).toBe('🔥 and ❤️ and 👍');
  });

  it('leaves unknown shortcodes as literal text', () => {
    expect(replaceShortcodes('hello :definitely-not-real: world')).toBe(
      'hello :definitely-not-real: world',
    );
  });

  it('does not touch shortcodes inside URLs', () => {
    // The shortcode regex requires whitespace/start before the `:`, so colons
    // embedded in URLs don't trigger.
    expect(replaceShortcodes('check http://x.com/:colon:')).toBe(
      'check http://x.com/:colon:',
    );
  });

  it('preserves shortcodes inside inline code spans', () => {
    expect(replaceShortcodes('here is `:fire:` literal')).toBe(
      'here is `:fire:` literal',
    );
  });

  it('preserves shortcodes inside fenced code blocks', () => {
    const input = 'before\n```\n:fire: stays literal\n```\nafter :fire:';
    expect(replaceShortcodes(input)).toBe(
      'before\n```\n:fire: stays literal\n```\nafter 🔥',
    );
  });

  it('emits custom-emoji placeholders for server-specific names', () => {
    const out = replaceShortcodes('hype :partyparrot: yes', {
      partyparrot: '/uploads/abc.png',
    });
    expect(out).toContain('\u3008EMOJI:partyparrot\u3009');
    CUSTOM_EMOJI_PLACEHOLDER_REGEX.lastIndex = 0;
    const match = CUSTOM_EMOJI_PLACEHOLDER_REGEX.exec(out);
    expect(match?.[1]).toBe('partyparrot');
  });

  it('short-circuits on strings with no colon', () => {
    expect(replaceShortcodes('no shortcodes here')).toBe('no shortcodes here');
  });
});

describe('searchShortcodes', () => {
  it('returns prefix matches first, alphabetically', () => {
    const results = searchShortcodes('fi');
    const names = results.map((r) => r.name);
    expect(names).toContain('fire');
    expect(names[0].startsWith('fi')).toBe(true);
  });

  it('prioritizes custom emojis over unicode', () => {
    const results = searchShortcodes('fi', { fish: '/uploads/fish.png' });
    expect(results[0].name).toBe('fish');
    expect(results[0].isCustom).toBe(true);
  });

  it('respects the limit argument', () => {
    expect(searchShortcodes('a', {}, 3).length).toBeLessThanOrEqual(3);
  });
});

describe('resolveReactionEmoji', () => {
  it('returns unicode char for non-shortcode strings', () => {
    expect(resolveReactionEmoji('🔥')).toEqual({ kind: 'unicode', char: '🔥' });
  });

  it('resolves unicode shortcodes', () => {
    expect(resolveReactionEmoji(':fire:')).toEqual({
      kind: 'unicode',
      char: '🔥',
    });
  });

  it('resolves custom reactions', () => {
    const out = resolveReactionEmoji(':parrot:', { parrot: '/uploads/p.png' });
    expect(out).toEqual({
      kind: 'custom',
      name: 'parrot',
      url: '/uploads/p.png',
    });
  });

  it('falls back to literal for unknown shortcodes', () => {
    expect(resolveReactionEmoji(':notreal:')).toEqual({
      kind: 'unicode',
      char: ':notreal:',
    });
  });
});

describe('groupReactions', () => {
  it('deduplicates relay echoes by author and resolves custom emoji', () => {
    const grouped = groupReactions([
      { id: '1', pubkey: 'me', emoji: '🔥' },
      { id: '2', pubkey: 'me', emoji: '🔥' },
      { id: '3', pubkey: 'other', emoji: ':party:', customEmojis: { party: 'https://cdn/party.png' } },
    ], 'me', {});

    expect(grouped).toHaveLength(2);
    expect(grouped.find((item) => item.emoji === '🔥')).toMatchObject({ count: 1, mine: true });
    expect(grouped.find((item) => item.emoji === ':party:')?.customEmojis).toEqual({
      party: 'https://cdn/party.png',
    });
  });
});
