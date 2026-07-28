import { describe, it, expect, beforeEach } from 'vitest';
import {
  useReadStateStore,
  ensureReadStateStoreForAccount,
  getInboxUnreadCount,
  READ_STATE_INITIAL,
  INBOX_CAP,
} from './read-state';

describe('useReadStateStore', () => {
  beforeEach(() => {
    useReadStateStore.setState({ ...READ_STATE_INITIAL });
  });

  it('starts empty', () => {
    const s = useReadStateStore.getState();
    expect(s.dmCursors).toEqual({});
    expect(s.groupCursors).toEqual({});
    expect(s.inboxEvents).toEqual([]);
    expect(s.inboxLastReadAt).toBe(0);
  });

  describe('setDmCursor', () => {
    it('writes a cursor for a new peer', () => {
      useReadStateStore.getState().setDmCursor('alice', 1000);
      expect(useReadStateStore.getState().dmCursors['alice']).toBe(1000);
    });

    it('only advances — never moves backwards', () => {
      useReadStateStore.getState().setDmCursor('alice', 5000);
      useReadStateStore.getState().setDmCursor('alice', 3000);
      expect(useReadStateStore.getState().dmCursors['alice']).toBe(5000);
    });

    it('no-ops when tsMs equals existing cursor (idempotent)', () => {
      useReadStateStore.getState().setDmCursor('alice', 1000);
      const before = useReadStateStore.getState().dmCursors;
      useReadStateStore.getState().setDmCursor('alice', 1000);
      expect(useReadStateStore.getState().dmCursors).toBe(before);
    });
  });

  describe('setGroupCursor', () => {
    it('advances and is monotonic just like dmCursors', () => {
      useReadStateStore.getState().setGroupCursor('g1', 100);
      useReadStateStore.getState().setGroupCursor('g1', 200);
      useReadStateStore.getState().setGroupCursor('g1', 50);
      expect(useReadStateStore.getState().groupCursors['g1']).toBe(200);
    });
  });

  describe('inbox', () => {
    it('pushes events newest-first and dedupes by id', () => {
      const base = {
        type: 'mention' as const,
        senderPubkey: 'pk',
        channelId: 'ch1',
        messageId: 'm1',
        createdAt: '2026-05-08T10:00:00Z',
      };
      useReadStateStore.getState().pushInboxEvent(base);
      useReadStateStore.getState().pushInboxEvent(base);
      expect(useReadStateStore.getState().inboxEvents).toHaveLength(1);
    });

    it(`caps inbox at INBOX_CAP=${INBOX_CAP}`, () => {
      for (let i = 0; i < INBOX_CAP + 10; i++) {
        useReadStateStore.getState().pushInboxEvent({
          type: 'mention',
          senderPubkey: 'pk',
          channelId: 'ch1',
          messageId: `m${i}`,
          createdAt: `2026-05-08T10:00:${i.toString().padStart(2, '0')}Z`,
        });
      }
      expect(useReadStateStore.getState().inboxEvents).toHaveLength(INBOX_CAP);
    });

    it('advanceInboxRead sets inboxLastReadAt to ~now', () => {
      const before = Date.now();
      useReadStateStore.getState().advanceInboxRead();
      const after = Date.now();
      const ts = useReadStateStore.getState().inboxLastReadAt;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('markAllAsRead advances inbox + every supplied DM peer + every supplied channel', () => {
      const before = Date.now();
      useReadStateStore.getState().markAllAsRead(['alice', 'bob'], ['g1', 'g2']);
      const after = Date.now();
      const s = useReadStateStore.getState();
      expect(s.inboxLastReadAt).toBeGreaterThanOrEqual(before);
      expect(s.inboxLastReadAt).toBeLessThanOrEqual(after);
      expect(s.dmCursors['alice']).toBeGreaterThanOrEqual(before);
      expect(s.dmCursors['bob']).toBeGreaterThanOrEqual(before);
      expect(s.groupCursors['g1']).toBeGreaterThanOrEqual(before);
      expect(s.groupCursors['g2']).toBeGreaterThanOrEqual(before);
    });

    it('markAllAsRead is a single set() — subscribers re-render once', () => {
      let renders = 0;
      const unsub = useReadStateStore.subscribe(() => { renders++; });
      useReadStateStore.getState().markAllAsRead(['alice'], ['g1']);
      unsub();
      expect(renders).toBe(1);
    });

    it('markAllAsRead never moves any cursor backwards', () => {
      const future = Date.now() + 60_000;
      useReadStateStore.getState().setDmCursor('alice', future);
      useReadStateStore.getState().setGroupCursor('g1', future);
      useReadStateStore.getState().markAllAsRead(['alice'], ['g1']);
      const s = useReadStateStore.getState();
      // cursors were already past now — markAllAsRead must not regress them
      expect(s.dmCursors['alice']).toBe(future);
      expect(s.groupCursors['g1']).toBe(future);
    });

    it('clearInboxEvents wipes the log', () => {
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm1',
        createdAt: '2026-05-08T10:00:00Z',
      });
      useReadStateStore.getState().clearInboxEvents();
      expect(useReadStateStore.getState().inboxEvents).toEqual([]);
    });

    it('marks mention and reply notifications read from their channel cursor', () => {
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm1',
        createdAt: '2026-05-08T10:00:00Z',
      });
      useReadStateStore.getState().pushInboxEvent({
        type: 'reply', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm2',
        createdAt: '2026-05-08T11:00:00Z',
      });
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch2', messageId: 'm3',
        createdAt: '2026-05-08T09:00:00Z',
      });

      useReadStateStore.getState().setGroupCursor('ch1', Date.parse('2026-05-08T11:00:00Z'));

      expect(getInboxUnreadCount()).toBe(1);
    });

    it('getInboxUnreadCount counts events newer than the cursor', () => {
      useReadStateStore.setState({ inboxLastReadAt: Date.parse('2026-05-08T10:00:00Z') });
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm1',
        createdAt: '2026-05-08T09:00:00Z', // older — read
      });
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm2',
        createdAt: '2026-05-08T11:00:00Z', // newer — unread
      });
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm3',
        createdAt: '2026-05-08T12:00:00Z', // newer — unread
      });
      expect(getInboxUnreadCount()).toBe(2);
    });
  });

  describe('applyRemoteState', () => {
    it('merges new dm cursors and advances existing ones monotonically', () => {
      useReadStateStore.getState().setDmCursor('alice', 100);
      useReadStateStore.getState().setDmCursor('bob', 500);
      useReadStateStore.getState().applyRemoteState({
        dmCursors: { alice: 200, bob: 300, carol: 1000 },
      });
      const s = useReadStateStore.getState();
      expect(s.dmCursors['alice']).toBe(200);  // advanced
      expect(s.dmCursors['bob']).toBe(500);    // remote was older — unchanged
      expect(s.dmCursors['carol']).toBe(1000); // new peer
    });

    it('merges group cursors monotonically', () => {
      useReadStateStore.getState().setGroupCursor('g1', 100);
      useReadStateStore.getState().applyRemoteState({
        groupCursors: { g1: 50, g2: 999 },
      });
      const s = useReadStateStore.getState();
      expect(s.groupCursors['g1']).toBe(100);  // older — kept local
      expect(s.groupCursors['g2']).toBe(999);  // new
    });

    it('advances inboxLastReadAt only when remote is newer', () => {
      useReadStateStore.setState({ inboxLastReadAt: 500 });
      useReadStateStore.getState().applyRemoteState({ inboxLastReadAt: 200 });
      expect(useReadStateStore.getState().inboxLastReadAt).toBe(500);
      useReadStateStore.getState().applyRemoteState({ inboxLastReadAt: 1000 });
      expect(useReadStateStore.getState().inboxLastReadAt).toBe(1000);
    });

    it('is a no-op when nothing is newer (object identity preserved)', () => {
      useReadStateStore.getState().setGroupCursor('g1', 500);
      const before = useReadStateStore.getState();
      useReadStateStore.getState().applyRemoteState({
        groupCursors: { g1: 100 },
      });
      const after = useReadStateStore.getState();
      // Same object reference signals "no setState" for downstream subscribers.
      expect(after.groupCursors).toBe(before.groupCursors);
    });

    it('handles a fully empty snapshot', () => {
      useReadStateStore.getState().setGroupCursor('g1', 500);
      useReadStateStore.getState().applyRemoteState({});
      expect(useReadStateStore.getState().groupCursors['g1']).toBe(500);
    });

    it('atomically merges all three categories in one update', () => {
      let renderCount = 0;
      const unsub = useReadStateStore.subscribe(() => { renderCount++; });
      useReadStateStore.getState().applyRemoteState({
        dmCursors: { alice: 100 },
        groupCursors: { g1: 200 },
        inboxLastReadAt: 300,
      });
      unsub();
      // Single set() call; downstream subscribers re-render exactly once.
      expect(renderCount).toBe(1);
    });
  });

  describe('reset', () => {
    it('wipes all cursors and inbox', () => {
      useReadStateStore.getState().setDmCursor('alice', 1000);
      useReadStateStore.getState().setGroupCursor('g1', 2000);
      useReadStateStore.getState().pushInboxEvent({
        type: 'mention', senderPubkey: 'pk', channelId: 'ch1', messageId: 'm1',
        createdAt: '2026-05-08T10:00:00Z',
      });
      useReadStateStore.getState().reset();
      const s = useReadStateStore.getState();
      expect(s.dmCursors).toEqual({});
      expect(s.groupCursors).toEqual({});
      expect(s.inboxEvents).toEqual([]);
      expect(s.inboxLastReadAt).toBe(0);
    });
  });
});

describe('per-account read-state store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persist key includes the active pubkey', async () => {
    ensureReadStateStoreForAccount('a'.repeat(64));
    useReadStateStore.getState().setDmCursor('peer-1', 12345);
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.getItem('obelisk-read-state:' + 'a'.repeat(64))).not.toBeNull();
  });

  it('switching accounts swaps the persist key', async () => {
    ensureReadStateStoreForAccount('a'.repeat(64));
    useReadStateStore.getState().setDmCursor('peer-1', 100);
    await new Promise((r) => setTimeout(r, 0));

    ensureReadStateStoreForAccount('b'.repeat(64));
    useReadStateStore.getState().setDmCursor('peer-2', 200);
    await new Promise((r) => setTimeout(r, 0));

    expect(localStorage.getItem('obelisk-read-state:' + 'a'.repeat(64))).not.toBeNull();
    expect(localStorage.getItem('obelisk-read-state:' + 'b'.repeat(64))).not.toBeNull();
  });
});
