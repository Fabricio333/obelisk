# Mesh — Wire Protocol

Two Nostr event kinds + one in-PC data channel:

| Kind | Direction | Purpose |
|---|---|---|
| **20078** (presence beacon) | broadcast (`#e` = channel id) | publisher-is-alive, with `p` connected tags and `peer` known-active gossip tags |
| **25050** (signal envelope) | directed (`#p` = recipient) | SDP offer/answer/ICE/trackinfo/qualityhint/bye/requestReset, JSON-encoded in `content` |
| **`obelisk-control` data channel** | per-peer-pair, ordered | hello, peerSnapshot, ping/pong, peerAdded/peerRemoved, bye |

## Presence beacon (kind 20078)

```jsonc
{
  "kind": 20078,
  "content": "",
  "tags": [
    ["e", "<channel-id>"],
    ["t", "obelisk-voice-presence"],
    ["expiration", "<unix-seconds, +45 from publish>"],
    ["p", "<connected-peer-pubkey>"], // 0..N — peers we have a live PC to
    ["peer", "<known-active-peer-pubkey>"], // 0..N — peers known from relay/control/local state
    ["v", "camera"], ["v", "screen"],  // 0..2 — outbound video tracks
    ["sfu", "1"],                       // present iff this client is an SFU node
    ["client", "obelisk-mesh-test-peer"], // diagnostic mesh test peer marker
    ["test-peer", "mesh"]                // legacy/simple diagnostic marker
  ]
}
```

Cadence:

- **Steady state**: every 10 s (`BEACON_INTERVAL_MS`).
- **Bring-up burst**: at join, additional publishes scheduled at
  `[300, 900, 1800, 3500, 7000, 12000, 18000]` ms
  (`BEACON_BRINGUP_DELAYS_MS`) so a peer who joined a few seconds
  before us discovers us within seconds, not one full steady-state tick.
- **Refresh on connect/disconnect/discovery change**: when our connected
  set or known-active peer set changes, schedule a debounced beacon
  (~250 ms) so the new information shows up in everyone's transitive
  roster within a single hop.

The receiver dedups by `(pubkey, created_at)` — newer beacons replace
older ones; expired beacons (`expiration` past, normally 45 s after
publish) are swept out by `subscribeRoster`'s
`(PRESENCE_TTL_SECONDS / 2) * 1000` interval. Older clients that only
understand `p` tags still get connected-peer transitive discovery; newer
clients use `peer` tags to learn about participants that a publisher has
seen but not directly connected to yet.

### Diagnostic mesh test peers

Synthetic mesh peers spawned from the SFU admin UI publish the same presence
beacon plus both diagnostic markers:

- `["client", "obelisk-mesh-test-peer"]`
- `["test-peer", "mesh"]`

These peers are not SFUs and still negotiate direct P2P mesh. The marker only
changes the browser-side admission gate: a local channel admin may dial and
accept signals from the marked pubkey without first adding it to the NIP-29
member list. Regular members still apply the normal member/admin/open-room gate,
so the marker cannot be used by arbitrary pubkeys to join private calls for
non-admin viewers. This is for operator diagnostics and synthetic media tests.

## Signal envelope (kind 25050)

```jsonc
{
  "kind": 25050,
  "content": "<JSON of VoiceSignalPayload>",
  "tags": [
    ["p", "<recipient-pubkey>"],
    ["e", "<channel-id>"],
    ["t", "obelisk-voice-signal"]
  ]
}
```

`content` is a `VoiceSignalPayload` (see `src/lib/voice/types.ts`).
Variants:

| `type` | Carries |
|---|---|
| `peer` | opaque `peerSignal: SimplePeer.SignalData`, `sessionId`, `seq`; carries SDP, ICE, renegotiation, and transceiver requests |
| `trackinfo` | `trackInfo: { trackId, kind }`, `sessionId`, `seq` |
| `qualityhint` | `qualityHint: { maxBitrate, maxFramerate }`, `sessionId`, `seq` |
| `bye` | `sessionId`, `seq`, optional `byeReason: 'local-leave' \| 'room-full' \| string`. `'room-full'` is sent by every in-cap peer to a 5th arrival. |
| `offer`, `answer`, `ice`, `requestReset` | accepted on receive for rolling compatibility with the former custom negotiator; new clients publish `peer` |

The relay transport treats `peerSignal` as opaque JSON. Nostr pubkeys remain
the identity/admission boundary; `simple-peer` never chooses participant IDs.

### `simple-peer` negotiation

Polite/impolite is decided by lexicographic pubkey comparison
(`selfPubkey > remotePubkey` ⇒ polite/non-initiator). Therefore every pair has
exactly one initiator. The library emits `signal`; `Peer` wraps it as a
kind-25050 `type: 'peer'` event, and the recipient passes `peerSignal` to
`simplePeer.signal()`. Non-initiators use the library's `renegotiate` and
`transceiverRequest` signals rather than creating colliding offers.

### Recovery

`simple-peer` owns browser SDP, ICE, and media renegotiation. A 9 s initial
connection watchdog tears down peers that never open. Terminal library/PC
closure and heartbeat loss converge on `VoiceClient.tearDownPeer`; if the
pubkey remains present in relay or control discovery, the debounced dial loop
creates a fresh library peer and reattaches local tracks.

## Control channel (`obelisk-control`)

A single ordered RTCDataChannel per peer pair, labeled `obelisk-control`.
`simple-peer` creates it on the deterministic initiator and adopts it on the
non-initiator. This preserves exactly one control plane per pair while leaving
the existing Obelisk control messages unchanged.

```ts
type ControlMessage =
  | { type: 'hello'; peers: string[]; sessionId: string; build: string }
  | { type: 'peerSnapshot'; peers: string[]; ts: number }
  | { type: 'peerAdded'; pubkey: string }
  | { type: 'peerRemoved'; pubkey: string }
  | { type: 'bye'; reason: string }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number; echoTs: number };
```

Lifecycle (timing constants in `src/lib/voice/control-channel.ts`):

- **Connection timeout**: 9 s from peer construction to connection.
- **Heartbeat**: ping every 2.5 s. Pong response carries `echoTs` →
  RTT measurement.
- **Peer snapshot**: every 5 s, send `peerSnapshot { peers }` with the
  sender's full known-active peer set.
- **Dead-peer timer**: 20 s without ANY inbound traffic (ping, pong,
  hello, peerSnapshot, peerAdded/Removed) → `onDead('heartbeat-lost')`.
- **Bye**: synchronous send via `dc.send` BEFORE `pc.close()` →
  remote receives within ~10 ms.

Discovery propagation:

- On open, send `hello { peers: meshKnownPubkeys(), sessionId, build }`.
- Every 5 s, and after relay/control discovery changes, send
  `peerSnapshot { peers: meshKnownPubkeys(), ts }` to every open control
  channel. This is the reliable path for sharing peers that are in the call
  but not directly established yet.
- Whenever a new peer connects, send `peerAdded { pubkey }` to every
  OTHER peer as a fast incremental hint.
- Whenever a peer disconnects, send `peerRemoved { pubkey }` to every
  OTHER peer as a fast incremental hint.

The receiver feeds these into the `DiscoveryEngine`
(`src/lib/voice/discovery.ts`), which tracks `(pubkey, viaPeer)` so a
single peer's `peerRemoved` doesn't drop someone other peers still
claim. Full `peerSnapshot` messages replace the claims from that one
neighbor so stale transitive hints age out without requiring relay beacons.

## Hangup paths (in priority order)

1. **Control-channel `bye`** — primary. Sent synchronously over the
   data channel before `pc.close()`. Other side receives within
   ~10 ms; `onPeerDead('bye:local-leave')` fires immediately.
2. **Control-channel heartbeat-lost** — backup. 20 s after the last
   inbound message, `onDead('heartbeat-lost')` fires. Covers tab
   crashes / network blackouts where bye was never sent.
3. **Relay `bye` (kind 25050 type=bye)** — backup. Used when the data
   channel hadn't opened yet.
4. **Library/PC terminal close** — last resort. The owner tears down and
   redials while relay/control discovery still considers the pubkey active.

All four converge on `tearDownPeer` (idempotent — see `client.ts`). A real
`bye` removes the participant; connection-only failures close the local
`simple-peer` silently and preserve membership while kind 20078 still says the
remote user is present. This prevents reciprocal kind 25050 leave/redial loops.

## Capacity and full-mesh convergence

- **People:** `MAX_PARTICIPANTS = 4`, including self. Every client sorts the
  same known pubkey set and keeps the lexicographic leading four. An over-cap
  signal is answered with relay `bye { byeReason: 'room-full' }`; the rejected
  client surfaces the error and leaves instead of retrying indefinitely.
- **Full mesh:** `DiscoveryEngine` unions relay beacon publishers, beacon `p`
  and `peer` tags, active-call hints, and attributed control-channel claims.
  `VoiceClient.runDialLoop()` opens one `Peer` to every admitted pubkey. Thus,
  when A is connected to B and C, A's beacon/control snapshot teaches B about
  C and C about B; both run the same dial loop until all three pairwise links
  exist. Periodic full snapshots remove stale claims, while `peerAdded` gives
  a fast path for new links.
- **Recovery:** a terminal close removes the dead `Peer` and schedules the
  dial loop. If relay/control discovery still says that pubkey is active, a
  fresh `simple-peer` instance is created and local tracks are reattached.
- **Cameras:** `MAX_CAMERAS = 4`. Camera claims are `v=camera` beacon tags.
- **Screen:** `MAX_SCREEN_SHARES = 1`, independent of the camera count.
  Screen claims are `v=screen` tags.
- **Simultaneous media claims:** every client sorts each media kind by
  `(beaconCreatedAt, pubkey)` and keeps the leading slice. A losing local
  camera or screen track is stopped and the updated beacon is published.

## Membership + WoT

- The voice channel's NIP-29 admin/member list is the trust gate.
  Marked mesh test peers are a narrow diagnostic exception for local channel
  admins only; they do not change the gate for regular members.
  Signals from non-members are deferred for up to
  `DEFERRED_SIGNAL_TTL_MS = 5_000` ms; if `updateRoles()` admits the
  sender within that window the queue replays through `routeSignal`.
  After expiry, `signalsDropped.membershipFinal` increments.
- WoT is **bypassed** for kinds 20078 + 25050 — `wotEngine` lists
  them in `ALWAYS_ALLOW_KINDS`. Voice trust is the per-channel member
  list, not WoT distance. WoT applies to surfaces where the user has
  no other filter (chat, profiles); inside a small per-channel voice
  room the operator's member list is the right gate.
