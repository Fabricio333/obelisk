# Mesh — Failure Modes

Every previously-silent failure in the mesh has been wired into a
counter on `VoiceClient.metrics`. The `?debug=voice` overlay reads
the live values; the Playwright harness asserts on them. Counters
that should stay at zero on a healthy mesh are marked **(zero
expected)**.

## Membership / WoT

| Failure | Handler | Counter |
|---|---|---|
| Signal arrives before `updateRoles()` admits the sender | Defer up to 5 s; replay on admit | `signalsDropped.membershipDeferred` (transient — ok), `signalsDropped.membershipFinal` **(zero expected)** |
| Deferred queue overflows (8 per peer / 64 total) | Drop oldest | `signalsDropped.deferredOverflow` **(zero expected)** |
| WoT engine denies a kind 25050 from a non-member | `KIND_VOICE_PRESENCE` + `KIND_VOICE_SIGNAL` are in `ALWAYS_ALLOW_KINDS` so this path is unreachable in normal operation. Defense-in-depth check stays in client.ts:490 | `signalsDropped.wot` **(zero expected)** |
| Self-echo (relay broadcasts our own beacon back to us) | Drop at receiver | `signalsDropped.self` (non-zero baseline; not a failure) |
| Signal addressed to someone else | Drop at receiver | `signalsDropped.notForMe` (non-zero baseline; not a failure) |

## Relay

| Failure | Handler | Counter |
|---|---|---|
| Rate-limit response (`OK ... false "rate-limit:..."` or "slow down") | Exponential backoff: 1s, 2s, 4s, 8s with ±25% jitter, max 4 retries | `rateLimit.hit`, `rateLimit.backoffMs` |
| Publish fails for any non-rate-limit reason (signing error, network down, relay reject) | Re-thrown to caller; counter incremented | `relay.publishFail` **(zero expected)**, `relay.lastError` |
| NIP-42 AUTH not yet complete when first beacon publishes | Best-effort: wait up to 5 s for auth (fire-and-forget — beacon goes out anyway, bring-up burst covers retry) | `relay.authWaited`, `relay.authTimedOut` (occasional non-zero on slow relays — ok) |

## Peer

| Failure | Handler | Counter |
|---|---|---|
| Peer PC reaches a terminal close | `VoiceClient` silently rebuilds the peer (no `bye`), preserves kind 20078 presence, and redials from discovery | `peers.tornDown` |
| Peer crashed / network blackout (no traffic for 20 s) | Silent local teardown + discovery-driven redial; no reciprocal leave signal | `peers.tornDown` |
| Peer cleanly leaves | Control-channel `bye` (sub-100 ms) → `tearDownPeer` | `peers.tornDown`, `signals.byeViaControl` |
| Peer never opens (9 s timeout) | Silent local teardown + discovery-driven redial while the beacon remains live | `peers.tornDown` |
| Local tab close / refresh | `beforeunload` / `pagehide` → control-channel `bye` to all peers, then `pc.close()` | `peers.tornDownByUnload` (on the leaver), `signals.byeViaControl` (on the receivers) |
| Both browsers try to negotiate | Deterministic pubkey ordering makes exactly one `simple-peer` instance the initiator; the other sends library `renegotiate`/`transceiverRequest` signals | Covered by `peer.test.ts` and `client.test.ts` |

## Topology

| Failure | Handler | Counter |
|---|---|---|
| Capacity overflow (>4 mesh participants) | Lex-deterministic eviction plus active `bye { byeReason: 'room-full' }` rejection keeps every client on the same four-person set | Verified by `client.test.ts` and `scripts/e2e/voice/five-peer-rejection.spec.ts` |
| Camera overflow (>4) | Per-kind `(createdAt, pubkey)` winners; a losing local camera is stopped | Verified by `video-slot-cap.test.ts` |
| Screen-share overflow (>1) | Same deterministic winner rule, independent of camera slots | Verified by `video-slot-cap.test.ts` |
| SFU advertised on the channel but transport fails | `SfuClient.start` rejects → `enterMeshMode()` (mesh fallback) — except for `voice-sfu` channels which surface the error instead | `signalsDropped.sfuRouted` |

## What the `?debug=voice` overlay shows

Live, polling every 500 ms:

- top counters: connected peers, ever-connected, torn-down (split:
  unload vs other), ICE-exhausted
- control channel: opened count, ping/pong totals, last RTT
- discovery: relay-discovered count, control-discovered count
- signals: sent/received, bye via control vs relay
- dropped (highlighted red when non-zero on the "should be zero" set):
  wot, membFinal, overflow
- relay: beacons sent/received, publishFail, auth waits/timeouts,
  last error string
- rate-limit: total hits, cumulative backoff ms
- last 50 events from the ring buffer (kind, reason, peer, payload)

Open with `?debug=voice` on any voice URL. Production-safe — no PII
beyond pubkey prefixes.
