# Obelisk Desktop Tor Node

## Goal

Ship one installable Obelisk application for macOS, Linux, and Windows that is
both a chat client and an optional server.

A user should be able to:

1. Install Obelisk like a normal desktop application.
2. Log in with a Nostr key.
3. Connect to Obelisk servers shared by other people.
4. Press **Host a server** to start a local `obelisk-relay` through Tor.
5. Whitelist Nostr npubs or create invitations.
6. Share the generated server address with friends.
7. Leave the application running so the relay remains available.

No domain, TLS certificate, public IP, port forwarding, Cloudflare account, or
manual Docker setup should be required.

## Product model

Every installed application contains the same pieces:

```text
Obelisk Desktop
├── Obelisk chat client
├── obelisk-relay
├── Tor client and onion service
├── relay database and configuration
└── node manager
```

The node manager starts and stops the relay and Tor, reports their status, and
keeps their data in the application's persistent data directory.

Running a local server is optional. A user may only connect to other servers,
host their own, or do both.

## Hosting flow

The host experience should be:

1. Click **Host a server**.
2. Choose a server name.
3. Confirm the operator npub.
4. Obelisk starts `obelisk-relay` on loopback only.
5. Tor creates a persistent onion service that forwards to the local relay.
6. Obelisk displays the server as online and provides a share button.

The onion-service private key must persist across restarts so the server keeps
the same address. It must be included in encrypted backups; losing it changes
the address.

The host computer must remain powered on with an internet connection. If it is
offline, the server is unavailable until it returns. Tor provides reachability,
not replication or automatic failover.

## Connecting flow

People using the same Obelisk desktop application can join through an explicit
invitation:

```text
obelisk://join?relay=ws://exampleaddress.onion&invite=CODE
```

The final invite format should carry:

- the onion relay address;
- the expected relay/operator public key;
- an optional NIP-29 group identifier;
- an optional limited-use invitation code.

Opening the invite adds the server to the server rail and connects through the
Tor instance managed by Obelisk. Onion relays must only be added by an explicit
user action or trusted invitation. They must not be accepted automatically from
arbitrary remote relay-list events.

## Access control

The onion address locates the server; it is not membership authorization.
`obelisk-relay` remains the authorization boundary.

The host can:

- whitelist individual Nostr npubs;
- remove or ban npubs;
- use NIP-42 authentication;
- create expiring or limited-use invitations;
- use Web of Trust policies to admit trusted people.

All moderation and membership decisions remain signed Nostr operations. The
desktop interface only manages the local relay and presents those controls.

## Relay and event routing

Each community has one home relay. Group state and NIP-29 events must remain
scoped to that relay:

```text
server or group → home relay → subscriptions and publications
```

The client must not subscribe every saved relay into one shared group store.
Doing so would mix channels, membership, moderation, and messages from unrelated
servers. Selecting a server activates that server's relay context, following
the bridge's existing `switchRelay` model.

Public identity data and direct-message routing may still use the existing
profile and NIP-65 relay paths. Private NIP-29 events must never be copied to
public relays merely because the author is in the user's Web of Trust.

## Web of Trust routing

An online Obelisk node may help relay permitted **public** events from trusted
people, but this is separate from hosting a private chat server.

The first version should use Web of Trust only for:

- deciding which npubs may join automatically;
- filtering unwanted public events;
- discovering relay hints for trusted npubs;
- optionally accepting explicitly configured public event kinds.

It should not become a general relay-to-relay replication network in the MVP.
Automatic replication needs loop prevention, event-kind policies, storage
limits, deletion handling, trust boundaries, and privacy review.

The safe routing rule is:

```text
private group event  → home relay only
public allowed event → configured relays, subject to WoT policy
direct message       → recipient relay hints
```

## Desktop packaging

The application must ship three signed installers:

- macOS;
- Linux;
- Windows.

For a real one-click experience, production installers should bundle compatible
relay and Tor binaries. Requiring Docker is acceptable for development but not
for the consumer application.

The node manager is responsible for:

- starting the relay and Tor after the user enables hosting;
- restarting failed processes with a bounded backoff;
- stopping them cleanly;
- applying upgrades without deleting relay data;
- displaying bootstrap, online, degraded, and offline states;
- exposing logs and a diagnostic export;
- backing up the relay database, configuration, and onion identity.

The relay must listen only on loopback. Tor is the public ingress.

## MVP

The smallest useful release includes:

1. Desktop application packaging for all three platforms.
2. Existing Obelisk client and identity methods.
3. Connect to a shared onion relay.
4. Start and stop a bundled local relay.
5. Create and persist a Tor onion service.
6. Display and copy the server invitation.
7. Manage an npub whitelist.
8. Persist and back up relay data and onion keys.
9. Keep each server's events isolated.
10. Show clear relay and Tor health states.

Automatic public-event forwarding between independently hosted nodes is a later
feature. The MVP already supports a useful network: people host sovereign chat
servers, share them directly, and move between them with one application.

## Out of scope for the first release

- Voice and video calls.
- Relay database replication or high availability.
- Hidden background hosting after the user explicitly quits the application.
- Automatically importing unknown onion addresses from Nostr events.
- Broadcasting private group events across servers.
- A custom replacement for Tor.

## Definition of done

The feature is ready when a new user on each supported desktop platform can:

1. Install Obelisk without installing Docker or configuring Tor.
2. Start a server and receive a stable onion invitation.
3. Whitelist another npub.
4. Send the invitation to a second Obelisk desktop user.
5. Have that user connect, authenticate, join, send a message, disconnect, and
   later recover the stored history.
6. Restart the host application without changing the address or losing data.
7. Confirm that events from different saved servers never appear in each
   other's channels.
