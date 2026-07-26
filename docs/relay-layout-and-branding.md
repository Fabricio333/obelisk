# Relay layout & branding (operator-controlled, shared)

Two NIP-78 (kind 30078) replaceable parameterized events let admins control
what every user sees for a given relay:

- **Layout** — categories + channel ordering. `src/lib/channel-layout.ts`
- **Branding** — relay icon, banner, display name, description.
  `src/lib/relay-branding.ts`

Both accept one authoritative author: the validated NIP-11 operator identity.

Relay custom emojis use the same operator-author model, but they are stored as
NIP-51 `kind:30030` emoji-set events instead of NIP-78. See
[relay-custom-emojis.md](relay-custom-emojis.md).

## Storage

| What | Kind | d-tag |
|---|---|---|
| Layout | 30078 | `obelisk:layout:<relayUrl>` |
| Branding | 30078 | `obelisk:branding:<relayUrl>` |

Layout tags:

```
["category", catId, name, position]
["channel",  channelId, catId|"", position]
```

Branding tags: `["icon", url]`, `["banner", url]`, `["name", text]`,
`["description", text]`.

## Who can edit (the "authors" set)

The only pubkey accepted as authoritative for relay-wide settings is the
validated NIP-11 `contact` npub when present, falling back to the relay's
NIP-11 `pubkey`.

The sidebar gear is rendered only when the active identity matches that
operator key. Layout, branding, and emoji subscriptions use the same key, so
events from channel admins or unrelated pubkeys are ignored client-side.

## Security boundary

The client gate prevents accidental access and rejects untrusted display
settings, but it is not a substitute for relay authorization. NIP-29 member
and role commands are signed by the client and must be authorized by the
relay; a modified client can always attempt to publish them.

## Code map

```
src/lib/channel-layout.ts         subscribeLayout(relay, authors[], cb)
                                  useChannelLayout(relay, authors[])
                                  publishLayout, applyLayout, relayOperatorAuthors
src/lib/relay-branding.ts         subscribeBranding(relay, authors[], cb)
                                  useRelayBranding(relay, authors[])
                                  publishBranding
src/app/app/DesktopShell.tsx      Sidebar — gates the server settings gear
                                  and relay-wide modals
```

## Operator UX

1. Log in with the validated operator identity advertised by NIP-11.
2. Open `/app`, select the relay.
3. In the sidebar header, click the gear next to the connection dot.
4. Edit and **Publish**. The replaceable event lands on the relay; every
   client subscribed via `useChannelLayout` / `useRelayBranding` updates
   immediately.

If the gear does not appear, set NIP-11 `contact` to the operator npub (or
`pubkey` to the operator hex key) and reconnect.
