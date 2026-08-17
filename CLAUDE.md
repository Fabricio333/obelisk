# AGENTS.md — Obelisk

You are building **Obelisk**, a Discord-like group chat app where identity comes from Nostr keypairs. No emails, no passwords — cryptographic identity only.

See [ROADMAP.md](ROADMAP.md) for the development plan.

## Architecture

Obelisk is **fully Nostr-relay-only**. There is no backend, no Postgres, no API routes, no Socket.io server. The whole app is a thin React shell over a `nostr-tools` `SimplePool` wrapped by `src/lib/nostr-bridge/client.ts`. Group state, members, admins, messages, DMs, and reactions are all NIP-29 / NIP-04 / NIP-17 events delivered straight from the relay to the client.

```
Frontend          Next.js 16 + Tailwind v4 (La Crypta UI)
Auth              Nostr (NIP-07 / nsec / NIP-46 bunker)
Bridge            src/lib/nostr-bridge/ — SimplePool + nostr-tools singleton
Group protocol    NIP-29 (kinds 9, 9000-9007, 39000-39002)
DMs               NIP-04 (kind 4) — see src/lib/dm/
Cache             localStorage stale-while-revalidate (src/lib/nostr-bridge/cache.ts)
Voice (mesh)      P2P WebRTC, Nostr-signaled (kinds 20078 / 25050) + per-pair `obelisk-control` data channel (heartbeat, fast hangup, transitive discovery) — see docs/voice/
Voice (SFU)      mediasoup engine, Nostr-RPC signaling (kind 25050 envelopes) — src/lib/voice/sfu-client.ts (server: obelisk-app/obelisk-sfu)
Payments          Nostr Wallet Connect (NIP-47) — src/lib/wallet/
```

## Stack
- **Next.js 16** + TypeScript + Tailwind CSS v4 (purely client-rendered — no API routes)
- **nostr-tools** — `SimplePool`, `BunkerSigner`, `finalizeEvent`, NIP-04/NIP-44 helpers. This is the only Nostr client in the running code path.
- **@nostr-wot/data** + **@nostr-wot/ui** — WoT-aware profile/follow hooks (`useProfile`, `useFollows`, `usePubkey`, `formatPubkey`, `hexToNpub`) consumed by the rail / search / DM list. Orthogonal to the bridge — the bridge owns identity + relay subs; nostr-wot owns WoT scoring + profile cache.
- **Zustand** — client-side state under `src/store/` (chat, dm, voice, notifications, read-state, moderation, multi-account, toast, locale, messageZap). Identity is NOT a Zustand store — it lives on the bridge.
- **Vitest** + **React Testing Library** + **jsdom** — testing
- **NDK** is in `package.json` for historical reasons but is **not imported anywhere in `src/`** — do not reach for it when adding features.

## Project Structure
```
src/
├── app/                          # Next.js App Router
│   ├── layout.tsx                # Root layout (La Crypta theme)
│   ├── page.tsx                  # Landing page
│   ├── app/                      # /app — chat surface
│   │   ├── page.tsx                # Mounts <AppGate />
│   │   ├── AppGate.tsx             # Viewport-based switch: desktop or mobile shell (`useIsMobile`)
│   │   ├── DesktopShell.tsx        # Desktop chat shell (default export named AppShell)
│   │   ├── mobile/                 # Phone shell + per-screen views
│   │   │   └── PhoneShell.tsx
│   │   ├── LoginModal.tsx          # 3 auth methods + QR bunker flow
│   │   ├── RelayStatusBanner.tsx   # Unified connection + access banner
│   │   ├── ServerRail.tsx          # Relay-list rail
│   │   ├── DMList.tsx, DMComposer.tsx
│   │   ├── SearchBar.tsx
│   │   └── UserPanel.tsx
│   ├── guides/                   # Markdown guides + SVG diagrams
│   ├── r/[code]/                 # Per-relay branded share-link routes
│   ├── voice/                    # Voice channel surface
│   ├── manifest.ts, robots.ts, sitemap.ts, opengraph-image.tsx
├── components/
│   ├── Navbar.tsx, Footer.tsx, LandingPage.tsx, Showcase.tsx
│   ├── ProfileEditor.tsx           # kind:0 editor — `bridge.editUserMetadata`
│   ├── ActivityIndicator.tsx, ToastStack.tsx, ModalShell.tsx
│   ├── BlossomImageInput.tsx, UserAvatar.tsx, ObeliskIcon.tsx
│   ├── ShootingStars.tsx, LanguageToggle.tsx, FAQItem.tsx, SdkSessionBridge.tsx
│   ├── admin/                       # RelayAdminPanel
│   ├── chat/                        # MemberList, MessageContent, MessageZapModal,
│   │                                 # ForumView, ProfilePopover, InvoiceCard,
│   │                                 # EmojiPicker, MentionAutocomplete/Navigator,
│   │                                 # LinkPreview, CodeBlock, SpoilerText, WotBadge, …
│   ├── guides/                      # ArticleShell, GuideCard, Callout, …
│   ├── settings/                    # Account / relay / appearance panels
│   └── voice/                       # VoiceRoom, VoiceStatusBar
├── hooks/
│   ├── useIdentity.ts             # Thin facade over bridge identity hooks
│   ├── useAutoMarkRead.ts, useClickOutside.ts, useCopyToClipboard.ts
│   ├── useDebouncedCallback.ts, useFaviconBadge.ts
│   └── chat/                      # useNostrPresence, useMessageZaps, useVoiceChatPane
├── lib/
│   ├── nostr-bridge/              # ⭐ THE bridge — read this first
│   │   ├── client.ts                # SimplePool wrapper, sessions, subscriptions
│   │   ├── stores.ts                # React hooks: useIsLoggedIn, useGroups, useAdmins, …
│   │   ├── actions.ts               # Imperative login / publish actions
│   │   ├── orchestrator.ts          # P0/P2 tier plan + dispatcher
│   │   ├── cache.ts                 # Stale-while-revalidate localStorage cache
│   │   ├── cache-clear.ts           # Sweep for "Clear cache" UX
│   │   ├── relay-url.ts             # normalizeRelayUrl + validation
│   │   ├── types.ts                 # NostrBridge interface, JsGroup/JsMessage/…
│   │   └── index.ts                 # Public re-exports
│   ├── channel-layout.ts          # NIP-78 (kind 30078) channel layout + operator pubkey
│   ├── relay-branding.ts          # Operator-controlled relay branding (kind 30078)
│   ├── relay-info.ts              # NIP-11 fetcher (relay name, icon, operator pubkey)
│   ├── relay-share-link.ts        # /r/<code> share-link encoder/decoder
│   ├── nip-kinds.ts, nip-59.ts, nip98.ts  # Protocol helpers
│   ├── mentions.ts, markdown.ts, emoji-shortcodes.ts, remark-spoiler.ts
│   ├── attachments.ts, blossom.ts, bolt11.ts
│   ├── group-search.ts, guides.ts, guide-urls.ts
│   ├── i18n.ts, json-safe.ts, local-store.ts, promise.ts, preferences.ts
│   ├── activity-log.ts, favicon-badge.ts, recent-emojis.ts, read-gates.ts
│   ├── reset.ts                   # `resetAllClientState()` — login/logout teardown
│   ├── dm/                        # NIP-04 DM cache + relay-list resolution
│   ├── wallet/                    # Nostr Wallet Connect (NIP-47)
│   ├── voice/                     # Mesh + SFU client (`client.ts`, `peer.ts`, `sfu-client.ts`)
│   ├── wot/                       # Web-of-trust engine + colors
│   ├── read-state/                # Read-state store + relay-sync (NIP-59 gift wrap)
│   ├── notifications/             # Notification selectors (mentions vs DMs)
│   ├── hooks/                     # Bridge-internal hook utilities
│   ├── server/                    # Server-side helpers (currently OG image)
│   ├── nostr-hooks.ts, nostr-pool.ts, nostr-read.ts  # Legacy thin wrappers
├── store/                         # Zustand stores (chat, dm, voice, notifications,
│                                   # read-state, multi-account, moderation,
│                                   # locale, toast, messageZap, …)
└── test/setup.ts                  # Vitest + jsdom setup
```

The `prisma/`, `server.ts`, and `src/app/api/` directories from the legacy stack are gone. References to `useAuthStore`, `restoreSession`, `syncProfile`, `/api/auth/*`, `/api/members/*` are no longer in the tree — if you find one, it slipped through and should be removed.

The chat shell entry point is `AppGate.tsx` (mounted by `app/page.tsx`); it picks between `DesktopShell` and `mobile/PhoneShell` based on `useIsMobile()`. Both shells observe `useIsLoggedIn()` and render the same store-fed UI.

## Commands
```bash
npm install          # Install dependencies
npm run dev          # Dev server at localhost:3000 (no Socket.io)
npm run build        # next build (no Prisma steps)
npm run test         # Run all tests once
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

## Auth (3 methods, all relay-only)

See [docs/data-system.md](docs/data-system.md) for the complete contract.

| Method | Signer | Login entry |
|---|---|---|
| **NIP-07 extension** | `window.nostr` | `bridge.loginWithNip07(pubkeyHex)` |
| **nsec** | `finalizeEvent(template, sk)` | `bridge.loginWithNsec(privKeyHex, pubKeyHex)` |
| **NIP-46 bunker** | `BunkerSigner` (nostr-tools/nip46) | `bridge.loginWithBunker(bunkerUrl)` or `bridge.createNostrConnectSession()` (QR) |

All four entrypoints (and the page-reload rehydration in `initialize()`) route through the private `finalizeLogin()`:

```
1. persist()                       — write session to localStorage
2. resetPoolForSessionChange()     — fresh sockets so NIP-42 AUTH renegotiates
3. await connect()                 — relay handshake + open global subscriptions
4. isLoggedIn.set(true)            — flip the gate AppShell observes
```

`isLoggedIn` is the contract for "AppShell can mount the chat UI" — it implies relay handshake completed and global REQs are open.

## Data subscriptions

`connect()` runs the priority orchestrator (`src/lib/nostr-bridge/orchestrator.ts`). Two tiers leave the wire in strict order:

- **P0** (same microtask): whitelist preflight (kind 0 `authors:[me]` limit 1), group metadata (kind 39000), own kind 0.
- **P2** (next microtask): relay-wide admin/member (kinds 39001+39002, no `#d`), incoming DMs (kind 4 with `#p` and `authors`), own contact list (kind 3), mute list (kind 10000), authored groups (kind 9007), active calls (kind 31314).

`ingestGroupMetadata` fans out per-group work for every discovered channel:

```
ingestGroupMetadata(ev)
├── this.groups.update(...)
├── queueGroupMessages(groupId)        — kind 9, #h=groupId (deferred batch drain, active channel jumps the queue)
└── subscribeGroupCreator(groupId)     — kind 9007, #h=groupId (one-shot, for the WoT exemption + lazy admin-claim)
```

Per-group admin/member (`subscribeAdminMember`) is **not** fired here — the relay-wide P2 sub covers it. The lazy per-group sub on `useAdmins` / `useMembers` mount is idempotent and serves as a fallback.

### Single-relay rule for groups; cross-relay only for DMs

**Groups bind to the active relay. Only DMs run cross-relay.** This is the
load-bearing rule that keeps the bridge from leaking pubkey via NIP-42 AUTH
challenges to relays the user isn't browsing, and keeps background work
predictable:

| Subscription                      | Scope                                      |
|----------------------------------|--------------------------------------------|
| Group metadata / messages / reactions / admin / member (kinds 9, 39000, 39001, 39002, 7, 9007) | **Active relay only** (`this.relays = [activeRelay]`) |
| Group read-state cursors (NIP-59 wraps over kind 30078) | **Active relay only** — `startGroupsRelaySync(activeRelay, ids)` in `src/lib/read-state/root.tsx` |
| Mention notifications (kind 9 `@you`) | **Active relay only** — scanned solely while that relay is active; cards are stamped with it and cached per relay (`src/store/notifications.ts`) |
| DMs (kind 4) | **NIP-65 read+write union** of the user's relay list |
| DM read-state cursors + `inboxLastReadAt` (NIP-59 wraps) | **NIP-65 read+write union** |
| Voice signaling / SFU RPC (kinds 25050, 31313, 31314) | Per-channel relay set (mesh: active relay; SFU: pinned trust set) |

Publishing has one extra rule that reads do not, because a publish rides an
**authenticated** socket:

| Publish | Scope |
|---|---|
| NIP-17 gift wrap, recipient copy (kind 1059) | **Recipient's kind-10050 inbox only.** Falls to their NIP-65 read set, then — last resort — the active relay. Never a union: see `resolveGiftWrapRelays` and [docs/direct-messages.md](docs/direct-messages.md). |
| NIP-17 gift wrap, self copy (kind 1059) | **Our own inbox only** (`this.relays` ∪ `myDmRelays`), minus any relay that just took the recipient's copy. |
| Own NIP-17 inbox list (kind 10050) | NIP-65 read+write union + active relay, with `authMode: 'never'`. |

Gift wraps publish with `authMode: 'last-resort'` — never volunteer a NIP-42
identity on the socket carrying an ephemeral-keyed envelope. A new
DM-adjacent publish must pick an `authMode` deliberately, not inherit the
default.

When you add a new background subscription, decide upfront which row it
belongs to. If it's not DMs, it goes on the active relay only — never on
`useConfiguredRelays()`. Fanning out across configured relays opens
sockets to whitelist-gated relays the user hasn't authenticated against
and produces the `Tried to send AUTH on a closed connection` loop.

Future: in-OS background notifications (browser Notification API,
service-worker push) are DM-only too. Group mentions only notify while
the user has the group's relay open as the active relay.

**Notifications are two separate streams** — private DMs and group
`@`-mentions — with independent logs and independent read cursors.
Only an explicit mention pings; ordinary channel traffic and
replies-to-you do not. See [docs/read-state.md §2b](docs/read-state.md).

## bridgeCache (stale-while-revalidate)

`src/lib/nostr-bridge/cache.ts` is a small `localStorage` cache for relay-derived state. Each entry pairs an ingest writer (via `cacheSet`, often with an equality guard or a debounce) with a seed reader (`seedCacheForRelay` on bridge construction / login / `switchRelay`).

Currently wired:
- kind 0 (user profiles) — capped iteration on seed (500 pubkeys)
- kind 7 (reactions) — per-channel map, debounced 200ms, capped at `REACTION_CACHE_LIMIT` (500/channel)
- kind 9 (messages) — per-channel list, debounced 200ms, capped at `MESSAGE_CACHE_LIMIT` (50/channel); optimistic placeholders are filtered out before write
- kind 9007 (creators), 39000 (group metadata), 39001/39002 (admin/member lists)
- kind 30078 (NIP-78) — channel layout + relay branding share this kind under different `d`-tags

Deliberately not cached: kind 4 DMs (the DM store keeps its own per-account persistence). See [docs/data-system.md §9](docs/data-system.md) for the full contract.

## Voice & video

Two engines, one client surface:

| Mode  | Topology      | Code path                     | When                                     |
|-------|---------------|-------------------------------|------------------------------------------|
| mesh  | P2P full mesh | `src/lib/voice/peer.ts` (`Peer`) | small rooms, no SFU advertised on the channel |
| sfu   | mediasoup SFU | `src/lib/voice/sfu-client.ts` (`SfuClient`) — server lives in [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu) | a kind 31313 advertisement is reachable (or pinned via `NEXT_PUBLIC_SFU_PUBKEY`) + the channel is `voice-sfu` kind |

`VoiceClient` (`src/lib/voice/client.ts`) owns the topology decision (`setSfuMode`) and exposes a single API to the rest of the app — UI components never see the engine. Mesh peers use perfect-negotiation over kind 25050 SDP/ICE blobs; the SFU peer uses mediasoup-client speaking RPC envelopes (`src/lib/voice/sfu-rpc.ts`) on the same kind 25050.

The SFU server is a separate repo: **[obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu)** (mediasoup, Nostr-RPC signaling, allow-list, deploy). Synthetic test peers used to drive the SFU now live in that repo under `scripts/test-peers/` and can be spawned manually OR via the SFU's admin UI (`/admin` → "Spawn test peer").

## Design System (La Crypta)
- **Background:** `lc-black` (#0a0a0a) with subtle grid pattern
- **Cards:** `lc-dark` (#171717) with `lc-border` (#262626), 12px radius
- **Accent:** `lc-green` (#b4f953) — lime green for active states, CTAs
- **Text:** `lc-white` (#fafafa), `lc-muted` (#a3a3a3)
- **Buttons:** Pill-shaped (9999px radius) — `lc-pill-primary` / `lc-pill-secondary`
- **CSS classes:** `lc-card`, `lc-glow`, `lc-spinner`, `lc-skeleton`, `lc-img-skeleton`

## Key NIPs Used

| NIP | What | Usage |
|-----|------|-------|
| NIP-01 | Basic events & profiles | Profile data (kind 0) |
| NIP-04 | Direct messages | DMs (kind 4) |
| NIP-07 | Browser extension signer | Login method |
| NIP-29 | Simple groups | Channels (kinds 9, 9000-9007, 39000-39002) |
| NIP-42 | Authentication of clients to relays | Auto-auth via `automaticallyAuth` callback |
| NIP-46 | Nostr Connect (bunker) | Login method with QR |
| NIP-05 | DNS-based verification | Display verification status |
| NIP-46 | Nostr Connect (bunker) | Remote signer login |
| NIP-50 | Search | `bridge.searchMessages` |
| NIP-59 | Gift wrap (kind 1059) | Encrypted multi-device read-state sync (`src/lib/nip-59.ts`, `src/lib/read-state/relay-sync.ts`) |
| NIP-65 | Relay list metadata | Auto-fetch user relays; DM-state sync targets the NIP-65 read+write union |
| NIP-78 | Application-specific data | Channel layout (kind 30078); also the inner rumor kind for NIP-59-wrapped read state |
| NIP-98 | HTTP authentication | Blossom upload-auth |

## Development Guidelines

### When coding:
- Identity comes from the bridge (`useIsLoggedIn`, `useMyPubkey`, `useSignerReady`, `useUserMetadata`). **Do NOT introduce a new auth store** or a backend session.
- For new relay-derived data, follow the existing pattern: add a `StateStore` on `BridgeImpl`, an ingest method that respects `created_at`-newest-wins, a `subscribeXxx` method on the bridge interface, and a `useXxx` hook in `stores.ts`.
- Use the `bridgeCache` module for any data that benefits from instant first paint on reload (small, infrequently-changing). Wire `cacheGet` for seed and `cacheSet` for write-through.
- Follow La Crypta design system — use `lc-*` CSS classes and color tokens.
- Add skeleton loading for any new data-fetching component.
- **Always write tests** for new features (see Testing).

### Bridge quick reference
```typescript
import {
  getBridge,
  useIsLoggedIn, useMyPubkey, useSignerReady,
  useGroups, useMessages, useAdmins, useMembers,
  useUserMetadata,
  nostrActions,
} from '@/lib/nostr-bridge';

// In a component:
const myPubkey = useMyPubkey();
const groups = useGroups();
const admins = useAdmins(activeGroupId);

// Imperative publishing:
const bridge = await getBridge();
await bridge.sendMessage(groupId, 'hello');
await bridge.editUserMetadata({ name: 'Alice', displayName: 'Alice' });
```

### LocalStorage conventions

| Data type | Key pattern | Mechanism |
|---|---|---|
| Per-user state (cursors, prefs, follows) | `obelisk-{store}:{myPubkey}` | Zustand `persist` + `ensureXxxForAccount()` helper |
| Relay-derived metadata (lists, layouts, branding) | `obelisk-cache-v3/{relay}/{kind}/{id}` | `bridgeCache` (`src/lib/nostr-bridge/cache.ts`) |
| UI-only state, non-personal | `obelisk-dex/{namespace}/{id}` | direct `localStorage` |
| Per-user UI flags | `obelisk-dex/{flag}/{myPubkey}` | direct `localStorage` |

When adding new persisted per-user state, follow the read-state store as the
canonical example: define a Zustand `persist` store keyed by
`obelisk-{name}` with an `ensureXxxForAccount(pubkey)` helper that swaps the
key on login. Wire the helper into the `PER_ACCOUNT_STORES` array in
`src/lib/read-state/root.tsx` alongside the existing ones. See
[docs/read-state.md](docs/read-state.md) for the full pattern (cursor
model, mention/reply detection, encrypted multi-device sync via NIP-59,
deferred-mount gating), and [docs/data-system.md §9](docs/data-system.md)
for where this sits relative to the bridgeCache.

## Testing

### Stack
- **Vitest** — test runner (configured in `vitest.config.ts`)
- **React Testing Library** — component testing
- **jsdom** — browser environment simulation

### Conventions
- Co-locate test files next to source: `Component.tsx` -> `Component.test.tsx`
- Shared mocks in `src/test/`
- Use `data-testid` attributes for reliable test selectors
- Bridge integration tests use a `FakePool` that mocks `SimplePool` (see `bridge.test.ts`, `login-race.test.ts`). The fake must implement `subscribe`, `publish`, `close`, AND `ensureRelay` because `connect()` awaits the handshake.

### What to test
- **Components:** rendering, skeleton states, interactions, conditional rendering
- **Stores (Zustand):** initial state, actions, persistence
- **Bridge:** subscription lifecycle, ingestion logic, cache integration, login race regressions
- **Lib functions:** pure functions, async with timeouts, error handling

> **CRITICAL — NON-NEGOTIABLE RULE:**
> A feature is **NOT done** until its tests are written, passing, and the full suite runs green.
> Do NOT move on to the next task until `npm run test` passes with the new tests included.
> **No exceptions. Tests are part of the implementation, not an afterthought.**

## Relays
- **Default for groups:** `wss://public.obelisk.ar` (constant `DEFAULT_RELAY` in `src/lib/nostr-bridge/client.ts`, overridable per session)
- **Profile relays (kind:0 / kind:3):** relay.damus.io, relay.nostr.band, nos.lol, relay.primal.net, purplepag.es
- **NostrConnect rendezvous:** relay.nsec.app + the profile relays
- **User relays:** Auto-fetched from NIP-65 (kind 10002) for DM delivery (`fetchMyDmRelays`)

## Resources
- [docs/data-system.md](docs/data-system.md) — priority orchestrator (P0/P1/P2/P3), login → connect contract, whitelist preflight (1.5s, no soak), connection banner, bridgeCache, NIP-42 AUTH, watchdog tunables, UI loading states, "Clear cache" semantics
- [docs/read-state.md](docs/read-state.md) — per-channel and per-DM cursors, the two notification streams (per-relay mentions vs account-wide DMs), mention/reply detection, MentionNavigator, encrypted multi-device sync via NIP-59 gift wrap (groups state per relay; DM state on NIP-65 relays), deferred-mount gating for relay-sync subs
- [docs/voice/](docs/voice/README.md) — mesh voice: protocol, modules, failure modes, testing (P2P WebRTC over Nostr signaling + `obelisk-control` data channel)
- [docs/sfu-system.md](docs/sfu-system.md) — SFU architecture (mediasoup engine, Nostr-RPC signaling)
- [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu) — SFU server repo (protocol spec, operator guide, deploy)
- SFU test peers — moved to obelisk-sfu repo (`scripts/test-peers/` there); spawn from the SFU admin UI
- [docs/relay-layout-and-branding.md](docs/relay-layout-and-branding.md) — shared NIP-78 layout & branding; multi-author latest-wins, gated on group-admin union
- [docs/relay-roles.md](docs/relay-roles.md) — operator-defined tiered roles (NIP-78 kind 30078); highest tier held is the badge shown in chat and the member list
- [docs/dm-metadata-privacy.md](docs/dm-metadata-privacy.md) — why gift-wrapped DMs can still leak the social graph, the ordered relay ladder, AUTH modes, what cannot be fixed client-side, and the rules for changing DM routing
- [docs/uploads.md](docs/uploads.md) — Blossom storage + URL format
- [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md) — `npm run dev:tunnel` exposes localhost:3000 at https://obelisk.fabri.lat
- [docs/known-bugs.md](docs/known-bugs.md) — open bugs & tech debt
- [Nostr Protocol](https://nostr.com)
- [NIPs Repository](https://github.com/nostr-protocol/nips)
- [La Crypta](https://lacrypta.ar)
- [ROADMAP.md](ROADMAP.md) — Development roadmap
