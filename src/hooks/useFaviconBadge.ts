'use client';

import { useEffect, useReducer, useRef } from 'react';
import { useCurrentRelayUrl } from '@/lib/nostr-bridge';
import { useTotalDMUnread } from '@/lib/read-state/selectors';
import { useUnreadMentionCount } from '@/lib/notifications/selectors';
import { setBadgeCount, clearBadge } from '@/lib/favicon-badge';

const BASE_TITLE = 'Obelisk';

/**
 * Mirror the notification total into the browser tab: red dot on the
 * favicon + `(N) Obelisk` in the title. Should be mounted exactly once at
 * the chat root (currently from `ReadStateRoot`).
 *
 * **The badge counts things addressed to you — nothing else.** That is
 * unread DMs plus unread @-mentions on the relay you're connected to.
 * Ordinary channel traffic deliberately does NOT badge the tab: a busy
 * relay would otherwise pin the title at `(99+)` permanently and the
 * signal would mean nothing. Per-channel unread dots in the sidebar are
 * a separate, quieter affordance driven by `groupCursors`.
 *
 * Mentions are only counted for the active relay, because mention
 * scanning only happens there (CLAUDE.md, "Single-relay rule for
 * groups"). There is no background cross-relay mention watch.
 *
 * No "subtract the active channel" correction is needed here: the bridge
 * already refuses to push a mention card when `isUserWatchingChannel` is
 * true, so a mention you're looking at never enters the count. The
 * focus/visibility listener remains because that gate is evaluated at
 * ingest time and the DM half still reads live cursors.
 */
export function useFaviconBadge(): void {
  const activeRelay = useCurrentRelayUrl();
  const totalDM = useTotalDMUnread();
  const mentions = useUnreadMentionCount(activeRelay);

  // Re-evaluate on tab focus/visibility transitions — the store
  // subscriptions above don't observe those, and the ingest-time gates
  // that decide what becomes a notification do read them.
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

  const total = totalDM + mentions;

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
}
