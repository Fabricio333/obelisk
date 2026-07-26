/**
 * Voice-specific helpers for the Playwright harness. Builds on
 * `scripts/e2e/lib.ts` (session seeding + relay-access helpers) with
 * primitives for driving the `VoiceClient` directly via the
 * window-exposed `__obeliskVoiceClient` constructor — bypassing the
 * VoiceRoom UI's NIP-29 membership gate so a fresh ephemeral nsec can
 * exercise the mesh transport against any relay.
 *
 * Why bypass the UI? The room's gate requires the channel's kind 39000
 * metadata to land on the relay, plus the test pubkey to be in the
 * member list. On a fresh ad-hoc test channel that's a chicken-and-egg
 * problem. Driving `VoiceClient` directly with `{ open: true }` lets
 * the harness create an "open room" on demand without seeding NIP-29
 * state.
 */
import type { Page } from '@playwright/test';
import { logFail, logObserved, logOk, logWarn } from '../lib';

/** Unique channel id for one test run. */
export function makeProbeChannelId(): string {
  return `obelisk-mesh-probe-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(16)}`;
}

/**
 * Stub `navigator.mediaDevices.getUserMedia` and `getDisplayMedia` BEFORE
 * any app code loads. Headless Chromium's fake-device flags can hang or
 * return permission errors depending on the platform; we'd rather drive
 * the WebRTC negotiation with synthetic tracks generated in the page
 * (Web Audio destination → MediaStreamTrack) so the test is deterministic
 * across CI environments.
 *
 * The synthetic mic emits a 220 Hz sine at low gain — quiet but real
 * audio frames hit the encoder, which is enough for `bytesReceived > 0`
 * inbound assertions.
 */
export async function installFakeMediaStreams(context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      navigator: Navigator;
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    function makeFakeAudioStream(): MediaStream {
      const Ctx = (w.AudioContext ?? w.webkitAudioContext)!;
      const ac = new Ctx();
      const resume = () => { void ac.resume().catch(() => {}); };
      resume();
      const resumeTimer = window.setInterval(() => {
        if (ac.state === 'running') window.clearInterval(resumeTimer);
        else resume();
      }, 500);
      const osc = ac.createOscillator();
      osc.frequency.value = 220;
      const gain = ac.createGain();
      gain.gain.value = 0.05; // quiet but non-silent
      const dest = ac.createMediaStreamDestination();
      osc.connect(gain).connect(dest);
      try { osc.start(); } catch { /* already started */ }
      return dest.stream;
    }
    function makeFakeVideoStream(): MediaStream {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 240;
      const ctx2d = canvas.getContext('2d')!;
      function paint() {
        ctx2d.fillStyle = '#070';
        ctx2d.fillRect(0, 0, canvas.width, canvas.height);
        ctx2d.fillStyle = '#fff';
        ctx2d.font = '24px monospace';
        ctx2d.fillText(String(Date.now()).slice(-8), 12, 40);
        requestAnimationFrame(paint);
      }
      paint();
      return (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(15);
    }
    const fakeGetUserMedia = async (constraints: MediaStreamConstraints): Promise<MediaStream> => {
      const stream = new MediaStream();
      if (constraints.audio) {
        for (const t of makeFakeAudioStream().getTracks()) stream.addTrack(t);
      }
      if (constraints.video) {
        for (const t of makeFakeVideoStream().getTracks()) stream.addTrack(t);
      }
      return stream;
    };
    const fakeGetDisplayMedia = async (): Promise<MediaStream> => makeFakeVideoStream();
    if (!w.navigator.mediaDevices) {
      Object.defineProperty(w.navigator, 'mediaDevices', { value: {}, configurable: true });
    }
    Object.defineProperty(w.navigator.mediaDevices, 'getUserMedia', {
      value: fakeGetUserMedia, configurable: true, writable: true,
    });
    Object.defineProperty(w.navigator.mediaDevices, 'getDisplayMedia', {
      value: fakeGetDisplayMedia, configurable: true, writable: true,
    });
  });
}

export interface VoiceMetricsSnapshot {
  beacons: { sent: number; rcvd: number };
  signals: { sent: number; rcvd: number; byeViaControl: number; byeViaRelay: number };
  signalsDropped: {
    wot: number;
    membershipDeferred: number;
    membershipFinal: number;
    deferredOverflow: number;
    notForMe: number;
    self: number;
    unknownPayload: number;
    sfuRouted: number;
  };
  peers: {
    connected: number;
    ever: number;
    tornDown: number;
    tornDownByUnload: number;
    sessionMismatchResets: number;
    iceExhausted: number;
  };
  relay: { publishFail: number; lastError: string | null; authWaited: number; authTimedOut: number };
  rateLimit: { hit: number; backoffMs: number };
  controlChannel: { opened: number; pingSent: number; pongRcvd: number; lastRttMs: number | null };
  transitive: { discoveredViaRelay: number; discoveredViaControl: number };
}

/**
 * Wait until the bridge is initialized AND its public key is available.
 * Uses the same readiness signal the AppShell relies on.
 */
export async function waitForBridgeReady(page: Page, timeoutMs = 30_000): Promise<string> {
  return await page.evaluate(async (timeout) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const w = window as unknown as {
        __obeliskBridgeReady?: boolean;
        __obeliskVoiceClient?: unknown;
      };
      const mod = await (async () => {
        try {
          // The bridge module attaches `getBridge` to window via the
          // existing nostr-bridge surface. Walk it directly.
          const m = (window as unknown as {
            __obeliskBridge?: { getPublicKey: () => string | null };
          }).__obeliskBridge;
          return m ?? null;
        } catch { return null; }
      })();
      void w; void mod;
      // Most reliable signal: VoiceClient class is on window AND we can
      // construct one (which checks getSelfPubkey internally).
      const Ctor = (window as unknown as { __obeliskVoiceClient?: unknown }).__obeliskVoiceClient as
        (new (id: string, opts: unknown) => { selfPubkey: string }) | undefined;
      if (typeof Ctor === 'function') {
        try {
          const probe = new Ctor(`bridge-probe-${Date.now()}`, { open: true });
          return probe.selfPubkey;
        } catch {
          /* not ready yet */
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('bridge did not become ready in time');
  }, timeoutMs);
}

/**
 * Construct a VoiceClient on the page with `{ open: true }` and join.
 * Stores it on `window.__test_voice` for later inspection.
 */
export async function joinMeshChannel(
  page: Page,
  channelId: string,
  opts: { otherMembers?: readonly string[] } = {},
): Promise<{ selfPubkey: string }> {
  return await page.evaluate(
    async ({ channelId, otherMembers }) => {
      const Ctor = (window as unknown as { __obeliskVoiceClient?: unknown }).__obeliskVoiceClient as
        | (new (id: string, opts: unknown) => {
            selfPubkey: string;
            join: () => Promise<void>;
            leave: () => Promise<void>;
            getPeerConnectionState: (pk: string) => string | null;
            metrics: unknown;
          })
        | undefined;
      if (typeof Ctor !== 'function') throw new Error('VoiceClient not exposed on window');
      const client = new Ctor(channelId, {
        // Open room — bypass the NIP-29 membership gate. The mesh transport
        // we're testing here doesn't depend on membership; the WoT/member
        // filter in client.ts:489–490 is what we instrumented to observe
        // silent drops.
        open: true,
        // Pre-populate members so the receive-side `isMember` filter passes
        // even when WoT is enabled. The list is just a safety net — `open:true`
        // already short-circuits the check via openRoom.
        members: otherMembers,
        events: {
          onError: (msg: string) => console.warn('[probe] voice error:', msg),
          onTopologyChange: (sfu: string | null) => console.log('[probe] topology', sfu),
        },
      });
      (window as unknown as { __test_voice?: unknown }).__test_voice = client;
      console.log('[probe] joinMeshChannel: client constructed, pubkey=', client.selfPubkey.slice(0, 8));
      try {
        await Promise.race([
          client.join(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('join() timed out after 30s')), 30_000)),
        ]);
      } catch (err) {
        console.error('[probe] join() failed:', err);
        throw err;
      }
      console.log('[probe] joinMeshChannel: join() resolved');
      return { selfPubkey: client.selfPubkey };
    },
    { channelId, otherMembers: opts.otherMembers ?? [] },
  );
}

/** Read the live metrics snapshot from the active VoiceClient. */
export async function readMetrics(page: Page): Promise<VoiceMetricsSnapshot | null> {
  return await page.evaluate(() => {
    const w = window as unknown as { __test_voice?: { metrics: VoiceMetricsSnapshot } };
    if (!w.__test_voice) return null;
    // Deep-clone so the snapshot doesn't mutate under our feet between assertions.
    return JSON.parse(JSON.stringify(w.__test_voice.metrics)) as VoiceMetricsSnapshot;
  });
}

/** Read the live PC connectionState for a given remote pubkey. */
export async function getPeerState(page: Page, pubkey: string): Promise<string | null> {
  return await page.evaluate((pk) => {
    const w = window as unknown as {
      __test_voice?: { getPeerConnectionState: (pk: string) => string | null };
    };
    return w.__test_voice?.getPeerConnectionState(pk) ?? null;
  }, pubkey);
}

/** Read the media kinds exposed through VoiceClient's UI-facing track API. */
export async function getRemoteTrackKinds(page: Page, pubkey: string): Promise<string[]> {
  return await page.evaluate((pk) => {
    const client = (window as unknown as {
      __test_voice?: {
        getRemoteTracks: () => Array<{ pubkey: string; kind: string; stream: MediaStream }>;
      };
    }).__test_voice;
    return client?.getRemoteTracks()
      .filter((remote) => remote.pubkey === pk && remote.stream.getTracks().some((track) => track.readyState === 'live'))
      .map((remote) => remote.kind) ?? [];
  }, pubkey);
}

/** Read inbound RTP audio bytesReceived to confirm media is flowing. */
export async function getInboundAudioBytes(page: Page, pubkey: string): Promise<number> {
  return await page.evaluate(async (pk) => {
    const w = window as unknown as {
      __test_voice?: { peers?: Map<string, { pc: RTCPeerConnection }> };
    };
    const inner = w.__test_voice as unknown as {
      peers: Map<string, { pc: RTCPeerConnection }>;
    } | undefined;
    const peer = inner?.peers?.get(pk);
    if (!peer) return 0;
    const stats = await peer.pc.getStats();
    let bytes = 0;
    stats.forEach((rep) => {
      const r = rep as { type?: string; kind?: string; mediaType?: string; bytesReceived?: number };
      if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio')) {
        bytes += r.bytesReceived ?? 0;
      }
    });
    return bytes;
  }, pubkey);
}

/** Read inbound RTP video bytesReceived (camera + screen combined). */
export async function getInboundVideoBytes(page: Page, pubkey: string): Promise<number> {
  return await page.evaluate(async (pk) => {
    const inner = (window as unknown as { __test_voice?: unknown }).__test_voice as {
      peers: Map<string, { pc: RTCPeerConnection }>;
    } | undefined;
    const peer = inner?.peers?.get(pk);
    if (!peer) return 0;
    const stats = await peer.pc.getStats();
    let bytes = 0;
    stats.forEach((rep) => {
      const r = rep as { type?: string; kind?: string; mediaType?: string; bytesReceived?: number };
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
        bytes += r.bytesReceived ?? 0;
      }
    });
    return bytes;
  }, pubkey);
}

/** Toggle camera on the active VoiceClient. */
export async function setCameraEnabled(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const c = (window as unknown as { __test_voice?: { setCameraEnabled: (on: boolean) => Promise<void> } }).__test_voice;
    if (c) await c.setCameraEnabled(enabled);
  }, on);
}

/** Toggle microphone on the active VoiceClient. */
export async function setMicEnabled(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const c = (window as unknown as { __test_voice?: { setMicEnabled: (on: boolean) => Promise<void> } }).__test_voice;
    if (c) await c.setMicEnabled(enabled);
  }, on);
}

/** Toggle screen share on the active VoiceClient. */
export async function setScreenShareEnabled(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const c = (window as unknown as { __test_voice?: { setScreenShareEnabled: (on: boolean) => Promise<void> } }).__test_voice;
    if (c) await c.setScreenShareEnabled(enabled);
  }, on);
}

/**
 * Count inbound RTP video tracks across all peers for a given remote pubkey,
 * grouped by camera vs screen via track label heuristics. Returns total bytes
 * and per-track counts.
 */
export async function getInboundVideoBreakdown(
  page: Page,
  pubkey: string,
): Promise<{ totalBytes: number; trackCount: number }> {
  return await page.evaluate(async (pk) => {
    const inner = (window as unknown as { __test_voice?: unknown }).__test_voice as {
      peers: Map<string, { pc: RTCPeerConnection }>;
    } | undefined;
    const peer = inner?.peers?.get(pk);
    if (!peer) return { totalBytes: 0, trackCount: 0 };
    const stats = await peer.pc.getStats();
    let totalBytes = 0;
    let trackCount = 0;
    stats.forEach((rep) => {
      const r = rep as { type?: string; kind?: string; mediaType?: string; bytesReceived?: number };
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
        totalBytes += r.bytesReceived ?? 0;
        trackCount += 1;
      }
    });
    return { totalBytes, trackCount };
  }, pubkey);
}

/** Leave the channel and tear down the test client. */
export async function leaveMeshChannel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as unknown as { __test_voice?: { leave: () => Promise<void> } };
    if (w.__test_voice) {
      try { await w.__test_voice.leave(); } catch { /* ignore */ }
    }
  });
}

/** Poll a predicate at 250 ms cadence until truthy or deadline elapses. */
export async function waitFor<T>(
  fn: () => Promise<T> | T,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${description} (last=${JSON.stringify(last)})`);
}

/** Log helpers re-exported so specs only need one import. */
export { logFail, logObserved, logOk, logWarn };
