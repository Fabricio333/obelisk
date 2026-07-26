/**
 * SFU control + discovery for the dex client.
 *
 * Voice channels marked `voice-sfu` (NIP-29 group with `["t","voice-sfu"]`)
 * scale past the 8-peer mesh ceiling by routing all media through a
 * Selective Forwarding Unit. The SFU is a separate Nostr-signaled service
 * (see ../../../services/sfu) and it only opens a room for a channel
 * after an authorized client publishes a kind 25052 `start` event
 * addressed to it.
 *
 * Until this module existed the dex tagged channels with `["t","voice-sfu"]`
 * but never published the `start` — so clients fell back to mesh and the
 * SFU stayed idle. This module fills the gap:
 *
 *   1. Discovery — subscribe to kind 31313 (replaceable advertisement) on
 *      the configured relays. Each running SFU publishes one of these
 *      with its url, capacity, and which relays it treats as
 *      trusted-author. Cache the newest per pubkey.
 *
 *   2. Publish start — when a user joins a `voice-sfu` channel, build a
 *      kind 25052 `{action:'start',params:…}` event, sign through the
 *      bridge's active signer, and publish to the dex's default relays
 *      AND the SFU's advertised `trusted_relay`(s). The trusted relay's
 *      write-whitelist is the SFU's authorization gate; arrival via
 *      that relay is what flips the SFU's `trusted=true` log line.
 *
 *   3. Rate-limit — repeated joins inside a short window publish at most
 *      one start. The SFU dedupes by event id anyway, but skipping the
 *      sign+publish saves a bunker round-trip.
 *
 * The voice client itself doesn't need to know about any of this: once
 * the SFU's room is active, the SFU joins the channel as a peer with a
 * `["sfu","1"]` tag in its kind 20078 beacon, and the existing mesh→sfu
 * topology switch in `client.ts` takes over.
 */
import type { Event as NostrEvent, Filter } from 'nostr-tools';

import { getBridge, getBridgeImpl, isImportableRelayUrl } from '@/lib/nostr-bridge/client';
import { KIND_SFU_ADVERTISE, KIND_SFU_CONTROL } from '@/lib/nip-kinds';
import { resolveSfuPin } from './sfu-pin';

/** Trusted-author relay used as a hard fallback when no advertisement is
 *  cached yet (matches services/sfu defaults). */
const FALLBACK_TRUSTED_RELAY = 'wss://lacrypta-relay.obelisk.ar';

/** Lifetime of the kind 25052 `expiration` tag. The SFU drops events with
 *  `expiration <= now`, so this is just enough headroom for relay delivery. */
const SFU_CONTROL_TTL_SECONDS = 60;

/** Throttle `publishSfuStart` to at most one publish per channel+sfu in
 *  this window. The SFU is idempotent on `start` for an already-active
 *  room, but resigning + republishing is wasteful. */
const START_RATELIMIT_MS = 30_000;

/** How long to wait for the first 31313 to land when the cache is cold.
 *  Replaceable kinds are returned immediately by compliant relays, so a
 *  short wait is sufficient — and keeping it short means a bad/missing
 *  advertisement doesn't block the join. */
const DISCOVERY_COLD_WAIT_MS = 1500;
const PIN_COLD_WAIT_WITH_ENV_MS = 200;

export interface SfuAdvertisement {
  pubkey: string;
  url: string | null;
  region: string | null;
  cap: number | null;
  /** Relays the SFU treats as trusted-author (events seen on them bypass
   *  the SFU's local allow-list). Clients should publish `start` here. */
  trustedRelays: readonly string[];
  /** Relays the SFU subscribes to in general (signaling, advertise, etc.). */
  generalRelays: readonly string[];
  createdAt: number;
}

export interface SfuStartParams {
  video?: boolean;
  screen?: boolean;
  maxParticipants?: number;
}

const advertisements = new Map<string, SfuAdvertisement>();
let advertisementSubInflight: Promise<void> | null = null;
let advertisementUnsub: (() => void) | null = null;

const recentStarts = new Map<string, number>();

function tagValues(ev: NostrEvent, name: string): string[] {
  return ev.tags.filter((t) => t[0] === name).map((t) => t[1]).filter(Boolean);
}

function firstTag(ev: NostrEvent, name: string): string | null {
  return tagValues(ev, name)[0] ?? null;
}

/**
 * Parse a kind 31313 event into an SfuAdvertisement. Exported for tests.
 */
export function parseAdvertisement(ev: NostrEvent): SfuAdvertisement {
  const capStr = firstTag(ev, 'cap');
  const capNum = capStr ? Number(capStr) : NaN;
  // Drop any `relay` / `trusted_relay` entries pointing at localhost,
  // loopback, RFC-1918, or non-wss schemes. SfuRpc subscribes to whatever
  // we hand it, and a never-resolving WebSocket to a private host stalls
  // every voice-sfu join until the rpc timeout fires. A dev box that
  // happens to publish kind 31313 with its lan IP — or an old pinned SFU
  // entry from a local test rig — shouldn't take down production browsers.
  return {
    pubkey: ev.pubkey,
    url: firstTag(ev, 'url'),
    region: firstTag(ev, 'region'),
    cap: Number.isFinite(capNum) ? capNum : null,
    trustedRelays: tagValues(ev, 'trusted_relay').filter(isImportableRelayUrl),
    generalRelays: tagValues(ev, 'relay').filter(isImportableRelayUrl),
    createdAt: ev.created_at,
  };
}

function ingestAdvertisement(ev: NostrEvent): void {
  if (ev.kind !== KIND_SFU_ADVERTISE) return;
  const existing = advertisements.get(ev.pubkey);
  if (existing && existing.createdAt >= ev.created_at) return;
  advertisements.set(ev.pubkey, parseAdvertisement(ev));
}

/**
 * Open (once) a long-lived subscription for kind 31313 advertisements on
 * the configured relays. Subsequent calls are no-ops.
 */
async function ensureAdvertisementSub(): Promise<void> {
  if (advertisementSubInflight) return advertisementSubInflight;
  advertisementSubInflight = (async () => {
    await getBridge();
    const impl = getBridgeImpl();
    if (!impl) return;
    // 24h `since` window — the SFU re-publishes its 31313 every 5 minutes
    // (see services/sfu/src/advertise.ts), so any live SFU's advertisement
    // is well within that window. Wider would just inflate replay traffic.
    const since = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    const filter: Filter = { kinds: [KIND_SFU_ADVERTISE], since };
    advertisementUnsub = impl.subscribeFilter(filter, ingestAdvertisement);
  })();
  await advertisementSubInflight;
}

/**
 * Pick an SFU to address. Returns the most recently-advertised SFU, or
 * `null` if none is known. Eagerly opens the discovery subscription.
 *
 * For v0 there is intentionally no scoring (region, capacity, latency).
 * Operators run one SFU per channel cluster; multi-SFU selection is a
 * post-v0 concern.
 */
export async function pickSfu(channelId?: string): Promise<SfuAdvertisement | null> {
  const pinnedPubkey = process.env.NEXT_PUBLIC_SFU_PUBKEY;
  const pinnedUrl = process.env.NEXT_PUBLIC_SFU_URL;
  const pinnedRelays = (process.env.NEXT_PUBLIC_SFU_TRUSTED_RELAYS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // 1) Per-channel pin (kind 30078) — what the channel admin chose. This
  //    is the path we want to be the rule, not the exception: any operator
  //    can run their own SFU and bind it to their channel without touching
  //    the dex build. Falls through if no pin is set yet for this channel.
  if (channelId) {
    const channelPin = await resolveSfuPin(
      channelId,
      pinnedPubkey ? PIN_COLD_WAIT_WITH_ENV_MS : undefined,
    );
    if (channelPin) {
      return {
        pubkey: channelPin.pubkey,
        url: channelPin.url,
        region: null,
        cap: null,
        trustedRelays: channelPin.trustedRelays,
        generalRelays: channelPin.relays,
        createdAt: channelPin.createdAt,
      };
    }
  }

  // 2) Build-time override: when the operator pins a single SFU via env
  //    vars there's no need to round-trip kind 31313 discovery through a
  //    relay. Skips a failure mode where the chosen relay (e.g. NIP-29-only)
  //    refuses to store kind 31313 — the SFU's publish acks but no
  //    subscriber ever sees it, so `pickSfu` returns null and the UI
  //    shows "SFU unavailable". With per-channel pins live, this layer
  //    is just a safety net for unconfigured channels.
  if (pinnedPubkey && /^[0-9a-f]{64}$/i.test(pinnedPubkey)) {
    return {
      pubkey: pinnedPubkey.toLowerCase(),
      url: pinnedUrl ?? null,
      region: null,
      cap: null,
      trustedRelays: pinnedRelays,
      generalRelays: pinnedRelays,
      createdAt: Math.floor(Date.now() / 1000),
    };
  }
  await ensureAdvertisementSub();
  if (advertisements.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_COLD_WAIT_MS));
  }
  let best: SfuAdvertisement | null = null;
  for (const ad of advertisements.values()) {
    if (!best || ad.createdAt > best.createdAt) best = ad;
  }
  return best;
}

/**
 * Publish a kind 25052 `start` event addressed to `sfuPubkey` for the
 * given `channelId`. Targets the bridge's default relay set AND the
 * SFU's advertised trusted-author relays — the latter is what gives the
 * SFU's call-listener `trusted=true` and bypasses the local allow-list.
 *
 * Returns `true` on a successful sign+publish, `false` on rate-limit or
 * any sign/publish failure (caller falls back to mesh silently).
 *
 * `options.force` bypasses the 30 s rate-limit. The supervisor uses
 * this when retrying after the SFU's beacon never arrived and when
 * republishing because the SFU dropped out mid-call — both scenarios
 * where a fresh publish is exactly what we want.
 */
export async function publishSfuStart(
  channelId: string,
  sfuPubkey: string,
  options: {
    trustedRelays?: readonly string[];
    params?: SfuStartParams;
    force?: boolean;
  } = {},
): Promise<boolean> {
  const key = `${channelId}:${sfuPubkey}`;
  const now = Date.now();
  if (!options.force) {
    const last = recentStarts.get(key);
    if (last && now - last < START_RATELIMIT_MS) return false;
  }
  recentStarts.set(key, now);

  const trustedRelays = options.trustedRelays && options.trustedRelays.length > 0
    ? options.trustedRelays
    : [FALLBACK_TRUSTED_RELAY];
  const params = options.params ?? {};
  const expiration = Math.floor(now / 1000) + SFU_CONTROL_TTL_SECONDS;
  const tags: string[][] = [
    ['p', sfuPubkey],
    ['e', channelId],
    ['t', 'obelisk-sfu-control'],
    ['expiration', String(expiration)],
  ];
  const content = JSON.stringify({
    action: 'start',
    params: {
      video: params.video ?? true,
      screen: params.screen ?? true,
      maxParticipants: params.maxParticipants ?? 50,
    },
  });

  try {
    await getBridge();
    const impl = getBridgeImpl();
    if (!impl) {
      recentStarts.delete(key);
      return false;
    }
    await impl.publishEvent({ kind: KIND_SFU_CONTROL, content, tags }, { extraRelays: [...trustedRelays] });
    return true;
  } catch (err) {
    recentStarts.delete(key);
    console.warn('[sfu] publish start failed', err);
    return false;
  }
}

/**
 * One-shot helper: discover an SFU and publish `start` for the given
 * channel. Returns the targeted SFU pubkey on success, `null` if no SFU
 * was available or the publish was rate-limited / failed.
 *
 * Used by the voice-sfu join path — the caller doesn't need to know
 * anything about advertisements or relay routing.
 *
 * `force` is forwarded to `publishSfuStart` to bypass the rate-limit.
 */
export async function ensureSfuRoomStarted(
  channelId: string,
  params: SfuStartParams = {},
  options: { force?: boolean } = {},
): Promise<string | null> {
  const sfu = await pickSfu(channelId);
  if (!sfu) return null;
  const ok = await publishSfuStart(channelId, sfu.pubkey, {
    trustedRelays: sfu.trustedRelays,
    params,
    force: options.force === true,
  });
  return ok ? sfu.pubkey : null;
}

/**
 * Test-only resets and accessors. Not part of the public surface.
 */
export const __testing = {
  reset(): void {
    advertisements.clear();
    recentStarts.clear();
    advertisementSubInflight = null;
    advertisementUnsub?.();
    advertisementUnsub = null;
  },
  ingest(ev: NostrEvent): void {
    ingestAdvertisement(ev);
  },
  snapshot(): readonly SfuAdvertisement[] {
    return [...advertisements.values()];
  },
};
