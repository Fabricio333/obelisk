/**
 * Browser-side mediasoup client for SFU mode.
 *
 * Replaces the werift-era `Peer` for the SFU peer slot in `VoiceClient`.
 * Mesh peers continue to use the existing perfect-negotiation `Peer` class.
 *
 * Lifecycle:
 *   1. `start()`        — open RPC, load mediasoup Device with router caps
 *   2. `createTransports()` — build send + recv WebRtcTransports via RPC
 *   3. `publishTrack()` — turn a local MediaStreamTrack into a Producer
 *   4. (notifications) — `newProducer` from server triggers `consume()`
 *      which mints a Consumer and surfaces its track via `onRemoteTrack`
 *   5. `close()`        — close transports, close RPC
 *
 * `appData.kind` carries the voice-level kind (`camera` / `screen` / etc.)
 * so the receiving client can put the track in the right tile slot. The
 * server passes it through unchanged on consumers, so origin attribution
 * survives the SFU hop without any custom signaling we'd have to invent.
 */
import { Device } from 'mediasoup-client';
import type {
  AppData,
  Consumer,
  DtlsParameters,
  Producer,
  RtpCapabilities,
  RtpParameters,
  Transport,
} from 'mediasoup-client/types';

import { SfuRpc } from './sfu-rpc';
import type { RpcNotification } from './sfu-rpc';
import type { VoiceTrackKind } from './types';
import { ICE_SERVERS } from './ice-config';


export interface SfuRemoteTrack {
  /** Origin pubkey (the *producer's* author, not the SFU). */
  pubkey: string;
  trackId: string;
  kind: VoiceTrackKind;
  stream: MediaStream;
  consumer: Consumer;
}

/**
 * Reliability-layer telemetry. Surfaced through `onReliabilityEvent` so
 * `VoiceClient` can roll up counters into `VoiceMetrics` and the
 * `?debug=voice` overlay can show them in the field. Emitted on three
 * distinct conditions:
 *
 *   `consume-retry`  — a transient failure (RPC timeout, NO_PEER, …) was
 *                      caught and another attempt is scheduled. `attempt`
 *                      is the number of attempts made so far (1-indexed).
 *   `consume-failed` — gave up on this producer after the backoff ladder
 *                      was exhausted or a permanent error code (e.g.
 *                      `CANNOT_CONSUME`) was returned. The track will
 *                      not appear without a fresh `newProducer` event.
 *   `stale-consumer` — a consumer's `bytesReceived` hasn't moved for
 *                      `STALE_TIMEOUT_MS` despite the consumer being
 *                      live and unpaused — wedged. The consumer is torn
 *                      down and a fresh `consume` is requeued.
 */
export interface SfuReliabilityEvent {
  kind: 'consume-retry' | 'consume-failed' | 'stale-consumer';
  producerId: string;
  peerPubkey?: string;
  attempt?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SfuClientEvents {
  onRemoteTrack(track: SfuRemoteTrack): void;
  onRemoteTrackEnded(trackId: string): void;
  onConnectionStateChange?(state: string): void;
  /**
   * Fires whenever the SFU-tracked participant set changes. The SFU pushes
   * `peerJoined`, `peerLeft`, and an initial `participantList` snapshot
   * over kind 25050 RPC notifications; this client maintains the union and
   * emits the deduped pubkey list. The local user is NOT included.
   *
   * Replaces the kind 20078 beacon-driven roster in SFU mode — the SFU is
   * the authoritative source for who's actually wired up to the room.
   */
  onPeersChange?(pubkeys: string[]): void;
  /**
   * Reliability-layer telemetry — see `SfuReliabilityEvent` for the kinds
   * and when they fire. Optional; if not wired the events are silent.
   */
  onReliabilityEvent?(ev: SfuReliabilityEvent): void;
}

/**
 * Backoff ladder for `consume` / `resumeConsumer` retries. 4 attempts
 * spread over ~16 s (500 ms, 1.5 s, 4 s, 10 s). Mirrors the shape of
 * `peer.ts:RECONNECT_DELAYS_MS` so steady-state recovery has a similar
 * envelope across mesh and SFU modes. Pre-fix every transient failure
 * was logged-and-forgotten — a single dropped `consume` RPC would
 * silently strand a remote track until the user left and rejoined.
 */
export const CONSUME_RETRY_DELAYS_MS = [500, 1500, 4000, 10000] as const;

/** How often the stale-consumer watchdog polls `consumer.getStats()`. */
export const STALE_CHECK_INTERVAL_MS = 5_000;
/**
 * A non-paused consumer whose `bytesReceived` has been frozen for this
 * long is treated as wedged: we close it and re-issue `consume`. 12 s
 * comfortably outlasts a normal jitter pause and the warm-up grace
 * window below, while still recovering well before the user notices.
 */
export const STALE_TIMEOUT_MS = 12_000;
/**
 * After `consume` succeeds the consumer needs ICE to nominate, DTLS to
 * finish, and the first keyframe to arrive — typically <1 s but can be
 * longer on lossy links. Skip the staleness check for this many ms
 * after the consumer is first surfaced so warm-up isn't misdiagnosed.
 */
export const STALE_WARMUP_MS = 3_000;
const STARTUP_RPC_RETRY = { attempts: 4, timeoutMs: 1800, retryDelayMs: 75 } as const;
const CONNECT_RPC_RETRY = { attempts: 3, timeoutMs: 2000, retryDelayMs: 75 } as const;

interface ProducerAppData {
  kind?: VoiceTrackKind;
  originPubkey?: string;
}

interface PendingConsume {
  producerId: string;
  appData: ProducerAppData | null;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * If `consume` succeeded but `resumeConsumer` failed, the Consumer
   * object is reusable — only the resume RPC needs to be retried. We
   * stash it here so the next attempt skips a wasted `consume` round
   * trip. Cleared on permanent error or when we tear the entry down.
   */
  consumer: Consumer | null;
  /** Cached pubkey for telemetry; appData.originPubkey if present. */
  peerPubkey: string;
}

interface ConsumerHealth {
  producerId: string;
  appData: ProducerAppData | null;
  createdAt: number;
  lastBytesReceived: number;
  lastProgressAt: number;
}

type SfuRpcTransport = Pick<SfuRpc, 'start' | 'close' | 'request' | 'requestWithRetry'>;

export class SfuClient {
  private readonly rpc: SfuRpcTransport;
  private readonly events: SfuClientEvents;
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;

  /** voice-kind → Producer, so `setLocalTrack` can replace cleanly. */
  private producers = new Map<VoiceTrackKind, Producer>();

  /** producerId → SfuRemoteTrack — for clean teardown when the SFU
   * notifies us via `producerClosed`. */
  private remoteByProducerId = new Map<string, SfuRemoteTrack>();

  /**
   * Producers we've seen but haven't yet consumed because the recvTransport
   * isn't ready. Once `createTransports()` finishes we drain this queue.
   */
  private pendingProducers: Array<{ producerId: string; appData: ProducerAppData | null; kind: 'audio' | 'video' }> = [];

  /**
   * In-flight + scheduled consume attempts, keyed by producerId. An entry
   * exists from the moment we first try to consume a producer until the
   * track is surfaced (success) or we give up (permanent error / ladder
   * exhausted). Duplicate `newProducer` notifications collapse onto the
   * same entry, and `producerClosed` / `peerLeft` cancel the timer so
   * we don't keep retrying a producer the SFU has already torn down.
   */
  private pendingConsumes = new Map<string, PendingConsume>();

  /**
   * Per-consumer RTP-flow tracking for the stale watchdog. We compare
   * the latest `inbound-rtp.bytesReceived` snapshot against the last
   * one we saw; if it doesn't move for STALE_TIMEOUT_MS we consider
   * the consumer wedged and rebuild it.
   */
  private consumerHealth = new Map<string, ConsumerHealth>();
  private staleWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * SFU-pushed roster of OTHER participants (self excluded). Maintained by
   * `participantList` (replaces wholesale), `peerJoined` (adds), `peerLeft`
   * (removes). Surfaced via `events.onPeersChange` on every mutation.
   */
  private peers = new Set<string>();

  private closed = false;

  constructor(opts: {
    channelId: string;
    sfuPubkey: string;
    selfPubkey: string;
    events: SfuClientEvents;
    /** Trusted-author relays the SFU listens on. Outbound RPC envelopes
     *  must publish here, not the dex's default relays. */
    trustedRelays?: readonly string[];
  }) {
    this.events = opts.events;
    this.rpc = new SfuRpc({
      channelId: opts.channelId,
      sfuPubkey: opts.sfuPubkey,
      selfPubkey: opts.selfPubkey,
      onNotification: (n) => this.handleNotification(n),
      ...(opts.trustedRelays && opts.trustedRelays.length > 0
        ? { publishRelays: opts.trustedRelays }
        : {}),
    });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('SfuClient closed');
    await this.rpc.start();
    if (this.closed) return;
    const caps = await this.rpc.requestWithRetry<RtpCapabilities>(
      'getRouterRtpCapabilities',
      undefined,
      STARTUP_RPC_RETRY,
    );
    if (this.closed) return;
    const device = new Device();
    await device.load({ routerRtpCapabilities: caps });
    if (this.closed) return;
    this.device = device;
    await this.createTransports();
  }

  /** Publish a local track. `kind` is the voice-level slot, not the raw
   * media kind — `produce()` resolves that for us. */
  async publishTrack(kind: VoiceTrackKind, track: MediaStreamTrack): Promise<void> {
    if (this.closed) return;
    const sendTransport = this.sendTransport;
    if (!sendTransport) throw new Error('sendTransport not ready');

    // Replace if we already have one of this voice-kind — clients flip
    // camera → screen all the time and we don't want to leak Producers.
    const existing = this.producers.get(kind);
    if (existing) {
      if (!existing.closed) {
        try { await existing.replaceTrack({ track }); return; }
        catch { /* fall through and re-produce */ }
      }
      try { existing.close(); } catch { /* ignore */ }
      this.producers.delete(kind);
    }
    const producer = await sendTransport.produce({
      track,
      appData: { kind } as AppData,
    });
    if (this.closed) {
      try { producer.close(); } catch { /* ignore */ }
      return;
    }
    this.producers.set(kind, producer);
    producer.on('transportclose', () => this.producers.delete(kind));
    producer.on('trackended', () => {
      void this.unpublishTrack(kind).catch(() => undefined);
    });
  }

  async unpublishTrack(kind: VoiceTrackKind): Promise<void> {
    const producer = this.producers.get(kind);
    if (!producer) return;
    this.producers.delete(kind);
    try {
      await this.rpc.request('closeProducer', { producerId: producer.id });
    } catch (e) {
      console.warn('[sfu] closeProducer rpc failed', e);
    }
    try { producer.close(); } catch { /* ignore */ }
  }

  /**
   * Close transports and tell the SFU we're leaving.
   *
   * `awaitLeaveMs` bounds how long we'll wait for the `leave` RPC's
   * underlying Nostr publish to actually transmit before tearing down.
   * Set to 0 (the page-unload path passes 0) to keep the old fire-and-
   * forget behavior — the synchronous DTLS close-notify on transport.close
   * is enough on a closing tab. For graceful cases like channel switch we
   * want a short bounded wait so the leave really lands; otherwise the
   * SFU only finds out via the empty-grace timer / RTP inactivity reaper,
   * which is the long road and was at the heart of the "calls remain
   * active with 0 people" symptom.
   */
  async close(awaitLeaveMs = 500): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Try to land the `leave` RPC publish before we tear down. Bound the
    // wait so a hung relay can't deadlock a channel switch — past the
    // budget the SFU still cleans us up via DTLS close-notify, just on a
    // longer leash.
    if (awaitLeaveMs > 0) {
      try {
        await Promise.race([
          this.rpc.request('leave', undefined, 1500).catch(() => undefined),
          new Promise<void>((r) => setTimeout(r, awaitLeaveMs)),
        ]);
      } catch { /* ignore */ }
    } else {
      // Fire-and-forget path for unload — the page is going away, we
      // can't await anything reliably. The publish microtask still runs
      // before the page unloads in practice, and DTLS close-notify on
      // the transport.close() below is the deterministic fallback.
      try {
        void this.rpc.request('leave', undefined, 1500).catch(() => undefined);
      } catch { /* ignore */ }
    }
    this.stopStaleWatchdog();
    this.pendingProducers = [];
    for (const pending of Array.from(this.pendingConsumes.values())) {
      if (pending.timer) clearTimeout(pending.timer);
      // Don't close the consumer here — we hand it off via `consumer`
      // when consume succeeded but resume failed; the broader teardown
      // below closes the recv transport which closes every consumer.
    }
    this.pendingConsumes.clear();
    for (const consumer of this.remoteByProducerId.values()) {
      try { consumer.consumer.close(); } catch { /* ignore */ }
    }
    this.remoteByProducerId.clear();
    this.consumerHealth.clear();
    for (const producer of this.producers.values()) {
      try { producer.close(); } catch { /* ignore */ }
    }
    this.producers.clear();
    this.peers.clear();
    try { this.sendTransport?.close(); } catch { /* ignore */ }
    try { this.recvTransport?.close(); } catch { /* ignore */ }
    this.sendTransport = null;
    this.recvTransport = null;
    this.rpc.close();
  }

  // ── transports ─────────────────────────────────────────────────────────

  private async createTransports(): Promise<void> {
    const device = this.device;
    if (!device) throw new Error('device not loaded');
    if (this.closed) return;

    // Send transport — for our outbound producers.
    const sendInfo = await this.rpc.requestWithRetry<{
      id: string;
      iceParameters: unknown;
      iceCandidates: unknown[];
      dtlsParameters: DtlsParameters;
    }>('createWebRtcTransport', { direction: 'send' }, STARTUP_RPC_RETRY);
    if (this.closed) return;
    const sendTransport = device.createSendTransport({
      id: sendInfo.id,
      iceParameters: sendInfo.iceParameters as never,
      iceCandidates: sendInfo.iceCandidates as never,
      dtlsParameters: sendInfo.dtlsParameters,
      iceServers: ICE_SERVERS,
    });
    if (this.closed) {
      try { sendTransport.close(); } catch { /* ignore */ }
      return;
    }
    this.sendTransport = sendTransport;
    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      if (this.closed) {
        errback(new Error('SfuClient closed'));
        return;
      }
      this.rpc.requestWithRetry('connectWebRtcTransport', {
        transportId: sendInfo.id,
        dtlsParameters,
      }, CONNECT_RPC_RETRY).then(() => callback()).catch((err) => errback(err as Error));
    });
    sendTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      if (this.closed) {
        errback(new Error('SfuClient closed'));
        return;
      }
      this.rpc.request<{ id: string }>('produce', {
        transportId: sendInfo.id,
        kind,
        rtpParameters,
        appData,
      }).then(({ id }) => callback({ id })).catch((err) => errback(err as Error));
    });
    sendTransport.on('connectionstatechange', (state) => {
      this.events.onConnectionStateChange?.(state);
    });

    // Recv transport — for consumers the server pushes us.
    const recvInfo = await this.rpc.requestWithRetry<{
      id: string;
      iceParameters: unknown;
      iceCandidates: unknown[];
      dtlsParameters: DtlsParameters;
    }>('createWebRtcTransport', { direction: 'recv' }, STARTUP_RPC_RETRY);
    if (this.closed) {
      try { sendTransport.close(); } catch { /* ignore */ }
      if (this.sendTransport === sendTransport) this.sendTransport = null;
      return;
    }
    const recvTransport = device.createRecvTransport({
      id: recvInfo.id,
      iceParameters: recvInfo.iceParameters as never,
      iceCandidates: recvInfo.iceCandidates as never,
      dtlsParameters: recvInfo.dtlsParameters,
      iceServers: ICE_SERVERS,
    });
    if (this.closed) {
      try { recvTransport.close(); } catch { /* ignore */ }
      try { sendTransport.close(); } catch { /* ignore */ }
      if (this.sendTransport === sendTransport) this.sendTransport = null;
      return;
    }
    this.recvTransport = recvTransport;
    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      if (this.closed) {
        errback(new Error('SfuClient closed'));
        return;
      }
      this.rpc.requestWithRetry('connectWebRtcTransport', {
        transportId: recvInfo.id,
        dtlsParameters,
      }, CONNECT_RPC_RETRY).then(() => callback()).catch((err) => errback(err as Error));
    });

    // Drain any newProducer events that arrived before the recv transport
    // was ready. Server replays the existing producer list when our recv
    // transport request lands too, so a duplicate is fine — we dedupe by
    // producerId.
    const queued = this.pendingProducers.splice(0);
    if (this.closed) return;
    for (const item of queued) {
      this.enqueueConsume(item.producerId, item.appData);
    }
  }

  // ── server notifications ───────────────────────────────────────────────

  private handleNotification(n: RpcNotification): void {
    if (this.closed) return;
    if (n.method === 'newProducer') {
      const data = n.data as { producerId: string; kind: 'audio' | 'video'; appData: ProducerAppData | null };
      if (!data?.producerId) return;
      if (this.remoteByProducerId.has(data.producerId)) return;
      if (this.pendingConsumes.has(data.producerId)) return;
      if (!this.recvTransport || !this.device) {
        this.pendingProducers.push({ producerId: data.producerId, appData: data.appData, kind: data.kind });
        return;
      }
      this.enqueueConsume(data.producerId, data.appData);
    } else if (n.method === 'producerClosed') {
      const data = n.data as { producerId: string };
      // Cancel any in-flight retry first — the producer is gone, no
      // amount of retrying brings it back, and a queued attempt firing
      // after the producerClosed would just emit a wasted `consume-failed`.
      this.cancelPendingConsume(data.producerId);
      const remote = this.remoteByProducerId.get(data.producerId);
      if (!remote) return;
      this.remoteByProducerId.delete(data.producerId);
      this.consumerHealth.delete(remote.consumer.id);
      try { remote.consumer.close(); } catch { /* ignore */ }
      this.events.onRemoteTrackEnded(remote.trackId);
    } else if (n.method === 'kicked') {
      const data = n.data as { reason?: string };
      console.warn('[sfu] kicked from room', data?.reason ?? '');
      void this.close().catch(() => undefined);
    } else if (n.method === 'participantList') {
      // Authoritative snapshot the SFU pushes when our recv transport opens.
      // Replaces — not merges — so the dex's roster always matches the
      // server's truth even after a reconnect. Anyone we were tracking who
      // isn't in the fresh list has left; drop their forwarded tracks too,
      // otherwise their tile stays black after a server restart.
      const data = n.data as { pubkeys?: string[] };
      const next = new Set<string>();
      for (const pk of data?.pubkeys ?? []) {
        if (typeof pk === 'string' && pk.length > 0) next.add(pk);
      }
      for (const prev of this.peers) {
        if (!next.has(prev)) this.dropTracksFor(prev);
      }
      this.peers = next;
      this.emitPeersChange();
    } else if (n.method === 'peerJoined') {
      const data = n.data as { pubkey?: string };
      if (!data?.pubkey) return;
      if (this.peers.has(data.pubkey)) return;
      this.peers.add(data.pubkey);
      this.emitPeersChange();
    } else if (n.method === 'peerLeft') {
      const data = n.data as { pubkey?: string };
      if (!data?.pubkey) return;
      const removed = this.peers.delete(data.pubkey);
      // Prune any tracks the SFU was forwarding from this peer. The server
      // SHOULD also fire `producerClosed` for each producer, but in practice
      // an abrupt disconnect (tab close, network loss, kicked) lands `peerLeft`
      // without the per-producer follow-ups — and without this pruning the
      // peer's video tile stays as the last frame (a black rectangle once
      // the WebRTC timeout drains the jitter buffer).
      this.dropTracksFor(data.pubkey);
      if (removed) this.emitPeersChange();
    }
  }

  /** Close every consumer whose producer originated from `pubkey`, dropping
   *  the corresponding remote-track entry and notifying the dex. Also
   *  cancels any in-flight retry for the same peer — when a peer leaves
   *  abruptly we don't want the retry ladder hammering `consume` for a
   *  producer the SFU has already torn down on its side. */
  private dropTracksFor(pubkey: string): void {
    for (const [producerId, remote] of Array.from(this.remoteByProducerId.entries())) {
      if (remote.pubkey !== pubkey) continue;
      this.remoteByProducerId.delete(producerId);
      this.consumerHealth.delete(remote.consumer.id);
      try { remote.consumer.close(); } catch { /* ignore */ }
      try { this.events.onRemoteTrackEnded(remote.trackId); } catch (err) {
        console.warn('[sfu] onRemoteTrackEnded handler threw', err);
      }
    }
    for (const [producerId, pending] of Array.from(this.pendingConsumes.entries())) {
      if (pending.peerPubkey !== pubkey) continue;
      this.cancelPendingConsume(producerId);
    }
  }

  private emitPeersChange(): void {
    try {
      this.events.onPeersChange?.([...this.peers]);
    } catch (err) {
      console.warn('[sfu] onPeersChange handler threw', err);
    }
  }

  /**
   * Snapshot of the SFU-pushed peer list (excluding self). The dex
   * mirrors this into `VoiceClient.rosterPubkeys` so React UI re-renders
   * without waiting for the next event tick.
   */
  getPeers(): string[] {
    return [...this.peers];
  }

  // ── consume retry queue ────────────────────────────────────────────────
  //
  // Pre-reliability-layer the consume path was a single try/catch that
  // logged a warning on any failure and forgot the producer forever.
  // That was the root cause of the "leave + rejoin to see content"
  // symptom: a single dropped `consume` RPC, an 8 s timeout on a heavy
  // relay, or a transient `NO_PEER` race between the SFU writing peer
  // state and our consume request landing — all of these silently
  // stranded a remote track.
  //
  // The new flow:
  //   1. `enqueueConsume` is the single entry point. It dedupes against
  //      `remoteByProducerId` (already consumed) and `pendingConsumes`
  //      (already in flight) so duplicate `newProducer` notifications
  //      collapse cleanly.
  //   2. `attemptConsume` runs the two-phase `consume` + `resumeConsumer`
  //      RPC chain. If `consume` succeeded but `resumeConsumer` failed
  //      we keep the Consumer object on the pending entry and the next
  //      retry only re-issues the resume — no wasted round-trip.
  //   3. Errors are classified by `RpcError.code` (sfu-rpc.ts attaches
  //      it onto the thrown Error). `CANNOT_CONSUME` and `ROOM_FULL` are
  //      permanent — retrying won't help — so we give up immediately
  //      and emit `consume-failed`. Everything else (timeout, NO_PEER,
  //      NO_RECV_TRANSPORT, NO_ROUTER, NO_CONSUMER, network errors)
  //      is treated as transient and retried with the
  //      `CONSUME_RETRY_DELAYS_MS` ladder.
  //   4. After `CONSUME_RETRY_DELAYS_MS.length` attempts we give up,
  //      emit `consume-failed`, and log at error level. The retry queue
  //      protects against transient failures, not permanent ones.

  private enqueueConsume(producerId: string, appData: ProducerAppData | null): void {
    if (this.closed) return;
    if (!this.device || !this.recvTransport) return;
    if (this.remoteByProducerId.has(producerId)) return;
    if (this.pendingConsumes.has(producerId)) return;
    const entry: PendingConsume = {
      producerId,
      appData,
      attempts: 0,
      timer: null,
      consumer: null,
      peerPubkey: appData?.originPubkey ?? '',
    };
    this.pendingConsumes.set(producerId, entry);
    void this.attemptConsume(entry);
  }

  private cancelPendingConsume(producerId: string): void {
    const entry = this.pendingConsumes.get(producerId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.consumer) {
      try { entry.consumer.close(); } catch { /* ignore */ }
    }
    this.pendingConsumes.delete(producerId);
  }

  private async attemptConsume(entry: PendingConsume): Promise<void> {
    if (this.closed) return;
    if (!this.device || !this.recvTransport) return;
    // The producer may have been torn down between scheduling and
    // firing (peer left, or a `producerClosed` notification arrived).
    if (!this.pendingConsumes.has(entry.producerId)) return;
    entry.attempts += 1;
    const transport = this.recvTransport;
    try {
      // Phase 1: `consume` RPC + `recvTransport.consume`. Skipped if a
      // previous attempt already minted the Consumer and only the
      // resume failed — saves a round-trip and avoids the SFU minting
      // a duplicate consumer it would have to garbage-collect later.
      let consumer = entry.consumer;
      let consumeAppData: ProducerAppData | null = entry.appData;
      let consumerKind: 'audio' | 'video' | null = null;
      if (!consumer) {
        const consumeData = await this.rpc.request<{
          id: string;
          producerId: string;
          kind: 'audio' | 'video';
          rtpParameters: RtpParameters;
          appData: ProducerAppData | null;
        }>('consume', {
          producerId: entry.producerId,
          rtpCapabilities: this.device.rtpCapabilities,
        });
        if (this.closed || !this.pendingConsumes.has(entry.producerId)) {
          // Race: producer closed / client torn down while RPC was in
          // flight. Don't surface a half-built track.
          return;
        }
        consumer = await transport.consume({
          id: consumeData.id,
          producerId: consumeData.producerId,
          kind: consumeData.kind,
          rtpParameters: consumeData.rtpParameters,
        });
        if (this.closed || !this.pendingConsumes.has(entry.producerId)) {
          try { consumer.close(); } catch { /* ignore */ }
          return;
        }
        consumeAppData = consumeData.appData ?? entry.appData;
        consumerKind = consumeData.kind;
        entry.consumer = consumer;
      } else {
        consumerKind = consumer.kind === 'audio' ? 'audio' : 'video';
      }
      // Phase 2: `resumeConsumer` RPC. Server starts consumers paused
      // so the client can prepare its <video> element first.
      await this.rpc.request('resumeConsumer', { consumerId: consumer.id });
      if (this.closed || !this.pendingConsumes.has(entry.producerId)) {
        try { consumer.close(); } catch { /* ignore */ }
        return;
      }
      // Success — surface the track and clear the pending entry.
      this.surfaceConsumer(entry.producerId, consumer, consumerKind, consumeAppData ?? entry.appData);
      this.pendingConsumes.delete(entry.producerId);
    } catch (err) {
      if (this.closed || !this.pendingConsumes.has(entry.producerId)) return;
      const code = (err as Error & { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (this.isPermanentConsumeError(code)) {
        console.error('[sfu] consume permanently failed', entry.producerId, code, message);
        this.emitReliability({
          kind: 'consume-failed',
          producerId: entry.producerId,
          peerPubkey: entry.peerPubkey || undefined,
          attempt: entry.attempts,
          errorCode: code,
          errorMessage: message,
        });
        this.cancelPendingConsume(entry.producerId);
        return;
      }
      if (entry.attempts >= CONSUME_RETRY_DELAYS_MS.length) {
        console.error('[sfu] consume gave up after', entry.attempts, 'attempts', entry.producerId, message);
        this.emitReliability({
          kind: 'consume-failed',
          producerId: entry.producerId,
          peerPubkey: entry.peerPubkey || undefined,
          attempt: entry.attempts,
          errorCode: code,
          errorMessage: message,
        });
        this.cancelPendingConsume(entry.producerId);
        return;
      }
      const delay = CONSUME_RETRY_DELAYS_MS[entry.attempts - 1] ?? CONSUME_RETRY_DELAYS_MS[CONSUME_RETRY_DELAYS_MS.length - 1];
      console.warn('[sfu] consume failed; retrying in', delay, 'ms', entry.producerId, code ?? '', message);
      this.emitReliability({
        kind: 'consume-retry',
        producerId: entry.producerId,
        peerPubkey: entry.peerPubkey || undefined,
        attempt: entry.attempts,
        errorCode: code,
        errorMessage: message,
      });
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void this.attemptConsume(entry);
      }, delay);
    }
  }

  /**
   * Permanent error codes — retrying these is wasted effort. Everything
   * else (timeouts, NO_PEER / NO_RECV_TRANSPORT / NO_ROUTER / NO_CONSUMER
   * races, network errors with no code) is transient and goes through
   * the backoff ladder.
   */
  private isPermanentConsumeError(code: string | undefined): boolean {
    return code === 'CANNOT_CONSUME' || code === 'ROOM_FULL';
  }

  private surfaceConsumer(
    producerId: string,
    consumer: Consumer,
    consumerKind: 'audio' | 'video' | null,
    appData: ProducerAppData | null,
  ): void {
    const meta = appData ?? {};
    const fallbackKind = consumerKind ?? (consumer.kind === 'audio' ? 'audio' : 'video');
    const voiceKind: VoiceTrackKind = meta.kind ?? (fallbackKind === 'audio' ? 'audio' : 'camera');
    const stream = new MediaStream([consumer.track]);
    const remote: SfuRemoteTrack = {
      pubkey: meta.originPubkey ?? '',
      trackId: consumer.track.id,
      kind: voiceKind,
      stream,
      consumer,
    };
    this.remoteByProducerId.set(producerId, remote);
    const now = Date.now();
    this.consumerHealth.set(consumer.id, {
      producerId,
      appData,
      createdAt: now,
      lastBytesReceived: 0,
      lastProgressAt: now,
    });
    // Two distinct close events from mediasoup-client v3.20:
    //   `transportclose` — recv transport closed (page unload, full
    //                      SFU reconnect). Fires once per recv transport
    //                      teardown across all consumers.
    //   `trackended` — the underlying MediaStreamTrack ended (RTP stops
    //                  flowing for long enough that the browser marks
    //                  the track ended). Belt-and-suspenders backup for
    //                  the explicit `producerClosed` notification the
    //                  SFU sends — if the notification is delayed or
    //                  dropped, this still fires within a few seconds
    //                  of the upstream camera/screen-share toggling off.
    // Pre-fix neither was wired and the SFU's `closeProducer` handler
    // didn't fan out `producerClosed`, so a remote camera-off left a
    // frozen tile in everyone's grid until they left the channel.
    const onClose = () => {
      if (!this.remoteByProducerId.has(producerId)) return;
      this.remoteByProducerId.delete(producerId);
      this.consumerHealth.delete(consumer.id);
      try { consumer.close(); } catch { /* ignore */ }
      this.events.onRemoteTrackEnded(remote.trackId);
    };
    consumer.on('transportclose', onClose);
    consumer.on('trackended', onClose);
    this.events.onRemoteTrack(remote);
    this.startStaleWatchdog();
  }

  private emitReliability(ev: SfuReliabilityEvent): void {
    try {
      this.events.onReliabilityEvent?.(ev);
    } catch (err) {
      console.warn('[sfu] onReliabilityEvent handler threw', err);
    }
  }

  // ── stale-consumer watchdog ────────────────────────────────────────────
  //
  // Some failures leave a consumer "live" with zero bytes flowing —
  // a paused-then-orphaned consumer if `resumeConsumer` raced with a
  // server-side state flush, an ICE path that nominated but stopped
  // forwarding, or a brief codec hiccup that never recovered. The
  // browser's own `trackended` only fires after ~10 s of dead RTP and
  // *only if RTP started in the first place* — if it never started,
  // `trackended` never fires. We watchdog on `getStats()` so the
  // dex notices and rebuilds the consumer instead of waiting for the
  // user to leave and rejoin.

  private startStaleWatchdog(): void {
    if (this.staleWatchdogTimer) return;
    if (this.closed) return;
    this.staleWatchdogTimer = setInterval(() => {
      void this.checkConsumerHealth();
    }, STALE_CHECK_INTERVAL_MS);
  }

  private stopStaleWatchdog(): void {
    if (!this.staleWatchdogTimer) return;
    clearInterval(this.staleWatchdogTimer);
    this.staleWatchdogTimer = null;
  }

  private async checkConsumerHealth(): Promise<void> {
    if (this.closed) return;
    if (this.remoteByProducerId.size === 0) {
      this.stopStaleWatchdog();
      return;
    }
    const now = Date.now();
    for (const [producerId, remote] of Array.from(this.remoteByProducerId.entries())) {
      const health = this.consumerHealth.get(remote.consumer.id);
      if (!health) continue;
      if (now - health.createdAt < STALE_WARMUP_MS) continue;
      if (remote.consumer.paused) continue;
      let bytesReceived = 0;
      try {
        const stats = await remote.consumer.getStats();
        bytesReceived = extractInboundBytesReceived(stats);
      } catch {
        // getStats() failure is itself a signal but very noisy in some
        // browsers — skip this tick rather than escalating on a single
        // hiccup. The next tick will retry the read.
        continue;
      }
      if (bytesReceived > health.lastBytesReceived) {
        health.lastBytesReceived = bytesReceived;
        health.lastProgressAt = now;
        continue;
      }
      if (now - health.lastProgressAt < STALE_TIMEOUT_MS) continue;
      // Wedged. Tear it down and re-enqueue a fresh consume — the
      // server still has the producer (we'd have received producerClosed
      // otherwise). Cache the appData before we drop state.
      const appData = health.appData;
      this.consumerHealth.delete(remote.consumer.id);
      this.remoteByProducerId.delete(producerId);
      try { remote.consumer.close(); } catch { /* ignore */ }
      try { this.events.onRemoteTrackEnded(remote.trackId); } catch (err) {
        console.warn('[sfu] onRemoteTrackEnded handler threw', err);
      }
      this.emitReliability({
        kind: 'stale-consumer',
        producerId,
        peerPubkey: appData?.originPubkey || remote.pubkey || undefined,
      });
      this.enqueueConsume(producerId, appData);
    }
  }
}

function extractInboundBytesReceived(stats: RTCStatsReport | Map<string, unknown>): number {
  // RTCStatsReport iterates [id, RTCStats] pairs. We pick the inbound-rtp
  // entry — there's only one per consumer (one m-line). Fall back to 0
  // if the browser hasn't populated the stat yet (very early after
  // consume — STALE_WARMUP_MS is meant to cover this window but a few
  // browsers expose `inbound-rtp` without `bytesReceived` for a tick).
  let bytes = 0;
  stats.forEach((stat: unknown) => {
    if (!stat || typeof stat !== 'object') return;
    const s = stat as { type?: string; bytesReceived?: number };
    if (s.type !== 'inbound-rtp') return;
    if (typeof s.bytesReceived === 'number' && s.bytesReceived > bytes) {
      bytes = s.bytesReceived;
    }
  });
  return bytes;
}
