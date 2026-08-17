# Direct Messages

Private 1:1 chat between Nostr identities. Like everything else in Obelisk, DMs are entirely client-driven over relays: there is no server in the data path.

> **This document was rewritten on 2026-08-17.** The version before it described a local `src/lib/dm/` subsystem that commit `5cbcec0` deleted on 2026-05-10, listing modules (`dm.ts`, `dm-cache.ts`, `cache-key.ts`, `coalescer.ts`, `pool.ts`, `src/components/dm/*`, `feature-flags.ts`) that no longer exist. That staleness cost a full spec-and-plan cycle on the post-quantum work, which was written against a system that was not there. If you change how DMs work, change this file in the same commit.

## Where the code actually is

DMs live **in the bridge**, delegating the wire format to `@nostr-wot/dm`. There is no separate DM subsystem.

| Path | Responsibility |
|---|---|
| `src/lib/nostr-bridge/client.ts` | Everything: subscriptions, ingest, send, relay routing, the signer adapter. Search `sendDirectMessage`, `publishDirectMessage`, `ingestIncomingDM`, `ingestIncomingGiftWrap`, `ingestDM`, `getDmSigner`, `subscribeIncomingDMs`, `ensureDmInboxRelaysPublished`, `fetchPartnerInboxRelays`, `resolveDmProtocol`. |
| `src/lib/nostr-bridge/types.ts` | `JsDirectMessage` — the only DM shape the UI ever sees. |
| `src/lib/nostr-bridge/stores.ts` | `useDirectMessages()` over the bridge's `dmsByPeer` store. |
| `src/lib/dm/opt-in.ts` | The `directMessagesEnabled` preference gate. The only surviving file under `src/lib/dm/`. |
| `src/store/dm.ts` | Zustand UI state: `activeDMPubkey`, `isDMMode`, and the persisted per-peer `protocolOverrides`. |
| `src/lib/pq/` | Post-quantum: attestation lookup, own-capability detection, status computation, send-plan resolution. |
| `src/app/app/DMList.tsx`, `DMComposer.tsx`, `DMOptInGate.tsx` | Shared DM UI. |
| `src/app/app/DesktopShell.tsx` (`DMPanel`) | Desktop thread view. |
| `src/app/app/mobile/PhoneShell.tsx` (`DmThreadScreen`) | Mobile thread view. |
| `src/components/chat/PqConversationNotice.tsx`, `PqMessageMark.tsx` | Post-quantum indicators. |

`@nostr-wot/dm` types never leave `src/lib/nostr-bridge/`. That boundary is deliberate: if the SDK integration turns out wrong, the blast radius is the bridge's DM methods rather than every component.

## Protocols

- **NIP-17 gift wrap is the default.** A kind-14 rumor is sealed (kind 13, signed by you, NIP-44 encrypted to the recipient) and then wrapped (kind 1059, signed by a fresh ephemeral key per message, timestamps fuzzed up to two days into the past). Relays see an ephemeral author and a recipient tag, and nothing else.
- **NIP-04 (kind 4) is a per-thread opt-out**, not a fallback that happens on its own. `resolveDmProtocol` returns `'nip04'` only when the user set `useDMStore.protocolOverrides[peer]` to it. The override persists per account.
- **Post-quantum is an optional third layer inside NIP-17**, described below. It is never a separate protocol and never changes anything outside the seal.

Both inbound paths are live: kind-4 events and kind-1059 wraps ingest into the same `dmsByPeer` store, and each message records which one carried it.

## Opt-in

DMs are off by default (`directMessagesEnabled`, `src/lib/preferences.ts`). While off, the bridge opens no DM subscriptions and publishes no kind-10050. `DMOptInGate` renders the enable prompt; `setDmOptInEnabled(false)` calls `bridge.disableDirectMessages()` to tear the subscriptions down.

## Subscriptions

DMs are the **one** thing in Obelisk that runs cross-relay. Everything group-related binds to the active relay (see AGENTS.md's single-relay rule).

`subscribeIncomingDMs` opens three filters on the active relay:

| Filter | Handler |
|---|---|
| `{ kinds: [4], '#p': [me] }` | `ingestIncomingDM` |
| `{ kinds: [4], authors: [me] }` | `ingestIncomingDM` (our own sends, echoed) |
| `{ kinds: [1059], '#p': [me] }` | `ingestIncomingGiftWrap` |

Then `fetchMyDmRelays()` resolves our own kind-10050 (NIP-17 inbox) and kind-10002 (NIP-65 read/write) sets and duplicates all three filters onto any relay not already covered. Without this, DMs sent by clients that respect our published inbox would never arrive.

There is no "gift wraps authored by me" filter, and there cannot be: the wrap is signed by a fresh ephemeral key, not by us. That is why every NIP-17 send publishes a **second wrap addressed to ourselves** (below). The `{ kinds: [1059], '#p': [me] }` filter picks it up like any other inbound wrap, which is how the sender's own outgoing history survives a reload and reaches their other devices.

## Sending

`sendDirectMessage` inserts an optimistic placeholder and hands off to `publishDirectMessage`, which never blocks on anything optional.

**NIP-04 path:** encrypt, publish to `this.relays` plus the recipient's NIP-65 read relays.

**NIP-17 path:**

1. `buildChatMessage(me, peer, content)` builds the kind-14 rumor, with its `created_at` pinned to the timestamp the optimistic placeholder already committed to.
2. `resolvePqSend` decides whether the seal can be post-quantum (below).
3. `sealAndGiftWrap` produces the kind-1059, post-quantum or classic.
4. `resolveGiftWrapRelays` decides where the wrap goes — see [Inbox routing](#inbox-routing-kind-10050).
5. Publish, then replace the placeholder.
6. `publishSelfGiftWrapCopy` seals the **same rumor** a second time, addressed to us, and publishes it to our own inbox only.

The placeholder is replaced with the **rumor's id**, not the wrap's. A gift wrap's id belongs to its ephemeral envelope and differs between the two copies, so keying the thread on it would let our own self-copy render as a second message. The rumor id is identical in both wraps and on every device, which is what `ingestDM` dedupes on. Timestamps use **our own pre-fuzz `created_at`**, not the wrap's: NIP-17 fuzzes the wrap timestamp backwards for privacy, so using it would make a message you just sent appear days old.

Failures mark the placeholder failed and surface a retry button; `retryDirectMessage` replays the same arguments, including the resolved protocol.

### The self-copy

NIP-17 delivers a sender-addressed copy alongside the recipient's. Three rules govern it:

- **Same rumor object.** Rebuilding it would produce a different timestamp and a different id, and the copy would come back off the relay as a second message.
- **Its own fresh ephemeral key.** `sealAndGiftWrap` generates one per call. Reusing one would let any relay link the two copies and undo the metadata protection NIP-17 exists to provide.
- **It never fails the send.** The recipient's copy is the message; losing ours degrades history only. Every failure is swallowed and logged through the relay-debug channel, and the publish is `quiet` so the user does not see a second "Publishing" entry for one message.

When the delivered copy went out post-quantum, the self-copy is sealed post-quantum too, encapsulated to **our own** ML-KEM key (`PqSendPlan.selfKemKey`), not the recipient's. Using the recipient's would need their ML-KEM secret to open, so we would have published a copy of our own message that we could never read again. When the delivered copy was classic, the self-copy stays classic: sealing ours post-quantum would make the message read as protected after a reload when it never was.

NIP-04 threads publish no self-copy and need none. Those events are authored by us, so the `{ kinds: [4], authors: [me] }` filter already finds them.

## Inbox routing (kind 10050)

### Where a wrap goes

Relay selection is a privacy control, not a delivery convenience. A kind-1059 is signed by a throwaway key so a relay learns only "some ephemeral key dropped a wrap for someone". Publishing that wrap to the relay the user is browsing destroys the guarantee: that socket is NIP-42-authenticated as the real sender, so the relay gets the true identity, the true send time, and — if the recipient reads there too — the sender-to-recipient edge.

`resolveGiftWrapRelays` therefore walks a strictly ordered ladder and uses each rung **alone**, never unioned:

| Rung | Target | Why |
|---|---|---|
| 1 | Recipient's kind-10050 inbox | The answer NIP-17 defines. Nothing of ours is added. |
| 2 | Recipient's NIP-65 read relays | Still relays *they* chose, so the wrap stays on the recipient's infrastructure. |
| 3 | Our active relay | Last resort, and the only rung with a real cost: this relay sees an authenticated publish from us. Taken anyway, because the spec forbids letting a missing inbox list block a send. |

The self-copy goes to **our own inbox only** — the relays `subscribeIncomingDMs` already holds authenticated REQs on (`this.relays` ∪ `myDmRelays`). It never rides along to the recipient's relays, and any relay that just took the recipient's copy is subtracted from its target set so no single relay can pair the two same-sized wraps. If that subtraction would empty the set (both parties on one relay), durability wins and it is logged as `dm-self-copy-shares-relay`.

Gift-wrap publishes use `authMode: 'last-resort'`: no NIP-42 identity is volunteered up front, since AUTH would staple our real pubkey to an envelope built not to carry it. Only if *every* target refused, and at least one refusal was auth-shaped, do we re-publish authenticated rather than drop the message.

### Publishing our own list

On login, `ensureDmInboxRelaysPublished` publishes our own kind-10050 advertising `this.relays`, unless a current one already exists. It republishes when the advertised set no longer matches or the existing event is older than seven days. Gated on the DM opt-in, and best-effort: a failure degrades reachability without breaking anything.

It targets the **NIP-65 read+write union** (AGENTS.md's relay scope for DM traffic) plus the active relay plus whatever the previous list named, so a replacement actually supersedes the copy senders will read. The union is derived from the same REQ that checks for an existing list (`kinds: [10002, 10050]`), so there is no extra round-trip. When the user has no NIP-65 list at all the union collapses to the active relay and nobody could find the list, so the profile relays are added back.

The publish uses `authMode: 'never'`. A kind-10050 is public by design and self-signed; no relay needs to know who opened the socket in order to store it, and authenticating the user to relays they never selected is not a price worth paying for discoverability. The active relay is already authenticated from ordinary browsing, so the list always lands somewhere.

Without a published kind-10050, no NIP-17 client can reach you, however many wraps other people send.

## Post-quantum

Full design: [`docs/superpowers/specs/2026-08-15-post-quantum-dms-design.md`](superpowers/specs/2026-08-15-post-quantum-dms-design.md).

The post-quantum envelope replaces the **seal's** ciphertext. Everything outside the seal is unchanged, so a relay or a client that has not implemented it still sees an ordinary kind-1059. `@nostr-wot/pq` owns the envelope; `@nostr-wot/dm` passes an opts bag through to the signer; the signer owns the key material. Obelisk holds no post-quantum secrets and cannot derive any: its logins are `nsec | nip07 | bunker` and it never sees a BIP-39 seed.

**Sending.** `resolvePqSend` (`src/lib/pq/send.ts`) returns the peer's ML-KEM key plus our own (for the self-copy), or `null` meaning "send classic". All three of these must hold:

1. The `postQuantumEnabled` preference is on.
2. `selfPqState().canSend` — the extension advertises `window.nostr.nip44.schemes` including `'pq'`.
3. The peer publishes a usable `kind:10203` attestation carrying a KEM key.

Condition 2 requires the **explicit marker**, not merely a NIP-07 session with published keys (`capabilityUnknown`). Post-quantum is an optional third argument to `nip44.encrypt`; an unaware extension silently ignores it and returns classic ciphertext, which we would then record as protected. A false claim of protection is worse than an honest classic send, so unknown means classic. No shipping extension advertises the marker yet, so in practice post-quantum sending is reachable only against a signer that opts in.

`resolvePqSend` never throws, and a signer that refuses post-quantum after advertising it falls back to a classic seal. **A message that cannot be protected still sends.** That rule is in the spec and is non-negotiable.

Condition 2 is checked **locally first**, before any relay round trip, because it is free (`loginMethod === 'nip07'` plus the `window.nostr.nip44.schemes` marker) and settles the answer for every session that cannot send post-quantum anyway. Without that short circuit, every DM send on every session would pay two attestation lookups to learn nothing, which matters now that the preference defaults on.

**Receiving** needs no configuration: the envelope is self-describing, so `signer.nip44Decrypt` routes on its own.

**Provenance.** Every message carries `protocol: 'nip04' | 'nip17'` and `pq?: boolean`. Inbound `pq` comes from `isPqEnvelope()` on the seal's ciphertext, recorded by the signer adapter's `pqTrack` because `unwrapGiftWrap` does not report its own routing decision. Outbound `pq` reflects what the seal actually did, never what was requested. `undefined` reads as classic everywhere, which is what any message stored before the field existed should mean.

**Indicators.** `PqConversationNotice` sits under the thread header on both shells; `PqMessageMark` renders per message, aggregated by `threadMarks` so only protection-level *transitions* are marked. Marking every message would put a pill on every bubble of a Discord-style list, because all pre-NIP-17 history is NIP-04. Both surfaces are gated on the `postQuantumEnabled` preference, which **defaults on**: the indicators are the feature, and defaulting off meant nobody who never opened settings saw the notice, the marks or the guide link at all. Unlike `directMessagesEnabled` the preference grants nothing and reveals nothing, it only decides whether Obelisk tells you what a conversation rests on. Sending stays conservative independently (condition 2 above), so the default cannot produce a false claim of protection.

## Security

`unwrapGiftWrap` verifies the seal's signature and rejects a rumor whose `pubkey` differs from the seal's signer. Both failures raise the same generic error so neither becomes an oracle. Authentication does not rest on the NIP-44 conversation-key binding alone.

The bridge treats `senderPubkey` (recovered from the seal) as the author and never trusts the rumor's own `pubkey` field.

An outgoing wrap that arrives from another device carries the real recipient in the rumor's `p` tag; an inbound one is from the sender directly. `ingestIncomingGiftWrap` distinguishes them the same way `@nostr-wot/dm`'s own `handleGiftWrap` does.

## Storage

**No DM plaintext is written to disk, and no DM events are cached.** kind 4 and kind 1059 are deliberately excluded from `bridgeCache` (see [docs/data-system.md §9](data-system.md)). `dmsByPeer` is in-memory and rebuilds from relays on every load.

The only persisted DM state is `obelisk-dm-store:{myPubkey}`, holding the per-peer protocol overrides. Its `merge` explicitly discards `threads` / `messages` so a legacy PWA install that still has them on disk never merges them back into memory. Read cursors live in `obelisk-read-state:{myPubkey}` (see [docs/read-state.md](read-state.md)).

`dmsByPeer` deliberately survives a relay switch: DMs follow the user, not the relay. It is cleared on logout and account switch.

## Notifications

Incoming DMs push a card onto the DM notification stream (`useNotificationsStore.pushDmNotification`) unless the user is actively watching that thread (`isUserWatchingDM`). Relay-agnostic on purpose, because DMs are the cross-relay stream. Group mentions are a separate stream with a separate cursor.

## Operational notes

- **Self-hosted instances** need no configuration. There is no DM-related env var, migration, or admin setting.
- **Bunker users** get one signer round trip per send (the seal encrypt plus the seal signature) and one per inbound wrap. Bunker sessions cannot send post-quantum: NIP-46's `nip44_encrypt` request has no field for `recipientKemKey`, and `Nip46Signer` throws rather than silently downgrading.
- **nsec sessions** cannot send post-quantum either. Obelisk never sees a BIP-39 seed, so there is nothing to derive ML-KEM keys from, and `@nostr-wot/pq` rejects a 32-byte secp256k1 key as seed input because that derivation would be circular.

## Troubleshooting

- **"Sent a message but they never got it."** Check whether the recipient has published a kind-10050. Without one the wrap falls to their NIP-65 read set, and without that to our own active relay — neither of which is guaranteed to overlap with what they actually read. They can fix it once, for everyone, with any modern client.
- **"My own DMs are missing after a reload."** Nothing is cached, so the whole thread rebuilds from relays on every load and takes a moment. If an outgoing NIP-17 message never comes back, its self-copy did not land: check whether we have a published kind-10050 (`ensureDmInboxRelaysPublished`) and whether the relay accepted the second wrap. Messages sent before the self-copy shipped are gone from the sender's side for good; the recipient still has them.
- **"The post-quantum toggle is on but nothing is post-quantum."** Almost certainly `capabilityUnknown`: the extension does not advertise `nip44.schemes`. The settings status row says so explicitly.
- **"Every old message shows a mark."** It should not: marks aggregate to transitions. If you see one per bubble, `threadMarks` is not being used.

## Spec and plans

- NIP-17 adoption: [`docs/superpowers/specs/2026-08-16-nip17-dms-design.md`](superpowers/specs/2026-08-16-nip17-dms-design.md)
- Post-quantum: [`docs/superpowers/specs/2026-08-15-post-quantum-dms-design.md`](superpowers/specs/2026-08-15-post-quantum-dms-design.md)
- Original (superseded) DM design: [`docs/superpowers/specs/2026-04-26-direct-messages-design.md`](superpowers/specs/2026-04-26-direct-messages-design.md)

## Tests

- `src/lib/nostr-bridge/dm-nip17.test.ts` — NIP-17 default, inbox routing, forged-authorship rejection, all three login methods.
- `src/lib/nostr-bridge/dm-pq-send.test.ts` — post-quantum send and receive, every negative case, the classic fallback.
- `src/lib/nostr-bridge/optimistic-send.test.ts` — placeholder lifecycle.
- `src/lib/pq/*.test.ts` — attestations, capability, status lattice, send-plan resolution.
- `src/app/app/DMPanel.pq.test.tsx` — indicator mounting, mark aggregation, on-accent contrast.
