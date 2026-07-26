// Build identity — bumped per-deploy to force turbopack to mint a fresh
// chunk filename for this module. Without it, sticky local caches
// (extension content scripts, HTTPS-inspecting proxies, aggressive disk
// caches) can pin the previous build's voice client at the same URL
// indefinitely. Side-effect (window assignment) so the constant
// survives tree-shaking — turbopack would otherwise drop a `void`'d
// constant and produce the same chunk hash as before.
if (typeof globalThis !== 'undefined') {
  (globalThis as { __obeliskVoiceBuild?: string }).__obeliskVoiceBuild =
    '2026-05-24T01:00:00Z-voice-video-autoplay-retry';
}

/**
 * VoiceClient orchestrates a peer mesh inside a single channel:
 *  - publishes presence beacons on a 10s cadence + opportunistically when
 *    the local connected/known peer set changes (so transitive discovery
 *    on other clients converges within one beacon hop, not 10 s)
 *  - subscribes to the roster + opens a `Peer` per remote pubkey
 *  - subscribes to incoming signaling and routes to the right `Peer`
 *  - manages local mic / camera / screen tracks across all peers
 *  - drives RMS-based speaking detection for the local mic and every
 *    incoming remote audio track, mirroring transitions into the voice
 *    store so the UI's speaking-orb pulses without round-tripping
 *
 * Pure-Nostr; no `server.ts` dependency. 4-person calls fit comfortably
 * with three direct peer connections per client.
 */
import { Peer } from './peer';
import { SfuClient } from './sfu-client';
import type { SfuRemoteTrack } from './sfu-client';
import { pickSfu, publishSfuStart } from './sfu-control';
import type { SfuAdvertisement } from './sfu-control';
import type {
  VoicePresence,
  VoiceSignalPayload,
  VoiceTrackKind,
  VoiceQualityHint,
  VideoSlotKind,
} from './types';
import {
  createVoiceTransport,
  getSelfPubkey,
  type VoiceTransport,
  transitiveParticipants,
} from './transport';
import { getPreset, MIC_CONSTRAINTS, type VideoQuality } from './quality';
import { useVoiceStore } from '@/store/voice';
import { wotEngine } from '@/lib/wot/engine';
import { KIND_VOICE_SIGNAL } from '@/lib/nip-kinds';
import { SpeakingDetector, resumeSharedAudioContext } from './speaking-detector';
import { emptyVoiceMetrics, type VoiceMetrics } from './metrics';
import { pushVoiceDebug, setVoiceMetricsRef } from './debug';
import { getBridge } from '@/lib/nostr-bridge/client';
import { DiscoveryEngine } from './discovery';
import {
  withRateLimitBackoff,
  installBeforeUnloadHandler,
  type UnloadHandlerHandle,
} from './failure-handlers';

const SELF_BUILD_TAG = '2026-05-24T01:00:00Z-voice-video-autoplay-retry';

const BEACON_INTERVAL_MS = 10_000;
/**
 * Aggressive beacon burst right after `join()`. NIP-29 voice beacons are
 * ephemeral — relays don't backfill them — so a peer who joined a few
 * seconds before us would otherwise be invisible until their next 10 s
 * tick. Firing additional publishes in the first ~12 s collapses that
 * worst-case discovery latency to a few seconds while keeping the
 * total relay traffic bounded (six small events vs ~one event every
 * 15 s in steady state).
 *
 * Time origin = right after the first `publishBeacon()` returns from
 * `join()`. The schedule is intentionally front-loaded: each step is
 * roughly 2× the previous so a slow NIP-42 AUTH has multiple chances
 * to land a beacon before we settle into the steady-state cadence.
 */
const BEACON_BRINGUP_DELAYS_MS = [300, 900, 1800, 3500, 7000, 12_000, 18_000];
/**
 * Mesh participant cap. Each peer maintains N-1 outbound audio streams
 * (so an N-person room is N(N-1) PCs total — quadratic). Four means
 * 12 directed streams room-wide, comfortable on a typical home upstream at
 * Opus 64-128 kbps per stream.
 *
 * **Active rejection** — when this cap is reached the existing peers
 * send a `bye { byeReason: 'room-full' }` to any over-cap arrival, so
 * the joiner stops repeated redial attempts immediately and surfaces a
 * clean error in their UI. Lex-deterministic ordering means every
 * existing peer agrees on who's "in" and who's "rejected" without
 * a coordinator. See `isWithinRoomCap`.
 */
const MAX_PARTICIPANTS = 4;
/**
 * Independent room-wide media caps: four cameras and one screen share.
 * Beyond this, mesh uplink becomes
 * the binding constraint long before the audio mesh does. Race-overflow
 * resolution is deterministic via `(beaconCreatedAt asc, pubkey asc)` —
 * the holders outside the leading slice locally evict their video.
 */
const MAX_CAMERAS = 4;
const MAX_SCREEN_SHARES = 1;
/**
 * Debounce for opportunistic beacon refresh after a connection-state change.
 * Coalesces a flurry of `connected` transitions during initial mesh formation
 * into a single beacon publish so we don't spam the relay.
 */
const BEACON_REFRESH_DEBOUNCE_MS = 250;
const CONTROL_SNAPSHOT_DEBOUNCE_MS = 150;
/**
 * Window during which we hold an inbound signal from a peer who isn't yet
 * known to be a member. 5 s comfortably covers the expected race between
 * the peer's first kind 25050 and the bridge's kind 39002 snapshot
 * delivery on a healthy relay; longer windows just delay the failure
 * mode where the peer never appears at all.
 */
const DEFERRED_SIGNAL_TTL_MS = 5_000;
/** Per-peer cap — offer + answer + ~6 ICE batches is the normal worst case. */
const DEFERRED_SIGNAL_PER_PEER_CAP = 8;
/** Total cap across all unknown peers, to bound memory under a flood. */
const DEFERRED_SIGNAL_TOTAL_CAP = 64;
/** How often the deferred queue self-sweeps for expired entries. */
const DEFERRED_SIGNAL_SWEEP_MS = 1_000;
/**
 * Give the SFU's control subscription a short chance to process the
 * just-published `start` event before the first mediasoup RPC.
 */
const SFU_START_SETTLE_MS = 350;
/**
 * Delays (ms) between successive SFU bootstrap attempts. Attempt 0 fires
 * immediately; subsequent attempts wait this long before reissuing
 * `publishSfuStart` + reopening RPC. Total wall-clock budget ≈ 6 s before
 * the user sees an error toast — comfortably covers the worst-case window
 * where the SFU process is still booting after a watchdog restart.
 */
const SFU_BOOTSTRAP_ATTEMPT_DELAYS_MS = [0, 2_000, 4_000];
const SFU_BOOTSTRAP_MAX_ATTEMPTS = SFU_BOOTSTRAP_ATTEMPT_DELAYS_MS.length;

export interface RemoteTrack {
  /**
   * Logical origin — whose participant tile this track renders in. In
   * mesh, this equals the RTC remote. In SFU mode, it's the participant
   * the SFU is forwarding from (set by `trackInfo.originPubkey`).
   */
  pubkey: string;
  /**
   * The RTC remote that delivered this track over its PC. Same as
   * `pubkey` in mesh; the SFU's pubkey in SFU mode. Used by teardown
   * to clean up forwarded tracks when the underlying PC drops.
   */
  viaPubkey: string;
  trackId: string;
  kind: VoiceTrackKind;
  stream: MediaStream;
}

export interface VoiceClientEvents {
  onParticipantsChange?(pubkeys: string[]): void;
  onRemoteTracksChange?(tracks: RemoteTrack[]): void;
  onLocalTracksChange?(local: { mic: boolean; camera: boolean; screen: boolean }): void;
  onPeerConnectionStatesChange?(states: Record<string, RTCPeerConnectionState>): void;
  /**
   * Topology change — null means "back on mesh", a hex pubkey means "now
   * forwarding through this SFU". Fires every time `setSfuMode` flips,
   * including the first time an SFU's beacon shows up. UI uses this to
   * tell users whether their `voice-sfu` channel actually upgraded to
   * the SFU or fell back to mesh because the SFU rejected the start.
   */
  onTopologyChange?(sfuPubkey: string | null): void;
  onError?(message: string): void;
  onLeft?(reason?: string): void;
}

export interface VoiceClientOptions {
  /**
   * Authoritative member list for this channel (NIP-29 kind 39002 pubkeys).
   * Non-members' presence beacons and signaling events are dropped, and the
   * local user must be in this list to publish a beacon. An empty list is
   * treated as "open room" — only useful for ad-hoc / dev rooms; production
   * callers should always pipe the real member list through here.
   */
  members?: readonly string[];
  /**
   * Whether the call should run on an SFU.
   *
   * `true` — at `join()`, ask `pickSfu(channelId)` for the active SFU
   *          (per-channel pin → env override → kind 31313 advertisement)
   *          and switch to SFU mode if found. Used for `voice-sfu`
   *          channels.
   * `false` (default) — stay in mesh. `pickSfu` is never consulted, so
   *          stray SFU advertisements can't hijack the topology.
   *
   * Mutable post-construction via {@link VoiceClient.setExpectSfu} so a
   * channel-kind reclassification flips the live call without requiring
   * a teardown/rejoin.
   */
  expectSfu?: boolean;
  /**
   * Channel admins (NIP-29 kind 39001 pubkeys). Only events signed by these
   * pubkeys are honored as moderator force-actions.
   */
  admins?: readonly string[];
  /**
   * NIP-29 `["open"]` flag from the channel's kind 39000 metadata. When
   * true, anyone may join regardless of `members`/`admins` — passing the
   * member list is still useful so admin badges render correctly, but the
   * gate on join/canJoin becomes unconditional.
   */
  open?: boolean;
  /** Relay where this call was joined. Mesh voice traffic remains pinned here
   *  even when the user browses another server. */
  originRelayUrl?: string | null;
  events?: VoiceClientEvents;
}

export class VoiceClient {
  readonly channelId: string;
  readonly selfPubkey: string;
  private events: VoiceClientEvents;
  private readonly transport: VoiceTransport;
  private readonly sessionId = randomId();

  private members: ReadonlySet<string>;
  private admins: ReadonlySet<string>;
  // Mutable so the live client can pick up a channel flipping open ↔ closed
  // without being torn down. NIP-29 admins occasionally republish kind 39000
  // with a different `["open"]` state and any in-call peers should follow.
  private openRoom: boolean;
  /**
   * Mirrors `VoiceClientOptions.expectSfu`. Mutable so a channel that
   * gets reclassified between `voice` and `voice-sfu` mid-call flips the
   * topology without forcing the user to rejoin.
   */
  private expectSfu: boolean;

  private peers = new Map<string, Peer>();
  private openingPeers = new Set<string>();
  private remoteTracks = new Map<string, RemoteTrack>(); // key: trackId
  private rosterPubkeys: string[] = [];
  /**
   * SFU mode marker. Set when any beacon in `currentRoster` carries the
   * `["sfu","1"]` topology tag; cleared otherwise. While set, the dial
   * loop opens at most ONE PC (to this pubkey) instead of meshing across
   * every other participant. See `setSfuMode` and docs/sfu-system.md §5.
   */
  private sfuPubkey: string | null = null;
  /**
   * Mediasoup-client driver for the active SFU. Replaces the werift-era
   * `Peer` class for the SFU peer slot. Mesh peers continue to use `Peer`.
   * Lifecycle: created in `setSfuMode(pubkey)`, torn down on `setSfuMode(null)`
   * or when the channel is left.
   */
  private sfuClient: SfuClient | null = null;
  /**
   * Unsubscribe handle for the bridge's `activeCallByChannel` state store.
   * We watch this only while in SFU mode — when our channel disappears or
   * flips to `status='closed'`, the SFU has published a kind 31314 closure
   * (intentional shutdown, watchdog auto-heal, or duration-cap end). Reacting
   * here triggers the same supervisor-driven republish that an organic
   * topology loss would, ~13s faster than waiting for the SFU's kind 20078
   * beacon to expire from the roster.
   */
  private activeCallUnsub: (() => void) | null = null;
  private voiceRelayCapacityRelease: (() => void) | null = null;
  /**
   * Have we ever observed our channel as `active` in the bridge's
   * active-call store? Used as an armed-flag so a snapshot that lands
   * before the SFU has had a chance to publish 31314 doesn't trigger
   * a phantom closure-recovery.
   */
  private activeCallSeen = false;
  /**
   * Pubkeys that have published a beacon with `["sfu","1"]` for this
   * channel. SFUs are infrastructure, not participants — they should be
   * trusted through the membership filter without operators having to
   * manually add the SFU's pubkey to every channel's NIP-29 member list.
   * The SFU's signed beacon is the credential; the SFU's own allow-list
   * (config-side) gates who can actually start calls on it.
   *
   * Refreshed from `currentRoster` on every snapshot — when the SFU's
   * beacon expires, its pubkey leaves this set on the next sweep.
   *
   * Trust caveat: a malicious actor could publish a beacon with
   * `["sfu","1"]` to claim SFU status. The hardening pair is the SFU's
   * kind 31314 active-call event (only published when an authorized host
   * actually started a call); v0 trusts the beacon flag alone.
   */
  private knownSfuPubkeys = new Set<string>();
  private knownMeshTestPeerPubkeys = new Set<string>();
  /**
   * Passive active-call participants from the bridge's global kind 20078
   * watcher. This is a fallback bootstrap source for the joined mesh client:
   * if the dedicated roster subscription misses an ephemeral beacon, the UI's
   * live-call detector can still hand us the pubkeys it already sees.
   */
  private passiveParticipantHints = new Set<string>();
  /**
   * Pubkeys we currently have RTCPeerConnections in `connected` state with.
   * Drives the `connectedTo` field of our own beacon — every other peer who
   * sees our beacon learns to dial these pubkeys, even if those pubkeys'
   * own beacons were dropped by the relay.
   */
  private connectedPubkeys = new Set<string>();
  /**
   * Latest known beacon-roster snapshot for this channel. Used to compute
   * the room-wide video-slot count when local video is starting / running.
   * Updated on every `subscribeRoster` callback and on each local video
   * mutation (so race resolution sees its own updates immediately).
   */
  private currentRoster: readonly VoicePresence[] = [];
  /**
   * Wall-clock seconds when each of our local video tracks claimed its
   * slot. Race resolution sorts by `(claimedAt asc, pubkey asc)` so an
   * older track wins against a later one — matches the relay-sourced
   * `createdAt` ordering used for remote claims.
   */
  private localVideoClaimedAt = new Map<VideoSlotKind, number>();
  private beaconRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  private micTrack: MediaStreamTrack | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private screenAudioTrack: MediaStreamTrack | null = null;
  /**
   * Last requested camera facing — flipped by `switchCamera()` and used
   * as the `facingMode` hint when (re-)acquiring the camera. Desktops
   * typically ignore the hint and just hand back the default device.
   */
  private cameraFacing: 'user' | 'environment' = 'user';

  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Front-loaded extra beacon publishes scheduled at `join()` time. Held so
   * `leave()` can cancel them — without this, an in-flight bring-up timer
   * would publish a beacon for a channel we've already left.
   */
  private bringupTimers: ReturnType<typeof setTimeout>[] = [];
  /**
   * Pubkeys we've seen in any roster snapshot since join. Used to detect a
   * NEW peer's first appearance, which schedules a beacon refresh so that
   * peer learns about us within ~250 ms instead of waiting up to a full
   * `BEACON_INTERVAL_MS` for our next periodic publish.
   */
  private seenRosterPubkeys = new Set<string>();
  /**
   * Two-source mesh peer discovery (relay beacons + control-channel
   * propagation). On every roster snapshot we replace the relay set; the
   * control set accumulates as peers' data channels report `hello` /
   * `peerAdded` / `peerRemoved`. The dial loop uses `effectivePeers()` so
   * the dex stays workable when the relay drops a participant's beacons
   * but their PC to a third party is healthy.
   */
  private readonly discovery = new DiscoveryEngine();
  /** Coalesce dial-loop runs triggered by control-channel propagation
   *  arriving in microtask order during a single hello. */
  private dialDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesce full peer-set gossip across open WebRTC control channels. */
  private controlSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private unloadHandler: UnloadHandlerHandle | null = null;
  private rosterUnsub: (() => void) | null = null;
  private signalsUnsub: (() => void) | null = null;
  private joined = false;
  private deafened = false;
  /**
   * Speaking-activity detectors. Keyed by pubkey: the local detector lives
   * under `selfPubkey` and each remote audio track gets a detector under
   * its peer's pubkey. We keep them addressable so micEnabled toggles, peer
   * teardown, and remote-track-end can all stop the right one.
   */
  private speakingDetectors = new Map<string, SpeakingDetector>();

  /**
   * Observable counters for the mesh voice layer. Exposed via
   * `window.__obeliskVoiceMetrics` so the Playwright harness and the
   * `?debug=voice` overlay can assert on previously-silent failure modes.
   * Mutated in place — never reassigned — so subscribers see updates
   * without needing change events.
   */
  readonly metrics: VoiceMetrics = emptyVoiceMetrics();

  /**
   * Inbound signals from peers we haven't yet seen as members. Queued for
   * up to `DEFERRED_SIGNAL_TTL_MS` waiting for `updateRoles()` to admit
   * the sender. On admission the queue drains through the same
   * `routeSignal` path the live signal takes. Bounded by
   * `DEFERRED_SIGNAL_PER_PEER_CAP` and `DEFERRED_SIGNAL_TOTAL_CAP` so a
   * malicious flood can't blow memory.
   *
   * Without this queue, the receiver-side membership filter at line 489
   * silently drops the very first kind 25050 from any peer whose 39002
   * snapshot lands a few hundred ms after their first SDP offer — a
   * common timing on cold-start where membership and voice signals
   * race through the bridge in an unpredictable order. Phase-1
   * diagnosis flagged this as the dominant production-side regression
   * risk.
   */
  private deferredSignals = new Map<
    string,
    { payload: VoiceSignalPayload; arrivedAt: number }[]
  >();
  private deferredSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(channelId: string, options: VoiceClientOptions = {}) {
    this.channelId = channelId;
    this.events = options.events ?? {};
    this.transport = createVoiceTransport({ relayUrl: options.originRelayUrl ?? null });
    this.members = new Set(options.members ?? []);
    this.admins = new Set(options.admins ?? []);
    // Honor the explicit `open` flag from kind 39000 first. Falling back
    // to "no members provided" preserves the dev / ad-hoc-room behavior
    // but is no longer the only path — production callers wire the
    // group's `isOpen` through so an open public channel doesn't reject
    // non-members just because their kind 9000 hasn't landed locally.
    this.openRoom = options.open === true
      || !options.members
      || options.members.length === 0;
    // Default `false` — mesh-only unless the caller explicitly opts in
    // via channel kind. Production callers (VoiceRoom) pass
    // `expectSfu: channelKind === 'voice-sfu'`, so the default only
    // affects ad-hoc / test constructions which should be mesh.
    this.expectSfu = options.expectSfu === true;
    const pk = getSelfPubkey();
    if (!pk) throw new Error('Not logged in to nostr');
    this.selfPubkey = pk;
    setVoiceMetricsRef(this.metrics);
    if (typeof window !== 'undefined') {
      (window as unknown as { __obeliskVoiceSelfPubkey?: string }).__obeliskVoiceSelfPubkey = pk;
    }
  }

  /** Swap the event listeners — used when a fresh React owner picks up an
   *  already-running call after navigating back. */
  setEvents(events: VoiceClientEvents): void {
    this.events = events;
  }

  /**
   * Multicast subscribers for remote-track changes. `events.onRemoteTracksChange`
   * is single-callback (owned by the React room component while it's
   * mounted); listeners registered here run alongside it so surfaces
   * outside the room — e.g. the always-mounted `BackgroundVoiceAudio`
   * sink that keeps audio playing while the user views another channel —
   * can react to the same updates without fighting for `events`.
   */
  private remoteTracksListeners = new Set<(t: RemoteTrack[]) => void>();
  subscribeRemoteTracks(cb: (t: RemoteTrack[]) => void): () => void {
    this.remoteTracksListeners.add(cb);
    try { cb(Array.from(this.remoteTracks.values())); } catch { /* swallow */ }
    return () => { this.remoteTracksListeners.delete(cb); };
  }

  /** Snapshot helpers so a freshly-bound owner can hydrate UI state without
   *  waiting for the next event tick. */
  getParticipants(): string[] {
    return [...this.rosterPubkeys];
  }
  getRemoteTracks(): RemoteTrack[] {
    return Array.from(this.remoteTracks.values());
  }
  isJoined(): boolean {
    return this.joined;
  }
  /**
   * Test/diagnostic accessor — returns the underlying RTCPeerConnection's
   * `connectionState` for a remote pubkey, or `null` when there is no live
   * mesh peer for that pubkey (peer not opened yet, already torn down, or
   * SFU mode where the peer is the SFU). The Playwright two-peer mesh
   * spec calls this through `active-client.ts:getPeerConnectionState`.
   */
  getPeerConnectionState(pubkey: string): RTCPeerConnectionState | null {
    const peer = this.peers.get(pubkey);
    return peer?.pc?.connectionState ?? null;
  }
  getPeerConnectionStates(): Record<string, RTCPeerConnectionState> {
    const states: Record<string, RTCPeerConnectionState> = {};
    for (const [pubkey, peer] of this.peers.entries()) {
      states[pubkey] = peer.pc.connectionState;
    }
    return states;
  }
  /**
   * Currently-active SFU pubkey for this channel, or null in mesh mode.
   * UI uses this to render an "SFU mode" badge or hide the participant
   * count from including the SFU. Updated whenever the roster snapshot
   * gains/loses a beacon with `["sfu","1"]`.
   */
  getSfuPubkey(): string | null {
    return this.sfuPubkey;
  }

  /**
   * Toggle the open-room flag at runtime. Used when the channel's kind
   * 39000 metadata arrives (or is republished) after the client was
   * constructed — without this, an early gate decision permanently freezes
   * the openness state and either over-restricts (drops every remote peer
   * because the member list hadn't propagated yet) or under-restricts.
   */
  setOpen(open: boolean): void {
    if (this.openRoom === open) return;
    this.openRoom = open;
    // Passive hints are filtered through isMember/canJoin, so an open-room
    // transition can make already-detected callers dialable immediately.
    this.scheduleDialFromDiscovery();
    // Re-run the membership trim if we just locked the room down so any
    // already-connected non-members are dropped immediately.
    if (!open) {
      for (const pk of Array.from(this.peers.keys())) {
        if (!this.isMember(pk)) {
          this.tearDownPeer(pk);
        }
      }
    }
  }

  /**
   * Feed the active mesh client with the bridge-level live-call detector.
   * The detector is driven by the same kind 20078 beacons shown in the
   * pre-join UI, so using it here prevents a split-brain state where the
   * room says people are present but the joined WebRTC client never dials
   * them because its dedicated ephemeral roster REQ missed the beacon.
   */
  setPassiveParticipantHints(
    pubkeys: readonly string[] = [],
    options: { merge?: boolean } = {},
  ): void {
    const next = options.merge ? new Set(this.passiveParticipantHints) : new Set<string>();
    for (const pk of pubkeys) {
      if (!pk || pk === this.selfPubkey) continue;
      if (!/^[0-9a-f]{64}$/i.test(pk)) continue;
      next.add(pk.toLowerCase());
    }
    const before = Array.from(this.passiveParticipantHints).sort().join('|');
    const after = Array.from(next).sort().join('|');
    if (before === after) return;
    this.passiveParticipantHints = next;
    pushVoiceDebug({
      kind: 'peer-discovered',
      payload: { source: 'active-call-hints', peers: Array.from(next).sort() },
    });
    if (!this.joined || this.sfuPubkey) return;
    this.runDialLoop();
    this.scheduleBeaconRefresh();
  }

  /**
   * Live-flip whether the call should run on an SFU. Used when the
   * channel kind reclassifies between `voice` and `voice-sfu` while a
   * call is already running — we want the topology to follow the new
   * kind without forcing every participant to leave/rejoin.
   *
   * Going `true → false` (voice-sfu → voice): tear down the SFU client,
   * fire `onTopologyChange(null)`, start mesh subscriptions.
   *
   * Going `false → true` (voice → voice-sfu): ask `pickSfu` for the
   * channel's current SFU; if found, tear down mesh + flip to SFU. If
   * no SFU is reachable, stay in mesh.
   */
  setExpectSfu(expect: boolean): void {
    if (this.expectSfu === expect) return;
    this.expectSfu = expect;
    if (!this.joined) return;
    if (!expect && this.sfuPubkey) {
      const sfuPubkey = this.sfuPubkey;
      this.exitSfuMode();
      try { this.events.onTopologyChange?.(null); } catch (err) {
        console.warn('[voice] onTopologyChange handler threw', err);
      }
      void this.enterMeshMode().catch((err) =>
        console.warn('[voice] enterMeshMode after SFU exit failed', err),
      );
      console.log('[voice] topology sfu:', sfuPubkey.slice(0, 8), '→ mesh');
    } else if (expect && !this.sfuPubkey) {
      void (async () => {
        const picked = await pickSfu(this.channelId).catch(() => null);
        if (!picked) {
          // Channel just reclassified to voice-sfu but the pinned SFU is
          // unreachable. Surface to the UI; do not silently keep meshing —
          // the channel admin's intent is "use the SFU", not "best effort".
          try { this.events.onError?.('Channel switched to SFU mode but no SFU is reachable.'); }
          catch { /* ignore */ }
          return;
        }
        this.exitMeshMode();
        await this.enterSfuMode(picked.pubkey, picked);
      })();
    }
  }

  /**
   * Update the trusted member / admin lists at runtime. Existing peers from
   * pubkeys that just dropped out of the member set are torn down.
   */
  updateRoles(members: readonly string[], admins: readonly string[]): void {
    this.members = new Set(members);
    this.admins = new Set(admins);
    // Drain any deferred signals from peers we've now admitted. Runs
    // BEFORE the eviction loop so a peer who was newly admitted then
    // immediately demoted (rare but possible if 39002 oscillates)
    // still gets their queued offer applied — `tearDownPeer` will
    // clean up afterwards.
    this.drainDeferredSignals();
    if (this.openRoom) return;
    for (const pk of Array.from(this.peers.keys())) {
      // Admins are full members for connectivity purposes — kind 39001
      // doesn't always duplicate into 39002, so checking only `members`
      // would tear down legitimate admin peers on every role update.
      if (!this.isMember(pk)) {
        this.tearDownPeer(pk);
      }
    }
  }

  /**
   * Queue an inbound signal from a peer who isn't yet known to be a
   * member. Drained by `drainDeferredSignals` on every `updateRoles`
   * tick OR expired by the periodic sweep.
   */
  private deferSignal(from: string, payload: VoiceSignalPayload): void {
    let total = 0;
    for (const arr of this.deferredSignals.values()) total += arr.length;
    if (total >= DEFERRED_SIGNAL_TOTAL_CAP) {
      // Total cap exceeded — drop the OLDEST entry across all peers
      // before queueing this one. Bounds memory under a flood of
      // unknown-peer signaling without losing the most recent state.
      let oldestPeer: string | null = null;
      let oldestAt = Number.MAX_SAFE_INTEGER;
      for (const [pk, arr] of this.deferredSignals) {
        if (arr.length === 0) continue;
        if (arr[0].arrivedAt < oldestAt) {
          oldestAt = arr[0].arrivedAt;
          oldestPeer = pk;
        }
      }
      if (oldestPeer) {
        this.deferredSignals.get(oldestPeer)!.shift();
        this.metrics.signalsDropped.deferredOverflow++;
      }
    }
    let arr = this.deferredSignals.get(from);
    if (!arr) {
      arr = [];
      this.deferredSignals.set(from, arr);
    }
    if (arr.length >= DEFERRED_SIGNAL_PER_PEER_CAP) {
      arr.shift(); // drop oldest for this peer
      this.metrics.signalsDropped.deferredOverflow++;
    }
    arr.push({ payload, arrivedAt: Date.now() });
    this.metrics.signalsDropped.membershipDeferred++;
    pushVoiceDebug({ kind: 'signal-dropped', reason: 'membership-deferred', peer: from, payload });
    if (!this.deferredSweepTimer) {
      this.deferredSweepTimer = setInterval(() => this.sweepDeferredSignals(), DEFERRED_SIGNAL_SWEEP_MS);
    }
  }

  /** Replay queued signals for any peer who is now a member. */
  private drainDeferredSignals(): void {
    if (this.deferredSignals.size === 0) return;
    for (const [from, arr] of Array.from(this.deferredSignals.entries())) {
      if (!this.isMember(from)) continue;
      this.deferredSignals.delete(from);
      for (const { payload } of arr) {
        // WoT is now defense-in-depth (voice kinds in ALWAYS_ALLOW_KINDS),
        // but keep the check so a regression surfaces observably.
        if (!wotEngine.isAllowed(from, KIND_VOICE_SIGNAL)) {
          this.metrics.signalsDropped.wot++;
          pushVoiceDebug({ kind: 'signal-dropped', reason: 'wot', peer: from, payload });
          continue;
        }
        void this.routeSignal(from, payload);
      }
    }
    if (this.deferredSignals.size === 0 && this.deferredSweepTimer) {
      clearInterval(this.deferredSweepTimer);
      this.deferredSweepTimer = null;
    }
  }

  /** Drop entries past the TTL; bump `membershipFinal` for each. */
  private sweepDeferredSignals(): void {
    const cutoff = Date.now() - DEFERRED_SIGNAL_TTL_MS;
    for (const [from, arr] of Array.from(this.deferredSignals.entries())) {
      let removed = 0;
      while (arr.length > 0 && arr[0].arrivedAt < cutoff) {
        arr.shift();
        removed++;
      }
      if (removed > 0) {
        this.metrics.signalsDropped.membershipFinal += removed;
        pushVoiceDebug({ kind: 'signal-dropped', reason: 'membership-final', peer: from, payload: { dropped: removed } });
        console.warn('[voice-drop] membership-final', from.slice(0, 8), 'dropped=', removed);
      }
      if (arr.length === 0) this.deferredSignals.delete(from);
    }
    if (this.deferredSignals.size === 0 && this.deferredSweepTimer) {
      clearInterval(this.deferredSweepTimer);
      this.deferredSweepTimer = null;
    }
  }

  /** True when the local user is allowed to publish a beacon. */
  canJoin(): boolean {
    return this.openRoom || this.members.has(this.selfPubkey) || this.admins.has(this.selfPubkey);
  }

  isMember(pubkey: string): boolean {
    // SFUs are pseudo-members: their signed beacon is the credential.
    // This avoids forcing operators to add every SFU they want to use
    // to every channel's NIP-29 member list. Filter is the same on the
    // signaling path so the SFU's offers/answers/ICE aren't dropped.
    if (this.knownSfuPubkeys.has(pubkey)) return true;
    // Operator-spawned mesh test peers are diagnostics, not room members.
    // Once their signed beacon marks them as a mesh test peer, admit them
    // for any local user who can join this call. The join gate still enforces
    // NIP-29 membership/open-room access for the browser user, but the test
    // peer itself does not need to be duplicated into every member list.
    if (this.knownMeshTestPeerPubkeys.has(pubkey) && this.canJoin()) return true;
    // The bridge-level active-call detector is driven by signed kind 20078
    // beacons on this channel. Treat those pubkeys as provisional mesh
    // members while the local user is allowed to join, so a slow/stale
    // NIP-29 member snapshot cannot open a peer and then immediately
    // evict it before SDP/ICE completes.
    if (this.passiveParticipantHints.has(pubkey) && this.canJoin()) return true;
    return this.openRoom || this.members.has(pubkey) || this.admins.has(pubkey);
  }

  isAdmin(pubkey: string): boolean {
    return this.admins.has(pubkey);
  }

  async join(): Promise<void> {
    if (this.joined) return;
    if (!this.canJoin()) {
      throw new Error('You are not a member of this voice channel.');
    }
    this.joined = true;

    // The Join button is the user gesture that lets us resume the shared
    // AudioContext used by SpeakingDetector. Browsers create it suspended.
    void resumeSharedAudioContext();

    // Join starts listening-only. The user can publish their mic explicitly
    // from the mic button; presence, beacons, and remote audio do not depend
    // on microphone permission.
    this.emitLocal();

    // Topology decision is made up-front, not driven by the beacon roster
    // arriving late: for `voice-sfu` channels, ask `pickSfu` (per-channel
    // pin → env override → kind 31313 advertisement) and switch to SFU
    // mode immediately. The SFU itself becomes the source of truth for
    // the participant list via `peerJoined`/`peerLeft`/`participantList`
    // notifications, so we skip beacons + roster entirely while in SFU
    // mode.
    //
    // SFU-only contract: a `voice-sfu` channel ONLY uses its pinned SFU.
    // No mesh fallback — operators of a big-room channel choose an SFU
    // intentionally; silently dropping to a 6-peer mesh on transient SFU
    // outage gives a worse experience (people fail to hear each other,
    // 9th joiner gets evicted, audio quality drops) than surfacing the
    // outage clearly and letting the user retry.
    if (this.expectSfu) {
      const picked = await pickSfu(this.channelId).catch((err) => {
        console.warn('[voice] pickSfu threw at join', err);
        return null;
      });
      if (!picked) {
        this.joined = false;
        throw new Error(
          'No SFU is currently reachable for this channel. Ask the channel admin to verify the pinned SFU is online.',
        );
      }
      await this.enterSfuMode(picked.pubkey, picked);
      return;
    }

    await this.enterMeshMode();

    // Tab close / refresh: synchronous best-effort goodbye so the other
    // side learns within ~10 ms instead of waiting for the data-channel
    // heartbeat (7 s) or the relay-side beacon expiry (~30 s). Each
    // peer.close() inside leave() sends a control-channel bye
    // synchronously through the open data channel before pc.close() — the
    // bye reaches the remote even if the relay refuses our final kind 25050.
    this.unloadHandler = installBeforeUnloadHandler({
      onUnload: () => {
        this.metrics.peers.tornDownByUnload += this.peers.size;
        // leave() returns a Promise we can't await during unload; fire it
        // and let the synchronous portion (peer.close → control bye) run
        // before the page goes away.
        void this.leave().catch(() => {});
      },
    });
  }

  private async reserveMeshRelayCapacity(): Promise<void> {
    if (this.voiceRelayCapacityRelease) return;
    try {
      const bridge = await getBridge() as unknown as {
        reserveVoiceRelayCapacity?: (channelId: string) => () => void;
      };
      this.voiceRelayCapacityRelease = bridge.reserveVoiceRelayCapacity?.(this.channelId) ?? null;
    } catch {
      this.voiceRelayCapacityRelease = null;
    }
  }

  /**
   * Subscribe to roster + signaling, publish the first beacon, and start
   * the periodic beacon timer. Idempotent — re-running is a no-op when
   * mesh subs are already up. Used both at fresh join and as the SFU
   * fallback when `pickSfu` returns null or `SfuClient.start` throws.
   */
  private async enterMeshMode(): Promise<void> {
    if (this.signalsUnsub || this.rosterUnsub) return;

    await this.reserveMeshRelayCapacity();

    // Subscribe to incoming signaling first so we don't miss offers from
    // peers who learn about us via the beacon we're about to send.
    this.signalsUnsub = await this.transport.subscribeSignals(
      this.channelId,
      this.selfPubkey,
      (from, payload) => {
        this.metrics.signals.rcvd++;
        // Membership race — defer rather than silently drop. If `from`
        // becomes a member within DEFERRED_SIGNAL_TTL_MS (drained by
        // updateRoles), the queued payloads replay through routeSignal
        // and the call still forms. After the TTL expires the
        // membershipFinal counter increments and the signal is gone for
        // good. See Phase-1 diagnosis H2.
        if (!this.isMember(from)) {
          this.deferSignal(from, payload);
          return;
        }
        // WoT branch is now defense-in-depth: voice kinds are in
        // ALWAYS_ALLOW_KINDS so isAllowed() returns true unconditionally.
        // Counter remains so a regression in the allow-list surfaces
        // observably instead of silently breaking voice.
        if (!wotEngine.isAllowed(from, KIND_VOICE_SIGNAL)) {
          this.metrics.signalsDropped.wot++;
          pushVoiceDebug({ kind: 'signal-dropped', reason: 'wot', peer: from, payload });
          console.warn('[voice-drop] wot', from.slice(0, 8), payload?.type);
          return;
        }
        void this.routeSignal(from, payload);
      },
    );

    this.rosterUnsub = await this.transport.subscribeRoster(this.channelId, (roster) => {
      // Snapshot the live roster so the video-slot computation can see
      // every other peer's `videoTracks` claim alongside our own state.
      this.currentRoster = roster;
      // Refresh known-SFU set BEFORE the membership filter so SFU
      // beacons survive `isMember` even when the SFU isn't in the
      // channel's NIP-29 member list. Auto-trust is intentional —
      // operators shouldn't have to babysit the member list every
      // time they want to spin up an SFU.
      this.knownSfuPubkeys = new Set(roster.filter((r) => r.isSfu).map((r) => r.pubkey));
      const previousMeshTestPeers = this.knownMeshTestPeerPubkeys;
      this.knownMeshTestPeerPubkeys = new Set(roster.filter((r) => r.isMeshTestPeer).map((r) => r.pubkey));
      for (const pk of this.knownMeshTestPeerPubkeys) {
        if (previousMeshTestPeers.has(pk)) continue;
        const peer = this.peers.get(pk);
        if (peer?.polite) {
          // A passive active-call hint can open the peer before the roster
          // beacon reveals it as a mesh test peer. Rebuild so the browser
          // becomes the offer-driving side instead of staying polite forever.
          this.tearDownPeer(pk, true);
        }
      }
      // Mesh test peers are admitted by their roster beacon, not by NIP-29
      // role updates. Signals can arrive first because we subscribe to
      // signaling before roster, so replay any queued offers as soon as the
      // marker makes them a valid peer for allowed local callers.
      this.drainDeferredSignals();
      // Compute the transitive participant set first — including peers we
      // only know about from someone else's `connectedTo` p-tags — then
      // filter by membership and hand to handleRoster for cap+open logic.
      const allPubkeys = transitiveParticipants(roster);
      const filtered = allPubkeys.filter((pk) => this.isMember(pk));
      this.handleRoster(filtered);
      // Re-evaluate the video cap whenever the roster changes — a new
      // claim from a peer whose beacon arrived after ours could push us
      // outside the leading slice and require local eviction.
      this.enforceVideoSlotCap();
    });

    // The bridge's active-call detector is the same source that powers the
    // pre-join "people are in this call" UI. Subscribe from the mesh engine
    // too so discovery doesn't depend on the React room effect racing in
    // after join; the callback replays the current store value immediately.
    this.subscribeActiveCallStatus();

    // Wait for NIP-42 AUTH to complete on the active relay before the
    // first beacon publish. Without this, on slower relays the
    // bringup beacon at t=0 fires before the relay has finished
    // accepting our AUTH challenge — the publish gets rejected
    // (typically "auth-required") and is silently lost. The bridge
    // resolves immediately when AUTH was already complete, so this
    // is a no-op on the fast path. Always resolves; we record both
    // the wait and the timeout into observable counters.
    // Fire-and-forget AUTH wait: record into metrics if/when it resolves,
    // but never block the first beacon. The bring-up burst
    // (BEACON_BRINGUP_DELAYS_MS) covers the AUTH race even on slow relays,
    // and blocking here causes test environments without a real bridge
    // (or with fake timers) to hang.
    void (async () => {
      try {
        const bridge = await getBridge();
        if (bridge && typeof bridge.waitForRelayAuth === 'function') {
          const result = await bridge.waitForRelayAuth(5_000);
          this.metrics.relay.authWaited++;
          if (result !== 'ok') {
            this.metrics.relay.authTimedOut++;
          }
        }
      } catch {
        // best-effort
      }
    })();

    await this.publishBeacon();
    // Front-loaded burst — beacons are ephemeral so a peer whose relay
    // session was still completing NIP-42 AUTH on our first beacon needs
    // several more chances within the user's "is this stuck?" window
    // before we let the 15 s steady-state cadence take over.
    for (const delay of BEACON_BRINGUP_DELAYS_MS) {
      this.bringupTimers.push(
        setTimeout(() => { void this.publishBeacon().catch(() => {}); }, delay),
      );
    }
    this.beaconTimer = setInterval(() => {
      void this.publishBeacon().catch(() => {});
    }, BEACON_INTERVAL_MS);
  }

  /**
   * Tear down the mesh-mode subscriptions, timers, and any open `Peer`
   * instances. Safe to call when mesh isn't running. Used by the
   * mid-call mesh→SFU transition (`setExpectSfu(true)`).
   */
  private exitMeshMode(): void {
    if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
    if (this.beaconRefreshTimer) { clearTimeout(this.beaconRefreshTimer); this.beaconRefreshTimer = null; }
    for (const t of this.bringupTimers) clearTimeout(t);
    this.bringupTimers.length = 0;
    this.signalsUnsub?.(); this.signalsUnsub = null;
    this.rosterUnsub?.(); this.rosterUnsub = null;
    this.voiceRelayCapacityRelease?.(); this.voiceRelayCapacityRelease = null;
    this.currentRoster = [];
    this.knownMeshTestPeerPubkeys.clear();
    this.passiveParticipantHints.clear();
    this.seenRosterPubkeys.clear();
    this.discovery.reset();
    if (this.dialDebounceTimer) { clearTimeout(this.dialDebounceTimer); this.dialDebounceTimer = null; }
    if (this.controlSnapshotTimer) { clearTimeout(this.controlSnapshotTimer); this.controlSnapshotTimer = null; }
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.emitPeerConnectionStates();
    this.unsubscribeActiveCallStatus();
  }

  /**
   * Flip topology to SFU mode. Sets `sfuPubkey`, fires `onTopologyChange`,
   * and stands up the `SfuClient`. On `SfuClient.start()` failure, clears
   * SFU state and falls back to mesh — UI gets back-to-back
   * `onTopologyChange(sfu)` then `onTopologyChange(null)` so the badge
   * reflects the live state.
   */
  private async enterSfuMode(sfuPubkey: string, resolvedSfu?: SfuAdvertisement): Promise<void> {
    if (this.sfuPubkey === sfuPubkey && this.sfuClient) return;

    if (this.sfuClient) {
      // Await close so the prior client's `leave` RPC actually transmits
      // before we open a new connection; otherwise the SFU may still hold
      // our prior peer entry when our new SfuClient.start() races in,
      // double-fanning peerJoined notifications and producing roster
      // flicker.
      try { await this.sfuClient.close(); } catch { /* ignore */ }
      this.sfuClient = null;
    }
    // Drop any prior watcher — we're switching SFUs (or re-entering after
    // a closure-driven teardown). The new watcher arms after startSfuClient.
    this.unsubscribeActiveCallStatus();
    // Track the *intended* SFU pubkey so other paths (peer mute, echo
    // suppression) can reason about the topology — but do NOT fire
    // onTopologyChange yet. The UI badge interprets a non-null sfuPubkey
    // as "SFU connected"; firing here would lie for the entire RPC
    // handshake window and stay stuck on "connected" if the handshake
    // times out. startSfuClient handles its own failure cleanup
    // (clears sfuPubkey, fires onTopologyChange(null), surfaces onError,
    // re-throws). We only fire onTopologyChange(sfuPubkey) on success.
    this.sfuPubkey = sfuPubkey;
    await this.startSfuClient(sfuPubkey, resolvedSfu);
    // SfuClient is up — arm the kind 31314 watcher so we react fast when
    // the SFU room closes (graceful restart, watchdog auto-heal, 1h cap).
    this.subscribeActiveCallStatus();
    try { this.events.onTopologyChange?.(sfuPubkey); } catch (err) {
      console.warn('[voice] onTopologyChange handler threw', err);
    }
  }

  /**
   * Watch the bridge's `activeCallByChannel` state for our channel. The
   * SFU publishes kind 31314 status=closed when a room closes (graceful
   * shutdown, watchdog auto-heal, or hard duration cap); the bridge
   * deletes the entry on receipt. When that happens we fast-path the
   * recovery without waiting for the SFU beacon's TTL to expire.
   */
  private subscribeActiveCallStatus(): void {
    if (this.activeCallUnsub) return;
    this.activeCallSeen = false;
    // The bridge is async to obtain in some environments (tests, SSR);
    // resolve it in the background and bail if teardown happens first.
    let cancelled = false;
    const cancel = () => { cancelled = true; };
    // Stash a placeholder so a quick teardown-during-resolve still
    // produces an observable "unsubbed" state.
    this.activeCallUnsub = cancel;
    void (async () => {
      let b: Awaited<ReturnType<typeof getBridge>>;
      try { b = await getBridge(); } catch { return; }
      if (cancelled) return;
      const realUnsub = b.subscribeActiveCallByChannel((byChannel) => {
        const entry = byChannel[this.channelId];
        if (!this.sfuClient && !this.sfuPubkey) {
          if (entry?.mode === 'mesh') {
            this.setPassiveParticipantHints(entry.participantPubkeys ?? []);
          } else {
            this.setPassiveParticipantHints([]);
          }
        }
        if (entry && (entry.status === 'active' || entry.status === 'starting')) {
          this.activeCallSeen = true;
          return;
        }
        // Either status flipped away from active, or the bridge dropped
        // the entry on a status=closed event. Recover only if we've
        // previously seen an active entry — otherwise a snapshot that
        // lands before the SFU has published 31314 would trip a phantom
        // closure-recovery and we'd loop.
        if (!this.activeCallSeen) return;
        if (!this.sfuClient) return;
        console.warn('[voice] SFU room closed remotely — recovering');
        this.handleRemoteSfuClosure();
      });
      if (cancelled) {
        try { realUnsub(); } catch { /* ignore */ }
        return;
      }
      this.activeCallUnsub = realUnsub;
    })();
  }

  private unsubscribeActiveCallStatus(): void {
    try { this.activeCallUnsub?.(); } catch { /* ignore */ }
    this.activeCallUnsub = null;
    this.activeCallSeen = false;
  }

  /**
   * SFU told us (via kind 31314 status=closed) that the call ended. Tear
   * down the dead SfuClient and fire onTopologyChange(null) — the
   * supervisor effect in VoiceRoom.tsx (around the
   * `setSfuRepublishCounter` bump) responds by republishing `start`
   * with force=true, and the next roster tick re-enters SFU mode via
   * the regular enterSfuMode path.
   */
  private handleRemoteSfuClosure(): void {
    const client = this.sfuClient;
    this.sfuClient = null;
    this.sfuPubkey = null;
    // Drop the watcher — the next enterSfuMode will re-arm it. Leaving it
    // armed would re-fire on every subsequent empty snapshot until the
    // bridge sees a fresh active entry.
    this.unsubscribeActiveCallStatus();
    if (client) {
      // 0-budget close: the SFU is gone, so awaiting a leave RPC just
      // burns 500ms waiting for a timeout. Mirror the failSfuStart path.
      void client.close(0).catch(() => undefined);
    }
    try { this.events.onTopologyChange?.(null); } catch (err) {
      console.warn('[voice] onTopologyChange handler threw', err);
    }
  }

  async leave(): Promise<void> {
    if (!this.joined) return;
    const wasMeshMode = !!(this.signalsUnsub || this.rosterUnsub) && !this.sfuPubkey && !this.sfuClient;
    this.joined = false;
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
    }
    if (this.beaconRefreshTimer) {
      clearTimeout(this.beaconRefreshTimer);
      this.beaconRefreshTimer = null;
    }
    for (const t of this.bringupTimers) clearTimeout(t);
    this.bringupTimers.length = 0;
    if (this.deferredSweepTimer) {
      clearInterval(this.deferredSweepTimer);
      this.deferredSweepTimer = null;
    }
    this.deferredSignals.clear();
    this.seenRosterPubkeys.clear();
    this.discovery.reset();
    if (this.dialDebounceTimer) { clearTimeout(this.dialDebounceTimer); this.dialDebounceTimer = null; }
    if (this.controlSnapshotTimer) { clearTimeout(this.controlSnapshotTimer); this.controlSnapshotTimer = null; }
    if (this.unloadHandler) { this.unloadHandler.uninstall(); this.unloadHandler = null; }
    if (wasMeshMode) {
      try {
        await this.transport.publishLeavePresence(this.channelId);
        this.metrics.signals.byeViaRelay++;
      } catch (err) {
        console.warn('[voice] leave beacon failed', err);
      }
    }
    this.signalsUnsub?.();
    this.signalsUnsub = null;
    this.rosterUnsub?.();
    this.rosterUnsub = null;
    this.voiceRelayCapacityRelease?.();
    this.voiceRelayCapacityRelease = null;

    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.emitPeerConnectionStates();
    this.unsubscribeActiveCallStatus();
    if (this.sfuClient) {
      // Bounded await so the SFU sees our `leave` RPC before its
      // empty-grace timer / RTP reaper has to discover us via timeout.
      // Capped at ~500 ms so a slow relay can't deadlock channel
      // switches; DTLS close-notify on transport.close() is the
      // deterministic fallback past that budget.
      try { await this.sfuClient.close(); } catch { /* ignore */ }
      this.sfuClient = null;
    }
    this.sfuPubkey = null;
    this.rosterPubkeys = [];
    this.connectedPubkeys.clear();
    this.localVideoClaimedAt.clear();
    this.currentRoster = [];
    this.knownMeshTestPeerPubkeys.clear();
    this.passiveParticipantHints.clear();
    this.remoteTracks.clear();
    this.emitRemoteTracks();

    // Stop every speaking detector and clear the store entry so orbs go dark.
    for (const [pk, det] of this.speakingDetectors) {
      det.stop();
      try { useVoiceStore.getState().setSpeaking(pk, false); } catch { /* no store yet during tests */ }
    }
    this.speakingDetectors.clear();
    try { useVoiceStore.getState().clearLocalMutes(); } catch { /* test envs */ }

    this.stopTrack(this.micTrack); this.micTrack = null;
    this.stopTrack(this.camTrack); this.camTrack = null;
    this.stopTrack(this.screenTrack); this.screenTrack = null;
    this.stopTrack(this.screenAudioTrack); this.screenAudioTrack = null;
    this.emitLocal();
    this.events.onLeft?.();
  }

  // ── Beacon publishing ──────────────────────────────────────────────────

  /**
   * Known active mesh pubkeys from every source we currently trust:
   * connected PCs, relay beacons, control-channel snapshots, and active-call
   * hints. This set is what we gossip as `peer` tags and `peerSnapshot`
   * messages, so partially formed meshes can converge without re-advertising
   * stale PCs that never connected.
   */
  private meshKnownPubkeys(): string[] {
    const known = new Set<string>();
    for (const pk of this.connectedPubkeys) known.add(pk);
    for (const pk of this.discovery.effectivePeers()) known.add(pk);
    for (const pk of this.passiveParticipantHints) known.add(pk);
    known.delete(this.selfPubkey);
    return Array.from(known).filter((pk) => this.isMember(pk)).sort();
  }

  /**
   * Publish a presence beacon advertising our currently-connected peers,
   * our full known active peer set, and the outbound video tracks we're
   * sending. The connected list powers legacy transitive discovery; the
   * known-peer list lets other clients dial participants that we know about
   * but have not directly established yet. The video list lets every peer
   * compute the room-wide video count for separate camera and screen-share cap enforcement.
   *
   * Public so multi-client integration tests can drive each node's beacon
   * deterministically (the production cadence is timer-driven via
   * `BEACON_INTERVAL_MS` + opportunistic refresh on connection-state change
   * or local video toggle).
   */
  async publishBeacon(): Promise<void> {
    if (!this.joined || this.sfuPubkey || this.sfuClient) return;
    const videoTracks: VideoSlotKind[] = [];
    if (this.camTrack) videoTracks.push('camera');
    if (this.screenTrack) videoTracks.push('screen');
    try {
      await withRateLimitBackoff(
        () => this.transport.publishPresenceBeacon(this.channelId, [...this.connectedPubkeys], this.meshKnownPubkeys(), videoTracks),
        { metrics: this.metrics },
      );
      this.metrics.beacons.sent++;
      pushVoiceDebug({ kind: 'beacon-sent' });
    } catch (err) {
      this.metrics.relay.publishFail++;
      this.metrics.relay.lastError = err instanceof Error ? err.message : String(err);
      pushVoiceDebug({ kind: 'relay-error', payload: this.metrics.relay.lastError });
      throw err;
    }
  }

  /**
   * Schedule a beacon refresh after a short debounce. Called when our
   * connected-peer set changes so the propagation latency for transitive
   * discovery is one debounce window, not one full BEACON_INTERVAL_MS.
   */
  private scheduleBeaconRefresh(): void {
    if (!this.joined) return;
    if (this.beaconRefreshTimer) return;
    this.beaconRefreshTimer = setTimeout(() => {
      this.beaconRefreshTimer = null;
      if (!this.joined) return;
      void this.publishBeacon().catch(() => {});
    }, BEACON_REFRESH_DEBOUNCE_MS);
  }

  private scheduleControlPeerSnapshot(): void {
    if (!this.joined || this.sfuPubkey) return;
    if (this.controlSnapshotTimer) return;
    this.controlSnapshotTimer = setTimeout(() => {
      this.controlSnapshotTimer = null;
      if (!this.joined || this.sfuPubkey) return;
      this.broadcastControlPeerSnapshot();
    }, CONTROL_SNAPSHOT_DEBOUNCE_MS);
  }

  private broadcastControlPeerSnapshot(): void {
    const peers = this.meshKnownPubkeys();
    for (const peer of this.peers.values()) {
      peer.broadcastControl({ type: 'peerSnapshot', peers, ts: Date.now() });
    }
  }

  // ── Roster + peer management ───────────────────────────────────────────

  /**
   * Mesh-only roster handler. The SFU path bypasses this entirely — it
   * mirrors the SFU's pushed `participantList`/`peerJoined`/`peerLeft`
   * directly into `rosterPubkeys` from the `SfuClient.onPeersChange`
   * callback. Roster subscription is gated by `enterMeshMode`, so this
   * function can assume mesh mode.
   */
  private handleRoster(pubkeys: string[]) {
    const others = pubkeys.filter((p) => p !== this.selfPubkey);
    const beforeDiscoveryKey = this.discovery.effectivePeers().slice().sort().join('|');

    // Track relay-discovered set in the discovery engine so the dial-loop
    // sees the union of relay + control-channel sources. Increment the
    // attribution counter for any peer the relay just told us about that
    // we hadn't seen on the relay before.
    const previouslyRelay = new Set(others.filter((p) => this.discovery.source(p).relay));
    this.discovery.setRelayDiscovered(others);
    const afterDiscoveryKey = this.discovery.effectivePeers().slice().sort().join('|');
    let relayNew = 0;
    for (const p of others) {
      if (!previouslyRelay.has(p)) relayNew++;
    }
    this.metrics.transitive.discoveredViaRelay += relayNew;

    // First-sighting rebroadcast: if any pubkey in this snapshot is new to
    // us, schedule a beacon refresh so that peer learns about us within
    // ~250 ms instead of waiting up to a full BEACON_INTERVAL_MS for our
    // next periodic publish. The debounce coalesces a flurry of new peers
    // (e.g. cold-start where the first roster delivery contains the entire
    // room) into a single extra publish.
    let sawNew = false;
    for (const pk of others) {
      if (!this.seenRosterPubkeys.has(pk)) {
        this.seenRosterPubkeys.add(pk);
        sawNew = true;
      }
    }
    if (sawNew || beforeDiscoveryKey !== afterDiscoveryKey) {
      this.scheduleBeaconRefresh();
      this.scheduleControlPeerSnapshot();
    }

    this.runDialLoop();
  }

  private applyControlPeerSnapshot(remotePubkey: string, peers: readonly string[]): void {
    const filtered = peers
      .filter((pk) => pk && pk !== this.selfPubkey)
      .filter((pk) => this.isMember(pk));
    const { added, removed } = this.discovery.setControlDiscovered(remotePubkey, filtered);
    if (added.length === 0 && removed.length === 0) return;
    this.metrics.transitive.discoveredViaControl += added.length;
    this.scheduleDialFromDiscovery();
    this.scheduleBeaconRefresh();
    this.scheduleControlPeerSnapshot();
  }

  /**
   * Coalesce dial loops triggered by control-channel propagation arriving
   * in microtask order during a single hello / peerAdded burst. Without
   * the debounce a hello carrying N peers would spawn N PCs in microtask
   * order while we're still applying the previous offer. 100 ms is small
   * enough to feel instant, large enough to absorb the typical hello.
   */
  private scheduleDialFromDiscovery(): void {
    if (this.dialDebounceTimer) return;
    this.dialDebounceTimer = setTimeout(() => {
      this.dialDebounceTimer = null;
      this.runDialLoop();
    }, 100);
  }

  /**
   * Apply the current discovery set: cap, dial new peers, evict cap
   * violators. Called from `handleRoster` (relay-driven) and from
   * `scheduleDialFromDiscovery` (control-channel-driven). Idempotent.
   */
  private runDialLoop(): void {
    const others = Array.from(new Set([
      ...this.discovery.effectivePeers(),
      ...this.passiveParticipantHints,
    ]))
      .filter((p) => p !== this.selfPubkey)
      .filter((p) => this.isMember(p));

    // Hard cap: if more than MAX_PARTICIPANTS would be present and we're
    // not in the leading slice, deterministically (lex) trim the tail so
    // every client agrees on the same set of cap-violators.
    const visible = others.slice();
    if (visible.length + 1 > MAX_PARTICIPANTS) {
      visible.sort();
      visible.splice(MAX_PARTICIPANTS - 1);
    }
    const visibleSet = new Set(visible);

    // Peers that lost every discovery source and are not currently live
    // should disappear immediately. The old union kept all open Peer
    // objects forever, so a tab that closed before/after negotiation could
    // remain rendered until a refresh even after its beacon expired.
    for (const [pk, peer] of Array.from(this.peers.entries())) {
      if (visibleSet.has(pk)) continue;
      if (this.connectedPubkeys.has(pk) || peer.isControlOpen()) continue;
      this.tearDownPeer(pk);
    }

    // Union of discovered pubkeys + actually-live peers. Connected/control
    // peers stay visible across relay beacon gaps; non-live stale peers do
    // not.
    const union = new Set(visible);
    for (const [pk, peer] of this.peers.entries()) {
      if (this.connectedPubkeys.has(pk) || peer.isControlOpen()) union.add(pk);
    }
    this.rosterPubkeys = Array.from(union);
    this.events.onParticipantsChange?.([...this.rosterPubkeys]);

    for (const p of visible) {
      if (!this.peers.has(p)) this.openPeer(p);
    }
    // Cap-overflow eviction.
    if (this.peers.size + 1 > MAX_PARTICIPANTS) {
      const keep = new Set(Array.from(this.peers.keys()).sort().slice(0, MAX_PARTICIPANTS - 1));
      for (const pk of Array.from(this.peers.keys())) {
        if (!keep.has(pk)) this.tearDownPeer(pk);
      }
    }
  }

  /**
   * Tear down the active SFU client and drop SFU-attributed state. Used
   * by the SFU→mesh transition (`setExpectSfu(false)` mid-call, or fallback
   * after a failed `SfuClient.start`). Does NOT start mesh subscriptions
   * — caller decides whether to re-enter mesh.
   */
  private exitSfuMode(): void {
    const from = this.sfuPubkey;
    if (this.sfuClient) {
      // Topology pivot to mesh — fire-and-forget the close. We don't
      // need to await the leave RPC here because we're not opening a
      // new SFU connection; mesh peers are about to provide media via
      // a different path.
      void this.sfuClient.close().catch(() => undefined);
      this.sfuClient = null;
    }
    if (from) {
      // Drop SFU-attributed remote tracks so the next topology re-emits
      // fresh ones rather than orphaning them on a closed peer.
      for (const [trackId, t] of Array.from(this.remoteTracks.entries())) {
        if (t.viaPubkey === from) this.remoteTracks.delete(trackId);
      }
      this.emitRemoteTracks();
      this.connectedPubkeys.delete(from);
    }
    this.sfuPubkey = null;
    this.rosterPubkeys = [];
    this.events.onParticipantsChange?.([]);
  }

  /**
   * Stand up the mediasoup-client driver: open RPC, load Device, build
   * send/recv transports, then push every local track. On `start()`
   * failure, fall back to mesh — clearing SFU state, firing
   * `onTopologyChange(null)`, and entering mesh subscriptions.
   *
   * Caller (`enterSfuMode`) guarantees the previous client was torn down.
   */
  private async publishSfuStartOrThrow(sfuPubkey: string, controlRelays: readonly string[]): Promise<void> {
    const ok = await publishSfuStart(this.channelId, sfuPubkey, {
      trustedRelays: controlRelays,
      params: { video: true, screen: true, maxParticipants: 50 },
      force: true,
    });
    if (!ok) throw new Error('Could not publish SFU start control event.');
    await new Promise((resolve) => setTimeout(resolve, SFU_START_SETTLE_MS));
  }

  private isInitialSfuRpcTimeout(err: unknown): boolean {
    return err instanceof Error && err.message.includes('rpc timeout: getRouterRtpCapabilities');
  }

  private async failSfuStart(client: SfuClient, sfuPubkey: string, err: unknown): Promise<never> {
    console.warn('[voice] SfuClient.start failed', err);
    // start() failed — no live RPC subscription to gracefully close.
    // Use 0-budget close (skip the bounded await for the leave RPC),
    // since the SFU may not have registered a peer for us.
    try { await client.close(0); } catch { /* ignore */ }
    if (this.sfuClient === client) this.sfuClient = null;
    if (this.sfuPubkey === sfuPubkey) {
      this.sfuPubkey = null;
      try { this.events.onTopologyChange?.(null); } catch { /* ignore */ }
    }
    // SFU-pinned channels stay on SFU. Surface a clear error and stop —
    // mesh fallback would silently change the call's semantics (peer cap,
    // forwarding, recording capability) and the channel admin's pin is
    // an explicit choice we shouldn't override on a transient outage.
    const msg = err instanceof Error ? err.message : String(err);
    try { this.events.onError?.(`Could not connect to the SFU: ${msg}`); } catch { /* ignore */ }
    throw err;
  }

  private async startSfuClient(sfuPubkey: string, resolvedSfu?: SfuAdvertisement): Promise<void> {
    // Keep control and RPC relay roles separate. `trusted_relay` is the
    // authorization lane for kind 25052 start events; the SFU publishes
    // kind 25050 RPC responses on its writable/general `relay` set. Using
    // trusted-only relays for RPC makes browsers wait through rejected or
    // closed relays before landing on the relay where the SFU answered.
    //
    // Resolution order matches `pickSfu(channelId)`:
    //   1. per-channel pin (kind 30078)        — preferred
    //   2. NEXT_PUBLIC_SFU_TRUSTED_RELAYS env  — fallback for unconfigured channels
    const picked = resolvedSfu?.pubkey === sfuPubkey
      ? resolvedSfu
      : await pickSfu(this.channelId);
    let controlRelays: string[] = [];
    let rpcRelays: string[] = [];
    if (picked && picked.pubkey === sfuPubkey) {
      controlRelays = picked.trustedRelays.length > 0
        ? [...picked.trustedRelays]
        : [...picked.generalRelays];
      rpcRelays = picked.generalRelays.length > 0
        ? [...picked.generalRelays]
        : [...picked.trustedRelays];
    } else {
      const envControlRelays = (process.env.NEXT_PUBLIC_SFU_TRUSTED_RELAYS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const envRpcRelays = (process.env.NEXT_PUBLIC_SFU_RELAYS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      controlRelays = envControlRelays;
      rpcRelays = envRpcRelays.length > 0 ? envRpcRelays : envControlRelays;
    }
    const makeClient = (): SfuClient => new SfuClient({
      channelId: this.channelId,
      sfuPubkey,
      ...(picked?.url ? {
        sfuUrl: picked.url,
        onRelayFallback: () => this.publishSfuStartOrThrow(sfuPubkey, controlRelays),
      } : {}),
      selfPubkey: this.selfPubkey,
      ...(rpcRelays.length > 0 ? { trustedRelays: rpcRelays } : {}),
      events: {
        onRemoteTrack: (t: SfuRemoteTrack) => {
          if (this.deafened && (t.kind === 'audio' || t.kind === 'screen-audio')) {
            t.consumer.track.enabled = false;
          }
          const logicalPubkey = t.pubkey || sfuPubkey;
          this.remoteTracks.set(t.trackId, {
            pubkey: logicalPubkey,
            viaPubkey: sfuPubkey,
            trackId: t.trackId,
            kind: t.kind,
            stream: t.stream,
          });
          if (t.kind === 'audio') {
            this.attachSpeakingDetector(logicalPubkey, t.stream);
          }
          this.emitRemoteTracks();
        },
        onRemoteTrackEnded: (trackId) => {
          const removed = this.remoteTracks.get(trackId);
          this.remoteTracks.delete(trackId);
          if (removed?.kind === 'audio') {
            this.detachSpeakingDetector(removed.pubkey);
          }
          this.emitRemoteTracks();
        },
        onConnectionStateChange: (state) => {
          if (state === 'connected') {
            this.connectedPubkeys.add(sfuPubkey);
          } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            this.connectedPubkeys.delete(sfuPubkey);
          }
        },
        onPeersChange: (pubkeys) => {
          // SFU is the source of truth for the participant list in SFU
          // mode. Mirror it directly into the renderable roster — no
          // beacon discovery, no transitive merging.
          this.rosterPubkeys = [...pubkeys];
          try {
            this.events.onParticipantsChange?.([...pubkeys]);
          } catch (err) {
            console.warn('[voice] onParticipantsChange handler threw', err);
          }
        },
        onReliabilityEvent: (ev) => {
          // SFU consume-path reliability telemetry — see SfuClient for
          // when each kind fires. Mirrored into VoiceMetrics so the
          // ?debug=voice overlay shows a running tally and so the
          // playwright harness can assert on regressions.
          if (ev.kind === 'consume-retry') {
            this.metrics.sfuReliability.consumeRetries += 1;
          } else if (ev.kind === 'consume-failed') {
            this.metrics.sfuReliability.consumeFailed += 1;
          } else if (ev.kind === 'stale-consumer') {
            this.metrics.sfuReliability.staleConsumer += 1;
          }
          pushVoiceDebug({
            kind: 'sfu-reliability',
            reason: ev.kind,
            peer: ev.peerPubkey,
            payload: {
              producerId: ev.producerId,
              attempt: ev.attempt,
              code: ev.errorCode,
              msg: ev.errorMessage,
            },
          });
        },
      },
    });

    // Bootstrap loop. Direct RPC authenticates and opens the room itself.
    // Older SFUs fall back to the Nostr start + kind 25050 path; that path can
    // race room creation with its first RPC. The next-most-common failure is
    // "SFU process is restarting
    // after a watchdog auto-heal." Both are recoverable by reissuing
    // `start` (force=true, already inside publishSfuStartOrThrow) with a
    // fresh RPC client. Any non-timeout failure is treated as permanent —
    // those are typically auth, network, or allow-list rejections, which
    // retrying just lengthens the time before the user sees the error.
    let client: SfuClient | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < SFU_BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
      const delay = SFU_BOOTSTRAP_ATTEMPT_DELAYS_MS[attempt] ?? 0;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      client = makeClient();
      this.sfuClient = client;
      try {
        if (!picked?.url) await this.publishSfuStartOrThrow(sfuPubkey, controlRelays);
        await client.start();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!this.isInitialSfuRpcTimeout(err)) {
          return this.failSfuStart(client, sfuPubkey, err);
        }
        const next = attempt + 1;
        console.warn(`[voice] SFU bootstrap attempt ${next}/${SFU_BOOTSTRAP_MAX_ATTEMPTS} timed out — retrying`);
        try { await client.close(0); } catch { /* ignore */ }
        if (this.sfuClient === client) this.sfuClient = null;
        // Leave `client` pointing at the (now-closed) instance so the
        // post-loop failSfuStart on exhaustion has a real reference to
        // pass — recreating one just for the signature wastes resources
        // (and would surface a phantom Nth SfuClient instance in tests).
      }
    }
    if (lastErr) {
      // All attempts exhausted on the cold-start race. Surface as the
      // standard SFU-start failure so the UI's error toast + pinned-SFU
      // guarantees behave the same as a single-attempt failure used to.
      if (!client) {
        // Defensive: the loop must have run at least one attempt before
        // recording lastErr, so client should always be set.
        throw new Error('SFU bootstrap failed with no client reference');
      }
      return this.failSfuStart(client, sfuPubkey, lastErr);
    }
    if (!client) {
      // Defensive: the loop should always set `client` on success. Treat
      // an unset client as a logic bug rather than silently producing a
      // half-built state.
      throw new Error('SFU bootstrap loop exited without a client');
    }
    // Push existing local tracks to the new client.
    if (this.micTrack) await client.publishTrack('audio', this.micTrack).catch((e) => console.warn('[voice] publish mic threw', e));
    if (this.camTrack) await client.publishTrack('camera', this.camTrack).catch((e) => console.warn('[voice] publish cam threw', e));
    if (this.screenTrack) await client.publishTrack('screen', this.screenTrack).catch((e) => console.warn('[voice] publish screen threw', e));
    if (this.screenAudioTrack) await client.publishTrack('screen-audio', this.screenAudioTrack).catch((e) => console.warn('[voice] publish screen-audio threw', e));
  }

  private openPeer(remotePubkey: string) {
    // Defensive: after leave() the client should never spin up new peers.
    // Late-arriving rosters can otherwise trigger openPeer post-teardown
    // and the resulting RTCPeerConnection would never be cleaned up.
    if (!this.joined) return;
    if (this.peers.has(remotePubkey) || this.openingPeers.has(remotePubkey)) return;
    // SFU peer is handled by `SfuClient`/mediasoup-client, not by the mesh
    // simple-peer path. Don't construct a `Peer` for it.
    if (this.sfuPubkey && remotePubkey === this.sfuPubkey) return;
    // Lexicographic roles give exactly one simple-peer initiator per pair.
    // EXCEPTION — peers that are an SFU are ALWAYS treated as remote-impolite
    // (so we are polite). werift's SFU implementation cannot roll back its
    // own offer; if pubkey ordering happened to put the SFU on the polite
    // side, every renegotiation deadlocks with both sides dropping the
    // other's offer. Forcing the browser to be polite for SFU peers keeps
    // simple-peer initiator invariants while accommodating werift.
    const isSfuPeer = this.knownSfuPubkeys.has(remotePubkey);
    const isMeshTestPeer = this.knownMeshTestPeerPubkeys.has(remotePubkey);
    const polite = isSfuPeer ? true : isMeshTestPeer ? false : this.selfPubkey > remotePubkey;
    const shouldKickRecvOnly = this.shouldKickRecvOnlyOffer(remotePubkey, isSfuPeer, polite);
    console.log('[voice] openPeer', remotePubkey.slice(0, 8),
      'polite=', polite, isSfuPeer ? '(sfu)' : isMeshTestPeer ? '(mesh-test-peer)' : '');
    this.openingPeers.add(remotePubkey);
    let peer: Peer | null = null;
    try {
      const createdPeer = new Peer({
        remotePubkey,
        polite,
        sessionId: this.sessionId,
        bootstrapRecvOnlyMedia: shouldKickRecvOnly,
        send: (payload) => withRateLimitBackoff(
          () => this.transport.sendSignal(this.channelId, remotePubkey, payload),
          { metrics: this.metrics },
        ),
        // SFU peers don't speak our control-channel protocol — only mesh
        // peers get the obelisk-control data channel. The flag is the same
        // one we use to force polite negotiation for SFUs.
        control: isSfuPeer ? undefined : {
          selfBuild: SELF_BUILD_TAG,
          metrics: this.metrics,
          getCurrentPeers: () => this.meshKnownPubkeys(),
        },
        events: {
          onTransitivePeers: (peers, _build) => {
            this.applyControlPeerSnapshot(remotePubkey, peers);
          },
          onControlPeerSnapshot: (peers) => {
            this.applyControlPeerSnapshot(remotePubkey, peers);
          },
          onControlPeerAdded: (pubkey) => {
            if (pubkey === this.selfPubkey) return;
            if (this.discovery.addControlDiscovered(pubkey, remotePubkey)) {
              this.metrics.transitive.discoveredViaControl++;
              this.scheduleDialFromDiscovery();
              this.scheduleBeaconRefresh();
              this.scheduleControlPeerSnapshot();
            }
          },
          onControlPeerRemoved: (pubkey) => {
            if (this.discovery.removeControlDiscovered(pubkey, remotePubkey)) {
              this.scheduleDialFromDiscovery();
              this.scheduleBeaconRefresh();
              this.scheduleControlPeerSnapshot();
            }
          },
          onPeerDead: (reason) => {
            // Active capacity rejection — the remote is telling us the room
            // is full. Surface a clean error and leave; without this, our
            // repeated redial attempts would loop trying to re-dial them.
            if (reason === 'bye:room-full') {
              pushVoiceDebug({
                kind: 'pc-state',
                peer: remotePubkey,
                payload: { event: 'rejected-room-full' },
              });
              this.metrics.peers.tornDown++;
              try { this.events.onError?.('Room is full — try again when someone leaves.'); }
              catch (e) { console.warn('[voice] onError threw on room-full', e); }
              // Use a microtask so the current signal-routing call returns
              // before we dismantle our own state.
              queueMicrotask(() => { void this.leave().catch(() => {}); });
              return;
            }
            // FAST hangup — control channel detected the peer is gone. Route
            // through tearDownPeer (idempotent) so the rest of the cleanup
            // happens identically to the relay-bye / connectionState='closed'
            // paths. The bye-via-control split counter helps the diagnostic
            // overlay distinguish the source.
            if (reason.startsWith('bye:')) {
              this.metrics.signals.byeViaControl++;
            }
            this.metrics.peers.tornDown++;
            pushVoiceDebug({
              kind: 'pc-state',
              peer: remotePubkey,
              payload: { event: 'fast-hangup', reason },
            });
            // Remove anything this peer claimed transitively so we don't
            // keep re-dialing through them.
            this.discovery.dropClaimsFromPeer(remotePubkey);
            this.scheduleBeaconRefresh();
            this.scheduleControlPeerSnapshot();
            this.tearDownPeer(remotePubkey, !reason.startsWith('bye:'));
            if (!reason.startsWith('bye:')) this.scheduleDialFromDiscovery();
          },
          onRemoteTrack: (track, stream, kind, originPubkey) => {
            // Apply current deafen state to brand-new audio arrivals so a peer
            // who joins after we deafened doesn't suddenly become audible.
            if (this.deafened && (kind === 'audio' || kind === 'screen-audio')) {
              track.enabled = false;
            }
            // In SFU mode `originPubkey` differs from `remotePubkey` (the SFU
            // is the RTC peer; the participant who actually produced the
            // media is the origin). Tile mapping uses the origin so the
            // sound shows up on the right person's tile, not the SFU's.
            const logicalPubkey = originPubkey ?? remotePubkey;
            this.remoteTracks.set(track.id, {
              pubkey: logicalPubkey,
              viaPubkey: remotePubkey,
              trackId: track.id,
              kind,
              stream,
            });
            // Speaking detection keyed by origin so SFU mode lights up the
            // correct tile, not "the SFU is speaking" for everyone.
            if (kind === 'audio') {
              this.attachSpeakingDetector(logicalPubkey, stream);
            }
            this.emitRemoteTracks();
          },
          onRemoteTrackEnded: (trackId) => {
            const removed = this.remoteTracks.get(trackId);
            this.remoteTracks.delete(trackId);
            // If the ended track was the peer's mic, stop their detector so
            // the orb doesn't strobe on stale RMS readings post-disconnect.
            // Use the track's logical (origin) pubkey, not the RTC remote.
            if (removed?.kind === 'audio') {
              this.detachSpeakingDetector(removed.pubkey);
            }
            this.emitRemoteTracks();
          },
          onConnectionEstablished: () => {
            if (!this.connectedPubkeys.has(remotePubkey)) {
              this.metrics.peers.connected = this.connectedPubkeys.size + 1;
            }
            this.connectedPubkeys.add(remotePubkey);
            this.metrics.peers.ever++;
            pushVoiceDebug({ kind: 'pc-state', peer: remotePubkey, payload: 'connected' });
            this.scheduleBeaconRefresh();
            // Tell every OTHER mesh peer about this new connection so they
            // can transitively discover us through this one. The control
            // channel may not be open yet on this peer; that's fine — its
            // own `hello` will carry the up-to-date list when it opens.
            for (const [otherPk, otherPeer] of this.peers.entries()) {
              if (otherPk === remotePubkey) continue;
              otherPeer.broadcastControl({ type: 'peerAdded', pubkey: remotePubkey });
            }
            this.scheduleControlPeerSnapshot();
            this.emitPeerConnectionStates();
          },
          onConnectionLost: () => {
            if (this.connectedPubkeys.delete(remotePubkey)) {
              this.scheduleBeaconRefresh();
            }
            for (const [otherPk, otherPeer] of this.peers.entries()) {
              if (otherPk === remotePubkey) continue;
              otherPeer.broadcastControl({ type: 'peerRemoved', pubkey: remotePubkey });
            }
            this.scheduleControlPeerSnapshot();
            this.emitPeerConnectionStates();
            this.runDialLoop();
          },
          onQualitySample: (sample) => {
            try { useVoiceStore.getState().setPeerQuality(remotePubkey, sample); } catch { /* test envs */ }
          },
          onConnectionStateChange: (state) => {
            this.emitPeerConnectionStates();
            if (state === 'closed') {
              // Drop the peer so a future signal/beacon from the same pubkey
              // can spawn a fresh PC instead of routing into a dead one.
              // simple-peer owns ICE negotiation; a terminal close is the point
              // where discovery should create a fresh connection.
              const p = this.peers.get(remotePubkey);
              if (p && p === peer) {
                this.tearDownPeer(remotePubkey, true);
                this.scheduleDialFromDiscovery();
              }
            }
          },
        },
      });
      peer = createdPeer;
      this.peers.set(remotePubkey, createdPeer);
      this.emitPeerConnectionStates();
    } finally {
      this.openingPeers.delete(remotePubkey);
    }
    if (!peer) return;

    // Push existing local tracks to the new peer. Muted joins still need
    // recv-only media sections on at least one side of the pair; otherwise
    // a listener can see the roster/control state but have no audio/video
    // m-lines to receive a peer who was already publishing mic audio.
    // The impolite side drives that initial recv-only offer for ordinary
    // browser peers. Special peers can force it regardless of polarity.
    void this.attachAllLocalTracks(peer).then(() => {
      if (shouldKickRecvOnly || !polite) {
        void peer.kickInitialOffer();
      }
    });
  }

  private shouldKickRecvOnlyOffer(remotePubkey: string, isSfuPeer: boolean, polite: boolean): boolean {
    if (isSfuPeer) return true;
    if (this.knownMeshTestPeerPubkeys.has(remotePubkey)) return true;
    if (this.passiveParticipantHints.has(remotePubkey)) return true;
    if (polite) return false;
    const presence = this.currentRoster.find((p) => p.pubkey === remotePubkey);
    return (presence?.videoTracks?.length ?? 0) > 0;
  }

  /**
   * Tear down a peer connection and clean up every state map that referred
   * to it — speaking detector, remote tracks, connected set, store entry.
   * Single source of truth so we don't leak state on partial cleanup paths.
   *
   * Order matters: we delete from `this.peers` BEFORE calling `peer.close()`
   * because `pc.close()` fires `onconnectionstatechange('closed')`
   * synchronously, and the listener checks `this.peers.get(pubkey) === peer`
   * to decide whether to clean up. With the entry still in the map at that
   * moment, the listener would re-enter `tearDownPeer` and recurse.
   */
  private tearDownPeer(pubkey: string, preservePresence = false): void {
    const peer = this.peers.get(pubkey);
    const droppedClaims = this.discovery.dropClaimsFromPeer(pubkey);
    if (droppedClaims.length > 0) {
      this.scheduleBeaconRefresh();
      this.scheduleControlPeerSnapshot();
    }
    if (peer) {
      this.peers.delete(pubkey);
      // Internal connection rebuilds must not announce that the user left
      // the call. Their live kind-20078 beacon remains the presence source.
      peer.close({ notifyRemote: false });
      this.metrics.peers.tornDown++;
      pushVoiceDebug({ kind: 'peer-torn-down', peer: pubkey });
    }
    const nextRoster = preservePresence
      ? this.rosterPubkeys
      : this.rosterPubkeys.filter((pk) => pk !== pubkey);
    const rosterChanged = nextRoster.length !== this.rosterPubkeys.length;
    if (rosterChanged) {
      this.rosterPubkeys = nextRoster;
      this.events.onParticipantsChange?.([...this.rosterPubkeys]);
    }
    this.removeRemoteTracksFor(pubkey);
    this.detachSpeakingDetector(pubkey);
    if (this.connectedPubkeys.delete(pubkey)) {
      this.metrics.peers.connected = this.connectedPubkeys.size;
      this.scheduleBeaconRefresh();
    }
    if (peer || rosterChanged || droppedClaims.length > 0) {
      this.scheduleControlPeerSnapshot();
    }
    try { useVoiceStore.getState().clearPeerQuality(pubkey); } catch { /* test envs */ }
    this.emitPeerConnectionStates();
  }

  private async attachAllLocalTracks(peer: Peer) {
    if (this.micTrack) await peer.setLocalTrack('audio', this.micTrack);
    if (this.camTrack) await peer.setLocalTrack('camera', this.camTrack);
    if (this.screenTrack) await peer.setLocalTrack('screen', this.screenTrack);
    if (this.screenAudioTrack) await peer.setLocalTrack('screen-audio', this.screenAudioTrack);
    // Push the user-chosen outbound cap and our receive hint so a peer who
    // joins mid-call inherits the same quality contract as existing peers.
    let videoQuality: VideoQuality = 'auto';
    let receivedVideoQuality: VideoQuality = 'auto';
    try {
      const s = useVoiceStore.getState();
      videoQuality = s.videoQuality;
      receivedVideoQuality = s.receivedVideoQuality;
    } catch { /* test envs */ }
    const localPreset = getPreset(videoQuality);
    await peer.setLocalVideoCap({ maxBitrate: localPreset.maxBitrate, maxFramerate: localPreset.maxFramerate });
    if (receivedVideoQuality !== 'auto') {
      const inbound = getPreset(receivedVideoQuality);
      await peer.sendQualityHint(qualityHintFromPreset(inbound));
    }
  }

  /** User changed their outbound camera quality. Re-acquire the track at the
   *  new resolution and update encoder caps on every peer. */
  async applyVideoQuality(q: VideoQuality): Promise<void> {
    const preset = getPreset(q);
    const cap = { maxBitrate: preset.maxBitrate, maxFramerate: preset.maxFramerate };
    if (this.camTrack) {
      try {
        await this.camTrack.applyConstraints(preset.constraints);
      } catch (e) {
        console.warn('[voice] applyConstraints failed, will re-acquire', e);
      }
    }
    for (const peer of this.peers.values()) {
      await peer.setLocalVideoCap(cap);
    }
  }

  /** User changed their incoming-quality preference. Broadcast a qualityhint
   *  to every peer so they cap their outbound video to us. */
  async broadcastReceivedQuality(q: VideoQuality): Promise<void> {
    const preset = getPreset(q);
    const hint = qualityHintFromPreset(preset);
    for (const peer of this.peers.values()) {
      await peer.sendQualityHint(hint);
    }
  }

  private removeRemoteTracksFor(pubkey: string) {
    let changed = false;
    const droppedAudioOrigins = new Set<string>();
    // Match by `viaPubkey` (RTC remote) — when the SFU's PC drops, every
    // forwarded track must clear regardless of which origin it carried.
    // In mesh, viaPubkey === pubkey so the behavior is unchanged.
    for (const [id, t] of Array.from(this.remoteTracks.entries())) {
      if (t.viaPubkey === pubkey) {
        this.remoteTracks.delete(id);
        if (t.kind === 'audio') droppedAudioOrigins.add(t.pubkey);
        changed = true;
      }
    }
    // Stop speaking detectors for every origin whose audio just disappeared,
    // so the speaking orb on each affected tile clears immediately.
    for (const origin of droppedAudioOrigins) {
      this.detachSpeakingDetector(origin);
    }
    if (changed) this.emitRemoteTracks();
  }

  private async routeSignal(fromPubkey: string, payload: VoiceSignalPayload): Promise<void> {
    // SFU traffic flows through `SfuClient` (mediasoup-client + RPC), not
    // the mesh  adapter`Peer`. The legacy subscribeSignals
    // delivers everything on kind 25050 — including RPC responses /
    // notifications that have no `type` we recognize — so we drop those
    // here. Without this guard `peer.handleSignal(undefined!.handleSignal)`
    // throws TypeError on every RPC reply from the SFU.
    if (this.sfuPubkey && fromPubkey === this.sfuPubkey) {
      this.metrics.signalsDropped.sfuRouted++;
      pushVoiceDebug({ kind: 'signal-dropped', reason: 'sfu-routed', peer: fromPubkey });
      return;
    }
    // Defensively ignore unknown payload shapes (e.g. RPC envelopes from
    // a different peer that mistakenly addressed us).
    if (!payload || typeof payload.type !== 'string') {
      this.metrics.signalsDropped.unknownPayload++;
      pushVoiceDebug({ kind: 'signal-dropped', reason: 'unknown-payload', peer: fromPubkey });
      return;
    }
    if (payload.type !== 'peer' && payload.type !== 'offer' && payload.type !== 'answer'
      && payload.type !== 'ice' && payload.type !== 'bye'
      && payload.type !== 'trackinfo' && payload.type !== 'qualityhint'
      && payload.type !== 'requestReset') {
      this.metrics.signalsDropped.unknownPayload++;
      pushVoiceDebug({ kind: 'signal-dropped', reason: 'unknown-payload', peer: fromPubkey, payload });
      return;
    }
    // Active capacity rejection. If this signal is from a peer who's
    // outside the lex-leading MAX_PARTICIPANTS slice, refuse to open
    // a peer and send a `bye` with `byeReason: 'room-full'`. Every
    // existing peer makes the same lex calculation, so the rejected
    // joiner gets up to MAX_PARTICIPANTS independent byes and learns
    // immediately. Already-open peers (in this.peers) bypass this
    // check — they're members of the in-set by definition.
    if (!this.peers.has(fromPubkey) && !this.isWithinRoomCap(fromPubkey)) {
      void this.transport.sendSignal(this.channelId, fromPubkey, {
        type: 'bye',
        sessionId: this.sessionId,
        seq: 0,
        byeReason: 'room-full',
      }).catch(() => {});
      this.metrics.signalsDropped.unknownPayload++; // reuse counter — bumped only as "dropped at receiver"
      pushVoiceDebug({
        kind: 'signal-dropped',
        reason: 'unknown-payload',
        peer: fromPubkey,
        payload: { event: 'rejected-room-full' },
      });
      return;
    }
    let peer = this.peers.get(fromPubkey);
    if (!peer) {
      // Roster may not have caught up yet; create the peer eagerly so the
      // initial offer doesn't get dropped on join.
      this.openPeer(fromPubkey);
      peer = this.peers.get(fromPubkey);
      if (!peer) return; // openPeer skipped (e.g. !this.joined)
    }
    await peer.handleSignal(payload);
  }

  /**
   * True iff `pubkey` is in the lex-leading MAX_PARTICIPANTS slice of
   * (self + currently-known peers). Symmetric across the room — every
   * peer agrees on the same in/out partition without a coordinator.
   *
   * "Currently-known" = effective discovery set ∪ already-open peers ∪
   * self ∪ the candidate pubkey. Including the candidate matters: an
   * over-cap joiner who happens to be lex-leading should be
   * accepted, displacing the lex-trailing existing peer.
   */
  private isWithinRoomCap(pubkey: string): boolean {
    const candidates = new Set<string>(this.discovery.effectivePeers());
    for (const pk of this.peers.keys()) candidates.add(pk);
    candidates.add(this.selfPubkey);
    candidates.add(pubkey);
    const sorted = Array.from(candidates).sort();
    return sorted.indexOf(pubkey) < MAX_PARTICIPANTS;
  }

  // ── Speaking detection ─────────────────────────────────────────────────

  private attachSpeakingDetector(pubkey: string, stream: MediaStream): void {
    this.detachSpeakingDetector(pubkey);
    let detector: SpeakingDetector;
    try {
      detector = new SpeakingDetector(stream, (speaking) => {
        try { useVoiceStore.getState().setSpeaking(pubkey, speaking); } catch { /* test envs */ }
      });
    } catch (e) {
      // jsdom and a handful of older Safari builds don't expose AudioContext.
      // The call is voice-first, so we silently degrade (no speaking orb)
      // rather than tearing down the call.
      console.warn('[voice] speaking detector unavailable:', e);
      return;
    }
    this.speakingDetectors.set(pubkey, detector);
    detector.start();
  }

  private detachSpeakingDetector(pubkey: string): void {
    const det = this.speakingDetectors.get(pubkey);
    if (!det) return;
    det.stop();
    this.speakingDetectors.delete(pubkey);
    try { useVoiceStore.getState().setSpeaking(pubkey, false); } catch { /* test envs */ }
  }

  // ── Local-media controls ───────────────────────────────────────────────

  async setMicEnabled(on: boolean): Promise<void> {
    if (on && !this.micTrack) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: MIC_CONSTRAINTS,
      });
      this.micTrack = stream.getAudioTracks()[0] ?? null;
      if (this.micTrack) {
        // Local speaking detector — drives the viewer's own orb without a
        // round-trip through remote peers. Detector reads via AnalyserNode
        // only (never connects to destination), so playback stays purely
        // on the outbound sender.
        this.attachSpeakingDetector(this.selfPubkey, new MediaStream([this.micTrack]));
        for (const peer of this.peers.values()) await peer.setLocalTrack('audio', this.micTrack);
        if (this.sfuClient) await this.sfuClient.publishTrack('audio', this.micTrack).catch((e) => console.warn('[voice] sfu publish mic threw', e));
      }
    } else if (!on && this.micTrack) {
      // Stop the local detector so the orb goes dark immediately.
      this.detachSpeakingDetector(this.selfPubkey);
      for (const peer of this.peers.values()) await peer.setLocalTrack('audio', null);
      if (this.sfuClient) await this.sfuClient.unpublishTrack('audio').catch(() => undefined);
      this.stopTrack(this.micTrack);
      this.micTrack = null;
    }
    this.emitLocal();
  }

  async setCameraEnabled(on: boolean): Promise<void> {
    console.log('[voice] setCameraEnabled', on, 'peers=', this.peers.size);
    if (on && !this.camTrack) {
      // Room-wide video-slot cap: refuse early if every slot is already
      // claimed. Race-overflow (two peers claim simultaneously) is
      // resolved by `enforceVideoSlotCap` once beacons round-trip.
      if (!this.canClaimVideoSlot('camera')) {
        const err = new Error('Camera limit reached (4/4). Ask someone to turn off their camera.');
        try { useVoiceStore.getState().setError(err.message); } catch { /* test envs */ }
        throw err;
      }
      let quality: VideoQuality = 'auto';
      try { quality = useVoiceStore.getState().videoQuality; } catch { /* test envs */ }
      const preset = getPreset(quality);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { ...preset.constraints, facingMode: this.cameraFacing },
      });
      this.camTrack = stream.getVideoTracks()[0] ?? null;
      console.log('[voice] camera acquired, track=', this.camTrack?.id, 'quality=', quality);
      if (this.camTrack) {
        // Bias the encoder toward smooth motion (faces, gestures) over
        // peak per-frame resolution. Browsers honor this when picking
        // between motion-vector vs intra-frame compression strategies.
        try { (this.camTrack as MediaStreamTrack).contentHint = 'motion'; } catch { /* older browsers */ }
        // Claim the slot immediately so a flurry of remote beacons doesn't
        // bounce us out before our own beacon publishes.
        this.localVideoClaimedAt.set('camera', Math.floor(Date.now() / 1000));
        const cap = { maxBitrate: preset.maxBitrate, maxFramerate: preset.maxFramerate };
        for (const peer of this.peers.values()) {
          await peer.setLocalTrack('camera', this.camTrack);
          await peer.setLocalVideoCap(cap);
        }
        if (this.sfuClient) await this.sfuClient.publishTrack('camera', this.camTrack).catch((e) => console.warn('[voice] sfu publish camera threw', e));
        // Republish beacon ASAP so other peers see our claim and don't
        // race past us.
        this.scheduleBeaconRefresh();
      }
    } else if (!on && this.camTrack) {
      for (const peer of this.peers.values()) await peer.setLocalTrack('camera', null);
      if (this.sfuClient) await this.sfuClient.unpublishTrack('camera').catch(() => undefined);
      this.stopTrack(this.camTrack);
      this.camTrack = null;
      if (this.localVideoClaimedAt.delete('camera')) {
        this.scheduleBeaconRefresh();
      }
    }
    this.emitLocal();
  }

  /**
   * Flip between front ('user') and back ('environment') cameras on devices
   * that have both. No-op when the camera isn't currently on. Replaces the
   * local track in place on every mesh peer and on the SFU producer, so
   * remote viewers see the swap without renegotiation churn beyond the
   * `replaceTrack` call.
   */
  async switchCamera(): Promise<void> {
    if (!this.camTrack) return;
    const next: 'user' | 'environment' = this.cameraFacing === 'user' ? 'environment' : 'user';
    let quality: VideoQuality = 'auto';
    try { quality = useVoiceStore.getState().videoQuality; } catch { /* test envs */ }
    const preset = getPreset(quality);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...preset.constraints, facingMode: { exact: next } },
      });
    } catch {
      // Some devices reject `exact` even when both cameras exist — retry
      // with a soft `ideal` hint before giving up.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...preset.constraints, facingMode: next },
      });
    }
    const newTrack = stream.getVideoTracks()[0] ?? null;
    if (!newTrack) return;
    try { (newTrack as MediaStreamTrack).contentHint = 'motion'; } catch { /* older browsers */ }
    const oldTrack = this.camTrack;
    this.camTrack = newTrack;
    this.cameraFacing = next;
    for (const peer of this.peers.values()) await peer.setLocalTrack('camera', newTrack);
    if (this.sfuClient) {
      await this.sfuClient.publishTrack('camera', newTrack).catch((e) => console.warn('[voice] sfu replace camera threw', e));
    }
    this.stopTrack(oldTrack);
    this.emitLocal();
  }

  getCameraFacing(): 'user' | 'environment' {
    return this.cameraFacing;
  }

  async setScreenShareEnabled(on: boolean): Promise<void> {
    if (on && !this.screenTrack) {
      // Same room-wide video-slot cap as camera; screen-share counts as
      // one slot regardless of whether screen-audio is attached.
      if (!this.canClaimVideoSlot('screen')) {
        const err = new Error('A screen is already being shared. Only one screen share is allowed.');
        try { useVoiceStore.getState().setError(err.message); } catch { /* test envs */ }
        throw err;
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
      this.screenTrack = stream.getVideoTracks()[0] ?? null;
      this.screenAudioTrack = stream.getAudioTracks()[0] ?? null;
      if (this.screenTrack) {
        // Screen-share is text-heavy: tell the encoder to preserve detail
        // (sharp glyphs) rather than smoothness. Pairs with the
        // 'maintain-resolution' degradationPreference set in peer.ts.
        try { (this.screenTrack as MediaStreamTrack).contentHint = 'detail'; } catch { /* older browsers */ }
        this.localVideoClaimedAt.set('screen', Math.floor(Date.now() / 1000));
        for (const peer of this.peers.values()) await peer.setLocalTrack('screen', this.screenTrack);
        if (this.sfuClient) await this.sfuClient.publishTrack('screen', this.screenTrack).catch((e) => console.warn('[voice] sfu publish screen threw', e));
      }
      if (this.screenAudioTrack) {
        // Music / system audio — let Opus encode at full quality, no AGC.
        try { (this.screenAudioTrack as MediaStreamTrack).contentHint = 'music'; } catch { /* older browsers */ }
        for (const peer of this.peers.values()) await peer.setLocalTrack('screen-audio', this.screenAudioTrack);
        if (this.sfuClient) await this.sfuClient.publishTrack('screen-audio', this.screenAudioTrack).catch((e) => console.warn('[voice] sfu publish screen-audio threw', e));
      }
      // Browser-driven stop ("Stop sharing" toolbar button) — clean up.
      if (this.screenTrack) {
        this.screenTrack.onended = () => { void this.setScreenShareEnabled(false); };
      }
      this.scheduleBeaconRefresh();
    } else if (!on) {
      if (this.screenTrack) {
        for (const peer of this.peers.values()) await peer.setLocalTrack('screen', null);
        if (this.sfuClient) await this.sfuClient.unpublishTrack('screen').catch(() => undefined);
        this.stopTrack(this.screenTrack);
        this.screenTrack = null;
      }
      if (this.screenAudioTrack) {
        for (const peer of this.peers.values()) await peer.setLocalTrack('screen-audio', null);
        if (this.sfuClient) await this.sfuClient.unpublishTrack('screen-audio').catch(() => undefined);
        this.stopTrack(this.screenAudioTrack);
        this.screenAudioTrack = null;
      }
      if (this.localVideoClaimedAt.delete('screen')) {
        this.scheduleBeaconRefresh();
      }
    }
    this.emitLocal();
  }

  getLocalTracks(): { mic: MediaStreamTrack | null; camera: MediaStreamTrack | null; screen: MediaStreamTrack | null } {
    return { mic: this.micTrack, camera: this.camTrack, screen: this.screenTrack };
  }

  /**
   * Silence all incoming audio. Doesn't affect what we publish — peers still
   * hear us if our mic is on. Implemented by disabling the receive side of
   * each remote audio track; new arrivals inherit the flag in `onRemoteTrack`.
   */
  setDeafenEnabled(on: boolean): void {
    this.deafened = on;
    for (const t of this.remoteTracks.values()) {
      if (t.kind === 'audio' || t.kind === 'screen-audio') {
        for (const track of t.stream.getAudioTracks()) track.enabled = !on;
      }
    }
  }

  isDeafened(): boolean {
    return this.deafened;
  }

  // ── Video-slot cap (room-wide) ─────────────────────────────────────────

  /**
   * Build the flattened list of every video track currently in the room
   * — local + remote — sorted by `(claimedAt asc, pubkey asc)` so any two
   * clients computing this list independently agree on the leading slice.
   *
   * For remote tracks, `claimedAt` is the publisher's beacon `createdAt`.
   * For local tracks, `claimedAt` is the wall-clock second we acquired
   * the track. They share the same units (relay seconds), so the order
   * is consistent across publishers.
   */
  private buildVideoSlotList(): { pubkey: string; kind: VideoSlotKind; claimedAt: number }[] {
    const list: { pubkey: string; kind: VideoSlotKind; claimedAt: number }[] = [];
    // Remote claims from beacons (excluding self — we use our own track
    // state, not the beacon we published, to avoid a stale beacon claim
    // outliving a track we just stopped).
    for (const presence of this.currentRoster) {
      if (presence.pubkey === this.selfPubkey) continue;
      for (const kind of presence.videoTracks) {
        list.push({ pubkey: presence.pubkey, kind, claimedAt: presence.createdAt });
      }
    }
    // Local claims.
    for (const [kind, claimedAt] of this.localVideoClaimedAt.entries()) {
      list.push({ pubkey: this.selfPubkey, kind, claimedAt });
    }
    list.sort((a, b) => {
      if (a.claimedAt !== b.claimedAt) return a.claimedAt - b.claimedAt;
      if (a.pubkey !== b.pubkey) return a.pubkey < b.pubkey ? -1 : 1;
      // Same publisher claiming both kinds: 'camera' before 'screen' is
      // arbitrary but deterministic.
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      return 0;
    });
    return list;
  }

  /**
   * Number of video slots currently in use across the room.
   * UI exposes this so the camera/screen buttons can disable when full.
   */
  getVideoSlotsInUse(): number {
    return Math.min(
      this.buildVideoSlotList().filter((slot) => slot.kind === 'camera').length,
      MAX_CAMERAS,
    );
  }

  getVideoSlotsAvailable(): number {
    return Math.max(0, MAX_CAMERAS - this.getVideoSlotsInUse());
  }

  private canClaimVideoSlot(kind: VideoSlotKind): boolean {
    const limit = kind === 'camera' ? MAX_CAMERAS : MAX_SCREEN_SHARES;
    return this.buildVideoSlotList().filter((slot) => slot.kind === kind).length < limit;
  }

  /**
   * Re-check the cap against the latest roster. If our local video is
   * outside the leading per-kind cap, evict it (mirrors the
   * audio-mesh cap-overflow logic in `handleRoster`). Triggered on every
   * roster update, so a remote claim that landed before ours pushes us
   * out within one beacon hop.
   */
  private enforceVideoSlotCap(): void {
    if (this.localVideoClaimedAt.size === 0) return;
    const list = this.buildVideoSlotList();
    const winners = [
      ...list.filter((slot) => slot.kind === 'camera').slice(0, MAX_CAMERAS),
      ...list.filter((slot) => slot.kind === 'screen').slice(0, MAX_SCREEN_SHARES),
    ];
    if (winners.length === list.length) return;
    const winnerSet = new Set(winners.map((winner) => winner.pubkey + ':' + winner.kind));
    // For each of OUR local tracks, evict the ones that didn't make it
    // into the leading slice. Don't await — the toggle is fire-and-forget;
    // any lingering peers will see the next beacon refresh announcing the
    // dropped track.
    for (const kind of Array.from(this.localVideoClaimedAt.keys())) {
      const ourKey = this.selfPubkey + ':' + kind;
      if (winnerSet.has(ourKey)) continue;
      console.warn('[voice] video-slot evicted locally:', kind, '— another peer claimed it earlier');
      if (kind === 'camera') {
        void this.setCameraEnabled(false);
      } else {
        void this.setScreenShareEnabled(false);
      }
      try { useVoiceStore.getState().setError(kind === 'camera'
        ? 'Camera limit reached — your camera was disabled.'
        : 'Another screen share won the room slot — your screen share was stopped.'); } catch { /* test envs */ }
    }
  }

  /**
   * Toggle local-only mute for a single peer. Shorthand around the voice
   * store entry — VoiceRoom binds `<audio>.muted` to the same flag, so the
   * UI applies it automatically. No Nostr traffic; purely local.
   */
  setPeerMuted(pubkey: string, muted: boolean): void {
    try {
      const s = useVoiceStore.getState();
      if (muted) s.muteLocally(pubkey);
      else s.unmuteLocally(pubkey);
    } catch { /* test envs */ }
  }

  /** Test/debug helper — exposes the connected-peer set used to populate
   *  the next beacon's `connectedTo` p-tags. */
  getConnectedPubkeys(): string[] {
    return Array.from(this.connectedPubkeys);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private emitPeerConnectionStates() {
    this.events.onPeerConnectionStatesChange?.(this.getPeerConnectionStates());
  }

  private emitRemoteTracks() {
    const arr = Array.from(this.remoteTracks.values());
    this.events.onRemoteTracksChange?.(arr);
    for (const cb of this.remoteTracksListeners) {
      try { cb(arr); } catch { /* swallow */ }
    }
  }

  private emitLocal() {
    const local = {
      mic: !!this.micTrack,
      camera: !!this.camTrack,
      screen: !!this.screenTrack,
    };
    // Mirror to the global voice store so VoiceStatusBar (and any other
    // surface that reads from the store) stays accurate even when the
    // room component is unmounted — e.g. while the user is viewing a
    // text channel during an active call. The room's events handler is
    // a UI-only superset; it gets the same payload via the call below.
    try {
      const s = useVoiceStore.getState();
      s.setMuted(!local.mic);
      s.setCameraOn(local.camera);
      s.setScreenSharing(local.screen);
    } catch { /* test envs without zustand provider */ }
    this.events.onLocalTracksChange?.(local);
  }

  private stopTrack(t: MediaStreamTrack | null) {
    if (!t) return;
    try { t.stop(); } catch { /* ignore */ }
  }
}

function qualityHintFromPreset(preset: { maxBitrate: number | null; maxFramerate: number; maxHeight: number | null }): VoiceQualityHint {
  return {
    maxHeight: preset.maxHeight,
    maxFramerate: preset.maxFramerate,
    maxBitrate: preset.maxBitrate,
  };
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Test/diagnostic surface — exposes the VoiceClient constructor on window
// so the Playwright voice harness can drive a real mesh peer without
// instantiating the VoiceRoom UI (which has its own membership-gate UX
// that depends on real NIP-29 group metadata being present on the relay).
// Production code never reads from this; UI components import VoiceClient
// directly via the module graph.
if (typeof window !== 'undefined') {
  (window as unknown as { __obeliskVoiceClient?: typeof VoiceClient }).__obeliskVoiceClient = VoiceClient;
}
