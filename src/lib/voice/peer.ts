/**
 * Pairwise WebRTC connection backed by simple-peer.
 *
 * Obelisk still owns Nostr identity, admission, relay signaling, mesh
 * discovery, media policy, and quality controls. simple-peer owns the
 * browser-specific SDP/ICE/renegotiation state machine and data channel.
 */
import SimplePeer from 'simple-peer';
import type { VoiceSignalPayload, VoiceTrackKind, VoiceQualityHint } from './types';
import { startStatsMonitor, type QualitySample, type StatsMonitorHandle } from './stats';
import { AUDIO_MAX_BITRATE } from './quality';
import {
  CONTROL_CHANNEL_LABEL,
  DEAD_PEER_TIMEOUT_MS,
  PEER_SNAPSHOT_INTERVAL_MS,
  PING_INTERVAL_MS,
  type ControlMessage,
} from './control-channel';
import type { VoiceMetrics } from './metrics';
import { ICE_SERVERS, ICE_TRANSPORT_POLICY } from './ice-config';

export const INITIAL_CONNECT_TIMEOUT_MS = 9000;
export const REMOTE_VIDEO_MUTE_GRACE_MS = 2500;

export interface PeerEvents {
  onRemoteTrack(track: MediaStreamTrack, stream: MediaStream, kind: VoiceTrackKind, originPubkey?: string): void;
  onRemoteTrackEnded(trackId: string): void;
  onConnectionStateChange(state: RTCPeerConnectionState): void;
  onConnectionEstablished?(): void;
  onConnectionLost?(): void;
  onQualitySample?(sample: QualitySample): void;
  onTransitivePeers?(remotePeers: string[], remoteBuild: string): void;
  onControlPeerSnapshot?(remotePeers: string[]): void;
  onControlPeerAdded?(pubkey: string): void;
  onControlPeerRemoved?(pubkey: string): void;
  onPeerDead?(reason: string): void;
}

export interface PeerOptions {
  remotePubkey: string;
  /** Preserved public name: the polite side is the non-initiator. */
  polite: boolean;
  sessionId: string;
  bootstrapRecvOnlyMedia?: boolean;
  send: (payload: VoiceSignalPayload) => Promise<void> | void;
  events: PeerEvents;
  iceTransportPolicy?: RTCIceTransportPolicy;
  control?: {
    selfBuild: string;
    metrics: VoiceMetrics;
    getCurrentPeers: () => string[];
  };
}

type SimplePeerInstance = SimplePeer.Instance;
type SimplePeerSignal = SimplePeer.SignalData;

interface LocalMedia {
  track: MediaStreamTrack;
  stream: MediaStream;
}

function browserWrtc(): NonNullable<SimplePeer.Options['wrtc']> {
  const g = globalThis as typeof globalThis & {
    RTCPeerConnection: typeof RTCPeerConnection;
    RTCSessionDescription?: typeof RTCSessionDescription;
    RTCIceCandidate?: typeof RTCIceCandidate;
  };
  const SessionDescription = g.RTCSessionDescription ?? class {
    type: RTCSdpType;
    sdp: string;
    constructor(init: RTCSessionDescriptionInit) {
      this.type = init.type;
      this.sdp = init.sdp ?? '';
    }
    toJSON() { return { type: this.type, sdp: this.sdp }; }
  } as unknown as typeof RTCSessionDescription;
  const IceCandidate = g.RTCIceCandidate ?? class {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment: string | null;
    constructor(init: RTCIceCandidateInit) {
      this.candidate = init.candidate ?? '';
      this.sdpMid = init.sdpMid ?? null;
      this.sdpMLineIndex = init.sdpMLineIndex ?? null;
      this.usernameFragment = init.usernameFragment ?? null;
    }
    toJSON() {
      return {
        candidate: this.candidate,
        sdpMid: this.sdpMid,
        sdpMLineIndex: this.sdpMLineIndex,
        usernameFragment: this.usernameFragment,
      };
    }
  } as unknown as typeof RTCIceCandidate;
  return {
    RTCPeerConnection: g.RTCPeerConnection,
    RTCSessionDescription: SessionDescription,
    RTCIceCandidate: IceCandidate,
  };
}

function decodeControl(data: unknown): ControlMessage | null {
  try {
    if (typeof data === 'string') return JSON.parse(data) as ControlMessage;
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(data))) as ControlMessage;
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      )) as ControlMessage;
    }
    return JSON.parse(String(data)) as ControlMessage;
  } catch {
    return null;
  }
}

export class Peer {
  readonly remotePubkey: string;
  readonly polite: boolean;
  pc: RTCPeerConnection;

  private readonly send: PeerOptions['send'];
  private readonly events: PeerEvents;
  private readonly sessionId: string;
  private readonly control: PeerOptions['control'];
  private readonly iceTransportPolicy: RTCIceTransportPolicy;
  private readonly initiator: boolean;
  private recvOnlyBootstrapped = false;
  private readonly simple: SimplePeerInstance;
  private localMedia = new Map<VoiceTrackKind, LocalMedia>();
  private remoteTrackKinds = new Map<string, VoiceTrackKind>();
  private remoteTrackOrigins = new Map<string, string>();
  private remoteVideoMuteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private outboundSeq = 0;
  private connected = false;
  private controlStarted = false;
  private closed = false;
  private localVideoCap: { maxBitrate: number | null; maxFramerate: number } | null = null;
  private inboundCap: VoiceQualityHint | null = null;
  private connectWatchdog: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private deadTimer: ReturnType<typeof setTimeout> | null = null;
  private statsMonitor: StatsMonitorHandle | null = null;

  constructor(opts: PeerOptions) {
    this.remotePubkey = opts.remotePubkey;
    this.polite = opts.polite;
    this.send = opts.send;
    this.events = opts.events;
    this.sessionId = opts.sessionId;
    this.control = opts.control;
    this.iceTransportPolicy = opts.iceTransportPolicy ?? ICE_TRANSPORT_POLICY;
    this.initiator = !this.polite;
    this.simple = this.createSimplePeer();
    this.pc = this.rawPc();
  }

  private createSimplePeer(): SimplePeerInstance {
    const simple = new SimplePeer({
      initiator: this.initiator,
      trickle: true,
      wrtc: browserWrtc(),
      config: {
        iceServers: ICE_SERVERS,
        iceTransportPolicy: this.iceTransportPolicy,
        iceCandidatePoolSize: 4,
      },
      channelName: CONTROL_CHANNEL_LABEL,
      channelConfig: { ordered: true },
    });
    const pc = (simple as SimplePeerInstance & { _pc: RTCPeerConnection })._pc;
    const nativeStateHandler = pc.onconnectionstatechange;
    pc.onconnectionstatechange = (event) => {
      nativeStateHandler?.call(pc, event);
      this.handleConnectionState(pc.connectionState);
    };

    simple.on('signal', (data) => {
      void this.sendSignal({ type: 'peer', peerSignal: data }).catch((error) => {
        console.warn('[voice] simple-peer signal publish failed', error);
      });
    });
    simple.on('track', (track, stream) => this.handleRemoteTrack(track, stream));
    simple.on('connect', () => {
      this.handleConnected();
      this.startControl();
    });
    simple.on('data', (data) => this.handleControl(decodeControl(data)));
    simple.on('error', (error) => {
      console.warn('[voice] simple-peer error for', this.remotePubkey.slice(0, 8), error);
    });
    simple.on('close', () => {
      if (!this.closed) this.handleConnectionState('closed');
    });

    this.connectWatchdog = setTimeout(() => {
      this.connectWatchdog = null;
      if (!this.closed && !this.connected) this.events.onPeerDead?.('open-timeout');
    }, INITIAL_CONNECT_TIMEOUT_MS);
    console.log('[voice] simple-peer PC', this.remotePubkey.slice(0, 8), 'initiator=', this.initiator);
    return simple;
  }

  private rawPc(): RTCPeerConnection {
    return (this.simple as SimplePeerInstance & { _pc: RTCPeerConnection })._pc;
  }

  private async sendSignal(payload: Omit<VoiceSignalPayload, 'sessionId' | 'seq'>): Promise<void> {
    if (this.closed) return;
    await this.send({ ...payload, sessionId: this.sessionId, seq: ++this.outboundSeq });
  }

  private handleConnectionState(state: RTCPeerConnectionState): void {
    this.events.onConnectionStateChange(state);
    if (state === 'connected') this.handleConnected();
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      if (this.connected) {
        this.connected = false;
        this.events.onConnectionLost?.();
      }
    }
  }

  private handleConnected(): void {
    if (this.closed || this.connected) return;
    this.connected = true;
    if (this.connectWatchdog) {
      clearTimeout(this.connectWatchdog);
      this.connectWatchdog = null;
    }
    this.events.onConnectionEstablished?.();
    if (this.events.onQualitySample) {
      this.statsMonitor = startStatsMonitor(this.pc, this.events.onQualitySample);
    }
  }

  private startControl(): void {
    if (!this.control || this.controlStarted || this.closed) return;
    this.controlStarted = true;
    this.broadcastControl({
      type: 'hello',
      peers: this.control.getCurrentPeers(),
      sessionId: this.sessionId,
      build: this.control.selfBuild,
    });
    this.armDeadTimer();
    this.pingTimer = setInterval(
      () => this.broadcastControl({ type: 'ping', ts: Date.now() }),
      PING_INTERVAL_MS,
    );
    this.snapshotTimer = setInterval(
      () => this.broadcastControl({
        type: 'peerSnapshot',
        peers: this.control?.getCurrentPeers() ?? [],
        ts: Date.now(),
      }),
      PEER_SNAPSHOT_INTERVAL_MS,
    );
    this.control.metrics.controlChannel.opened++;
  }

  private handleRemoteTrack(track: MediaStreamTrack, stream: MediaStream): void {
    const kind = this.remoteTrackKinds.get(track.id) ?? (track.kind === 'audio' ? 'audio' : 'camera');
    this.events.onRemoteTrack(track, stream, kind, this.remoteTrackOrigins.get(track.id));
    const ended = () => {
      const timer = this.remoteVideoMuteTimers.get(track.id);
      if (timer) clearTimeout(timer);
      this.remoteVideoMuteTimers.delete(track.id);
      this.events.onRemoteTrackEnded(track.id);
    };
    track.addEventListener('ended', ended, { once: true });
    if (kind === 'camera' || kind === 'screen') {
      track.addEventListener('mute', () => {
        const previous = this.remoteVideoMuteTimers.get(track.id);
        if (previous) clearTimeout(previous);
        this.remoteVideoMuteTimers.set(track.id, setTimeout(ended, REMOTE_VIDEO_MUTE_GRACE_MS));
      });
      track.addEventListener('unmute', () => {
        const timer = this.remoteVideoMuteTimers.get(track.id);
        if (timer) clearTimeout(timer);
        this.remoteVideoMuteTimers.delete(track.id);
      });
    }
  }

  broadcastControl(message: ControlMessage): void {
    if (!this.simple.connected) return;
    try { this.simple.send(JSON.stringify(message)); } catch { /* best effort */ }
  }

  isControlOpen(): boolean {
    return this.simple.connected;
  }

  private handleControl(message: ControlMessage | null): void {
    if (!message || typeof message.type !== 'string') return;
    this.armDeadTimer();
    switch (message.type) {
      case 'hello':
        this.events.onTransitivePeers?.(Array.isArray(message.peers) ? message.peers : [], message.build ?? '');
        break;
      case 'peerSnapshot':
        this.events.onControlPeerSnapshot?.(Array.isArray(message.peers) ? message.peers : []);
        break;
      case 'peerAdded':
        if (typeof message.pubkey === 'string') this.events.onControlPeerAdded?.(message.pubkey);
        break;
      case 'peerRemoved':
        if (typeof message.pubkey === 'string') this.events.onControlPeerRemoved?.(message.pubkey);
        break;
      case 'bye':
        this.events.onPeerDead?.(`bye:${message.reason ?? 'remote-bye'}`);
        break;
      case 'ping':
        this.broadcastControl({ type: 'pong', ts: Date.now(), echoTs: message.ts });
        break;
      case 'pong':
        if (this.control) {
          this.control.metrics.controlChannel.pongRcvd++;
          this.control.metrics.controlChannel.lastRttMs = Math.max(0, Date.now() - message.echoTs);
        }
        break;
    }
  }

  private armDeadTimer(): void {
    if (!this.control) return;
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = setTimeout(() => {
      this.deadTimer = null;
      if (!this.closed) this.events.onPeerDead?.('heartbeat-lost');
    }, DEAD_PEER_TIMEOUT_MS);
  }

  async setLocalTrack(kind: VoiceTrackKind, track: MediaStreamTrack | null): Promise<void> {
    if (this.closed) return;
    const current = this.localMedia.get(kind);
    if (current?.track === track) return;
    if (track) {
      await this.sendSignal({ type: 'trackinfo', trackInfo: { trackId: track.id, kind } });
    }
    if (current && track) {
      this.simple.replaceTrack(current.track, track, current.stream);
      this.localMedia.set(kind, { track, stream: current.stream });
    } else if (current) {
      this.simple.removeTrack(current.track, current.stream);
      this.localMedia.delete(kind);
    } else if (track) {
      const stream = new MediaStream([track]);
      this.simple.addTrack(track, stream);
      this.localMedia.set(kind, { track, stream });
    }
    if (kind === 'audio') await this.applyAudioSenderParams();
    if (kind === 'camera' || kind === 'screen') await this.applyVideoSenderParams(kind);
  }

  /** The deterministic simple-peer initiator creates offers automatically. */
  async kickControlOffer(): Promise<void> { this.bootstrapRecvOnly(); }
  async kickInitialOffer(): Promise<void> { this.bootstrapRecvOnly(); }

  private bootstrapRecvOnly(): void {
    if (this.recvOnlyBootstrapped || this.closed) return;
    this.recvOnlyBootstrapped = true;
    this.simple.addTransceiver('video', { direction: 'recvonly' });
    this.simple.addTransceiver('audio', { direction: 'recvonly' });
  }

  async handleSignal(payload: VoiceSignalPayload): Promise<void> {
    if (this.closed) return;
    if (payload.type === 'bye') {
      this.events.onPeerDead?.(`bye:${payload.byeReason ?? 'remote-bye'}`);
      return;
    }
    if (payload.type === 'trackinfo' && payload.trackInfo) {
      this.remoteTrackKinds.set(payload.trackInfo.trackId, payload.trackInfo.kind);
      if (payload.trackInfo.originPubkey) {
        this.remoteTrackOrigins.set(payload.trackInfo.trackId, payload.trackInfo.originPubkey);
      }
      return;
    }
    if (payload.type === 'qualityhint') {
      this.inboundCap = payload.qualityHint ?? null;
      await this.applyVideoSenderParams('camera');
      await this.applyVideoSenderParams('screen');
      return;
    }
    if (payload.type === 'requestReset') {
      this.events.onPeerDead?.('reset-requested');
      return;
    }
    try {
      if (payload.type === 'peer' && payload.peerSignal) {
        this.simple.signal(payload.peerSignal as SimplePeerSignal);
      } else if ((payload.type === 'offer' || payload.type === 'answer') && payload.sdp) {
        this.simple.signal({ type: payload.type, sdp: payload.sdp });
      } else if (payload.type === 'ice') {
        for (const candidate of payload.candidates ?? []) {
          this.simple.signal({ type: 'candidate', candidate: candidate as RTCIceCandidate });
        }
      }
    } catch (error) {
      console.warn('[voice] simple-peer rejected signal', error);
    }
  }

  async setLocalVideoCap(cap: { maxBitrate: number | null; maxFramerate: number } | null): Promise<void> {
    this.localVideoCap = cap;
    await this.applyVideoSenderParams('camera');
    await this.applyVideoSenderParams('screen');
  }

  async sendQualityHint(hint: VoiceQualityHint): Promise<void> {
    await this.sendSignal({ type: 'qualityhint', qualityHint: hint });
  }

  private async applyVideoSenderParams(kind: 'camera' | 'screen'): Promise<void> {
    const media = this.localMedia.get(kind);
    if (!media) return;
    const sender = this.pc.getSenders().find((candidate) => candidate.track === media.track);
    if (!sender) return;
    const localBitrate = this.localVideoCap?.maxBitrate ?? null;
    const remoteBitrate = this.inboundCap?.maxBitrate ?? null;
    const localFps = this.localVideoCap?.maxFramerate ?? null;
    const remoteFps = this.inboundCap?.maxFramerate ?? null;
    const maxBitrate = localBitrate == null ? remoteBitrate
      : remoteBitrate == null ? localBitrate
      : Math.min(localBitrate, remoteBitrate);
    const maxFramerate = localFps == null ? remoteFps
      : remoteFps == null ? localFps
      : Math.min(localFps, remoteFps);
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      if (maxBitrate != null) params.encodings[0].maxBitrate = maxBitrate;
      else delete params.encodings[0].maxBitrate;
      if (maxFramerate != null) params.encodings[0].maxFramerate = maxFramerate;
      else delete params.encodings[0].maxFramerate;
      params.degradationPreference = kind === 'camera' ? 'maintain-framerate' : 'maintain-resolution';
      await sender.setParameters(params);
    } catch (error) {
      console.warn('[voice] video setParameters failed', error);
    }
  }

  async applyAudioSenderParams(): Promise<void> {
    const media = this.localMedia.get('audio');
    if (!media) return;
    const sender = this.pc.getSenders().find((candidate) => candidate.track === media.track);
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = AUDIO_MAX_BITRATE;
      await sender.setParameters(params);
    } catch (error) {
      console.warn('[voice] audio setParameters failed', error);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.broadcastControl({ type: 'bye', reason: 'local-leave' });
    void Promise.resolve(this.send({
      type: 'bye',
      sessionId: this.sessionId,
      seq: ++this.outboundSeq,
      byeReason: 'local-leave',
    })).catch(() => {});
    if (this.connectWatchdog) clearTimeout(this.connectWatchdog);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    for (const timer of this.remoteVideoMuteTimers.values()) clearTimeout(timer);
    this.remoteVideoMuteTimers.clear();
    this.statsMonitor?.stop();
    this.statsMonitor = null;
    this.simple.destroy();
    if (this.connected) {
      this.connected = false;
      this.events.onConnectionLost?.();
    }
  }
}
