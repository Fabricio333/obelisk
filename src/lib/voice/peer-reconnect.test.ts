import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWebRtcMocks } from '@/test/mocks/webrtc';
import { INITIAL_CONNECT_TIMEOUT_MS, Peer } from './peer';

let webrtc: ReturnType<typeof installWebRtcMocks>;

beforeEach(() => {
  webrtc = installWebRtcMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  webrtc.uninstall();
});

function peerWith(events: Partial<ConstructorParameters<typeof Peer>[0]['events']> = {}) {
  return new Peer({
    remotePubkey: 'b'.repeat(64),
    polite: false,
    sessionId: 'session',
    send: vi.fn(),
    events: {
      onRemoteTrack: vi.fn(),
      onRemoteTrackEnded: vi.fn(),
      onConnectionStateChange: vi.fn(),
      ...events,
    },
  });
}

describe('Peer lifecycle recovery hooks', () => {
  it('reports a connection that never opens so VoiceClient can redial it', () => {
    const onPeerDead = vi.fn();
    const peer = peerWith({ onPeerDead });
    vi.advanceTimersByTime(INITIAL_CONNECT_TIMEOUT_MS);
    expect(onPeerDead).toHaveBeenCalledWith('open-timeout');
    peer.close();
  });

  it('emits established/lost edges from the underlying connection', () => {
    const onConnectionEstablished = vi.fn();
    const onConnectionLost = vi.fn();
    const peer = peerWith({ onConnectionEstablished, onConnectionLost });
    const pc = peer.pc as unknown as { forceState(state: RTCPeerConnectionState): void };
    pc.forceState('connected');
    pc.forceState('disconnected');
    expect(onConnectionEstablished).toHaveBeenCalledTimes(1);
    expect(onConnectionLost).toHaveBeenCalledTimes(1);
    peer.close();
  });
});
