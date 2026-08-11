/**
 * Persisted WoT settings + extension status. Drives the engine config.
 *
 * Persisted bits: `enabled`, `maxHops`. The probe `status` is volatile —
 * recomputed on app mount and on `visibilitychange` so swapping the
 * extension on/off without a reload reflects in the UI.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { quotaSafeLocalStorage } from '@/lib/quota-safe-storage';
import { wotEngine } from './engine';
import { wotProbe, type WotStatus } from './extension';

interface WotState {
  enabled: boolean;
  maxHops: number;
  minPaths: number;
  status: WotStatus;
  setEnabled: (next: boolean) => void;
  setMaxHops: (hops: number) => void;
  setMinPaths: (paths: number) => void;
  setStatus: (status: WotStatus) => void;
  refreshStatus: () => Promise<void>;
}

export const useWotStore = create<WotState>()(
  persist(
    (set, get) => ({
      enabled: false,
      maxHops: 2,
      minPaths: 1,
      status: 'absent',
      setEnabled: (next) => {
        set({ enabled: next });
        wotEngine.configure({ enabled: next && get().status === 'configured' });
      },
      setMaxHops: (hops) => {
        const clamped = Math.max(1, Math.min(4, Math.floor(hops)));
        set({ maxHops: clamped });
        wotEngine.configure({ maxHops: clamped });
      },
      setMinPaths: (paths) => {
        const clamped = Math.max(1, Math.min(3, Math.floor(paths)));
        set({ minPaths: clamped });
        wotEngine.configure({ minPaths: clamped });
      },
      setStatus: (status) => {
        set({ status });
        // Engine should only run when the extension is actually configured.
        wotEngine.configure({ enabled: get().enabled && status === 'configured' });
      },
      refreshStatus: async () => {
        const probe = await wotProbe();
        get().setStatus(probe.status);
      },
    }),
    {
      name: 'obelisk:wot',
      storage: createJSONStorage(() => quotaSafeLocalStorage),
      partialize: (s) => ({ enabled: s.enabled, maxHops: s.maxHops, minPaths: s.minPaths }),
    },
  ),
);

let initialized = false;

/**
 * Wire the store to the engine and start probing the extension. Idempotent
 * — safe to call from multiple mount points (AppShell + WotSettings).
 */
export function initializeWot(): void {
  if (initialized) return;
  if (typeof window === 'undefined') return;
  initialized = true;
  const s = useWotStore.getState();
  wotEngine.configure({
    enabled: s.enabled && s.status === 'configured',
    maxHops: s.maxHops,
    minPaths: s.minPaths,
  });
  // Expose the engine for manual inspection: `window.wot.stats()`.
  (window as unknown as { wot?: unknown }).wot = wotEngine;
  void s.refreshStatus();
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void useWotStore.getState().refreshStatus();
    }
  });
}
