import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '@/lib/quota-safe-storage';
import type { VideoQuality } from '@/lib/voice/quality';
import type { QualitySample } from '@/lib/voice/stats';

interface VoiceState {
  /** Channel id of the call we're currently in, or null if not in any call. */
  currentVoiceChannelId: string | null;
  /**
   * Relay URL where the active call's channel was hosted at join time.
   * Captured so the sidebar status-bar's "jump to call" button can switch
   * relays first when the user navigates to it from a different relay —
   * `useGroups()` only returns groups for the currently-active relay, so
   * without this, jumping back from another relay would land on a chat
   * surface that doesn't know the channel exists.
   */
  currentVoiceRelayUrl: string | null;
  /** Mic enabled? Mirror of VoiceClient.getLocalTracks().mic, kept in store so
   *  the sidebar status bar can re-render without owning the client. */
  isMuted: boolean;
  /** Output silenced (incoming audio not played). Local-only — does not
   *  affect what we publish. */
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isConnecting: boolean;
  error: string | null;
  /** Whether the right-side text-chat rail is visible inside the voice room. */
  isVoiceChatOpen: boolean;
  /** Outbound camera quality cap. Persisted to localStorage. */
  videoQuality: VideoQuality;
  /** Hint we send to peers to cap their outbound to us. Persisted. */
  receivedVideoQuality: VideoQuality;
  /** Per-peer connection-quality samples, keyed by remote pubkey. */
  peerQuality: Record<string, QualitySample>;
  /**
   * Pubkeys currently producing audio above the speaking threshold. Driven
   * by the per-peer SpeakingDetector instances inside the VoiceClient and
   * read by the UI to pulse the speaking orb on each tile. Stored as a
   * frozen object keyed by pubkey because Zustand reference-equality on
   * `Set` doesn't trigger re-renders cleanly.
   */
  speakingPubkeys: Readonly<Record<string, true>>;
  /**
   * Pubkeys this client has muted "for me only" — they're still publishing
   * audio to the channel, but our `<audio>` elements bind their `.muted`
   * attribute to membership in this set so we don't hear them. No Nostr
   * traffic; never affects other participants.
   */
  localMutedPubkeys: Readonly<Record<string, true>>;

  setVoiceChannel: (channelId: string | null, relayUrl?: string | null) => void;
  setMuted: (muted: boolean) => void;
  setDeafened: (deafened: boolean) => void;
  setCameraOn: (on: boolean) => void;
  setScreenSharing: (on: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  setError: (error: string | null) => void;
  setVoiceChatOpen: (open: boolean) => void;
  setVideoQuality: (q: VideoQuality) => void;
  setReceivedVideoQuality: (q: VideoQuality) => void;
  setPeerQuality: (pubkey: string, sample: QualitySample) => void;
  clearPeerQuality: (pubkey: string) => void;
  /** Mark `pubkey` as actively speaking or silent. Idempotent. */
  setSpeaking: (pubkey: string, speaking: boolean) => void;
  /** Mute a single peer for the local listener. */
  muteLocally: (pubkey: string) => void;
  /** Restore audio for a single peer. */
  unmuteLocally: (pubkey: string) => void;
  /** Drop every per-peer mute — used when leaving the call. */
  clearLocalMutes: () => void;
  /** Reset to defaults — called when the call ends. */
  leaveVoice: () => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
  currentVoiceChannelId: null,
  currentVoiceRelayUrl: null,
  isMuted: true,
  isDeafened: false,
  isCameraOn: false,
  isScreenSharing: false,
  isConnecting: false,
  error: null,
  isVoiceChatOpen: false,
  videoQuality: 'auto' as VideoQuality,
  receivedVideoQuality: 'auto' as VideoQuality,
  peerQuality: {},
  speakingPubkeys: {},
  localMutedPubkeys: {},

  setVoiceChannel: (currentVoiceChannelId, relayUrl) =>
    set((s) => ({
      currentVoiceChannelId,
      // Only overwrite the relay if the caller passed one. Pass `null` to
      // explicitly clear (e.g. the parallel `leaveVoice()` reset path).
      currentVoiceRelayUrl: relayUrl === undefined ? s.currentVoiceRelayUrl : relayUrl,
    })),
  setMuted: (isMuted) => set({ isMuted }),
  setDeafened: (isDeafened) => set({ isDeafened }),
  setCameraOn: (isCameraOn) => set({ isCameraOn }),
  setScreenSharing: (isScreenSharing) => set({ isScreenSharing }),
  setConnecting: (isConnecting) => set({ isConnecting }),
  setError: (error) => set({ error }),
  setVoiceChatOpen: (isVoiceChatOpen) => set({ isVoiceChatOpen }),
  setVideoQuality: (videoQuality) => set({ videoQuality }),
  setReceivedVideoQuality: (receivedVideoQuality) => set({ receivedVideoQuality }),
  setPeerQuality: (pubkey, sample) =>
    set((s) => ({ peerQuality: { ...s.peerQuality, [pubkey]: sample } })),
  clearPeerQuality: (pubkey) =>
    set((s) => {
      if (!(pubkey in s.peerQuality)) return s;
      const next = { ...s.peerQuality };
      delete next[pubkey];
      return { peerQuality: next };
    }),
  setSpeaking: (pubkey, speaking) =>
    set((s) => {
      const has = pubkey in s.speakingPubkeys;
      if (speaking && has) return s;
      if (!speaking && !has) return s;
      const next = { ...s.speakingPubkeys };
      if (speaking) next[pubkey] = true as const;
      else delete next[pubkey];
      return { speakingPubkeys: next };
    }),
  muteLocally: (pubkey) =>
    set((s) => {
      if (pubkey in s.localMutedPubkeys) return s;
      return { localMutedPubkeys: { ...s.localMutedPubkeys, [pubkey]: true as const } };
    }),
  unmuteLocally: (pubkey) =>
    set((s) => {
      if (!(pubkey in s.localMutedPubkeys)) return s;
      const next = { ...s.localMutedPubkeys };
      delete next[pubkey];
      return { localMutedPubkeys: next };
    }),
  clearLocalMutes: () =>
    set((s) => (Object.keys(s.localMutedPubkeys).length === 0 ? s : { localMutedPubkeys: {} })),
  leaveVoice: () =>
    set({
      currentVoiceChannelId: null,
      currentVoiceRelayUrl: null,
      isMuted: true,
      isDeafened: false,
      isCameraOn: false,
      isScreenSharing: false,
      isConnecting: false,
      error: null,
      peerQuality: {},
      speakingPubkeys: {},
      localMutedPubkeys: {},
    }),
    }),
    {
      name: 'obelisk:voice:quality',
      storage: createJSONStorage(() => quotaSafeLocalStorage),
      // Only persist user-set quality preferences; runtime state (current
      // channel, mic/camera, peer samples) must reset on reload.
      partialize: (state) => ({
        videoQuality: state.videoQuality,
        receivedVideoQuality: state.receivedVideoQuality,
      }),
    },
  ),
);
