/**
 * Relay branding — operator-controlled icon/banner/name shown in the
 * sidebar header. Stored as a NIP-78 (kind 30078) replaceable parameterized
 * event authored by the **relay operator** (NIP-11 `pubkey`). Mirrors the
 * shape of `channel-layout.ts`.
 *
 * d-tag: `obelisk:branding:<relayUrl>`
 *
 * Tags:
 *   ["icon", url]
 *   ["banner", url]
 *   ["name", displayName]
 *   ["description", text]
 */
import { useEffect, useState } from 'react';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { getBridge, getBridgeImpl } from '@/lib/nostr-bridge/client';
import { cacheGet, cacheSet } from '@/lib/nostr-bridge/cache';
import { KIND_NIP78_APP_DATA as KIND_BRANDING } from '@/lib/nip-kinds';

export interface RelayBranding {
  readonly icon: string;
  readonly banner: string;
  readonly name: string;
  readonly description: string;
  /** created_at of the source event, or 0 if none seen yet. */
  readonly updatedAt: number;
}

export const EMPTY_BRANDING: RelayBranding = {
  icon: '',
  banner: '',
  name: '',
  description: '',
  updatedAt: 0,
};

function dTag(relayUrl: string): string {
  return `obelisk:branding:${relayUrl}`;
}

export function parseBranding(ev: NostrEvent): RelayBranding {
  let icon = '';
  let banner = '';
  let name = '';
  let description = '';
  for (const t of ev.tags) {
    if (t[0] === 'icon' && typeof t[1] === 'string') icon = t[1];
    else if (t[0] === 'banner' && typeof t[1] === 'string') banner = t[1];
    else if (t[0] === 'name' && typeof t[1] === 'string') name = t[1];
    else if (t[0] === 'description' && typeof t[1] === 'string') description = t[1];
  }
  return { icon, banner, name, description, updatedAt: ev.created_at };
}

export function toTags(b: RelayBranding, relayUrl: string): string[][] {
  const tags: string[][] = [['d', dTag(relayUrl)]];
  if (b.icon) tags.push(['icon', b.icon]);
  if (b.banner) tags.push(['banner', b.banner]);
  if (b.name) tags.push(['name', b.name]);
  if (b.description) tags.push(['description', b.description]);
  return tags;
}

export function subscribeBranding(
  relayUrl: string,
  authors: ReadonlyArray<string>,
  onChange: (b: RelayBranding) => void,
): () => void {
  const impl = getBridgeImpl();
  if (!impl) {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    void getBridge().then(() => {
      if (cancelled) return;
      unsub = subscribeBranding(relayUrl, authors, onChange);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }

  if (authors.length === 0) return () => {};
  let latest: RelayBranding = EMPTY_BRANDING;
  // Stale-while-revalidate: paint cached branding so the banner/name don't
  // flash empty on reload. Keyed by dTag (`obelisk:branding:<relay>`) which
  // is distinct from layout's dTag, so they share kind 30078 cleanly.
  const cached = cacheGet<RelayBranding>(relayUrl, KIND_BRANDING, dTag(relayUrl));
  if (cached) {
    latest = cached.value;
    onChange(latest);
  }
  const filter: Filter = {
    kinds: [KIND_BRANDING],
    authors: [...authors],
    '#d': [dTag(relayUrl)],
  };
  return impl.subscribeFilterWatched(filter, (ev) => {
    if (ev.created_at <= latest.updatedAt) return;
    latest = parseBranding(ev);
    cacheSet(relayUrl, KIND_BRANDING, dTag(relayUrl), latest);
    onChange(latest);
  });
}

export async function publishBranding(relayUrl: string, branding: RelayBranding): Promise<void> {
  await getBridge();
  const impl = getBridgeImpl();
  if (!impl) throw new Error('nostr bridge not initialized');
  await impl.publishEvent({
    kind: KIND_BRANDING,
    content: '',
    tags: toTags(branding, relayUrl),
  }, { extraRelays: [relayUrl], mode: 'replace' });
}

export function useRelayBranding(
  relayUrl: string | null,
  authors: ReadonlyArray<string>,
): RelayBranding {
  const [b, setB] = useState<RelayBranding>(EMPTY_BRANDING);
  const authorsKey = [...authors].sort().join(',');
  // Reset only on relay change — authors arriving after the first paint
  // would otherwise blank the banner/name briefly mid-load.
  useEffect(() => {
    setB(EMPTY_BRANDING);
  }, [relayUrl]);
  useEffect(() => {
    if (!relayUrl || authors.length === 0) return;
    return subscribeBranding(relayUrl, authors, setB);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, authorsKey]);
  return b;
}
