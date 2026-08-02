/**
 * Notification log — two independent streams, never mixed.
 *
 *   • **Mentions** (group scope): an explicit `@you` in a NIP-29 channel.
 *     Scoped per relay, because group state binds to the active relay
 *     (see CLAUDE.md "Single-relay rule for groups"). Mentions are only
 *     ever *scanned* while that relay is the active one — there is no
 *     background cross-relay mention watch, by design.
 *   • **DMs** (account scope): incoming NIP-04 messages. DMs follow the
 *     user across relays via NIP-65, so this stream is relay-agnostic.
 *
 * Each stream owns its own read cursor. Reading your DMs must not mark
 * channel mentions read, and vice versa — that conflation was the whole
 * reason the old single `inboxEvents` + `inboxLastReadAt` pair was wrong.
 *
 * | Stream   | Log                  | Cursor                              | Synced via                      |
 * |----------|----------------------|-------------------------------------|---------------------------------|
 * | mentions | `mentionsByRelay`    | `mentionCursorByRelay[relay]`       | NIP-59 groups-scope wrap        |
 * | DMs      | `dmNotifications`    | `useReadStateStore.inboxLastReadAt` | NIP-59 DM-scope wrap (existing) |
 *
 * The DM cursor deliberately stays in the read-state store: it already
 * rides in the DM-scope gift wrap published to the NIP-65 read+write
 * union, so multi-device convergence keeps working untouched. This store
 * owns the card logs and the per-relay mention cursors only — one source
 * of truth per value.
 *
 * Replies-to-you are NOT notifications. Only an explicit mention pings.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { createEnsureForAccount } from './multi-account';
import { useReadStateStore } from './read-state';

/** Max mention cards retained per relay. */
export const MENTION_CAP_PER_RELAY = 50;
/** Max DM cards retained account-wide. */
export const DM_NOTIFICATION_CAP = 50;

export interface MentionNotification {
  /** The mentioning message's event id — also the dedupe key. */
  readonly id: string;
  /** Normalized relay URL this mention was scanned on. */
  readonly relay: string;
  readonly channelId: string;
  readonly senderPubkey: string;
  readonly preview: string;
  /** Unix **milliseconds**. */
  readonly createdAt: number;
}

export interface DmNotification {
  /** The kind-4 event id — also the dedupe key. */
  readonly id: string;
  readonly senderPubkey: string;
  readonly preview: string;
  /** Unix **milliseconds**. */
  readonly createdAt: number;
}

interface NotificationsPersisted {
  /** Newest-first mention cards, keyed by normalized relay URL. */
  mentionsByRelay: Record<string, MentionNotification[]>;
  /**
   * Per-relay mention read cursor (unix ms). A relay present here with a
   * value has been connected to before; absence is what
   * {@link registerRelay} keys the first-connect floor off.
   */
  mentionCursorByRelay: Record<string, number>;
  /** Newest-first DM cards. Cursor lives in the read-state store. */
  dmNotifications: DmNotification[];
}

interface NotificationsActions {
  /**
   * Stamp a first-connect floor for `relay` if it has never been seen.
   * Must run BEFORE the relay's kind-9 subscriptions open, otherwise the
   * historical backfill floods the bell with mentions from before the
   * user ever opened this relay.
   *
   * Idempotent and deliberately non-destructive on repeat connects: a
   * relay whose cursor already exists keeps it, so mentions cached from
   * the last session stay unread until actually read.
   */
  registerRelay: (relay: string) => void;
  /** Append a mention card. Drops anything at/older than the relay cursor. */
  pushMention: (n: MentionNotification) => void;
  /** Append a DM card. Drops anything at/older than the DM cursor. */
  pushDmNotification: (n: DmNotification) => void;
  /** Mark every mention on `relay` read (cursor := now). */
  markMentionsRead: (relay: string) => void;
  /** Drop `relay`'s mention log and mark it read. */
  clearMentions: (relay: string) => void;
  /** Drop the DM log. Also advances the DM cursor. */
  clearDmNotifications: () => void;
  /** Monotonic merge of a remote mention cursor (NIP-59 groups-scope wrap). */
  applyRemoteMentionCursor: (relay: string, tsMs: number) => void;
  /** Wipe everything — logout chain. */
  reset: () => void;
}

export type NotificationsStore = NotificationsPersisted & NotificationsActions;

export const NOTIFICATIONS_INITIAL: NotificationsPersisted = {
  mentionsByRelay: {},
  mentionCursorByRelay: {},
  dmNotifications: [],
};

/** DM cursor accessor — single source of truth lives in the read-state store. */
function dmCursor(): number {
  return useReadStateStore.getState().inboxLastReadAt;
}

export const useNotificationsStore = create<NotificationsStore>()(
  persist(
    (set) => ({
      ...NOTIFICATIONS_INITIAL,

      registerRelay: (relay) => set((state) => {
        if (state.mentionCursorByRelay[relay] !== undefined) return state;
        return {
          mentionCursorByRelay: {
            ...state.mentionCursorByRelay,
            [relay]: Date.now(),
          },
        };
      }),

      pushMention: (n) => set((state) => {
        if (n.createdAt <= (state.mentionCursorByRelay[n.relay] ?? 0)) return state;
        const existing = state.mentionsByRelay[n.relay] ?? [];
        if (existing.some((m) => m.id === n.id)) return state;
        const next = [n, ...existing]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, MENTION_CAP_PER_RELAY);
        return { mentionsByRelay: { ...state.mentionsByRelay, [n.relay]: next } };
      }),

      pushDmNotification: (n) => set((state) => {
        if (n.createdAt <= dmCursor()) return state;
        if (state.dmNotifications.some((d) => d.id === n.id)) return state;
        const next = [n, ...state.dmNotifications]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, DM_NOTIFICATION_CAP);
        return { dmNotifications: next };
      }),

      markMentionsRead: (relay) => set((state) => ({
        mentionCursorByRelay: { ...state.mentionCursorByRelay, [relay]: Date.now() },
      })),

      clearMentions: (relay) => set((state) => {
        const mentionsByRelay = { ...state.mentionsByRelay };
        delete mentionsByRelay[relay];
        return {
          mentionsByRelay,
          mentionCursorByRelay: { ...state.mentionCursorByRelay, [relay]: Date.now() },
        };
      }),

      clearDmNotifications: () => {
        useReadStateStore.getState().advanceInboxRead();
        set({ dmNotifications: [] });
      },

      applyRemoteMentionCursor: (relay, tsMs) => set((state) => {
        if (tsMs <= (state.mentionCursorByRelay[relay] ?? 0)) return state;
        return {
          mentionCursorByRelay: { ...state.mentionCursorByRelay, [relay]: tsMs },
        };
      }),

      reset: () => set({ ...NOTIFICATIONS_INITIAL }),
    }),
    {
      name: 'obelisk-notifications',
      storage: createJSONStorage(() => {
        if (typeof localStorage === 'undefined') {
          const mem = new Map<string, string>();
          return {
            getItem: (k) => mem.get(k) ?? null,
            setItem: (k, v) => void mem.set(k, v),
            removeItem: (k) => void mem.delete(k),
          };
        }
        return localStorage;
      }),
      partialize: (state) =>
        ({
          mentionsByRelay: state.mentionsByRelay,
          mentionCursorByRelay: state.mentionCursorByRelay,
          dmNotifications: state.dmNotifications,
        }) as NotificationsPersisted,
    },
  ),
);

/**
 * Multi-account isolation — swaps the persist key to
 * `obelisk-notifications:{pubkey}`. Without this, account B on the same
 * browser would inherit account A's mention cards.
 */
export const ensureNotificationsStoreForAccount = createEnsureForAccount(
  'obelisk-notifications',
  useNotificationsStore,
);

// -- read predicates ----------------------------------------------------

/**
 * A mention is read once EITHER cursor has passed it: the relay's mention
 * cursor (bell "mark read") or the channel's own read cursor (the user
 * scrolled past it in the channel). The second clause is what makes the
 * bell badge clear naturally when you just go read the conversation.
 */
export function isMentionRead(
  m: MentionNotification,
  relayCursor: number,
  groupCursor = 0,
): boolean {
  return m.createdAt <= relayCursor || m.createdAt <= groupCursor;
}

export function isDmNotificationRead(d: DmNotification, cursor: number): boolean {
  return d.createdAt <= cursor;
}

// -- non-reactive selectors (for use outside React) ---------------------

export function getUnreadMentionCount(relay: string | null | undefined): number {
  if (!relay) return 0;
  const { mentionsByRelay, mentionCursorByRelay } = useNotificationsStore.getState();
  const list = mentionsByRelay[relay];
  if (!list || list.length === 0) return 0;
  const cursor = mentionCursorByRelay[relay] ?? 0;
  const groupCursors = useReadStateStore.getState().groupCursors;
  let n = 0;
  for (const m of list) {
    if (!isMentionRead(m, cursor, groupCursors[m.channelId] ?? 0)) n++;
  }
  return n;
}

export function getUnreadDmNotificationCount(): number {
  const { dmNotifications } = useNotificationsStore.getState();
  const cursor = dmCursor();
  let n = 0;
  for (const d of dmNotifications) {
    if (!isDmNotificationRead(d, cursor)) n++;
  }
  return n;
}
