'use client';

import { hasUsableKeys } from './attestations';

interface Nip44WithSchemes {
  schemes?: string[];
}

interface MaybePqWindow {
  nostr?: { nip44?: Nip44WithSchemes };
}

export interface SelfPqState {
  /** We can actually encrypt post-quantum from this session. */
  canSend: boolean;
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
 * `selfPqState` falls back to attestation presence.
 */
export function signerSupportsPq(): boolean {
  const schemes = nip44Schemes();
  return Array.isArray(schemes) && schemes.includes('pq');
}

export async function selfPqState(
  pubkey: string | null,
  loginMethod: string | null,
): Promise<SelfPqState> {
  if (!pubkey) return { canSend: false, hasKeys: false, attestationPublished: false };

  const published = await hasUsableKeys(pubkey);

  // Only the NIP-07 surface exposes post-quantum encryption. nsec has no seed
  // to derive from, and a bunker signs remotely with no post-quantum path.
  const viaExtension = loginMethod === 'nip07';

  // If the extension advertises a `nip44.schemes` marker, trust it — even
  // when it positively declares no post-quantum support. Only fall back to
  // "this user has published post-quantum keys and is on a NIP-07 session"
  // when the extension publishes no marker at all to go on.
  const markerPresent = Array.isArray(nip44Schemes());
  const canSend = viaExtension && published && (markerPresent ? signerSupportsPq() : true);

  return { canSend, hasKeys: published, attestationPublished: published };
}
