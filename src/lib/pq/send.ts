'use client';

import { toBase64 } from '@nostr-wot/pq';
import { getPreferences } from '@/lib/preferences';
import { getAttestation } from './attestations';
import { selfPqState, signerSupportsPq } from './capability';

/**
 * Everything the DM send path needs in order to seal post-quantum. Only
 * *public* encapsulation keys: no secret key material ever leaves the
 * extension, and Obelisk deliberately never sees any (see the design doc's
 * non-goals).
 *
 * Deliberately *not* `@nostr-wot/dm`'s `PqSealOptions`. That type belongs to
 * the transport and stays inside `src/lib/nostr-bridge/`; the bridge builds
 * the `{ scheme: 'pq', … }` bag from this plain shape at the call site.
 */
export interface PqSendPlan {
  /** Recipient's ML-KEM-1024 encapsulation key, base64, from their kind:10203. */
  recipientKemKey: string;
  /**
   * *Our own* ML-KEM-1024 encapsulation key, base64, from our own kind:10203.
   *
   * NIP-17 publishes a second gift wrap addressed to the sender, so the
   * sender's outgoing history survives a reload and reaches their other
   * devices. That copy's seal is encrypted *to us*, which means its
   * post-quantum envelope has to be encapsulated to our key, not the
   * recipient's: an envelope built with `recipientKemKey` would need the
   * peer's ML-KEM secret to open, and we would have published a copy of our
   * own message that we can never read again.
   *
   * `null` when our attestation is missing or unusable — the self-copy then
   * falls back to a classic NIP-44 seal (still readable, since NIP-44 to
   * oneself is an ordinary self-ECDH) rather than being unreadable or not
   * being published at all.
   */
  selfKemKey: string | null;
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

    // Cheap, purely local short-circuit before any relay round trip.
    // `canSend` below already requires both of these — a NIP-07 session and a
    // `nip44.schemes` marker that advertises `pq` — so when either is missing
    // the attestation lookups cannot change the answer. Checking them first
    // matters now that the preference defaults on: without it, every DM send
    // on every session would pay two relay queries to learn nothing.
    if (loginMethod !== 'nip07' || !signerSupportsPq()) return null;

    const self = await selfPqState(myPubkey, loginMethod);
    if (!self.canSend) return null;

    const peer = await getAttestation(recipientPubkey);
    // `usable` is true only when a KEM key is present and nothing failed
    // validation; the explicit `kem` check keeps TypeScript honest and guards
    // against a future `usable` that no longer implies a key.
    if (!peer?.usable || !peer.kem) return null;

    // Our own key, for the sender-addressed second wrap. `canSend` already
    // required a usable self-attestation, so this is a cache hit on the
    // lookup `selfPqState` just made; it can only come back empty if the
    // entry expired in between.
    const mine = myPubkey ? await getAttestation(myPubkey) : null;

    return {
      recipientKemKey: toBase64(peer.kem),
      selfKemKey: mine?.usable && mine.kem ? toBase64(mine.kem) : null,
    };
  } catch {
    return null;
  }
}
