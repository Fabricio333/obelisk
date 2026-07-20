/**
 * Priority orchestrator — sequences the bridge's post-handshake REQ fan-out
 * into explicit tiers so the UI's paint order matches user-perceived priority:
 *
 *   P0  Channel menu (selected relay's group metadata) + own profile
 *   P1  Active channel content (messages, members, reactions) — fired by
 *       `setActiveGroup` and by `applyPendingResubscribe` with the active
 *       group bumped to the head of the queue. Not represented here as a
 *       static plan; it's stateful.
 *   P2  Everything else needed to bootstrap the rest of the app: layout-
 *       author seeding (relay-wide admin/member), contact list, mute list,
 *       authored-groups index, active SFU calls.
 *   P3  Lazy on first hook call: per-group admin/member, per-group
 *       reactions, per-pubkey kind:0 metadata. Owned by the bridge methods
 *       themselves (e.g. `useAdmins` mount → `subscribeAdminMember`).
 *
 * Why tiers, not just sequential dispatch: SimplePool batches outbound
 * frames within the current microtask. To get a strict "P0 frames hit the
 * wire before P2 frames" guarantee — and a relay's AUTH-gated queue
 * processes them in that order — P2 dispatch is deferred to the *next*
 * microtask. Cheap, observable in tests, no setTimeout flakes.
 *
 * Read-state relay-sync (kind 1059 subs) is NOT in this plan. It mounts
 * from `ReadStateRoot` and is gated on `groupMetadataEose` OR a 1000ms
 * post-`Connected` timer — see `docs/read-state.md`.
 *
 * Direct-message subscriptions are intentionally NOT in the default plan.
 * They open from `useDirectMessages()` only after the local DM opt-in
 * preference is enabled.
 */

export type TierAction =
  | 'preflightRelayAccess'
  | 'subscribeGroupMetadata'
  | 'ensureMyMetadata'
  | 'subscribeAllAdminMember'
  | 'subscribeMyContactList'
  | 'subscribeMyMuteList'
  | 'subscribeMyAuthoredGroups'
  | 'subscribeActiveCalls';

export interface TierPlan {
  /** Synchronous frames, leave the orchestrator in the same microtask as `connect()`. */
  readonly P0: readonly TierAction[];
  /** Deferred one microtask so the WS-frame queue writes P0 first. */
  readonly P2: readonly TierAction[];
}

/**
 * Default plan. Order inside each tier is the order frames go out — kept
 * stable so a network trace of `connect()` is easy to match against the
 * code.
 */
export const DEFAULT_TIER_PLAN: TierPlan = {
  // Preflight goes out first so a whitelist rejection on the active relay
  // surfaces within ~1.5s (the preflight's own watchdog), well before the
  // 4s soak window any other CLOSED auth-required reason would otherwise
  // wait through.
  P0: ['preflightRelayAccess', 'subscribeGroupMetadata', 'ensureMyMetadata'],
  P2: [
    'subscribeAllAdminMember',
    'subscribeMyContactList',
    'subscribeMyMuteList',
    'subscribeMyAuthoredGroups',
    'subscribeActiveCalls',
  ],
};

export interface OrchestratorOptions {
  /**
   * Called once per action in the plan, in tier order. The bridge owns
   * the side-effect (firing the actual `subscribeXxx` REQ); the
   * orchestrator owns the scheduling.
   */
  dispatch: (action: TierAction) => void;
  /**
   * Reopens any per-group REQs that were live on the previous pool (e.g.
   * across relay switch or session change). Fired after P2 so the global
   * REQs land first; the active-group bump-to-head behavior is bridge-side.
   * Pass a no-op if there is no pending state.
   */
  applyResubscribe: () => void;
  /** Optional override (testing / future tunables). */
  plan?: TierPlan;
}

/**
 * Schedule the connect-time fan-out. Returns synchronously after P0
 * actions are dispatched; P2 + resubscribe run on the next microtask.
 */
export function runConnectFanOut(opts: OrchestratorOptions): void {
  const plan = opts.plan ?? DEFAULT_TIER_PLAN;
  for (const action of plan.P0) opts.dispatch(action);
  queueMicrotask(() => {
    for (const action of plan.P2) opts.dispatch(action);
    opts.applyResubscribe();
  });
}
