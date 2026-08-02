import { describe, it, expect, beforeEach } from 'vitest';
import {
  DM_NOTIFICATION_CAP,
  MENTION_CAP_PER_RELAY,
  NOTIFICATIONS_INITIAL,
  ensureNotificationsStoreForAccount,
  getUnreadDmNotificationCount,
  getUnreadMentionCount,
  isDmNotificationRead,
  isMentionRead,
  useNotificationsStore,
  type MentionNotification,
} from './notifications';
import { READ_STATE_INITIAL, useReadStateStore } from './read-state';

const RELAY_A = 'wss://a.example';
const RELAY_B = 'wss://b.example';

function mention(over: Partial<MentionNotification> = {}): MentionNotification {
  return {
    id: 'm1',
    relay: RELAY_A,
    channelId: 'ch1',
    senderPubkey: 'pk',
    preview: 'hey @me',
    createdAt: 2_000,
    ...over,
  };
}

describe('useNotificationsStore', () => {
  beforeEach(() => {
    useNotificationsStore.setState({ ...NOTIFICATIONS_INITIAL });
    useReadStateStore.setState({ ...READ_STATE_INITIAL });
  });

  describe('registerRelay (first-connect floor)', () => {
    it('stamps a cursor at ~now for an unseen relay', () => {
      const before = Date.now();
      useNotificationsStore.getState().registerRelay(RELAY_A);
      const cursor = useNotificationsStore.getState().mentionCursorByRelay[RELAY_A];
      expect(cursor).toBeGreaterThanOrEqual(before);
      expect(cursor).toBeLessThanOrEqual(Date.now());
    });

    it('does NOT restamp a relay that already has a cursor', () => {
      useNotificationsStore.setState({ mentionCursorByRelay: { [RELAY_A]: 111 } });
      useNotificationsStore.getState().registerRelay(RELAY_A);
      expect(useNotificationsStore.getState().mentionCursorByRelay[RELAY_A]).toBe(111);
    });

    it('keeps cached mentions unread across a reconnect', () => {
      // Session 1: relay seen, a mention arrives and is never read.
      useNotificationsStore.setState({ mentionCursorByRelay: { [RELAY_A]: 1_000 } });
      useNotificationsStore.getState().pushMention(mention({ createdAt: 5_000 }));
      // Session 2: reconnecting must not silence it.
      useNotificationsStore.getState().registerRelay(RELAY_A);
      expect(getUnreadMentionCount(RELAY_A)).toBe(1);
    });

    it('drops the historical backfill on a first-ever connect', () => {
      useNotificationsStore.getState().registerRelay(RELAY_A);
      // Backfill: everything predates the floor stamped a moment ago.
      for (let i = 0; i < 10; i++) {
        useNotificationsStore.getState().pushMention(
          mention({ id: `old${i}`, createdAt: Date.now() - 86_400_000 + i }),
        );
      }
      expect(useNotificationsStore.getState().mentionsByRelay[RELAY_A]).toBeUndefined();
      expect(getUnreadMentionCount(RELAY_A)).toBe(0);
    });

    it('still admits live mentions after the floor is stamped', () => {
      useNotificationsStore.getState().registerRelay(RELAY_A);
      useNotificationsStore.getState().pushMention(
        mention({ createdAt: Date.now() + 1_000 }),
      );
      expect(getUnreadMentionCount(RELAY_A)).toBe(1);
    });
  });

  describe('pushMention', () => {
    it('dedupes by event id', () => {
      useNotificationsStore.getState().pushMention(mention());
      useNotificationsStore.getState().pushMention(mention());
      expect(useNotificationsStore.getState().mentionsByRelay[RELAY_A]).toHaveLength(1);
    });

    it('drops anything at or older than the relay cursor', () => {
      useNotificationsStore.setState({ mentionCursorByRelay: { [RELAY_A]: 5_000 } });
      useNotificationsStore.getState().pushMention(mention({ id: 'old', createdAt: 4_000 }));
      useNotificationsStore.getState().pushMention(mention({ id: 'same', createdAt: 5_000 }));
      useNotificationsStore.getState().pushMention(mention({ id: 'new', createdAt: 6_000 }));
      const list = useNotificationsStore.getState().mentionsByRelay[RELAY_A];
      expect(list.map((m) => m.id)).toEqual(['new']);
    });

    it('keeps the list newest-first', () => {
      useNotificationsStore.getState().pushMention(mention({ id: 'a', createdAt: 100 }));
      useNotificationsStore.getState().pushMention(mention({ id: 'c', createdAt: 300 }));
      useNotificationsStore.getState().pushMention(mention({ id: 'b', createdAt: 200 }));
      const list = useNotificationsStore.getState().mentionsByRelay[RELAY_A];
      expect(list.map((m) => m.id)).toEqual(['c', 'b', 'a']);
    });

    it(`caps per relay at ${MENTION_CAP_PER_RELAY}`, () => {
      for (let i = 0; i < MENTION_CAP_PER_RELAY + 10; i++) {
        useNotificationsStore.getState().pushMention(
          mention({ id: `m${i}`, createdAt: 1_000 + i }),
        );
      }
      expect(useNotificationsStore.getState().mentionsByRelay[RELAY_A])
        .toHaveLength(MENTION_CAP_PER_RELAY);
    });

    it('keeps relays in separate buckets', () => {
      useNotificationsStore.getState().pushMention(mention({ id: 'a', relay: RELAY_A }));
      useNotificationsStore.getState().pushMention(mention({ id: 'b', relay: RELAY_B }));
      const s = useNotificationsStore.getState();
      expect(s.mentionsByRelay[RELAY_A]).toHaveLength(1);
      expect(s.mentionsByRelay[RELAY_B]).toHaveLength(1);
      expect(getUnreadMentionCount(RELAY_A)).toBe(1);
    });
  });

  describe('stream independence', () => {
    it('marking mentions read does not touch DM notifications', () => {
      useNotificationsStore.getState().pushMention(mention());
      useNotificationsStore.getState().pushDmNotification({
        id: 'd1', senderPubkey: 'peer', preview: 'yo', createdAt: 2_000,
      });
      expect(getUnreadMentionCount(RELAY_A)).toBe(1);
      expect(getUnreadDmNotificationCount()).toBe(1);

      useNotificationsStore.getState().markMentionsRead(RELAY_A);

      expect(getUnreadMentionCount(RELAY_A)).toBe(0);
      expect(getUnreadDmNotificationCount()).toBe(1);
    });

    it('reading DMs does not silence channel mentions', () => {
      useNotificationsStore.getState().pushMention(mention());
      useNotificationsStore.getState().pushDmNotification({
        id: 'd1', senderPubkey: 'peer', preview: 'yo', createdAt: 2_000,
      });

      useReadStateStore.getState().advanceInboxRead();

      expect(getUnreadDmNotificationCount()).toBe(0);
      expect(getUnreadMentionCount(RELAY_A)).toBe(1);
    });

    it('marking one relay read leaves other relays untouched', () => {
      useNotificationsStore.getState().pushMention(mention({ id: 'a', relay: RELAY_A }));
      useNotificationsStore.getState().pushMention(mention({ id: 'b', relay: RELAY_B }));
      useNotificationsStore.getState().markMentionsRead(RELAY_A);
      expect(getUnreadMentionCount(RELAY_A)).toBe(0);
      expect(getUnreadMentionCount(RELAY_B)).toBe(1);
    });

    it('clearMentions drops only that relay bucket', () => {
      useNotificationsStore.getState().pushMention(mention({ id: 'a', relay: RELAY_A }));
      useNotificationsStore.getState().pushMention(mention({ id: 'b', relay: RELAY_B }));
      useNotificationsStore.getState().clearMentions(RELAY_A);
      const s = useNotificationsStore.getState();
      expect(s.mentionsByRelay[RELAY_A]).toBeUndefined();
      expect(s.mentionsByRelay[RELAY_B]).toHaveLength(1);
    });

    it('clearDmNotifications wipes the log and advances the DM cursor', () => {
      useNotificationsStore.getState().pushDmNotification({
        id: 'd1', senderPubkey: 'peer', preview: 'yo', createdAt: 2_000,
      });
      useNotificationsStore.getState().clearDmNotifications();
      expect(useNotificationsStore.getState().dmNotifications).toEqual([]);
      expect(useReadStateStore.getState().inboxLastReadAt).toBeGreaterThan(0);
    });
  });

  describe('pushDmNotification', () => {
    it('dedupes by event id and caps the log', () => {
      for (let i = 0; i < DM_NOTIFICATION_CAP + 5; i++) {
        useNotificationsStore.getState().pushDmNotification({
          id: `d${i}`, senderPubkey: 'peer', preview: 'x', createdAt: 1_000 + i,
        });
      }
      useNotificationsStore.getState().pushDmNotification({
        id: 'd0', senderPubkey: 'peer', preview: 'x', createdAt: 1_000,
      });
      expect(useNotificationsStore.getState().dmNotifications)
        .toHaveLength(DM_NOTIFICATION_CAP);
    });

    it('drops anything at or older than the DM cursor', () => {
      useReadStateStore.setState({ inboxLastReadAt: 5_000 });
      useNotificationsStore.getState().pushDmNotification({
        id: 'old', senderPubkey: 'peer', preview: 'x', createdAt: 4_000,
      });
      expect(useNotificationsStore.getState().dmNotifications).toEqual([]);
    });
  });

  describe('read predicates', () => {
    it('a mention is read once the channel cursor passes it', () => {
      const m = mention({ createdAt: 1_000 });
      expect(isMentionRead(m, 0, 0)).toBe(false);
      expect(isMentionRead(m, 0, 2_000)).toBe(true);   // read the channel
      expect(isMentionRead(m, 2_000, 0)).toBe(true);   // dismissed the bell
    });

    it('getUnreadMentionCount honours the channel cursor', () => {
      useNotificationsStore.getState().pushMention(mention({ id: 'a', createdAt: 1_000 }));
      useNotificationsStore.getState().pushMention(
        mention({ id: 'b', channelId: 'ch2', createdAt: 1_000 }),
      );
      useReadStateStore.getState().setGroupCursor('ch1', 5_000);
      expect(getUnreadMentionCount(RELAY_A)).toBe(1);
    });

    it('isDmNotificationRead compares against the DM cursor', () => {
      const d = { id: 'd', senderPubkey: 'p', preview: '', createdAt: 1_000 };
      expect(isDmNotificationRead(d, 500)).toBe(false);
      expect(isDmNotificationRead(d, 1_000)).toBe(true);
    });

    it('getUnreadMentionCount is 0 for an unknown relay', () => {
      expect(getUnreadMentionCount(null)).toBe(0);
      expect(getUnreadMentionCount('wss://never-seen')).toBe(0);
    });
  });

  describe('applyRemoteMentionCursor', () => {
    it('advances monotonically and ignores older remotes', () => {
      useNotificationsStore.getState().applyRemoteMentionCursor(RELAY_A, 1_000);
      useNotificationsStore.getState().applyRemoteMentionCursor(RELAY_A, 500);
      expect(useNotificationsStore.getState().mentionCursorByRelay[RELAY_A]).toBe(1_000);
      useNotificationsStore.getState().applyRemoteMentionCursor(RELAY_A, 2_000);
      expect(useNotificationsStore.getState().mentionCursorByRelay[RELAY_A]).toBe(2_000);
    });

    it('is a no-op (identity preserved) when the remote is not newer', () => {
      useNotificationsStore.getState().applyRemoteMentionCursor(RELAY_A, 1_000);
      const before = useNotificationsStore.getState().mentionCursorByRelay;
      useNotificationsStore.getState().applyRemoteMentionCursor(RELAY_A, 1_000);
      expect(useNotificationsStore.getState().mentionCursorByRelay).toBe(before);
    });
  });

  describe('reset', () => {
    it('wipes both streams', () => {
      useNotificationsStore.getState().pushMention(mention());
      useNotificationsStore.getState().pushDmNotification({
        id: 'd1', senderPubkey: 'p', preview: '', createdAt: 1_000,
      });
      useNotificationsStore.getState().reset();
      const s = useNotificationsStore.getState();
      expect(s.mentionsByRelay).toEqual({});
      expect(s.mentionCursorByRelay).toEqual({});
      expect(s.dmNotifications).toEqual([]);
    });
  });
});

describe('per-account notifications store', () => {
  beforeEach(() => {
    localStorage.clear();
    useNotificationsStore.setState({ ...NOTIFICATIONS_INITIAL });
  });

  it('scopes the persist key to the active pubkey', async () => {
    ensureNotificationsStoreForAccount('a'.repeat(64));
    useNotificationsStore.getState().pushMention(mention());
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('obelisk-notifications:' + 'a'.repeat(64))).not.toBeNull();
  });

  it('switching accounts swaps the persist key', async () => {
    ensureNotificationsStoreForAccount('a'.repeat(64));
    useNotificationsStore.getState().pushMention(mention({ id: 'a' }));
    await new Promise((r) => setTimeout(r, 0));

    ensureNotificationsStoreForAccount('b'.repeat(64));
    useNotificationsStore.getState().pushMention(mention({ id: 'b' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(localStorage.getItem('obelisk-notifications:' + 'a'.repeat(64))).not.toBeNull();
    expect(localStorage.getItem('obelisk-notifications:' + 'b'.repeat(64))).not.toBeNull();
  });
});
