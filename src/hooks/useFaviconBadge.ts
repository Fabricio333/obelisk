'use client';

import { useEffect, useReducer, useRef } from 'react';
import { useMyPubkey } from '@/lib/nostr-bridge';
import { useChatStore } from '@/store/chat';
import {
  useTotalDMUnread,
  useTotalChannelUnread,
  countChannelUnread,
} from '@/lib/read-state/selectors';
import { useReadStateStore } from '@/store/read-state';
import { useMessages } from '@/lib/nostr-bridge';
import { isUserWatchingChannel } from '@/lib/read-gates';
import { setBadgeCount, clearBadge } from '@/lib/favicon-badge';

const BASE_TITLE = 'Obelisk';
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

function effectiveCursor(stored: number | undefined): number {
  return stored && stored > 0 ? stored : Date.now() - FALLBACK_WINDOW_MS;
}

/**
 * Mirror the unread total into the browser tab: red dot on the favicon +
 * `(N) Obelisk` in the title. Should be mounted exactly once at the chat
 * root (currently from `AppGate.tsx` while the user is logged in).
 *
 * Source of truth is the read-state cursor: `useTotalDMUnread` and
 * `useTotalChannelUnread` derive the counts from bridge messages filtered
 * by `useReadStateStore.{dm,group}Cursors`. The active channel's
 * contribution is subtracted when the user is actively watching it (visible
 * + focused + scrolled-near-bottom) — `useAutoMarkRead` advances the
 * cursor in the next effect tick, but this hook renders in the same commit,
 * so without the manual subtraction the badge would briefly flash a phantom
 * `+1` between message ingest and cursor advance.
 */
export function useFaviconBadge(): void {
  const myPubkey = useMyPubkey();
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const isNearBottom = useChatStore((s) => s.isNearBottom);

  const totalDM = useTotalDMUnread();
  const totalCh = useTotalChannelUnread(myPubkey);

  // For the "skip active" subtraction, we need the active channel's message
  // list and its cursor. Both subscribe via existing hooks.
  const activeMessages = useMessages(activeChannelId);
  const activeCursor = useReadStateStore((s) =>
    activeChannelId ? s.groupCursors[activeChannelId] : undefined,
  );

  // Re-evaluate `isUserWatchingChannel` (which reads `document.hasFocus()` /
  // `visibilityState`) on tab focus/visibility transitions. The store
  // subscriptions above don't observe those.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const tick = () => force();
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    window.addEventListener('blur', tick);
    return () => {
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
      window.removeEventListener('blur', tick);
    };
  }, []);

  let total = totalDM + totalCh;
  if (
    activeChannelId &&
    activeMessages &&
    isUserWatchingChannel(activeChannelId)
  ) {
    total -= countChannelUnread(
      activeMessages,
      effectiveCursor(activeCursor),
      myPubkey,
    );
    if (total < 0) total = 0;
  }

  // Apply the badge + title on every relevant change.
  const originalTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (originalTitleRef.current === null) {
      const current = document.title || BASE_TITLE;
      originalTitleRef.current = current.startsWith('(') ? BASE_TITLE : current;
    }
    if (total > 0) {
      const label = total > 99 ? '99+' : String(total);
      document.title = `(${label}) ${originalTitleRef.current || BASE_TITLE}`;
      void setBadgeCount(total);
    } else {
      document.title = originalTitleRef.current || BASE_TITLE;
      void clearBadge();
    }
  }, [total]);

  // Restore on unmount (logout).
  useEffect(() => {
    return () => {
      if (typeof document === 'undefined') return;
      if (originalTitleRef.current) document.title = originalTitleRef.current;
      void clearBadge();
    };
  }, []);

  // Suppress unused-var lint on isNearBottom — we only read it so the hook
  // re-runs when scroll position toggles into/out of the bottom band, which
  // changes whether `isUserWatchingChannel` returns true.
  void isNearBottom;
}
