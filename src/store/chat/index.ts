import { create } from 'zustand';

export interface ChatState {
  activeChannelId: string | null;
  isNearBottom: boolean;
  serverEmojis: Record<string, string>;
  serverMediaKinds: Record<string, 'emoji' | 'gif' | 'sticker'>;
  profilePopupPubkey: string | null;
  profilePopupAnchor: { x: number; y: number } | null;
  lastActivityAt: Record<string, number>;
  presenceTick: number;
  setServerEmojis: (emojis: Record<string, string>, kinds?: ChatState['serverMediaKinds']) => void;
  openProfilePopup: (pubkey: string, anchor?: { x: number; y: number }) => void;
  closeProfilePopup: () => void;
  recordActivity: (pubkey: string, atMs: number) => void;
  bumpPresenceTick: () => void;
  reset: () => void;
}

export const CHAT_INITIAL_STATE = {
  activeChannelId: null as string | null,
  isNearBottom: true,
  serverEmojis: {} as Record<string, string>,
  serverMediaKinds: {} as ChatState['serverMediaKinds'],
  profilePopupPubkey: null as string | null,
  profilePopupAnchor: null as { x: number; y: number } | null,
  lastActivityAt: {} as Record<string, number>,
  presenceTick: 0,
};

export const useChatStore = create<ChatState>()((set) => ({
  ...CHAT_INITIAL_STATE,
  setServerEmojis: (serverEmojis, serverMediaKinds = {}) => set({ serverEmojis, serverMediaKinds }),
  openProfilePopup: (profilePopupPubkey, profilePopupAnchor = null) => set({ profilePopupPubkey, profilePopupAnchor }),
  closeProfilePopup: () => set({ profilePopupPubkey: null, profilePopupAnchor: null }),
  recordActivity: (pubkey, atMs) => set((state) =>
    atMs <= (state.lastActivityAt[pubkey] ?? 0)
      ? state
      : { lastActivityAt: { ...state.lastActivityAt, [pubkey]: atMs }, presenceTick: Date.now() },
  ),
  bumpPresenceTick: () => set({ presenceTick: Date.now() }),
  reset: () => set(CHAT_INITIAL_STATE),
}));
