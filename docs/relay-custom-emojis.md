# Relay custom emojis

Obelisk stores custom emoji packs as relay-scoped Nostr events, not in a
backend table. Each relay can have its own list, and admins can copy that
list to another configured relay from the UI.

## Protocol model

There are two layers:

| Layer | Kind / tags | Purpose |
|---|---|---|
| Relay emoji list | NIP-51 `kind:30030` with `emoji` tags | The admin-managed picker list for one relay |
| Message/reaction usage | NIP-30 `["emoji", name, url]` tags | Makes each event renderable by other clients even if their local list differs |
| Sticker message | Obelisk `["sticker", name, url]` plus NIP-30 fallback | Marks sticker-only messages for large media rendering |

The relay list uses a deterministic `d` tag:

```json
["d", "obelisk:emojis:<relayUrl>"]
```

Example event tags:

```json
[
  ["d", "obelisk:emojis:wss://relay.example"],
  ["title", "Obelisk emojis"],
  ["emoji", "party_parrot", "https://blossom.example/<hash>.webp"],
  ["emoji", "wave", "https://blossom.example/<hash>.png"]
]
```

Shortcode names are normalized to lowercase `a-z`, `0-9`, and `_`, up to
64 characters. File extensions are stripped when names are derived from
uploads.

## Relay scoping

The `d` tag includes the relay URL on purpose. A list published for
`wss://relay-a.example` is not reused as the canonical list for
`wss://relay-b.example`.

When an admin uses **Share** in the emoji modal, Obelisk republishes the
same emoji tags under the target relay's own `d` tag. That preserves
independent per-relay ownership while making migration/copying easy.

## Who can edit

The author set is the same model used by relay layout and branding:

- any pubkey in a visible group's NIP-29 admin list (`kind:39001`)
- the relay's NIP-11 operator pubkey, when advertised

Clients subscribe to `kind:30030` only from that author set, and newest
`created_at` wins. Events by non-admin pubkeys are ignored by the client.

## Uploads

Emoji image files are uploaded to Blossom with the existing BUD-01 upload
flow in `src/lib/blossom.ts`. The relay emoji event stores the resulting
HTTP URL in each `emoji` tag.

Supported file types in the admin UI:

- PNG
- JPEG
- GIF
- WebP

GIF files are handled with the same protocol as static emoji images: they
upload to Blossom and are referenced by normal NIP-30 `emoji` tags when
used. The picker presents them separately under **Server GIFs**, while
static images appear under **Server emojis**.

## Folder import

The relay emoji admin modal supports folder import:

1. Open `/app`.
2. Select the relay.
3. Use the relay header emoji/admin button.
4. Click **Upload folder**.
5. Choose a folder containing image files.
6. Review the generated shortcodes and click **Save**.

Folder import filters non-image files. Shortcodes are derived from
filenames:

| Filename | Shortcode |
|---|---|
| `Party Parrot.webp` | `:party_parrot:` |
| `wave.png` | `:wave:` |
| `nostr-gr.gif` | `:nostr_gr:` |

If two files normalize to the same shortcode, Obelisk appends a numeric
suffix such as `_2`.

## Rendering and interoperability

When a user sends a message containing a custom shortcode, Obelisk scans
the content and adds NIP-30 `emoji` tags for every custom shortcode used.
The same happens for custom emoji reactions.

This means old events remain renderable even if the relay's current emoji
list later changes, and other NIP-30-aware clients can render the custom
emoji from the event itself.

## Stickers

Stickers are distinct from inline custom emoji. Selecting an item from the **Stickers** tab creates a kind `9` message whose content is the matching shortcode and whose tags carry both forms:

```json
{
  "kind": 9,
  "content": ":party_cat:",
  "tags": [
    ["h", "<group-id>"],
    ["emoji", "party_cat", "https://blossom.example/<hash>.webp"],
    ["sticker", "party_cat", "https://blossom.example/<hash>.webp"]
  ]
}
```

The `emoji` tag is the NIP-30 compatibility fallback. Other NIP-30 clients still have enough event-local data to render the shortcode. Obelisk uses the `sticker` marker to render the asset as standalone media instead of a 20px inline emoji.

The sticker marker is accepted only when the name is normalized, the URL uses HTTP(S), and the entire trimmed content is exactly `:<name>:`. Editing the draft or adding an attachment clears sticker intent. These checks prevent a stray marker from hiding normal message text.

Personal stickers use the normal Blossom BUD-01 upload flow. Their local picker index is stored under `obelisk:personal-stickers`; portability does not depend on that index because each sent event copies the URL into both tags.

The picker uses La Crypta black/card tokens, fixed-height grid tracks, clipped cells, and `object-contain`, so mixed source dimensions cannot overlap.

## Removing messages and reactions

Clicking a reaction pill that the current user already added removes that
reaction by publishing a NIP-09 deletion event:

```json
[
  ["e", "<reaction-event-id>"],
  ["k", "7"],
  ["h", "<group-id>"]
]
```

The deletion event is `kind:5` with content `remove reaction`. Obelisk
accepts NIP-09 deletions only from the pubkey that authored the target
event. The same path is used when a user deletes their own group message,
with `["k", "9"]` and content `remove message`.

Admins remove messages or reactions for everyone with NIP-29
`kind:9005` delete-event moderation:

```json
[
  ["h", "<group-id>"],
  ["e", "<message-or-reaction-event-id>"]
]
```

Obelisk subscribes to both deletion protocols per group. A `kind:9005`
event removes the targeted group message or reaction from local state, and
deleting a message also hides reactions that targeted that message.

## Code map

```text
src/lib/relay-emojis.ts                  kind:30030 parse/subscribe/publish
src/lib/custom-emoji-tags.ts             NIP-30 tag extraction and normalization
src/lib/sticker-tags.ts                  sticker validation + fallback tags
src/lib/personal-stickers.ts             personal picker index
src/components/admin/RelayEmojiAdminModal.tsx
                                         relay emoji admin UI, folder import, share
src/components/chat/EmojiPicker.tsx      custom emoji picker entries
src/components/chat/MessageContent.tsx   inline emoji + standalone sticker rendering
src/lib/nostr-bridge/client.ts           sendMessage/sendReaction emoji tags
                                         removeReaction NIP-09 kind 5 events
```
