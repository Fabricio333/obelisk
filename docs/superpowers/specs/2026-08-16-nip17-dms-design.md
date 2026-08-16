# NIP-17 gift-wrapped DMs — design

## Problem

Obelisk's DMs are NIP-04 kind 4. The ciphertext is encrypted, but the event itself is public metadata: any relay, and anyone reading it, sees that pubkey A messaged pubkey B, when, and how often. NIP-04 also uses an unauthenticated encryption scheme that the Nostr ecosystem has moved away from.

NIP-17 fixes both. The message becomes an unsigned kind-14 *rumor*, sealed inside a kind-13 event encrypted to the recipient, then gift-wrapped in a kind-1059 signed by a throwaway key. A relay sees only "some ephemeral pubkey published a wrap addressed to B". Sender, timing and frequency all disappear.

It is also the prerequisite for post-quantum DMs: the `@nostr-wot/pq` envelope rides inside NIP-44 within NIP-59 gift wrap. Tasks 5 and 6 of the post-quantum plan are parked on exactly this.

## History, and why this is not a revert

A NIP-04/NIP-17 DM subsystem was built in April 2026 (`src/lib/dm/dm.ts` and friends, with its own 2,589-line plan) and deleted on 2026-05-10 in `5cbcec0`:

> "their runtime callers all moved away during the SDK migration. Only their own tests + reset.ts and a single AppGate import referenced them."

The deletion was correct — the code was genuinely orphaned. But `docs/direct-messages.md` was left describing the deleted system as if it shipped, which is why it reads as though Obelisk already does NIP-17. **That doc must be corrected as part of this work.**

We do not resurrect those modules. They were written against a pre-SDK-migration architecture whose callers no longer exist, and the bridge has since grown its own subscription, optimistic-send and cache machinery. We do harvest their routing logic, which is careful and correct — particularly the kind-10050 inbox reasoning.

## Goals

- Send DMs as NIP-17 gift wraps, routed to the recipient's published inbox relays.
- Receive and ingest kind-1059 wraps addressed to us, surfacing them as ordinary messages.
- Let a conversation use NIP-04 when the peer's client needs it, chosen per thread.
- Publish our own kind-10050 inbox list, so other clients can reach us.
- Unblock post-quantum sending.

## Non-goals

- **The encrypted-at-rest DM cache** (KEK, non-extractable AES key, follow-aware LRU) that `docs/direct-messages.md` describes. That belongs to the deleted subsystem; the bridge has its own cache contract, and mixing the two is how the last one got orphaned.
- **The 50ms REQ coalescer and SWR profile/relay-list caches.** Same reason.
- **Migrating existing NIP-04 history.** Old threads stay NIP-04 and render as they do today.
- **Post-quantum sending.** This unblocks it; it does not implement it.

## Constraints from the existing architecture

- The bridge (`src/lib/nostr-bridge/client.ts`, 6,848 lines) owns identity, subscriptions and publishing. DMs live there, not in a separate module. This work extends it rather than adding a parallel subsystem.
- `src/lib/nip-59.ts` **already implements NIP-59 correctly** and is in production for read-state sync: seal at `KIND_SEAL`, wrap at `KIND_GIFT_WRAP` with a per-message ephemeral key, and `fuzzyCreatedAt()` for timestamp privacy. It is self-directed only — `nip44Encrypt(myPubkey, …)` and `['p', myPubkey]`.
- `JsDirectMessage` (`types.ts:119`) is the live model rendered via `useDirectMessages()`. It has no protocol field.
- `src/store/dm.ts` already declares `DMProtocol = 'nip04' | 'nip17'`, per-thread `protocolOverrides`, and a protocol-choice popup. That plumbing exists and is unused.
- CLAUDE.md's relay table puts DMs on the **NIP-65 read+write union**, unlike groups which are active-relay only.

## Architecture

### 1. Generalize the gift wrap

`nip-59.ts` gains a peer-directed sibling of `wrapForSelf`/`unwrapForSelf`. The existing self-directed functions stay exactly as they are — read-state sync depends on them and must not change behaviour.

```ts
export async function wrapForRecipient(
  template: RumorTemplate,
  recipientPubkey: string,
  signer: NipSigner,
): Promise<NostrEvent>

export async function unwrapFromSender(
  wrap: NostrEvent,
  signer: NipSigner,
): Promise<Rumor | null>
```

The difference from `wrapForSelf` is only in who the seal is encrypted to and whose pubkey is in the wrap's `p` tag. The ephemeral-key and timestamp-fuzzing logic is shared.

### 2. Message kind

NIP-17 chat messages are **kind 14** rumors. The rumor carries `['p', recipient]` and the plaintext in `content`. Add `KIND_CHAT_MESSAGE = 14` to `nip-kinds.ts` beside the existing seal and wrap constants.

### 3. Inbox routing

A NIP-17 wrap must go to the recipient's **kind-10050** inbox relays, not their kind-10002 read relays. The deleted implementation documented the failure mode precisely: if you do not query and publish to the preferred inbox, wraps never arrive no matter how many you send.

- On first contact, fetch the peer's kind-10050; cache it for the session.
- Fall back to their kind-10002 read relays, then to the configured pool, and record which fallback was used so the UI can be honest about best-effort delivery.
- **Publish our own kind-10050** — without it, no NIP-17-capable client can reach us. This is the step most easily forgotten and it makes the feature bidirectional.

### 4. Receive path

The DM subscription gains a second filter alongside the existing kind-4 pair:

```ts
{ kinds: [KIND_GIFT_WRAP], '#p': [me] }
```

On each wrap: unwrap to the seal, decrypt to the rumor, verify the rumor's author matches the seal's signer (a forged rumor claiming someone else's authorship must be rejected, not displayed), then ingest as a `JsDirectMessage`.

Note the privacy consequence, inherent to NIP-17 and not a defect: a wrap reveals nothing until decrypted, so a NIP-17 thread only appears in the DM list once at least one of its messages has been unwrapped on this device.

### 5. Protocol selection

`JsDirectMessage` gains `protocol?: DMProtocol`, defaulting to `'nip04'` for anything already stored. Sends default to NIP-17; the per-thread override in `store/dm.ts` selects NIP-04 for peers whose clients need it. That store plumbing already exists.

This field is also what the parked post-quantum per-message provenance work needs.

### 6. Send path

`sendDirectMessage` branches on the resolved protocol. The optimistic-send machinery (`upsertPendingDM` / `replacePendingDM`) is protocol-agnostic and is reused unchanged.

## Security

- **Rumor authorship must be verified against the seal.** Skipping this lets anyone gift-wrap a rumor claiming to be from someone else, and it renders as genuine. This is the single most important check in the feature.
- Signature verification on the wrap happens in `nostr-tools` before delivery, as it does for every other subscription.
- The ephemeral key must be fresh per message. Reuse links wraps together and undoes the metadata protection.
- `fuzzyCreatedAt()` must be used on both seal and wrap, as `wrapForSelf` already does.
- Decryption failures must be indistinguishable from one another to the caller. A distinct error per cause is an oracle.

## Testing

- `wrapForRecipient` → `unwrapFromSender` round trip between two keypairs.
- A rumor whose author does not match the seal's signer is rejected.
- A wrap addressed to someone else does not decrypt.
- Inbox resolution: kind-10050 present, absent with kind-10002 present, and neither.
- Send routes to the inbox relays; NIP-04 sends still route to read relays.
- The existing self-directed read-state path is unchanged — its tests must still pass untouched.

## Documentation

`docs/direct-messages.md` currently describes the deleted subsystem as shipped. Rewrite it to describe what this work actually builds, and remove the references to modules that no longer exist. Leaving it as-is is what caused a whole post-quantum spec to be written against a system that was not there.
