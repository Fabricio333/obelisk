# Server banner — NIP-29 custom `banner` tag

NIP-29 defines `name`, `about`, and `picture` tags on group metadata events
(kinds **39000** and **9002**), but does not standardise a banner image.
Obelisk adds a **`["banner", <url>]`** tag using the same events. Other
NIP-29 clients ignore unknown tags, so this is forward-compatible.

## Event shape

### Setting / updating a banner — kind **9002** (edit-metadata)

Signed by a group admin. Published to the group's relay.

```jsonc
{
  "kind": 9002,
  "tags": [
    ["h", "<groupId>"],
    ["banner", "https://example.com/banner.gif"]
    // optional: also set ["name", ...], ["about", ...], ["picture", ...]
  ],
  "content": "",
  "created_at": 1714000000
}
```

The relay replays the change as a refreshed kind **39000** group-metadata
event:

```jsonc
{
  "kind": 39000,
  "tags": [
    ["d", "<groupId>"],
    ["name", "La Crypta"],
    ["picture", "https://…/icon.png"],
    ["banner", "https://…/banner.gif"],
    ["public"], ["open"]
  ],
  "content": ""
}
```

### URL constraints

- `banner` is a single URL string. Static images (`.png`, `.jpg`, `.webp`) and
  animated GIFs are both expected; clients should render via a normal `<img>`
  tag. No size-hint tags — the server-rail / chat-header is responsible for
  cropping (`object-cover`).
- To clear the banner, publish a 9002 event with an empty value:
  `["banner", ""]`. Clients treat an empty string as "no banner".

## Compatibility notes

- The relay implementation is the source of truth for group metadata. If a
  relay strips unknown tags when it republishes 39000, banners will not
  propagate. Most current NIP-29 relays (`relay.0xchat.com`,
  `groups.fiatjaf.com`, `lacrypta-relay.obelisk.ar`) preserve unknown tags.
- Other NIP-29 clients will ignore the tag silently — no errors, no banner
  shown. Reverting to a banner-aware client picks the value up from the
  relay's existing 39000 event.

## Client implementation in this repo

- Type: `JsGroup.banner: string | null` — see
  `src/lib/nostr-bridge/types.ts`.
- Parse: `ingestGroupMetadata` in `src/lib/nostr-bridge/client.ts` reads
  `tag('banner')` from kind 39000.
- Sign: `editGroupMetadata({ banner })` adds `["banner", url]` to the kind
  9002 tag list (same file).
- Render: `ChatPanel` in `src/app/app/AppShell.tsx` renders the banner as a
  thin strip directly below the channel header.
- Edit: the channel settings modal (admin-only) exposes a "Banner URL" field.
