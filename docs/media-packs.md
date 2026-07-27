# Emoji, GIF, and sticker packs

Obelisk manages emoji, GIFs, and stickers as Nostr media packs. There is no
backend catalog or database: packs, favorites, and server favorites are signed
events fetched from relays and cached locally for fast first paint.

## User experience

- Open **Emoji, GIFs & stickers** directly from the signed-in user settings on desktop or mobile.
- **Marketplace** discovers public packs. **View pack** opens every item inside the same modal; it never opens a media route or browser tab.
- Selecting an item opens a larger preview with its source pack and an explicit single-item favorite action.
- **My packs** creates, edits, and deletes named packs owned by the user.
- **Favorites** contains individually saved media and packs selected with the explicit **Save pack** control.
- Use the Emoji/GIF/Sticker filters to browse or create packs of the intended
  media type.
- Relay operators open a server-only selection view from server settings. It hides personal favorite controls; **Add pack to server** and **Remove pack from server** are explicit relay actions there. **Save & add to server** creates a named pack and selects its live reference for the active relay.

The message-bar selector keeps its existing Emoji/GIF/Sticker interface. Its
personal sections also include the user's item favorites and items from every
favorited pack. Favoriting one item does not subscribe to the rest of its pack.
The existing **Create** sticker tile uploads into the user's editable
**My stickers** pack, creating and favoriting that pack when needed.

## Nostr contract

| Data | Kind | Identity |
|---|---:|---|
| Named media pack | `30030` | `30030:<author>:<d>` |
| User favorites | `10030` | one replaceable event per user |
| Server favorites | `30030` | `d = obelisk:emojis:<relayUrl>` by the relay operator |

### Named packs

Each user pack is a parameterized replaceable NIP-51 emoji-set event:

```json
[
  ["d", "pack-identifier"],
  ["title", "Party pack"],
  ["description", "Optional description"],
  ["image", "https://blossom.example/cover.webp"],
  ["emoji", "party_parrot", "https://blossom.example/parrot.gif", "30030:<author>:pack-identifier"],
  ["media", "party_parrot", "gif"]
]
```

The standard `emoji` tag keeps packs useful to NIP-30/NIP-51 clients. Obelisk's
`media` tag records whether an item belongs in the Emoji, GIF, or Sticker
picker; clients that do not understand it can safely treat the item as an
emoji. If the tag is missing, `.gif` URLs are inferred as GIFs and other URLs
as emoji.

Pack edits reuse the same `d` value. Newest `created_at` wins. Obelisk publishes relay-list replacements with monotonic timestamps so rapid removals cannot leave stale Server GIFs, and makes
consecutive local edits monotonic so two saves in one second cannot discard the
second edit. Deleting an owned pack publishes a NIP-09 kind 5 request with its address and removes the local cached copy and saved-pack reference.

### User favorites

The user's replaceable kind `10030` event contains:

- `['a', '30030:<author>:<d>']` for each favorited pack.
- `['emoji', '<name>', '<url>', '<optional-pack-address>']` for each
  individually favorited item.
- `['media', '<name>', 'emoji|gif|sticker']` to preserve the picker type.

Pack references stay live: edits by the pack author flow through to users who
favorited the pack. Individual favorites retain their URL and name even if the
source pack is later unavailable.

### Server favorites

Each relay keeps an independent operator-authored kind `30030` list using:

```json
["d", "obelisk:emojis:<relayUrl>"],
["a", "30030:<author>:<pack-id>"]
```

Adding a marketplace pack stores its `30030:<author>:<d>` address in the relay list. Obelisk resolves that address against the newest pack event, so edits and removals propagate to every server that selected the pack.
Media type tags are preserved. Individually added media remains embedded in the relay list and can be removed without changing a selected pack; removing a selected pack only removes its address from that relay;
it does not change the user's pack or any other relay. Relay-wide write
controls remain operator-only: use the valid NIP-11 `contact` npub, falling
back to the NIP-11 `pubkey`; the relay is the final authorization boundary.

### Visibility and encryption

Marketplace packs and server favorites are intentionally public so other users
and servers can discover and reuse them. User favorites are also published as
standard kind `10030` tags for NIP-51 interoperability. NIP-51 supports private
lists by placing NIP-44-encrypted tags in event content, but Obelisk does not
silently mix private and public favorites. A future privacy control should
publish a clearly separate private list.

## Sending and rendering

The message picker combines individually favorited items, items from favorited
packs, and the active server's favorites. Emoji usage carries NIP-30 `emoji`
tags on the message or reaction. A standalone sticker also carries Obelisk's
validated `sticker` marker plus the NIP-30 fallback, so other clients can still
render it. GIF messages use their Blossom HTTP(S) URL. Event-local tags keep
sent content renderable if a pack or server list changes later.

Only normalized shortcode names and HTTP(S) media URLs are accepted at the
event boundary.

## One-time import of an existing server list

1. Log in with the relay operator identity.
2. Open the relay's **Emoji, GIFs & stickers** settings.
3. Select **Import existing list once**.

Obelisk copies every existing server item into an editable pack named from the
relay host. Migration never clears or rewrites the source list, so a failed or
interrupted publish cannot lose the server's media. After import, the pack can be edited, saved, and reused on other relays. The import button disappears as soon as that deterministic pack exists, leaving only the new pack workflow.

## Uploads and discovery

The pack editor accepts one or many files from the computer, uploads them through the existing Blossom BUD-01 uploader, and also supports direct HTTP(S) URLs. Events store the returned
absolute HTTP(S) URL; Obelisk does not proxy media or write upload metadata to a
database.

At login, the bridge subscribes to kind `30030` packs on the active relay and
profile relays, plus the current user's kind `10030` favorites. Parsed packs and
favorites use the existing local `bridgeCache` as stale-while-revalidate data.

## Code map

```text
src/lib/media-packs.ts                       parse and serialize packs/favorites
src/lib/nostr-bridge/client.ts               subscribe, ingest, publish, and cache
src/components/media/MediaLibraryModal.tsx   marketplace, packs, favorites, one-time import
src/components/chat/MessageMediaPicker.tsx   merged Emoji/GIF/Sticker data
src/lib/relay-emojis.ts                      operator-owned server favorites
src/lib/custom-emoji-tags.ts                 NIP-30 validation and message tags
src/lib/sticker-tags.ts                      standalone sticker marker and fallback
```
