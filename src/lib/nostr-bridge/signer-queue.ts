/**
 * Priority queue in front of the remote signer (NIP-07 extension / NIP-46
 * bunker).
 *
 * ## Why
 *
 * Every `window.nostr.*` call — `signEvent`, `nip04.*`, `nip44.*`, and the
 * `nostr-wot` extension's `wot.*` namespace — travels the same NIP-07 bridge:
 * page → `postMessage` → content script → `chrome.runtime` → MV3 service
 * worker. Extensions service that channel one request at a time, and an idle
 * MV3 worker adds a cold-start on top. Bunker has the same shape with worse
 * per-request cost: a full relay round-trip, sometimes a user approval prompt.
 *
 * The app produces far more background signer traffic than interactive
 * traffic — inbound gift-wrap decrypts, read-state unwrapping, WoT distance
 * lookups. Without ordering, a user pressing Enter on a message lands behind
 * hundreds of those, and the signature that should take one round-trip takes
 * seconds. Latency was `queue_depth × per_request_cost`.
 *
 * This module makes the depth *ours* instead of the signer's, so we can
 * reorder it.
 *
 * ## Design
 *
 * - **`MAX_IN_FLIGHT = 1`.** The signer is serial anyway, so holding one slot
 *   costs no throughput. It is also the whole point: once a request has been
 *   handed to the extension we cannot take it back, so the cap on in-flight
 *   background work *is* the cap on how long an arriving interactive request
 *   waits. With a cap of 1 it waits for at most one background round-trip.
 * - **Strict priority.** The `interactive` lane drains completely before
 *   `background`; FIFO within a lane. There is deliberately no aging /
 *   anti-starvation heuristic: interactive traffic is rare and bursty (a
 *   keystroke-to-send, a relay AUTH, a zap), so the background lane always
 *   gets the channel back within a few requests. Adding fairness here would
 *   trade the guarantee we actually want for one we don't need.
 * - **The slot is released in `finally`**, so a rejected op never wedges the
 *   drain.
 *
 * ## Scope
 *
 * Only the `nip07` and `bunker` login methods route through here. `nsec` signs
 * and decrypts with local synchronous crypto — queueing it would add latency
 * to buy nothing. Callers keep their existing `if (loginMethod === 'nsec')`
 * early returns and wrap only the two remote branches.
 *
 * ## Lane assignment
 *
 * A lane is a property of the **call site**, not of the operation. The same
 * `nip44Decrypt` is background when it opens an inbound gift wrap and
 * interactive when it decrypts an NWC wallet response the user is waiting on.
 * Signer factories therefore take a lane parameter that **defaults to
 * `interactive`**, and only known-background call sites opt out. A new caller
 * that forgets to think about it gets prioritized, which is the safe failure.
 */

import { pushRelayDebug } from './relay-debug';

export type SignerLane = 'interactive' | 'background';

/**
 * How many signer requests may be outstanding at once. See the module doc:
 * this is the bound on how long an interactive request waits behind
 * background work, not a throughput knob.
 */
export const MAX_IN_FLIGHT = 1;

interface QueueEntry {
  readonly lane: SignerLane;
  readonly label: string;
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

const lanes: Record<SignerLane, QueueEntry[]> = {
  interactive: [],
  background: [],
};

let inFlight = 0;

export interface SignerQueueStats {
  interactive: number;
  background: number;
  inFlight: number;
}

export function signerQueueStats(): SignerQueueStats {
  return {
    interactive: lanes.interactive.length,
    background: lanes.background.length,
    inFlight,
  };
}

function nextEntry(): QueueEntry | undefined {
  return lanes.interactive.shift() ?? lanes.background.shift();
}

function drain(): void {
  while (inFlight < MAX_IN_FLIGHT) {
    const entry = nextEntry();
    if (!entry) return;
    inFlight += 1;
    // `run` may throw synchronously — Promise.resolve().then keeps that on the
    // rejection path instead of escaping into the drain loop.
    void Promise.resolve()
      .then(entry.run)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        inFlight -= 1;
        drain();
      });
  }
}

/**
 * Queue a signer operation. Interactive work jumps ahead of any background
 * backlog; within a lane, order is preserved.
 *
 * `label` is for diagnostics only (relay-debug panel, `window.__obeliskSignerQueue`).
 */
export function enqueueSignerOp<T>(
  lane: SignerLane,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    lanes[lane].push({
      lane,
      label,
      run: run as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    const stats = signerQueueStats();
    // Only surface a depth that means something — a queue that is keeping up
    // shouldn't spam the debug panel on every keystroke.
    if (stats.interactive + stats.background > 1) {
      pushRelayDebug({
        kind: 'signer-queue',
        status: `${label} · ${stats.interactive}i/${stats.background}b`,
      });
    }
    drain();
  });
}

/**
 * Drop every queued operation and reset the in-flight counter. Called on
 * logout / session change: the queued closures capture the old session's
 * signer, and running them against a new identity would be wrong.
 *
 * Pending callers are rejected rather than left hanging so their `await`s
 * unwind instead of leaking.
 */
export function resetSignerQueue(): void {
  const pending = [...lanes.interactive, ...lanes.background];
  lanes.interactive = [];
  lanes.background = [];
  inFlight = 0;
  for (const entry of pending) {
    try {
      entry.reject(new Error('Signer queue reset'));
    } catch {
      // A rejection handler that throws must not stop us clearing the rest.
    }
  }
}

/**
 * Expose stats for manual inspection: `window.__obeliskSignerQueue.stats()`.
 * Mirrors the `window.wot = wotEngine` precedent in `src/lib/wot/store.ts`.
 */
export function installSignerQueueDebug(): void {
  if (typeof window === 'undefined') return;
  (window as unknown as { __obeliskSignerQueue?: unknown }).__obeliskSignerQueue = {
    stats: signerQueueStats,
  };
}
