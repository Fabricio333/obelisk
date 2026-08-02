/**
 * React selectors over the two notification streams.
 *
 * Counts are recomputed on read from the card logs + cursors — there is no
 * counter to keep in sync. Mention selectors take the relay explicitly so
 * callers are forced to be honest about the single-relay rule: a mention
 * badge is always "on THIS relay", never an account-wide aggregate.
 */
import { useMemo } from 'react';
import {
  isDmNotificationRead,
  isMentionRead,
  useNotificationsStore,
  type DmNotification,
  type MentionNotification,
} from '@/store/notifications';
import { useReadStateStore } from '@/store/read-state';

const EMPTY_MENTIONS: ReadonlyArray<MentionNotification> = [];

/** Mention cards for `relay`, newest first. */
export function useMentionNotifications(
  relay: string | null | undefined,
): ReadonlyArray<MentionNotification> {
  const byRelay = useNotificationsStore((s) => s.mentionsByRelay);
  return relay ? (byRelay[relay] ?? EMPTY_MENTIONS) : EMPTY_MENTIONS;
}

/** Read cursor for `relay`'s mentions (0 when the relay is unseen). */
export function useMentionCursor(relay: string | null | undefined): number {
  return useNotificationsStore((s) => (relay ? (s.mentionCursorByRelay[relay] ?? 0) : 0));
}

export function useUnreadMentionCount(relay: string | null | undefined): number {
  const mentions = useMentionNotifications(relay);
  const cursor = useMentionCursor(relay);
  const groupCursors = useReadStateStore((s) => s.groupCursors);
  return useMemo(() => {
    let n = 0;
    for (const m of mentions) {
      if (!isMentionRead(m, cursor, groupCursors[m.channelId] ?? 0)) n++;
    }
    return n;
  }, [mentions, cursor, groupCursors]);
}

/** DM cards, newest first. Relay-agnostic — DMs follow NIP-65. */
export function useDmNotifications(): ReadonlyArray<DmNotification> {
  return useNotificationsStore((s) => s.dmNotifications);
}

/** DM notification cursor — lives in the read-state store (NIP-59 DM scope). */
export function useDmNotificationCursor(): number {
  return useReadStateStore((s) => s.inboxLastReadAt);
}

export function useUnreadDmNotificationCount(): number {
  const dms = useDmNotifications();
  const cursor = useDmNotificationCursor();
  return useMemo(() => {
    let n = 0;
    for (const d of dms) {
      if (!isDmNotificationRead(d, cursor)) n++;
    }
    return n;
  }, [dms, cursor]);
}

/**
 * Combined bell badge: unread mentions on the active relay + unread DMs.
 * The two streams stay separate everywhere else; this is only for the
 * single glyph that has to represent both.
 */
export function useNotificationBadgeCount(relay: string | null | undefined): number {
  return useUnreadMentionCount(relay) + useUnreadDmNotificationCount();
}
