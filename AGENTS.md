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
Voice (mesh)      P2P WebRTC, Nostr-signaled (kinds 20078 / 25050) — src/lib/voice/peer.ts
Voice (SFU)      mediasoup engine, Nostr-RPC signaling (kind 25050 envelopes) — src/lib/voice/sfu-client.ts (server: obelisk-app/obelisk-sfu)
Payments          Nostr Wallet Connect (NIP-47) — src/lib/wallet/
```

## Stack
- **Next.js 16** + TypeScript + Tailwind CSS v4 (purely client-rendered — no API routes)
- **nostr-tools** — `SimplePool`, `BunkerSigner`, `finalizeEvent`, NIP-04/NIP-44 helpers
- **NDK** (Nostr Dev Kit) — used for some helper paths (`getNDK()` in `src/lib/nostr.ts`); **the active login + relay surface is the bridge, not NDK**
- **Zustand** — client-side state (`src/store/chat.ts`, `src/store/notification.ts`, `src/store/voice.ts`, etc.). Identity comes from the bridge, not a Zustand store.
- **Vitest** + **React Testing Library** + **jsdom** — testing

## Project Structure
```
src/
├── app/
│   ├── layout.tsx        # Root layout (La Crypta theme)
│   ├── page.tsx          # Landing page
│   ├── app/              # /app — chat UI lives here
│   │   ├── AppShell.tsx      # Top-level chat shell, gates on useIsLoggedIn
│   │   ├── LoginModal.tsx    # 3 auth methods + QR bunker flow
│   │   ├── ServerRail.tsx    # Relay-list rail
│   │   ├── DMList.tsx        # Direct messages
│   │   ├── SearchBar.tsx
│   │   └── UserPanel.tsx
│   ├── guides/           # Markdown guides + SVG diagrams
│   ├── manifest.ts, robots.ts, sitemap.ts, opengraph-image.tsx
│   └── voice/            # Voice channel surface
├── components/
│   ├── Navbar.tsx        # Landing-page nav (uses bridge identity hooks)
│   ├── ProfileEditor.tsx # kind:0 editor — calls bridge.editUserMetadata
│   ├── chat/
│   │   ├── MemberList.tsx
│   │   ├── MessageContent.tsx, MessageZapModal.tsx
│   │   ├── ProfilePopover.tsx
│   │   └── InvoiceCard.tsx   # BOLT11 invoice payment via local NWC
│   └── voice/            # VoiceRoom, VoiceStatusBar
├── hooks/
│   ├── useIdentity.ts    # Thin facade over bridge hooks
│   └── chat/             # useNostrPresence, useMessageZaps, useVoiceChatPane
├── lib/
│   ├── nostr-bridge/     # ⭐ THE bridge — read this first
│   │   ├── client.ts         # SimplePool wrapper, sessions, subscriptions
│   │   ├── stores.ts         # React hooks: useIsLoggedIn, useGroups, useAdmins, ...
│   │   ├── actions.ts        # Imperative login / publish actions
│   │   ├── cache.ts          # Stale-while-revalidate localStorage cache
│   │   ├── types.ts          # NostrBridge interface, JsGroup/JsMessage/...
│   │   └── index.ts          # Public re-exports
│   ├── nostr.ts          # NDK helpers used outside the bridge (getNDK, formatPubkey, ...)
│   ├── channel-layout.ts # NIP-78 (kind 30078) channel layout
│   ├── relay-branding.ts # Operator-controlled relay branding
│   ├── dm/               # NIP-04 DM cache + relay list resolution
│   ├── wallet/           # NWC client (NIP-47)
│   ├── blossom.ts        # Blossom (BUD-01) image upload
│   ├── nip98.ts          # NIP-98 HTTP auth (signed Authorization headers)
│   └── voice/            # Voice room utilities
├── store/                # Zustand stores (chat, notification, voice, dm, ...)
└── test/setup.ts         # Vitest + jsdom setup
```

The `prisma/`, `server.ts`, and `src/app/api/` directories from the legacy stack are gone. References to `useAuthStore`, `restoreSession`, `syncProfile`, `/api/auth/*`, `/api/members/*` are no longer in the tree — if you find one, it slipped through and should be removed.

## Commands
```bash
npm install          # Install dependencies
npm run dev          # Dev server at localhost:3000 (no Socket.io)
npm run build        # next build (no Prisma steps)
npm run test         # Run all tests once
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
```

## Deployment discipline

- Production runs from `/root/obelisk-dex`; never build or restart it when deploying test.
- Test runs from the single persistent `/root/obelisk-dex-test` directory on port 3002. Reuse it in place.
- **Never create timestamped, versioned, or disposable `/root/obelisk-dex-test-release-*` directories.**
- Preserve the test directory's `.env*` files and `node_modules` symlink when updating it, then build there and restart the same `obelisk-dex-test` PM2 process.
- Use a temporary directory under `/tmp` if staging is unavoidable, and remove it before finishing.
- Do not deploy production unless the user explicitly asks.

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

`connect()` opens global REQs at login: group metadata (kind 39000), incoming DMs (kind 4 with `#p` and `authors`), own contact list (kind 3), own kind:0. Per-group REQs are eagerly fired from `ingestGroupMetadata`:

```
ingestGroupMetadata(ev)
├── this.groups.update(...)
├── subscribeGroupMessages(groupId)        — kind 9, #h=groupId
└── subscribeAdminMember(groupId)          — kinds 39001+39002, #d=groupId
```

This is what makes "groups where I am admin" resolve on first paint without the user opening each channel.

## bridgeCache (stale-while-revalidate)

`src/lib/nostr-bridge/cache.ts` is a tiny `localStorage` cache for relay-derived state. Currently wired through admin/member lists (kinds 39001/39002); group metadata, profiles, layout, and branding are TODOs at the call sites. See [docs/data-system.md §8](docs/data-system.md) for the full contract.

## Relay-wide settings authority

- The server-settings gear and relay-wide branding, layout, emoji, and bulk member controls are **operator-only** on desktop and mobile.
- Resolve the human operator through `operatorPubkeyFromRelayInfo()`: prefer a valid NIP-11 `contact` npub, then fall back to the NIP-11 `pubkey`.
- Obelisk relays advertise a service key in `pubkey` and the human operator in `contact`; never gate the human operator UI on `pubkey` alone.
- Do not broaden relay-wide authority to the union of NIP-29 group admins. A channel admin must not gain control of the entire relay.
- Client-side visibility is defense in depth. The relay remains the final authorization boundary for signed NIP-29 moderation commands.

## Voice & video

Two engines, one client surface:

| Mode  | Topology      | Code path                     | When                                     |
|-------|---------------|-------------------------------|------------------------------------------|
| mesh  | P2P full mesh | `src/lib/voice/peer.ts` (`Peer`) | small rooms, no SFU advertised on the channel |
| sfu   | mediasoup SFU | `src/lib/voice/sfu-client.ts` (`SfuClient`) — server lives in [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu) | a kind 31313 advertisement is reachable (or pinned via `NEXT_PUBLIC_SFU_PUBKEY`) + the channel is `voice-sfu` kind |

`VoiceClient` (`src/lib/voice/client.ts`) owns the topology decision (`setSfuMode`) and exposes a single API to the rest of the app — UI components never see the engine. Mesh peers use perfect-negotiation over kind 25050 SDP/ICE blobs; the SFU peer uses mediasoup-client speaking RPC envelopes (`src/lib/voice/sfu-rpc.ts`) on the same kind 25050.

The SFU server is a separate repo: **[obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu)** (mediasoup, Nostr-RPC signaling, allow-list, deploy). Synthetic test peers used to drive it from a Node process live in `scripts/sfu-test-peers/`.

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
| NIP-65 | Relay list metadata | Auto-fetch user relays |
| NIP-78 | Application-specific data | Channel layout (kind 30078) |
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

### Test scope
- **Small, localized changes** (CSS, copy, one isolated component or helper): run only the directly affected test file(s), plus a targeted lint/type/build check when relevant. Do **not** run the full suite by default.
- **Broad or high-risk changes** (bridge/auth/protocol behavior, shared state, cross-cutting refactors, dependency/config upgrades): run the affected tests and the full `npm run test` suite.
- Run the full suite before a release or when the user explicitly requests it.
- If a focused test exposes wider regressions or the impact cannot be isolated confidently, expand the test scope.

> **CRITICAL — NON-NEGOTIABLE RULE:**
> A change is **NOT done** until the appropriately scoped tests are written and passing.
> Tests are part of the implementation, not an afterthought.

## Relays
- **Built-in group relays:** `wss://public.obelisk.ar` (default) and `wss://lacrypta-relay.obelisk.ar`
- **Profile relays (kind:0 / kind:3):** relay.damus.io, relay.nostr.band, nos.lol, relay.primal.net, purplepag.es
- **NostrConnect rendezvous:** relay.nsec.app + the profile relays
- **User relays:** Auto-fetched from NIP-65 (kind 10002) for DM delivery (`fetchMyDmRelays`)

## Resources
- [docs/data-system.md](docs/data-system.md) — login flow, NIP-42 AUTH, watchdog, bridgeCache
- [docs/voice-system.md](docs/voice-system.md) — mesh voice (P2P over Nostr signaling)
- [docs/sfu-system.md](docs/sfu-system.md) — SFU architecture (mediasoup engine, Nostr-RPC signaling)
- [obelisk-app/obelisk-sfu](https://github.com/obelisk-app/obelisk-sfu) — SFU server repo (protocol spec, operator guide, deploy)
- [scripts/sfu-test-peers/README.md](scripts/sfu-test-peers/README.md) — synthetic test peers
- [docs/relay-layout-and-branding.md](docs/relay-layout-and-branding.md) — operator-only shared NIP-78 layout, branding, emojis, and server-settings authorization
- [docs/uploads.md](docs/uploads.md) — Blossom storage + URL format
- [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md) — `npm run dev:tunnel` exposes localhost:3000 at https://obelisk.fabri.lat
- [docs/known-bugs.md](docs/known-bugs.md) — open bugs & tech debt
- [Nostr Protocol](https://nostr.com)
- [NIPs Repository](https://github.com/nostr-protocol/nips)
- [La Crypta](https://lacrypta.ar)
- [ROADMAP.md](ROADMAP.md) — Development roadmap
