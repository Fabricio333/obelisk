'use client';

/**
 * Read-state mount point — owns the side-effects that wire encrypted
 * multi-device cursor sync (NIP-59 gift wraps) and the auto-mark-read +
 * favicon-badge hooks.
 *
 * Lives in `src/lib/read-state/` rather than `src/app/app/AppGate.tsx`
 * so AppGate stays a thin shell selector and the deferred-mount logic
 * is testable in isolation.
 *
 * Mount timing — Phase 5 of the data-system redesign:
 *
 * Relay-sync subscriptions (one `{kinds:[1059], '#p':[me]}` on the ACTIVE
 * relay for groups-scope state, one per NIP-65 read+write relay for DM-
 * scope state) are P2 priority. They MUST NOT block the channel-menu paint.
 *
 * Architectural rule: groups bind to the active relay only; only DMs and
 * DM-state sync run cross-relay. See CLAUDE.md and docs/data-system.md §4.
 * The {@link useReadyToSync} hook gates the two `useEffect`s on either:
 *   1. `groupMetadataEose === true` — the relay has finished streaming kind
 *      39000; channels are painted. OR
 *   2. 1000ms post-`Connected` — even on a relay that silently filters
 *      kind 39000 (no EOSE), we don't want to defer cursor sync forever.
 *
 * The 8s debounce in `relay-sync.ts:flush()` means a ~1s mount delay is
 * imperceptible to the user; cursor convergence across devices happens
 * after first paint either way.
 *
 * Account-scoped store ensures (read-state cursors, DM overrides, etc.)
 * remain eager — they read from localStorage and must be in place before
 * the chat UI tries to read cursors.
 */

import { useEffect, useState } from 'react';
import {
  useConfiguredRelays,
  useConnectionState,
  useCurrentRelayUrl,
  useGroupMetadataEose,
  useGroups,
} from '@/lib/nostr-bridge';
import { useMyPubkey } from '@/lib/nostr-bridge';
import { useAutoMarkRead } from '@/hooks/useAutoMarkRead';
import { useFaviconBadge } from '@/hooks/useFaviconBadge';
import { ensureReadStateStoreForAccount } from '@/store/read-state';
import { ensureDMStoreForAccount } from '@/store/dm';
import { ensureModerationStoreForAccount } from '@/store/moderation';
import { startGroupsRelaySync, startDMRelaySync } from './relay-sync';
import { fetchRelayList } from '@nostr-wot/data';
import { DEFAULT_PROFILE_LOOKUP_RELAYS } from '@/lib/nostr-bridge/client';


/**
 * Per-account persistence wiring. Add new per-account stores here — the
 * useEffect below loops through this on every login change. Forgetting an
 * entry silently leaks state across accounts on the same browser.
 */
const PER_ACCOUNT_STORES = [
  ensureReadStateStoreForAccount,
  ensureDMStoreForAccount,
  ensureModerationStoreForAccount,
] as const;

/**
 * Gate the P2 relay-sync subscriptions on either the channel-menu having
 * painted (`groupMetadataEose`) or a 1000ms post-`Connected` timer. Exposed
 * as a hook so it's straightforward to mock in unit tests.
 */
export function useReadyToSync(): boolean {
  const groupMetadataEose = useGroupMetadataEose();
  const conn = useConnectionState();
  // The grace-timer half of the contract is the only stateful piece —
  // once it fires we latch true and never tear it down. The EOSE half
  // is a pure derivation, which keeps setState out of the effect body
  // (only inside the setTimeout callback).
  const [graceReady, setGraceReady] = useState(false);
  useEffect(() => {
    if (graceReady) return;
    if (conn !== 'Connected') return;
    const t = setTimeout(() => setGraceReady(true), 1000);
    return () => clearTimeout(t);
  }, [graceReady, conn]);
  return groupMetadataEose || graceReady;
}

export default function ReadStateRoot() {
  const myPubkey = useMyPubkey();
  const relays = useConfiguredRelays();
  const activeRelay = useCurrentRelayUrl();
  const groups = useGroups();
  const readyToSync = useReadyToSync();

  useEffect(() => {
    if (!myPubkey) return;
    for (const ensure of PER_ACCOUNT_STORES) ensure(myPubkey);
  }, [myPubkey]);

  // Groups-scope cursor sync runs on the ACTIVE relay only. Fanning out
  // across every configured relay opened background sockets to relays the
  // user wasn't browsing — leaking pubkey via NIP-42 AUTH and triggering
  // a "send AUTH on closed connection" loop on whitelist-gated relays.
  // Architectural rule: groups bind to the active relay; only DMs (and
  // DM-state sync) run cross-relay. See docs/data-system.md §4.
  //
  // The read-state wrap MUST land before messages paint — otherwise the
  // unread badges flash on, then off when cursors arrive. So we no longer
  // gate this on `useReadyToSync` (which deferred until after EOSE / 1s
  // grace); instead we mount as soon as the active relay + first group
  // are known. The empty-store defaults are "from zero", so a relay that
  // never delivers our wrap (no stored gift wrap, or a relay that doesn't
  // accept kind 1059) leaves cursors at zero and the user gets a fresh
  // wrap published as soon as they mark anything read.
  const groupIdsKey = groups.map((g) => g.id).sort().join(',');
  useEffect(() => {
    if (!myPubkey || !activeRelay) return;
    const ids = groups.map((g) => g.id);
    if (ids.length === 0) return;
    return startGroupsRelaySync(activeRelay, ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPubkey, activeRelay, groupIdsKey]);

  // DM-state sync targets the user's NIP-65 relays so cursors converge
  // across devices regardless of which relay they're chatting on. This is
  // the ONE place we fan subscriptions across multiple relays.
  const [dmRelays, setDmRelays] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    if (!myPubkey) return;
    let cancelled = false;
    const searchRelays = Array.from(new Set([...relays, ...DEFAULT_PROFILE_LOOKUP_RELAYS]));
    void fetchRelayList(myPubkey, searchRelays).then((list) => {
      if (cancelled) return;
      // NIP-65 union of read+write — matches DM coverage requirement.
      const found = list ? Array.from(new Set([...list.read, ...list.write])) : [];
      // Fall back to the active relay if the user has no NIP-65 list yet
      // — better one-relay sync than no sync at all, and matches the
      // "active relay only for groups, NIP-65 for DMs" architectural rule.
      setDmRelays(found.length > 0 ? found : (activeRelay ? [activeRelay] : []));
    });
    return () => { cancelled = true; };
  }, [myPubkey, relays, activeRelay]);

  useEffect(() => {
    if (!readyToSync) return;
    if (!myPubkey || dmRelays.length === 0) return;
    return startDMRelaySync(dmRelays);
  }, [readyToSync, myPubkey, dmRelays]);

  useAutoMarkRead();
  useFaviconBadge();
  return null;
}
