import { describe, it, expect } from 'vitest';
import { searchGroups } from './group-search';
import type { JsGroup } from '@/lib/nostr-bridge';

const g = (id: string, name: string | null, about: string | null = null): JsGroup => ({
  id,
  name,
  about,
  picture: null,
  banner: null,
  isPublic: true,
  isHidden: false,
  isRestricted: false,
  isOpen: true,
  parent: null,
  kind: 'text',
  forumTags: [],
  topics: [],
});

describe('searchGroups', () => {
  const groups: JsGroup[] = [
    g('relay.io/abc', 'General', 'Open chat for everyone'),
    g('relay.io/btc', 'Bitcoin Talk', 'Sats and stacking'),
    g('relay.io/dev', 'Dev Chat', null),
    g('relay.io/Random123', null, null),
  ];

  it('returns [] for empty/whitespace query', () => {
    expect(searchGroups(groups, '')).toEqual([]);
    expect(searchGroups(groups, '   ')).toEqual([]);
  });

  it('matches name case-insensitively', () => {
    const r = searchGroups(groups, 'general');
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('relay.io/abc');
  });

  it('matches about field', () => {
    const r = searchGroups(groups, 'stacking');
    expect(r.map((x) => x.id)).toEqual(['relay.io/btc']);
  });

  it('matches id substring when name is null', () => {
    const r = searchGroups(groups, 'random');
    expect(r.map((x) => x.id)).toEqual(['relay.io/Random123']);
  });

  it('returns multiple matches', () => {
    const r = searchGroups(groups, 'chat');
    expect(r.map((x) => x.id).sort()).toEqual(['relay.io/abc', 'relay.io/dev']);
  });
});
