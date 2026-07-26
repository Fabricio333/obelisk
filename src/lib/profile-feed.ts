import type { Event as NostrEvent } from 'nostr-tools';
import { isVideoUrl } from './attachments';
import { extractUrls, isImageUrl } from './markdown';

export const DEFAULT_PROFILE_FEED_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
] as const;

export type ProfileFeedTab = 'posts' | 'replies' | 'media';

export function normalizeProfileFeedRelays(value: unknown): string[] {
  if (!Array.isArray(value) || value.length !== 3) return [...DEFAULT_PROFILE_FEED_RELAYS];
  const relays = value.map((entry, index) => {
    if (typeof entry !== 'string') return DEFAULT_PROFILE_FEED_RELAYS[index];
    try {
      const url = new URL(entry.trim());
      if (url.protocol !== 'wss:' || url.username || url.password) {
        return DEFAULT_PROFILE_FEED_RELAYS[index];
      }
      return url.toString().replace(/\/$/, '');
    } catch {
      return DEFAULT_PROFILE_FEED_RELAYS[index];
    }
  });
  return new Set(relays).size === 3 ? relays : [...DEFAULT_PROFILE_FEED_RELAYS];
}

export function parseProfileFeedRelays(value: string): string[] | null {
  const entries = value.split(/[\n,]+/).map((relay) => relay.trim()).filter(Boolean);
  if (entries.length !== 3) return null;
  const normalized = normalizeProfileFeedRelays(entries);
  return normalized.every((relay, index) => relay === entries[index].replace(/\/$/, ''))
    ? normalized
    : null;
}

export function isReply(note: Pick<NostrEvent, 'tags'>): boolean {
  return note.tags.some((tag) => tag[0] === 'e' && !!tag[1]);
}

export function mediaUrls(note: Pick<NostrEvent, 'content'>): string[] {
  return extractUrls(note.content).filter((url) => isImageUrl(url) || isVideoUrl(url));
}

export function filterProfileFeed(notes: readonly NostrEvent[], tab: ProfileFeedTab): NostrEvent[] {
  return notes.filter((note) => (
    tab === 'posts' ? !isReply(note) : tab === 'replies' ? isReply(note) : mediaUrls(note).length > 0
  ));
}

export function toggledFollowTags(
  tags: readonly (readonly string[])[],
  pubkey: string,
  following: boolean,
): string[][] {
  const withoutTarget = tags
    .filter((tag) => !(tag[0] === 'p' && tag[1] === pubkey))
    .map((tag) => [...tag]);
  return following ? [...withoutTarget, ['p', pubkey]] : withoutTarget;
}
