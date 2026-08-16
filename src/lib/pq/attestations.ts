'use client';

import { attestationFilter, parseAttestation, type PqAttestation } from '@nostr-wot/pq';
import { getPool, getDefaultRelays } from '@nostr-wot/data';

/** How long a looked-up attestation stays fresh. Attestations are replaceable
 *  events that change rarely, so this is generous on purpose. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** A failed lookup is not evidence of absence, so it expires fast. Short
 *  rather than uncached so a persistently unreachable relay cannot be
 *  re-queried on every render. */
const FAILURE_TTL_MS = 30 * 1000;

interface Entry {
  attestation: PqAttestation | null;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<PqAttestation | null>>();

export function clearAttestationCache(): void {
  cache.clear();
  inflight.clear();
}

async function fetchAttestation(pubkey: string): Promise<PqAttestation | null> {
  try {
    // The bridge's SimplePool is private, so lib modules go through
    // @nostr-wot/data's shared pool — the same one the profile and follow
    // fetchers use, so attestation lookups share its connections.
    const events = await getPool().querySync(getDefaultRelays(), attestationFilter([pubkey]));
    if (!events?.length) return null;
    // Replaceable kind: the newest wins.
    const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    return parseAttestation(newest);
  } catch {
    // A relay failure looks identical to "no attestation" to the caller —
    // querySync resolves with [] rather than rejecting when every relay
    // fails, so this catch only ever fires on a thrown query. Either way
    // it's a negative result, not evidence of absence, and gets the short TTL.
    return null;
  }
}

export async function getAttestation(pubkey: string): Promise<PqAttestation | null> {
  const hit = cache.get(pubkey);
  if (hit) {
    const ttl = hit.attestation === null ? FAILURE_TTL_MS : TTL_MS;
    if (Date.now() - hit.fetchedAt < ttl) return hit.attestation;
  }

  const existing = inflight.get(pubkey);
  if (existing) return existing;

  const promise = fetchAttestation(pubkey)
    .then((attestation) => {
      cache.set(pubkey, { attestation, fetchedAt: Date.now() });
      return attestation;
    })
    .finally(() => {
      inflight.delete(pubkey);
    });

  inflight.set(pubkey, promise);
  return promise;
}

/** Whether this pubkey advertises post-quantum keys we could encrypt to. */
export async function hasUsableKeys(pubkey: string): Promise<boolean> {
  const att = await getAttestation(pubkey);
  return att?.usable === true;
}
