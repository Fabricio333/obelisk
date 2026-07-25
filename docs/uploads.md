# Uploads — storage layout and access model

## Storage

Uploaded files live on disk at `./uploads/<24-hex>.<ext>` relative to the
Node.js working directory. In Docker this is backed by a persistent volume
(see `docker-compose.yml`). The directory is intentionally **outside**
`public/` because Next.js indexes `public/` at build time and won't serve
files written there at runtime in production.

Files are served by a dedicated route handler at
`src/app/uploads/[name]/route.ts`, not by Next.js static file serving.

## URL format

Stored URLs in the database (emojis, GIFs, message content, etc.) are
**site-relative** (`/uploads/<name>.<ext>`) — never absolute.

Absolute URLs would bake the hostname at upload time, which breaks when:
- The server listens on `0.0.0.0` (not a routable client hostname)
- The domain changes (self-hosted migration, reverse-proxy swap)
- Clients load the app over a different scheme/port than the upload was made

If you see `https?://<host>/uploads/...` in the DB, it's legacy data — run
the backfill:

```sql
UPDATE "ServerEmoji"
   SET url = regexp_replace(url, '^https?://[^/]+/uploads/', '/uploads/')
 WHERE url ~ '^https?://[^/]+/uploads/';

UPDATE "Message"
   SET content = regexp_replace(content, 'https?://[^/\s)]+/uploads/', '/uploads/', 'g')
 WHERE content ~ 'https?://[^/\s)]+/uploads/';
```

## Access model — IMPORTANT

The `/uploads/<name>` route **does not check authentication**. Anyone who
knows a filename can fetch it.

### What this means

- **Unlisted, not private.** Filenames are `randomBytes(12).toString('hex')`
  = 96 bits of entropy, effectively unguessable. This is the same model as
  Discord/Slack CDN URLs.
- **URLs leak across server boundaries.** A user on Server A who posts an
  image exposes that URL to anyone who sees the message — including
  non-members, kicked users, embed crawlers (Telegram/Twitter/Slack link
  previews), and search engines that index any page linking the URL.
- **No per-server scoping at fetch time.** The uploads table doesn't record
  which server owns a file, and the route handler doesn't know either.
- **Kicked/banned users retain access** to any URL they already saw.

### When this is fine

- Emojis, avatars, server icons, GIF libraries — content that's *intended*
  to be shareable.
- Casual chat attachments in a context where the threat model matches
  Discord's (i.e. "nobody outside the server is going to find these URLs,
  and if they do, it's not a disaster").

### When this is NOT fine

- Anything resembling private documents, PII, or regulated content.
- Rooms or servers advertised as "private" where members would reasonably
  expect attachments to be inaccessible to non-members.

### If you need to lock this down

Two tiers, in increasing order of strictness:

1. **Session-gated** — require a logged-in session in
   `src/app/uploads/[name]/route.ts`. Cheap to implement, but breaks
   `<img src>` in contexts that don't carry the session cookie
   (cross-origin embeds, external link-preview crawlers, email clients).

2. **Server-scoped** — add a `serverId` column to an `Upload` table,
   populated at upload time, and check the viewer's membership in that
   server at fetch time. This is the "correct" model for private content
   but requires: schema migration, upload route persisting rows, fetch
   route doing a DB lookup per request (cache-friendly since filenames
   are immutable), and a strategy for emoji/avatar images that need to
   stay public.

Neither is implemented today. Status quo matches Discord's CDN model and
is acceptable for a Discord-like chat. Revisit if the threat model shifts.

## Voice notes

The composer records microphone audio with the browser MediaRecorder API, shows a live elapsed timer, uploads the finished file through Blossom, and publishes a kind 9 group message. The message content remains the Blossom HTTP URL for client compatibility.

Obelisk adds an explicit event-local marker so an audio-only WebM is never guessed to be video:

~~~json
["voice", "https://blossom.example/<hash>.webm", "5"]
~~~

The third value is the rounded duration in seconds. Clients accept the marker only when the URL is HTTP(S), the trimmed message content exactly matches it, and the duration is between 0 and 3600 seconds. Invalid markers fall back to normal URL rendering.

Tagged voice notes render with the compact Obelisk audio player (play/pause, seek, elapsed time, total duration) rather than a native video canvas. Editing the uploaded URL clears voice-note intent before send.

Code map:

~~~text
src/components/chat/ComposerActions.tsx  recorder and live timer
src/lib/voice-note-tags.ts              marker validation
src/lib/nostr-bridge/client.ts          event parsing and optimistic state
src/components/chat/MessageContent.tsx  compact audio player
~~~

## Size limits

Per-mime caps (bytes) live in `src/lib/attachments.ts`:

- Images: 10 MB
- Video: 50 MB
- Documents: 25 MB
- Audio: 25 MB

Servers can tighten these per-mime (but not loosen past the global
ceiling) via the admin panel. Custom emojis clamp tighter still
(256 KB static, 2 MB GIF) client-side; the GIF library clamps to 8 MB.
