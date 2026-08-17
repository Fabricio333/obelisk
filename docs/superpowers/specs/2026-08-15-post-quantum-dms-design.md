# Post-quantum DMs — capability detection, per-message provenance, and an onboarding guide

## Problem

Every encrypted DM Obelisk sends today can be recorded now and read later. NIP-44 derives its conversation key from a secp256k1 ECDH secret, so the day secp256k1 falls, every gift wrap sitting on a public relay becomes plaintext. This is *harvest now, decrypt later*, and it is the only half of the quantum problem that can be fixed in advance: a message protected today stays confidential permanently, whenever the break arrives. Forgery cannot be pre-empted that way — it is fixed only once the ecosystem stops accepting secp256k1 signatures.

The nostr-wot extension already ships post-quantum keys and exposes them through NIP-07. Obelisk cannot see any of it: it does not know whether a user has post-quantum keys, whether their attestation is published, or whether a given conversation could be quantum-secured. Users have no way to tell a protected thread from an exposed one, and no path to getting protected.

## Goals

- Show whether the logged-in user has a post-quantum identity, and whether its `kind:10203` attestation is actually published.
- Show, per conversation, whether it is quantum-secured.
- Show, per message, what protection it actually had — because a long thread legitimately contains messages of different kinds, sent from different clients over years.
- Send post-quantum DMs when the signer supports it and the recipient advertises keys.
- Explain, in-app, the two ways to get a post-quantum identity.

## Non-goals

- **Obelisk never holds post-quantum secret key material.** Key custody stays in the extension. No import of key files into browser storage.
- **No key derivation in Obelisk.** `derivePqKeys()` needs the 64-byte BIP-39 seed. Obelisk's logins are `nsec | nip07 | bunker` and it never sees a seed — it deliberately cannot derive, and `@nostr-wot/pq` rejects a 32-byte secp256k1 private key as seed input because that derivation would be circular.
- **No blocking.** A conversation that cannot be quantum-secured still sends. The notice teaches; it does not gate.
- **No group-chat coverage.** NIP-29 group messages are relay-visible by design; this is DMs only.

## Constraints discovered

**Obelisk cannot derive post-quantum keys.** Only the extension can, so post-quantum *encryption* is reachable only through the NIP-07 surface:

```js
window.nostr.nip44.encrypt(pubkey, plaintext, { scheme: 'pq', recipientKemKey })
```

`nsec` and `bunker` logins get detection and indicators, never post-quantum sending. This is a property of where the seed lives, not a limitation we can engineer around.

**The extension publishes no capability marker.** Post-quantum support is an *optional third argument*; a supporting extension and an unaware one expose an identical shape. `Function.length` is not a contract, and probing by encrypting means encrypting something to ask a question. The extension made this choice deliberately — inferring would put relay I/O inside a signing call, and a failed lookup would force either breaking callers or silently downgrading — but it left callers no way to ask. Tracked as a separate upstream change; until it lands we use the fallback below.

## Architecture

A new `src/lib/pq/` module beside `dm/` and `wot/`. Obelisk holds no protocol knowledge: kinds, envelope format and attestation parsing all come from `@nostr-wot/pq`.

```
src/lib/pq/
├── attestations.ts   Fetch + cache kind:10203, stale-while-revalidate
├── capability.ts     Own post-quantum state: signer support, keys, published
├── status.ts         Pure status computation (no I/O)
└── index.ts
```

`@nostr-wot/pq` supplies `PQC_KIND`, `attestationFilter()`, `parseAttestation()`, `isPqEnvelope()`, and `PqAttestation` (whose `origin: 'derived' | 'independent'` maps onto the two onboarding paths).

### Capability detection

```
supportsPq =
  window.nostr.nip44.schemes?.includes('pq')     // once the extension ships it
  ?? (isNip07Available() && userHasPublishedAttestation)   // fallback
```

The fallback answers "this user has post-quantum keys" rather than "this signer can encrypt with them" — weaker, but observable and true, and it reuses the attestation query we need anyway. When `supportsPq()` lands in `@nostr-wot/signers`, `capability.ts` delegates and this logic is deleted.

### Two status levels

**Conversation** — `secured` only when all three hold: the `postQuantumEnabled` preference is on, the user advertises post-quantum keys, and the peer advertises post-quantum keys. This is capability-and-configuration state, and it is true before either party has spoken.

It deliberately does *not* claim every message was post-quantum. Obelisk can verify a peer published an attestation; it cannot verify their client uses it.

**Message** — computed from what the message actually was. Only deficient messages are marked, so a healthy thread stays quiet:

| State | Mark |
|---|---|
| `protocol: 'nip04'` | not gift-wrapped — metadata visible to relays |
| `protocol: 'nip17'`, no post-quantum envelope | not quantum-safe |
| `protocol: 'nip17'` + post-quantum envelope | none |

`DMMessage` already carries `protocol: 'nip04' \| 'nip17'`, so gift-wrap provenance is modelled per message today. Post-quantum is the orthogonal second axis — it always rides inside NIP-17 — so the store change is one field: `pq?: boolean`.

## Data flow

**Receive.** Decryption needs no change: the payload is self-describing and the extension routes it. Before decrypting, `isPqEnvelope()` on the inner ciphertext sets `DMMessage.pq`.

**Send.** `Preferences` gains `postQuantumEnabled` (following `directMessagesEnabled`). `nip44Encrypt` in `src/lib/nostr-bridge/client.ts:6346` widens to accept optional post-quantum options; **only the nip07 branch at :6357 honors them**, `nsec` and `bunker` ignore them. When the conversation cannot be secured, the message sends classic and the notice does the teaching.

This is the only change to the 6,848-line `client.ts`: one widened signature and one pass-through.

## Module breakdown

| Module | Responsibility | Depends on |
|---|---|---|
| `pq/attestations.ts` | Relay lookup + SWR cache of `kind:10203` | `@nostr-wot/pq`, bridge pool |
| `pq/capability.ts` | Is post-quantum available for *me* | `attestations`, `window.nostr` |
| `pq/status.ts` | Conversation + message status. **Pure** | types only |
| `store/dm.ts` | `DMMessage.pq?: boolean` | — |
| `lib/preferences.ts` | `postQuantumEnabled: boolean` | — |
| UI | Conversation notice, per-message mark, settings toggle | `pq/status` |
| `app/guides/{en,es}/` | The onboarding guide | — |

## The guide

Two paths, because they suit different people:

1. **A new account from a 24-word phrase.** Post-quantum keys are derived from the BIP-39 seed as *siblings* of the Nostr key, never children — so breaking secp256k1 does not reach them, and one phrase restores both. It must be 24 words: a 12-word phrase expands to a valid seed carrying only 128 bits of entropy, which would make the seed, not the lattice, the weakest link.
2. **An independent identity attached to an existing npub.** For anyone who already has an npub, or imported from an `nsec` and has no seed to derive from. The extension generates a standalone pair offline and publishes an attestation signed by the existing account. It needs its own separate backup, because it cannot be recovered from the phrase.

English and Spanish, matching the repo's two locales, linking out to nostr-wot for the extension and keygen tooling.

## Testing strategy

- `status.ts` is pure, so the whole status lattice is table-tested without a relay or browser: every combination of preference, own keys, peer keys, protocol and envelope.
- `capability.ts` against a mocked `window.nostr`, covering marker-present, marker-absent-with-attestation, and neither.
- `attestations.ts` against a mocked pool: cache hit, stale revalidate, malformed attestation rejected by `parseAttestation`.
- Bridge: `nip44Encrypt` passes post-quantum options on nip07 and ignores them on nsec/bunker.
- Note `vitest.config.ts` inlines `@nostr-wot/*`; any `vi.mock` of a module `@nostr-wot/pq` imports depends on that.

## Post-merge follow-ups

- Extension: publish a capability marker (`window.nostr.nip44.schemes`).
- `@nostr-wot/signers`: add `supportsPq()`; delete Obelisk's fallback once it ships.
- Revisit whether the conversation badge should also reflect observed post-quantum messages, not only advertised capability.
