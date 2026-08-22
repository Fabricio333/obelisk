/**
 * Web-of-Trust gating engine.
 *
 * The contract — see docs/wot-integration-plan.md:
 *   - `isAllowed(pubkey, kind?)` is synchronous. It is called from the bridge
 *     ingest hot path and must never await.
 *   - When WoT is enabled and the verdict for `pubkey` is unresolved, we
 *     fail-open AND enqueue `pubkey` for batch resolution. Later deny
 *     verdicts notify UI/policy listeners, but must not delete cached bridge
 *     data by themselves.
 *   - Mutes (union of NIP-51 + local zustand) override allow; blocks are a
 *     hard local denylist that also bypasses always-allow exemptions.
 *   - Always-allow kinds: own events, group metadata (39000), admins/members
 *     (39001/39002), group create (9007). Consensual DM exemption is
 *     evaluated via a caller-supplied predicate.
 */

import { wotBatch } from './extension';
import {
  KIND_GROUP_CREATE,
  KIND_GROUP_METADATA,
  KIND_GROUP_ADMINS,
  KIND_GROUP_MEMBERS,
  // Voice signaling — mesh voice is gated by NIP-29 membership inside the
  // channel; layering WoT on top means a participant whose follow graph is
  // sparse can fail to talk to half the room. The room is small (cap 8),
  // the participants are already vetted by the channel admin's member
  // list, and the events are short-lived ephemeral kinds.
  KIND_VOICE_PRESENCE,
  KIND_VOICE_SIGNAL,
} from '@/lib/nip-kinds';

const VERDICT_TTL_MS = 30 * 60 * 1000;
const BATCH_DEBOUNCE_MS = 100;

const ALWAYS_ALLOW_KINDS = new Set<number>([
  KIND_GROUP_METADATA,
  KIND_GROUP_ADMINS,
  KIND_GROUP_MEMBERS,
  KIND_GROUP_CREATE,
  KIND_VOICE_PRESENCE,
  KIND_VOICE_SIGNAL,
]);

type Verdict = 'allow' | 'deny';
interface VerdictEntry {
  verdict: Verdict;
  /** Hop distance for `allow` verdicts (used by the WotBadge UI). `null` means resolved-allow with no distance number. */
  distance: number | null;
  expiresAt: number;
}

export interface WotEngineConfig {
  enabled: boolean;
  maxHops: number;
  /**
   * Minimum number of disjoint trust paths required for an `allow` verdict.
   * `1` (default) reproduces pre-multipath behavior. Higher values demand
   * corroborating follows so a single rogue follower can't unilaterally
   * vouch for a spammer.
   */
  minPaths: number;
}

export type WotEngineEvent = 'verdict-deny' | 'verdicts-changed' | 'enabled-changed';
type Listener = (pubkey: string) => void;
type AnyListener = () => void;

export class WotEngine {
  private cache = new Map<string, VerdictEntry>();
  private pending = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a `wotBatch` round-trip is outstanding. See {@link scheduleFlush}. */
  private flushing = false;
  /** Bumped by {@link clearVerdicts} so an in-flight batch's answers can be discarded. */
  private flushGeneration = 0;

  private cfg: WotEngineConfig = { enabled: false, maxHops: 2, minPaths: 1 };
  private ownPubkey: string | null = null;
  private mutedPubkeys = new Set<string>();
  private blockedPubkeys = new Set<string>();
  private isConsensualDm: (pubkey: string) => boolean = () => false;

  private denyListeners = new Set<Listener>();
  private changeListeners = new Set<AnyListener>();
  private enabledListeners = new Set<(enabled: boolean) => void>();

  configure(next: Partial<WotEngineConfig>): void {
    const prev = this.cfg;
    this.cfg = { ...prev, ...next };
    // Any config change invalidates verdicts — graph traversal depth or the
    // enable bit fundamentally change every prior answer.
    const configChanged =
      prev.enabled !== this.cfg.enabled ||
      prev.maxHops !== this.cfg.maxHops ||
      prev.minPaths !== this.cfg.minPaths;
    if (configChanged) this.clearVerdicts();
    // Fire on every config change (not just enable flip) so the bridge
    // re-evaluates known authors when maxHops changes too — otherwise
    // raising maxHops wouldn't re-admit previously-denied authors.
    if (configChanged) {
      for (const cb of this.enabledListeners) {
        try { cb(this.cfg.enabled); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Subscribe to enable/disable transitions. Used by the bridge to
   * retroactively re-evaluate authors of already-cached events when WoT
   * gets toggled on after data is in the stores.
   */
  onEnabledChanged(cb: (enabled: boolean) => void): () => void {
    this.enabledListeners.add(cb);
    return () => this.enabledListeners.delete(cb);
  }

  setOwnPubkey(pubkey: string | null): void {
    if (this.ownPubkey === pubkey) return;
    this.ownPubkey = pubkey;
    this.clearVerdicts();
  }

  setMutedPubkeys(list: ReadonlyArray<string>): void {
    const next = new Set(list);
    for (const pk of next) {
      if (!this.mutedPubkeys.has(pk)) this.fireDeny(pk);
    }
    this.mutedPubkeys = next;
    this.notifyChanged();
  }

  setBlockedPubkeys(list: ReadonlyArray<string>): void {
    const next = new Set(list);
    for (const pk of next) {
      if (!this.blockedPubkeys.has(pk)) this.fireDeny(pk);
    }
    this.blockedPubkeys = next;
    this.notifyChanged();
  }

  setConsensualDmPredicate(fn: (pubkey: string) => boolean): void {
    this.isConsensualDm = fn;
  }

  /**
   * Pubkeys that operate the relay(s) the user is currently browsing
   * (NIP-11 `pubkey` field). When the local user IS one of these, group-rail
   * filtering should treat every group on that relay as trusted — they own
   * the surface, hiding their own channels behind WoT is nonsense.
   */
  private operatorPubkeys = new Set<string>();
  setOperatorPubkeys(list: ReadonlyArray<string>): void {
    this.operatorPubkeys = new Set(list);
    this.notifyChanged();
  }
  isOperator(pubkey: string): boolean {
    return this.operatorPubkeys.has(pubkey);
  }
  hasOperators(): boolean {
    return this.operatorPubkeys.size > 0;
  }

  /**
   * Sync gating predicate — the load-bearing function. Called from the
   * bridge `subscribeWatched.onevent` for every relay-derived event.
   */
  isAllowed(pubkey: string, kind?: number): boolean {
    // Block is the hard ceiling — bypasses every exemption.
    if (this.blockedPubkeys.has(pubkey)) return false;

    // Mutes apply unconditionally (NIP-51 + local).
    if (this.mutedPubkeys.has(pubkey)) return false;

    // Own events: always allow (they obviously won't be in our own WoT graph
    // as a non-self entry, and we sign them ourselves).
    if (this.ownPubkey && pubkey === this.ownPubkey) return true;

    // WoT off / not enabled / not configured → fail-open.
    if (!this.cfg.enabled) return true;

    // Always-allow kinds: group structure events. Without these we can't
    // render the group metadata or know who the admins/members are.
    if (typeof kind === 'number' && ALWAYS_ALLOW_KINDS.has(kind)) return true;

    // Consensual DM exemption: if we've already DM'd this pubkey, accept
    // their replies even without WoT membership.
    if (this.isConsensualDm(pubkey)) return true;

    const entry = this.cache.get(pubkey);
    const now = Date.now();
    if (!entry || entry.expiresAt <= now) {
      // Unresolved → fail-open; enqueue for batch resolution. A subsequent
      // deny verdict will prune anything we admitted in the meantime.
      this.markUnknown(pubkey);
      return true;
    }
    return entry.verdict === 'allow';
  }

  /**
   * `true` only when WoT is enabled AND we hold a resolved deny verdict
   * for `pubkey`. Use this to gate REQ-amplification (e.g. profile lookups)
   * — unresolved verdicts must NOT block REQs because the verdict may
   * eventually resolve to allow.
   */
  isResolvedDeny(pubkey: string): boolean {
    if (!this.cfg.enabled) return false;
    if (this.blockedPubkeys.has(pubkey)) return true;
    if (this.mutedPubkeys.has(pubkey)) return true;
    const entry = this.cache.get(pubkey);
    if (!entry || entry.expiresAt <= Date.now()) return false;
    return entry.verdict === 'deny';
  }

  /**
   * Look up the cached distance for a pubkey, or `null` when unresolved.
   * Used by the WotBadge UI — does NOT enqueue a fresh lookup.
   */
  getDistance(pubkey: string): number | null {
    const entry = this.cache.get(pubkey);
    if (!entry || entry.expiresAt <= Date.now()) return null;
    if (entry.verdict !== 'allow') return null;
    return entry.distance;
  }

  /**
   * Enqueue a pubkey for batch verdict resolution. No-op if already cached
   * (and not expired) or already in-flight. Public so callers can warm
   * verdicts proactively (e.g. before painting a member list).
   */
  markUnknown(pubkey: string): void {
    if (!this.cfg.enabled) return;
    const entry = this.cache.get(pubkey);
    if (entry && entry.expiresAt > Date.now()) return;
    if (this.pending.has(pubkey)) return;
    this.pending.add(pubkey);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    // A flush already talking to the extension must finish before another
    // starts. Guarding only the timer (as this used to) let a second
    // `getDistanceBatch` go out while the first was still awaiting, so two
    // graph traversals competed for the same single-request extension
    // channel — and every signature queued behind both.
    if (this.flushing) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, BATCH_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.pending.size === 0) return;
    const batch = Array.from(this.pending);
    this.pending.clear();
    this.flushing = true;
    // Verdicts are computed against the config in force when the batch left.
    // If `clearVerdicts` runs while we're awaiting — a maxHops change, a
    // minPaths change, an account switch — these answers describe a graph
    // traversal nobody asked for any more and must not be written back.
    const generation = this.flushGeneration;
    let result: Record<string, { distance: number | null; paths: number | null }> | null;
    try {
      result = await wotBatch(batch, this.cfg.maxHops, this.cfg.minPaths);
    } finally {
      this.flushing = false;
      // Anything enqueued while we were in flight was blocked from arming a
      // timer by the guard above; re-arm now so it isn't stranded.
      if (this.pending.size > 0) this.scheduleFlush();
    }
    if (this.flushGeneration !== generation) return;
    if (!result) {
      if (typeof console !== 'undefined') {
        console.warn('[wot] batch returned null — extension absent or rejected', { count: batch.length });
      }
      return;
    }
    const expiresAt = Date.now() + VERDICT_TTL_MS;
    let allow = 0;
    let deny = 0;
    for (const pk of batch) {
      const entry = result[pk];
      const distance = entry?.distance ?? null;
      const paths = entry?.paths ?? null;
      // Allow iff the distance is within maxHops AND (the extension didn't
      // report path count OR the count meets the threshold). Treating
      // `null` paths as "satisfies" keeps engines that don't expose
      // multipath compatible.
      const inHops = typeof distance === 'number' && distance >= 0 && distance <= this.cfg.maxHops;
      const enoughPaths = paths === null ? true : paths >= this.cfg.minPaths;
      if (inHops && enoughPaths) {
        this.cache.set(pk, { verdict: 'allow', distance, expiresAt });
        allow++;
      } else {
        this.cache.set(pk, { verdict: 'deny', distance: null, expiresAt });
        this.fireDeny(pk);
        deny++;
      }
    }
    if (typeof console !== 'undefined') {
      console.log('[wot] batch resolved', {
        total: batch.length, allow, deny,
        maxHops: this.cfg.maxHops, minPaths: this.cfg.minPaths,
      });
    }
    this.notifyChanged();
  }

  /**
   * Live counters for the diagnostic panel. Walks the cache once per call —
   * called from a UI component that already re-renders on `verdicts-changed`,
   * so the work stays bounded.
   */
  stats(): { allow: number; deny: number; pending: number } {
    let allow = 0;
    let deny = 0;
    const now = Date.now();
    for (const [, v] of this.cache) {
      if (v.expiresAt <= now) continue;
      if (v.verdict === 'allow') allow++;
      else deny++;
    }
    return { allow, deny, pending: this.pending.size };
  }

  private clearVerdicts(): void {
    this.cache.clear();
    this.pending.clear();
    // Invalidate any batch already on the wire — see {@link flush}.
    this.flushGeneration += 1;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.notifyChanged();
  }

  on(event: 'verdict-deny', cb: Listener): () => void;
  on(event: 'verdicts-changed', cb: AnyListener): () => void;
  on(event: WotEngineEvent, cb: Listener | AnyListener): () => void {
    if (event === 'verdict-deny') {
      this.denyListeners.add(cb as Listener);
      return () => this.denyListeners.delete(cb as Listener);
    }
    this.changeListeners.add(cb as AnyListener);
    return () => this.changeListeners.delete(cb as AnyListener);
  }

  private fireDeny(pubkey: string): void {
    for (const cb of this.denyListeners) {
      try { cb(pubkey); } catch { /* listener errors must not crash gating */ }
    }
  }

  private notifyChanged(): void {
    for (const cb of this.changeListeners) {
      try { cb(); } catch { /* ditto */ }
    }
  }

  // -- Test helpers -----------------------------------------------------
  /** @internal */
  _setVerdictForTest(pubkey: string, verdict: Verdict, distance: number | null = null): void {
    this.cache.set(pubkey, { verdict, distance, expiresAt: Date.now() + VERDICT_TTL_MS });
  }
  /** @internal */
  _flushForTest(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.flush();
  }
  /** @internal */
  _reset(): void {
    this.clearVerdicts();
    this.cfg = { enabled: false, maxHops: 2, minPaths: 1 };
    this.ownPubkey = null;
    this.mutedPubkeys = new Set();
    this.blockedPubkeys = new Set();
    this.isConsensualDm = () => false;
  }
}

export const wotEngine = new WotEngine();

/** Convenience export — the function reference is stable across configs. */
export function isAllowed(pubkey: string, kind?: number): boolean {
  return wotEngine.isAllowed(pubkey, kind);
}

export const KINDS_ALWAYS_ALLOW = ALWAYS_ALLOW_KINDS;
export const _internals = { VERDICT_TTL_MS, BATCH_DEBOUNCE_MS };
