'use client';

/**
 * Mounts a global `<NostrSessionProvider>` around the entire app and keeps
 * the SDK's session in lockstep with the bridge's auth state.
 *
 * Why: components are migrating from `nostr-bridge` hooks
 * (`useMyPubkey`, `useUserMetadata`, …) to the SDK hooks
 * (`usePubkey`, `useProfile`, …). The SDK hooks read from a session context;
 * if no signer is attached, they return `null`. This component bridges the
 * bridge's session into the SDK context so SDK hooks "just work" everywhere
 * the bridge is logged in — without making any of the migrated components
 * aware of the bridge.
 *
 * Adapter shape: the bridge doesn't expose nip04/nip44 encrypt/decrypt, so
 * the adapter only implements `getPublicKey` + `signEvent`. That's enough
 * for profile reads / writes (kind 0) and any other feature the SDK covers.
 * NIP-29 messaging, voice, and DMs continue to use the bridge directly.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { NostrSessionProvider } from '@nostr-wot/ui';
import { useLogin, useLogout } from '@nostr-wot/data/react';
import { setPool } from '@nostr-wot/data';
import type { SessionSigner } from '@nostr-wot/data/react';
import { getBridge } from '@/lib/nostr-bridge';
import type { NostrBridge } from '@/lib/nostr-bridge/types';
import { getNostrPool } from '@/lib/nostr-pool';

// Share Obelisk's TextCoercing-aware SimplePool with the SDK so SDK
// fetchers (fetchProfile, fetchRelayList, …) ride the same WebSocket
// connections and don't trip on relays that push binary frames. Runs
// at module load — browser only, since the pool needs `WebSocket`.
if (typeof window !== 'undefined') {
  try { setPool(getNostrPool()); } catch { /* ignore */ }
}

function buildAdapter(bridge: NostrBridge): SessionSigner {
  return {
    getPublicKey: async () => bridge.getPublicKey() ?? '',
    signEvent: async (template) =>
      bridge.signEventTemplate(template as Parameters<NostrBridge['signEventTemplate']>[0]),
    // The bridge does not expose nip04/nip44 — leave undefined. Consumers
    // that need encryption (DMs, KEK signer) keep using the bridge directly.
  };
}

function BridgeToSdkSync({ children }: { children: ReactNode }): ReactNode {
  const login = useLogin();
  const logout = useLogout();
  const [bridge, setBridge] = useState<NostrBridge | null>(null);

  // Resolve the bridge instance once.
  useEffect(() => {
    let cancelled = false;
    void getBridge().then((b) => {
      if (!cancelled) setBridge(b);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to bridge auth state and mirror into SDK session.
  useEffect(() => {
    if (!bridge) return undefined;

    let lastPubkey: string | null = null;
    let cancelled = false;

    const sync = () => {
      if (cancelled) return;
      const pk = bridge.getPublicKey();
      if (pk && pk !== lastPubkey) {
        lastPubkey = pk;
        const adapter = buildAdapter(bridge);
        void login(adapter);
      } else if (!pk && lastPubkey !== null) {
        lastPubkey = null;
        void logout();
      }
    };

    const unsubPubkey = bridge.subscribeMyPubkey(() => sync());

    // Initial sync (in case the bridge already has a session before our
    // subscribers fire).
    sync();

    return () => {
      cancelled = true;
      unsubPubkey();
    };
  }, [bridge, login, logout]);

  return children;
}

export default function SdkSessionBridge({ children }: { children: ReactNode }) {
  return (
    <NostrSessionProvider autoRestore={false} theme="la-crypta">
      <BridgeToSdkSync>{children}</BridgeToSdkSync>
    </NostrSessionProvider>
  );
}
