'use client';

/**
 * Standards-only Nostr user search.
 *
 * Resolves a free-text query to user candidates using three orthogonal paths:
 *   - Direct identity decode: 64-char hex / `npub1…` / `nprofile1…` (NIP-19).
 *   - NIP-05 lookup: `name@host.tld` via `.well-known/nostr.json`.
 *   - NIP-50 free-text search against indexer relays for kind:0 metadata.
 *
 * No proprietary endpoints, no server route. Dedupe / ranking happens on the
 * client.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { npubToHex } from '@nostr-wot/data';
import { useNostrQuery } from '@nostr-wot/data/react';

export interface UserHit {
  pubkey: string;
  displayName: string | null;
  picture: string | null;
  nip05: string | null;
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * NIP-50 search isn't universally supported; query a couple of indexers in
 * parallel so a flaky single relay doesn't silently kill the whole feature.
 */
export const NIP50_RELAYS = [
  'wss://relay.nostr.band',
  'wss://relay.noswhere.com',
  'wss://search.nos.today',
];

const NIP05_RE = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i;

function parseKind0Content(raw: string): {
  name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
} {
  try {
    const r = JSON.parse(raw);
    return {
      name: r.name,
      displayName: r.displayName ?? r.display_name,
      picture: r.picture ?? r.image,
      nip05: r.nip05,
    };
  } catch {
    return {};
  }
}

async function resolveNip05(identifier: string, signal: AbortSignal): Promise<UserHit | null> {
  const m = NIP05_RE.exec(identifier.trim());
  if (!m) return null;
  const [, name, domain] = m;
  try {
    const res = await fetch(
      `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
      { signal, mode: 'cors' },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { names?: Record<string, string> };
    const pk = data.names?.[name] ?? data.names?.[name.toLowerCase()];
    if (typeof pk !== 'string' || !/^[0-9a-f]{64}$/i.test(pk)) return null;
    return { pubkey: pk.toLowerCase(), displayName: null, picture: null, nip05: identifier };
  } catch {
    return null;
  }
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export interface NostrUserSearchResult {
  /** Direct hit when the query decodes as hex / npub / nprofile (NIP-19). */
  directHit: UserHit | null;
  /** Resolved NIP-05 hit when the query matches `name@host.tld`. */
  nip05Hit: UserHit | null;
  /** NIP-50 kind:0 `search` results from indexer relays. */
  nostrResults: UserHit[];
  loading: boolean;
}

export function useNostrUserSearch(rawQuery: string): NostrUserSearchResult {
  const trimmed = rawQuery.trim();
  const debounced = useDebounced(trimmed, SEARCH_DEBOUNCE_MS);

  const directHex = useMemo(() => (debounced ? npubToHex(debounced) : null), [debounced]);
  const directHit: UserHit | null = directHex
    ? { pubkey: directHex, displayName: null, picture: null, nip05: null }
    : null;

  const enabled = debounced.length >= 2 && !directHex;

  const [nip05Hit, setNip05Hit] = useState<UserHit | null>(null);
  const [nip05Loading, setNip05Loading] = useState(false);

  useEffect(() => {
    setNip05Hit(null);
    if (!enabled || !NIP05_RE.test(debounced)) {
      setNip05Loading(false);
      return;
    }
    const ac = new AbortController();
    setNip05Loading(true);
    resolveNip05(debounced, ac.signal).then((hit) => {
      if (ac.signal.aborted) return;
      setNip05Hit(hit);
      setNip05Loading(false);
    });
    return () => {
      ac.abort();
      setNip05Loading(false);
    };
  }, [debounced, enabled]);

  const filters = useMemo(
    () => (enabled ? [{ kinds: [0], search: debounced, limit: 10 }] : []),
    [debounced, enabled],
  );
  const { events, loading: queryLoading } = useNostrQuery(filters, {
    enabled,
    relays: NIP50_RELAYS,
    timeoutMs: 10000,
  });

  const nostrResults = useMemo<UserHit[]>(() => {
    if (!enabled) return [];
    const out: UserHit[] = [];
    const seen = new Set<string>();
    if (nip05Hit) seen.add(nip05Hit.pubkey);
    for (const ev of events as NostrEvent[]) {
      if (ev.kind !== 0) continue;
      if (seen.has(ev.pubkey)) continue;
      seen.add(ev.pubkey);
      const parsed = parseKind0Content(ev.content);
      out.push({
        pubkey: ev.pubkey,
        displayName: parsed.displayName ?? parsed.name ?? null,
        picture: parsed.picture ?? null,
        nip05: parsed.nip05 ?? null,
      });
      if (out.length >= 10) break;
    }
    return out;
  }, [events, enabled, nip05Hit]);

  return {
    directHit,
    nip05Hit,
    nostrResults,
    loading: enabled && (queryLoading || nip05Loading),
  };
}
