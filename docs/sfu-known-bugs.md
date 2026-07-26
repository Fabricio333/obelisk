# SFU known bugs (server-side)

Issues observed while debugging the dex client that almost certainly belong
to the **`obelisk-app/obelisk-sfu`** server repo, not the client. Listed here
so the next pass on the SFU project has a punch list.

The dex client was tightened in this same change to:

- Drop "fall back to mesh" when the SFU is unreachable. SFU-pinned channels
  now error clearly instead of silently degrading to a 6–8-peer mesh.
- Prune remote tracks on `peerLeft` and on every `participantList` snapshot,
  not just on `producerClosed`. This works around (1) below.

So a few of the symptoms below are now **client-masked but server-rooted** —
fix them server-side and the client workaround can come out.

---

## 1. `peerLeft` without `producerClosed` follow-ups

When a participant disconnects abruptly (tab close, network loss, OS sleep,
kicked) the SFU emits `peerLeft` over the kind 25050 RPC notification stream
but **does not** fire one `producerClosed` per producer the leaving peer
owned. The dex used to leave those tiles on screen as a black rectangle (the
last decoded frame, then empty after the WebRTC jitter buffer drains)
because the client only acted on `producerClosed`.

**Server fix:** when the SFU detects a peer is gone (transport timeout,
explicit `leave`, eviction), iterate that peer's producer set and fire one
`producerClosed` per producer **before** firing `peerLeft`. Notification
order matters — the client should be able to clean tracks on
`producerClosed` and only use `peerLeft` for roster updates.

**Client workaround in place:** `src/lib/voice/sfu-client.ts` now also drops
tracks on `peerLeft` and on every `participantList` snapshot.

## 2. Allow-list enforcement is implicit (relay write ACL only)

The SFU treats *any* kind 25050 `start` event seen on its trusted-author
relay(s) as authorized. The relay's write whitelist is the only enforcement.
This works on `lacrypta-relay.obelisk.ar` but is brittle:

- A misconfigured trusted relay (write-open) silently authorizes the world.
- Multiple operators sharing one SFU lose per-channel control.

**Server fix:** add a server-side allow-list keyed by pubkey hex that the
operator manages (config file or kind 31313 self-tag). Reject `start` events
from pubkeys not in the list, even on trusted relays.

## 3. Asymmetric relay subscription

`services/sfu` (and the obelisk-sfu repo) accepts a list of relays but
the subscription strategy treats them all as equally authoritative. In
practice a `start` event published to relay A may not reach the SFU
subscribed primarily to relay B, even though both are listed — depending on
which relay the SFU's `subscribeMany` selected first.

**Server fix:** ensure the SFU subscribes to **every** trusted relay it
advertises (kind 31313 `trusted_relay` tags). Fan-in over all of them.

## 4. RPC reply / notification routing on kind 25050

Some kind 25050 RPC notifications arrive on the dex through the generic
voice-signal subscription (because the relay doesn't index `#p` for ephemeral
kinds, so the dex subscribes by `#e` only and filters in-handler). The
filter in `client.ts` `routeSignal` correctly drops these, but they still
hit the wire — multiplied by every dex peer in the room.

**Server fix:** SFU should publish RPC envelopes (`type: 'response'` /
`type: 'notification'`) with a distinguishing tag (e.g. `["t","sfu-rpc"]`)
so dex clients that want to ignore them can filter at subscription time.

## 5. Recovery after SFU restart

When the SFU process restarts, it loses all in-memory peer state. The dex
clients keep their WebRTC transports open — but the SFU has no record of
them, so it silently drops their RTP. Today the dex's only signal is the
absence of the SFU's `["sfu","1"]` beacon; the supervisor in
`VoiceRoom.tsx` republishes `start` after a watchdog window, but the SFU
treats the new transport requests as fresh joins, leaving stale
producers/consumers in the dex's `remoteByProducerId` map.

**Server fix:** on startup, publish a kind 31313 advertisement with a
**fresh `since`** value (or include a session id tag). Clients comparing
the new id to their cached one can detect "the SFU restarted, drop all
state and rejoin" without waiting for the watchdog.

## 6. Stale peer state on abrupt close — server has no `leave` method

**Symptom (user-reported):** "The SFU is not detecting that people end the
call on their side and still thinks they are in the voice channel, so they
cannot enter new ones — neither on the same channel, other channel, or
other server."

The dex never sent an explicit `leave` to the SFU; teardown relied entirely
on the mediasoup transport's DTLS close-notify reaching the server. That
signal is unreliable when the tab closes abruptly, the network drops, or
the user rejoins faster than DTLS times out (often 30 s+). During that
window the SFU still has the peer's pubkey "in the room" and rejects new
joins as "already present", so the user gets stuck.

**Client mitigation in place:** `src/lib/voice/sfu-client.ts` `close()` now
fire-and-forgets a kind 25050 RPC `{ method: 'leave' }` to the server
before tearing down its own transports. `src/lib/voice/active-client.ts`
also wires `pagehide` / `beforeunload` so abrupt tab closures still
attempt the same RPC.

**Server fix:** the SFU **must** implement two things —

1. **A `leave` RPC method.** On receipt: drop the peer's transports +
   producers + consumers, fire `peerLeft` to remaining participants,
   reply with `{ ok: true }`. Idempotent — a `leave` for an already-gone
   peer just returns ok.

2. **An ICE/DTLS-timeout-driven sweep.** Even with the explicit RPC, some
   peers will vanish without any graceful close (network loss, OS kill,
   browser crash). When a transport's ICE state stays `disconnected` /
   `failed` for >15 s, drop the peer the same way `leave` does. Without
   this sweep, a single user who refreshes during a network blip stays
   "stuck in the room" until the operator restarts the SFU.

Until the server lands these, users who close the tab abruptly may
still see "you're already in this call" errors on their next join — the
client's best-effort RPC reduces but doesn't eliminate the window.

## 7. Inactive-but-still-connected peers are never reaped

Distinct from #6: even when ICE / DTLS report the transport as healthy,
the peer can be effectively gone — laptop closed but radio on, OS
suspended the tab, mobile background-throttled, "soft" network failure
where TCP keepalives hold but no real RTP arrives. The transport-state
sweep proposed in #6 wouldn't catch this because the transport never
flipped to `disconnected`/`failed`.

**Symptom:** the user's tile still appears in the SFU's roster long
after they actually walked away or their device froze. Other participants
keep their video tile up (now black after the jitter buffer drains), and
when the user comes back / restarts they're rejected as "already in the
room" because the SFU still believes they're present.

**Server fix:** add an **activity-based reaper** keyed on inbound RTP
flow:

1. For each peer, track `lastInboundPacketAt` across all of their producers
   (audio + video + screen). Update on every packet observed by the
   SFU's RTP layer.
2. Every N seconds, walk peers and drop any whose `lastInboundPacketAt`
   is older than `INACTIVITY_TIMEOUT` (suggested: 20–30 s — long enough
   to ride out a normal mute + brief network jitter, short enough that
   a frozen tab clears within a song's length).
3. Treat a "no producers at all + no RPC traffic" peer the same way after
   the same window — a peer joined but never published is also stale.
4. On reap: same teardown path as `leave` (close transports / producers /
   consumers, fire `peerLeft`, free the slot).

This is the only signal that survives soft failures. ICE keepalives, RTP
flow, and DTLS state can all disagree: ICE/DTLS see "healthy", RTP shows
silence. RTP is the ground truth for "is this peer actually doing
anything in the call."

**Why the client can't fix this:** the dex has no visibility into what
the SFU forwards from peer A to peer B. It only sees its own outbound
and inbound. Detecting "everyone else is silent" client-side would
falsely reap a quiet meeting; the SFU is the only place that has the
full picture.

## 8. No `screen-audio` slot in `appData`

The dex publishes screen-audio tracks with `appData: { kind: 'screen-audio' }`.
The SFU passes `appData` through unchanged on consumers, which is good —
but if a future SFU release strips unknown app-data fields for safety, the
client's tile mapping breaks (audio attaches to the wrong participant).

**Server fix:** explicitly whitelist the dex's voice kinds (`audio`,
`camera`, `screen`, `screen-audio`) in any appData sanitization layer.

---

## Cross-cutting: voice signaling does not survive a bridge relay switch

Not strictly server-side, but worth tracking here because the SFU is the
side that benefits from the fix: voice transport (`src/lib/voice/transport.ts`)
goes through the bridge's `SimplePool`. When the user switches relays in
the dex (sidebar relay rail), the bridge tears down its pool and re-creates
on the new relay — so voice's `subscribeRoster` / `subscribeSignals` /
SFU RPC are all severed. Audio + video keep flowing over WebRTC because
the peer connections are direct, but SDP renegotiation and new joiners
silently fail until the user navigates back to the call's origin relay
(at which point the watchdog re-subscribes).

Long-term fix is on the dex side: give voice a dedicated pool that captures
relays at join time and survives bridge switches. Tracked here so SFU
operators understand why a "call works on home relay, breaks on switch"
report shouldn't be assumed to be an SFU bug.
