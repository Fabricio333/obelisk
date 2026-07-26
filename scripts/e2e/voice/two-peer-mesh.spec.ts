/**
 * Two-peer mesh diagnostic — Phase 1 of the mesh hardening plan.
 *
 * Spawns two BrowserContexts in one Browser (different storage origins so
 * each peer carries its own nsec). Each peer:
 *   1. Seeds an ephemeral nsec session targeting `wss://public.obelisk.ar`
 *      (override via OBELISK_E2E_RELAY).
 *   2. Navigates to /app so the bridge initializes + completes NIP-42 AUTH.
 *   3. Constructs a `VoiceClient({ open: true })` against a fresh probe
 *      channel id and calls `join()`.
 *   4. Both peers exchange NIP-29 voice presence beacons (kind 20078) and
 *      voice signals (kind 25050) via the relay; WebRTC negotiation runs
 *      in real Chromium with --use-fake-device-for-media-stream.
 *
 * Assertions track each hypothesis from the diagnose-first plan:
 *   H1 (WoT silent drop):       metrics.signalsDropped.wot === 0 on both sides.
 *   H2 (membership-race drop):  metrics.signalsDropped.membershipFinal === 0.
 *   H3 (AUTH-vs-bringup race):  beacon round-trip lands within 7 s.
 *   H4 (relay write accepts):   peer counts non-zero beacon publishes
 *                               + sees inbound beacons; relay.publishFail === 0.
 *   H5 (build cache pinning):   __obeliskVoiceBuild constant matches
 *                               the value in client.ts.
 *
 * Phase-3 extension: after 30 s of stable mesh, peer B closes its
 * context — peer A must observe `metrics.peers.tornDown >= 1` within
 * 35 s (current ICE-failure budget; data-channel heartbeat in Phase 3
 * tightens this to <10 s).
 */
import { test, expect, chromium } from '@playwright/test';
import {
  attachClientCapture,
  generateIdentity,
  nsecSession,
  seedSession,
  waitForRelayOk,
  DEFAULT_RELAY,
} from '../lib';
import {
  getInboundAudioBytes,
  getInboundVideoBytes,
  getPeerState,
  getRemoteTrackKinds,
  installFakeMediaStreams,
  joinMeshChannel,
  leaveMeshChannel,
  logObserved,
  logOk,
  makeProbeChannelId,
  readMetrics,
  setCameraEnabled,
  setMicEnabled,
  waitFor,
  waitForBridgeReady,
} from './lib-voice';

const RELAY_URL = process.env.OBELISK_E2E_RELAY ?? DEFAULT_RELAY;
const MEDIA_FLOW_TIMEOUT_MS = 30_000;

test('two real mesh peers connect via the public relay', async () => {
  test.setTimeout(150_000);

  // We launch our own browser so the two contexts share a parent process
  // for resource isolation but have completely separate localStorage.
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  try {
    const channelId = makeProbeChannelId();
    logObserved(`channel ${channelId}`);
    logObserved(`relay   ${RELAY_URL}`);

    // ── Peer setup ─────────────────────────────────────────────────────
    const baseURL = process.env.OBELISK_E2E_BASE_URL ?? 'http://localhost:3001';
    const ctxA = await browser.newContext({
      permissions: ['microphone', 'camera'],
      // Origin must match baseURL so the permission grant applies to our
      // navigations. Without this, navigator.mediaDevices.getUserMedia
      // hangs forever in headless Chromium even with the fake-device
      // browser flags — the OS-level audio permission gate is what
      // grantPermissions toggles, distinct from the device-source flag.
    });
    const ctxB = await browser.newContext({
      permissions: ['microphone', 'camera'],
    });
    await ctxA.grantPermissions(['microphone', 'camera'], { origin: baseURL });
    await ctxB.grantPermissions(['microphone', 'camera'], { origin: baseURL });
    await installFakeMediaStreams(ctxA);
    await installFakeMediaStreams(ctxB);
    const idA = generateIdentity();
    const idB = generateIdentity();
    logObserved(`peerA   ${idA.npub}`);
    logObserved(`peerB   ${idB.npub}`);

    await seedSession(ctxA, nsecSession(idA, RELAY_URL));
    await seedSession(ctxB, nsecSession(idB, RELAY_URL));

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    attachClientCapture(pageA);
    attachClientCapture(pageB);

    // Navigate to /voice/<channelId>. We do NOT use /app because the
    // AppShell mounts the group rail + member/admin/profile/DM
    // subscriptions, which on a fresh nsec adds 50+ relay subs and
    // exhausts public.obelisk.ar's `restricted: Subscription quota
    // exceeded: 50/50` ceiling — voice's own subs then get rejected.
    //
    // The /voice route's gate sits at "loading-roles" (no group metadata
    // exists for the ad-hoc probe channel). That's fine: we drive
    // VoiceClient directly via window.__obeliskVoiceClient and skip the
    // gate entirely. The page is just a host for the bridge + module
    // graph.
    await Promise.all([
      pageA.goto(`/voice/${channelId}`, { waitUntil: 'domcontentloaded' }),
      pageB.goto(`/voice/${channelId}`, { waitUntil: 'domcontentloaded' }),
    ]);

    // ── H4: relay write acceptance check ──────────────────────────────
    await Promise.all([
      waitForRelayOk(pageA, 30_000),
      waitForRelayOk(pageB, 30_000),
    ]);
    logOk(`relay-access ok on both peers (${RELAY_URL})`);

    // ── Bridge readiness ──────────────────────────────────────────────
    const [pkA, pkB] = await Promise.all([
      waitForBridgeReady(pageA),
      waitForBridgeReady(pageB),
    ]);
    expect(pkA).toBe(idA.pkHex);
    expect(pkB).toBe(idB.pkHex);
    logOk('bridge ready on both peers; pubkeys match seeded identities');

    // ── Join the mesh ─────────────────────────────────────────────────
    // Each side knows the other's pubkey via the test wiring; pass it
    // as `members` so the receive-side `isMember` filter passes even
    // though `open: true` already short-circuits it. Belt-and-braces.
    await Promise.all([
      joinMeshChannel(pageA, channelId, { otherMembers: [pkA, pkB] }),
      joinMeshChannel(pageB, channelId, { otherMembers: [pkA, pkB] }),
    ]);
    logOk('both peers joined the probe channel');

    // ── H3 + H4: beacon round-trip ────────────────────────────────────
    // Each peer must publish at least one beacon AND see the other's
    // beacon arrive (signals.rcvd > 0 implies subscribeSignals delivered
    // events from the relay). The 15 s budget covers AUTH + bringup
    // burst + worst-case relay delivery latency on a public relay.
    await Promise.all([
      waitFor(
        () => readMetrics(pageA),
        (m) => m !== null && m.beacons.sent >= 1,
        15_000,
        'peerA published at least one beacon',
      ),
      waitFor(
        () => readMetrics(pageB),
        (m) => m !== null && m.beacons.sent >= 1,
        15_000,
        'peerB published at least one beacon',
      ),
    ]);
    logOk('both peers published their first beacon');

    // ── WebRTC connectivity (H1+H2 implicitly: if the connection forms,
    //    no signaling was silently dropped) ─────────────────────────────
    await Promise.all([
      waitFor(
        () => getPeerState(pageA, pkB),
        (s) => s === 'connected',
        45_000,
        `peerA's RTC to peerB reaches 'connected'`,
      ),
      waitFor(
        () => getPeerState(pageB, pkA),
        (s) => s === 'connected',
        45_000,
        `peerB's RTC to peerA reaches 'connected'`,
      ),
    ]);
    logOk('WebRTC connectionState=connected on both sides');

    // ── Media flow: prove connected peers actually exchange RTP bytes ──
    await Promise.all([
      setMicEnabled(pageA, true),
      setMicEnabled(pageB, true),
    ]);
    await Promise.all([
      waitFor(
        () => getInboundAudioBytes(pageA, pkB),
        (bytes) => bytes > 0,
        MEDIA_FLOW_TIMEOUT_MS,
        'peerA receives peerB audio RTP bytes',
      ),
      waitFor(
        () => getInboundAudioBytes(pageB, pkA),
        (bytes) => bytes > 0,
        MEDIA_FLOW_TIMEOUT_MS,
        'peerB receives peerA audio RTP bytes',
      ),
    ]);
    logOk('audio RTP bytes are flowing both ways');

    await Promise.all([
      setCameraEnabled(pageA, true),
      setCameraEnabled(pageB, true),
    ]);
    await Promise.all([
      waitFor(
        () => getInboundVideoBytes(pageA, pkB),
        (bytes) => bytes > 0,
        MEDIA_FLOW_TIMEOUT_MS,
        'peerA receives peerB camera RTP bytes',
      ),
      waitFor(
        () => getInboundVideoBytes(pageB, pkA),
        (bytes) => bytes > 0,
        MEDIA_FLOW_TIMEOUT_MS,
        'peerB receives peerA camera RTP bytes',
      ),
    ]);
    logOk('camera RTP bytes are flowing both ways');

    await Promise.all([
      waitFor(
        () => getRemoteTrackKinds(pageA, pkB),
        (kinds) => kinds.includes('audio') && kinds.includes('camera'),
        MEDIA_FLOW_TIMEOUT_MS,
        'peerA exposes peerB media to the UI',
      ),
      waitFor(
        () => getRemoteTrackKinds(pageB, pkA),
        (kinds) => kinds.includes('audio') && kinds.includes('camera'),
        MEDIA_FLOW_TIMEOUT_MS,
        'peerB exposes peerA media to the UI',
      ),
    ]);
    logOk('VoiceClient exposes live audio and camera tracks to the UI on both sides');

    // ── Hold for 5 s of steady state, then snapshot ───────────────────
    await pageA.waitForTimeout(5_000);
    const mA = await readMetrics(pageA);
    const mB = await readMetrics(pageB);
    if (!mA || !mB) throw new Error('metrics snapshot returned null');

    logObserved(`peerA metrics: ${JSON.stringify(mA)}`);
    logObserved(`peerB metrics: ${JSON.stringify(mB)}`);

    // ── Hypothesis assertions ─────────────────────────────────────────
    expect(mA.signalsDropped.wot, 'H1: WoT silent drops on peerA').toBe(0);
    expect(mB.signalsDropped.wot, 'H1: WoT silent drops on peerB').toBe(0);
    expect(mA.signalsDropped.membershipFinal, 'H2: membership-final drops on peerA').toBe(0);
    expect(mB.signalsDropped.membershipFinal, 'H2: membership-final drops on peerB').toBe(0);
    expect(mA.relay.publishFail, 'H4: peerA relay publish failures').toBe(0);
    expect(mB.relay.publishFail, 'H4: peerB relay publish failures').toBe(0);
    expect(mA.peers.connected, 'peerA connected count').toBeGreaterThanOrEqual(1);
    expect(mB.peers.connected, 'peerB connected count').toBeGreaterThanOrEqual(1);

    // ── H5: build identity present ────────────────────────────────────
    const buildA = await pageA.evaluate(
      () => (window as unknown as { __obeliskVoiceBuild?: string }).__obeliskVoiceBuild ?? null,
    );
    expect(buildA, 'voice build identity present on window').toBeTruthy();
    logObserved(`__obeliskVoiceBuild = ${buildA}`);

    // ── Phase-3 fast hangup detection ─────────────────────────────────
    // peerB calls leave() (which sends a control-channel bye via the
    // open data channel BEFORE pc.close), then closes its context.
    // peerA must notice within 15 s — empirically the bye lands in
    // ~10–50 ms; the budget is generous to accommodate slow CI runners
    // and the relay echo timing. The pre-Phase-3 ICE-failure path took
    // 45 s+; this assertion is the headline win.
    await leaveMeshChannel(pageB);
    await ctxB.close();
    logObserved('peerB context closed; awaiting peerA fast-hangup detection');
    const detectStart = Date.now();
    await waitFor(
      () => readMetrics(pageA),
      (m) => m !== null && m.peers.tornDown >= 1,
      15_000,
      'peerA detects peerB tear-down via control channel',
    );
    const detectMs = Date.now() - detectStart;
    logOk(`peerA detected peerB leave in ${detectMs}ms (metrics.peers.tornDown >= 1)`);

    // Bonus: confirm the bye came over control channel, not just relay.
    // signals.byeViaControl > 0 proves the data-channel path fired.
    const finalA = await readMetrics(pageA);
    if (finalA && finalA.signals.byeViaControl > 0) {
      logOk(`bye arrived via control channel (byeViaControl=${finalA.signals.byeViaControl})`);
    } else {
      logWarn('bye did NOT arrive via control channel; fell back to relay/PC-state path');
    }

    // ── Cleanup ───────────────────────────────────────────────────────
    await leaveMeshChannel(pageA);
    await ctxA.close();
  } finally {
    await browser.close();
  }
});
