'use client';

// src/hooks/chat/useMessageZaps.ts
// Subscribes to NIP-57 kind 9735 zap-receipt events that target any of the
// given message ids and aggregates totals per message. The recipient pubkey
// for validation is read from the receipt's nested zap-request `p` tag, so
// this hook works for any author (not just the current user).

import { useEffect, useMemo, useState } from 'react';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { sharedCoalescer, getDefaultRelays, parseZapMsats } from '@nostr-wot/data';
import { validateZapReceipt, type RawNostrEvent } from '@nostr-wot/wallet';
import { isImportableRelayUrl, useConfiguredRelays } from '@/lib/nostr-bridge';

export interface MessageZapTotal {
  totalSats: number;
  count: number;
  zappers: Set<string>;
  zapperAmounts: Map<string, number>;
}

interface ReceiptEntry {
  dedupeKey: string;
  messageId: string;
  senderPubkey: string;
  amountMsat: number;
}

function tagValue(tags: string[][], name: string): string | null {
  return tags.find((t) => t[0] === name)?.[1] ?? null;
}

function tagAmountMsat(tags: string[][], name: string, defaultUnit = 'msat'): number {
  const tag = tags.find((t) => t[0] === name);
  if (!tag?.[1]) return 0;
  const amount = Number(tag[1]);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = (tag[2] || defaultUnit).toLowerCase();
  return ['sat', 'sats', 'satoshi', 'satoshis'].includes(unit)
    ? Math.floor(amount * 1000)
    : Math.floor(amount);
}

function zapReactionEntry(ev: RawNostrEvent, ids: readonly string[]): ReceiptEntry | null {
  if (ev.kind !== 7 || !ev.content.includes('⚡')) return null;
  const messageId = tagValue(ev.tags, 'e');
  if (!messageId || !ids.includes(messageId)) return null;
  const recipient = tagValue(ev.tags, 'p');
  if (!recipient) return null;

  const amountMsat =
    parseZapMsats(ev as unknown as NostrEvent)
    || tagAmountMsat(ev.tags, 'amount')
    || tagAmountMsat(ev.tags, 'msat')
    || tagAmountMsat(ev.tags, 'msats')
    || tagAmountMsat(ev.tags, 'millisats')
    || tagAmountMsat(ev.tags, 'sat', 'sat')
    || tagAmountMsat(ev.tags, 'sats', 'sat');
  if (amountMsat <= 0) return null;

  return {
    dedupeKey: tagValue(ev.tags, 'bolt11') || ev.id,
    messageId,
    senderPubkey: ev.pubkey,
    amountMsat,
  };
}

export function useMessageZaps(messageIds: ReadonlyArray<string>): Map<string, MessageZapTotal> {
  const [receipts, setReceipts] = useState<Map<string, ReceiptEntry>>(() => new Map());
  const configuredRelays = useConfiguredRelays();

  // Stable key so a re-render of the same id list doesn't re-subscribe.
  const idsKey = useMemo(() => [...messageIds].sort().join(','), [messageIds]);
  const relaysKey = useMemo(
    () => Array.from(new Set([...configuredRelays, ...getDefaultRelays()].filter(isImportableRelayUrl))).sort().join(','),
    [configuredRelays],
  );

  useEffect(() => {
    if (!idsKey) return;
    const ids = idsKey.split(',').filter(Boolean);
    if (ids.length === 0) return;

    const relays = relaysKey.split(',').filter(Boolean);
    if (relays.length === 0) return;

    const handle = (raw: NostrEvent | RawNostrEvent) => {
      const ev = raw as RawNostrEvent;
      const reactionEntry = zapReactionEntry(ev, ids);
      if (reactionEntry) {
        setReceipts((prev) => {
          if (prev.has(reactionEntry.dedupeKey)) return prev;
          const next = new Map(prev);
          next.set(reactionEntry.dedupeKey, reactionEntry);
          return next;
        });
        return;
      }

      if (ev.kind !== 9735) return;
      // Receipt's outer `e` tag points at the zapped message; use it to find
      // the expected recipient (the message author's pubkey is in the nested
      // zap-request's `p` tag, which validateZapReceipt already cross-checks).
      const eTag = ev.tags.find((t) => t[0] === 'e')?.[1];
      if (!eTag || !ids.includes(eTag)) return;
      const pTag = ev.tags.find((t) => t[0] === 'p')?.[1];
      if (!pTag) return;
      const validated = validateZapReceipt(ev, pTag);
      if (!validated || !validated.messageId) return;

      setReceipts((prev) => {
        const dedupeKey = tagValue(ev.tags, 'bolt11') || validated.receiptId;
        if (prev.has(dedupeKey)) return prev;
        const next = new Map(prev);
        next.set(dedupeKey, {
          dedupeKey,
          messageId: validated.messageId!,
          senderPubkey: validated.senderPubkey,
          amountMsat: validated.amountMsat,
        });
        return next;
      });
    };

    return sharedCoalescer.enqueue({
      filters: [{ kinds: [7, 9735], '#e': ids }],
      relays,
      onEvent: handle,
    });
  }, [idsKey, relaysKey]);

  return useMemo(() => {
    const out = new Map<string, MessageZapTotal>();
    for (const r of receipts.values()) {
      let entry = out.get(r.messageId);
      if (!entry) {
        entry = { totalSats: 0, count: 0, zappers: new Set(), zapperAmounts: new Map() };
        out.set(r.messageId, entry);
      }
      const sats = Math.floor(r.amountMsat / 1000);
      entry.totalSats += sats;
      entry.count += 1;
      entry.zappers.add(r.senderPubkey);
      entry.zapperAmounts.set(r.senderPubkey, (entry.zapperAmounts.get(r.senderPubkey) ?? 0) + sats);
    }
    return out;
  }, [receipts]);
}
