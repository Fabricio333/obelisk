# Data system

How Obelisk loads data from relays, what runs first, how connection state
and whitelist rejection surface, and how the local cache fits in.

This doc supersedes the legacy `auth-and-data-loading.md` and
`progressive-loading.md`. Read this together with
[`read-state.md`](./read-state.md), which covers the parallel notification
/ cursor-sync system.

## 1. Architecture in one paragraph

Obelisk is fully Nostr-relay-only. The whole client is a thin shell over
`src/lib/nostr-bridge/client.ts`, which wraps `nostr-tools`' `SimplePool`.
Identity is one of three signer kinds (nsec, NIP-07, NIP-46 bunker). Group
state, members, admins, messages, DMs, and reactions all arrive as NIP-29
/ NIP-04 / NIP-17 events that fan out into a set of `StateStore`s the React
components subscribe to. There is no backend, no Postgres, no session
cookie.

## 2. Login methods

| Method | Signer | Persisted in localStorage | First-publish latency |
|---|---|---|---|
| **NIP-07 extension** | `window.nostr` (Alby, nos2x, …) | `pubKeyHex`, `loginMethod: 'nip07'`, `relayUrl` | ~0 — extension is in-process |
| **nsec (raw key)** | `nostr-tools` `finalizeEvent` | `privKeyHex`, `pubKeyHex`, `loginMethod: 'nsec'`, `relayUrl` | ~0 — local crypto |
| **NIP-46 bunker** | `BunkerSigner` from `nostr-tools/nip46` | `pubKeyHex`, `loginMethod: 'bunker'`, `bunkerUrl`, `bunkerLocalSecretHex`, `relayUrl` | 1-3s — remote signer round-trip |

Bunker has two entry shapes: a `bunker://...` URL (paste flow) and a
`nostrconnect://...` URI (QR flow). Both end up creating the same kind of
`BunkerSigner`; the QR path is `BunkerSigner.fromURI` and keeps a local
secret so the connection survives reload.

## 3. The login → connect contract

All four login entrypoints (`loginWithNsec`, `loginWithNip07`,
`loginWithBunker`, `createNostrConnectSession.waitForConnection`) plus the
page-reload rehydration path in `initialize()` route through the private
`finalizeLogin()`:

```
1. persist()                     // write session to localStorage
2. resetPoolForSessionChange()   // close + rebuild SimplePool with the new session
3. await connect()               // ensureRelay handshake + run the orchestrator
4. isLoggedIn.set(true)          // flip the gate AppShell observes
```

Step 4 is last so `useIsLoggedIn() === true` always implies "the relay
handshake completed and the orchestrator's tier-1 REQs are open." If
`connect()` throws, the gate stays closed and the login modal surfaces
the error.

Inside `connect()`, the handshake itself is a first-response-wins race:

- Per-relay `ensureRelay` timeout: `PER_RELAY_TIMEOUT_MS = 3000`.
- Hard ceiling across all relays: `HARD_CEILING_MS = 1500`.

If at least one relay handshakes within 1500ms the gate flips and slower
relays handshake in the background. Subscriptions registered after that
queue on the pool and bind as each socket comes online.

## 4. Priority tiers (the orchestrator)

`src/lib/nostr-bridge/orchestrator.ts` declares the tier plan, and the
bridge dispatches each action via `dispatchOrchestratorAction`. The
default plan:

| Tier | Action | When | Watchdog | Affects relay-access | Cache |
|---|---|---|---|---|---|
| **P0** | `preflightRelayAccess` (kind 0 `authors:[me]` limit 1) | After `ensureRelay` resolves | 1500ms / 1 attempt; immediate downgrade on `auth-required:`/`restricted:` | yes — authoritative | n/a |
| **P0** | `subscribeGroupMetadata` (39000) | Parallel with preflight | 5000ms / ∞ | yes | yes (write + seed) |
| **P0** | `ensureMyMetadata` (kind 0 for `myPubkey`) | Parallel with preflight | 3000ms / 2 | no | yes (write + seed) |
| **P1** | Active channel: kind 9 `limit:50` + `subscribeAdminMember(activeId)` + kind 7 reactions | On `setActiveGroup` | 5000ms / ∞; reactions 3000ms / 2 | no | n/a / yes / no |
| **P2** | Background channels: kind 9 `limit:50` via `queueGroupMessages` drain (4 per 80ms) | After `ingestGroupMetadata` per group | 5000ms / ∞ | no | no |
| **P2** | `subscribeAllAdminMember` (relay-wide 39001+39002, no `#d`) — bootstraps layout authors | After P0 EOSE | 5000ms / ∞ | no | yes (per-group) |
| **P2** | `subscribeIncomingDMs` (kind 4 `#p:[me]` + `authors:[me]`) | After P0 EOSE | 5000ms / ∞ | no | n/a |
| **P2** | `subscribeMyContactList` (kind 3, on PROFILE_RELAYS) | After P0 EOSE | 5000ms / 4 | no | n/a |
| **P2** | `subscribeMyMuteList` (kind 10000) | After P0 EOSE | 5000ms / 4 | no | n/a |
| **P2** | `subscribeMyAuthoredGroups` (kind 9007 `authors:[me]`) | After P0 EOSE | 5000ms / ∞ | no | yes (per-group) |
| **P2** | `subscribeActiveCalls` (kind 31314) | After P0 EOSE | 5000ms / ∞ | no | no |
| **P0** | Read-state relay-sync, **groups scope** (kind 1059 `#p:[me]`, ACTIVE relay only) | As soon as `myPubkey` + `activeRelay` + first group are known — fires before messages paint so unread badges don't flash | 5000ms / ∞ | no | yes |
| **P2** | Read-state relay-sync, **DM scope** (kind 1059 `#p:[me]`, NIP-65 read+write union) | After NIP-65 list resolves (cross-relay; the only background fanout we tolerate) | 5000ms / ∞ | no | yes |
| **P3** | Per-group `subscribeAdminMember(id)` | On first `useAdmins`/`useMembers` mount | 5000ms / 4 | no | yes |
| **P3** | Per-pubkey kind 0 | On first `ensureUserMetadata` | 3000ms / 2 | no | yes |

Implementation notes:
- P0 actions are dispatched synchronously inside `connect()` (in the same
  microtask). P2 actions are dispatched on `queueMicrotask`, so their
  WebSocket frames go out strictly after P0 frames.
- Read-state relay-sync is split: the **groups scope** (active relay
  only) fires unconditionally — it must land before messages paint so the
  unread badges don't flash on then off when cursors arrive. The **DM
  scope** (NIP-65 read+write union) is still gated by `useReadyToSync()`
  in `src/lib/read-state/root.tsx`. See [`read-state.md`](./read-state.md).
- **Architectural rule — single-relay groups, cross-relay DMs:**
  every background subscription except DMs and DM-state sync runs on
  `this.relays = [activeRelay]` only. Fanning a non-DM REQ across
  `useConfiguredRelays()` opens sockets to whitelist-gated relays the
  user hasn't AUTH'd against, leaks pubkey via the NIP-42 challenge, and
  produces the `Tried to send AUTH on a closed connection` loop. If you
  add a new background sub, it goes on the active relay. Future in-OS
  notifications (browser Notification API / service-worker push) are
  DM-only too.
- `pendingResubscribe` (per-group REQs that were live on the previous
  pool) is applied at the end of the P2 microtask via
  `applyPendingResubscribe`, with the active group bumped to the head of
  the queue.

`subscribeAllAdminMember` deliberately stays — its single relay-wide REQ
seeds the layout-author set used by NIP-78 channel-layout queries. See
[`relay-layout-and-branding.md`](./relay-layout-and-branding.md).

## 5. Whitelist preflight

`preflightRelayAccess()` fires `{kinds:[0], authors:[me], limit:1}` on the
active relay with these `subscribeWatched` options:

```
watchdogMs: 1500
maxAttempts: 1
affectsRelayAccess: true
immediateAccessDowngrade: true
```

`immediateAccessDowngrade` is new: when the preflight sub closes with an
`auth-required:` or `restricted:` reason, `setRelayAccess(url, state)`
runs directly instead of going through `setRelayAccessDeferred` (the
default 4s soak that absorbs transient AUTH races for the rest of the
fan-out). The user sees the whitelist banner within ~1.5s.

EOSE on the preflight filter is harmless (the relay just doesn't have
the user's kind 0 yet) and flips `relayAccess` to `'ok'` via the
standard onevent/oneose path.

`switchRelay` resets the pool and re-runs `connect()`, so the preflight
fires for the new relay automatically.

## 6. Connection state

`BridgeImpl.connectionState: StateStore<string>` with values:

- `'Disconnected'` — initial state and after a socket close while the browser is online.
- `'Offline'` — the browser reports no network; cached state stays mounted and retries pause.
- `'Connecting'` — set at `connect()` start.
- `'Connected'` — set after the first relay handshakes.
- `'Error:<message>'` — set on `connect()` throw.

`relay.onclose` flips the state to `'Disconnected'` (or keeps `'Offline'`) and kicks
`reconnectInBackground()` with capped, jittered exponential backoff. Native relay pings detect half-open sockets; browser `online` and visible-tab events wake a pending retry immediately, while `offline` pauses retry traffic.

UI surface: `src/app/app/ConnectionBanner.tsx` mounts above the chat pane
in both shells. Visible when `useIsLoggedIn() === true` AND
`useConnectionState() !== 'Connected'`. Renders a thin red bar with the
state label + detail; unmounts as soon as the connection recovers. The
banner has `data-testid="connection-loss-banner"` and `data-state`.

## 7. NIP-42 AUTH

`BridgeImpl.createPool()` registers `automaticallyAuth(_relayUrl)` with
SimplePool. When a relay sends an AUTH challenge:

1. SimplePool calls the callback with the challenge event template.
2. The callback dispatches by `loginMethod`:
   - **nsec**: `finalizeEvent(template, sk)` — synchronous local crypto.
   - **nip07**: `window.nostr.signEvent(template)` — extension RPC.
   - **bunker**: `await ensureBunkerSigner()` then `signer.signEvent(template)`.
3. SimplePool sends the signed event back as an AUTH frame and retries
   the queued REQ.

The bunker path is special: cold `BunkerSigner.connect()` takes 1-3s, so
`initialize()` pre-warms the bunker signer fire-and-forget before
`connect()` runs. `bunkerSignerReady` (a `StateStore<boolean>`) tracks the
warm state; `useSignerReady()` derives `loggedIn && (loginMethod !== 'bunker' || bunkerSignerReady)`.

## 8. Watchdog tunables

`subscribeWatched` wraps `pool.subscribe` with a per-sub watchdog. If
neither EVENT nor EOSE arrives within `watchdogMs`, the sub is closed and
re-issued with exponential backoff (1s / 2s / 4s / 8s, capped at 30s).

| Path | watchdogMs | maxAttempts | Worst-case wait |
|---|---|---|---|
| **Preflight** (kind 0 `authors:[me]`) | 1500 | 1 | ~1.5s |
| Group metadata (39000) | 5000 | ∞ | unbounded |
| Group messages (kind 9, `#h`) | 5000 | ∞ | unbounded |
| Admin/member (39001+39002, `#d`) | 5000 | ∞ | unbounded |
| Relay-wide admin/member | 5000 | ∞ | unbounded |
| Incoming DMs (kind 4) | 5000 | ∞ | unbounded |
| Own contact list (kind 3) | 5000 | 4 | ~27s |
| Mute list (kind 10000) | 5000 | 4 | ~27s |
| Authored groups (kind 9007) | 5000 | ∞ | unbounded |
| Active calls (kind 31314) | 5000 | ∞ | unbounded |
| Read-state sync (kind 1059) | 5000 | ∞ | unbounded |
| **kind 0 metadata** | 3000 | 2 | ~6s |
| **Reactions** (kind 7, `#h`) | 3000 | 2 | ~6s |

Per-channel and per-pubkey subs (group messages, admin/member, kind 0,
reactions) use `affectsRelayAccess: false` so a normal "you can't read
this one" CLOSED doesn't flip the relay-wide banner.

## 9. bridgeCache (stale-while-revalidate)

`src/lib/nostr-bridge/cache.ts` is a small `localStorage`-backed cache. Startup indexes all required kinds in one storage scan and batches StateStore hydration by data type.
Keyed by `obelisk-cache-v3/<relay>/<kind>/<id>` with a `{ v, t }` payload.
No TTL — relays are the source of truth and `created_at`-newest-wins
replaces entries through `cacheSet`.

| Wired through cache | Writer | Seed reader |
|---|---|---|
| 39000 (group metadata) | `client.ts:ingestGroupMetadata` | `seedCacheForRelay` |
| 39001 (admin lists) | `client.ts:ingestAdminMember` | `seedCacheForRelay` |
| 39002 (member lists) | `client.ts:ingestAdminMember` | `seedCacheForRelay` |
| 9007 (group creators) | `client.ts:ingestGroupCreator` | `seedCacheForRelay` |
| 0 (user metadata) | `client.ts:ingestUserMetadata` | `seedCacheForRelay` (≤500 pubkeys) |
| 30078 layout | `channel-layout.ts:subscribeLayout` | self-seeds via `cacheGet` |
| 30078 branding | `relay-branding.ts:subscribeBranding` | self-seeds via `cacheGet` |

Invalidation is explicit only:
- `cacheClearAll()` runs on logout — wipes every `obelisk-cache-v3/*` key.
- `cacheDelete(relay, kind?, id?)` for surgical removal.
- The Preferences-panel "Clear cache" button calls
  `clearAllClientCacheExceptSession()` (see §11).

Cache is **never** invalidated on relay switch — caches for the previous
relay stay on disk and re-paint instantly on switch-back.

## 10. UI loading states

These mirror the priority order so the user always sees the highest-tier
data load first.

| Surface | Loading state | Source signal |
|---|---|---|
| Sidebar header banner | `lc-banner-placeholder` div in fixed-aspect slot, then real image fades in | `branding.updatedAt > 0` |
| Sidebar header title | `lc-skeleton` for up to 1500ms grace, then `branding.name \|\| shortHost(relay)` | `branding.updatedAt > 0` OR grace timer |
| Sidebar channel list (empty) | `lc-spinner` + "Loading channels…" → "No channels on this relay yet." | `groupMetadataEose` |
| Chat pane (no group) | "Loading channel info…" with `lc-spinner` | `!group && !groupMetadataEose` |
| Chat pane (group, no messages) | "Loading messages…" with `lc-spinner` | `group && !messagesEose` |
| Chat pane → "Load earlier" on scroll-to-top | `useLoadEarlier` returns `false` once `reachedStart` | scroll listener at top of `messagesRef` |
| Members panel (desktop) | `lc-spinner` + "Loading members…" | `useMembershipReady(groupId)` |
| Members screen (mobile) | `lc-spinner` + "Loading members…" → "No members" | `useMembershipReady(groupId)` |
| `ConnectionBanner` | always visible while `loggedIn && connectionState !== 'Connected'` | `useConnectionState()` |
| `RelayAccessBanner` | visible when `relayAccess !== 'ok'` (preflight or normal subs) | `useRelayAccess()` |

Each loader has a stable `data-testid` so the Playwright specs can assert
paint order — see [`testing-strategy`](#13-test-coverage).

## 11. "Clear local cache" semantics

The Preferences panel exposes a "Clear local cache" button backed by
`clearAllClientCacheExceptSession()` (`src/lib/nostr-bridge/cache-clear.ts`).

**Wiped** (prefix scans):
- `obelisk-cache-v3/*`, `obelisk-cache-v2/*`, `obelisk-cache/*`
- `obelisk:relay-info-v3` and legacy `v2` (NIP-11 cache singleton)
- `obelisk-read-state:*`, `obelisk-dm-store:*`, `obelisk-forum-follow:*`
- `obelisk-dex/forum-collapsed/*`, `obelisk-dex/mobile-setup-seen/*`,
  `obelisk-dex/just-generated/*`
- `obelisk:voice-chat-width`

**Preserved**:
- `obelisk-dex/session` — the active session.
- `obelisk-dex/relays` — the configured relay list.
- `obelisk:preferences` — settings the user just chose.

After the wipe, the page reloads via `window.location.reload()`. The next
paint re-fetches every store from the relay through the orchestrator's
P0/P2 fan-out.

## 12. Manual verification

For each login method, clear localStorage then:

1. **NIP-07 extension** — log in → sidebar populates within ~2s; gear icon
   on owned channels visible on **first** paint, no refresh needed. Reload
   → sidebar paints instantly from cache before the relay round-trip
   completes.
2. **nsec** — paste a key with admin rights on a known channel → admin
   badge visible immediately. Reload → admin badge from cache, instant.
3. **Bunker URL** — paste `bunker://…@relay.nsec.app/?secret=…`, approve in
   the remote signer → channel list + admin status appear without refresh.
   Reload → bunker pre-warm fires; first AUTH challenge completes in <3s.
4. **Slow relay** — DevTools → Network → "Slow 3G" — repeat (1)–(3).
   Verify: channel-menu spinner is visible first; banner is a transparent
   placeholder until branding lands; chat pane shows "Loading channel
   info…" then "Loading messages…"; member panel shows "Loading members…".
   No empty-sidebar flash, no layout shift when the banner image arrives.
5. **Whitelist preflight on a restricted relay** — point a fresh nsec at
   `wss://relay.obelisk.ar`; assert `RelayAccessBanner` flips to
   `data-state="restricted"` within ~1.5s. No 4s soak.
6. **Connection loss** — disconnect Wi-Fi mid-session;
   `ConnectionBanner` appears within 1s. Reconnect — banner disappears.
7. **Preferences → Clear cache** — confirm; reload; sidebar paints from a
   clean cache. Session and preferences preserved.

## 13. Test coverage

| File | Covers |
|---|---|
| `src/lib/nostr-bridge/cache.test.ts` | round-trip, isolation by relay/kind, prefix-wipe deletion, JSON corruption resilience, kind 0 shape |
| `src/lib/nostr-bridge/cache-clear.test.ts` | every prefix is wiped, session + preferences preserved, idempotent |
| `src/lib/nostr-bridge/orchestrator.test.ts` | P0 actions sync, P2 deferred to next microtask, custom plan honored, default plan locked-in |
| `src/lib/nostr-bridge/preflight.test.ts` | preflight REQ fires, CLOSED restricted/auth-required flips access within ~50ms, EOSE flips to 'ok', no retry on maxAttempts=1 |
| `src/lib/nostr-bridge/bridge.test.ts` | end-to-end ingest/subscribe behavior; deferred soak still holds for non-preflight subs |
| `src/lib/nostr-bridge/login-race.test.ts` | Fix A (`isLoggedIn` flips after `connect`), Fix B (eager admin/member sub on group discovery), Fix C (bunker pre-warm), Fix D (admin list persisted through `cacheSet`) |
| `src/lib/nostr-bridge/optimistic-send.test.ts` | local echo + relay-confirmed reconciliation |
| `src/lib/nostr-bridge/relay-auth-state.test.ts` | relay-access state transitions, sticky-OK, deferred soak |

Playwright E2E coverage of paint order, transparent banner, members
loading, whitelist rejection, connection loss, cache reuse, and clear-cache
lives under `scripts/e2e/`. See [§14](#14-playwright-e2e).

## 14. Playwright E2E

Specs run via `npm run test:e2e` against a local dev server (the harness
defaults to `localhost:3001`, matching `ecosystem.config.js`; `npm run
dev` serves `:3000`, so set `OBELISK_E2E_BASE_URL` or run dev with
`PORT=3001` — see `scripts/e2e/README.md` for the full port story)
talking to real relays.

| Spec | What it asserts | Relay |
|---|---|---|
| `login-and-send.spec.ts` | smoke: login → find channel → publish | `wss://public.obelisk.ar` |
| `paint-order.spec.ts` | channel-menu spinner → channel rows → chat spinner → chat content | `wss://public.obelisk.ar` |
| `transparent-banner.spec.ts` | `lc-banner-placeholder` before branding, image after | `wss://public.obelisk.ar` |
| `members-loading.spec.ts` | "Loading members…" until 39002 ingest | `wss://public.obelisk.ar` |
| `whitelist-rejection.spec.ts` | preflight surfaces `RelayAccessBanner[data-state="restricted"]` within ~3s | `wss://relay.obelisk.ar` (restricted; configurable via `OBELISK_E2E_RESTRICTED_RELAY`) |
| `connection-loss.spec.ts` | banner appears on socket drop, disappears on recovery | `wss://public.obelisk.ar` |
| `cache-second-load.spec.ts` | reload paints first channel row within 1500ms of `navigationStart` | `wss://public.obelisk.ar` |
| `clear-cache.spec.ts` | Preferences → Clear cache wipes the right keys, preserves session | `wss://public.obelisk.ar` |
| `read-state-convergence.spec.ts` | two contexts, same nsec → cursor converges within 12s | `wss://public.obelisk.ar` |

Per-spec retries: 1. Each spec uses `attachClientCapture` (see
`scripts/e2e/lib.ts`) to dump WebSocket frames on failure for debugging.
