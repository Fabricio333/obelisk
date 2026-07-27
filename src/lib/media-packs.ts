import type { Event as NostrEvent } from 'nostr-tools';
import {
  isValidCustomEmojiName,
  normalizeCustomEmojiName,
} from './custom-emoji-tags';
import type {
  JsMediaFavorites,
  JsMediaItem,
  JsMediaKind,
  JsMediaPack,
} from './nostr-bridge/types';
import { inferMediaKind } from './media-kind';

export const EMPTY_MEDIA_FAVORITES: JsMediaFavorites = {
  items: [],
  packAddresses: [],
  createdAt: 0,
};

const PACK_ADDRESS_RE = /^30030:[0-9a-f]{64}:.+$/;

function validUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function mediaKinds(tags: ReadonlyArray<ReadonlyArray<string>>): Map<string, JsMediaKind> {
  const kinds = new Map<string, JsMediaKind>();
  for (const tag of tags) {
    if (tag[0] !== 'media') continue;
    const name = normalizeCustomEmojiName(tag[1] ?? '');
    const kind = tag[2];
    if (name && (kind === 'emoji' || kind === 'gif' || kind === 'sticker')) kinds.set(name, kind);
  }
  return kinds;
}

function mediaItems(tags: ReadonlyArray<ReadonlyArray<string>>, fallbackAddress?: string): JsMediaItem[] {
  const kinds = mediaKinds(tags);
  const byName = new Map<string, JsMediaItem>();
  for (const tag of tags) {
    if (tag[0] !== 'emoji') continue;
    const name = normalizeCustomEmojiName(tag[1] ?? '');
    const url = validUrl(tag[2]);
    if (!isValidCustomEmojiName(name) || !url) continue;
    const packAddress = PACK_ADDRESS_RE.test(tag[3] ?? '') ? tag[3] : fallbackAddress;
    byName.set(name, {
      name,
      url,
      kind: kinds.get(name) ?? inferMediaKind(url),
      ...(packAddress ? { packAddress } : {}),
    });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function mediaPackAddress(author: string, identifier: string): string {
  return `30030:${author}:${identifier}`;
}

export function parseMediaPack(ev: NostrEvent): JsMediaPack | null {
  const identifier = ev.tags.find((tag) => tag[0] === 'd')?.[1]?.trim() ?? '';
  if (!identifier) return null;
  const address = mediaPackAddress(ev.pubkey, identifier);
  const value = (name: string) => ev.tags.find((tag) => tag[0] === name)?.[1]?.trim() ?? '';
  return {
    address,
    identifier,
    author: ev.pubkey,
    title: value('title') || identifier,
    description: value('description'),
    image: validUrl(value('image')),
    items: mediaItems(ev.tags, address),
    createdAt: ev.created_at,
  };
}

export function parseMediaFavorites(ev: NostrEvent): JsMediaFavorites {
  return {
    items: mediaItems(ev.tags),
    packAddresses: Array.from(new Set(
      ev.tags
        .filter((tag) => tag[0] === 'a' && PACK_ADDRESS_RE.test(tag[1] ?? ''))
        .map((tag) => tag[1]),
    )),
    createdAt: ev.created_at,
  };
}

function itemTags(items: ReadonlyArray<JsMediaItem>): string[][] {
  const tags: string[][] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = normalizeCustomEmojiName(item.name);
    const url = validUrl(item.url);
    if (!isValidCustomEmojiName(name) || !url || seen.has(name)) continue;
    seen.add(name);
    tags.push(item.packAddress
      ? ['emoji', name, url, item.packAddress]
      : ['emoji', name, url]);
    tags.push(['media', name, item.kind]);
  }
  return tags;
}

export function mediaPackTags(
  pack: Pick<JsMediaPack, 'identifier' | 'title' | 'description' | 'image' | 'items'>,
  author: string,
): string[][] {
  const identifier = pack.identifier.trim();
  if (!identifier) throw new Error('Pack identifier is required.');
  const address = mediaPackAddress(author, identifier);
  const items = pack.items.map((item) => ({ ...item, packAddress: address }));
  return [
    ['d', identifier],
    ['title', pack.title.trim() || identifier],
    ...(pack.description.trim() ? [['description', pack.description.trim()]] : []),
    ...(validUrl(pack.image) ? [['image', validUrl(pack.image)]] : []),
    ...itemTags(items),
  ];
}

export function mediaFavoriteTags(favorites: JsMediaFavorites): string[][] {
  return [
    ...Array.from(new Set(favorites.packAddresses))
      .filter((address) => PACK_ADDRESS_RE.test(address))
      .map((address) => ['a', address]),
    ...itemTags(favorites.items),
  ];
}

export function mediaItemsFromPacks(
  packAddresses: ReadonlyArray<string>,
  packs: Readonly<Record<string, JsMediaPack>>,
): JsMediaItem[] {
  const byUrl = new Map<string, JsMediaItem>();
  for (const address of packAddresses) {
    for (const item of packs[address]?.items ?? []) byUrl.set(item.url, item);
  }
  return Array.from(byUrl.values());
}
