'use client';

import { useEffect } from 'react';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { getBridgeImpl, isImportableRelayUrl } from '@/lib/nostr-bridge';
import { useChatStore } from '@/store/chat';

/** A user counts as recently active if they published on this group relay in this window. */
export const PRESENCE_WINDOW_MS = 15 * 60 * 1000;

/** How often the UI re-evaluates the window (so users fade to offline). */
const TICK_INTERVAL_MS = 30 * 1000;

/** Event kinds that mean "this user was active on this group relay". */
const ACTIVITY_KINDS = [
  0,     // metadata update
  1,     // text note
  3,     // contacts
  6,     // repost
  7,     // reaction
  9,     // NIP-29 group message
  9735,  // zap receipt
  30023, // long-form
];

export function presenceActivityKey(relayUrl: string, pubkey: string): string {
  const relay = relayUrl.endsWith('/') ? relayUrl.slice(0, -1) : relayUrl;
  return relay.toLowerCase() + ':' + pubkey.toLowerCase();
}

/** Subscribes to recent activity from group members on this group's relay. */
export function useNostrPresence(pubkeys: string[], relayUrl: string): void {
  const recordActivity = useChatStore((s) => s.recordActivity);
  const bumpPresenceTick = useChatStore((s) => s.bumpPresenceTick);

  const authors = pubkeys.filter((pk) => /^[0-9a-f]{64}$/i.test(pk)).sort();
  const key = relayUrl + ':' + authors.join(',');

  useEffect(() => {
    if (!authors.length || !isImportableRelayUrl(relayUrl)) return;
    const bridge = getBridgeImpl();
    if (!bridge) return;

    const since = Math.floor((Date.now() - PRESENCE_WINDOW_MS) / 1000);
    return bridge.subscribeFilterWatched(
      { kinds: ACTIVITY_KINDS, authors, since },
      (ev: NostrEvent) => {
        const ts = (ev.created_at ?? 0) * 1000;
        if (ts > 0 && ev.pubkey) recordActivity(presenceActivityKey(relayUrl, ev.pubkey), ts);
      },
      { relays: [relayUrl], relayMode: 'replace', affectsRelayAccess: false },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const id = window.setInterval(() => bumpPresenceTick(), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [bumpPresenceTick]);
}
