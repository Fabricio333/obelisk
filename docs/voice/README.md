# Voice — Overview

Obelisk has two voice engines that share one client surface
(`src/lib/voice/client.ts` → `VoiceClient`). UI components never see
which engine is active; they consume `VoiceClient` events.

| Engine | Topology | When | Code |
|---|---|---|---|
| **mesh** | P2P full mesh via `simple-peer`; discovery/signaling on Nostr (kinds 20078 + 25050) | rooms of at most 4 people, no SFU advertised on the channel | `src/lib/voice/{client,peer,transport,control-channel,discovery,failure-handlers}.ts` |
| **SFU** | mediasoup, direct signed WebSocket RPC (kind 25050 fallback) | a verified URL pin, build pin, or kind 31313 advertisement resolves AND the channel is the `voice-sfu` kind | `src/lib/voice/{sfu-client,sfu-control,sfu-rpc,sfu-pin}.ts` (server lives in [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu)) |

This directory documents the **mesh** engine in depth. SFU docs are at
[`../sfu-system.md`](../sfu-system.md).

## When to read what

- **[mesh-protocol.md](mesh-protocol.md)** — the wire protocol: presence
  beacons (kind 20078), `simple-peer` signaling envelopes (kind 25050),
  transitive discovery, control-channel messages, media caps, and hangup
  paths. Read this first if you are touching anything that produces or
  consumes Nostr events for voice.
- **[mesh-modules.md](mesh-modules.md)** — code map of
  `src/lib/voice/`. Read this before adding a new file or moving an
  existing one.
- **[failure-modes.md](failure-modes.md)** — every known failure mode
  and the handler it routes through, with the metric you'd watch in
  the `?debug=voice` overlay. Read this before opening a "voice
  doesn't work" issue.
- **[remote-signing-optimization.md](remote-signing-optimization.md)** —
  proposal to reduce mesh beacon pressure on NIP-46 and extension
  signers, followed by an optional scoped voice-session key design.
- **[testing.md](testing.md)** — Playwright harness usage; how the
  two-peer / three-peer / glare specs run; how to add a new failure
  injection.

## What "mesh" buys you

- **No central server**. The dex stays workable as long as one Nostr
  relay is reachable. There is no obelisk-owned voice server in the
  mesh path.
- **End-to-end encryption** of media via DTLS-SRTP — Nostr only carries
  signaling; the relay never sees audio.
- **Sub-10s hangup detection** as of Phase 3 (control-channel
  heartbeat). Pre-Phase-3 the only signal was ICE failure ~30 s+ after
  the peer vanished.
- **Transitive WebRTC discovery**: when A↔B and B↔C are connected,
  A and C learn about each other through B's data channel without
  needing the relay to deliver every beacon symmetrically. The mesh
  forms even on a flaky relay link.

## What mesh does NOT do

- Rooms larger than 4 participants. The mesh degrades quadratically:
  four people produce six peer pairs and each browser maintains three
  direct connections. The 5th joiner is **actively rejected**: every
  in-cap peer sends a `bye { byeReason: 'room-full' }` so the joiner
  surfaces a clean "Room is full" error and leaves on its own
  without looping.
- More than four simultaneous cameras or more than one screen share.
  Camera and screen limits are independent and derived from signed relay
  beacons; `(createdAt, pubkey)` ordering resolves simultaneous claims
  consistently on every client.
- Anything beyond those limits needs the SFU engine.
- Recording. There's no central party to record. If recording is a
  product requirement, route the room through the SFU.
- Ad-hoc "anyone can speak". Voice is gated by the channel's NIP-29
  member list — same trust gate as text chat.

## Production NAT traversal

Presence and signaling use Nostr, but media still needs a WebRTC network
path. Production deployments must configure authenticated TURN so devices
behind symmetric or carrier-grade NAT do not remain at **Media syncing**:

```dotenv
NEXT_PUBLIC_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
NEXT_PUBLIC_TURN_USERNAME=<username>
NEXT_PUBLIC_TURN_CREDENTIAL=<credential>
```

These `NEXT_PUBLIC_*` values are embedded in the browser bundle, so rebuild
after changing them. Keep `NEXT_PUBLIC_FORCE_RELAY=0`; set it to `1` only
for a relay-only connectivity test.
