/**
 * Shared channel layout — categories + channel ordering, stored as a
 * NIP-78 (kind 30078) replaceable parameterized event authored by the
 * **relay operator** (NIP-11 `pubkey`). Everyone subscribed to the relay
 * sees the same ordering; only the operator can publish/edit.
 *
 * d-tag: `obelisk:layout:<relayUrl>`
 *
 * Tags:
 *   ["category", catId, name, position]
 *   ["channel",  channelId, catId|"", position]
 *
 * Channels not listed in any category render under an Uncategorized bucket
 * at the bottom. Categories with no children still render (operator can
 * drop channels into them).
 */
import { useEffect, useState } from 'react';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { getBridge, getBridgeImpl } from '@/lib/nostr-bridge/client';
import { cacheGet, cacheSet } from '@/lib/nostr-bridge/cache';
import { fetchRelayInfo, operatorPubkeyFromRelayInfo } from '@/lib/relay-info';
import { KIND_NIP78_APP_DATA as KIND_LAYOUT } from '@/lib/nip-kinds';

export interface ChannelLayoutCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface ChannelLayoutChannel {
  readonly id: string;
  readonly categoryId: string | null;
  readonly position: number;
}

export interface ChannelLayout {
  readonly categories: ReadonlyArray<ChannelLayoutCategory>;
  readonly channels: ReadonlyArray<ChannelLayoutChannel>;
  /** created_at of the source event, or 0 if none seen yet. */
  readonly updatedAt: number;
}

export const EMPTY_LAYOUT: ChannelLayout = { categories: [], channels: [], updatedAt: 0 };

function dTag(relayUrl: string): string {
  return `obelisk:layout:${relayUrl}`;
}

function parseLayout(ev: NostrEvent): ChannelLayout {
  const categories: ChannelLayoutCategory[] = [];
  const channels: ChannelLayoutChannel[] = [];
  for (const t of ev.tags) {
    if (t[0] === 'category' && t[1] && t[2] !== undefined) {
      categories.push({
        id: t[1],
        name: t[2] || 'Untitled',
        position: parseInt(t[3] ?? '0', 10) || 0,
      });
    } else if (t[0] === 'channel' && t[1]) {
      channels.push({
        id: t[1],
        categoryId: t[2] ? t[2] : null,
        position: parseInt(t[3] ?? '0', 10) || 0,
      });
    }
  }
  categories.sort((a, b) => a.position - b.position);
  channels.sort((a, b) => a.position - b.position);
  return { categories, channels, updatedAt: ev.created_at };
}

function toTags(layout: ChannelLayout, relayUrl: string): string[][] {
  const tags: string[][] = [['d', dTag(relayUrl)]];
  layout.categories.forEach((c, i) => {
    tags.push(['category', c.id, c.name, String(i)]);
  });
  layout.channels.forEach((ch, i) => {
    tags.push(['channel', ch.id, ch.categoryId ?? '', String(i)]);
  });
  return tags;
}

/**
 * Subscribe to layout events authored by any of `authors` for the given
 * relay. Calls `onChange` with the freshest layout seen so far; older
 * events are dropped. With multiple authors, latest `created_at` wins.
 */
export function subscribeLayout(
  relayUrl: string,
  authors: ReadonlyArray<string>,
  onChange: (layout: ChannelLayout) => void,
): () => void {
  const impl = getBridgeImpl();
  if (!impl) {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    void getBridge().then(() => {
      if (cancelled) return;
      unsub = subscribeLayout(relayUrl, authors, onChange);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }

  if (authors.length === 0) return () => {};
  let latest: ChannelLayout = EMPTY_LAYOUT;
  // Stale-while-revalidate: paint the cached layout immediately, then let
  // newest-wins overwrite once the relay confirms. Keyed by dTag so layout
  // and branding (both kind 30078) don't collide.
  const cached = cacheGet<ChannelLayout>(relayUrl, KIND_LAYOUT, dTag(relayUrl));
  if (cached) {
    latest = cached.value;
    onChange(latest);
  }
  const filter: Filter = {
    kinds: [KIND_LAYOUT],
    authors: [...authors],
    '#d': [dTag(relayUrl)],
  };
  return impl.subscribeFilterWatched(filter, (ev) => {
    if (ev.created_at <= latest.updatedAt) return;
    latest = parseLayout(ev);
    cacheSet(relayUrl, KIND_LAYOUT, dTag(relayUrl), latest);
    onChange(latest);
  });
}

export async function publishLayout(relayUrl: string, layout: ChannelLayout): Promise<void> {
  await getBridge();
  const impl = getBridgeImpl();
  if (!impl) throw new Error('nostr bridge not initialized');
  await impl.publishEvent({
    kind: KIND_LAYOUT,
    content: '',
    tags: toTags(layout, relayUrl),
  }, { extraRelays: [relayUrl], mode: 'replace' });
}

export function useChannelLayout(
  relayUrl: string | null,
  authors: ReadonlyArray<string>,
): ChannelLayout {
  const [layout, setLayout] = useState<ChannelLayout>(EMPTY_LAYOUT);
  const authorsKey = [...authors].sort().join(',');
  // Reset only when the relay changes — authors growing as admin events
  // stream in would otherwise flash categories/order to empty mid-load.
  // The newest-wins guard inside subscribeLayout already drops stale events.
  useEffect(() => {
    setLayout(EMPTY_LAYOUT);
  }, [relayUrl]);
  useEffect(() => {
    if (!relayUrl || authors.length === 0) return;
    return subscribeLayout(relayUrl, authors, setLayout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, authorsKey]);
  return layout;
}

/**
 * Resolve the human operator from NIP-11 contact, falling back to pubkey. Returns
 * `null` until the fetch completes (or if the relay doesn't advertise a
 * usable operator identity).
 */
export function useRelayOperatorPubkey(relayUrl: string | null): string | null {
  const [pk, setPk] = useState<string | null>(null);
  useEffect(() => {
    setPk(null);
    if (!relayUrl) return;
    let cancelled = false;
    void fetchRelayInfo(relayUrl).then((info) => {
      if (cancelled) return;
      setPk(operatorPubkeyFromRelayInfo(info));
    });
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);
  return pk;
}

export function relayOperatorAuthors(operatorPubkey: string | null): string[] {
  return operatorPubkey ? [operatorPubkey] : [];
}

// -- Pure helpers used by the UI ---------------------------------------------

export interface LaidOutSidebar {
  readonly categories: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly channelIds: ReadonlyArray<string>;
  }>;
  readonly uncategorized: ReadonlyArray<string>;
}

/**
 * Apply a layout to the canonical channel list, returning render-ready
 * groupings. Channels missing from the layout fall to `uncategorized` in
 * their original order; channels in the layout but missing from
 * `allChannelIds` are dropped (they may have been deleted server-side).
 */
export function applyLayout(layout: ChannelLayout, allChannelIds: ReadonlyArray<string>): LaidOutSidebar {
  const known = new Set(allChannelIds);
  const placed = new Set<string>();
  const byCat = new Map<string, string[]>();
  for (const ch of layout.channels) {
    if (!known.has(ch.id)) continue;
    if (ch.categoryId) {
      const arr = byCat.get(ch.categoryId) ?? [];
      arr.push(ch.id);
      byCat.set(ch.categoryId, arr);
    }
    placed.add(ch.id);
  }
  const categories = layout.categories.map((c) => ({
    id: c.id,
    name: c.name,
    channelIds: byCat.get(c.id) ?? [],
  }));
  const uncategorized: string[] = [];
  // First the explicitly-uncategorized (in layout, no catId), then anything
  // not referenced at all in the layout (preserving relay order).
  for (const ch of layout.channels) {
    if (!known.has(ch.id)) continue;
    if (!ch.categoryId) uncategorized.push(ch.id);
  }
  for (const id of allChannelIds) {
    if (!placed.has(id)) uncategorized.push(id);
  }
  return { categories, uncategorized };
}

export function newCategoryId(): string {
  // Short, URL-safe, low-collision. Only needs to be unique within one user's
  // layout.
  return Math.random().toString(36).slice(2, 10);
}
