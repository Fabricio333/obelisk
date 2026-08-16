'use client';

import { hasUsableKeys } from './attestations';

interface Nip44WithSchemes {
  schemes?: string[];
}

interface MaybePqWindow {
  nostr?: { nip44?: Nip44WithSchemes };
}

export interface SelfPqState {
  /**
   * Marker present and affirmative (`window.nostr.nip44.schemes` includes
   * `'pq'`). Safe for the send path to trust: this is the only case where
   * we actually know the signer can encrypt post-quantum.
   */
  canSend: boolean;
  /**
   * Keys are published and we're on a NIP-07 session, but the extension
   * publishes no `nip44.schemes` marker at all — so whether it can
   * actually encrypt post-quantum is unknown, not assumed. Post-quantum is
   * an optional third argument to `nip44.encrypt`; an unaware extension
   * silently ignores it and returns classic ciphertext, so guessing "true"
   * here would be a silent downgrade the moment a send path trusts it.
   */
  capabilityUnknown: boolean;
  /** We advertise usable post-quantum keys. */
  hasKeys: boolean;
  /** The kind:10203 attestation is on a relay. Currently identical to
   *  `hasKeys` — they diverge only once a signer can report keys it has
   *  not published. */
  attestationPublished: boolean;
}

function nip44Schemes(): string[] | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as MaybePqWindow).nostr?.nip44?.schemes;
}

/**
 * Whether the connected extension can encrypt post-quantum.
 *
 * Post-quantum is an optional third argument to `nip44.encrypt`, so a
 * supporting extension and an unaware one are shaped identically. The only
 * honest signal is an explicit marker: `window.nostr.nip44.schemes`. When
 * that marker is present it is authoritative — including when it positively
 * declares no post-quantum support (e.g. `['nip44']`). When it is absent,
 * `selfPqState` reports `capabilityUnknown` rather than guessing.
 */
export function signerSupportsPq(): boolean {
  const schemes = nip44Schemes();
  return Array.isArray(schemes) && schemes.includes('pq');
}

export async function selfPqState(
  pubkey: string | null,
  loginMethod: string | null,
): Promise<SelfPqState> {
  if (!pubkey) {
    return { canSend: false, capabilityUnknown: false, hasKeys: false, attestationPublished: false };
  }

  const published = await hasUsableKeys(pubkey);

  // Only the NIP-07 surface exposes post-quantum encryption. nsec has no seed
  // to derive from, and a bunker signs remotely with no post-quantum path.
  const viaExtension = loginMethod === 'nip07';

  // If the extension advertises a `nip44.schemes` marker, trust it — even
  // when it positively declares no post-quantum support. When the extension
  // publishes no marker at all, we do not know whether it can encrypt
  // post-quantum, so that state is surfaced explicitly via
  // `capabilityUnknown` rather than guessed as `canSend: true`.
  const markerPresent = Array.isArray(nip44Schemes());
  const canSend = viaExtension && published && markerPresent && signerSupportsPq();
  const capabilityUnknown = viaExtension && published && !markerPresent;

  return { canSend, capabilityUnknown, hasKeys: published, attestationPublished: published };
}
