# Content Migration Plan — Seeder → DB-editable

**Status:** active priority — partial. `Message.pinnedAt` / `pinnedByPubkey` columns and a pins panel exist; the admin editor, migration script and `Channel.purpose` work are still pending. Referenced from [ROADMAP.md](../ROADMAP.md).

## Why this matters

The deployed La Crypta server is behind `prisma/seed.ts`. The initial channel content — welcome message in `empezá-acá`, posts of `indice` (reglas, actividades, proyectos, redes), posts of `méritos` (plantillas de reclamo), channel descriptions, emojis, tags — is **hardcoded in the seeder** and only applied once at server creation. Once the server exists there is no way to edit that content from the UI, and re-running the seeder does not update existing rows. The fix is to move it all into DB-editable entities.

## Parts

### 1. Pinned messages (partially shipped)

- Schema already has `Message.pinnedAt DateTime?` + `Message.pinnedByPubkey String?` and an index on `[channelId, pinnedAt]`.
- `GET /api/channels/[channelId]/pins` is shipped, and `PinnedMessagesPanel.tsx` renders them.
- Pending: NIP-29-compatible pin events to toggle pin state. Pin button in the message context menu (admin/mod+), badge 📌 on the pinned message inline. Works for forum posts too (pinned posts appear first in the list).

### 2. Channel description / topic editor

`Channel.description` already exists. Make it editable from /admin → ChannelManager **and** from a settings gear in the channel header (admin+). Render in the channel header Discord-style: `# chat-general — descripción del canal`.

### 3. Channel info / "rules" sticky panel

For channels like `empezá-acá` or `indice` that today have seeded content, add a sticky "channel info" panel editable from /admin. Markdown (same capabilities as the current seeder body). Renders above the first message, collapsible.

### 4. Migration of seeded content to DB

One-shot migration script that walks each hardcoded block in `seed.ts` — welcome message of `empezá-acá`, posts of `indice`, posts of `méritos`, etc. — and creates it as a pinned message or forum post **attributed to the system member**, idempotent (skip if already present). After running, that content lives in the DB and is editable from /admin without touching code.

### 5. Refactor of `prisma/seed.ts`

The seeder drops down to creating only the minimum structure — server + categories + empty channels + tags. Content becomes the responsibility of the migration above, or of admins editing from /admin. Idempotent and safe to re-run on every deploy.

### 6. `Channel.purpose` enum

Some seeded channels have a functional role beyond being a regular text channel:

- `empezá-acá` → onboarding widget.
- `méritos` → merit-claim button that opens a form.
- `indice` / rules channel → prominent rules display.

Add `Channel.purpose` (optional enum: `onboarding | rules | announcements | merit_claim | normal`). UI uses it to show the right widget/button. Configurable from /admin → ChannelManager.

## Tests

- Pin/unpin endpoint with role guards (admin+ only).
- Pinned panel renders latest pins first.
- ChannelManager saves `description`, `info`, `purpose`.
- Migration script is idempotent (running twice is a no-op).
- Purpose-specific widgets mount on the right channels.
