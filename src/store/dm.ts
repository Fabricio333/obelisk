import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '@/lib/quota-safe-storage';
import { createEnsureForAccount } from './multi-account';

export type DMProtocol = 'nip04' | 'nip17';

/**
 * In-memory shape used by the UI / store. Plaintext lives only in RAM.
 */
export interface DMMessage {
  id: string;
  senderPubkey: string;
  recipientPubkey: string;
  content: string;
  createdAt: number; // unix timestamp (seconds)
  protocol: DMProtocol;
  /** Optimistic-send state — true while the event is still publishing. */
  isPending?: boolean;
  /** Populated when publish fails; presence of this field enables the retry UI. */
  sendError?: string;
}

export interface DMThread {
  pubkey: string; // the other participant
  displayName: string;
  picture?: string;
  lastMessage?: string;
  lastMessageAt?: number;
  protocol?: DMProtocol;
}

interface DMPersistedState {
  protocolOverrides: Record<string, DMProtocol>;
}

interface DMState extends DMPersistedState {
  isDMMode: boolean;
  activeDMPubkey: string | null;
  threads: DMThread[];
  messages: DMMessage[];
  isLoadingMessages: boolean;
  isLoadingThreads: boolean;
  /** Has the caller loaded older history at least once? Used by infinite scroll. */
  hasMoreHistory: boolean;
  /** Show the protocol choice popup */
  showProtocolPrompt: string | null;

  setDMMode: (active: boolean) => void;
  setActiveDM: (pubkey: string | null) => void;
  setThreads: (threads: DMThread[]) => void;
  addThread: (thread: DMThread) => void;
  updateThread: (pubkey: string, updates: Partial<DMThread>) => void;
  setMessages: (messages: DMMessage[]) => void;
  prependMessages: (messages: DMMessage[]) => void;
  addMessage: (message: DMMessage) => void;
  replaceMessage: (pendingId: string, real: DMMessage) => void;
  markMessageFailed: (pendingId: string, error: string) => void;
  setLoadingMessages: (loading: boolean) => void;
  setLoadingThreads: (loading: boolean) => void;
  setHasMoreHistory: (value: boolean) => void;
  setProtocolOverride: (pubkey: string, protocol: DMProtocol) => void;
  setShowProtocolPrompt: (pubkey: string | null) => void;
}

export const useDMStore = create<DMState>()(
  persist(
    (set) => ({
      isDMMode: false,
      activeDMPubkey: null,
      threads: [],
      messages: [],
      isLoadingMessages: false,
      isLoadingThreads: false,
      hasMoreHistory: false,
      protocolOverrides: {},
      showProtocolPrompt: null,

      setDMMode: (active) => set({ isDMMode: active }),
      setActiveDM: (pubkey) =>
        set({ activeDMPubkey: pubkey, messages: [], isLoadingMessages: !!pubkey, hasMoreHistory: false }),
      setThreads: (threads) => set({ threads }),
      addThread: (thread) =>
        set((state) => ({
          threads: [thread, ...state.threads.filter((t) => t.pubkey !== thread.pubkey)],
        })),
      updateThread: (pubkey, updates) =>
        set((state) => ({
          threads: state.threads.map((t) => (t.pubkey === pubkey ? { ...t, ...updates } : t)),
        })),
      setMessages: (messages) => set({ messages, isLoadingMessages: false }),
      prependMessages: (older) =>
        set((state) => {
          const existing = new Set(state.messages.map((m) => m.id));
          const fresh = older.filter((m) => !existing.has(m.id));
          return { messages: [...fresh, ...state.messages] };
        }),
      addMessage: (message) =>
        set((state) => {
          if (state.messages.some((m) => m.id === message.id)) return state;
          return { messages: [...state.messages, message] };
        }),
      replaceMessage: (pendingId, real) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === pendingId ? real : m)),
        })),
      markMessageFailed: (pendingId, error) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === pendingId ? { ...m, isPending: false, sendError: error } : m,
          ),
        })),
      setLoadingMessages: (loading) => set({ isLoadingMessages: loading }),
      setLoadingThreads: (loading) => set({ isLoadingThreads: loading }),
      setHasMoreHistory: (value) => set({ hasMoreHistory: value }),
      setProtocolOverride: (pubkey, protocol) =>
        set((state) => ({
          protocolOverrides: { ...state.protocolOverrides, [pubkey]: protocol },
          showProtocolPrompt: null,
        })),
      setShowProtocolPrompt: (pubkey) => set({ showProtocolPrompt: pubkey }),
    }),
    {
      name: 'obelisk-dm-store',
      storage: createJSONStorage(() => quotaSafeLocalStorage),
      // The DM store now persists *only* the user's per-peer protocol
      // override choices (NIP-04 vs NIP-17). Read state lives in
      // `useReadStateStore` (`obelisk-read-state:{pubkey}`); thread + message
      // arrays are ephemeral and rehydrate from the bridge cache.
      partialize: (state) =>
        ({
          protocolOverrides: state.protocolOverrides,
        }) as DMPersistedState,
      // Old app versions persisted decrypted threads/messages. Never merge
      // those legacy fields back into memory, even if they remain on a PWA.
      merge: (persisted, current) => ({
        ...current,
        isDMMode: false,
        activeDMPubkey: null,
        threads: [],
        messages: [],
        isLoadingMessages: false,
        isLoadingThreads: false,
        hasMoreHistory: false,
        showProtocolPrompt: null,
        protocolOverrides: (persisted as Partial<DMPersistedState> | undefined)?.protocolOverrides ?? {},
      }),
    },
  ),
);

/**
 * Multi-account isolation — swaps the persist key to `obelisk-dm-store:{pubkey}`
 * so per-peer protocol overrides don't leak across logins. Idempotent.
 */
export const ensureDMStoreForAccount = createEnsureForAccount(
  'obelisk-dm-store',
  useDMStore,
);
