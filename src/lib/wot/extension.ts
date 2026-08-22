/**
 * Typed wrapper around `window.nostr.wot` (the nostr-wot extension API).
 *
 * Returns `null` rather than throwing when the extension is absent or any
 * call rejects — callers treat that as "no verdict, fail-open" per the
 * design in docs/wot-integration-plan.md.
 *
 * Every call here goes through the `background` lane of the signer queue
 * (`src/lib/nostr-bridge/signer-queue.ts`). `window.nostr.wot` is the *same*
 * extension object as `window.nostr.signEvent` and shares its single request
 * channel, so an unbounded graph traversal here delays the user's next
 * signature. Nobody is watching a spinner for a WoT verdict; signatures win.
 */
import { enqueueSignerOp } from '@/lib/nostr-bridge/signer-queue';

export type WotStatus = 'absent' | 'configured' | 'error';

export interface WotProbe {
  status: WotStatus;
  /** Active user pubkey hex inside the extension, when known. */
  user?: string | null;
}

interface NostrWotApi {
  getStatus?: () => Promise<unknown>;
  getDistance?: (pubkey: string) => Promise<number | null | undefined>;
  getDistanceBatch?: (
    pubkeys: string[],
    opts?: { maxHops?: number; minPaths?: number },
  ) => Promise<Record<string, number | null>>;
  isInMyWoT?: (pubkey: string, opts?: { maxHops?: number; minPaths?: number }) => Promise<boolean>;
  /**
   * Minimum number of node-disjoint trust paths from the active user to
   * `pubkey`. Higher values mean the verdict is corroborated by multiple
   * independent followers — a single shilled follow can claim 1° but not
   * sustain a high path count. Optional in the API; the engine falls back
   * to distance-only when the extension doesn't expose it.
   */
  getMinPaths?: (pubkey: string, opts?: { maxHops?: number }) => Promise<number | null | undefined>;
}

function api(): NostrWotApi | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { nostr?: { wot?: NostrWotApi } };
  return w.nostr?.wot ?? null;
}

export async function wotProbe(): Promise<WotProbe> {
  const a = api();
  if (!a) return { status: 'absent' };
  // Consider the extension "configured" if ANY distance method exists.
  // Some builds expose `getStatus`, others don't — relying on it is fragile.
  const hasDistance =
    typeof a.getDistanceBatch === 'function' ||
    typeof a.getDistance === 'function';
  if (!hasDistance) return { status: 'absent' };
  if (typeof a.getStatus === 'function') {
    try {
      const raw = await enqueueSignerOp('background', 'wot:getStatus', () => a.getStatus!());
      if (raw && typeof raw === 'object') {
        const r = raw as { configured?: boolean; user?: string | null };
        if (r.configured === false) return { status: 'absent' };
        return { status: 'configured', user: r.user ?? null };
      }
    } catch {
      return { status: 'error' };
    }
  }
  return { status: 'configured' };
}

/**
 * Batch distance lookup. Returns a map of `pubkey → distance` where
 * `distance` is the hop count from the active user. `null` distance means
 * "not reachable within maxHops" — i.e. out of WoT.
 *
 * Resolves with `null` (not partial) when the extension is missing or the
 * call rejects so callers can apply the fail-open policy uniformly.
 */
export interface WotBatchEntry {
  /** Hop distance from the active user, or `null` when out of `maxHops`. */
  distance: number | null;
  /**
   * Minimum disjoint trust paths within `maxHops`. `null` when the
   * extension doesn't report it — engine treats null as "satisfies any
   * minPaths threshold" (fail-open per-field, not per-pubkey).
   */
  paths: number | null;
}

/**
 * Pubkeys per `getDistanceBatch` call. A cold start on a relay-default group
 * list can produce thousands of distinct pubkeys; handing the extension one
 * traversal that large occupies the shared request channel for as long as it
 * takes, which is exactly the head-of-line blocking the queue exists to
 * prevent. Sequential chunks keep each occupancy short.
 */
const DISTANCE_CHUNK = 100;

/**
 * Ceiling on per-pubkey `getMinPaths` round-trips in a single batch. Path
 * count has no batch API, so it costs one extension call each. Exceeding this
 * is logged rather than silently truncated — pubkeys past the cap come back
 * with `paths: null`, which the engine treats as "satisfies the threshold"
 * (fail-open per field, matching the `getMinPaths`-absent case).
 */
const MIN_PATHS_CALL_CAP = 200;

function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function wotBatch(
  pubkeys: string[],
  maxHops: number,
  minPaths: number,
): Promise<Record<string, WotBatchEntry> | null> {
  if (pubkeys.length === 0) return {};
  const a = api();
  if (!a) return null;
  try {
    const out: Record<string, WotBatchEntry> = {};
    const distanceMap: Record<string, number | null> = {};
    if (typeof a.getDistanceBatch === 'function') {
      for (const part of chunk(pubkeys, DISTANCE_CHUNK)) {
        const res = await enqueueSignerOp('background', 'wot:getDistanceBatch', () =>
          a.getDistanceBatch!(part, { maxHops, minPaths }),
        );
        // A non-object answer is a broken/absent engine, not "nobody is
        // reachable". Returning `null` here is the documented contract —
        // callers fail *open* on null but would cache a deny for every
        // pubkey if we handed back a map of nulls instead.
        if (!res || typeof res !== 'object') return null;
        for (const pk of part) distanceMap[pk] = res[pk] ?? null;
      }
    } else if (typeof a.getDistance === 'function') {
      for (const part of chunk(pubkeys, DISTANCE_CHUNK)) {
        await Promise.all(
          part.map(async (pk) => {
            try {
              const d = await enqueueSignerOp('background', 'wot:getDistance', () => a.getDistance!(pk));
              distanceMap[pk] = typeof d === 'number' ? d : null;
            } catch {
              distanceMap[pk] = null;
            }
          }),
        );
      }
    } else {
      return null;
    }

    for (const pk of pubkeys) {
      out[pk] = { distance: distanceMap[pk] ?? null, paths: null };
    }

    // Optional path count. Only queried when the user requires more than one
    // path, and only for pubkeys that already passed the distance check — a
    // pubkey outside `maxHops` is denied on distance alone, so buying its
    // path count is a round-trip spent on an answer that changes nothing.
    // (This is what turned a 200-member list into 200 graph traversals.)
    if (minPaths > 1 && typeof a.getMinPaths === 'function') {
      const candidates = pubkeys.filter((pk) => {
        const d = distanceMap[pk];
        return typeof d === 'number' && d >= 0 && d <= maxHops;
      });
      const queried = candidates.slice(0, MIN_PATHS_CALL_CAP);
      if (candidates.length > queried.length && typeof console !== 'undefined') {
        console.warn('[wot] getMinPaths capped', {
          candidates: candidates.length,
          queried: queried.length,
          skippedTreatedAs: 'paths satisfied',
        });
      }
      for (const part of chunk(queried, DISTANCE_CHUNK)) {
        await Promise.all(
          part.map(async (pk) => {
            try {
              const p = await enqueueSignerOp('background', 'wot:getMinPaths', () =>
                a.getMinPaths!(pk, { maxHops }),
              );
              out[pk] = { distance: distanceMap[pk] ?? null, paths: typeof p === 'number' ? p : null };
            } catch {
              out[pk] = { distance: distanceMap[pk] ?? null, paths: null };
            }
          }),
        );
      }
    }
    return out;
  } catch {
    return null;
  }
}

export async function wotDistance(pubkey: string): Promise<number | null> {
  const a = api();
  if (!a || typeof a.getDistance !== 'function') return null;
  try {
    const d = await enqueueSignerOp('background', 'wot:getDistance', () => a.getDistance!(pubkey));
    return typeof d === 'number' ? d : null;
  } catch {
    return null;
  }
}
