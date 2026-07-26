# Obelisk — Roadmap

Discord-like group chat where identity comes from Nostr keypairs. Architecture overview lives in [CLAUDE.md](CLAUDE.md); deploy runbook in [DEPLOY.md](DEPLOY.md); detailed specs and open bugs under [docs/](docs/README.md).

This file is the high-level roadmap — one line per initiative, grouped by phase. Implementation details, schemas, acceptance criteria and prior-art reading live in the docs. Completed work beyond the high-level bullets below lives in git history.

## 🛡️ Reliability — cross-cutting

End-to-end stability work that spans the dex + relay + SFU. Tracking it
here in obelisk-dex because the dex is where most of the symptoms surface
(channels not loading, voice freezing, "rpc timeout"). The companion
roadmaps in `obelisk-app/obelisk-relay` and `obelisk-app/obelisk-sfu`
mirror the pieces each repo owns.

- [ ] **Single source of truth for relay-import filtering.** Done at the
  parser layer (`isImportableNostrRelayUrl` in `src/lib/nostr-read.ts`)
  but should be promoted to a shared helper used everywhere a URL crosses
  from a Nostr event into `new WebSocket()` — covers any future client
  feature that pulls a relay list (NIP-50 search relays, NIP-78 channel
  layout fallbacks, recipient outbox lookups).
- [ ] **Deploy-stable chunk filenames.** Add a `generateBuildId` based on
  CI commit SHA so every deploy invalidates ALL chunk URLs. Current
  workaround is bumping `__obeliskVoiceBuild` / `__obeliskSfuRpcBuild`
  markers in `src/lib/voice/{client,sfu-rpc}.ts` whenever a sticky local
  cache (Brave shields, content-script extensions, HTTPS-inspecting
  proxies) pins old code at the same URL. Permanent fix: per-deploy
  build-id prefix on every asset URL.
- [ ] **E2E coverage for SFU + multi-device flows.** `scripts/e2e/` has
  a Playwright harness for login + send. Extend it to: (a) join a
  voice-sfu channel via two synthetic browsers, (b) verify both stay
  connected when using the same nsec across both, (c) verify a
  whitelisted relay rejecting a non-whitelisted pubkey shows the
  banner and not a stuck "Connecting…" spinner.
- [ ] **Bridge connection-state observability.** Surface a debug
  /connection-state pane (admin-gated) listing every active socket, its
  AUTH state, watchdog attempt count, and the queue depth. Lets us
  diagnose stuck pools without asking users to paste console output.
- [ ] **Offline-safe relay-list cache invalidation.** When NIP-65 / NIP-17
  relay lists are updated server-side (other clients republish), the dex
  should refresh. Today the cache TTL is 6h. Lower it for the user's own
  lists and add a manual "refresh" button in profile settings.
- [ ] **Auto-purge stale per-channel watchdog state on quota errors.**
  Quota / "concurrent REQs" CLOSEDs now back off via the parser
  (`parseRelayRejection` returns null for those), but the per-sub
  watchdog still consumes a slot until backoff expires. Add a short
  cool-down where same-relay subs that got quota-rejected don't re-fire
  for 30s instead of immediately retrying with backoff.
- [ ] **Production CSP hardening.** Drop GTM (currently in `src/proxy.ts`
  CSP) so we don't need `'unsafe-eval'` or the `googletagmanager.com`
  exception. Replace with self-hosted plausible / nostr-native analytics.
- [ ] **NIP-65 self-republish UX.** Detect when the user's own NIP-65
  contains a CSP-unsafe relay (`ws://`, localhost) and offer a one-click
  "fix and republish" button in profile settings. Many users carry these
  from earlier dev setups and never know.

## 🔥 Active priorities

- [ ] **App-wide i18n + per-user language** — extend landing i18n infra to chat/admin/moderation/forum/settings/errors, IP-based default on first login, `User.language` persisted, hot-swap from /settings. See [docs/i18n-plan.md](docs/i18n-plan.md).
- [ ] **Pinned messages + DB-editable channel content (seed paridad)** — migrate `prisma/seed.ts` hardcoded content (welcome, foro índice, méritos posts, channel info) to pinned messages and forum posts editable from /admin. See [docs/content-migration-plan.md](docs/content-migration-plan.md).
- [ ] **Forum post parity with chat** — once forums are reintroduced on the relay-only stack, replies should reuse the same NIP-29 message pipeline as chat so reactions, edits, pagination and mentions work inside posts.
- [ ] **WoT admin UI** — data layer is shipped; finish the /admin tab with referente preview, "Refrescar WoT" action, auto-authorized list and manual whitelist overrides. See [docs/wot-and-invite-credits.md](docs/wot-and-invite-credits.md).
- [ ] **Wizard de setup inicial / instance owner desde UI** — remove the `INSTANCE_OWNER_PUBKEY` env hardcode; first authenticated NIP-07 user claims instance ownership, persisted in DB. Improves self-hosting UX.
- [ ] **Browser & PWA notifications + sound (Phase 1.5 of notifications redesign)** — desktop `Notification` API, PWA service worker, Discord-style chime. Foundation in `docs/read-state.md` Phase 1.5 section; gates on the same `isUserWatching` predicate already used for inbox cards. Per-channel mute settings (All / Mentions only / Nothing) ride along.

## ✅ Shipped

### Foundation
- Auth: NIP-07, nsec, NIP-46 bunker (challenge → sign → verify → session).
- Nostr profiles: DB-cached avatar / banner / bio / NIP-05, daily refresh, startup backfill, "Sincronizar desde Nostr" button, per-server nickname override.
- La Crypta design system + relay management.
- Landing page — bilingual ES/EN, responsive.

### Chat
- Schema: Server / Category / Channel / Message / Member / Ban / Mute / Warning / Report / Session.
- Real-time via Socket.io: message CRUD, reactions, threads, edits, deletes, typing, error handling, paginated history.
- Rich text: markdown, code blocks + syntax highlighting, spoilers, blockquotes, lists, OG link previews, YouTube embeds.
- Mentions (@user) resolved from Nostr profiles; profile popover on click (avatar, banner, NIP-05, roles, join date).
- Forum channels (list + detail + tags) using the shared `MessageInput`.
- Welcome channel with configurable `welcomeChannelId` + banner.
- Pinned messages (`Message.pinnedAt` + pins panel).
- Message search (Discord-style) — see [docs/search.md](docs/search.md).

### Voice
- Audio, video, and screen sharing over Nostr-signaled WebRTC: `simple-peer` full mesh (4 people, 4 cameras, 1 screen share) plus the mediasoup SFU engine. See [docs/voice/](docs/voice/README.md) and [docs/sfu-system.md](docs/sfu-system.md).

### Uploads & media
- Multi-file upload (paste + drag-and-drop), dynamic image gallery, lightbox with zoom / pan, videos, audio, documents.
- Per-server configurable size limits per mime category.
- Custom emojis per server + shortcode autocomplete (`:name:`) + bilingual emoji picker.
- See [docs/uploads.md](docs/uploads.md).

### Admin & moderation
- Multi-server admin panel with server picker + CRUD of channels / categories / members / invitations.
- Instance owner (global access via `INSTANCE_OWNER_PUBKEY`, can transfer `Server.ownerPubkey`).
- Roles: owner / admin / mod / member — **plus custom roles per server** (`CustomRole` + `MemberCustomRole`, colors / icons / priority, badges).
- **Role-gated channels** (`readRoleIds` / `writeRoleIds`) and **write-locked channels** (`writePermission`: everyone / mod / admin / roles).
- Invite links: create, copy, expire, revoke, join-source tracking (`Member.joinedViaInviteId`).
- WoT auto-registration data layer: `referentePubkey` + `wotEnabled` per server, kind-3 fetch, `isInWot()` gate, `WotEntry` + `WotOverride` models.
- Bans (with required reason), mutes, warnings, reports, audit log with pagination.
- Access Control tab unifying join-mode + WoT + invitations.

### Lightning
- NWC wallet connection, encrypted client-side before persistence.
- Zap users from profile + zap messages with custom amounts or presets.
- See [docs/bitcoin-zaps-nwc.md](docs/bitcoin-zaps-nwc.md).

### Testing & ops
- 146+ Vitest + RTL tests across 47+ files (auth / chat / voice / DM / search / admin / moderation / i18n stores / favicon-badge / read-tracker / mention extractor).
- Docker + Caddy + PostgreSQL self-host deploy (BuildKit cache mounts, Prisma schema copied after `npm ci`).

## 📅 Upcoming

### Fase 1.5 — Admin, moderation & forums (remaining)
- [ ] **Permisos configurables por rol** — editable per-server permission matrix (invite, kick, ban, mute, manage roles, webhooks…).
- [ ] **Server-level access control by role** — private servers visible only to given roles.
- [ ] **Canal tipo `updates` / announcements** — new `Channel.type = 'updates'`; admin-only posts, push notification, pinned in sidebar. Supersedes the older "announcement channels" bullet (it's the same feature).
- [ ] **Channel templates** — Community / Gaming / DAO / Dev-Team presets, custom templates, apply-to-existing server.
- [ ] **Dashboard de estadísticas** — `/admin/stats` for instance owner: storage breakdown, DAU / WAU / MAU, top posters, top channels, DB table sizes; CSV / JSON export.
- [ ] **Moderation panel, multi-server** — scope by server; mods only see / act on servers where they have permissions.
- [ ] **Admin UX polish** — drag-and-drop reorder, inline edit, bulk actions, role-visibility preview, permission-matrix grid.
- [ ] **Member list grouped by role** — sidebar sections by role ordered by `priority`, online counts, offline section collapsible.
- [ ] **`Channel.purpose` enum** — `onboarding | rules | announcements | merit_claim | normal` for purpose-specific widgets (see content-migration-plan).

### Fase 2 — Core features
- [ ] **DMs over Nostr (NIP-17 + legacy NIP-04)** — architecture is built (schema, signer integration, lazy relay-AUTH, rumor fields) but **not shipped**: gated by `DM_FEATURE_ENABLED` in `src/lib/feature-flags.ts` pending NIP-17 signer-lifecycle fixes.
- [ ] **Multi-server onboarding** — screen for users with no servers: join via invite, browse public servers, create new. Creation by any authenticated user (today instance-owner only).
- [ ] **DMs 1-a-1 server-scoped (alternative path)** — if the NIP-17 direction hits a dead end: `DirectConversation` + `DirectMessage` models, REST + `dm:<id>` Socket rooms, inbox in ServerBar, anti-spam via shared-server constraint.
- [ ] **Llamadas directas 1-a-1** — audio / video P2P with signaling via Nostr kind 25050.
- [ ] **Voice — text chat within a voice channel**.
- [ ] **Voice — E2EE over SFU** — mediasoup insertable streams, WebCrypto frame encryption, passphrase or NIP-44 key exchange per channel.
- [ ] **Voice — town hall / moderated mode** — raise-hand queue, grant / revoke speak, concurrent-speakers cap.
- [ ] **Relative links `#{nombre}`** — channel / post / thread autocomplete mirroring mentions; stable placeholders, permission-gated, rename-safe.
- [ ] **Idioma canónico del servidor** — `Server.language` for system messages (independent of per-user UI language).
- [ ] **User-personalised channel view** — sidebar sorted by `lastInteractionAt` + per-user pins + "show all channels" toggle.
- [ ] **Account and data deletion** — settings action, cascade or tombstone user's messages, membership and moderation records.

### Fase 3 — Advanced features
- [ ] **Mute / Block sync via NIP-51 (kind 10000)** — today mute / block is client-side in `localStorage` (`src/store/moderation.ts`); sync via relays with NIP-44 encryption, import existing mute lists from other clients.
- [ ] **Nostr relay-based groups (NIP-29)** — promoted to its own phase, see **Fase 9** below. Working prototype already exists (fiatjaf-style relay groups).
- [ ] **App profiles + Nostr kind-0 editor** — overlay over Nostr, plus a safe kind-0 editor with read → merge → diff preview → confirm → publish.
- [ ] **Export conversations** (JSON / plain text).
- [ ] **Discord-compatible bot API** — subset of REST v10 + Gateway WebSocket + `BotAccount` + snowflake-style ID translation.
- [ ] **Stickers per server** — `ServerSticker` model + `StickerPicker` + admin tab.
- [ ] **Private personal sticker packs over Nostr** — replace the current `localStorage`-only created-sticker list with a user-owned NIP-78 kind `30078` event (`d=obelisk:private-stickers:v1`) whose content is NIP-44 encrypted to the same user pubkey; publish to configured user relays, restore across devices with newest-wins semantics, support deletions and tombstones, validate names and URLs, retain a local cache fallback, and migrate existing personal stickers on first publish.
- [ ] **PDF thumbnails** — deferred, needs `pdfjs-dist` + native canvas in the Docker image.
- [ ] **Compression / transcoding** — deferred, needs `sharp` for images and `ffmpeg-static` for video.

### Fase 4 — Polish & launch
- [ ] **Notifications (remaining phases)** — per-channel settings (All / Mentions-only / Nothing) persisted in `MemberChannelSettings`, server / channel mute durations, browser Notification API when backgrounded, fix `/api/unread` DM count (today it's binary per thread), jump-between-mentions (F7 / Shift+F7).
- [ ] **PWA** — installable, offline, service worker.
- [ ] **Per-server custom themes**.
- [ ] **Mobile responsive audit** — chat / admin / moderation / voice / forum views.

### Fase 5 — Knowledge base with LLM
- [ ] Conversation detector + topic-routing suggestion card (inline, dismissible, cooldown per channel).
- [ ] Thread index — LLM-generated descriptions via Ollama `llama3.2:1b`, mod approval gate.
- [ ] Semantic search over the indexed knowledge base + auto-tagging.

### Fase 6 — Lightning zaps (remaining)
- [ ] Balance in UI + transaction history.
- [ ] Zap with attached message + receive animation.
- [ ] Emoji zaps (⚡=21, 🔥=100, 🚀=500, 💎=1000 sats) + per-channel / per-server leaderboards.
- [ ] NIP-57 zap receipts + zap splits.

### Fase 7 — Obelisk Lite
A zero-learning-curve mobile / web client, intercompatible with Obelisk full (same backend, same API, same DB).
- [ ] React Native / PWA mobile + responsive web.
- [ ] WhatsApp-like onboarding over NIP-07 / nsec / bunker, no Nostr jargon exposed to the user.
- [ ] Channels rendered as "grupos", threads inline, push notifications, QR / link invites.

### Fase 8 — Security audit & code quality
Production hardening. Expand into `docs/security-audit-plan.md` when the work starts.
- [ ] **Frontend security** — XSS audit (markdown, bios, channel names), content sanitization, CSRF / session hijacking review, upload validation (type / size / path / SVG), auth bypass, WebSocket spoofing, rate limiting, `npm audit` + deps review, CSP + HSTS + security headers, manual pentest against staging (OWASP Top 10 for chat apps).
- [ ] **Code quality** — shared UI primitives (Button / Modal / Dialog / Input / Dropdown / Avatar / Tooltip / Badge / Tabs), unified confirm-dialog, reusable hooks (`useSocket`, `usePermission`, `useServerRole`, `usePagination`, `useDebounce`), unified fetch helper, strict TypeScript (`noUncheckedIndexedAccess`), ESLint + Prettier + husky + lint-staged, a11y (ARIA, keyboard nav, contrast, screen readers).
- [ ] **Performance** — lazy routes via `next/dynamic`, virtualization for messages / members / channels, bundle analysis, image optim, DB indexes + N+1 review, cursor-based pagination, debounce / throttle, `React.memo` / `useMemo`, `perMessageDeflate`, profile prefetch, service worker.
- [ ] **Documentation** — `docs/security.md`, `docs/components.md`, `docs/architecture.md`, `CONTRIBUTING.md`, TSDoc on public APIs.

### Fase 9 — Self-hostable Relay + Admin

Pivot/parallel track: Obelisk gains a **bundled NIP-29 relay** that any user can self-host, with an admin panel that ships *with the relay* (not the chat app). The relay becomes a source of truth for groups; Obelisk-the-app becomes one client among many. Hybrid model — Postgres stays for uploads, role matrix, audit, search indexes; relay handles federated group events.

**Open architecture decisions** (resolve before writing tickets):
- Monorepo (`/relay` package alongside `/src`) vs separate repo. Leaning monorepo — shared types, single `docker-compose.yml`.
- Implementation: **khatru** (Go, fiatjaf reference, single binary) vs pure TS (`nostr-relay`). Leaning khatru.
- Initial scope: ship 9.1 core + 9.2 minimum (auth, allow/blocklist, event browser, audit log) before tackling the rest of Fase 9.

#### 9.1 Relay core
- [ ] **Bundled relay binary** (`obelisk-relay`) — single Docker image, single config file, swappable storage adapter (SQLite for solo hosters, Postgres for larger instances).
- [ ] **NIP-29 group support** — kinds 9 (chat), 11 (thread), 12 (reply), 9000–9020 (mod actions), 39000–39003 (group metadata / admins / members / roles).
- [ ] **NIP-42 AUTH** — required for posting; pubkey-gated reads for private groups.
- [ ] **NIP-70 protected events** — relay-only retention, no rebroadcast.
- [ ] **Retention policies** — per-kind TTL, max-events-per-pubkey, max-event-size, max-tags, configurable from admin UI.

#### 9.2 `/admin` panel (ships *with* the relay)
- [ ] **Auth** — challenge → sign with NIP-07 / nsec / NIP-46 bunker, gated by `RELAY_ADMIN_PUBKEYS` env. First-pubkey-claims-ownership wizard if env unset (mirrors the instance-owner story in Fase 1.5).
- [ ] **Dashboard** — events/sec, connected sockets, storage size, top pubkeys by event count, top kinds, AUTH failure rate.
- [ ] **User management** — search by pubkey / npub / NIP-05; per-user ban / mute / read-only / quota override; bulk import allowlist from a "referente" pubkey's kind-3 (reuse the WoT pattern).
- [ ] **Access modes** — open, allowlist-only, blocklist, WoT-gated, paid (NIP-05 verified or LN payment to write).
- [ ] **Group management** — list NIP-29 groups, edit metadata, add/remove admins, force-delete, transfer ownership.
- [ ] **Event browser & moderation** — filter by kind / author / group / time, inspect raw JSON, soft-delete (publish kind 5) or hard-delete from DB, bulk delete by author or group.
- [ ] **Content rules engine** — regex/keyword filters on `content`, max-tag-count, kind allowlist, denylisted-domain detector for embedded URLs.
- [ ] **Rate limits** — events/min per pubkey, connection caps per IP, per-user overrides.
- [ ] **Reports inbox** — relay accepts kind 1984; queue for admin review with action: ignore / mute / ban / delete event.
- [ ] **Audit log** — every admin action signed and stored as a kind-30XXXX replaceable event so it's portable + verifiable across hosts.
- [ ] **Backup / restore** — export all events + admin state to a tarball; import on a new host.
- [ ] **Federation controls** — outgoing publish to mirror relays, blocked-relay list, optional follow-other-relay subscription.

#### 9.3 Obelisk-the-app integration
- [ ] **Per-server backend toggle** — `Server.backend = 'postgres' | 'relay'`; relay-mode servers store `Server.relayUrl` + `Server.groupId` (NIP-29 `h` tag).
- [ ] **`MessageSource` adapter layer** — `MessageArea` / `MessageInput` consume an interface so they don't care whether events come from Socket.io or an NDK relay subscription.
- [ ] **Optional sync bridge** — pump messages between Postgres and relay so existing servers can mirror to a relay without losing the local UX (uploads, reactions, threads).
- [ ] **Self-host wizard update** — `docker-compose.yml` gains a `relay` service; wizard asks "App-only / Relay-only / Both."

#### 9.4 Docs
- [ ] `docs/relay.md` — architecture, config, NIP support matrix.
- [ ] `docs/relay-admin.md` — every admin panel feature with screenshots.
- [ ] `docs/migration-postgres-to-relay.md` — for existing instances opting in.

## 🐛 Known bugs & tech debt

See [docs/known-bugs.md](docs/known-bugs.md).

## 🧪 Test suite

Vitest + React Testing Library, 47+ files / 146+ tests. Covered: auth, channels, messages, DMs, members, search, voice, admin, moderation, i18n, stores, favicon-badge, read-tracker, mention extractor. Pending: multimedia upload tests, WebSocket reconnection + multi-client tests, Playwright E2E flows, load tests, CI pipeline running tests on every PR.

## ⛔ Descoped

- ~~**Activity-based invite credits**~~ — replaced by admin-only invites (Discord model). The UI form in `AccessPanel`, the `/api/servers/:id/invite-credits` endpoint, `lib/invite-credits.ts`, the `InviteCreditsCard` profile widget, and the enforcement in `POST /api/servers/:id/invitations` were all removed. The `minDaysActive`, `minMessages`, `invitesPerUser`, `inviteExpiryHours` columns on `Server` are kept to preserve data but are no longer read or written.
- ~~**Vercel + Neon deployment**~~ — replaced by self-hosted Docker + Caddy + PostgreSQL. See [DEPLOY.md](DEPLOY.md).
- ~~**Socket.io relocation (Railway / Fly.io / Pusher)**~~ — no longer needed; Socket.io runs inside the custom `server.ts` and ships with the Docker image.
