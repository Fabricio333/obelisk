# Mesh — Testing

Two layers:

| Layer | Tool | Where | Run with |
|---|---|---|---|
| Unit + integration | Vitest + jsdom | `src/lib/voice/*.test.ts` | `npm run test` |
| End-to-end | Playwright + real Chromium WebRTC | `scripts/e2e/voice/*.spec.ts` | `npm run test:e2e:voice` |

## Unit / integration (Vitest)

Each `.ts` file in `src/lib/voice/` has a sibling `.test.ts`. Mocks
live in:

- `bridgeFake.impl` — fake `NostrBridge` (look at
  `src/lib/voice/transport.test.ts` for the canonical setup).
- `FakePc` / `FakeDataChannel` in `control-channel.test.ts` — for the
  data-channel layer.
- A real-ish PC pair via `peer-pair.integration.test.ts` exercising
  the SDP exchange end to end with mocked transport.

`npm run test` runs the full ~1000-test suite in <20s. Add new tests
beside the file you're changing.

## End-to-end (Playwright)

```bash
# 1. Build the production bundle (HMR / Fast Refresh would re-mount
#    the VoiceClient mid-test, breaking the harness):
npm run build

# 2. Start the production server on an unused port:
PORT=3001 npx next start &

# 3a. Run the focused media-sync regression (two browsers, audio + camera RTP):
OBELISK_E2E_BASE_URL=http://localhost:3001 npx playwright test --config=scripts/e2e/playwright.config.ts scripts/e2e/voice/two-peer-mesh.spec.ts

# 3b. Run the full voice E2E directory when you need all topology specs:
OBELISK_E2E_BASE_URL=http://localhost:3001 npm run test:e2e:voice
```

`npm run test:e2e:voice:headed` adds `--headed` for live observation.

The specs run against `wss://public.obelisk.ar` by default. Override with `OBELISK_E2E_RELAY`, but use credentials authorized by that relay. The selected relay is never silently replaced.

### Specs

| Spec | What it proves |
|---|---|
| `two-peer-mesh.spec.ts` | Beacon round-trip, signal round-trip, WebRTC `connectionState=connected`, audio RTP both ways, camera RTP both ways, UI-facing live audio/camera streams, build-tag check, and fast-hangup detection (<15 s) when one peer leaves |
| `three-peer-transitive.spec.ts` | Full mesh on 3 peers (each reports `connected=2`), 2 control channels per peer, heartbeat alive, at least one `transitive.discoveredViaControl > 0`, fast-hangup propagation when one peer leaves |
| `glare.spec.ts` | Two peers join at the exact same await tick → connection still establishes, exactly one control channel per side (no double-create) |
| `four-peer-media.spec.ts` | Full four-person room plus real audio, camera, and screen media flow |
| `five-peer-rejection.spec.ts` | Fifth lex-trailing peer receives `room-full`; the existing four remain stable |

### Media-sync Regression Checklist

The "Media syncing" failure mode can happen after peers are already visible and WebRTC reaches `connected`. The focused regression is:

1. Confirm the loaded client build with `window.__obeliskVoiceBuild`.
2. Run `npx vitest run src/lib/voice/client.test.ts src/lib/voice/peer.test.ts src/lib/voice/peer-pair.integration.test.ts`.
3. Build and restart the production server on the E2E port.
4. Run the focused `two-peer-mesh.spec.ts`; it must pass audio and camera RTP byte assertions plus UI-facing live-stream assertions in both directions.

The adapter delegates SDP/ICE/media renegotiation to `simple-peer`; regression coverage verifies deterministic initiator roles, opaque Nostr signal forwarding, recv-only transceiver requests, terminal redial, and media flow. Keep TURN forcing off for normal mesh tests; set `TEST_PEER_FORCE_RELAY=1` or `NEXT_PUBLIC_FORCE_RELAY=1` only for explicit TURN-only debugging.

### Why bypass the VoiceRoom UI?

The room's gate requires the channel's NIP-29 metadata (kind 39000)
to land on the relay AND the test pubkey to be in the member list.
For ad-hoc test channels that's chicken-and-egg. The harness drives
`VoiceClient` directly via `window.__obeliskVoiceClient` (a
test-only constructor exposure) with `{ open: true }` to skip the
membership gate. The transport, peer, and control-channel paths
under test are unaffected.

### SFU-hosted mesh test peer

The SFU repo includes a synthetic mesh peer that reuses the ffmpeg test-pattern
media path while speaking the browser mesh protocol:

```bash
cd /root/obelisk-sfu
TEST_PEER_RELAYS=wss://lacrypta-relay.obelisk.ar npm run test-peer:mesh -- <channel-id>
```

From the SFU admin UI, choose **Mesh P2P** in the Test peers form. The script
publishes kind 20078 beacons with diagnostic markers plus the same `p` and
`peer` gossip tags documented in `mesh-protocol.md`, then exchanges kind
25050 offer/answer/ICE directly with channel peers. It also speaks the
`obelisk-control` data channel, including `hello`, `peerSnapshot`, ping/pong,
and incremental peer add/remove hints. Browser clients admit the marked peer
only when the local viewer is a channel admin, which lets operators test
private channels without editing the NIP-29 member list.

### Synthetic media

Headless Chromium's `--use-fake-device-for-media-stream` can hang on
`getUserMedia` on some platforms. `installFakeMediaStreams` in
`lib-voice.ts` overrides `navigator.mediaDevices.getUserMedia` with
a Web Audio `OscillatorNode` (220 Hz sine, low gain) and a
canvas `captureStream(15)` so every test gets deterministic real
audio + video frames hitting the encoder.

### Adding a new failure-injection spec

Pattern:

1. Spawn the contexts you need (one BrowserContext per peer).
2. `seedSession` with fresh ephemeral nsecs.
3. `installFakeMediaStreams` on each.
4. `pages[i].goto('/voice/<channelId>')`.
5. `waitForRelayOk` + `waitForBridgeReady` on each.
6. `joinMeshChannel(page, channelId, { otherMembers })`.
7. Inject the failure (e.g. drop the relay subscription, kill the
   data channel, throttle a publish — exposed via `__test_voice` for
   white-box access).
8. Assert via `readMetrics(page)` on the post-condition counter.

Keep specs single-purpose — one failure mode per spec, the smallest
peer count that exercises it. Combined-failure scenarios are
expensive to debug when they fail.
