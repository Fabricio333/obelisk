# NIP-17 DMs in Obelisk — adopt `@nostr-wot/dm`, and give it post-quantum

## The finding that shapes this

My first draft of this spec proposed building NIP-17 inside Obelisk's bridge: generalize `src/lib/nip-59.ts`, add kind-14 rumors, add a kind-1059 subscription, resolve kind-10050 inbox relays.

**All of that already exists in `@nostr-wot/dm`**, tested and published:

| Need | Already in `@nostr-wot/dm` |
|---|---|
| kind-14 rumor | `buildChatMessage` |
| seal + gift wrap | `sealAndGiftWrap` / `unwrapGiftWrap` |
| NIP-04 | `encryptNip04` / `decryptNip04` |
| inbox routing | `publishInboxRelays`, `fetchInboxRelays`, `relaysForPartner` |
| live subscription | `subscribeInbox` |
| sending | `sendDM` |
| storage | `cache/encrypted-storage.ts`, `eviction.ts`, `backfill.ts`, `read-cursors.ts` |
| React | `useDMSession`, `useThread`, `useConversations`, `useUnreadCount`, `useReadCursors` |

This also explains commit `5cbcec0`, which deleted Obelisk's local `src/lib/dm/` modules on 2026-05-10 because "their runtime callers all moved away during the **SDK migration**". The DM logic moved into the SDK. Obelisk deleted its copies but **never wired up the replacement**, so the bridge kept sending kind-4 and the migration was left half-finished. `docs/direct-messages.md` was never updated and still describes the deleted local subsystem, which is what caused the post-quantum spec to be written against a system that was not there.

So this work is not "build NIP-17". It is **finish the SDK migration**.

## The second finding: the SDK duplicates itself

`@nostr-wot/pq` implements gift wrap a second time. `packages/pq/src/dm.ts` declares its own `KIND_GIFT_WRAP = 1059`, builds its own seal with `finalizeEvent`, and wraps with its own `nip44.encrypt`. It does **not** depend on `@nostr-wot/dm`.

Two implementations of NIP-17 in one monorepo, and a consumer who wants post-quantum DMs must import both packages and compose them by hand — while `@nostr-wot/dm`'s hooks and cache, the things an app actually consumes, know nothing about post-quantum at all.

The layering that makes sense:

```
@nostr-wot/pq     post-quantum primitives: derivation, attestation,
                  encryptPq / decryptPq / isPqEnvelope.
                  Pure. No transport, no gift wrap.

@nostr-wot/dm     DM transport: NIP-04, NIP-17 (kind 14 → seal → 1059),
                  inbox routing, cache, hooks.
                  Owns the wire format, including its post-quantum variant.

Obelisk           consumes @nostr-wot/dm. Gets NIP-17 and post-quantum
                  without knowing how either works.
```

An application should not have to know whether a message is post-quantum in order to send or read it. That belongs to the transport.

## Goals

1. `@nostr-wot/dm` gains optional post-quantum sealing, depending on `@nostr-wot/pq` for the envelope rather than reimplementing it.
2. `unwrapGiftWrap` transparently opens post-quantum envelopes — the payload is self-describing, so a receiver needs no flag.
3. Obelisk adopts `@nostr-wot/dm` for DMs, replacing the bridge's kind-4-only path.
4. `docs/direct-messages.md` is corrected to describe what actually exists.
5. The two parked post-quantum tasks are unblocked as a consequence, not as separate work.

## Non-goals

- **Removing `@nostr-wot/pq`'s `createPqDirectMessage` / `openPqDirectMessage`.** They are published public API at 0.2.1 and the extension may use them. They get deprecated in favour of `@nostr-wot/dm`'s path, not deleted.
- **Changing the post-quantum wire format.** The envelope stays at the seal layer, where it saves ~2KB per message versus nesting in the rumor. That decision is documented in `pq/src/dm.ts` and is correct.
- **Migrating existing NIP-04 history.** Old threads stay NIP-04.
- **Rewriting Obelisk's DM UI.** The existing components keep rendering; only their data source changes.

## Design

### Part A — post-quantum in `@nostr-wot/dm`

`sealAndGiftWrap` gains an optional post-quantum mode. When enabled, the seal's `content` is the post-quantum envelope from `@nostr-wot/pq` instead of NIP-44 ciphertext; everything outside the seal is unchanged, so relays and non-supporting clients see an ordinary kind-1059.

`unwrapGiftWrap` calls `isPqEnvelope()` on the seal content and routes accordingly. No flag from the caller — the payload describes itself. This is the property that lets a mixed conversation work.

`sendDM` grows a `pq` option carrying the recipient's ML-KEM key, and `SendDMOptions` documents that the caller supplies the key from the recipient's `kind:10203` attestation. The transport does not fetch attestations; that stays with the application, which already has to decide whether the peer supports post-quantum.

`packages/dm` takes a dependency on `packages/pq`. That direction is correct: transport depends on primitives, never the reverse.

### Part B — deprecate the duplicate

`@nostr-wot/pq`'s `createPqDirectMessage` / `openPqDirectMessage` keep working, gain a deprecation notice pointing at `@nostr-wot/dm`, and their tests stay. The cross-implementation vector test that pins the wire format against the Rust NDK port must keep passing — it is the guarantee that both paths produce identical bytes.

### Part C — Obelisk adopts the SDK

The bridge stops implementing DMs and starts consuming `@nostr-wot/dm`. Concretely:

- A `NostrSigner` is derived from the bridge's existing signer dispatch, so all three login methods keep working. `@nostr-wot/signers@1.1.0` is already a dependency after the un-vendoring.
- `useDMSession` replaces the bridge's `subscribeDirectMessages`, with `discoverInboxRelays` on.
- `sendDirectMessage` delegates to the SDK's `sendDM`, keeping Obelisk's optimistic-send UI.
- `JsDirectMessage` gains `protocol` and `pq` so the existing UI can render provenance; the parked post-quantum per-message marks then have real data.
- We publish our own **kind-10050** inbox list. Without it no NIP-17 client can reach us, however many wraps we send.

### The integration risk, stated plainly

The bridge owns identity, relay connections and subscriptions, and it is 6,848 lines. `@nostr-wot/dm` wants to own a DM session with its own storage and subscription. These are two systems with overlapping responsibilities, and the previous attempt at this migration is exactly what left the orphaned modules behind.

Mitigation: adopt the SDK **behind the existing bridge interface** rather than exposing SDK types to the UI. The bridge keeps `sendDirectMessage` / `useDirectMessages`; internally they call the SDK. If the integration proves wrong, the blast radius is the bridge's DM methods, not every component.

## Security

### Finding: `@nostr-wot/dm` does not verify the seal. This must be fixed here.

`unwrapGiftWrap` (`packages/dm/src/index.ts`) decrypts the wrap, checks only `seal.kind === 13`, decrypts the seal, and returns `{ message, senderPubkey: seal.pubkey }`. It never calls `verifyEvent(seal)` and never checks that the rumor's own `pubkey` matches the seal's signer. There is no `verifyEvent`, `validateEvent` or `.sig` reference anywhere in the package.

**This is not currently exploitable**, and it is worth being precise about why: the seal is decrypted with `nip44Decrypt(seal.pubkey, seal.content)`, so the NIP-44 conversation key binds the ciphertext to the claimed sender. An attacker cannot produce content that decrypts under `conv(recipient, alice)` without Alice's private key. The ingest path (`cache/inbox.ts:148`) also correctly trusts `senderPubkey` rather than `message.pubkey`.

Two hazards remain:

1. **The returned `message.pubkey` is attacker-controlled and unvalidated.** A sender can set the rumor's author field to any pubkey while the seal is honestly their own. Any consumer that reads `message.pubkey` — the natural author field on a Nostr event — gets a forged identity. `cache/inbox.ts` avoids it; a future consumer easily would not.

2. **The seal's signature is decorative.** Authentication currently rests entirely on the conversation-key binding, not on the signature. That is fragile: any change to how the seal's content is encrypted silently removes the only authentication in the scheme.

Hazard 2 is why this must be fixed *before* post-quantum sealing lands here. `@nostr-wot/pq`'s `openPqDirectMessage` verifies both the seal signature and rumor authorship, and documents the authorship check as "the one worth having". Adding post-quantum sealing to `@nostr-wot/dm` without bringing those checks across would leave the weaker of the two implementations as the one every application consumes through the hooks.

**Fix:** `unwrapGiftWrap` verifies the seal's signature and rejects any rumor whose `pubkey` differs from the seal's signer, matching `@nostr-wot/pq` exactly. Both failures raise the same generic error, so neither becomes an oracle.
- Fresh ephemeral key per wrap. Reuse links messages and defeats the metadata protection.
- Timestamp fuzzing on seal and wrap.
- One generic failure on decrypt. Distinguishing causes is an oracle.
- Post-quantum party pubkeys are validated as 64 lowercase hex — the fix already shipped in `@nostr-wot/pq@0.2.1`.

## Testing

- Round trip through `@nostr-wot/dm` in both modes, classic and post-quantum, between two keypairs.
- A post-quantum message sent by `@nostr-wot/dm` opens with `@nostr-wot/pq`'s `openPqDirectMessage` and vice versa — the two paths must be byte-compatible or the deprecation is a break.
- The existing cross-implementation vector against the Rust NDK port still passes.
- Forged rumor authorship rejected.
- Obelisk: all three login methods send and receive; NIP-04 threads still work.

## Documentation

`docs/direct-messages.md` is rewritten to describe the SDK-backed implementation, with the module list corrected. The stale version cost a full spec-and-plan cycle on the post-quantum work; leaving it is not an option.
