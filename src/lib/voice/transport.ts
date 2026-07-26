/**
 * Thin Nostr transport for voice channels: presence beacons + per-peer
 * signaling. Publishes through the nostr-bridge signer, but keeps roster and
 * signal subscriptions on the bridge's dedicated voice pool so chat/app REQs
 * cannot consume the relay's per-WebSocket subscription quota for media setup.
 *
 * Beacons (kind 20078) announce two peer sets:
 *  - `p` tags: peers with confirmed live RTCPeerConnections.
 *  - `peer` tags: peers the publisher currently knows are active in the
 *    call, even if the direct PC is not established yet.
 *
 * VoiceClient unions both sets for transitive discovery. A fresh joiner
 * whose relay drops some publishers' beacons can still learn about them
 * from another participant's signed beacon or WebRTC control-channel
 * snapshot, so mesh formation converges from partial connectivity.
 *
 * Signaling (kind 25050) carries SDP / ICE / track-info / quality hints /
 * polite-side `requestReset` payloads.
 *
 * v1 publishes signed plaintext ephemeral events. We can swap to gift-wrap
 * later without changing the transport surface.
 */
import { getBridge, getBridgeImpl } from '@/lib/nostr-bridge/client';
import {
  KIND_VOICE_PRESENCE,
  KIND_VOICE_SIGNAL,
} from '@/lib/nip-kinds';
import type { VoicePresence, VoiceSignalPayload, VideoSlotKind } from './types';
import { pushVoiceDebug } from './debug';

const PRESENCE_TTL_SECONDS = 45;
const VOICE_SUB_WATCHDOG_MS = 2500;
const SEEN_SIGNAL_IDS_MAX = 2048;

export interface VoiceTransportOptions {
  /**
   * When set, all mesh voice traffic is pinned to this relay instead of the
   * bridge's currently-viewed relay. This keeps an active call's beacons and
   * signaling alive while the user browses other servers.
   */
  relayUrl?: string | null;
}

export interface VoiceTransport {
  publishPresenceBeacon(
    channelId: string,
    connectedTo?: readonly string[],
    knownPeers?: readonly string[],
    videoTracks?: readonly VideoSlotKind[],
  ): Promise<void>;
  publishLeavePresence(channelId: string): Promise<void>;
  subscribeRoster(channelId: string, onChange: (roster: VoicePresence[]) => void): Promise<() => void>;
  sendSignal(channelId: string, toPubkey: string, payload: VoiceSignalPayload): Promise<void>;
  subscribeSignals(
    channelId: string,
    selfPubkey: string,
    onSignal: (fromPubkey: string, payload: VoiceSignalPayload) => void,
  ): Promise<() => void>;
}

function publishOpts(options?: VoiceTransportOptions) {
  return options?.relayUrl
    ? { extraRelays: [options.relayUrl], mode: 'replace' as const }
    : undefined;
}

async function publishViaBridge(
  b: Awaited<ReturnType<typeof bridge>>,
  template: { kind: number; content: string; tags: string[][] },
  options?: VoiceTransportOptions,
): Promise<void> {
  const opts = publishOpts(options);
  if (opts) await b.publishEvent(template, opts);
  else await b.publishEvent(template);
}

function subscribeOpts(options?: VoiceTransportOptions) {
  return {
    watchdogMs: VOICE_SUB_WATCHDOG_MS,
    ...(options?.relayUrl
      ? {
          relays: [options.relayUrl],
          relayMode: 'replace' as const,
          affectsRelayAccess: false,
        }
      : {}),
  };
}

function subscribeVoice(
  b: Awaited<ReturnType<typeof bridge>>,
  filter: Parameters<typeof b.subscribeFilterWatched>[0],
  onEvent: Parameters<typeof b.subscribeFilterWatched>[1],
  options?: ReturnType<typeof subscribeOpts>,
): () => void {
  return b.subscribeVoiceFilterWatched(filter, onEvent, options);
}

export function createVoiceTransport(options: VoiceTransportOptions = {}): VoiceTransport {
  return {
    publishPresenceBeacon: (channelId, connectedTo = [], knownPeers = [], videoTracks = []) =>
      publishPresenceBeacon(channelId, connectedTo, knownPeers, videoTracks, options),
    publishLeavePresence: (channelId) => publishLeavePresence(channelId, options),
    subscribeRoster: (channelId, onChange) => subscribeRoster(channelId, onChange, options),
    sendSignal: (channelId, toPubkey, payload) => sendSignal(channelId, toPubkey, payload, options),
    subscribeSignals: (channelId, selfPubkey, onSignal) =>
      subscribeSignals(channelId, selfPubkey, onSignal, options),
  };
}

async function bridge() {
  await getBridge();
  const impl = getBridgeImpl();
  if (!impl) throw new Error('nostr bridge not initialized');
  return impl;
}

/**
 * Publish a presence beacon for the given channel.
 *
 * @param channelId - NIP-29 group id this beacon advertises presence in.
 * @param connectedTo - Peer pubkeys the publisher currently has live
 *   RTCPeerConnections to. Emitted as `p` tags so other participants can
 *   discover them transitively when their relay drops the publisher's
 *   own beacon. Empty / omitted = "no successful connections yet"
 *   (cold-started client).
 * @param knownPeers - Pubkeys the publisher believes are active in the
 *   call from any source: own PCs, relay beacons, or WebRTC control
 *   snapshots. Emitted as `peer` tags so peers can gossip participants
 *   before every direct connection is established.
 * @param videoTracks - Outbound video tracks the publisher is currently
 *   sending (any of `camera`, `screen`). Emitted as `v` tags so every
 *   participant can compute the independent four-camera and one-screen caps (see `client.ts`). Empty for audio-only joiners.
 *
 * Caller is responsible for the cadence (every ~10s while in the channel)
 * and for opportunistic re-publishes when `connectedTo`, `knownPeers`,
 * or `videoTracks` changes.
 */
export async function publishPresenceBeacon(
  channelId: string,
  connectedTo: readonly string[] = [],
  knownPeers: readonly string[] = [],
  videoTracks: readonly VideoSlotKind[] = [],
  options: VoiceTransportOptions = {},
): Promise<void> {
  const b = await bridge();
  const expiration = Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS;
  const tags: string[][] = [
    ['e', channelId],
    ['t', 'obelisk-voice-presence'],
    ['expiration', String(expiration)],
  ];
  // Dedup so a flapping connection-state-change doesn't spam tags.
  const seenP = new Set<string>();
  for (const pk of connectedTo) {
    if (!pk || seenP.has(pk)) continue;
    seenP.add(pk);
    tags.push(['p', pk]);
  }
  const seenKnown = new Set<string>();
  for (const pk of [...knownPeers, ...connectedTo]) {
    if (!pk || seenKnown.has(pk)) continue;
    seenKnown.add(pk);
    tags.push(['peer', pk]);
  }
  const seenV = new Set<string>();
  for (const kind of videoTracks) {
    if (kind !== 'camera' && kind !== 'screen') continue;
    if (seenV.has(kind)) continue;
    seenV.add(kind);
    tags.push(['v', kind]);
  }
  await publishViaBridge(
    b,
    {
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags,
    },
    options,
  );
  console.log(
    '[voice] beacon published for', channelId.slice(0, 8),
    '+', connectedTo.length, 'connections',
    '+', new Set([...knownPeers, ...connectedTo]).size, 'known',
    videoTracks.length > 0 ? `+ video=[${videoTracks.join(',')}]` : '',
  );
}

/**
 * Publish a terminal mesh presence update. This is intentionally the same
 * kind/tag family as the normal beacon, but with a past expiration and an
 * explicit status marker so subscribers can remove the publisher immediately
 * instead of waiting for the previous beacon's TTL.
 */
export async function publishLeavePresence(
  channelId: string,
  options: VoiceTransportOptions = {},
): Promise<void> {
  const b = await bridge();
  const now = Math.floor(Date.now() / 1000);
  await publishViaBridge(
    b,
    {
      kind: KIND_VOICE_PRESENCE,
      content: '',
      tags: [
        ['e', channelId],
        ['t', 'obelisk-voice-presence'],
        ['status', 'left'],
        ['expiration', String(now - 1)],
      ],
    },
    options,
  );
  console.log('[voice] leave beacon published for', channelId.slice(0, 8));
}

/**
 * Subscribe to presence beacons for a channel.
 *
 * Calls `onChange` with the live roster (publishers with non-expired beacons,
 * each carrying their own `connectedTo` list) whenever the set updates. The
 * caller (`VoiceClient`) is responsible for computing the transitive
 * participant union from publishers + their connectedTo lists, since that
 * computation also needs to be combined with the local connection state.
 */
export async function subscribeRoster(
  channelId: string,
  onChange: (roster: VoicePresence[]) => void,
  options: VoiceTransportOptions = {},
): Promise<() => void> {
  const b = await bridge();
  const latest = new Map<string, VoicePresence>();

  function emit() {
    const now = Math.floor(Date.now() / 1000);
    const live = Array.from(latest.values()).filter((p) => p.expiresAt > now);
    onChange(live);
  }

  // Sweep stale entries roughly twice per TTL so leavers disappear from the
  // roster even if no new beacons arrive.
  const sweep = (typeof window !== 'undefined' ? window : globalThis as unknown as { setInterval: typeof setInterval })
    .setInterval(emit, (PRESENCE_TTL_SECONDS / 2) * 1000);

  // Use the WATCHED variant so the subscription auto-recovers when a relay's
  // WebSocket drops (network blip, server restart, NAT rebind). The raw
  // `subscribeFilter` runs once and dies silently — symptom: one browser
  // logs "WebSocket is already in CLOSING or CLOSED state" while another
  // never sees a new joiner because its sub went dead. The watchdog detects
  // the silence (5 s no EVENT/EOSE) and re-issues the REQ with backoff.
  const unsub = subscribeVoice(
    b,
    {
      kinds: [KIND_VOICE_PRESENCE],
    },
    (ev) => {
      if (!ev.tags.some((t) => t[0] === 'e' && t[1] === channelId)) return;
      const expirationTag = ev.tags.find((t) => t[0] === 'expiration')?.[1];
      const expiresAt = expirationTag
        ? parseInt(expirationTag, 10)
        : ev.created_at + PRESENCE_TTL_SECONDS;
      if (!Number.isFinite(expiresAt)) return;
      // Bump the receive counter even for staler beacons — it measures
      // raw delivery, not de-duplicated deliveries.
      const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
        __obeliskVoiceMetrics?: { beacons: { rcvd: number } };
      };
      if (w.__obeliskVoiceMetrics) w.__obeliskVoiceMetrics.beacons.rcvd++;
      pushVoiceDebug({ kind: 'beacon-rcvd', peer: ev.pubkey });
      const status = ev.tags.find((t) => t[0] === 'status')?.[1];
      const terminal = status === 'left' || status === 'closed' || expiresAt <= Math.floor(Date.now() / 1000);
      const prev = latest.get(ev.pubkey);
      if (prev && (prev.createdAt > ev.created_at || (prev.createdAt === ev.created_at && !terminal))) return;
      const connectedTo = ev.tags
        .filter((t) => t[0] === 'p' && typeof t[1] === 'string' && t[1].length > 0)
        .map((t) => t[1])
        // Drop self-references defensively — a beacon claiming it's
        // connected to itself is meaningless and would inflate the roster.
        .filter((pk) => pk !== ev.pubkey);
      const knownPeerSet = new Set<string>();
      for (const t of ev.tags) {
        if (t[0] !== 'peer') continue;
        if (typeof t[1] !== 'string' || t[1].length === 0) continue;
        if (t[1] === ev.pubkey) continue;
        knownPeerSet.add(t[1]);
      }
      // Back-compat: old beacons only published connected peers as `p` tags.
      for (const pk of connectedTo) knownPeerSet.add(pk);
      const knownPeers = Array.from(knownPeerSet);
      const videoTracks = ev.tags
        .filter((t) => t[0] === 'v' && (t[1] === 'camera' || t[1] === 'screen'))
        .map((t) => t[1] as VideoSlotKind);
      // SFU advertisements carry `["sfu","1"]` on every beacon; mesh peers
      // never set it. The presence/absence is the topology marker the
      // VoiceClient uses to switch dial behavior — see `setSfuMode`.
      const isSfu = ev.tags.some((t) => t[0] === 'sfu' && t[1] === '1');
      const isMeshTestPeer = ev.tags.some((t) =>
        (t[0] === 'client' && t[1] === 'obelisk-mesh-test-peer') ||
        (t[0] === 'test-peer' && t[1] === 'mesh'),
      );
      latest.set(ev.pubkey, {
        pubkey: ev.pubkey,
        channelId,
        createdAt: ev.created_at,
        expiresAt,
        connectedTo,
        knownPeers,
        videoTracks,
        isSfu,
        isMeshTestPeer,
      });
      emit();
    },
    subscribeOpts(options),
  );

  emit();

  return () => {
    (typeof window !== 'undefined' ? window : globalThis as unknown as { clearInterval: typeof clearInterval })
      .clearInterval(sweep);
    unsub();
  };
}

/**
 * Publish a directed signaling event (offer / answer / ICE / bye /
 * trackinfo / qualityhint / requestReset) to a peer.
 */
export async function sendSignal(
  channelId: string,
  toPubkey: string,
  payload: VoiceSignalPayload,
  options: VoiceTransportOptions = {},
): Promise<void> {
  const b = await bridge();
  await publishViaBridge(
    b,
    {
      kind: KIND_VOICE_SIGNAL,
      content: JSON.stringify(payload),
      tags: [
        ['p', toPubkey],
        ['e', channelId],
        ['t', 'obelisk-voice-signal'],
      ],
    },
    options,
  );
  console.log('[voice] →', payload.type, 'to', toPubkey.slice(0, 8), 'seq', payload.seq);
  pushVoiceDebug({ kind: 'signal-sent', peer: toPubkey, payload: { type: payload.type, seq: payload.seq } });
  // Also bump the global metrics counter (mirrored to window.__obeliskVoiceMetrics)
  // so the Playwright spec doesn't have to walk the debug ring buffer for sends.
  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as {
    __obeliskVoiceMetrics?: { signals: { sent: number } };
  };
  if (w.__obeliskVoiceMetrics) w.__obeliskVoiceMetrics.signals.sent++;
}

/**
 * Subscribe to incoming signaling events addressed to the local user in the
 * given channel. Some relays don't reliably index tags for ephemeral kinds,
 * so we subscribe by kind and gate channel/recipient in the handler.
 */
export async function subscribeSignals(
  channelId: string,
  selfPubkey: string,
  onSignal: (fromPubkey: string, payload: VoiceSignalPayload) => void,
  options: VoiceTransportOptions = {},
): Promise<() => void> {
  const b = await bridge();
  const since = Math.floor(Date.now() / 1000) - 60;
  const seenIds = new Set<string>();

  function rememberSignalId(id: string | undefined): boolean {
    if (!id) return true;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    if (seenIds.size > SEEN_SIGNAL_IDS_MAX) {
      const oldest = seenIds.values().next().value;
      if (oldest) seenIds.delete(oldest);
    }
    return true;
  }

  // Watched variant — same reasoning as `subscribeRoster`. Without auto-
  // retry, a relay disconnect mid-call means SDP offers / answers / ICE
  // candidates from new joiners never reach us; the call stays formed for
  // existing peers but a third joiner appears to "not be detected".
  return subscribeVoice(
    b,
    {
      kinds: [KIND_VOICE_SIGNAL],
      since,
    },
    (ev) => {
      if (!rememberSignalId(ev.id)) {
        pushVoiceDebug({ kind: 'signal-dropped', reason: 'duplicate', peer: ev.pubkey });
        return;
      }
      if (ev.pubkey === selfPubkey) {
        pushVoiceDebug({ kind: 'signal-dropped', reason: 'self' });
        return;
      }
      if (!ev.tags.some((t) => t[0] === 'e' && t[1] === channelId)) {
        pushVoiceDebug({ kind: 'signal-dropped', reason: 'wrong-channel', peer: ev.pubkey });
        return;
      }
      const targets = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
      if (targets.length > 0 && !targets.includes(selfPubkey)) {
        pushVoiceDebug({ kind: 'signal-dropped', reason: 'not-for-me', peer: ev.pubkey });
        return;
      }
      try {
        const payload = JSON.parse(ev.content) as VoiceSignalPayload;
        console.log('[voice] ←', payload.type, 'from', ev.pubkey.slice(0, 8), 'seq', payload.seq);
        pushVoiceDebug({ kind: 'signal-rcvd', peer: ev.pubkey, payload: { type: payload.type, seq: payload.seq } });
        onSignal(ev.pubkey, payload);
      } catch (e) {
        console.warn('[voice] malformed signal', e);
      }
    },
    subscribeOpts(options),
  );
}

export function getSelfPubkey(): string | null {
  return getBridgeImpl()?.getPublicKey() ?? null;
}

/**
 * Compute the transitive participant set from a beacon roster.
 *
 * The relay only tells us about publishers we directly received beacons
 * from. To survive dropped beacons, each beacon also lists who its
 * publisher has confirmed live connections with — `connectedTo` — and
 * who the publisher currently knows about from relay/control gossip —
 * `knownPeers`. Union those into the publisher set and you get every
 * pubkey known to be in the room.
 *
 * Self is included as a transitive hint when other peers list us — but
 * `VoiceClient` always filters `selfPubkey` out before opening peers, so
 * we don't dial ourselves.
 */
export function transitiveParticipants(
  roster: readonly VoicePresence[],
): string[] {
  const set = new Set<string>();
  for (const p of roster) {
    set.add(p.pubkey);
    for (const pk of p.connectedTo) set.add(pk);
    for (const pk of p.knownPeers ?? []) set.add(pk);
  }
  return Array.from(set);
}
