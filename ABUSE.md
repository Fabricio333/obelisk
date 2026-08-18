# Reporting abuse

Obelisk is open-source software for chatting over the Nostr protocol. This document explains what
I can and cannot do about content you've encountered, and how to reach me.

**Contact: abuse@obelisk.ar**

## What Obelisk is

Obelisk is a client — a program that reads and writes Nostr events. It has no backend, no accounts,
no database, and no server that holds your messages. Messages live on **relays**: independent
servers, each run by whoever runs it.

I write and publish the client. Separately, I operate a small number of relays. Those are different
roles and the difference decides what I can act on.

## Relays I operate

- `wss://public.obelisk.ar`
- `wss://lacrypta-relay.obelisk.ar`

**I can act on content on these relays.** Specifically I can delete an event, remove a user from a
group, block a public key from the relay entirely, and delete all events published by a given key.

## Relays I do not operate

Every other relay, including any relay you added yourself and any relay a third party recommends.
**I cannot delete, edit, or moderate anything on a relay I don't run.** Nobody can, except its
operator. If your report concerns another relay, I will reply pointing you at that operator's
contact (published in its NIP-11 document), but I cannot act.

## What I cannot do, on any relay

- **Identify a user.** There are no accounts, emails, phone numbers, or device identifiers. A user
  is a public key. I do not know who holds it.
- **Read or recover direct messages.** DMs are end-to-end encrypted. I do not hold the keys.
- **Unpublish an event globally.** Nostr events are signed and replicated. Deleting from a relay I
  run removes it from that relay; copies on other relays are outside my control.

## How to report

Email **abuse@obelisk.ar** with:

1. The **relay URL** the content is on (e.g. `wss://public.obelisk.ar`) — without this I usually
   cannot find it.
2. The **event ID** (`nevent1…` or hex) and/or the **public key** (`npub1…` or hex).
3. What is wrong with it.

If you are reporting content that is illegal in your jurisdiction, say so and say which
jurisdiction.

## Response times

- **Acknowledgement within 72 hours.**
- **Substantive response within 7 days.**

If you have not heard back in that window, resend — mail does get lost.

## Legal process

For law-enforcement requests or legal notices, use **abuse@obelisk.ar** and say so in the subject.

An honest statement of what data exists: the relays I operate store the Nostr events published to
them, which are signed and mostly public by design. Relay access logs currently include client IP
addresses. There are no user accounts, real names, email addresses, or payment records, because the
software has no concept of them.

## About this project

Obelisk is an individual open-source project. There is no company behind it. It is published under
the AGPL-3.0 and provided as-is, without warranty. See `LICENSE`.
