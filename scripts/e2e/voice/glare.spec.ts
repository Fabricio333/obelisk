/**
 * Glare regression spec — Phase 3 of the mesh hardening plan.
 *
 * Two peers join the same channel within milliseconds of each other so
 * the deterministic pubkey roles select one simple-peer initiator; the connection still establishes within the normal
 * connect window. With the control channel we want
 * to be sure the data channel didn't introduce a new glare path
 * (impolite creates the channel; polite waits for ondatachannel —
 * symmetric, no double-create).
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
  getPeerState,
  installFakeMediaStreams,
  joinMeshChannel,
  leaveMeshChannel,
  logObserved,
  logOk,
  makeProbeChannelId,
  readMetrics,
  waitFor,
  waitForBridgeReady,
} from './lib-voice';

const RELAY_URL = process.env.OBELISK_E2E_RELAY ?? DEFAULT_RELAY;

test('simultaneous join still establishes a single PC + control channel pair', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });

  try {
    const channelId = makeProbeChannelId();
    const baseURL = process.env.OBELISK_E2E_BASE_URL ?? 'http://localhost:3001';

    const [ctxA, ctxB] = await Promise.all([
      browser.newContext({ permissions: ['microphone', 'camera'] }),
      browser.newContext({ permissions: ['microphone', 'camera'] }),
    ]);
    await ctxA.grantPermissions(['microphone', 'camera'], { origin: baseURL });
    await ctxB.grantPermissions(['microphone', 'camera'], { origin: baseURL });
    await installFakeMediaStreams(ctxA);
    await installFakeMediaStreams(ctxB);

    const idA = generateIdentity();
    const idB = generateIdentity();
    await seedSession(ctxA, nsecSession(idA, RELAY_URL));
    await seedSession(ctxB, nsecSession(idB, RELAY_URL));

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    attachClientCapture(pageA);
    attachClientCapture(pageB);

    await Promise.all([
      pageA.goto(`/voice/${channelId}`, { waitUntil: 'domcontentloaded' }),
      pageB.goto(`/voice/${channelId}`, { waitUntil: 'domcontentloaded' }),
    ]);
    await Promise.all([waitForRelayOk(pageA), waitForRelayOk(pageB)]);
    const [pkA, pkB] = await Promise.all([waitForBridgeReady(pageA), waitForBridgeReady(pageB)]);

    // Fire BOTH joins at the exact same await tick so the offers race.
    logObserved('forcing simultaneous join');
    const both = Promise.all([
      joinMeshChannel(pageA, channelId, { otherMembers: [pkA, pkB] }),
      joinMeshChannel(pageB, channelId, { otherMembers: [pkA, pkB] }),
    ]);
    await both;
    logOk('both peers joined simultaneously');

    // Despite the race the connection must still reach 'connected' on
    // both sides. The data channel must open exactly once (counter == 1).
    await Promise.all([
      waitFor(() => getPeerState(pageA, pkB), (s) => s === 'connected', 60_000, 'A→B connected'),
      waitFor(() => getPeerState(pageB, pkA), (s) => s === 'connected', 60_000, 'B→A connected'),
    ]);
    logOk('both PCs connected after glare');

    await pageA.waitForTimeout(3_000);
    const mA = await readMetrics(pageA);
    const mB = await readMetrics(pageB);
    expect(mA, 'A metrics').not.toBeNull();
    expect(mB, 'B metrics').not.toBeNull();

    expect(mA!.controlChannel.opened, 'A: exactly one control channel').toBe(1);
    expect(mB!.controlChannel.opened, 'B: exactly one control channel').toBe(1);
    expect(mA!.peers.connected, 'A: one connected peer').toBe(1);
    expect(mB!.peers.connected, 'B: one connected peer').toBe(1);
    logOk('exactly one control channel per side; glare resolved cleanly');

    await leaveMeshChannel(pageA);
    await leaveMeshChannel(pageB);
    await ctxA.close();
    await ctxB.close();
  } finally {
    await browser.close();
  }
});
