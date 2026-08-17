'use client';

import { toBase64 } from '@nostr-wot/pq';
import { getPreferences } from '@/lib/preferences';
import { getAttestation } from './attestations';
import { selfPqState } from './capability';

/**
 * Everything the DM send path needs in order to seal post-quantum. Only the
 * recipient's key: the sender's key material never leaves the extension, and
 * Obelisk deliberately never sees it (see the design doc's non-goals).
 *
 * Deliberately *not* `@nostr-wot/dm`'s `PqSealOptions`. That type belongs to
 * the transport and stays inside `src/lib/nostr-bridge/`; the bridge builds
 * the `{ scheme: 'pq', … }` bag from this plain shape at the call site.
 */
export interface PqSendPlan {
  /** Recipient's ML-KEM-1024 encapsulation key, base64, from their kind:10203. */
  recipientKemKey: string;
}

/**
 * Decide whether this outgoing DM can be sealed post-quantum.
 *
 * Returns `null` — meaning "send classic NIP-17" — for every negative case.
 * **This function never throws and never blocks a send.** A message that
 * cannot be quantum-secured still goes out; the conversation notice does the
 * teaching. That rule is in the spec and is non-negotiable, so every failure
 * mode here (no preference, no capability, no attestation, an unreachable
 * relay, a malformed attestation) collapses to the same `null`.
 *
 * Three conditions must all hold:
 *
 * 1. The `postQuantumEnabled` preference is on.
 * 2. `selfPqState().canSend` — the session can actually encrypt post-quantum.
 * 3. The peer publishes a *usable* kind:10203 attestation carrying a KEM key.
 *
 * On (2) we require `canSend`, not `canSend || capabilityUnknown`. Under
 * `capabilityUnknown` the extension publishes no `nip44.schemes` marker, so
 * post-quantum support is unobservable, and both ways it can go are bad:
 * an unaware extension silently ignores `nip44.encrypt`'s optional third
 * argument and returns classic ciphertext, which we would then record as
 * `pq: true` — a false security claim, the single worst outcome this feature
 * can produce — while a strict one throws, and throwing is what
 * `Nip46Signer` deliberately does rather than downgrade. Sending classic and
 * labelling it classic is honest in both worlds.
 */
export async function resolvePqSend(params: {
  myPubkey: string | null;
  loginMethod: string | null;
  recipientPubkey: string;
}): Promise<PqSendPlan | null> {
  const { myPubkey, loginMethod, recipientPubkey } = params;
  try {
    if (!getPreferences().postQuantumEnabled) return null;

    const self = await selfPqState(myPubkey, loginMethod);
    if (!self.canSend) return null;

    const peer = await getAttestation(recipientPubkey);
    // `usable` is true only when a KEM key is present and nothing failed
    // validation; the explicit `kem` check keeps TypeScript honest and guards
    // against a future `usable` that no longer implies a key.
    if (!peer?.usable || !peer.kem) return null;

    return { recipientKemKey: toBase64(peer.kem) };
  } catch {
    return null;
  }
}
