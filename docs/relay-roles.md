# Relay roles & ranks

Operator-defined ranks — "Moderator", "Contributor", "OG" — rendered as a badge
next to a user's name in chat and in the member list. Same trust model and
storage shape as [relay branding and channel layout](relay-layout-and-branding.md):
NIP-78 (kind 30078) parameterized replaceable events authored by the **relay
operator** (the NIP-11 `pubkey`). A channel admin does not gain relay-wide role
authority, and readers filter on the operator as author, so a roles event
published by anyone else is never parsed.

Code: [`src/lib/relay-roles.ts`](../src/lib/relay-roles.ts) ·
UI: `RoleBadge.tsx`, `RelayRolesAdminModal.tsx`.

## Wire format

Two `d` tags, both on kind 30078:

| `d` tag | Holds | Tags |
|---|---|---|
| `obelisk:roles:<relayUrl>` | the catalog — which roles exist | `["role", id, name, tier, color, emoji]` |
| `obelisk:role:<relayUrl>:<roleId>` | that role's holders | `["role", id]`, `["p", pubkey]` … |

Holders live in one event **per role** rather than inside the catalog:

- granting or revoking one role never rewrites the others, so two operator
  sessions editing different roles can't clobber each other;
- a role with many holders can't push the catalog past a relay's event-size
  limit.

`id` is a slug (`[a-z0-9_-]{1,32}`, derived from the name), `tier` is an
integer 0–999 where **higher is more senior**, `color` is `#rrggbb`
(shorthand is expanded on parse), and `emoji` is an optional badge glyph
(capped at 8 characters, whitespace stripped). The glyph is positional and only
written when set, so a reader that stops at the color still parses cleanly.
The catalog is capped at `MAX_ROLES` (24).
`parseRoleHolders` requires the event's `d` tag to match the relay being read,
so a holders list published for one relay can't grant roles on another.

## Which badge shows

A user may hold any number of roles. `topRole()` picks the one that renders:
highest tier wins, ties broken by `id` so every client agrees. Revoking is
removing the pubkey from that role's holder list — the badge then falls back
to the next-highest role the user still holds, or disappears. Deleting a role
from the catalog has the same effect for everyone holding it (holder lists for
unknown roles are ignored).

## Subscription and delivery

Roles are relay-wide operator data, so they follow the single-relay rule: the
**active relay only**, never the configured-relay union.

```
subscribeRelayRoles(relayUrl, [operatorPubkey], onChange)
├── REQ  kind 30078 #d=obelisk:roles:<relay>          — catalog
└── REQ  kind 30078 #d=[obelisk:role:<relay>:<id>, …] — holders, one REQ for all
                                                        roles, re-opened when
                                                        the catalog changes
```

Both are seeded from `bridgeCache` (stale-while-revalidate) so badges paint on
reload instead of popping in a second after the message they belong to.
Publishes bump `created_at` past the last write for that `d` tag so a same-second
edit still wins the replaceable-event race.

Each shell (`DesktopShell`, `mobile/PhoneShell`) holds the single subscription
and fans `rolesByPubkey()` into the chat store; `RoleBadge` reads that map, so
message rows and member rows never open their own REQ.

The desktop member list reads the same map to section online members by
standing: channel admins first, then one section per role in tier order, then
everyone without a role. Offline stays a single section — splitting absent
people by rank is noise.

## Admin surface

Server settings → **Roles & ranks** (relay operator only). Create roles, rename
them, pick a badge emoji, set the badge color, reorder them (position sets the
tier — top row is most senior), and grant/revoke per member by npub or hex
pubkey — the member picker searches everyone the relay knows about
(`useRelayPeople()`, the union of every channel's admin and member lists) by
display name, NIP-05 or pubkey, and still accepts a pasted npub for someone
the relay has not seen. The emoji picker is unicode-only: a custom emoji is a relay-scoped
image, and the badge has to render from the catalog alone on any client.

The catalog is edited as a draft and published with **Save roles**; grants and revokes publish
immediately to that role's holder list. A newly added role can only be assigned
once it has been saved to the relay.
