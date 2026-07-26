# Mesh — Code Map

`src/lib/voice/` (top-level files; tests sit alongside their sources).

## Public surface

- **`client.ts` → `VoiceClient`** — the orchestrator. Holds the
  Map of Peers, owns the SimplePool subscriptions, manages topology
  (mesh ↔ SFU), exposes events to React. **Everything outside the
  voice/ folder imports through here.**
- **`active-client.ts`** — module-singleton holder so the chat UI's
  `getActiveVoiceClient()` returns the same instance the VoiceRoom
  mounted, even across route changes that re-mount React.
- **`jump-to-voice.ts`** — programmatic navigation helper used by the
  ProfilePopover "join their voice channel" button.

## Mesh internals

- **`peer.ts` → `Peer`** — one per remote pubkey. Adapts the established
  [`simple-peer`](https://github.com/feross/simple-peer) library to signed
  Nostr signaling, local media/quality policy, and the ordered control data
  channel. Lexicographic pubkey roles select exactly one initiator per pair;
  terminal failures return to `VoiceClient` for discovery-driven redial.
- **`transport.ts`** — thin Nostr layer on top of the bridge.
  - `publishPresenceBeacon(channelId, connectedTo, videoTracks)`
  - `subscribeRoster(channelId, onChange)`
  - `sendSignal(channelId, toPubkey, payload)`
  - `subscribeSignals(channelId, selfPubkey, onSignal)`
  - `transitiveParticipants(roster)` — derives the union of beacon
    publishers + their `p`-tag connectedTo lists.
- **`control-channel.ts`** — shared control message types and timing
  constants. `Peer` sends them through `simple-peer`'s ordered data channel:
  2.5 s ping, 20 s dead-peer timeout, 5 s peer snapshots,
  `hello`/`peerAdded`/`peerRemoved`/`bye`, and RTT measurement.
- **`discovery.ts` → `DiscoveryEngine`** — union of relay-derived
  and control-channel-derived peer sets. Keyed by `(pubkey, viaPeer)`
  for control claims; removal-when-no-claimants prevents flicker on
  partial partitions.
- **`failure-handlers.ts`** — small primitives:
  - `withRateLimitBackoff` — wraps publishes with exponential retry
    on rate-limit-shaped errors.
  - `installBeforeUnloadHandler` — synchronous tab-close goodbye.
- **`metrics.ts`** — `VoiceMetrics` interface + `emptyVoiceMetrics()`.
  Mounted on `VoiceClient.metrics`, mirrored to
  `window.__obeliskVoiceMetrics`.
- **`debug.ts`** — `pushVoiceDebug()` ring buffer (500 events) at
  `window.__obeliskVoiceDebug`. Read by the Playwright harness and
  the `?debug=voice` overlay.

## SFU internals (separate engine)

- **`sfu-client.ts` → `SfuClient`** — mediasoup-client wrapper that
  speaks the SFU's RPC envelopes over direct WebSocket.
- **`sfu-control.ts`** — `pickSfu()` resolves the SFU pubkey for a
  channel via per-channel pin, env override, or kind 31313
  advertisement.
- **`sfu-rpc.ts`** — direct authenticated WebSocket RPC framing with
  kind 25050 as an older-server fallback.
- **`sfu-pin.ts`** — validates an SFU URL via `/info` and stores the
  verified per-channel kind 30078 pin.

## Shared helpers

- **`types.ts`** — shared TS types (`VoicePresence`,
  `VoiceSignalPayload`, `VoiceTrackKind`, `VoiceQualityHint`,
  `VideoSlotKind`).
- **`stats.ts`** — `startStatsMonitor` for periodic
  `getStats()`-derived `QualitySample` events.
- **`quality.ts`** — `VIDEO_QUALITIES`, `MIC_CONSTRAINTS`,
  `AUDIO_MAX_BITRATE`.
- **`speaking-detector.ts`** — RMS threshold + holdoff for
  speaking-orb pulses. Shared AudioContext to avoid per-peer
  allocation.

## React surface

- **`src/components/voice/VoiceRoom.tsx`** — the main UI shell.
  Mounts `VoiceClient`, wires events to local state, renders tiles.
- **`src/components/voice/VoiceControls.tsx`** — mic/cam/screen/leave
  toolbar.
- **`src/components/voice/VoiceStatusBar.tsx`** — minimized "you're
  in a call" status pill.
- **`src/components/voice/DebugOverlay.tsx`** — `?debug=voice`
  diagnostic overlay (Phase 3).

## Hooks

- **`src/hooks/chat/useVoiceChatPane.ts`** — joint hook for the chat
  side panel that coordinates voice state with the chat tab.

## Module deferred from this round

The plan called for a `mesh/` + `sfu/` + `shared/` subdirectory split.
That's a purely mechanical reorganization that adds churn without
changing behavior; it can be done as a separate commit. The current
flat layout is small enough (≤ 20 files) that the cognitive load of
finding any given thing is low.
