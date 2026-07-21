import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from './chat';

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.getState().reset();
  });

  it('starts with only the shared UI state', () => {
    expect(useChatStore.getState()).toMatchObject({
      activeChannelId: null,
      isNearBottom: true,
      serverEmojis: {},
      profilePopupPubkey: null,
      lastActivityAt: {},
      presenceTick: 0,
    });
  });

  it('updates emoji and profile-popup state', () => {
    useChatStore.getState().setServerEmojis({ party: 'https://example.com/party.png' });
    useChatStore.getState().openProfilePopup('alice');
    expect(useChatStore.getState().serverEmojis).toEqual({ party: 'https://example.com/party.png' });
    expect(useChatStore.getState().profilePopupPubkey).toBe('alice');
    useChatStore.getState().closeProfilePopup();
    expect(useChatStore.getState().profilePopupPubkey).toBeNull();
  });

  it('keeps the newest activity timestamp and advances the presence clock', () => {
    useChatStore.getState().recordActivity('alice', 20);
    useChatStore.getState().recordActivity('alice', 10);
    useChatStore.getState().bumpPresenceTick();
    expect(useChatStore.getState().lastActivityAt.alice).toBe(20);
    expect(useChatStore.getState().presenceTick).toBeGreaterThan(0);
  });

  it('resets account-scoped UI state', () => {
    useChatStore.setState({
      activeChannelId: 'group',
      isNearBottom: false,
      serverEmojis: { party: 'url' },
      profilePopupPubkey: 'alice',
      lastActivityAt: { alice: 20 },
      presenceTick: 2,
    });
    useChatStore.getState().reset();
    expect(useChatStore.getState()).toMatchObject({
      activeChannelId: null,
      isNearBottom: true,
      serverEmojis: {},
      profilePopupPubkey: null,
      lastActivityAt: {},
      presenceTick: 0,
    });
  });
});
