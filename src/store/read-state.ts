import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '@/lib/quota-safe-storage';
import { createEnsureForAccount } from './multi-account';

interface ReadStatePersisted {
  /** Per-peer DM read cursor in unix milliseconds. Monotonic — only advances. */
  dmCursors: Record<string, number>;
  /** Per-channel read cursor in unix milliseconds. Monotonic. */
  groupCursors: Record<string, number>;
  /**
   * Read cursor for the **DM notification stream** (unix ms). A DM card
   * older than this is read.
   *
   * Group mentions have their own per-relay cursor in
   * `useNotificationsStore.mentionCursorByRelay` and are deliberately NOT
   * governed by this value — reading DMs must not silence channel pings.
   *
   * The name is kept (rather than `dmNotificationLastReadAt`) because it
   * is the wire field in the NIP-59 DM-scope payload; renaming it would
   * desync every already-published gift wrap.
   */
  inboxLastReadAt: number;
}

/**
 * Snapshot delivered by the relay-sync engine after unwrapping a
 * NIP-59 gift-wrapped state event. All fields are optional so a single
 * remote state event can carry just the parts that scope demands —
 * per-relay events carry only `groupCursors`; DM events carry
 * `dmCursors` + `inboxLastReadAt`.
 *
 * The merge is monotonic: each cursor takes `max(local, remote)`,
 * making the entire state a CRDT under cursor-wise max — devices
 * converge regardless of arrival order.
 */
export interface RemoteReadState {
  readonly dmCursors?: Readonly<Record<string, number>>;
  readonly groupCursors?: Readonly<Record<string, number>>;
  readonly inboxLastReadAt?: number;
}

interface ReadStateActions {
  /** Advance the DM cursor for `peer` to `tsMs`. No-op if `tsMs` <= existing. */
  setDmCursor: (peer: string, tsMs: number) => void;
  /** Advance the channel cursor. No-op if `tsMs` <= existing. */
  setGroupCursor: (groupId: string, tsMs: number) => void;
  /** Mark the DM notification stream as read at `Date.now()`. */
  advanceInboxRead: () => void;
  /**
   * Mark everything as read at `Date.now()` — inbox cursor + every DM peer
   * cursor + every channel cursor in the supplied lists. The lists come from
   * the bridge (currently-loaded `dmsByPeer` keys + `messagesByGroup` keys)
   * so the store stays bridge-agnostic. Used by the "Mark all read" buttons
   * in the inbox / bell drawer; users expect it to clear the tab-title
   * `(N)` badge, which sums DM+channel unreads.
   */
  markAllAsRead: (peers: ReadonlyArray<string>, groupIds: ReadonlyArray<string>) => void;
  /**
   * Merge a remote state snapshot (from a NIP-59 state event) into the
   * local store. Each cursor advances to `max(local, remote)`; smaller
   * values are dropped. Atomic — a single Zustand state update so
   * subscribers re-render once.
   */
  applyRemoteState: (remote: RemoteReadState) => void;
  /** Wipe everything. Called from the logout chain. */
  reset: () => void;
}

export type ReadStateStore = ReadStatePersisted & ReadStateActions;

export const READ_STATE_INITIAL: ReadStatePersisted = {
  dmCursors: {},
  groupCursors: {},
  inboxLastReadAt: 0,
};

export const useReadStateStore = create<ReadStateStore>()(
  persist(
    (set) => ({
      ...READ_STATE_INITIAL,

      setDmCursor: (peer, tsMs) => set((state) => {
        const prev = state.dmCursors[peer] ?? 0;
        if (tsMs <= prev) return state;
        return { dmCursors: { ...state.dmCursors, [peer]: tsMs } };
      }),

      setGroupCursor: (groupId, tsMs) => set((state) => {
        const prev = state.groupCursors[groupId] ?? 0;
        if (tsMs <= prev) return state;
        return { groupCursors: { ...state.groupCursors, [groupId]: tsMs } };
      }),

      advanceInboxRead: () => set({ inboxLastReadAt: Date.now() }),

      markAllAsRead: (peers, groupIds) => set((state) => {
        const now = Date.now();
        const dmCursors = { ...state.dmCursors };
        let dmTouched = false;
        for (const peer of peers) {
          if ((dmCursors[peer] ?? 0) < now) {
            dmCursors[peer] = now;
            dmTouched = true;
          }
        }
        const groupCursors = { ...state.groupCursors };
        let gTouched = false;
        for (const gid of groupIds) {
          if ((groupCursors[gid] ?? 0) < now) {
            groupCursors[gid] = now;
            gTouched = true;
          }
        }
        return {
          ...(dmTouched ? { dmCursors } : {}),
          ...(gTouched ? { groupCursors } : {}),
          inboxLastReadAt: now,
        };
      }),

      applyRemoteState: (remote) => set((state) => {
        const next: Partial<ReadStatePersisted> = {};
        if (remote.dmCursors) {
          let touched = false;
          const merged: Record<string, number> = { ...state.dmCursors };
          for (const [peer, ts] of Object.entries(remote.dmCursors)) {
            const prev = merged[peer] ?? 0;
            if (ts > prev) {
              merged[peer] = ts;
              touched = true;
            }
          }
          if (touched) next.dmCursors = merged;
        }
        if (remote.groupCursors) {
          let touched = false;
          const merged: Record<string, number> = { ...state.groupCursors };
          for (const [gid, ts] of Object.entries(remote.groupCursors)) {
            const prev = merged[gid] ?? 0;
            if (ts > prev) {
              merged[gid] = ts;
              touched = true;
            }
          }
          if (touched) next.groupCursors = merged;
        }
        if (
          typeof remote.inboxLastReadAt === 'number' &&
          remote.inboxLastReadAt > state.inboxLastReadAt
        ) {
          next.inboxLastReadAt = remote.inboxLastReadAt;
        }
        return Object.keys(next).length > 0 ? next : state;
      }),

      reset: () => set({ ...READ_STATE_INITIAL }),
    }),
    {
      name: 'obelisk-read-state',
      storage: createJSONStorage(() => quotaSafeLocalStorage),
      partialize: (state) =>
        ({
          dmCursors: state.dmCursors,
          groupCursors: state.groupCursors,
          inboxLastReadAt: state.inboxLastReadAt,
        }) as ReadStatePersisted,
    },
  ),
);

/**
 * Multi-account isolation — swaps the persist key to `obelisk-read-state:{pubkey}`
 * so cursors don't leak across logins on the same device. Idempotent.
 */
export const ensureReadStateStoreForAccount = createEnsureForAccount(
  'obelisk-read-state',
  useReadStateStore,
);
