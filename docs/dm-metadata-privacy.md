# DM metadata privacy

Why gift-wrapped DMs can still leak who is talking to whom, what Obelisk does
about it, and what it cannot fix alone.

Read this before changing anything about **where** a DM is published. The
encryption is not the fragile part. The routing is.

## What NIP-17 buys you

A NIP-17 message has three layers:

| Layer | Kind | Signed by | Visible to a relay |
|---|---|---|---|
| Rumor | 14 | nobody (unsigned) | no — encrypted inside the seal |
| Seal | 13 | the real sender | no — encrypted inside the wrap |
| Gift wrap | 1059 | a throwaway key, fresh per message | yes |

So a relay holding a wrap sees only: *some pubkey it has never seen published
an envelope addressed to Bob.* It cannot tell who sent it, and the ephemeral
key is different for every single message, so it cannot group them either.

That is the whole point. The message body was already encrypted before NIP-17
existed. NIP-17 protects the **social graph**: who talks to whom, how often,
and when.

## How that guarantee gets thrown away

The wrap being anonymous does not help if the **connection** is not.

Two things combined to defeat it here, and neither involves breaking any
cryptography:

**1. Both copies went to our own relay.** Each DM publishes two wraps: one to
the recipient, one self-copy so the sender's own history survives a reload.
`fetchPartnerInboxRelays` used to *union* the peer's published kind-10050
inbox with a fallback that always contained the active relay:

```js
// the bug
return relays.length > 0
  ? Array.from(new Set([...relays, ...fallbackRelays]))  // ← union
  : fallbackRelays;
```

So even when the peer had published a perfectly good inbox list, our own relay
received both wraps anyway.

**2. That socket is authenticated as us.** Obelisk auto-answers NIP-42 AUTH
(`onauth: this.getAuthSigner()`). The relay therefore knows the connection
belongs to a specific pubkey *before* anything is published on it.

Put together, the relay observes: the connection authenticated as Alice just
published two same-sized kind-1059 events, seconds apart, one addressed to Bob
and one addressed to Alice.

It does not need to decrypt anything. The throwaway signing key is irrelevant,
because the socket already identified the sender. It is like posting two
anonymous letters while showing the postman your ID, and addressing one of
them to yourself.

The self-copy makes this strictly worse. A single wrap addressed to Bob is at
least ambiguous about who sent it. Two wraps published together, one to Bob
and one to you, states the pair outright.

## What we do about it

**An ordered ladder, each rung used alone.** `resolveGiftWrapRelays` walks
these in order and never unions them:

| Rung | Target | Why |
|---|---|---|
| 1 | Recipient's kind-10050 inbox | The answer NIP-17 defines. Nothing of ours is added. |
| 2 | Recipient's NIP-65 read relays | Still relays *they* chose, so the wrap stays on their infrastructure. |
| 3 | Our active relay | Last resort, only for a peer with no published lists at all. |

**The copies are kept apart.** The self-copy goes to our own inbox, minus any
relay that just took the recipient's copy, so one relay does not see both.

**AUTH is scoped per publish.** `publishSignedEvent` takes an `authMode`:

- Gift wraps use `'last-resort'` — publish anonymously, and only answer AUTH if
  every relay refused with `auth-required`. Identifying ourselves on the socket
  would undo the ephemeral key no matter where the event was routed.
- The kind-10050 publish uses `'never'`. An inbox list is *meant* to be public,
  so it needs no authenticated connection.

**Delivery still wins for peers with nothing published.** Rung 3 exists because
the spec rule is that a send is never blocked. The privacy cost is documented
at the call site.

### One deliberate behaviour change

If a peer advertises an inbox and that inbox is dead, the send now **fails
visibly** instead of silently succeeding by falling through to our own relay.
That is user-visible and it is the intended trade: a message the user believes
was delivered, sitting on a relay the recipient never reads, is worse than an
honest failure.

## What this cannot fix

**Shared relays.** If the same relay appears in both parties' inbox sets — very
common, since most people use the same handful of defaults — it receives both
wraps regardless of anything a client does, and can correlate on timing and
size. No single client fixes this; it is a property of Nostr's relay model.

**Timing.** `created_at` is fuzzed by up to two days on both the seal and the
wrap, which decorrelates the *claimed* time. It does nothing about the moment
the relay actually receives the event. A relay always knows real arrival time.

**Size.** The two wraps for one message are near-identical in length. Padding
is applied inside the envelope, but a relay seeing two same-sized events land
together can still guess they are a pair.

**The self-copy still tells our own relay that we sent *a* DM.** Not to whom —
that part is fixed — but the event rides our authenticated socket, and
`SimplePool` offers no per-publish unauthenticated connection. Closing this
needs a second, anonymous pool, which is a larger change than this branch.

These are worth stating plainly rather than implying the fix is total.

## Rules for anyone changing DM routing

- Adding a relay to a publish target is a privacy decision, not a delivery
  tweak. Justify it in a comment.
- Never union a discovered inbox with a fallback. Use the fallback only when
  discovery genuinely returned nothing.
- Anything published on an AUTH'd socket is attributable to the user. If the
  event is meant to be anonymous, it must not go out on one.
- Reads are much less sensitive than publishes. Querying for a peer's inbox
  or attestation reveals interest; publishing a wrap over an authenticated
  socket reveals authorship. Do not over-correct reads and break delivery.

## History

This leak shipped briefly on the branch that introduced NIP-17 and was caught
by an audit pass reading relay routing rather than cryptography. Four earlier
review rounds looked at the same branch and missed it, because they were all
checking the seal, the signature and the envelope — which were correct the
whole time.

See `docs/direct-messages.md` for how DMs work generally, and
`docs/superpowers/specs/2026-08-16-nip17-dms-design.md` for the design.
