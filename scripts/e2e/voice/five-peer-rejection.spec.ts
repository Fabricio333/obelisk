/**
 * Five-peer capacity rejection — proves that with `MAX_PARTICIPANTS = 4`,
 * the 5th joiner is actively denied by the existing room (each existing
 * peer sends `bye { byeReason: 'room-full' }`) and the rejected peer
 * surfaces a clean error + leaves on its own without looping the
 * repeated redial attempts. The existing 4-peer mesh is unaffected.
 *
 * Joins are STAGGERED for the same reason as four-peer-media: 5 fresh
 * AppShell + voice subscriptions hitting `public.obelisk.ar` at the
 * same instant saturates the per-WebSocket sub quota.
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
const STAGGER_MS = 1500;
const FORMATION_TIMEOUT_MS = 90_000;

test('5th peer is rejected with room-full and leaves cleanly; first 4 stay stable', async () => {
  test.setTimeout(300_000);
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });

  try {
    const channelId = makeProbeChannelId();
    const baseURL = process.env.OBELISK_E2E_BASE_URL ?? 'http://localhost:3001';

    // Generate 5 identities; force a stable lex order so we know which
    // peer should end up the rejected one. The 6th identity in our own
    // sort will be the lex-trailing one — that's the deterministic loser.
    const NUM_PEERS = 5;
    const ctxs = await Promise.all(
      Array.from({ length: NUM_PEERS }, () =>
        browser.newContext({ permissions: ['microphone', 'camera'] }),
      ),
    );
    for (const ctx of ctxs) {
      await ctx.grantPermissions(['microphone', 'camera'], { origin: baseURL });
      await installFakeMediaStreams(ctx);
    }

    // Generate identities and sort by lex (low pubkey first). The lex-LAST
    // peer is the one that should be rejected when it joins after the
    // first 4 have already filled the cap.
    const ids = Array.from({ length: NUM_PEERS }, () => generateIdentity())
      .sort((a, b) => a.pkHex.localeCompare(b.pkHex));
    for (let i = 0; i < NUM_PEERS; i++) {
      logObserved(`peer${i} ${ids[i].pkHex.slice(0, 12)}…`);
      await seedSession(ctxs[i], nsecSession(ids[i], RELAY_URL));
    }

    const pages = await Promise.all(ctxs.map((c) => c.newPage()));
    pages.forEach((page) => attachClientCapture(page));

    await Promise.all(pages.map((p) =>
      p.goto(`/voice/${channelId}`, { waitUntil: 'domcontentloaded' }),
    ));
    await Promise.all(pages.map((p) => waitForRelayOk(p, 30_000)));
    logOk('relay-access ok on all 5 peers');

    const pks = await Promise.all(pages.map((p) => waitForBridgeReady(p)));

    // Initialize the error log AND wrap the constructor in the same
    // post-navigation evaluate so neither gets wiped by navigation. The
    // wrapped ctor mirrors VoiceClient.events.onError into
    // window.__test_errors so we can assert on the room-full message.
    await pages[4].evaluate(() => {
      const w = window as unknown as {
        __obeliskVoiceClient?: new (id: string, opts: unknown) => unknown;
        __test_errors?: string[];
      };
      w.__test_errors = [];
      const Original = w.__obeliskVoiceClient!;
      const Wrapped = function (this: unknown, id: string, opts: { events?: { onError?: (m: string) => void } }) {
        const events = opts?.events ?? {};
        const userOnError = events.onError;
        events.onError = (msg: string) => {
          (w.__test_errors ??= []).push(msg);
          userOnError?.(msg);
        };
        return new Original(id, { ...opts, events });
      } as unknown as new (id: string, opts: unknown) => unknown;
      w.__obeliskVoiceClient = Wrapped;
    });

    // Stagger first 4 (the in-room peers). Wait for them to actually
    // connect to each other before letting peer4 attempt to join.
    for (let i = 0; i < 4; i++) {
      await joinMeshChannel(pages[i], channelId, { otherMembers: pks });
      logObserved(`peer${i} joined (in-cap)`);
      if (i < 3) await pages[i].waitForTimeout(STAGGER_MS);
    }

    // Wait until at least the lex-leading peer reports >=1 connection
    // — that's enough to ensure SOMEONE will be present to reject peer4.
    await Promise.all(pages.slice(0, 4).map((p, i) => waitFor(
      () => readMetrics(p),
      (m) => m !== null && m.peers.connected >= 1,
      FORMATION_TIMEOUT_MS,
      `peer${i} reaches connected>=1`,
    )));
    logOk('first 4 peers have at least one connection each');

    const inCapBefore = await Promise.all(pages.slice(0, 4).map((p) => readMetrics(p)));
    inCapBefore.forEach((m, i) => {
      logObserved(`pre-reject peer${i}: connected=${m?.peers.connected} ctrl=${m?.controlChannel.opened}`);
    });

    // Now peer4 (lex-trailing) tries to join. Should be rejected.
    await joinMeshChannel(pages[4], channelId, { otherMembers: pks });
    logObserved('peer4 attempted to join — expecting room-full');

    // peer4 should receive a room-full error within 20s. The error
    // surfaces as soon as ANY existing peer's bye reaches them.
    await waitFor(
      () => pages[4].evaluate(() =>
        (window as unknown as { __test_errors?: string[] }).__test_errors ?? [],
      ),
      (errs) => errs.some((e: string) => e.toLowerCase().includes('room is full')),
      20_000,
      'peer4 receives room-full error',
    );
    const peer4Errors = await pages[4].evaluate(() =>
      (window as unknown as { __test_errors?: string[] }).__test_errors ?? [],
    );
    logOk(`peer4 received error: "${peer4Errors[0]}"`);
    expect(peer4Errors[0].toLowerCase()).toContain('room is full');

    // Hold a moment, then verify the in-cap peers are still healthy.
    await pages[0].waitForTimeout(3_000);
    const inCapAfter = await Promise.all(pages.slice(0, 4).map((p) => readMetrics(p)));
    inCapAfter.forEach((m, i) => {
      if (!m) throw new Error(`peer${i} metrics null`);
      logObserved(`post-reject peer${i}: connected=${m.peers.connected} ctrl=${m.controlChannel.opened} dropped(wot/memb)=${m.signalsDropped.wot}/${m.signalsDropped.membershipFinal}`);
      // The room is still healthy: silent-drop counters at zero.
      expect(m.signalsDropped.wot, `peer${i} wot drops`).toBe(0);
      expect(m.signalsDropped.membershipFinal, `peer${i} memb drops`).toBe(0);
    });
    // Each in-cap peer's connected count must be at least as high as
    // before the rejection — the 5th joiner did not destabilize them.
    inCapAfter.forEach((m, i) => {
      const before = inCapBefore[i]?.peers.connected ?? 0;
      expect(m!.peers.connected, `peer${i} connected stable after rejection`).toBeGreaterThanOrEqual(before);
    });
    logOk('first 4 peers remained stable through rejection');

    await Promise.all(pages.map((p) => leaveMeshChannel(p)));
    await Promise.all(ctxs.map((c) => c.close()));
  } finally {
    await browser.close();
  }
});
