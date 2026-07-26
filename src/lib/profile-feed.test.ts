import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  DEFAULT_PROFILE_FEED_RELAYS,
  filterProfileFeed,
  hashtagTags,
  linkifyHashtags,
  normalizeProfileFeedRelays,
  parseProfileFeedRelays,
  profileReplyTags,
  toggledFollowTags,
} from './profile-feed';

const note = (id: string, content: string, tags: string[][] = []) => ({
  id,
  content,
  tags,
  kind: 1,
  pubkey: 'a'.repeat(64),
  created_at: 1,
  sig: 'b'.repeat(128),
}) as NostrEvent;

describe('profile feed helpers', () => {
  it('separates posts, replies, and media', () => {
    const notes = [
      note('post', 'hello'),
      note('reply', 'replying', [['e', 'parent', '', 'reply']]),
      note('image', 'https://example.com/photo.jpg'),
      note('video', 'https://example.com/clip.mp4', [['e', 'parent']]),
    ];

    expect(filterProfileFeed(notes, 'posts').map((event) => event.id)).toEqual(['post', 'image']);
    expect(filterProfileFeed(notes, 'replies').map((event) => event.id)).toEqual(['reply', 'video']);
    expect(filterProfileFeed(notes, 'media').map((event) => event.id)).toEqual(['image', 'video']);
  });

  it('preserves unrelated kind-3 tags while toggling one follow', () => {
    const tags = [['p', 'existing'], ['relay', 'wss://legacy.example']];
    expect(toggledFollowTags(tags, 'target', true)).toEqual([...tags, ['p', 'target']]);
    expect(toggledFollowTags([...tags, ['p', 'target']], 'target', false)).toEqual(tags);
  });

  it('links hashtags and builds interoperable post tags', () => {
    expect(linkifyHashtags('hello #Nostr and (#bitcoin)')).toBe(
      'hello [#Nostr](https://njump.me/t/Nostr) and ([#bitcoin](https://njump.me/t/bitcoin))',
    );
    expect(hashtagTags('#Nostr #nostr #Bitcoin')).toEqual([['t', 'nostr'], ['t', 'bitcoin']]);
    expect(profileReplyTags(note('parent', 'hello'))).toEqual([
      ['e', 'parent', '', 'root'],
      ['e', 'parent', '', 'reply'],
      ['p', 'a'.repeat(64)],
    ]);
  });

  it('accepts exactly three unique wss relays and falls back safely', () => {
    const custom = 'wss://one.example\nwss://two.example\nwss://three.example';
    expect(parseProfileFeedRelays(custom)).toEqual(custom.split('\n'));
    expect(parseProfileFeedRelays('wss://one.example\nhttps://bad.example\nwss://three.example')).toBeNull();
    expect(normalizeProfileFeedRelays(['wss://same.example', 'wss://same.example', 'wss://three.example']))
      .toEqual([...DEFAULT_PROFILE_FEED_RELAYS]);
  });
});
