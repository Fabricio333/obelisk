# SFU integration (client side)

The SFU server itself — mediasoup, Nostr-RPC signaling, allow-list, deploy —
lives in its own repo: **[obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu)**.
Read that repo's `README.md` and `docs/` for the wire protocol, server
architecture, and operator runbook.

This doc covers only how the obelisk-dex client integrates with an SFU.

## When the dex switches from mesh to SFU

`VoiceClient` in [src/lib/voice/client.ts](../src/lib/voice/client.ts) owns
the topology decision. The switch fires when **both**:

1. The channel is tagged `voice-sfu` (NIP-29 group with `["t","voice-sfu"]`).
2. `pickSfu()` in [src/lib/voice/sfu-control.ts](../src/lib/voice/sfu-control.ts)
   returns a non-null SFU — either via cached kind 31313 advertisement OR
   via the `NEXT_PUBLIC_SFU_PUBKEY` / `NEXT_PUBLIC_SFU_URL` /
   `NEXT_PUBLIC_SFU_TRUSTED_RELAYS` build-time pins.

When both hold, the client publishes a kind 25052 `start` and instantiates
`SfuClient` ([src/lib/voice/sfu-client.ts](../src/lib/voice/sfu-client.ts)).
Ordinary `voice` channels use the four-person mesh. A `voice-sfu` channel without a reachable SFU surfaces an error instead of silently falling back.

## Client modules

| File                              | Responsibility                                                                   |
|-----------------------------------|----------------------------------------------------------------------------------|
| `src/lib/voice/client.ts`         | Topology decision (`setSfuMode`), routes media setters to the active engine.     |
| `src/lib/voice/sfu-control.ts`    | Discovery (kind 31313), `start` publishing, rate-limit, build-time pin override. |
| `src/lib/voice/sfu-rpc.ts`        | Browser-side RPC envelope client over kind 25050.                                |
| `src/lib/voice/sfu-client.ts`     | mediasoup-client `Device` + send/recv `Transport`, ICE servers, producer mgmt.   |
| `src/lib/voice/peer.ts`           | `simple-peer` mesh adapter (P2P WebRTC over kinds 20078/25050).                  |

## Build-time SFU pinning

NIP-29-only relays (e.g. `lacrypta-relay.obelisk.ar`) do not store kind 31313, so the
dex can't always discover an SFU through the same relay it uses for the
group. To skip discovery, set in `.env.local`:

```
NEXT_PUBLIC_SFU_PUBKEY=<sfu hex pubkey>
NEXT_PUBLIC_SFU_URL=https://sfu.obelisk.ar
NEXT_PUBLIC_SFU_TRUSTED_RELAYS=wss://lacrypta-relay.obelisk.ar
```

`pickSfu()` short-circuits when these are set — no kind 31313 round-trip
needed.

## Testing

`scripts/sfu-test-peers/` contains synthetic peers that drive the SFU via
ffmpeg-fed `PlainTransport`s. See that directory's README. Useful for
verifying the client's `newProducer` consumption path without orchestrating
two browsers.

## See also

- [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu) — server, protocol, deployment
- [docs/voice/](voice/README.md) — mesh voice (P2P over Nostr signaling + per-peer control-channel data plane)
