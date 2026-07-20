import { describe, it, expect, vi } from 'vitest';
import {
  runConnectFanOut,
  DEFAULT_TIER_PLAN,
  type TierAction,
  type TierPlan,
} from './orchestrator';

/**
 * The orchestrator is a pure scheduler: it takes a `dispatch` callback and
 * an `applyResubscribe` callback, and it sequences them into P0 / P2 tiers.
 * These tests assert the timing contract — P0 actions run synchronously
 * within the same microtask as `runConnectFanOut`, P2 actions + resubscribe
 * run one microtask later.
 */

describe('runConnectFanOut', () => {
  it('dispatches P0 actions synchronously in plan order', () => {
    const calls: TierAction[] = [];
    runConnectFanOut({
      dispatch: (action) => calls.push(action),
      applyResubscribe: () => {},
    });
    expect(calls).toEqual([...DEFAULT_TIER_PLAN.P0]);
  });

  it('defers P2 actions to the next microtask', async () => {
    const calls: TierAction[] = [];
    runConnectFanOut({
      dispatch: (action) => calls.push(action),
      applyResubscribe: () => {},
    });
    // Right after the synchronous return only P0 has fired.
    expect(calls).toEqual([...DEFAULT_TIER_PLAN.P0]);
    // One microtask later, P2 actions are appended in plan order.
    await Promise.resolve();
    expect(calls).toEqual([...DEFAULT_TIER_PLAN.P0, ...DEFAULT_TIER_PLAN.P2]);
  });

  it('runs applyResubscribe after all P2 actions', async () => {
    const order: string[] = [];
    runConnectFanOut({
      dispatch: (action) => order.push(`dispatch:${action}`),
      applyResubscribe: () => order.push('resubscribe'),
    });
    await Promise.resolve();
    // Resubscribe is the last entry — guarantees per-group REQs queue
    // behind the relay-wide P2 frames.
    expect(order[order.length - 1]).toBe('resubscribe');
    // And it must run AFTER the last P2 dispatch, not before.
    const lastP2 = DEFAULT_TIER_PLAN.P2[DEFAULT_TIER_PLAN.P2.length - 1];
    expect(order.indexOf(`dispatch:${lastP2}`)).toBeLessThan(order.indexOf('resubscribe'));
  });

  it('does not invoke P2 actions synchronously', () => {
    const dispatch = vi.fn();
    runConnectFanOut({
      dispatch,
      applyResubscribe: () => {},
    });
    const syncCalls = dispatch.mock.calls.map((c) => c[0]);
    expect(syncCalls).toEqual([...DEFAULT_TIER_PLAN.P0]);
    // No P2 action appears in the synchronous batch.
    for (const action of DEFAULT_TIER_PLAN.P2) {
      expect(syncCalls).not.toContain(action);
    }
  });

  it('honors a custom plan', async () => {
    const customPlan: TierPlan = {
      P0: ['subscribeGroupMetadata'],
      P2: ['subscribeMyContactList'],
    };
    const calls: TierAction[] = [];
    runConnectFanOut({
      dispatch: (action) => calls.push(action),
      applyResubscribe: () => {},
      plan: customPlan,
    });
    expect(calls).toEqual(['subscribeGroupMetadata']);
    await Promise.resolve();
    expect(calls).toEqual(['subscribeGroupMetadata', 'subscribeMyContactList']);
  });

  it('default plan puts preflightRelayAccess first, then subscribeGroupMetadata (channel-menu priority)', () => {
    // Locks in the user-facing priority:
    //   1. Whitelist preflight fires first so a rejection surfaces within
    //      its tight 1500ms watchdog — no 4s soak.
    //   2. Channel-menu source REQ goes out next so the sidebar paints
    //      as soon as kind 39000 starts arriving.
    expect(DEFAULT_TIER_PLAN.P0[0]).toBe('preflightRelayAccess');
    expect(DEFAULT_TIER_PLAN.P0[1]).toBe('subscribeGroupMetadata');
  });

  it('default plan defers subscribeAllAdminMember to P2 (reclassified from P0)', () => {
    // History: pre-orchestrator, this fired in the same batch as group
    // metadata. Keeping it in P2 means the channel menu REQ wins the
    // race for the first relay response slot.
    expect(DEFAULT_TIER_PLAN.P0).not.toContain('subscribeAllAdminMember');
    expect(DEFAULT_TIER_PLAN.P2).toContain('subscribeAllAdminMember');
  });

  it('default plan does not subscribe to DMs before explicit local opt-in', () => {
    expect(DEFAULT_TIER_PLAN.P0).not.toContain('subscribeIncomingDMs');
    expect(DEFAULT_TIER_PLAN.P2).not.toContain('subscribeIncomingDMs');
  });
});
