'use client';

import { useEffect, useState } from 'react';
import { useMyPubkey } from '@/lib/nostr-bridge';
import { usePreferences } from '@/lib/preferences';
import { hasUsableKeys } from './attestations';
import { conversationStatus, type PqConversationStatus } from './status';

/** Identity of the answer, so a stale result is discarded on read. */
interface Resolved {
  key: string;
  status: PqConversationStatus;
}

/**
 * Conversation-level post-quantum status for an open DM thread.
 *
 * Returns `null` while the two attestation lookups are still in flight, so a
 * caller renders nothing rather than flashing "Not quantum-safe" at a
 * conversation that turns out to be secured. Both lookups go through
 * `getAttestation`'s stale-while-revalidate cache, so this is a cache read
 * on every thread open after the first.
 *
 * The resolved value is stamped with the inputs that produced it and compared
 * on read, so switching threads reads as "still resolving" without a
 * setState-in-effect reset that would cascade a render.
 *
 * Deliberately does not gate on the `postQuantumEnabled` preference here —
 * `conversationStatus` already folds it in — but a caller that wants to stay
 * silent for users who turned the feature off should check the preference
 * itself. See `DMPanel`.
 */
export function usePqConversationStatus(peer: string | null): PqConversationStatus | null {
  const myPubkey = useMyPubkey();
  const enabled = usePreferences().postQuantumEnabled;
  const key = peer && myPubkey ? `${myPubkey}|${peer}|${enabled}` : null;
  const [resolved, setResolved] = useState<Resolved | null>(null);

  useEffect(() => {
    if (!key || !peer || !myPubkey) return;
    let cancelled = false;
    void Promise.all([hasUsableKeys(myPubkey), hasUsableKeys(peer)])
      .then(([selfHasKeys, peerHasKeys]) => {
        if (cancelled) return;
        setResolved({ key, status: conversationStatus({ enabled, selfHasKeys, peerHasKeys }) });
      })
      // A lookup failure is not evidence of protection. `hasUsableKeys`
      // already swallows relay errors and reports false, so this only fires
      // on something unexpected; treat it the same way.
      .catch(() => {
        if (!cancelled) setResolved({ key, status: 'not-secured' });
      });
    return () => {
      cancelled = true;
    };
  }, [key, peer, myPubkey, enabled]);

  return resolved && resolved.key === key ? resolved.status : null;
}
