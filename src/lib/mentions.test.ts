import { describe, it, expect } from 'vitest';
import { nip19 } from 'nostr-tools';
import {
  parseMentions,
  serializeMention,
  filterMembers,
  extractMentionPubkeys,
  extractMentionPubkeysFromMessage,
  contentToDisplayTokens,
  displayTokensToContent,
  shortNpub,
  hasEveryoneMention,
  relayMentionCandidates,
  detectMentionQuery,
  applyMentionToDraft,
  MemberInfo,
} from './mentions';

const members: MemberInfo[] = [
  { pubkey: 'a'.repeat(64), displayName: 'Alice' },
  { pubkey: 'b'.repeat(64), displayName: 'Bob' },
  { pubkey: 'c'.repeat(64), displayName: 'Charlie' },
];

describe('serializeMention', () => {
  it('creates nostr:npub1<pubkey> format', () => {
    expect(serializeMention('a'.repeat(64))).toBe(`nostr:npub1${'a'.repeat(64)}`);
  });
});

describe('parseMentions', () => {
  it('returns single text segment for plain text', () => {
    const result = parseMentions('hello world', members);
    expect(result).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('parses a mention in the middle of text', () => {
    const content = `hey nostr:npub1${'a'.repeat(64)} check this`;
    const result = parseMentions(content, members);
    expect(result).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'mention', pubkey: 'a'.repeat(64), displayName: 'Alice' },
      { type: 'text', text: ' check this' },
    ]);
  });

  it('parses multiple mentions', () => {
    const content = `nostr:npub1${'a'.repeat(64)} and nostr:npub1${'b'.repeat(64)}`;
    const result = parseMentions(content, members);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'mention', pubkey: 'a'.repeat(64), displayName: 'Alice' });
    expect(result[1]).toEqual({ type: 'text', text: ' and ' });
    expect(result[2]).toEqual({ type: 'mention', pubkey: 'b'.repeat(64), displayName: 'Bob' });
  });

  it('shows truncated npub for unknown members', () => {
    const unknownPk = 'd'.repeat(64);
    const content = `nostr:npub1${unknownPk}`;
    const result = parseMentions(content, members);
    expect(result[0]).toMatchObject({
      type: 'mention',
      pubkey: unknownPk,
    });
    const seg = result[0] as { type: 'mention'; displayName: string };
    expect(seg.displayName.startsWith('npub1')).toBe(true);
    expect(seg.displayName.length).toBeLessThanOrEqual(12);
    expect(seg.displayName).not.toContain(unknownPk);
  });

  it('parses a real bech32 nostr:npub1 mention', () => {
    const pk = 'a'.repeat(64);
    const npub = nip19.npubEncode(pk); // real bech32 npub
    const content = `hey nostr:${npub} there`;
    const result = parseMentions(content, members);
    expect(result).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'mention', pubkey: pk, displayName: 'Alice' },
      { type: 'text', text: ' there' },
    ]);
  });

  it('parses a NIP-19 nprofile as a clickable profile mention', () => {
    const pubkey = 'c'.repeat(64);
    const nprofile = nip19.nprofileEncode({ pubkey, relays: ['wss://relay.example'] });

    expect(parseMentions(`see nostr:${nprofile}`, [])).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'mention', pubkey, displayName: shortNpub(pubkey) },
    ]);
  });

  it('parses a bare bech32 npub1 mention (no nostr: prefix)', () => {
    const pk = 'b'.repeat(64);
    const npub = nip19.npubEncode(pk);
    const content = `ping ${npub}!`;
    const result = parseMentions(content, members);
    expect(result[0]).toEqual({ type: 'text', text: 'ping ' });
    expect(result[1]).toEqual({ type: 'mention', pubkey: pk, displayName: 'Bob' });
  });

  it('roundtrips with serializeMention', () => {
    const pk = 'a'.repeat(64);
    const content = `hello ${serializeMention(pk)} world`;
    const result = parseMentions(content, members);
    expect(result).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'mention', pubkey: pk, displayName: 'Alice' },
      { type: 'text', text: ' world' },
    ]);
  });
});

describe('extractMentionPubkeys (server-safe)', () => {
  it('returns empty for plain text', () => {
    expect(extractMentionPubkeys('hello world')).toEqual([]);
  });

  it('extracts a legacy hex mention', () => {
    const pk = 'a'.repeat(64);
    expect(extractMentionPubkeys(`hi nostr:npub1${pk}`)).toEqual([pk]);
  });

  it('extracts a real bech32 nostr:npub1 mention', () => {
    const pk = 'a'.repeat(64);
    const npub = nip19.npubEncode(pk);
    expect(extractMentionPubkeys(`hey nostr:${npub} there`)).toEqual([pk]);
  });

  it('extracts a bare bech32 npub1 mention', () => {
    const pk = 'b'.repeat(64);
    const npub = nip19.npubEncode(pk);
    expect(extractMentionPubkeys(`ping ${npub}!`)).toEqual([pk]);
  });

  it('dedupes repeated mentions of the same pubkey', () => {
    const pk = 'c'.repeat(64);
    const content = `nostr:npub1${pk} and again nostr:npub1${pk}`;
    expect(extractMentionPubkeys(content)).toEqual([pk]);
  });

  it('extracts multiple distinct mentions', () => {
    const pkA = 'a'.repeat(64);
    const pkB = 'b'.repeat(64);
    const content = `nostr:npub1${pkA} and ${nip19.npubEncode(pkB)}`;
    const result = extractMentionPubkeys(content);
    expect(result).toHaveLength(2);
    expect(result).toContain(pkA);
    expect(result).toContain(pkB);
  });

  it('ignores malformed npub bodies', () => {
    // not 64 hex, not valid bech32
    expect(extractMentionPubkeys('nostr:npub1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual([]);
  });
});

describe('extractMentionPubkeysFromMessage', () => {
  const pkA = 'a'.repeat(64);
  const pkB = 'b'.repeat(64);
  const pkC = 'c'.repeat(64);

  it('returns content mentions only when tags are empty', () => {
    expect(extractMentionPubkeysFromMessage(`hi nostr:npub1${pkA}`, [])).toEqual([pkA]);
  });

  it('returns tag-only mentions when content has none', () => {
    expect(
      extractMentionPubkeysFromMessage('hello world', [['p', pkB]]),
    ).toEqual([pkB]);
  });

  it('unions content + tag mentions, deduped', () => {
    const result = extractMentionPubkeysFromMessage(
      `hi nostr:npub1${pkA} and friend`,
      [['p', pkA], ['p', pkB], ['e', pkC]], // pkA dedup; pkC is e-tag, ignored
    );
    expect(result).toHaveLength(2);
    expect(result).toContain(pkA);
    expect(result).toContain(pkB);
  });

  it('lowercases hex tag values for consistent comparison', () => {
    const upper = pkA.toUpperCase();
    const result = extractMentionPubkeysFromMessage('', [['p', upper]]);
    expect(result).toEqual([pkA]);
  });

  it('ignores p-tags whose value is not 64-hex (npub strings, garbage)', () => {
    const result = extractMentionPubkeysFromMessage('', [
      ['p', `npub1${pkA}`],
      ['p', 'not-a-pubkey'],
      ['p', pkB],
    ]);
    expect(result).toEqual([pkB]);
  });
});

describe('hasEveryoneMention', () => {
  it('matches a bare @everyone', () => {
    expect(hasEveryoneMention('@everyone')).toBe(true);
  });

  it('matches @everyone mid-sentence', () => {
    expect(hasEveryoneMention('hey @everyone check this')).toBe(true);
    expect(hasEveryoneMention('heads up @everyone!')).toBe(true);
  });

  it('does not match when embedded in a word', () => {
    expect(hasEveryoneMention('@everyones')).toBe(false);
    expect(hasEveryoneMention('@everyone_thing')).toBe(false);
  });

  it('does not match when preceded by word chars or another @', () => {
    expect(hasEveryoneMention('foo@everyone')).toBe(false);
    expect(hasEveryoneMention('@@everyone')).toBe(false);
  });

  it('does not match domain-like strings', () => {
    expect(hasEveryoneMention('@everyone.com')).toBe(false);
  });

  it('returns false for plain text', () => {
    expect(hasEveryoneMention('nothing to see here')).toBe(false);
  });
});

describe('shortNpub', () => {
  it('returns a short npub1-prefixed label', () => {
    const pk = 'a'.repeat(64);
    const out = shortNpub(pk);
    expect(out.startsWith('npub1')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12);
    expect(out).not.toContain(pk);
  });
});

describe('contentToDisplayTokens / displayTokensToContent', () => {
  const members: MemberInfo[] = [
    { pubkey: 'a'.repeat(64), displayName: 'Alice' },
    { pubkey: 'b'.repeat(64), displayName: 'Bob' },
    // Two different pubkeys that happen to share the same display name.
    // `c`-pubkey is in the members list as "Charlie"; a second user named
    // "Charlie" with a different pubkey exercises the collision path.
    { pubkey: 'c'.repeat(64), displayName: 'Charlie' },
    { pubkey: 'd'.repeat(64), displayName: 'Charlie' },
  ];

  it('replaces a hex mention with a @DisplayName token', () => {
    const content = `hi nostr:npub1${'a'.repeat(64)} welcome`;
    const { display, map } = contentToDisplayTokens(content, members);
    expect(display).toBe('hi @Alice welcome');
    expect(map.get('@Alice')).toBe(serializeMention('a'.repeat(64)));
  });

  it('round-trips a hex mention back to canonical form', () => {
    const canonical = `hi ${serializeMention('a'.repeat(64))} welcome`;
    const { display, map } = contentToDisplayTokens(canonical, members);
    expect(displayTokensToContent(display, map)).toBe(canonical);
  });

  it('round-trips a real bech32 npub mention to canonical hex form', () => {
    const pk = 'b'.repeat(64);
    const bech = nip19.npubEncode(pk);
    const content = `ping nostr:${bech}!`;
    const { display, map } = contentToDisplayTokens(content, members);
    expect(display).toBe('ping @Bob!');
    // Canonicalized to hex form regardless of input.
    expect(displayTokensToContent(display, map)).toBe(`ping ${serializeMention(pk)}!`);
  });

  it('falls back to shortNpub for unknown members', () => {
    const unknown = 'e'.repeat(64);
    const content = `yo nostr:npub1${unknown}`;
    const { display, map } = contentToDisplayTokens(content, members);
    expect(display.startsWith('yo @npub1')).toBe(true);
    // Ends with the ellipsis used by shortNpub.
    expect(display).toContain('…');
    expect([...map.values()]).toEqual([serializeMention(unknown)]);
  });

  it('disambiguates display-name collisions with #N suffixes', () => {
    const content = `nostr:npub1${'c'.repeat(64)} and nostr:npub1${'d'.repeat(64)}`;
    const { display, map } = contentToDisplayTokens(content, members);
    expect(display).toBe('@Charlie and @Charlie#2');
    expect(map.get('@Charlie')).toBe(serializeMention('c'.repeat(64)));
    expect(map.get('@Charlie#2')).toBe(serializeMention('d'.repeat(64)));
    // Re-serialization must replace the #2 token distinctly from the bare one.
    expect(displayTokensToContent(display, map)).toBe(
      `${serializeMention('c'.repeat(64))} and ${serializeMention('d'.repeat(64))}`,
    );
  });

  it('same pubkey twice is still round-trippable', () => {
    const pk = 'a'.repeat(64);
    const content = `${serializeMention(pk)} and ${serializeMention(pk)}`;
    const { display, map } = contentToDisplayTokens(content, members);
    expect(display).toBe('@Alice and @Alice#2');
    // Both tokens map back to the same canonical form.
    expect(displayTokensToContent(display, map)).toBe(content);
  });

  it('leaves plain text untouched with no mentions', () => {
    const { display, map } = contentToDisplayTokens('nothing to see here', members);
    expect(display).toBe('nothing to see here');
    expect(map.size).toBe(0);
    expect(displayTokensToContent('nothing to see here', map)).toBe('nothing to see here');
  });

  it('handles display names with regex-special characters', () => {
    const quirky: MemberInfo[] = [{ pubkey: 'a'.repeat(64), displayName: 'A.(B)+' }];
    const content = `hi ${serializeMention('a'.repeat(64))}`;
    const { display, map } = contentToDisplayTokens(content, quirky);
    expect(display).toBe('hi @A.(B)+');
    expect(displayTokensToContent(display, map)).toBe(content);
  });
});

describe('filterMembers', () => {
  it('filters by display name', () => {
    expect(filterMembers(members, 'ali')).toEqual([members[0]]);
  });

  it('filters by pubkey prefix', () => {
    expect(filterMembers(members, 'bbb')).toEqual([members[1]]);
  });

  it('returns empty for no match', () => {
    expect(filterMembers(members, 'xyz')).toEqual([]);
  });

  it('is case insensitive', () => {
    expect(filterMembers(members, 'ALICE')).toEqual([members[0]]);
  });
});

describe('relayMentionCandidates', () => {
  it('returns empty when no groups are supplied', () => {
    expect(relayMentionCandidates([], {}, {}, {})).toEqual([]);
  });

  it('unions members, admins, and creator of a single group', () => {
    const result = relayMentionCandidates(
      ['g1'],
      { g1: ['a', 'b'] },
      { g1: ['c'] },
      { g1: 'd' },
    );
    expect(result.sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('dedupes pubkeys that appear in multiple roles', () => {
    const result = relayMentionCandidates(
      ['g1'],
      { g1: ['a', 'b'] },
      { g1: ['a'] },
      { g1: 'a' },
    );
    expect(result.sort()).toEqual(['a', 'b']);
  });

  it('unions members across multiple groups, deduped', () => {
    const result = relayMentionCandidates(
      ['g1', 'g2'],
      { g1: ['a', 'b'], g2: ['b', 'c'] },
      {},
      {},
    );
    expect(result.sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips groups with no entries in any map', () => {
    const result = relayMentionCandidates(
      ['g1', 'gNoData'],
      { g1: ['a'] },
      {},
      {},
    );
    expect(result).toEqual(['a']);
  });

  it('only includes pubkeys from the supplied groupIds', () => {
    // WoT-hidden groups are filtered out of useGroups() upstream; this
    // helper must not pull their member rolls back in via the maps.
    const result = relayMentionCandidates(
      ['g1'],
      { g1: ['a'], gHidden: ['x'] },
      { gHidden: ['y'] },
      { gHidden: 'z' },
    );
    expect(result).toEqual(['a']);
  });
});

describe('detectMentionQuery', () => {
  it('returns null on plain text', () => {
    expect(detectMentionQuery('hello there', 11)).toBe(null);
  });

  it('returns the empty string immediately after a bare `@`', () => {
    expect(detectMentionQuery('hi @', 4)).toBe('');
  });

  it('captures the partial username being typed', () => {
    expect(detectMentionQuery('hi @ali', 7)).toBe('ali');
  });

  it('triggers when @ is the very first character', () => {
    expect(detectMentionQuery('@bob', 4)).toBe('bob');
  });

  it('does not trigger inside an email-like token', () => {
    // `@` here is preceded by a word char (`o`), not whitespace.
    expect(detectMentionQuery('foo@bar', 7)).toBe(null);
  });

  it('closes the slot once a non-word character is typed', () => {
    expect(detectMentionQuery('hi @ali ', 8)).toBe(null);
    expect(detectMentionQuery('hi @ali!', 8)).toBe(null);
  });

  it('uses the cursor, not the end of the string', () => {
    // Cursor is at position 7 ("hi @ali|x"), the trailing `x` is to the
    // right of the cursor and should not affect the slot detection.
    expect(detectMentionQuery('hi @alix', 7)).toBe('ali');
  });
});

describe('applyMentionToDraft', () => {
  const pk = 'a'.repeat(64);

  it('replaces an open `@query` slot with a nostr:npub token', () => {
    const { next, cursor } = applyMentionToDraft('hi @ali', 7, pk);
    const npub = `nostr:${nip19.npubEncode(pk)} `;
    expect(next).toBe(`hi ${npub}`);
    expect(cursor).toBe(`hi ${npub}`.length);
  });

  it('inserts a token at the cursor when no slot is open, with a leading space', () => {
    const { next } = applyMentionToDraft('hello', 5, pk);
    expect(next.startsWith('hello nostr:')).toBe(true);
  });

  it('does not add a leading space at the start of an empty draft', () => {
    const { next } = applyMentionToDraft('', 0, pk);
    expect(next.startsWith('nostr:')).toBe(true);
  });

  it('does not add a leading space when cursor is right after whitespace', () => {
    const { next } = applyMentionToDraft('hi ', 3, pk);
    expect(next).toBe(`hi nostr:${nip19.npubEncode(pk)} `);
  });

  it('preserves text after the cursor', () => {
    const { next } = applyMentionToDraft('hi @ali tail', 7, pk);
    const npub = `nostr:${nip19.npubEncode(pk)} `;
    expect(next).toBe(`hi ${npub} tail`);
  });

  it('returned cursor lands right after the inserted token', () => {
    const { next, cursor } = applyMentionToDraft('hi @ali', 7, pk);
    expect(next.slice(0, cursor)).toBe(`hi nostr:${nip19.npubEncode(pk)} `);
  });

  describe('with slash-command slot range', () => {
    const npub = nip19.npubEncode(pk);

    it('replaces the slot range when the user typed a partial name', () => {
      // `/zap dum` — slot range covers "dum" at chars 5..8.
      const { next, cursor } = applyMentionToDraft('/zap dum', 8, pk, { start: 5, end: 8 });
      expect(next).toBe(`/zap nostr:${npub} `);
      expect(cursor).toBe(`/zap nostr:${npub} `.length);
    });

    it('preserves the trailing amount when replacing an in-slot token', () => {
      // `/zap dum 100` — slot covers "dum"; the trailing "100" stays put.
      const { next } = applyMentionToDraft('/zap dum 100', 8, pk, { start: 5, end: 8 });
      expect(next).toBe(`/zap nostr:${npub}  100`);
    });

    it('ignores the @-regex path even if `@name` sits before the slot', () => {
      // The slot range takes priority over the legacy `@word` capture.
      const { next } = applyMentionToDraft('@bystander /zap dum', 19, pk, { start: 16, end: 19 });
      expect(next).toBe(`@bystander /zap nostr:${npub} `);
    });
  });
});
