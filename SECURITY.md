# Security policy

**Contact: security@obelisk.ar**

Obelisk handles Nostr private keys, signed events, and end-to-end encrypted direct messages. I take
reports about any of those seriously.

## Please do not open a public issue

Report privately to **security@obelisk.ar**.

## Scope

**In scope**

- This repository (the Obelisk client)
- `github.com/obelisk-app/obelisk-relay`, `obelisk-sfu`, and `obelisk-bots`
- The deployment at `obelisk.ar`

**Out of scope**

- Relays, signers, wallets, and media servers operated by other people
- Vulnerabilities in Nostr itself — report those to the NIPs repository
- Findings that require a user to paste their own `nsec` into a hostile page

## Please do not test against the live public relay

`wss://public.obelisk.ar` is used by real people. Run a local relay instead — see the relay repo for
a working `compose.yml`.

## What to include

- Impact, ideally framed as: private-key exposure, DM confidentiality, message integrity, or
  availability
- Affected component and version or commit SHA
- Reproduction steps or proof of concept
- Any suggested fix

## Response times

- **Acknowledgement within 48 hours.**
- **Fix within 90 days** for high and critical severity — faster where key material or DM
  confidentiality is at risk.

I will credit you in the advisory unless you'd rather I didn't. There is no bug bounty; this is an
unfunded individual project.
