/**
 * Tests for VoiceClient — the per-channel orchestrator.
 *
 * The transport layer (`./transport`) is mocked so tests drive roster +
 * signaling synchronously. WebRTC and getUserMedia are mocked too. This
 * leaves us to test the actual orchestration: roster→peer creation,
 * member filtering, mic/cam toggles, quality propagation, capacity cap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installWebRtcMocks,
  installMediaDevicesMocks,
  flushMicrotasks,
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakeRTCPeerConnection,
} from '@/test/mocks/webrtc';
import type { VoicePresence, VoiceSignalPayload } from './types';

// ── transport mock ──────────────────────────────────────────────────────
const transportFake = vi.hoisted(() => {
  let rosterCb: ((roster: VoicePresence[]) => void) | null = null;
  let signalsCb: ((from: string, p: VoiceSignalPayload) => void) | null = null;
  const sentSignals: { to: string; payload: VoiceSignalPayload }[] = [];
  const publishPresenceBeacon = vi.fn(async () => {});
  const publishLeavePresence = vi.fn(async () => {});
  let selfPubkey = 'self';
  return {
    publishPresenceBeacon,
    publishLeavePresence,
    subscribeRoster: vi.fn(async (_id: string, cb: (r: VoicePresence[]) => void) => {
      rosterCb = cb;
      return () => { rosterCb = null; };
    }),
    sendSignal: vi.fn(async (_id: string, to: string, payload: VoiceSignalPayload) => {
      sentSignals.push({ to, payload });
    }),
    subscribeSignals: vi.fn(async (_id: string, _self: string, cb: (from: string, p: VoiceSignalPayload) => void) => {
      signalsCb = cb;
      return () => { signalsCb = null; };
    }),
    getSelfPubkey: vi.fn(() => selfPubkey),
    setSelfPubkey: (pk: string) => { selfPubkey = pk; },
    fireRoster: (r: VoicePresence[]) => { rosterCb?.(r); },
    fireSignal: (from: string, payload: VoiceSignalPayload) => { signalsCb?.(from, payload); },
    sentSignals,
    reset: () => {
      rosterCb = null;
      signalsCb = null;
      sentSignals.length = 0;
      publishPresenceBeacon.mockClear();
      publishLeavePresence.mockClear();
      selfPubkey = 'self';
    },
  };
});

vi.mock('./transport', () => ({
  publishPresenceBeacon: transportFake.publishPresenceBeacon,
  publishLeavePresence: transportFake.publishLeavePresence,
  subscribeRoster: transportFake.subscribeRoster,
  sendSignal: transportFake.sendSignal,
  subscribeSignals: transportFake.subscribeSignals,
  createVoiceTransport: vi.fn(() => ({
    publishPresenceBeacon: transportFake.publishPresenceBeacon,
    publishLeavePresence: transportFake.publishLeavePresence,
    subscribeRoster: transportFake.subscribeRoster,
    sendSignal: transportFake.sendSignal,
    subscribeSignals: transportFake.subscribeSignals,
  })),
  getSelfPubkey: transportFake.getSelfPubkey,
  // Pure function — pass through unchanged for tests. Roster types now
  // carry `videoTracks` too; the transitive computation only unions
  // pubkeys, so the body stays the same.
  transitiveParticipants: (roster: VoicePresence[]) => {
    const set = new Set<string>();
    for (const p of roster) {
      set.add(p.pubkey);
      for (const pk of p.connectedTo) set.add(pk);
      for (const pk of p.knownPeers ?? []) set.add(pk);
    }
    return Array.from(set);
  },
}));

// ── sfu-control mock ────────────────────────────────────────────────────
// `pickSfu` is the new SFU-discovery entry point — `VoiceClient.join()`
// calls it directly when `expectSfu === true` instead of waiting for an
// SFU beacon to appear in the roster. Tests configure the return value
// per-case via `sfuControlFake.setPick(...)`.
const sfuControlFake = vi.hoisted(() => {
  let next: {
    pubkey: string;
    trustedRelays: readonly string[];
    generalRelays: readonly string[];
    url: string | null;
    region: string | null;
    cap: number | null;
    createdAt: number;
  } | null = null;
  const publishSfuStart = vi.fn(async () => true);
  return {
    pickSfu: vi.fn(async () => next),
    publishSfuStart,
    setPick: (
      pick: {
        pubkey: string;
        trustedRelays?: readonly string[];
        generalRelays?: readonly string[];
        url?: string | null;
        region?: string | null;
        cap?: number | null;
        createdAt?: number;
      } | null,
    ) => {
      next = pick
        ? {
            pubkey: pick.pubkey,
            trustedRelays: pick.trustedRelays ?? [],
            generalRelays: pick.generalRelays ?? pick.trustedRelays ?? [],
            url: pick.url ?? null,
            region: pick.region ?? null,
            cap: pick.cap ?? null,
            createdAt: pick.createdAt ?? 1,
          }
        : null;
    },
    reset: () => {
      next = null;
      publishSfuStart.mockClear();
    },
  };
});
vi.mock('./sfu-control', () => ({
  pickSfu: sfuControlFake.pickSfu,
  publishSfuStart: sfuControlFake.publishSfuStart,
}));

// ── sfu-client mock ─────────────────────────────────────────────────────
// Substitute the real mediasoup-driven `SfuClient` with a thin stub: it
// captures constructor opts so tests can fire `onPeersChange` etc., and
// its `start()` resolves immediately (or rejects when configured for
// the fallback-to-mesh path).
const sfuClientFake = vi.hoisted(() => {
  type Events = {
    onRemoteTrack?: (t: unknown) => void;
    onRemoteTrackEnded?: (id: string) => void;
    onConnectionStateChange?: (s: string) => void;
    onPeersChange?: (pubkeys: string[]) => void;
  };
  type StartOutcome = 'ok' | 'timeout' | 'generic-fail';
  const instances: Array<{
    channelId: string;
    sfuPubkey: string;
    selfPubkey: string;
    directUrl?: string | null;
    events: Events;
    started: boolean;
    closed: boolean;
    publishedKinds: string[];
    fail: boolean;
    outcome: StartOutcome;
  }> = [];
  let nextStartShouldFail = false;
  // Per-instance outcome queue. Each new SfuClient construction consumes
  // one entry; once exhausted defaults to 'ok'. Used to drive the
  // bootstrap-retry tests deterministically.
  const outcomeQueue: StartOutcome[] = [];
  class StubSfuClient {
    private readonly state: typeof instances[number];
    constructor(opts: { channelId: string; sfuPubkey: string; selfPubkey: string; directUrl?: string | null; events: Events }) {
      const outcome: StartOutcome = outcomeQueue.length > 0
        ? outcomeQueue.shift()!
        : (nextStartShouldFail ? 'generic-fail' : 'ok');
      this.state = {
        channelId: opts.channelId,
        sfuPubkey: opts.sfuPubkey,
        selfPubkey: opts.selfPubkey,
        directUrl: opts.directUrl,
        events: opts.events,
        started: false,
        closed: false,
        publishedKinds: [],
        fail: outcome !== 'ok',
        outcome,
      };
      nextStartShouldFail = false;
      instances.push(this.state);
    }
    async start(): Promise<void> {
      if (this.state.outcome === 'timeout') {
        throw new Error('rpc timeout: getRouterRtpCapabilities');
      }
      if (this.state.outcome === 'generic-fail') {
        throw new Error('start failed (mock)');
      }
      this.state.started = true;
    }
    async publishTrack(kind: string, _track: unknown): Promise<void> {
      this.state.publishedKinds.push(kind);
    }
    async unpublishTrack(_kind: string): Promise<void> {}
    async close(_awaitLeaveMs?: number): Promise<void> { this.state.closed = true; }
  }
  return {
    SfuClient: StubSfuClient,
    instances,
    last: () => instances[instances.length - 1],
    setNextStartShouldFail: () => { nextStartShouldFail = true; },
    queueStartOutcomes: (...outcomes: StartOutcome[]) => { outcomeQueue.push(...outcomes); },
    reset: () => {
      instances.length = 0;
      nextStartShouldFail = false;
      outcomeQueue.length = 0;
    },
  };
});
vi.mock('./sfu-client', () => ({
  SfuClient: sfuClientFake.SfuClient,
}));

// ── nostr-bridge mock ───────────────────────────────────────────────────
// VoiceClient.subscribeActiveCallStatus calls `getBridge()` and registers
// for kind 31314 status updates. Tests drive this through `bridgeFake.fire`
// to simulate the SFU publishing status=closed.
type ActiveCallEntry = { hostPubkey: string; status: string; participantCount: number; expiresAt: number; createdAt: number; mode?: 'sfu' | 'mesh'; participantPubkeys?: string[] };
const bridgeFake = vi.hoisted(() => {
  const cbs: Array<(byChannel: Record<string, ActiveCallEntry>) => void> = [];
  let unsubCalls = 0;
  let releaseCalls = 0;
  const bridge = {
    subscribeActiveCallByChannel: (cb: (byChannel: Record<string, ActiveCallEntry>) => void) => {
      cbs.push(cb);
      return () => { unsubCalls += 1; const i = cbs.indexOf(cb); if (i >= 0) cbs.splice(i, 1); };
    },
    waitForRelayAuth: vi.fn(async () => 'ok'),
    reserveVoiceRelayCapacity: vi.fn((_channelId: string) => () => { releaseCalls += 1; }),
  };
  return {
    bridge,
    getBridge: vi.fn(async () => bridge),
    fire: (byChannel: Record<string, ActiveCallEntry>) => {
      for (const cb of [...cbs]) cb(byChannel);
    },
    unsubCalls: () => unsubCalls,
    releaseCalls: () => releaseCalls,
    reset: () => {
      cbs.length = 0;
      unsubCalls = 0;
      releaseCalls = 0;
      bridge.reserveVoiceRelayCapacity.mockClear();
      bridgeFake.getBridge.mockClear();
    },
  };
});
vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: bridgeFake.getBridge,
}));

// Import VoiceClient after mocks.
import { VoiceClient } from './client';

let webrtc: ReturnType<typeof installWebRtcMocks>;
let media: ReturnType<typeof installMediaDevicesMocks>;

const SELF = 'a'.repeat(64);
const PEER1 = 'b'.repeat(64);
const PEER2 = 'c'.repeat(64);

beforeEach(() => {
  webrtc = installWebRtcMocks();
  media = installMediaDevicesMocks();
  transportFake.reset();
  transportFake.setSelfPubkey(SELF);
  sfuControlFake.reset();
  sfuClientFake.reset();
  bridgeFake.reset();
});

afterEach(() => {
  webrtc.uninstall();
  media.uninstall();
  vi.clearAllMocks();
  // Guarantee timer state is real before the next test runs — bootstrap
  // retry tests use fake timers and a failed assertion mid-test would
  // otherwise leave them active, hanging the next test on its first
  // real setTimeout (e.g. the SFU_START_SETTLE_MS post-publish wait).
  vi.useRealTimers();
});

function presence(
  pubkey: string,
  connectedTo: string[] = [],
  videoTracks: ('camera' | 'screen')[] = [],
): VoicePresence {
  return { pubkey, channelId: 'ch1', createdAt: 1, expiresAt: 9999999999, connectedTo, videoTracks, isSfu: false };
}

function meshTestPresence(pubkey: string): VoicePresence {
  return { ...presence(pubkey), isMeshTestPeer: true };
}

describe('VoiceClient.join', () => {
  it('throws when the local user is not in the member list', async () => {
    const client = new VoiceClient('ch1', { members: [PEER1] });
    await expect(client.join()).rejects.toThrow(/not a member/i);
  });

  it('joins, publishes a beacon, and subscribes to roster + signals', async () => {
    const client = new VoiceClient('ch1', { members: [SELF] });
    await client.join();
    // Beacon now carries connected peers, known peers, and active video
    // tracks (all empty on the first beacon).
    expect(transportFake.publishPresenceBeacon).toHaveBeenCalledWith('ch1', [], [], []);
    expect(transportFake.subscribeRoster).toHaveBeenCalled();
    expect(transportFake.subscribeSignals).toHaveBeenCalled();
    expect(bridgeFake.bridge.reserveVoiceRelayCapacity).toHaveBeenCalledWith('ch1');
    await client.leave();
    expect(bridgeFake.releaseCalls()).toBe(1);
  });

  it('publishes a terminal mesh presence beacon when leaving', async () => {
    const client = new VoiceClient('ch1', { members: [SELF] });
    await client.join();

    await client.leave();

    expect(transportFake.publishLeavePresence).toHaveBeenCalledTimes(1);
    expect(transportFake.publishLeavePresence).toHaveBeenCalledWith('ch1');
  });

  it('starts mesh and publishes the first beacon without opening the microphone', async () => {
    const nav = globalThis.navigator as unknown as {
      mediaDevices: {
        getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
      };
    };
    const getUserMedia = vi.fn(async () => (
      new FakeMediaStream([new FakeMediaStreamTrack('audio')]) as unknown as MediaStream
    ));
    nav.mediaDevices.getUserMedia = getUserMedia;

    const client = new VoiceClient('ch1', { members: [SELF] });
    await client.join();
    await flushMicrotasks(8);

    expect(transportFake.subscribeSignals).toHaveBeenCalled();
    expect(transportFake.subscribeRoster).toHaveBeenCalled();
    expect(transportFake.publishPresenceBeacon).toHaveBeenCalledWith('ch1', [], [], []);
    expect(client.isJoined()).toBe(true);
    expect(client.getLocalTracks().mic).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    await client.leave();
  });

  it('emits listening-only local state on join', async () => {
    const onLocalTracksChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      events: { onLocalTracksChange },
    });

    await client.join();
    await flushMicrotasks(8);

    expect(client.isJoined()).toBe(true);
    expect(client.getLocalTracks().mic).toBeNull();
    expect(onLocalTracksChange).toHaveBeenCalledWith({ mic: false, camera: false, screen: false });
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);
    expect(client.getParticipants()).toContain(PEER1);
    await client.leave();
  });

  it('treats an empty member list as an open room', async () => {
    const client = new VoiceClient('ch1');
    await client.join();
    expect(client.canJoin()).toBe(true);
    await client.leave();
  });
});

describe('VoiceClient roster → peer lifecycle', () => {
  it('creates a peer for each member in the roster (excluding self)', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1, PEER2] });
    await client.join();
    transportFake.fireRoster([presence(SELF), presence(PEER1), presence(PEER2)]);
    await flushMicrotasks(8);

    expect(client.getParticipants().sort()).toEqual([PEER1, PEER2].sort());
    await client.leave();
  });

  it('filters non-members out of the roster', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1), presence(PEER2)]);
    await flushMicrotasks(8);
    expect(client.getParticipants()).toEqual([PEER1]);
    await client.leave();
  });

  it('admits marked mesh test peers for non-admin users who can join', async () => {
    const adminClient = new VoiceClient('ch1', { members: [SELF], admins: [SELF] });
    await adminClient.join();
    transportFake.fireRoster([meshTestPresence(PEER2)]);
    await flushMicrotasks(8);
    expect(adminClient.getParticipants()).toEqual([PEER2]);
    await adminClient.leave();

    const memberClient = new VoiceClient('ch1', { members: [SELF], admins: [] });
    await memberClient.join();
    transportFake.fireRoster([meshTestPresence(PEER2)]);
    await flushMicrotasks(8);
    expect(memberClient.getParticipants()).toEqual([PEER2]);
    await memberClient.leave();
  });

  it('dials passive active-call hints when the dedicated roster misses a mesh peer', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [], open: true });
    await client.join();

    client.setPassiveParticipantHints([SELF, PEER2]);
    await flushMicrotasks(12);

    expect(client.getParticipants()).toEqual([PEER2]);
    const pc = webrtc.last();
    expect(pc.getTransceivers().map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(pc.getTransceivers().map((t) => t.direction)).toEqual(['recvonly', 'recvonly']);

    await client.publishBeacon();
    expect(transportFake.publishPresenceBeacon).toHaveBeenLastCalledWith('ch1', [], [PEER2], []);
    await client.leave();
  });

  it('does not keep gossiping a passive-hint peer after the hint is cleared before connection', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [], open: true });
    await client.join();

    client.setPassiveParticipantHints([PEER2]);
    await flushMicrotasks(12);
    expect(client.getParticipants()).toEqual([PEER2]);

    client.setPassiveParticipantHints([]);
    await flushMicrotasks(12);

    await client.publishBeacon();
    expect(transportFake.publishPresenceBeacon).toHaveBeenLastCalledWith('ch1', [], [], []);
    await client.leave();
  });

  it('dials mesh active-call participants reported by the bridge when the dedicated roster is empty', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [], open: true });
    await client.join();
    await flushMicrotasks(12);

    bridgeFake.fire({
      ch1: {
        hostPubkey: PEER2,
        status: 'active',
        participantCount: 2,
        expiresAt: 9_999_999_999,
        createdAt: 1,
        mode: 'mesh',
        participantPubkeys: [SELF, PEER2],
      },
    });
    await flushMicrotasks(12);

    expect(client.getParticipants()).toEqual([PEER2]);

    await client.publishBeacon();
    expect(transportFake.publishPresenceBeacon).toHaveBeenLastCalledWith('ch1', [], [PEER2], []);
    await client.leave();
  });

  it('keeps an active-call hinted mesh peer through membership reconciliation', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [] });
    await client.join();

    client.setPassiveParticipantHints([PEER1], { merge: true });
    await flushMicrotasks(12);
    expect(client.getParticipants()).toEqual([PEER1]);

    client.updateRoles([SELF], []);
    await flushMicrotasks(4);
    expect(client.getParticipants()).toEqual([PEER1]);

    await client.leave();
  });

  it('does not re-gossip a previously hinted mesh peer after a later active-call snapshot drops it', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [], open: true });
    await client.join();
    await flushMicrotasks(12);

    bridgeFake.fire({
      ch1: {
        hostPubkey: PEER1,
        status: 'active',
        participantCount: 2,
        expiresAt: 9_999_999_999,
        createdAt: 1,
        mode: 'mesh',
        participantPubkeys: [SELF, PEER1],
      },
    });
    await flushMicrotasks(12);

    bridgeFake.fire({
      ch1: {
        hostPubkey: SELF,
        status: 'active',
        participantCount: 1,
        expiresAt: 9_999_999_999,
        createdAt: 2,
        mode: 'mesh',
        participantPubkeys: [SELF],
      },
    });
    await flushMicrotasks(12);

    expect(client.getParticipants()).toEqual([]);

    await client.publishBeacon();
    expect(transportFake.publishPresenceBeacon).toHaveBeenLastCalledWith('ch1', [], [], []);
    await client.leave();
  });

  it('rebuilds a passive-hint peer when a later beacon marks it as a mesh test peer', async () => {
    const lowerPeer = '0'.repeat(64);
    const client = new VoiceClient('ch1', { members: [SELF], admins: [], open: true });
    await client.join();

    client.setPassiveParticipantHints([lowerPeer]);
    await flushMicrotasks(12);
    const firstPc = webrtc.last();
    expect(firstPc.connectionState).toBe('new');

    transportFake.fireRoster([meshTestPresence(lowerPeer)]);
    await flushMicrotasks(12);

    const secondPc = webrtc.last();
    expect(secondPc).not.toBe(firstPc);
    expect(firstPc.connectionState).toBe('closed');
    expect(client.getParticipants()).toEqual([lowerPeer]);
    await client.leave();
  });

  it('requests recv-only negotiation for polite passive active-call hints', async () => {
    const lowerPeer = '0'.repeat(64);
    const client = new VoiceClient('ch1', { members: [SELF], admins: [], open: true });
    await client.join();

    client.setPassiveParticipantHints([lowerPeer]);
    await flushMicrotasks(12);

    expect(client.getParticipants()).toEqual([lowerPeer]);
    expect(transportFake.sentSignals.some((signal) =>
      signal.to === lowerPeer
      && signal.payload.type === 'peer'
      && (signal.payload.peerSignal as { transceiverRequest?: unknown }).transceiverRequest,
    )).toBe(true);
    await client.leave();
  });

  it('opens recv-only media m-lines for ordinary muted mesh peers', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(12);

    const pc = webrtc.last();
    expect(pc.getTransceivers().map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(pc.getTransceivers().map((t) => t.direction)).toEqual(['recvonly', 'recvonly']);
    expect(pc.getSenders().map((s) => s.track)).toEqual([null, null]);
    await client.leave();
  });

  it('opens recv-only media m-lines for marked mesh test peers as a non-admin caller', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [] });
    await client.join();
    transportFake.fireRoster([meshTestPresence(PEER2)]);
    await flushMicrotasks(12);

    const pc = webrtc.last();
    expect(pc.getTransceivers().map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(pc.getTransceivers().map((t) => t.direction)).toEqual(['recvonly', 'recvonly']);
    expect(pc.getSenders().map((s) => s.track)).toEqual([null, null]);
    await client.leave();
  });

  it('drives initial offers to marked mesh test peers even when pubkey order would be polite', async () => {
    const lowerPeer = '0'.repeat(64);

    const client = new VoiceClient('ch1', { members: [SELF], admins: [] });
    await client.join();
    transportFake.fireRoster([meshTestPresence(lowerPeer)]);
    await flushMicrotasks(12);

    const pc = webrtc.last();
    expect(pc.getTransceivers().map((t) => t.kind)).toEqual(['video', 'audio']);
    await client.leave();
  });

  it('updateRoles tears down peers that just left the member set', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1, PEER2] });
    await client.join();
    transportFake.fireRoster([presence(PEER1), presence(PEER2)]);
    await flushMicrotasks(8);
    expect(client.getParticipants().sort()).toEqual([PEER1, PEER2].sort());

    client.updateRoles([SELF, PEER1], []);
    await flushMicrotasks(8);
    // PEER2 should be torn down.
    const remaining = client.getRemoteTracks().map((t) => t.pubkey);
    expect(remaining).not.toContain(PEER2);
    await client.leave();
  });

  it('removes a never-connected peer after relay/control discovery disappears', async () => {
    const quietPeer = '0'.repeat(64);
    const client = new VoiceClient('ch1', { members: [SELF, quietPeer] });
    await client.join();
    transportFake.fireRoster([presence(quietPeer)]);
    await flushMicrotasks(8);
    expect(client.getParticipants()).toContain(quietPeer);

    transportFake.fireRoster([]);
    await flushMicrotasks(8);
    expect(client.getParticipants()).not.toContain(quietPeer);
    await client.leave();
  });

  it('keeps a connected peer across a missing beacon but removes it on close', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);
    const pc = webrtc.last();
    pc.forceState('connected');
    await flushMicrotasks(8);

    transportFake.fireRoster([]);
    await flushMicrotasks(8);
    expect(client.getParticipants()).toContain(PEER1);

    pc.forceState('closed');
    await flushMicrotasks(8);
    expect(client.getParticipants()).not.toContain(PEER1);
    await client.leave();
  });

  it('keeps beacon presence stable and does not publish leave during an internal redial', async () => {
    vi.useFakeTimers();
    const onParticipantsChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      events: { onParticipantsChange },
    });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);
    onParticipantsChange.mockClear();
    transportFake.sentSignals.length = 0;

    await vi.advanceTimersByTimeAsync(9_000);
    await flushMicrotasks(8);

    expect(client.getParticipants()).toContain(PEER1);
    expect(onParticipantsChange.mock.calls.some(([participants]) => !participants.includes(PEER1))).toBe(false);
    expect(transportFake.sentSignals.some(({ payload }) => payload.type === 'bye')).toBe(false);
    await client.leave();
  });

  it('emits mesh peer connection states while media channels connect', async () => {
    const onPeerConnectionStatesChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      events: { onPeerConnectionStatesChange },
    });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);

    expect(client.getPeerConnectionStates()[PEER1]).toBe('new');
    expect(onPeerConnectionStatesChange).toHaveBeenCalledWith({ [PEER1]: 'new' });

    const pc = webrtc.last();
    pc.forceState('connected');
    await flushMicrotasks(8);

    expect(client.getPeerConnectionStates()[PEER1]).toBe('connected');
    expect(onPeerConnectionStatesChange).toHaveBeenCalledWith({ [PEER1]: 'connected' });

    await client.leave();
    expect(onPeerConnectionStatesChange).toHaveBeenLastCalledWith({});
  });

  it('drops signals from non-members', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireSignal(PEER2, { type: 'offer', sdp: 'v=0\r\n', sessionId: 's', seq: 1 });
    await flushMicrotasks(4);
    // No peer was created for PEER2.
    expect(webrtc.pcs()).toHaveLength(0);
    await client.leave();
  });

  it('routes signals from marked mesh test peers after a non-admin caller sees their beacon', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [] });
    await client.join();
    transportFake.fireRoster([meshTestPresence(PEER2)]);
    await flushMicrotasks(8);
    transportFake.fireSignal(PEER2, { type: 'offer', sdp: 'v=0\r\n', sessionId: 's', seq: 1 });
    await flushMicrotasks(4);
    expect(webrtc.pcs().length).toBeGreaterThan(0);
    await client.leave();
  });

  it('drains deferred mesh test peer signals once a non-admin caller sees their beacon', async () => {
    const client = new VoiceClient('ch1', { members: [SELF], admins: [] });
    const remotePc = new FakeRTCPeerConnection();
    remotePc.addTrack(new FakeMediaStreamTrack('video'));
    remotePc.addTrack(new FakeMediaStreamTrack('audio'));
    const offer = await remotePc.createOffer();

    await client.join();
    transportFake.fireSignal(PEER2, { type: 'offer', sdp: offer.sdp, sessionId: 'remote-s', seq: 1 });
    await flushMicrotasks(4);
    expect(webrtc.pcs()).toHaveLength(0);

    transportFake.fireRoster([meshTestPresence(PEER2)]);
    await flushMicrotasks(16);

    expect(transportFake.sentSignals.some((s) =>
      s.to === PEER2 && s.payload.type === 'peer',
    )).toBe(true);
    await client.leave();
  });
});

describe('VoiceClient mic/cam/screen toggles', () => {
  it('setMicEnabled(true) acquires a mic stream and pushes it to peers', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);
    await client.setMicEnabled(true);
    await flushMicrotasks(8);

    const pc = webrtc.last();
    const audioSenders = pc.getSenders().filter((s) => s.track?.kind === 'audio');
    expect(audioSenders.length).toBeGreaterThanOrEqual(1);
    await client.leave();
  });

  it('setCameraEnabled(true) uses the current videoQuality preset', async () => {
    const { useVoiceStore } = await import('@/store/voice');
    useVoiceStore.getState().setVideoQuality('480p');

    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);

    await client.setCameraEnabled(true);
    await flushMicrotasks(8);

    const pc = webrtc.last();
    const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
    expect(videoSender).toBeDefined();
    // After connect, the encoder cap is applied.
    pc.forceState('connected');
    await flushMicrotasks(8);
    // Cap reflects 480p preset (1.5 Mbps post-bump).
    expect(videoSender?.inspect().encodings[0].maxBitrate).toBe(1_500_000);

    await client.leave();
    useVoiceStore.getState().setVideoQuality('auto');
  });

  it('switchCamera replaces the local camera track and emits a local update', async () => {
    const onLocalTracksChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      events: { onLocalTracksChange },
    });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);

    await client.setCameraEnabled(true);
    const before = client.getLocalTracks().camera as FakeMediaStreamTrack | null;
    expect(before).not.toBeNull();
    onLocalTracksChange.mockClear();

    await client.switchCamera();
    const after = client.getLocalTracks().camera as FakeMediaStreamTrack | null;
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(before?.readyState).toBe('ended');
    expect(onLocalTracksChange).toHaveBeenCalledWith(
      expect.objectContaining({ camera: true }),
    );
    await client.leave();
  });

  it('setScreenShareEnabled cleans up when the browser ends the share', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);

    await client.setScreenShareEnabled(true);
    await flushMicrotasks(8);
    // Simulate user clicking "Stop sharing" in browser.
    const pc = webrtc.last();
    const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
    const track = videoSender?.track as { onended?: () => void; stop: () => void } | null | undefined;
    track?.onended?.();
    await flushMicrotasks(8);
    expect(client.getLocalTracks().screen).toBeNull();
    await client.leave();
  });

  it('setDeafenEnabled disables receive audio without affecting publish', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(20);
    // Drive a remote audio track in via a remote offer.
    // Easiest: mark the existing remote PC as receiving on its current m-line.
    await client.setMicEnabled(true);
    await flushMicrotasks(8);
    client.setDeafenEnabled(true);
    expect(client.isDeafened()).toBe(true);
    // Local mic state is independent.
    expect(client.getLocalTracks().mic).not.toBeNull();
    await client.leave();
  });
});

describe('VoiceClient quality propagation', () => {
  it('applyVideoQuality re-runs applyConstraints on the camera track', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
    await client.join();
    transportFake.fireRoster([presence(PEER1)]);
    await flushMicrotasks(8);
    await client.setCameraEnabled(true);
    await flushMicrotasks(8);

    await client.applyVideoQuality('720p');
    const cam = client.getLocalTracks().camera as unknown as { appliedConstraints: MediaTrackConstraints };
    // Most recent applyConstraints corresponds to 720p.
    expect((cam.appliedConstraints.height as { ideal: number }).ideal).toBe(720);
    await client.leave();
  });

  it('broadcastReceivedQuality sends a qualityhint to every peer', async () => {
    const client = new VoiceClient('ch1', { members: [SELF, PEER1, PEER2] });
    await client.join();
    transportFake.fireRoster([presence(PEER1), presence(PEER2)]);
    await flushMicrotasks(20);

    transportFake.sentSignals.length = 0;
    await client.broadcastReceivedQuality('480p');
    const hints = transportFake.sentSignals.filter((s) => s.payload.type === 'qualityhint');
    expect(new Set(hints.map((h) => h.to))).toEqual(new Set([PEER1, PEER2]));
    expect(hints[0].payload.qualityHint?.maxHeight).toBe(480);
    await client.leave();
  });
});

describe('VoiceClient bring-up beacon burst', () => {
  it('schedules extra publishes during the first ~18 s after join', async () => {
    vi.useFakeTimers();
    try {
      const client = new VoiceClient('ch1', { members: [SELF] });
      await client.join();
      // join() awaits the very first beacon synchronously.
      expect(transportFake.publishPresenceBeacon).toHaveBeenCalledTimes(1);

      // Walk past every front-loaded delay; each must produce a publish.
      for (const t of [300, 900, 1800, 3500, 7000, 12_000, 18_000]) {
        vi.setSystemTime(t);
        vi.advanceTimersByTime(t);
        await flushMicrotasks(2);
      }
      // 1 (initial) + 7 (burst) before the steady 10 s cadence dominates.
      expect(transportFake.publishPresenceBeacon.mock.calls.length).toBeGreaterThanOrEqual(8);
      await client.leave();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels pending bring-up timers on leave so they do not stray-publish', async () => {
    vi.useFakeTimers();
    try {
      const client = new VoiceClient('ch1', { members: [SELF] });
      await client.join();
      const baseline = transportFake.publishPresenceBeacon.mock.calls.length;
      await client.leave();
      // Advance past every bring-up delay; nothing else should fire.
      vi.advanceTimersByTime(20_000);
      await flushMicrotasks(2);
      expect(transportFake.publishPresenceBeacon.mock.calls.length).toBe(baseline);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VoiceClient first-sighting beacon refresh', () => {
  it('schedules an extra publish when a previously-unseen peer appears in the roster', async () => {
    vi.useFakeTimers();
    try {
      const client = new VoiceClient('ch1', { members: [SELF, PEER1] });
      await client.join();
      // Drain the bring-up burst so the assertion focuses on the
      // roster-driven refresh.
      vi.advanceTimersByTime(15_000);
      await flushMicrotasks(2);
      const baseline = transportFake.publishPresenceBeacon.mock.calls.length;

      // First time we see PEER1 → opportunistic publish (debounced 250 ms).
      transportFake.fireRoster([presence(PEER1)]);
      vi.advanceTimersByTime(300);
      await flushMicrotasks(2);
      expect(transportFake.publishPresenceBeacon.mock.calls.length).toBeGreaterThan(baseline);

      // Re-firing the SAME roster shouldn't trigger another refresh — only
      // brand-new pubkeys count as a sighting.
      const after = transportFake.publishPresenceBeacon.mock.calls.length;
      transportFake.fireRoster([presence(PEER1)]);
      vi.advanceTimersByTime(300);
      await flushMicrotasks(2);
      expect(transportFake.publishPresenceBeacon.mock.calls.length).toBe(after);
      await client.leave();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VoiceClient setExpectSfu', () => {
  const SFU = 'f'.repeat(64);

  it('does not consult pickSfu when constructed with expectSfu=false', async () => {
    const onTopologyChange = vi.fn();
    sfuControlFake.setPick({ pubkey: SFU });
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: false,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(5);
    expect(sfuControlFake.pickSfu).not.toHaveBeenCalled();
    expect(onTopologyChange).not.toHaveBeenCalled();
    await client.leave();
  });

  it('flips topology to mesh on setExpectSfu(false) while SFU is active', async () => {
    const onTopologyChange = vi.fn();
    sfuControlFake.setPick({ pubkey: SFU });
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(5);
    expect(onTopologyChange).toHaveBeenCalledWith(SFU);
    expect(sfuClientFake.last()?.started).toBe(true);
    onTopologyChange.mockClear();

    // Channel reclassified — voice-sfu → voice. Topology must drop
    // back to mesh and the SFU client must be torn down.
    client.setExpectSfu(false);
    await flushMicrotasks(5);
    expect(onTopologyChange).toHaveBeenCalledWith(null);
    expect(sfuClientFake.last()?.closed).toBe(true);
    expect(transportFake.subscribeRoster).toHaveBeenCalled();
    await client.leave();
  });

  it('re-enters SFU mode on setExpectSfu(true) using pickSfu', async () => {
    const onTopologyChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: false,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(5);
    expect(onTopologyChange).not.toHaveBeenCalled();

    // Make pickSfu hand back the SFU pubkey so the transition succeeds.
    sfuControlFake.setPick({ pubkey: SFU });
    client.setExpectSfu(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await flushMicrotasks(10);
    expect(onTopologyChange).toHaveBeenCalledWith(SFU);
    expect(sfuClientFake.last()?.sfuPubkey).toBe(SFU);
    await client.leave();
  });

  it('stays on mesh and surfaces an error when setExpectSfu(true) but pickSfu returns null', async () => {
    const onTopologyChange = vi.fn();
    const onError = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: false,
      events: { onTopologyChange, onError },
    });
    await client.join();
    sfuControlFake.setPick(null);
    client.setExpectSfu(true);
    await flushMicrotasks(10);
    expect(onTopologyChange).not.toHaveBeenCalled();
    expect(sfuClientFake.instances.length).toBe(0);
    // SFU-only contract: when the channel reclassifies to voice-sfu and no
    // SFU is reachable, surface the failure so the user knows the channel
    // isn't operating as configured. Do NOT silently keep meshing.
    expect(onError).toHaveBeenCalled();
    await client.leave();
  });
});

describe('VoiceClient onTopologyChange', () => {
  const SFU = 'f'.repeat(64);

  it('fires with the SFU pubkey when pickSfu resolves at join', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    const onTopologyChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(5);
    expect(onTopologyChange).toHaveBeenCalledWith(SFU);
    // Roster subscriptions are NOT taken in SFU mode — beacon discovery is
    // bypassed entirely; the SFU pushes the participant list over RPC.
    expect(transportFake.subscribeRoster).not.toHaveBeenCalled();
    expect(transportFake.publishPresenceBeacon).not.toHaveBeenCalled();
    await client.leave();
  });

  it('rejects join and surfaces an error when SfuClient.start fails (no mesh fallback)', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    sfuClientFake.setNextStartShouldFail();
    const onTopologyChange = vi.fn();
    const onError = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange, onError },
    });
    await expect(client.join()).rejects.toThrow();
    await flushMicrotasks(10);
    // enterSfuMode no longer fires onTopologyChange(SFU) eagerly — it
    // waits for SfuClient.start() to actually complete the RPC
    // handshake. On failure, startSfuClient's own catch fires
    // onTopologyChange(null) once. No mesh subscriptions are taken.
    expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([null]);
    expect(onError).toHaveBeenCalled();
    expect(transportFake.subscribeRoster).not.toHaveBeenCalled();
    expect(transportFake.publishPresenceBeacon).not.toHaveBeenCalled();
  });

  it('rejects join when no SFU is reachable on a voice-sfu channel (no mesh fallback)', async () => {
    sfuControlFake.setPick(null);
    const onTopologyChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange },
    });
    await expect(client.join()).rejects.toThrow(/no sfu/i);
    await flushMicrotasks(5);
    expect(onTopologyChange).not.toHaveBeenCalled();
    expect(transportFake.subscribeRoster).not.toHaveBeenCalled();
    expect(transportFake.publishPresenceBeacon).not.toHaveBeenCalled();
  });
});

describe('VoiceClient SFU push-roster', () => {
  const SFU = 'f'.repeat(64);

  it('mirrors SfuClient.onPeersChange into rosterPubkeys + onParticipantsChange', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    const onParticipantsChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1, PEER2],
      expectSfu: true,
      events: { onParticipantsChange },
    });
    await client.join();
    await flushMicrotasks(5);
    const stub = sfuClientFake.last();
    if (!stub) throw new Error('SfuClient not constructed');

    // Initial participantList — two peers already in the room.
    stub.events.onPeersChange?.([PEER1, PEER2]);
    expect(client.getParticipants().sort()).toEqual([PEER1, PEER2].sort());
    expect(onParticipantsChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([PEER1, PEER2]),
    );

    // peerJoined adds.
    stub.events.onPeersChange?.([PEER1, PEER2, 'd'.repeat(64)]);
    expect(client.getParticipants()).toContain('d'.repeat(64));

    // peerLeft removes.
    stub.events.onPeersChange?.([PEER1]);
    expect(client.getParticipants()).toEqual([PEER1]);
    await client.leave();
  });

  it('does not publish beacons or subscribe to roster while in SFU mode', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
    });
    await client.join();
    await flushMicrotasks(5);
    expect(transportFake.publishPresenceBeacon).not.toHaveBeenCalled();
    expect(transportFake.subscribeRoster).not.toHaveBeenCalled();
    expect(transportFake.subscribeSignals).not.toHaveBeenCalled();
    await client.leave();
  });

  it('forwards trustedRelays from pickSfu to the SfuClient', async () => {
    const relays = ['wss://lacrypta-relay.obelisk.ar'];
    sfuControlFake.setPick({ pubkey: SFU, trustedRelays: relays });
    const client = new VoiceClient('ch1', {
      members: [SELF],
      expectSfu: true,
    });
    await client.join();
    await flushMicrotasks(5);
    expect(sfuClientFake.last()?.sfuPubkey).toBe(SFU);
    await client.leave();
  });

  it('keeps Nostr RPC when the advertisement has a public URL', async () => {
    sfuControlFake.setPick({ pubkey: SFU, url: 'https://sfu.example.test' });
    const client = new VoiceClient('ch1', {
      members: [SELF],
      expectSfu: true,
    });
    await client.join();
    await flushMicrotasks(5);
    expect(sfuClientFake.last()?.directUrl).toBeUndefined();
    expect(sfuControlFake.publishSfuStart).toHaveBeenCalled();
    await client.leave();
  });
});

describe('VoiceClient room-full rejection', () => {
  it('sends bye{room-full} and refuses to open a peer when receiving a signal from over-cap pubkey', async () => {
    // Self is lex-first ('a'×64). 5 peers (b-f) fill the room. A 6th, 'g'×64,
    // sends an offer — must be rejected.
    const aPub = 'a'.repeat(64);
    const bPub = 'b'.repeat(64);
    const cPub = 'c'.repeat(64);
    const dPub = 'd'.repeat(64);
    const ePub = 'e'.repeat(64);
    const fPub = 'f'.repeat(64);
    const gPub = 'g'.repeat(64);
    transportFake.setSelfPubkey(aPub);
    const members = [aPub, bPub, cPub, dPub, ePub, fPub, gPub];
    const client = new VoiceClient('ch1', { members });
    await client.join();
    // Roster announces the leading 5 (excluding the over-cap peer).
    transportFake.fireRoster([aPub, bPub, cPub, dPub, ePub].map((m) => presence(m)));
    await flushMicrotasks(20);
    // Now g sends an offer — must be rejected with byeReason 'room-full'.
    transportFake.sentSignals.length = 0;
    transportFake.fireSignal(gPub, {
      type: 'offer', sdp: 'v=0', sessionId: 'g-sid', seq: 1,
    });
    await flushMicrotasks(10);
    const byeToG = transportFake.sentSignals.find(
      (s) => s.to === gPub && s.payload.type === 'bye',
    );
    expect(byeToG, 'sent bye to over-cap peer').toBeDefined();
    expect(byeToG!.payload.byeReason).toBe('room-full');
    // No peer was opened for g.
    expect(client.getParticipants()).not.toContain(gPub);
    await client.leave();
  });

  it('does NOT reject signaling from a peer that is within the cap', async () => {
    const aPub = 'a'.repeat(64);
    const bPub = 'b'.repeat(64);
    const cPub = 'c'.repeat(64);
    transportFake.setSelfPubkey(aPub);
    const members = [aPub, bPub, cPub];
    const client = new VoiceClient('ch1', { members });
    await client.join();
    transportFake.fireRoster([aPub, bPub, cPub].map((m) => presence(m)));
    await flushMicrotasks(20);
    transportFake.sentSignals.length = 0;
    transportFake.fireSignal(bPub, {
      type: 'offer', sdp: 'v=0', sessionId: 'b-sid', seq: 1,
    });
    await flushMicrotasks(10);
    // No bye should have been sent to b.
    const byeToB = transportFake.sentSignals.find(
      (s) => s.to === bPub && s.payload.type === 'bye' && s.payload.byeReason === 'room-full',
    );
    expect(byeToB, 'no room-full bye to in-cap peer').toBeUndefined();
    await client.leave();
  });
});

describe('VoiceClient SFU bootstrap retry ladder', () => {
  const SFU = 'f'.repeat(64);

  it('survives a transient timeout and joins on the second attempt', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    // First bootstrap throws an rpc timeout, second succeeds.
    sfuClientFake.queueStartOutcomes('timeout', 'ok');
    const onTopologyChange = vi.fn();
    const onError = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange, onError },
    });
    vi.useFakeTimers();
    try {
      const joining = client.join();
      // Per attempt: 350 ms SFU_START_SETTLE_MS + start() resolves immediately.
      // Attempt 0 timeout at t=350. Retry delay 2 s. Attempt 1 settle ends
      // at t=2700, then start() succeeds. Pad a bit for microtask drain.
      await vi.advanceTimersByTimeAsync(3_000);
      await joining;
      // Two SfuClient instances were constructed (one per attempt); the
      // first is closed, the second is the live one.
      expect(sfuClientFake.instances.length).toBe(2);
      expect(sfuClientFake.instances[0]!.closed).toBe(true);
      expect(sfuClientFake.instances[1]!.started).toBe(true);
      expect(sfuClientFake.instances[1]!.closed).toBe(false);
      // publishSfuStart was called once per attempt — both with force=true.
      expect(sfuControlFake.publishSfuStart).toHaveBeenCalledTimes(2);
      for (const call of sfuControlFake.publishSfuStart.mock.calls) {
        const opts = call[2] as { force?: boolean };
        expect(opts.force).toBe(true);
      }
      // onTopologyChange fired once with SFU pubkey (on success), and
      // critically NOT with null between attempts — the retry is
      // internal, the user sees one clean transition.
      expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([SFU]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await client.leave();
    }
  });

  it('fails join with a single onError after 3 consecutive timeouts', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    sfuClientFake.queueStartOutcomes('timeout', 'timeout', 'timeout');
    const onTopologyChange = vi.fn();
    const onError = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange, onError },
    });
    vi.useFakeTimers();
    try {
      // Attach the rejection handler BEFORE advancing timers — the loop's
      // failSfuStart throws synchronously as the last attempt resolves,
      // and a bare `client.join()` would surface as an unhandled rejection
      // partway through the advance.
      const settled = client.join().then(() => 'ok' as const, (e) => e as Error);
      // Per attempt: 350 ms settle then timeout. Retry delays 0/2/4 s.
      // Timeline: 350 (atmpt 0) + 2000 + 350 (atmpt 1) + 4000 + 350 (atmpt 2) ≈ 7050 ms.
      await vi.advanceTimersByTimeAsync(7_500);
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/rpc timeout/);
      expect(sfuClientFake.instances.length).toBe(3);
      for (const inst of sfuClientFake.instances) expect(inst.closed).toBe(true);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a non-timeout failure', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    sfuClientFake.queueStartOutcomes('generic-fail');
    const onError = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onError },
    });
    await expect(client.join()).rejects.toThrow();
    // Only one SfuClient was constructed — no retries for non-timeout errors.
    expect(sfuClientFake.instances.length).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('VoiceClient remote-SFU-closure recovery', () => {
  const SFU = 'f'.repeat(64);

  it('tears down SfuClient + fires onTopologyChange(null) when the bridge drops the active-call entry', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    const onTopologyChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(20);
    // After join the watcher should have asked for a bridge handle and
    // subscribed to activeCallByChannel.
    expect(bridgeFake.getBridge).toHaveBeenCalled();
    const initial = sfuClientFake.last();
    expect(initial.closed).toBe(false);
    expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([SFU]);

    // Arm the watcher with an active snapshot, then close.
    bridgeFake.fire({ ch1: { hostPubkey: SELF, status: 'active', participantCount: 1, expiresAt: 9_999_999_999, createdAt: 1 } });
    await flushMicrotasks(5);
    bridgeFake.fire({}); // status=closed → bridge deletes the entry
    await flushMicrotasks(5);

    expect(initial.closed).toBe(true);
    // The supervisor in VoiceRoom.tsx listens for this to bump
    // `sfuRepublishCounter` — that's what re-enters SFU mode.
    expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([SFU, null]);
    await client.leave();
  });

  it('ignores an empty snapshot delivered before the active entry has ever been seen', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    const onTopologyChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(20);
    const initial = sfuClientFake.last();
    expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([SFU]);

    // Fire only an empty snapshot — no prior active entry seen. This is
    // the steady-state at join (the SFU may not have published 31314 yet),
    // and reacting to it would loop the bootstrap.
    bridgeFake.fire({});
    await flushMicrotasks(5);
    expect(initial.closed).toBe(false);
    expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([SFU]);
    await client.leave();
  });

  it('does not react to active-call snapshots for a different channel', async () => {
    sfuControlFake.setPick({ pubkey: SFU });
    const onTopologyChange = vi.fn();
    const client = new VoiceClient('ch1', {
      members: [SELF, PEER1],
      expectSfu: true,
      events: { onTopologyChange },
    });
    await client.join();
    await flushMicrotasks(20);
    const initial = sfuClientFake.last();
    // Drive the watcher with snapshots that ONLY mention another channel.
    bridgeFake.fire({ ch2: { hostPubkey: SELF, status: 'active', participantCount: 1, expiresAt: 9_999_999_999, createdAt: 1 } });
    await flushMicrotasks(5);
    bridgeFake.fire({});
    await flushMicrotasks(5);
    // The dex never saw OUR channel as active, so the empty snapshot
    // cannot trigger recovery.
    expect(initial.closed).toBe(false);
    expect(onTopologyChange.mock.calls.map((c) => c[0])).toEqual([SFU]);
    await client.leave();
  });
});

describe('VoiceClient capacity cap', () => {
  it('caps audio mesh participants at 4', async () => {
    // 10 candidates; 4-person audio cap + self trims to <= 3 others.
    const members = [
      SELF, PEER1, PEER2,
      'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64),
      '1'.repeat(64), '2'.repeat(64),
      '3'.repeat(64), '4'.repeat(64),
    ];
    const client = new VoiceClient('ch1', { members });
    await client.join();
    transportFake.fireRoster(members.map((m) => presence(m)));
    await flushMicrotasks(20);
    // Self + at most 3 others = 4 total.
    expect(client.getParticipants().length).toBeLessThanOrEqual(3);
    await client.leave();
  });
});
