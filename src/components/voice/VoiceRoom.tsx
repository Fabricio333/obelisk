'use client';

/**
 * Voice channel room. Owns one VoiceClient and renders a stage layout:
 *  - When someone is sharing screen, the share takes the canvas and cams
 *    collapse to a side rail (desktop) / horizontal strip (mobile).
 *  - Otherwise, video tiles fill the canvas in a responsive grid.
 *  - Audio-only participants show as a compact horizontal strip.
 *  - A floating control pill sits over the stage.
 *
 * Authorization: subscribes to NIP-29 admins (39001) and members (39002).
 *
 * Background-call wiring: on join we register the client in the active-client
 * singleton and mirror local-track / connection state into `useVoiceStore`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { VoiceClient, type RemoteTrack } from '@/lib/voice/client';
import { setActiveVoiceClient, getActiveVoiceClient } from '@/lib/voice/active-client';
import { getBridge } from '@/lib/nostr-bridge/client';
import type { BridgeImpl } from '@/lib/nostr-bridge/client';
import { useVoiceStore } from '@/store/voice';
import { useActiveCall, useGroups, useCurrentRelayUrl } from '@/lib/nostr-bridge';
import { useUserMetadata as useProfile } from '@/lib/nostr-bridge';
import { ensureSfuRoomStarted } from '@/lib/voice/sfu-control';
import { shouldUseSfuTopology } from '@/lib/voice/topology';
import VoiceControls from './VoiceControls';
import { DebugOverlay } from './DebugOverlay';
import ShootingStars from '@/components/ShootingStars';
import { qualityColor, type QualitySample } from '@/lib/voice/stats';
import { toggleFullscreen, useFullscreenState } from './fullscreen';

interface Props {
  channelId: string;
  channelName?: string;
  chatSlot?: React.ReactNode;
  isChatOpen?: boolean;
  onToggleChat?: () => void;
}

type AuthGate =
  | { phase: 'init' }
  | { phase: 'loading-roles' }
  | { phase: 'not-a-member' }
  | { phase: 'ready'; members: readonly string[]; admins: readonly string[]; open: boolean };

export default function VoiceRoom({ channelId, channelName, chatSlot, isChatOpen, onToggleChat }: Props) {
  const router = useRouter();
  const groups = useGroups();
  const currentRelayUrl = useCurrentRelayUrl();
  const channelKind = useMemo(
    () => groups.find((g) => g.id === channelId)?.kind ?? null,
    [groups, channelId],
  );
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const activeCall = useActiveCall(channelId);
  const expectSfu = useMemo(
    () => shouldUseSfuTopology(channelKind, activeCall?.mode),
    [channelKind, activeCall?.mode],
  );
  const clientRef = useRef<VoiceClient | null>(null);
  const [gate, setGate] = useState<AuthGate>({ phase: 'init' });
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrack[]>([]);
  const [peerConnectionStates, setPeerConnectionStates] = useState<Record<string, RTCPeerConnectionState>>({});
  const [local, setLocal] = useState<{ mic: boolean; camera: boolean; screen: boolean }>({ mic: false, camera: false, screen: false });
  const [selfPubkey, setSelfPubkey] = useState<string>('');
  // Pinned participant — when set, that person's screen (preferred) or camera
  // takes the main stage and everyone else collapses to the rail. Any user can
  // pin/unpin from any tile.
  const [pinned, setPinned] = useState<string | null>(null);
  const [joinedChannelId, setJoinedChannelId] = useState<string | null>(() => {
    const c = getActiveVoiceClient();
    return c && c.isJoined() ? c.channelId : null;
  });
  const joined = joinedChannelId === channelId;

  /**
   * SFU upgrade status for the current call. Distinct from voice-client
   * mesh/sfu topology because it also captures the pre-connect states the
   * UI needs to display:
   *
   *   - 'na'           — channel is not voice-sfu (no banner)
   *   - 'starting'     — kind 25052 published, waiting for SFU's beacon
   *   - 'connected'    — SFU peer in roster, media routes through it
   *   - 'unavailable'  — no kind 31313 advertisement found; mesh fallback
   *   - 'unauthorized' — start published but SFU never joined within
   *                      the watchdog window — likely the publisher is
   *                      not whitelisted on the SFU's trusted-author relay
   */
  const [sfuStatus, setSfuStatus] = useState<
    'na' | 'starting' | 'connected' | 'unavailable' | 'unauthorized'
  >('na');
  /**
   * Republish trigger — incremented by `onTopologyChange` when an SFU
   * peer drops out of the roster after we'd been connected to it. The
   * supervisor effect watches this and re-publishes kind 25052 (with
   * force=true so the rate-limit doesn't swallow the recovery), so a
   * brief SFU restart is recovered without the user having to rejoin.
   */
  const [sfuRepublishCounter, setSfuRepublishCounter] = useState(0);

  useEffect(() => {
    if (joined) return;
    clientRef.current = null;
    setParticipants([]);
    setRemoteTracks([]);
    setPeerConnectionStates({});
    setLocal({ mic: false, camera: false, screen: false });
    setPinned(null);
  }, [channelId, joined]);

  // Phase 1 — bridge + role subscriptions, gate decision.
  useEffect(() => {
    let cancelled = false;
    let bridgeRef: BridgeImpl | null = null;
    let unsubMembers: (() => void) | null = null;
    let unsubAdmins: (() => void) | null = null;
    let unsubReady: (() => void) | null = null;

    let latestMembers: readonly string[] = [];
    let latestAdmins: readonly string[] = [];
    let membershipReady = false;
    let isOpen = false;
    let unsubGroups: (() => void) | null = null;
    let resolveTimer: ReturnType<typeof setTimeout> | null = null;

    setGate({ phase: 'loading-roles' });

    (async () => {
      try {
        const bridge = await getBridge();
        if (cancelled) return;
        bridgeRef = bridge;
        const pk = bridge.getPublicKey();
        if (!pk) {
          setError('You must be logged in to join voice.');
          return;
        }
        setSelfPubkey(pk);

        const decide = () => {
          if (cancelled) return;
          // Push live state into the running client. setOpen is critical:
          // if the channel's `["open"]` flag arrives after the client was
          // constructed, without this the local user sees nobody but
          // themselves because subscribeRoster's filter drops every remote
          // pubkey that isn't in the (still-empty) member set.
          clientRef.current?.setOpen(isOpen);
          clientRef.current?.updateRoles(latestMembers, latestAdmins);
          // Open channels (NIP-29 `["open"]` tag on kind 39000) admit
          // anyone — gating those on member/admin presence forces the
          // "not a member" screen for users who joined via the open flow
          // without an explicit kind 9000 ever landing on this relay.
          if (isOpen || latestMembers.includes(pk) || latestAdmins.includes(pk)) {
            setGate({ phase: 'ready', members: latestMembers, admins: latestAdmins, open: isOpen });
          } else {
            setGate({ phase: 'not-a-member' });
          }
        };

        // Resolve immediately on a positive match (or open channel).
        // Otherwise wait for the bridge's "membership ready" signal —
        // flipped to true the first time the relay delivers a 39001 or
        // 39002 event for this group. Without that signal, an empty list
        // could mean "not loaded yet" (slow NIP-42 round-trip) just as
        // easily as "user is not a member", and falsely flipping to
        // "not-a-member" is what forces the refresh-loop UX.
        const tryResolve = () => {
          if (cancelled) return;
          if (isOpen || latestMembers.includes(pk) || latestAdmins.includes(pk)) {
            decide();
            return;
          }
          if (membershipReady) decide();
        };

        unsubGroups = bridge.subscribeGroups((groups) => {
          const next = groups.find((g) => g.id === channelId)?.isOpen ?? false;
          if (next === isOpen) return;
          isOpen = next;
          tryResolve();
        });
        unsubMembers = bridge.subscribeMembers(channelId, (members) => {
          latestMembers = members;
          tryResolve();
        });
        unsubAdmins = bridge.subscribeAdmins(channelId, (admins) => {
          latestAdmins = admins;
          tryResolve();
        });
        unsubReady = bridge.subscribeMembershipReady(channelId, (ready) => {
          membershipReady = ready;
          tryResolve();
        });

        // Hard ceiling: if nothing came back at all after 12s, surface an
        // error so the user isn't stuck on a silent spinner.
        resolveTimer = setTimeout(() => {
          if (cancelled) return;
          if (!membershipReady) {
            setError('Could not load channel membership. Is this a valid channel id?');
          }
        }, 12000);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) setError(msg);
      }
    })();

    return () => {
      cancelled = true;
      if (resolveTimer) clearTimeout(resolveTimer);
      unsubGroups?.();
      unsubMembers?.();
      unsubAdmins?.();
      unsubReady?.();
      void bridgeRef;
    };
  }, [channelId]);

  // Phase 2 — once gated AND joined, attach to/start the call.
  useEffect(() => {
    if (gate.phase !== 'ready') return;
    if (!joined) return;
    let cancelled = false;
    const store = useVoiceStore.getState();
    store.setError(null);

    const events = {
      onParticipantsChange: (p: string[]) => { if (!cancelled) setParticipants(p); },
      onRemoteTracksChange: (t: RemoteTrack[]) => { if (!cancelled) setRemoteTracks(t); },
      onPeerConnectionStatesChange: (states: Record<string, RTCPeerConnectionState>) => {
        if (!cancelled) setPeerConnectionStates(states);
      },
      onLocalTracksChange: (l: { mic: boolean; camera: boolean; screen: boolean }) => {
        if (cancelled) return;
        setLocal(l);
        const s = useVoiceStore.getState();
        s.setMuted(!l.mic);
        s.setCameraOn(l.camera);
        s.setScreenSharing(l.screen);
      },
      onTopologyChange: (sfu: string | null) => {
        if (cancelled) return;
        // Only voice-sfu channels are tracking SFU upgrade status; for
        // a plain voice channel an SFU showing up wouldn't make sense
        // anyway, but keep the state machine local to that channel kind.
        if (!expectSfu) return;
        if (sfu) {
          setSfuStatus('connected');
          // Clear any stale connection error from a prior failed attempt.
          // If we got here, SfuClient.start resolved — the "rpc timeout"
          // / "Could not connect to the SFU" toast it produced is no
          // longer accurate, but nothing else clears it (the supervisor
          // retries silently and the user is left staring at a red
          // banner during a working call).
          setError(null);
          useVoiceStore.getState().setError(null);
        } else {
          // Topology dropped back to mesh — most likely the SFU restarted
          // or its beacon expired. Trigger a republish so a transient
          // outage doesn't strand the channel on mesh until everyone
          // rejoins. The supervisor handles the actual publish (with
          // force=true to bypass the rate-limit).
          setSfuStatus((prev) => (prev === 'connected' ? 'starting' : prev));
          setSfuRepublishCounter((n) => n + 1);
        }
      },
      onError: (m: string) => {
        if (cancelled) return;
        setError(m);
        useVoiceStore.getState().setError(m);
      },
    };

    const existing = getActiveVoiceClient();
    if (existing && existing.channelId === channelId && existing.isJoined()) {
      existing.setEvents(events);
      // Reapply expected-topology so a channel-kind reclassification
      // mid-call (admin republished kind 39000 with/without
      // ["t","voice-sfu"]) flips the live client immediately.
      existing.setExpectSfu(expectSfu);
      if (activeCall?.mode === 'mesh') {
        existing.setPassiveParticipantHints(activeCall.participantPubkeys ?? []);
      } else {
        existing.setPassiveParticipantHints([]);
      }
      clientRef.current = existing;
      setParticipants(existing.getParticipants());
      setRemoteTracks(existing.getRemoteTracks());
      setPeerConnectionStates(existing.getPeerConnectionStates());
      const tracks = existing.getLocalTracks();
      const localState = { mic: !!tracks.mic, camera: !!tracks.camera, screen: !!tracks.screen };
      setLocal(localState);
      const s = useVoiceStore.getState();
      s.setMuted(!localState.mic);
      s.setCameraOn(localState.camera);
      s.setScreenSharing(localState.screen);
      s.setVoiceChannel(channelId, currentRelayUrl);
      s.setConnecting(false);
      return () => {
        cancelled = true;
        if (clientRef.current === existing) {
          existing.setEvents({});
          clientRef.current = null;
        }
      };
    }

    // Hand off the prior client's leave promise into the async IIFE so we
    // can await it BEFORE constructing the next VoiceClient — pre-fix the
    // void-leave fired and we immediately raced into the new join while
    // the old client's transports + leave RPC were still settling. Net
    // effect: the SFU saw a new peerJoined for the new room while still
    // holding the old peer entry for the prior room, doubling everyone's
    // beacon-discovery roster work and (in the worst case) leaving stale
    // peer entries until the empty-grace / RTP reaper caught up.
    const priorLeave = (existing && existing.channelId !== channelId)
      ? existing.leave()
      : null;
    if (priorLeave) setActiveVoiceClient(null);

    store.setConnecting(true);
    let client: VoiceClient | null = null;

    (async () => {
      try {
        if (priorLeave) {
          // Bound the wait so a hung leave (dead relay, slow signer)
          // can't deadlock the UI. Past the budget the new join goes
          // ahead and the SFU's RTP-inactivity reaper or empty-grace
          // timer cleans up the prior room.
          await Promise.race([
            priorLeave.catch(() => undefined),
            new Promise<void>((r) => setTimeout(r, 800)),
          ]);
          if (cancelled) return;
        }
        client = new VoiceClient(channelId, {
          members: gate.members,
          admins: gate.admins,
          open: gate.open,
          expectSfu: expectSfu,
          originRelayUrl: currentRelayUrl,
          events,
        });
        clientRef.current = client;
        setActiveVoiceClient(client);
        if (activeCall?.mode === 'mesh') {
          client.setPassiveParticipantHints(activeCall.participantPubkeys ?? []);
        }
        await client.join();
        if (cancelled) return;
        const s = useVoiceStore.getState();
        s.setVoiceChannel(channelId, currentRelayUrl);
        s.setConnecting(false);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!cancelled) {
          setError(msg);
          useVoiceStore.getState().setError(msg);
          useVoiceStore.getState().setConnecting(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (clientRef.current) {
        clientRef.current.setEvents({});
        clientRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gate.phase, channelId, joined, expectSfu]);

  // Feed the joined mesh client with the same passive live-call roster used
  // by the pre-join UI. This gives mesh bootstrap a second source when an
  // ephemeral roster REQ misses a beacon but the bridge-level call detector
  // has already seen it.
  useEffect(() => {
    const c = clientRef.current ?? getActiveVoiceClient();
    if (!joined || !c || c.channelId !== channelId) return;
    if (typeof c.setPassiveParticipantHints !== 'function') return;
    if (activeCall?.mode === 'mesh') {
      c.setPassiveParticipantHints(activeCall.participantPubkeys ?? []);
    } else {
      c.setPassiveParticipantHints([]);
    }
  }, [joined, channelId, activeCall?.mode, activeCall?.participantPubkeys]);

  // Mirror channel-kind reclassifications into the running voice client.
  // If the admin republishes kind 39000 toggling ["t","voice-sfu"] while
  // a call is live, this flips the client's topology gate without forcing
  // anyone to leave the call. Kept thin (just clientRef.current?.set…)
  // because the actual peer reconciliation lives in setExpectSfu →
  // setSfuMode → handleRoster's wanted/peers diff.
  useEffect(() => {
    const c = clientRef.current ?? getActiveVoiceClient();
    if (!c || c.channelId !== channelId) return;
    c.setExpectSfu(expectSfu);
  }, [expectSfu, channelId]);

  // SFU supervisor — owns the publish/retry/republish lifecycle for
  // `voice-sfu` channels. Re-runs whenever the user joins, the channel
  // kind flips to voice-sfu, or the topology drops back to mesh
  // (signaled by `sfuRepublishCounter`).
  //
  // Lifecycle for one supervisor invocation:
  //   1. Publish kind 25052 `start` (rate-limited on first attempt;
  //      forced on retries / republishes so a brief SFU outage isn't
  //      stranded by the cooldown).
  //   2. Arm an 8 s watchdog. The SFU's `["sfu","1"]` beacon flips
  //      `onTopologyChange` to 'connected', which clears state via
  //      a separate path. If the watchdog fires while still 'starting'
  //      we retry up to MAX_ATTEMPTS times with linear backoff before
  //      giving up with 'unauthorized'.
  //   3. If discovery returns no SFU we set 'unavailable' and try
  //      again every UNAVAILABLE_RETRY_MS — an SFU coming online later
  //      should heal the channel without a rejoin.
  //
  // The `onTopologyChange` handler is the inbound signal:
  //   - sfu === <pubkey>  → setSfuStatus('connected') (no work here)
  //   - sfu === null after being connected → bumps republish counter,
  //     this effect re-runs with `force` semantics already baked in.
  useEffect(() => {
    if (gate.phase !== 'ready') return;
    if (!joined) return;
    if (!expectSfu) {
      setSfuStatus('na');
      return;
    }
    let cancelled = false;
    let attempt = 0;
    const MAX_ATTEMPTS = 3;
    const SFU_JOIN_WATCHDOG_MS = 25000;
    const RETRY_BACKOFF_MS = [5000, 10000];
    const UNAVAILABLE_RETRY_MS = 15000;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let retryDelay: ReturnType<typeof setTimeout> | null = null;

    const clearTimers = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      if (retryDelay) { clearTimeout(retryDelay); retryDelay = null; }
    };

    const tryStart = async (force: boolean) => {
      if (cancelled) return;
      clearTimers();
      // Don't drop a 'connected' label back to 'starting' while we
      // republish in the background — the topology event will flip it
      // if the SFU actually disappeared.
      setSfuStatus((prev) => (prev === 'connected' ? prev : 'starting'));
      let sfuPubkey: string | null = null;
      try {
        sfuPubkey = await ensureSfuRoomStarted(channelId, undefined, { force });
      } catch (err) {
        console.warn('[voice] ensureSfuRoomStarted threw', err);
      }
      if (cancelled) return;
      if (!sfuPubkey) {
        console.warn('[voice] no sfu available — mesh fallback; retrying in',
          UNAVAILABLE_RETRY_MS / 1000, 's');
        setSfuStatus((prev) => (prev === 'connected' ? prev : 'unavailable'));
        retryDelay = setTimeout(() => { void tryStart(true); }, UNAVAILABLE_RETRY_MS);
        return;
      }
      console.log('[voice] sfu start published target=', sfuPubkey.slice(0, 8),
        'attempt=', attempt + 1);
      watchdog = setTimeout(() => {
        if (cancelled) return;
        // If the topology callback already flipped us to 'connected', abort
        // the retry loop entirely. Republishing kind 25052 while a session
        // is up makes the SFU reset peer state and kicks the live call.
        setSfuStatus((prev) => {
          if (prev === 'connected') return prev;
          attempt += 1;
          if (attempt < MAX_ATTEMPTS) {
            const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
            console.warn('[voice] sfu beacon never arrived; retrying in', delay / 1000,
              's — attempt', attempt + 1, '/', MAX_ATTEMPTS);
            retryDelay = setTimeout(() => { void tryStart(true); }, delay);
            return prev;
          }
          console.warn('[voice] sfu start gave up after', MAX_ATTEMPTS, 'attempts');
          return 'unauthorized';
        });
      }, SFU_JOIN_WATCHDOG_MS);
    };

    // First entry uses force=false (cheap rate-limit); republish
    // counter changes always force (they're recovery signals).
    void tryStart(sfuRepublishCounter > 0);
    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [gate.phase, joined, expectSfu, channelId, sfuRepublishCounter]);

  const leave = useCallback(async () => {
    const c = clientRef.current ?? getActiveVoiceClient();
    clientRef.current = null;
    if (c) await c.leave();
    setActiveVoiceClient(null);
    useVoiceStore.getState().leaveVoice();
    setJoinedChannelId(null);
    setParticipants([]);
    setRemoteTracks([]);
    setPeerConnectionStates({});
    setLocal({ mic: false, camera: false, screen: false });
  }, []);

  // Mirror externally-driven hangups (e.g. the VoiceStatusBar leave button)
  // back into local state so the room flips to the "Join voice channel"
  // landing instead of staying on a stale connected view.
  useEffect(() => {
    const unsub = useVoiceStore.subscribe((state, prev) => {
      if (prev.currentVoiceChannelId === channelId && state.currentVoiceChannelId !== channelId) {
        clientRef.current = null;
        setJoinedChannelId(null);
        setParticipants([]);
        setRemoteTracks([]);
        setPeerConnectionStates({});
        setLocal({ mic: false, camera: false, screen: false });
      }
    });
    return unsub;
  }, [channelId]);

  const tracksByPubkey = useMemo(() => {
    const m = new Map<string, { audio?: RemoteTrack; camera?: RemoteTrack; screen?: RemoteTrack; screenAudio?: RemoteTrack }>();
    for (const t of remoteTracks) {
      const slot = m.get(t.pubkey) ?? {};
      if (t.kind === 'audio') slot.audio = t;
      else if (t.kind === 'camera') slot.camera = t;
      else if (t.kind === 'screen') slot.screen = t;
      else if (t.kind === 'screen-audio') slot.screenAudio = t;
      m.set(t.pubkey, slot);
    }
    return m;
  }, [remoteTracks]);

  const localCamStream = useMemo(() => {
    const cam = clientRef.current?.getLocalTracks().camera ?? null;
    return cam ? new MediaStream([cam]) : null;
  }, [local]);
  const localScreenStream = useMemo(() => {
    const s = clientRef.current?.getLocalTracks().screen ?? null;
    return s ? new MediaStream([s]) : null;
  }, [local]);

  const videoPubkeys: string[] = [];
  const audioPubkeys: string[] = [];
  if (local.camera) videoPubkeys.push(selfPubkey);
  else audioPubkeys.push(selfPubkey);
  for (const pk of participants) {
    if (tracksByPubkey.get(pk)?.camera) videoPubkeys.push(pk);
    else audioPubkeys.push(pk);
  }

  const screenSharers: { pubkey: string; track: RemoteTrack | null; isLocal: boolean }[] = [];
  if (local.screen && localScreenStream) screenSharers.push({ pubkey: selfPubkey, track: null, isLocal: true });
  for (const pk of participants) {
    const s = tracksByPubkey.get(pk)?.screen;
    if (s) screenSharers.push({ pubkey: pk, track: s, isLocal: false });
  }

  // Resolve the stage:
  //   - If user pinned someone, show their screen (preferred) or camera.
  //   - Else, if anyone is screen-sharing, default to first sharer.
  //   - Else no stage → grid mode.
  const activeStage = useMemo<
    | { pubkey: string; isLocal: boolean; kind: 'screen' | 'camera'; videoStream: MediaStream | null }
    | null
  >(() => {
    const build = (pk: string): { pubkey: string; isLocal: boolean; kind: 'screen' | 'camera'; videoStream: MediaStream | null } | null => {
      const isLocal = pk === selfPubkey;
      const slot = tracksByPubkey.get(pk);
      const hasScreen = isLocal ? !!localScreenStream : !!slot?.screen;
      if (hasScreen) {
        return {
          pubkey: pk,
          isLocal,
          kind: 'screen',
          videoStream: isLocal ? localScreenStream : (slot?.screen?.stream ?? null),
        };
      }
      const hasCam = isLocal ? !!localCamStream : !!slot?.camera;
      if (hasCam) {
        return {
          pubkey: pk,
          isLocal,
          kind: 'camera',
          videoStream: isLocal ? localCamStream : (slot?.camera?.stream ?? null),
        };
      }
      return null;
    };

    if (pinned) {
      const s = build(pinned);
      if (s) return s;
    }
    if (screenSharers.length > 0) {
      const first = screenSharers[0];
      return {
        pubkey: first.pubkey,
        isLocal: first.isLocal,
        kind: 'screen',
        videoStream: first.isLocal ? localScreenStream : (first.track?.stream ?? null),
      };
    }
    return null;
  }, [pinned, screenSharers, tracksByPubkey, selfPubkey, localCamStream, localScreenStream]);

  const meshSyncingCount = useMemo(() => {
    if (!joined || expectSfu) return 0;
    let count = 0;
    for (const pk of participants) {
      if (peerConnectionStates[pk] !== 'connected') count += 1;
    }
    return count;
  }, [joined, expectSfu, participants, peerConnectionStates]);

  if (gate.phase === 'init' || gate.phase === 'loading-roles') {
    return (
      <CenteredPanel>
        <Spinner />
        <div className="mt-3 text-sm text-neutral-300">Loading channel membership…</div>
        <div className="mt-1 font-mono text-xs text-neutral-500 break-all">{channelId}</div>
        {error && <div className="mt-3 text-xs text-red-400">{error}</div>}
      </CenteredPanel>
    );
  }
  if (gate.phase === 'not-a-member') {
    return (
      <CenteredPanel>
        <div className="text-lg font-semibold">You aren&apos;t a member of this channel.</div>
        <div className="mt-2 text-sm text-neutral-400">Ask an admin to add you, then refresh this page.</div>
        <div className="mt-4 font-mono text-xs text-neutral-500 break-all">{channelId}</div>
        <button
          onClick={() => router.push('/app')}
          className="mt-6 px-4 py-2 rounded-full bg-neutral-800 hover:bg-neutral-700 text-sm"
        >
          Back
        </button>
      </CenteredPanel>
    );
  }

  const totalCount = participants.length + 1;
  const displayName = channelName ?? `${channelId.slice(0, 16)}…`;
  const passiveParticipantPubkeys = activeCall?.participantPubkeys ?? [];
  const passiveCount = activeCall
    ? Math.max(
        activeCall.participantCount > 0 ? activeCall.participantCount : 0,
        passiveParticipantPubkeys.length,
      )
    : 0;
  const browsingWhileConnected = !!currentVoiceChannelId && currentVoiceChannelId !== channelId;

  if (!joined) {
    return (
      <div className="relative flex-1 flex min-h-0 p-2 sm:p-3 gap-2" data-testid="voice-channel">
        <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden rounded-2xl border border-lc-border bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-800 shadow-2xl">
          <StageBackdrop />
          <RoomHeader name={displayName} count={passiveCount} />
          <div className="relative z-10 flex-1 flex items-center justify-center p-6">
            <div className="text-center max-w-md">
              <div className="mx-auto mb-5 w-16 h-16 rounded-2xl bg-lc-green/10 ring-1 ring-lc-green/30 flex items-center justify-center text-lc-green">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </div>
              <div className="text-xl font-semibold text-lc-white mb-1">{displayName}</div>
              <div className="text-sm text-lc-muted mb-5">
                {passiveCount > 0
                  ? passiveCount + ' ' + (passiveCount === 1 ? 'person is' : 'people are') + ' in this call.'
                  : activeCall
                    ? 'This call is live.'
                    : 'No one is detected in this call yet.'}
                {browsingWhileConnected && (
                  <span className="block mt-1 text-lc-white/70">You will stay connected to your current call until you join this one.</span>
                )}
              </div>
              <PassiveCallRoster
                pubkeys={passiveParticipantPubkeys}
                count={passiveCount}
                mode={activeCall?.mode}
              />
              <button
                onClick={() => setJoinedChannelId(channelId)}
                className="mt-6 bg-lc-green hover:bg-lc-green/90 text-lc-black px-6 py-2.5 rounded-full text-sm font-semibold transition-colors shadow-lg shadow-lc-green/20"
                data-testid="join-voice-btn"
              >
                Join voice channel
              </button>
              {error && <div className="mt-4 text-xs text-red-300">{error}</div>}
            </div>
          </div>
        </div>
        {chatSlot && isChatOpen && (
          <div className="contents max-md:!block max-md:absolute max-md:inset-0 max-md:z-30 max-md:bg-lc-black/80 max-md:backdrop-blur-sm">
            {chatSlot}
          </div>
        )}
      </div>
    );
  }

  const hasStage = !!activeStage;
  const debugOverlay = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('debug') === 'voice';

  return (
    <div className="relative flex-1 flex min-h-0 p-2 sm:p-3 gap-2" data-testid="voice-channel">
      {debugOverlay && <DebugOverlay />}
      <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden rounded-2xl border border-lc-border bg-gradient-to-br from-indigo-950 via-indigo-900 to-violet-800 shadow-2xl">
        <StageBackdrop />
        <RoomHeader name={displayName} count={totalCount} sfuStatus={sfuStatus} meshSyncingCount={meshSyncingCount} />

        {/* Stage area */}
        <div className="relative z-10 flex-1 min-h-0 flex flex-col md:flex-row gap-2 sm:gap-3 p-2 sm:p-3 pb-24 sm:pb-28 overflow-hidden">
          {hasStage ? (
            <>
              {/* Main stage */}
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                <Stage
                  pubkey={activeStage!.pubkey}
                  isLocal={activeStage!.isLocal}
                  kind={activeStage!.kind}
                  videoStream={activeStage!.videoStream}
                  pinned={pinned === activeStage!.pubkey}
                  onTogglePin={() => setPinned((p) => (p === activeStage!.pubkey ? null : activeStage!.pubkey))}
                />
              </div>

              {/* Side rail (desktop) / bottom strip (mobile) — everyone, click to pin */}
              <ScrollableRail>
                {videoPubkeys.map((pk) => (
                  <RailVideoTile
                    key={pk}
                    pubkey={pk}
                    isLocal={pk === selfPubkey}
                    videoStream={pk === selfPubkey ? localCamStream : (tracksByPubkey.get(pk)?.camera?.stream ?? null)}
                    isPinned={pinned === pk}
                    isStage={activeStage!.pubkey === pk}
                    onClick={() => setPinned((p) => (p === pk ? null : pk))}
                  />
                ))}
                {audioPubkeys.map((pk) => (
                  <RailAudioTile
                    key={pk}
                    pubkey={pk}
                    isLocal={pk === selfPubkey}
                  />
                ))}
              </ScrollableRail>
            </>
          ) : (
            /* No screen-share: tiled video grid + audio strip */
            <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
              {videoPubkeys.length > 0 && (
                <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center" data-testid="video-grid">
                  {videoPubkeys.length === 1 ? (
                    <div className="max-w-full max-h-full aspect-video w-auto h-full">
                      <VideoTile
                        pubkey={videoPubkeys[0]}
                        isLocal={videoPubkeys[0] === selfPubkey}
                        videoStream={videoPubkeys[0] === selfPubkey ? localCamStream : (tracksByPubkey.get(videoPubkeys[0])?.camera?.stream ?? null)}
                        onPin={() => setPinned(videoPubkeys[0])}
                        fit="contain"
                        fillParent
                      />
                    </div>
                  ) : (
                    <div
                      className={
                        'grid gap-2 sm:gap-3 w-full h-full auto-rows-fr min-h-0 ' +
                        (videoPubkeys.length === 2
                          ? 'grid-cols-1 sm:grid-cols-2'
                          : videoPubkeys.length === 3
                            ? 'grid-cols-1 sm:grid-cols-3'
                            : videoPubkeys.length === 4
                              ? 'grid-cols-2'
                              : 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4')
                      }
                    >
                      {videoPubkeys.map((pk) => (
                        <VideoTile
                          key={pk}
                          pubkey={pk}
                          isLocal={pk === selfPubkey}
                          videoStream={pk === selfPubkey ? localCamStream : (tracksByPubkey.get(pk)?.camera?.stream ?? null)}
                          onPin={() => setPinned(pk)}
                          fit="cover"
                          fillParent
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {audioPubkeys.length > 0 && videoPubkeys.length === 0 && (
                <div className="flex-1 min-h-0 flex items-center justify-center" data-testid="audio-participants">
                  <div
                    className={
                      'grid gap-3 sm:gap-4 ' +
                      (audioPubkeys.length === 1
                        ? 'grid-cols-1'
                        : audioPubkeys.length === 2
                          ? 'grid-cols-2'
                          : audioPubkeys.length <= 4
                            ? 'grid-cols-2 sm:grid-cols-2'
                            : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4')
                    }
                  >
                    {audioPubkeys.map((pk) => (
                      <AudioTile
                        key={pk}
                        pubkey={pk}
                        isLocal={pk === selfPubkey}
                      />
                    ))}
                  </div>
                </div>
              )}

              {audioPubkeys.length > 0 && videoPubkeys.length > 0 && (
                <div className="shrink-0 flex gap-2 overflow-x-auto pb-1" data-testid="audio-participants">
                  {audioPubkeys.map((pk) => (
                    <AudioChip
                      key={pk}
                      pubkey={pk}
                      isLocal={pk === selfPubkey}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Floating control pill */}
        <div className="absolute left-0 right-0 bottom-3 sm:bottom-4 z-20 flex justify-center pointer-events-none px-2">
          <VoiceControls onLeave={leave} isChatOpen={isChatOpen} onToggleChat={onToggleChat} />
        </div>
      </div>

      {chatSlot && isChatOpen && (
        <div className="contents max-md:!block max-md:absolute max-md:inset-0 max-md:z-30 max-md:bg-lc-black/80 max-md:backdrop-blur-sm">
          {chatSlot}
        </div>
      )}
    </div>
  );
}

// ---- Sub-components ------------------------------------------------------

function PassiveCallRoster({ pubkeys, count, mode }: {
  pubkeys: readonly string[];
  count: number;
  mode?: 'sfu' | 'mesh';
}) {
  if (count <= 0 && pubkeys.length === 0) return null;
  const visible = pubkeys.slice(0, 6);
  const hidden = Math.max(0, count - visible.length);
  const topology = mode === 'sfu' ? 'SFU' : mode === 'mesh' ? 'Mesh' : 'Live';
  return (
    <div
      className="mx-auto mb-1 w-full rounded-xl border border-white/10 bg-black/25 px-3 py-3 text-left"
      data-testid="passive-call-roster"
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-lc-muted">
        <span>In Call</span>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-lc-white/75">{topology}</span>
      </div>
      {visible.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {visible.map((pk) => <PassiveCallParticipant key={pk} pubkey={pk} />)}
          {hidden > 0 && (
            <span className="inline-flex min-w-0 items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-lc-muted">
              +{hidden} more
            </span>
          )}
        </div>
      ) : (
        <div className="text-xs text-lc-muted">
          {count > 0 ? count + ' participant' + (count === 1 ? '' : 's') + ' detected; roster names are still syncing.' : 'Roster is syncing.'}
        </div>
      )}
    </div>
  );
}

function PassiveCallParticipant({ pubkey }: { pubkey: string }) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  return (
    <span
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs text-lc-white/85"
      data-testid="passive-call-participant"
      title={pubkey}
    >
      <Avatar pubkey={pubkey} picture={meta?.picture} name={name} size={5} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function StageBackdrop() {
  return (
    <>
      {/* Matrix grid overlay — restored from the legacy VoiceChannel look. */}
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        aria-hidden
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />
      <div className="absolute inset-0 z-0 pointer-events-none" aria-hidden>
        <ShootingStars contained count={8} />
      </div>
      <div
        className="absolute inset-0 z-0 opacity-60 pointer-events-none"
        aria-hidden
        style={{
          background:
            'radial-gradient(60% 50% at 50% 0%, rgba(180,249,83,0.05), transparent 70%), radial-gradient(50% 40% at 100% 100%, rgba(99,102,241,0.10), transparent 70%)',
        }}
      />
    </>
  );
}

/**
 * Compact SFU-status pill rendered between the room name and the
 * participant count inside RoomHeader. Tooltip carries the long-form
 * detail. The intent is that a user creating a Big-room voice call
 * never has to wonder whether they're actually getting SFU forwarding
 * or silently dropped to the 8-peer mesh — without occupying its own
 * row of chrome.
 *
 * Plain voice / non-sfu channels render nothing ('na').
 */
function SfuStatusPill({ status }: {
  status: 'na' | 'starting' | 'connected' | 'unavailable' | 'unauthorized';
}) {
  if (status === 'na') return null;
  const variants = {
    starting: {
      label: 'SFU connecting',
      detail: 'Asking the SFU to open this big-room call.',
      tone: 'bg-amber-500/15 border-amber-400/40 text-amber-100',
      dot: 'bg-amber-300',
      pulse: true,
    },
    connected: {
      label: 'SFU connected',
      detail: 'Big-room mode active — media is routed through the SFU.',
      tone: 'bg-emerald-500/15 border-emerald-400/40 text-emerald-100',
      dot: 'bg-emerald-300',
      pulse: false,
    },
    unavailable: {
      label: 'SFU unavailable',
      detail: 'No big-room SFU is advertising. Falling back to peer-to-peer mesh (max 8 participants).',
      tone: 'bg-amber-500/15 border-amber-400/40 text-amber-100',
      dot: 'bg-amber-300',
      pulse: false,
    },
    unauthorized: {
      label: 'SFU rejected',
      detail: 'Big-room start was rejected. Your account may not be whitelisted on the SFU’s trusted relay. Call is on peer-to-peer mesh (max 8 participants).',
      tone: 'bg-rose-500/15 border-rose-400/40 text-rose-100',
      dot: 'bg-rose-300',
      pulse: false,
    },
  } as const;
  const v = variants[status];
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="sfu-status"
      data-sfu-status={status}
      title={v.detail}
      className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium leading-none ${v.tone}`}
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        {v.pulse && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-70 ${v.dot}`} />
        )}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${v.dot}`} />
      </span>
      <span>{v.label}</span>
    </div>
  );
}

export function MeshSyncStatusPill({ count }: { count: number }) {
  if (count <= 0) return null;
  const detail = count === 1
    ? 'Peer detected; WebRTC media channels are still syncing in the background.'
    : count + ' peers detected; WebRTC media channels are still syncing in the background.';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="mesh-sync-status"
      title={detail}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium leading-none whitespace-nowrap bg-amber-500/15 border-amber-400/40 text-amber-100"
    >
      <span className="relative inline-flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-300 opacity-70" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-300" />
      </span>
      <span className="hidden sm:inline">Media syncing</span>
      <span className="sm:hidden">Syncing</span>
      {count > 1 && <span className="tabular-nums text-amber-50/90">{count}</span>}
    </div>
  );
}

function RoomHeader({ name, count, sfuStatus, meshSyncingCount = 0 }: {
  name: string;
  count: number;
  sfuStatus?: 'na' | 'starting' | 'connected' | 'unavailable' | 'unauthorized';
  meshSyncingCount?: number;
}) {
  return (
    <div className="relative z-10 px-3 sm:px-5 py-3 flex items-center gap-3 border-b border-white/5" data-testid="voice-room-header">
      <div className="min-w-0 flex items-center gap-2.5 flex-1 min-w-0">
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lc-green opacity-50" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-lc-green" />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.14em] text-lc-muted leading-none mb-1">Voice channel</div>
          <div className="font-semibold text-lc-white truncate text-sm sm:text-base leading-tight">{name}</div>
        </div>
      </div>
      {/* Compact topology status. SFU channels get the SFU badge; mesh
          channels show a live media-sync badge while peer PCs connect. */}
      <div className="flex justify-center shrink-0">
        {(sfuStatus ?? 'na') !== 'na' ? (
          <SfuStatusPill status={sfuStatus ?? 'na'} />
        ) : (
          <MeshSyncStatusPill count={meshSyncingCount} />
        )}
      </div>
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-xs text-white/80 shrink-0">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span className="tabular-nums">{count}</span>
      </div>
    </div>
  );
}

function Stage({ pubkey, isLocal, kind, videoStream, pinned, onTogglePin }: {
  pubkey: string;
  isLocal: boolean;
  kind: 'screen' | 'camera';
  videoStream: MediaStream | null;
  pinned: boolean;
  onTogglePin: () => void;
}) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const speaking = useTileSpeaking(pubkey);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = videoStream;
    el.muted = true;
    if (!videoStream) return;
    const play = () => { void el.play().catch(() => {}); };
    play();
    el.addEventListener('loadedmetadata', play);
    el.addEventListener('canplay', play);
    for (const track of videoStream.getVideoTracks()) track.addEventListener('unmute', play);
    return () => {
      el.removeEventListener('loadedmetadata', play);
      el.removeEventListener('canplay', play);
      for (const track of videoStream.getVideoTracks()) track.removeEventListener('unmute', play);
    };
  }, [videoStream]);
  const label =
    kind === 'screen'
      ? isLocal ? 'You are presenting' : `${name} is presenting`
      : isLocal ? `You · ${name}` : name;
  return (
    <div
      ref={containerRef}
      className={
        'relative flex-1 min-h-0 rounded-xl overflow-hidden bg-black ring-1 ring-white/10 transition-shadow ' +
        (speaking ? 'ring-2 ring-lc-green shadow-[0_0_24px_rgba(180,249,83,0.4)]' : '')
      }
      data-testid={kind === 'screen' ? 'screen-share-area' : 'video-stage'}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={'w-full h-full object-contain ' + (kind === 'camera' && isLocal ? 'scale-x-[-1]' : '')}
      />
      <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 backdrop-blur text-[11px] text-lc-green border border-lc-green/30">
        <span className="font-medium">{label}</span>
      </div>
      <div className="absolute top-2 right-2 flex items-center gap-1.5">
        {!isLocal && <MuteForMeButton pubkey={pubkey} />}
        <FullscreenButton targetRef={containerRef} />
        <button
          type="button"
          onClick={onTogglePin}
          title={pinned ? 'Unpin' : 'Pin to stage'}
          className={
            'flex items-center gap-1 px-2 py-1 rounded-md text-[11px] backdrop-blur transition-colors ' +
            (pinned
              ? 'bg-lc-green/20 text-lc-green border border-lc-green/40'
              : 'bg-black/60 text-white/80 border border-white/15 hover:bg-black/80')
          }
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 17v5" />
            <path d="M9 10.76V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4.76a2 2 0 0 0 .55 1.39l1.65 1.7A1 1 0 0 1 16.5 15.5h-9A1 1 0 0 1 6.8 13.85l1.65-1.7A2 2 0 0 0 9 10.76z" />
          </svg>
          {pinned ? 'Pinned' : 'Pin'}
        </button>
      </div>
    </div>
  );
}

function VideoTile({ pubkey, isLocal, videoStream, onPin, fit = 'cover', fillParent = false }: {
  pubkey: string;
  isLocal: boolean;
  videoStream: MediaStream | null;
  onPin?: () => void;
  fit?: 'cover' | 'contain';
  fillParent?: boolean;
}) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const speaking = useTileSpeaking(pubkey);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = videoStream;
    el.muted = true;
    if (!videoStream) return;
    const play = () => { void el.play().catch(() => {}); };
    play();
    el.addEventListener('loadedmetadata', play);
    el.addEventListener('canplay', play);
    for (const track of videoStream.getVideoTracks()) track.addEventListener('unmute', play);
    return () => {
      el.removeEventListener('loadedmetadata', play);
      el.removeEventListener('canplay', play);
      for (const track of videoStream.getVideoTracks()) track.removeEventListener('unmute', play);
    };
  }, [videoStream]);

  const fitClass = fit === 'contain' ? 'object-contain bg-black' : 'object-cover';
  // Use a div with role=button so we can host nested controls (mute,
  // fullscreen) — nested <button>s are invalid HTML.
  return (
    <div
      ref={containerRef}
      role={onPin ? 'button' : undefined}
      tabIndex={onPin ? 0 : undefined}
      onClick={onPin}
      onKeyDown={(e) => {
        if (!onPin) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPin(); }
      }}
      className={
        'relative rounded-xl overflow-hidden ring-1 ring-white/10 bg-neutral-950 group text-left transition ' +
        (onPin ? 'cursor-pointer hover:ring-lc-green/40 ' : '') +
        (speaking ? 'ring-2 ring-lc-green ' : '') +
        (fillParent ? 'w-full h-full' : 'w-full aspect-video')
      }
      data-testid="video-tile"
      title={onPin ? 'Pin to stage' : undefined}
    >
      {videoStream ? (
        <video ref={videoRef} autoPlay playsInline muted className={`w-full h-full ${fitClass} ${isLocal ? 'scale-x-[-1]' : ''}`} />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Avatar pubkey={pubkey} picture={meta?.picture} name={name} size={20} speaking={speaking} />
        </div>
      )}
      <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {!isLocal && <MuteForMeButton pubkey={pubkey} />}
        {videoStream && <FullscreenButton targetRef={containerRef} />}
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 py-1.5 flex items-center gap-1.5">
        {!isLocal && <QualityDot pubkey={pubkey} />}
        <span className="text-xs text-white font-medium truncate">{isLocal ? `You · ${name}` : name}</span>
      </div>
    </div>
  );
}

function QualityDot({ pubkey }: { pubkey: string }) {
  const sample = useVoiceStore((s) => s.peerQuality[pubkey]) as QualitySample | undefined;
  const color = qualityColor(sample?.level ?? 'unknown');
  const tooltip = sample
    ? [
        sample.outboundVideoBps != null ? `${Math.round(sample.outboundVideoBps / 1000)} kbps↑` : null,
        sample.rttMs != null ? `${Math.round(sample.rttMs)} ms RTT` : null,
        sample.loss != null ? `${(sample.loss * 100).toFixed(1)}% loss` : null,
      ].filter(Boolean).join(' · ')
    : 'Connecting…';
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      title={`${sample?.level ?? 'unknown'} — ${tooltip}`}
      data-testid="peer-quality-dot"
      data-quality={sample?.level ?? 'unknown'}
    />
  );
}

function ScrollableRail({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // On mobile (<md) the rail scrolls horizontally; on md+ it scrolls vertically.
    const horizontal = window.matchMedia('(max-width: 767px)').matches;
    if (horizontal) {
      setCanPrev(el.scrollLeft > 4);
      setCanNext(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    } else {
      setCanPrev(el.scrollTop > 4);
      setCanNext(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    }
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, [update, children]);

  const scroll = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const horizontal = window.matchMedia('(max-width: 767px)').matches;
    const amount = (horizontal ? el.clientWidth : el.clientHeight) * 0.8 * dir;
    if (horizontal) el.scrollBy({ left: amount, behavior: 'smooth' });
    else el.scrollBy({ top: amount, behavior: 'smooth' });
  };

  return (
    <div className="relative md:w-56 lg:w-64 shrink-0 min-h-0">
      <aside
        ref={ref as React.RefObject<HTMLElement>}
        onScroll={update}
        className="h-full flex md:flex-col gap-2 overflow-x-auto md:overflow-x-visible md:overflow-y-auto pb-1 md:pb-0 scroll-smooth"
      >
        {children}
      </aside>
      {canPrev && (
        <button
          type="button"
          onClick={() => scroll(-1)}
          aria-label="Scroll previous"
          className="absolute z-10 left-1 md:left-1/2 md:-translate-x-1/2 top-1 md:top-1 w-7 h-7 rounded-full bg-black/70 backdrop-blur text-white flex items-center justify-center shadow-lg ring-1 ring-white/15 hover:bg-black/85"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline className="md:hidden" points="15 18 9 12 15 6" />
            <polyline className="hidden md:block" points="18 15 12 9 6 15" />
          </svg>
        </button>
      )}
      {canNext && (
        <button
          type="button"
          onClick={() => scroll(1)}
          aria-label="Scroll next"
          className="absolute z-10 right-1 md:right-auto md:left-1/2 md:-translate-x-1/2 bottom-auto top-1/2 -translate-y-1/2 md:translate-y-0 md:top-auto md:bottom-1 w-7 h-7 rounded-full bg-black/70 backdrop-blur text-white flex items-center justify-center shadow-lg ring-1 ring-white/15 hover:bg-black/85"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline className="md:hidden" points="9 18 15 12 9 6" />
            <polyline className="hidden md:block" points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  );
}

function RailVideoTile({ isPinned, isStage, onClick, ...props }: {
  pubkey: string;
  isLocal: boolean;
  videoStream: MediaStream | null;
  isPinned?: boolean;
  isStage?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={
        'shrink-0 w-40 md:w-full md:max-w-full ' +
        (isStage ? 'ring-2 ring-lc-green rounded-xl' : '') +
        (isPinned ? ' opacity-90' : '')
      }
    >
      <VideoTile {...props} onPin={onClick} />
    </div>
  );
}

function AudioTile({ pubkey, isLocal }: {
  pubkey: string;
  isLocal: boolean;
}) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  const speaking = useTileSpeaking(pubkey);
  return (
    <div
      className={
        'relative aspect-video sm:aspect-square w-44 sm:w-48 rounded-2xl overflow-hidden bg-gradient-to-br from-neutral-900 to-neutral-950 flex flex-col items-center justify-center p-3 transition-shadow group ' +
        (speaking ? 'ring-2 ring-lc-green shadow-[0_0_18px_rgba(180,249,83,0.35)]' : 'ring-1 ring-white/10')
      }
      data-testid="voice-participant"
    >
      <div className={'rounded-full p-1 ' + (isLocal ? 'ring-2 ring-lc-green' : 'ring-1 ring-white/10')}>
        <Avatar pubkey={pubkey} picture={meta?.picture} name={name} size={16} speaking={speaking} />
      </div>
      <div className="mt-2 text-xs text-white font-medium truncate max-w-full flex items-center gap-1.5">
        {!isLocal && <QualityDot pubkey={pubkey} />}
        <span className="truncate">{isLocal ? `You · ${name}` : name}</span>
      </div>
      {!isLocal && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <MuteForMeButton pubkey={pubkey} />
        </div>
      )}
    </div>
  );
}

function RailAudioTile({ pubkey, isLocal }: {
  pubkey: string;
  isLocal: boolean;
}) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  const speaking = useTileSpeaking(pubkey);
  return (
    <div
      className={
        'relative shrink-0 w-40 md:w-full aspect-video rounded-xl bg-neutral-900 flex flex-col items-center justify-center gap-1.5 p-2 group transition-shadow ' +
        (speaking ? 'ring-2 ring-lc-green' : 'ring-1 ring-white/10')
      }
      data-testid="voice-participant"
    >
      <Avatar pubkey={pubkey} picture={meta?.picture} name={name} size={10} speaking={speaking} />
      <span className="text-[11px] text-white/85 truncate max-w-full px-1">{isLocal ? `You · ${name}` : name}</span>
      {!isLocal && (
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <MuteForMeButton pubkey={pubkey} compact />
        </div>
      )}
    </div>
  );
}

function AudioChip({ pubkey, isLocal }: {
  pubkey: string;
  isLocal: boolean;
}) {
  const meta = useProfile(pubkey);
  const name = meta?.displayName || meta?.name || pubkey.slice(0, 8);
  const speaking = useTileSpeaking(pubkey);
  return (
    <div
      className={
        'shrink-0 flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-white/5 transition-shadow ' +
        (speaking ? 'ring-2 ring-lc-green' : 'ring-1 ring-white/10')
      }
      data-testid="voice-participant"
    >
      <Avatar pubkey={pubkey} picture={meta?.picture} name={name} size={6} speaking={speaking} />
      <span className="text-xs text-white/85 truncate max-w-[10rem]">{isLocal ? `You · ${name}` : name}</span>
      {!isLocal && <MuteForMeButton pubkey={pubkey} compact />}
    </div>
  );
}

function Avatar({ pubkey, picture, name, size, speaking = false }: { pubkey: string; picture?: string | null; name: string; size: number; speaking?: boolean }) {
  const px = `${size * 4}px`;
  const speakingClass = speaking ? ' shadow-[0_0_12px_rgba(180,249,83,0.55)]' : '';
  if (picture) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={picture} alt={name} className={'rounded-full object-cover' + speakingClass} style={{ width: px, height: px }} />;
  }
  return (
    <div
      className={'rounded-full bg-gradient-to-br from-lc-olive to-neutral-800 flex items-center justify-center text-lc-green font-semibold ring-1 ring-white/10' + speakingClass}
      style={{ width: px, height: px, fontSize: `${Math.max(12, size * 1.4)}px` }}
    >
      {(name[0] ?? pubkey[0])?.toUpperCase()}
    </div>
  );
}

// ── Hooks: speaking ────────────────────────────────────────────────────

function useTileSpeaking(pubkey: string): boolean {
  return useVoiceStore((s) => !!s.speakingPubkeys[pubkey]);
}

// ── UI atoms: mute-for-me, fullscreen ──────────────────────────────────

function MuteForMeButton({ pubkey, compact = false }: { pubkey: string; compact?: boolean }) {
  const muted = useVoiceStore((s) => !!s.localMutedPubkeys[pubkey]);
  const muteLocally = useVoiceStore((s) => s.muteLocally);
  const unmuteLocally = useVoiceStore((s) => s.unmuteLocally);
  return (
    <button
      type="button"
      onClick={(e) => {
        // Stops the click bubbling to the tile's pin handler.
        e.stopPropagation();
        if (muted) unmuteLocally(pubkey);
        else muteLocally(pubkey);
      }}
      title={muted ? 'Unmute (just for you)' : 'Mute for me only'}
      data-testid="mute-for-me"
      data-muted={muted}
      className={
        'flex items-center justify-center rounded-md backdrop-blur transition-colors ' +
        (compact ? 'w-6 h-6 ' : 'px-2 py-1 ') +
        (muted
          ? 'bg-red-500/20 text-red-300 border border-red-400/40'
          : 'bg-black/60 text-white/80 border border-white/15 hover:bg-black/80')
      }
    >
      <svg width={compact ? 12 : 11} height={compact ? 12 : 11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {muted ? (
          <>
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
            <path d="M15 9.34V4a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" y1="19" x2="12" y2="23" />
          </>
        ) : (
          <>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
          </>
        )}
      </svg>
    </button>
  );
}

function FullscreenButton({ targetRef }: { targetRef: { current: HTMLElement | null } }) {
  const isFullscreen = useFullscreenState(targetRef);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void toggleFullscreen(targetRef.current);
      }}
      title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      data-testid="fullscreen-toggle"
      data-fullscreen={isFullscreen}
      className={
        'flex items-center justify-center w-7 h-7 rounded-md backdrop-blur transition-colors ' +
        (isFullscreen
          ? 'bg-lc-green/20 text-lc-green border border-lc-green/40'
          : 'bg-black/60 text-white/80 border border-white/15 hover:bg-black/80')
      }
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {isFullscreen ? (
          <>
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
            <path d="M3 16h3a2 2 0 0 1 2 2v3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </>
        ) : (
          <>
            <path d="M8 3H5a2 2 0 0 0-2 2v3" />
            <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
            <path d="M3 16v3a2 2 0 0 0 2 2h3" />
            <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          </>
        )}
      </svg>
    </button>
  );
}

function CenteredPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-black text-white p-6">
      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-xl p-6 text-center">
        {children}
      </div>
    </div>
  );
}

function Spinner() {
  return <div className="w-6 h-6 border-2 border-neutral-700 border-t-lc-green rounded-full animate-spin mx-auto" aria-label="loading" />;
}
