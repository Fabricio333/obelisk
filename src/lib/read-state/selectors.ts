/**
 * Derived read-state selectors.
 *
 * Counts are pure functions over the bridge's `dmsByPeer` / `messagesByGroup`
 * stores filtered by the persisted cursor in `useReadStateStore`. There is
 * no separate counter to keep in sync — every value here is recomputed on
 * read, so the only write site is `setDmCursor` / `setGroupCursor`.
 *
 * Cursors are stored in unix **milliseconds**; relay messages carry
 * `createdAt` in unix **seconds**. The comparison is `msg.createdAt * 1000`.
 *
 * Bootstrap fallback: when no cursor exists for a key (first paint after
 * deploy, or a peer the user has never opened), the effective cursor is
 * `Date.now() - 24h`. This matches the legacy 24h heuristic the user lived
 * with for years and converges to a real cursor as soon as they open the
 * thread for the first time.
 */
import { useMemo } from 'react';
import type { JsDirectMessage, JsMessage } from '@/lib/nostr-bridge/types';
import {
  useDirectMessages,
  useMessages,
  useMessagesByGroup,
} from '@/lib/nostr-bridge';
import { useReadStateStore } from '@/store/read-state';
import { buildAuthorIndex, isReplyToMe } from './replies';

const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

function effectiveCursor(stored: number | undefined): number {
  if (stored && stored > 0) return stored;
  return Date.now() - FALLBACK_WINDOW_MS;
}

/**
 * Count incoming DMs from `peer` newer than the read cursor. Outgoing
 * messages don't count (you wrote them — they're "read" by definition).
 *
 * Walks the list from the end and breaks once it hits the cursor; bridge
 * stores `dmsByPeer[peer]` sorted ascending by `createdAt`.
 */
export function countDMUnread(
  messages: ReadonlyArray<JsDirectMessage>,
  cursor: number,
): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.createdAt * 1000 <= cursor) break;
    if (!m.outgoing) n++;
  }
  return n;
}

export function useDMUnreadCount(peer: string | null | undefined): number {
  const dms = useDirectMessages();
  const stored = useReadStateStore((s) => (peer ? s.dmCursors[peer] : undefined));
  return useMemo(() => {
    if (!peer) return 0;
    const list = dms[peer];
    if (!list || list.length === 0) return 0;
    return countDMUnread(list, effectiveCursor(stored));
  }, [peer, dms, stored]);
}

export function useTotalDMUnread(): number {
  const dms = useDirectMessages();
  const cursors = useReadStateStore((s) => s.dmCursors);
  return useMemo(() => {
    let total = 0;
    for (const peer of Object.keys(dms)) {
      const list = dms[peer];
      if (!list || list.length === 0) continue;
      total += countDMUnread(list, effectiveCursor(cursors[peer]));
    }
    return total;
  }, [dms, cursors]);
}

/**
 * Channel unread count. Skips own messages (you wrote them).
 */
export function countChannelUnread(
  messages: ReadonlyArray<JsMessage>,
  cursor: number,
  ownPubkey: string | null,
): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.createdAt * 1000 <= cursor) break;
    if (ownPubkey && m.pubkey === ownPubkey) continue;
    n++;
  }
  return n;
}

export function useChannelUnreadCount(
  groupId: string | null | undefined,
  ownPubkey: string | null,
): number {
  const messages = useMessages(groupId ?? null);
  const stored = useReadStateStore((s) =>
    groupId ? s.groupCursors[groupId] : undefined,
  );
  return useMemo(() => {
    if (!groupId || !messages || messages.length === 0) return 0;
    return countChannelUnread(messages, effectiveCursor(stored), ownPubkey);
  }, [groupId, messages, stored, ownPubkey]);
}

/**
 * Sum of `useChannelUnreadCount` across every channel the bridge has
 * messages for. Subscribes to `messagesByGroup` so it re-evaluates when
 * any channel's message list changes.
 */
export function useTotalChannelUnread(ownPubkey: string | null): number {
  const byGroup = useMessagesByGroup();
  const cursors = useReadStateStore((s) => s.groupCursors);
  return useMemo(() => {
    let total = 0;
    for (const groupId of Object.keys(byGroup)) {
      const list = byGroup[groupId];
      if (!list || list.length === 0) continue;
      total += countChannelUnread(list, effectiveCursor(cursors[groupId]), ownPubkey);
    }
    return total;
  }, [byGroup, cursors, ownPubkey]);
}

/**
 * `true` if any unread message in the channel mentions `ownPubkey`. Reads
 * the precomputed `mentions` field that the bridge stamps at ingest from
 * `extractMentionPubkeysFromMessage(content, tags)` — content tokens AND
 * `#p` tags both count.
 */
export function channelHasMention(
  messages: ReadonlyArray<JsMessage>,
  cursor: number,
  ownPubkey: string | null,
): boolean {
  if (!ownPubkey) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.createdAt * 1000 <= cursor) break;
    if (m.pubkey === ownPubkey) continue;
    if (m.mentions.includes(ownPubkey)) return true;
  }
  return false;
}

export function useChannelHasMention(
  groupId: string | null | undefined,
  ownPubkey: string | null,
): boolean {
  const messages = useMessages(groupId ?? null);
  const stored = useReadStateStore((s) =>
    groupId ? s.groupCursors[groupId] : undefined,
  );
  return useMemo(() => {
    if (!groupId || !messages || messages.length === 0) return false;
    return channelHasMention(messages, effectiveCursor(stored), ownPubkey);
  }, [groupId, messages, stored, ownPubkey]);
}

/**
 * Highlights for a single channel: total unread, plus the subsets that are
 * mentions or replies-to-me, plus the ordered event ids the
 * `MentionNavigator` walks with `↑↓`. All four values are pure functions
 * of the messages list and the cursor — recomputed on render.
 *
 * `eventIds` is oldest→newest and contains only mention OR reply events
 * (deduped). Replies are detected via NIP-10 strict reply marker resolved
 * against the channel's local message list (parent must be known).
 */
export interface ChannelHighlights {
  readonly unread: number;
  readonly mentions: number;
  readonly replies: number;
  readonly eventIds: ReadonlyArray<string>;
}

export const EMPTY_HIGHLIGHTS: ChannelHighlights = {
  unread: 0,
  mentions: 0,
  replies: 0,
  eventIds: [],
};

export function computeChannelHighlights(
  messages: ReadonlyArray<JsMessage>,
  cursor: number,
  ownPubkey: string | null,
): ChannelHighlights {
  if (messages.length === 0) return EMPTY_HIGHLIGHTS;
  const authorById = buildAuthorIndex(messages);
  const eventIds: string[] = [];
  let unread = 0;
  let mentions = 0;
  let replies = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.createdAt * 1000 <= cursor) continue;
    if (ownPubkey && m.pubkey === ownPubkey) continue;
    unread++;
    const mentioned = !!ownPubkey && m.mentions.includes(ownPubkey);
    const replied = isReplyToMe(m, authorById, ownPubkey);
    if (mentioned) mentions++;
    if (replied) replies++;
    if (mentioned || replied) eventIds.push(m.id);
  }
  return { unread, mentions, replies, eventIds };
}

export function useChannelHighlights(
  groupId: string | null | undefined,
  ownPubkey: string | null,
): ChannelHighlights {
  const messages = useMessages(groupId ?? null);
  const stored = useReadStateStore((s) =>
    groupId ? s.groupCursors[groupId] : undefined,
  );
  return useMemo(() => {
    if (!groupId || !messages || messages.length === 0) return EMPTY_HIGHLIGHTS;
    return computeChannelHighlights(messages, effectiveCursor(stored), ownPubkey);
  }, [groupId, messages, stored, ownPubkey]);
}

/**
 * Highlight selector for channel lists. Unlike {@link useChannelHighlights},
 * this reads the already-loaded messages map and does not open a per-channel
 * message subscription. Channel menus can render dozens of rows; subscribing
 * each row would turn one menu paint into a relay REQ burst.
 */
export function useCachedChannelHighlights(
  groupId: string | null | undefined,
  ownPubkey: string | null,
): ChannelHighlights {
  const byGroup = useMessagesByGroup();
  const stored = useReadStateStore((s) =>
    groupId ? s.groupCursors[groupId] : undefined,
  );
  const messages = groupId ? byGroup[groupId] : undefined;
  return useMemo(() => {
    if (!groupId || !messages || messages.length === 0) return EMPTY_HIGHLIGHTS;
    return computeChannelHighlights(messages, effectiveCursor(stored), ownPubkey);
  }, [groupId, messages, stored, ownPubkey]);
}

/**
 * `true` when ANY currently-loaded channel has unread mentions or replies.
 * Used by the ServerRail to overlay an `@`-icon on the active relay tile.
 *
 * Limitation: only reflects channels the bridge has messages for — i.e.
 * the active relay. Inactive relays don't get a badge until cross-relay
 * mention-watch ships in a follow-up PR.
 */
export function useHasAnyHighlights(ownPubkey: string | null): boolean {
  const byGroup = useMessagesByGroup();
  const cursors = useReadStateStore((s) => s.groupCursors);
  return useMemo(() => {
    for (const groupId of Object.keys(byGroup)) {
      const list = byGroup[groupId];
      if (!list || list.length === 0) continue;
      const h = computeChannelHighlights(list, effectiveCursor(cursors[groupId]), ownPubkey);
      if (h.mentions > 0 || h.replies > 0) return true;
    }
    return false;
  }, [byGroup, cursors, ownPubkey]);
}

// Notification counts moved to `@/lib/notifications/selectors` when the
// single mixed inbox was split into independent DM and mention streams.
// See `useNotificationBadgeCount` / `useUnreadMentionCount` /
// `useUnreadDmNotificationCount` there.
