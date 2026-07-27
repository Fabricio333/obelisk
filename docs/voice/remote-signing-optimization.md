# Voice Beacon Remote-Signing Optimization

Status: proposal. No protocol or runtime changes have been implemented from
this note.

## Problem

Mesh voice currently signs a kind `20078` presence event:

- once when joining;
- seven more times during the first 18 seconds;
- every 10 seconds afterward;
- whenever connected peers, known peers, or outbound video tracks change;
- once more when leaving.

Every publish calls the active account signer. With NIP-46 this means a remote
RPC for every beacon, and the bring-up timers can overlap when the signer is
slow. Rate-limit retries currently repeat the whole sign-and-publish operation,
so a relay failure can also cause another signature request.

This is unnecessary once WebRTC control channels are open: they already carry
heartbeats, participant snapshots, and immediate leave messages. Relay beacons
are still needed for cold discovery, pre-join call indicators, and recovery
when no data channel exists.

## Goals

- At most one voice signature request in flight per client.
- No repeated signer prompts during normal call setup.
- Preserve fast discovery and relay-only recovery.
- Preserve the main Nostr identity as the admission boundary.
- Keep Phase 1 compatible with existing clients and relays.

## Phase 1 — reduce account-key signatures

### 1. Coalesce beacon updates

Keep one desired normalized beacon state:

```text
channel + connected pubkeys + known pubkeys + video tracks
```

If a beacon is already being signed, mark the state dirty instead of starting
another request. When the request completes, publish at most one follow-up
beacon if the normalized state changed. Skip opportunistic refreshes whose
state hash matches the last successfully signed beacon.

### 2. Replace the fixed bring-up burst

Publish one join beacon. Schedule one fallback after roughly three seconds only
when there is no relay self-echo, peer beacon, or successful peer connection.
Existing peers already refresh their beacon when they first discover a new
participant, so seven unconditional retries are redundant.

### 3. Slow the steady cadence

Initial target:

- steady beacon interval: 30 seconds;
- expiration: 90 seconds;
- state-change refresh: keep the existing short debounce, but coalesce it.

Connected peers continue to detect departure through the control-channel
`bye` and 20-second heartbeat timeout. The longer relay expiration only affects
viewers and participants that never established a data channel.

### 4. Sign once, retry publishing

Split beacon delivery into:

```text
event template -> account signature once -> publish signed event with retries
```

Rate-limit and connection retries must reuse the same signed event instead of
calling `sign_event` again. A retry should request a new signature only after
the event has expired or its advertised state changed.

### 5. Request scoped NIP-46 permissions

Client-created `nostrconnect://` sessions should request:

```text
sign_event:20078
sign_event:25050
```

A compatible signer may then approve those event kinds for the connection
instead of asking for every event. This improves prompts but does not remove
the NIP-46 network round trip, so coalescing and cadence reduction remain
necessary.

### 6. Avoid remote signing during unload

When a control data channel is open, its synchronous `bye` is the primary
leave signal. Do not depend on a remote-signed leave beacon during
`beforeunload`; browsers cannot reliably finish that RPC. Use relay expiration
as the fallback.

## Phase 2 — scoped local voice-session key

For the lowest latency, generate an in-memory keypair when joining and ask the
account signer for one short-lived authorization containing:

- account pubkey;
- session pubkey;
- channel id;
- allowed kinds `20078` and `25050`;
- an expiration no longer than the voice session.

The session key signs subsequent presence and signaling events locally.
Receivers accept them only after verifying both the account authorization and
the session-key signature. Delete the private session key on leave and never
persist it.

This is deliberately not NIP-26: delegated event signing is marked
unrecommended by the NIPs repository. It should be an Obelisk voice-session
credential with narrow scope and expiry.

### Relay constraint

A NIP-29 relay may authorize writes using the event author's pubkey. A locally
signed session event therefore may be rejected even when its account
authorization is valid. Phase 2 requires the Obelisk relay to validate the
voice-session credential, or otherwise admit the session pubkey for the
credential's channel and lifetime. Do not ship the client half alone.

## Acceptance criteria

- No more than two account-key beacon signatures during the first 20 seconds
  of a healthy mesh join.
- Maximum concurrent account signature requests from beacon publishing: one.
- An unchanged steady room produces no more than two beacon signatures per
  minute per participant.
- Retrying the same relay publish produces zero additional signatures.
- A new participant appears to existing peers within three seconds on a
  healthy relay.
- Connected peers still detect a clean leave immediately and a crashed peer
  within the control heartbeat timeout.
- Relay-only stale presence disappears within the advertised expiration.
- Tests cover a slow NIP-46 signer, coalesced state changes, publish retries,
  missing acknowledgements, and backwards-compatible kind `20078` parsing.

## Relevant code

- `src/lib/voice/client.ts` — cadence, bring-up timers, coalescing, control
  channel lifecycle.
- `src/lib/voice/transport.ts` — kind `20078` templates and publish boundary.
- `src/lib/voice/failure-handlers.ts` — relay retry behavior.
- `src/lib/nostr-bridge/client.ts` — account signing and NIP-46 session setup.

## Protocol references

- [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) — kinds
  `20000–29999` are ephemeral and are not expected to be stored.
- [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) — remote
  signing and scoped `sign_event:<kind>` permissions.
- [NIP-26](https://github.com/nostr-protocol/nips/blob/master/26.md) — delegated
  event signing, currently marked unrecommended.
