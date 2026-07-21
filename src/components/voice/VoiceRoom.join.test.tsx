import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VoiceRoom from './VoiceRoom';
import { useVoiceStore } from '@/store/voice';

const voiceHarness = vi.hoisted(() => ({
  activeClient: null as any,
  setActiveVoiceClient: vi.fn((client: any) => { voiceHarness.activeClient = client; }),
  voiceClientCtor: vi.fn(),
}));

const bridgeHarness = vi.hoisted(() => ({
  groups: [] as Array<{ id: string; name?: string; kind: 'voice' | 'voice-sfu'; isOpen?: boolean }>,
  activeCalls: {} as Record<string, any>,
  profiles: {} as Record<string, { name?: string; displayName?: string; picture?: string }>,
  bridge: null as any,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/ShootingStars', () => ({
  default: () => null,
}));

vi.mock('./VoiceControls', () => ({
  default: () => <div data-testid="voice-controls" />,
}));

vi.mock('./DebugOverlay', () => ({
  DebugOverlay: () => null,
}));

vi.mock('@/lib/voice/sfu-control', () => ({
  ensureSfuRoomStarted: vi.fn(async () => null),
}));

vi.mock('@/lib/voice/active-client', () => ({
  getActiveVoiceClient: () => voiceHarness.activeClient,
  setActiveVoiceClient: voiceHarness.setActiveVoiceClient,
}));

vi.mock('@/lib/voice/client', () => ({
  VoiceClient: vi.fn().mockImplementation(function VoiceClientMock(channelId: string) {
    const client = {
      channelId,
      isJoined: () => true,
      join: vi.fn(async () => {}),
      leave: vi.fn(async () => {}),
      setEvents: vi.fn(),
      setExpectSfu: vi.fn(),
      setPassiveParticipantHints: vi.fn(),
      getParticipants: () => [],
      getRemoteTracks: () => [],
      getPeerConnectionStates: () => ({}),
      getLocalTracks: () => ({ mic: null, camera: null, screen: null }),
    };
    voiceHarness.voiceClientCtor(channelId);
    return client;
  }),
}));

vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridge: async () => bridgeHarness.bridge,
}));

vi.mock('@/lib/nostr-bridge', () => ({
  useGroups: () => bridgeHarness.groups,
  useCurrentRelayUrl: () => 'wss://relay.test',
  useUserMetadata: (pubkey: string) => bridgeHarness.profiles[pubkey] ?? null,
  useActiveCall: (channelId: string | null) => (channelId ? bridgeHarness.activeCalls[channelId] ?? null : null),
}));

function makeActiveClient(channelId: string) {
  return {
    channelId,
    isJoined: () => true,
    leave: vi.fn(async () => {}),
    setEvents: vi.fn(),
    setExpectSfu: vi.fn(),
    setPassiveParticipantHints: vi.fn(),
    getParticipants: () => [],
    getRemoteTracks: () => [],
    getPeerConnectionStates: () => ({}),
    getLocalTracks: () => ({ mic: null, camera: null, screen: null }),
  };
}

beforeEach(() => {
  bridgeHarness.groups = [
    { id: 'old-voice', name: 'Old Voice', kind: 'voice', isOpen: true },
    { id: 'new-voice', name: 'New Voice', kind: 'voice-sfu', isOpen: true },
  ];
  bridgeHarness.activeCalls = {};
  bridgeHarness.profiles = {};
  bridgeHarness.bridge = {
    getPublicKey: () => 'me-pubkey',
    subscribeGroups: (cb: (groups: typeof bridgeHarness.groups) => void) => { cb(bridgeHarness.groups); return vi.fn(); },
    subscribeMembers: (_channelId: string, cb: (members: readonly string[]) => void) => { cb([]); return vi.fn(); },
    subscribeAdmins: (_channelId: string, cb: (admins: readonly string[]) => void) => { cb([]); return vi.fn(); },
    subscribeMembershipReady: (_channelId: string, cb: (ready: boolean) => void) => { cb(true); return vi.fn(); },
  };
  voiceHarness.activeClient = null;
  voiceHarness.setActiveVoiceClient.mockClear();
  voiceHarness.voiceClientCtor.mockClear();
  useVoiceStore.setState({
    currentVoiceChannelId: null,
    currentVoiceRelayUrl: null,
    isMuted: true,
    isDeafened: false,
    isCameraOn: false,
    isScreenSharing: false,
    isConnecting: false,
    error: null,
    peerQuality: {},
    speakingPubkeys: {},
    localMutedPubkeys: {},
  });
});

afterEach(() => {
  cleanup();
});

describe('VoiceRoom join page', () => {
  it('does not leave the current call when browsing a different voice channel', async () => {
    const active = makeActiveClient('old-voice');
    voiceHarness.activeClient = active;
    useVoiceStore.setState({ currentVoiceChannelId: 'old-voice' });

    const { rerender } = render(<VoiceRoom channelId="old-voice" channelName="Old Voice" />);
    expect(await screen.findByTestId('voice-controls')).toBeInTheDocument();

    rerender(<VoiceRoom channelId="new-voice" channelName="New Voice" />);
    expect(await screen.findByTestId('join-voice-btn')).toBeInTheDocument();

    expect(active.leave).not.toHaveBeenCalled();
    expect(voiceHarness.voiceClientCtor).not.toHaveBeenCalledWith('new-voice');
    expect(screen.getByText(/stay connected to your current call/i)).toBeInTheDocument();
  });

  it('passes detected mesh occupants into the media client immediately on join', async () => {
    bridgeHarness.activeCalls['old-voice'] = {
      hostPubkey: 'peer-a',
      status: 'active',
      participantCount: 2,
      expiresAt: Math.floor(Date.now() / 1000) + 90,
      createdAt: Math.floor(Date.now() / 1000),
      mode: 'mesh',
      participantPubkeys: ['me-pubkey', 'peer-a'],
    };

    render(<VoiceRoom channelId="old-voice" channelName="Old Voice" />);

    fireEvent.click(await screen.findByTestId('join-voice-btn'));
    expect(await screen.findByTestId('voice-controls')).toBeInTheDocument();

    await waitFor(() => {
      expect(voiceHarness.activeClient?.setPassiveParticipantHints).toHaveBeenCalledWith(['me-pubkey', 'peer-a']);
    });
  });

  it('renders passive SFU or mesh occupants on the join page without connecting', async () => {
    bridgeHarness.activeCalls['new-voice'] = {
      hostPubkey: 'sfu-pubkey',
      status: 'active',
      participantCount: 2,
      expiresAt: Math.floor(Date.now() / 1000) + 90,
      createdAt: Math.floor(Date.now() / 1000),
      mode: 'sfu',
      participantPubkeys: ['peer-a', 'peer-b'],
    };
    bridgeHarness.profiles['peer-a'] = { displayName: 'Ada' };
    bridgeHarness.profiles['peer-b'] = { name: 'Ben' };

    render(<VoiceRoom channelId="new-voice" channelName="New Voice" />);

    expect(await screen.findByTestId('join-voice-btn')).toBeInTheDocument();
    expect(screen.getByText('2 people are in this call.')).toBeInTheDocument();
    expect(screen.getByTestId('passive-call-roster')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Ben')).toBeInTheDocument();
    expect(voiceHarness.voiceClientCtor).not.toHaveBeenCalled();
  });
});
