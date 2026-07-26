# SFU integration (client side)

Obelisk uses mediasoup for `voice-sfu` channels. The selected SFU is stored
as a channel-admin NIP-78 pin, but mediasoup RPC normally travels directly to
the SFU's authenticated WebSocket—not through Nostr relays.

The server implementation and operator runbook live at
[obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu).

## Topology decision

`VoiceClient` chooses SFU mode only when both conditions hold:

1. channel metadata is `voice-sfu`;
2. `pickSfu(channelId)` resolves a per-channel pin, build fallback, or kind
   31313 advertisement.

Ordinary `voice` channels retain the four-person `simple-peer` mesh. An
SFU channel never silently falls back to mesh when its operator is unavailable.

## URL-only channel settings

Channel admins enter one URL, such as `https://sfu.obelisk.ar`. The editor
fetches `/info`, verifies that it is an Obelisk SFU, validates its 64-character
hex pubkey and same-origin advertised URL, and stores the returned identity and
compatibility relays in kind 30078.

The verified full pubkey is shown for advanced out-of-band comparison. Pubkey
and relay inputs are deliberately not editable: the SFU is their source of
truth.

## Connection flow

1. Resolve the kind 30078 pin and SFU URL.
2. Open `wss://<sfu>/rpc?channelId=<id>`.
3. Sign the server's kind 22242 challenge with the active Nostr signer.
4. The SFU verifies identity and its allow-list, returning `auth_ok` or a
   4403 authorization close.
5. Exchange mediasoup RPC envelopes over that socket.
6. Send audio/video/screen media via mediasoup WebRTC transports.

If direct RPC is unavailable because an older SFU does not expose `/rpc`,
`SfuRpc` retains kind 25050 relay RPC as a compatibility fallback. Explicit
authentication/whitelist failures never fall back.

## Client modules

| File | Responsibility |
|---|---|
| `src/lib/voice/client.ts` | Topology selection and shared UI-facing API. |
| `src/lib/voice/sfu-pin.ts` | URL verification plus kind 30078 pin storage. |
| `src/lib/voice/sfu-control.ts` | Pin/build/discovery resolution and legacy start control. |
| `src/lib/voice/sfu-rpc.ts` | Direct signed WebSocket RPC with kind 25050 fallback. |
| `src/lib/voice/sfu-client.ts` | mediasoup-client Device, transports, producers, and consumers. |

## Build fallback

Unpinned channels can use:

```dotenv
NEXT_PUBLIC_SFU_PUBKEY=<sfu hex pubkey>
NEXT_PUBLIC_SFU_URL=https://sfu.obelisk.ar
NEXT_PUBLIC_SFU_RELAYS=wss://public.obelisk.ar
NEXT_PUBLIC_SFU_TRUSTED_RELAYS=wss://lacrypta-relay.obelisk.ar
```

A per-channel verified URL pin takes precedence. The relay variables are only
needed for discovery/compatibility, not normal direct mediasoup RPC.

## Verification

Run the focused client checks:

```bash
npx vitest run src/lib/voice/sfu-pin.test.ts src/lib/voice/sfu-rpc.test.ts src/lib/voice/sfu-control.test.ts src/lib/voice/sfu-client-reliability.test.ts
```

The server release gate is `npm audit --omit=dev`, typecheck, full tests, and
build in the SFU repository.
