# Read state & notifications

Per-channel and per-DM cursors, mention/reply detection, mention
navigation, and encrypted multi-device sync over NIP-59 gift-wrapped
events. Same code path on mobile and desktop. Local-first; the relay
sync ships on by default for logged-in users.

This doc supersedes the legacy `notifications.md`. Read this together
with [`data-system.md`](./data-system.md) which covers the parallel
data-loading orchestrator.

## 1. Architecture in one paragraph

The bridge's `messagesByGroup` and `dmsByPeer` are the source of truth
for message data; `useNotificationsStore` holds the notification card
logs. Pure selectors derive unread counts and highlights from the
persisted cursor stores. An auto-mark hook advances
cursors when the user is watching a channel/DM. A relay-sync engine
wraps cursor snapshots in NIP-59 gift wraps and publishes them to the
right relays with an 8-second debounce; the same engine subscribes on
each device so cursors converge via monotonic `max()` merge.

```
            ┌─────────────────────────────┐
            │ bridge: messagesByGroup,    │
            │ dmsByPeer                   │ (source of truth, in-memory)
            └────────────┬────────────────┘
                         │
            ┌────────────▼────────────────┐    ┌──────────────────────────┐
            │ pure derived selectors      │◀───│ useReadStateStore        │
            │ useChannelHighlights        │    │ groupCursors, dmCursors, │
            │ useChannelUnreadCount       │    │ inboxLastReadAt          │
            │ useHasAnyHighlights         │    │ (persisted localStorage) │
            └────────────┬────────────────┘    └──────────▲──────────────┘
                         │                                │
       ┌─────────────────┴────────────────┐               │
       │                                  │               │
   ┌───▼────────────┐               ┌─────▼──────┐    ┌───┴──────────────┐
   │ ServerRail @   │               │ Channel row│    │ useAutoMarkRead  │
   │ overlay        │               │ badges     │    │ + ReadStateRoot  │
   │ MentionNav     │               │            │    │                  │
   └────────────────┘               └────────────┘    └──────────▲───────┘
                                                                 │
                                              ┌──────────────────┴───┐
                                              │ relay-sync engine    │
                                              │ NIP-59 gift wrap I/O │
                                              └──────────────────────┘
```

## 2. Cursor model

`src/store/read-state.ts`:

```ts
interface ReadStateStore {
  dmCursors: Record<peerHex, tsMs>;      // unix ms; only advances
  groupCursors: Record<groupId, tsMs>;   // unix ms; only advances
  inboxLastReadAt: number;               // DM-notification cursor, unix ms
  // ...
  applyRemoteState(remote: RemoteReadState): void;
}
```

- **Single cursor per channel/peer** — Discord-style. Mentions and replies
  are derived views of unread messages, not separate cursors. The
  auto-mark hook advances `lastReadAt`; all three badges (unread count,
  mention bubble, reply bubble) clear together.
- **Monotonicity** — `setDmCursor` / `setGroupCursor` / `applyRemoteState`
  only ever advance forward. Cursors are a CRDT under `max()`: two
  devices (or two tabs) advance independently and converge by taking the
  larger value per key.
- **Bootstrap fallback** — first paint with no cursor for a key falls
  back to `Date.now() − 24h`. Matches the legacy heuristic; converges to
  a real cursor as soon as the user opens the conversation.
- **Multi-account isolation** — persist key `obelisk-read-state:{myPubkey}`
  via `ensureReadStateStoreForAccount`. Mounted from
  `ReadStateRoot` on every login change.

### 2b. Notification streams (`src/store/notifications.ts`)

Notifications are **two independent streams that never share a cursor**.
Conflating them was the original bug: one `inboxEvents` ring buffer and
one `inboxLastReadAt` meant reading your DMs silently marked every
channel mention read.

| Stream | Log | Cursor | Scope | Synced by |
|---|---|---|---|---|
| Mentions | `mentionsByRelay[relay]` (cap 50/relay) | `mentionCursorByRelay[relay]` | **Per relay** | groups-scope wrap (`mentionsReadAt`) |
| DMs | `dmNotifications` (cap 50) | `useReadStateStore.inboxLastReadAt` | Account-wide | DM-scope wrap (existing field) |

Rules:

- **Only an explicit `@you` pings.** Not ordinary traffic, not
  replies-to-you. `ingestMessage` returns early unless
  `mentions.includes(me)`.
- **Mentions are scanned only while their relay is active.** Group kind-9
  subscriptions exist only for the active relay (see CLAUDE.md,
  "Single-relay rule for groups"), so this falls out of the architecture
  rather than being enforced separately. Each card is stamped with the
  relay it was scanned on and is never rendered while browsing another.
- **Cards persist per relay.** Leaving a relay and coming back restores
  its mention cards with their unread state intact.
- **First connect to an unseen relay ignores history.** `registerRelay`
  stamps `Date.now()` as that relay's cursor the first time the bridge
  connects to it — called from `finalizeLogin` and `switchRelay`, both
  *before* subscriptions open. A relay whose cursor already exists keeps
  it, so a reconnect never silences cards the user hasn't read.
- **A mention also clears when its channel is read.** `isMentionRead`
  takes `max(relay cursor, channel cursor)`, so scrolling past the
  mention in-channel dismisses the bell without a second interaction.

The DM cursor deliberately stays in the read-state store: it is already
the wire field in the DM-scope gift wrap, so multi-device convergence
works untouched. One source of truth per value, two stores.

## 3. Mention detection

`extractMentionPubkeysFromMessage(content, tags)` (`src/lib/mentions.ts`)
unions:

- Content tokens: `nostr:npub1<hex>` and `nostr:npub1<bech32>` and bare
  `npub1<bech32>`. Both legacy hex and real NIP-19 bech32 work.
- `["p", <64 hex>]` event tags (NIP-29 messages routinely carry these).

Precomputed once at ingest (`client.ts:ingestMessage`) and stored on
`JsMessage.mentions`. UI selectors filter that list — no re-parsing per
render.

## 4. Reply detection

`isReplyToMe(msg, authorById, myPubkey)` (`src/lib/read-state/replies.ts`)
— strict NIP-10:

- Message must have an `e` tag with marker `"reply"` (parsed by the
  bridge into `JsMessage.replyToId`).
- The id resolved to a parent must exist in the local channel message
  list AND have `pubkey === myPubkey`.

Root-only e-tags (`marker === "root"` or unmarked positional) are NOT
replies — those denote thread membership.

Replies feed the **channel highlight** views only (the `↑↓`
MentionNavigator and the green channel-row pill). They deliberately do
**not** produce a notification card and do not badge the tab — only an
explicit `@you` does. See §2b.

## 5. Highlights selector

`useChannelHighlights(groupId, myPubkey): ChannelHighlights`:

```ts
interface ChannelHighlights {
  unread: number;
  mentions: number;
  replies: number;
  /** mention OR reply event ids, oldest→newest, for ↑↓ navigation. */
  eventIds: ReadonlyArray<string>;
}
```

`useHasAnyHighlights(myPubkey)` returns `true` when any
currently-loaded channel has unread mentions or replies — drives the
ServerRail relay-tile `@` overlay on the active relay.

## 6. UI surfaces

| Surface | File | Behaviour |
|---|---|---|
| Relay-tile `@` overlay | `src/app/app/ServerRail.tsx` (RelayTile) | Tiny green `@` badge when the active relay has unread mentions or replies in any channel. Cross-relay surveillance is a follow-up. |
| Channel row badges | desktop `DesktopShell.tsx` (`GroupNode`), mobile `PhoneShell.tsx` (channel list) | Gray unread count + green pill for `mentions + replies`. Bold name when unread > 0. |
| MentionNavigator | `src/components/chat/MentionNavigator.tsx` | Floating bottom-right of the message viewport. `↑ N / total ↓` when there are highlights; `F7` / `Shift+F7` keyboard shortcuts. Plus a `⌄` jump-to-latest button when scrolled away from the bottom. |
| Inbox bell | desktop `DesktopShell.tsx` (`RelayTopBar`), mobile inbox tab | Two tabs — **Mentions** (active relay) and **DMs** — with independent counts, independent "mark read", and independent "clear". The bell glyph shows their sum. |
| Tab title + favicon | `src/hooks/useFaviconBadge.ts` | `useTotalDMUnread` + unread mentions on the active relay. Ordinary channel traffic does **not** badge the tab — a busy relay would otherwise pin it at `(99+)` forever. |

## 7. Encrypted multi-device sync

Two scopes share the same engine (`src/lib/read-state/relay-sync.ts`):

| Scope | Where it's published | Inner d-tag | Contents |
|---|---|---|---|
| **Groups state** | The **active** relay only (`useCurrentRelayUrl`) | `obelisk:readstate:v1` | `{ v:1, groups: { [groupId]: { lastReadAt } }, mentionsReadAt? }` |
| **DM state** | User's NIP-65 read+write union (`fetchRelayList`) | `obelisk:dm-readstate:v1` | `{ v:1, dms: { [peerHex]: { lastReadAt } }, inboxLastReadAt }` |

The groups-scope sub used to fan out across `useConfiguredRelays()` —
every relay in the rail got a kind 1059 REQ. That was the source of the
"send AUTH on a closed connection" loop: a whitelist-gated relay (e.g.
`lacrypta-relay.obelisk.ar`) the user had in their rail but wasn't
browsing would issue NIP-42 AUTH, the bridge would auto-sign and send,
the relay would close the socket, and nostr-tools would resend on
reconnect. Switching to active-relay-only also satisfies the
[architectural rule in CLAUDE.md](../CLAUDE.md#single-relay-rule-for-groups-cross-relay-only-for-dms):
**only DMs run cross-relay**.

Per-relay group-id collisions are not an in-memory concern because
NIP-29 group ids are random hex blobs (effectively unique across
relays); the on-the-wire payload is always scoped per relay (each
gift wrap carries only `groupIdsForRelay`), and `bridgeCache` keys are
`${relay}|${kind}|${dTag}`.

### Why NIP-59 gift wrap

The relay sees only `kind:1059 from random pubkey #p=me` — the same
shape as a NIP-17 DM. There is no plaintext `d` tag, no app fingerprint,
no replaceable-event slot announcing "this user has Obelisk read state
on this relay." Plausible deniability for app usage on any single
relay.

### Cost: accumulation

NIP-59 gift wraps aren't replaceable — every cursor advance creates a
new event on the relay. Mitigated by an **8-second debounce** —
bursts of cursor advances during active reading collapse into one
publish. Newest-wins on read; old wraps stay on the relay but never
affect correctness. We deliberately do NOT publish NIP-09 deletions for
prior wraps — many relays don't honor them anyway.

### Read protocol

For each target relay, subscribe `{kinds:[1059], "#p":[myPubkey]}`,
then for each event:

1. `unwrapForSelf(wrap, signer)` — NIP-44 decrypt the wrap content to
   recover the seal (kind 13), verify `seal.pubkey === me`, NIP-44
   decrypt the seal to recover the rumor.
2. Filter by `rumor.kind === 30078` AND inner d-tag matches the scope's
   tag.
3. Parse `JSON.parse(rumor.content)`; reject when `v !== 1`.
4. Pick newest by inner `rumor.created_at`. The wrap's `created_at` is
   randomized ±2 days for privacy (NIP-59 §Privacy tags).
5. `useReadStateStore.applyRemoteState({...})` — atomic monotonic
   merge: each cursor takes `max(local, remote)`.

A `bridgeCache` snapshot is painted first for instant first-paint on
reload; the live REQ overwrites it as soon as the relay confirms.

### Write protocol

The engine subscribes to `useReadStateStore` cursor changes filtered to
its scope. On any change:

1. Schedule `setTimeout(flush, 8000)`; cancel any prior pending timer.
2. `flush()` builds the JSON payload, calls `wrapForSelf({ kind: 30078, tags: [['d', dTag]], content }, signer)`,
   and `bridge.publishEvent(wrap, { extraRelays: [...], mode: 'replace' })`
   so the publish targets ONLY the scoped relays.
3. Cache the freshly-published payload to `bridgeCache` so reload paints
   the latest state without waiting for the relay round trip.

### NIP-44 + signing

`wrapForSelf` and `unwrapForSelf` (`src/lib/nip-59.ts`) accept a
`NipSigner` — `signEvent` + `nip44Encrypt` + `nip44Decrypt`. The bridge
builds one for the active session via `getNipSigner()`:

- nsec → `finalizeEvent(template, sk)` + raw `nostr-tools/nip44`
- NIP-07 → `window.nostr.signEvent` + `window.nostr.nip44.{encrypt,decrypt}`
- bunker → `BunkerSigner.signEvent` + `BunkerSigner.nip44{Encrypt,Decrypt}`

The wrap layer uses a fresh ephemeral keypair, so the user's real
pubkey never appears on the kind 1059 envelope.

## 8. Priority orchestrator alignment

The two scopes have different priorities now:

- **Groups scope** (active relay only) — fires as soon as `myPubkey`,
  `activeRelay`, and at least one group are known. **No `useReadyToSync`
  gate.** It must land before messages paint, otherwise unread badges
  flash on then off when cursors arrive (the bridgeCache seed paints
  instantly; the live REQ overwrites). The store defaults are "from
  zero," so a relay that doesn't store our wrap (or doesn't accept kind
  1059) leaves cursors at zero and a fresh wrap is published the moment
  the user marks anything read.
- **DM scope** (NIP-65 read+write union) — still gated by
  `useReadyToSync()` because it depends on the asynchronous `fetchRelayList`
  resolution and is one of two acceptable cross-relay fanouts (DMs
  themselves being the other).

`useReadyToSync()` waits for either `groupMetadataEose === true` (channel
menu painted) OR 1000ms post-`Connected` (some relays filter kind 39000
silently). The 8s debounce in `flush()` keeps mount-delay invisible to
the user either way.

See [`data-system.md` §4](./data-system.md) for the full priority table.

## 9. Mount points

```
src/app/app/AppGate.tsx
└── <ReadStateRoot/>  (gated on useIsLoggedIn)
    │  src/lib/read-state/root.tsx
    ├── ensureReadStateStoreForAccount(myPubkey)
    ├── ensureDMStoreForAccount(myPubkey)
    ├── ensureModerationStoreForAccount(myPubkey)
    ├── ensureForumFollowForAccount(myPubkey)
    ├── [no gate] startGroupsRelaySync(activeRelay, groupIds)
    ├── fetchRelayList(...) → setDmRelays  (NIP-65 read+write union)
    ├── [gated by useReadyToSync] startDMRelaySync(dmRelays)
    ├── useAutoMarkRead()
    └── useFaviconBadge()
```

## 10. LocalStorage conventions

| Data type | Key pattern | Mechanism |
|---|---|---|
| Per-user cursors | `obelisk-read-state:{myPubkey}` | Zustand `persist` + `ensureReadStateStoreForAccount` |
| Notification cards + mention cursors | `obelisk-notifications:{myPubkey}` | Zustand `persist` + `ensureNotificationsStoreForAccount` |
| Relay-derived metadata + state-event cache | `obelisk-cache-v3/{relay}/1059/{dTag}` | `bridgeCache` |
| UI-only flags | `obelisk-dex/{namespace}/{id}` | direct `localStorage` |

## 11. Cross-tab sync

Two tabs on the same account converge automatically:

- Zustand `persist` writes to localStorage on every state change; other
  tabs receive a `storage` event and rehydrate.
- Cursors are monotonic, so the `max()` merge is conflict-free.

## 12. Limitations

1. **Cross-relay mention surveillance** — the relay-tile `@` overlay only
   lights up on the active relay. To show it on inactive relays we'd
   need to subscribe to `{kinds:[9], "#p":[me]}` on each configured
   relay even when the user isn't on them. Tracked as a follow-up; the
   data path is otherwise ready.
2. **Reply-to-me requires the parent in local state** — backfill that
   arrives before the parent does won't count toward the channel's reply
   highlight. Acceptable because messages stream in chronologically.
   (Replies don't produce notifications at all — see §2b.)
3. **Gift wrap accumulation** — handled by the 8-second debounce, but
   long-running users on a single relay will accumulate ~10-30 KB of
   stale wraps per month. Future cleanup pass (NIP-09 deletions) is a
   follow-up.

## 13. Phase 1.5 (next): browser + PWA notifications + sound

Once the data layer is stable in production, OS-level notifications get
layered on top. Same predicate as the notification push at
`client.ts:ingestMessage` / `ingestDM`:

```
isNew && !isUserWatching(channel|dm) && (mentioned || isDM)
```

Per CLAUDE.md, background OS notifications are **DM-only**: group
mentions only notify while the user has that group's relay open as the
active relay, because that's the only time they're scanned.

When that fires AND the user has opted in:

- `Notification` API for desktop / open-tab PWA delivery.
- `<audio>` chime, debounced to once per second.
- `notificationclick` handler (registered by a tiny SW) deep-links to
  the right channel/DM.

iOS PWA: feature-detect `Notification` and gate the toggle. Sound works
everywhere. No backend, no Web Push subscriptions — the relay sub stays
in-page and the browser owns the OS handoff.

## 14. Testing

| File | Covers |
|---|---|
| `src/store/read-state.test.ts` | cursor monotonicity, account-swap persist key, `applyRemoteState` merge semantics |
| `src/store/notifications.test.ts` | stream independence, per-relay bucketing, first-connect floor, backfill drop, caps/dedup, remote cursor merge |
| `src/lib/nostr-bridge/bridge.test.ts` (`mention notifications`) | mentions-only ingest, relay stamping, self-mention and reply suppression, cursor-gated backfill |
| `src/lib/read-state/selectors.test.ts` | unread counts, own-message exclusion, `computeChannelHighlights` ordering, mention + reply union |
| `src/lib/read-state/replies.test.ts` | NIP-10 strict reply detection, parent lookup, edge cases |
| `src/lib/read-state/relay-sync.test.ts` | sub/ingest with merged cursors, debounced publish, d-tag filtering, cache-first paint |
| `src/lib/read-state/root.test.tsx` | `useReadyToSync` gate: false before connect, flips on EOSE, flips after 1000ms grace, no flip if connection drops mid-grace |
| `src/lib/nip-59.test.ts` | wrap/unwrap roundtrip, null-on-junk, recipient mismatch, ephemeral pubkey privacy |
| `src/lib/mentions.test.ts` | content-only and `#p`-tag mention extraction |
| `src/components/chat/MentionNavigator.test.tsx` | ↑↓ clamping, F7 / Shift+F7 keys, scrollIntoView, hidden when no highlights |
| `src/hooks/useAutoMarkRead.test.tsx` | cursor advances on watching, halts on hidden, monotonic on backfill |
| `src/hooks/useFaviconBadge.test.tsx` | tab title + favicon count DMs + active-relay mentions only, ignore ordinary traffic and other relays' mentions |

End-to-end (Playwright):

| Spec | What it asserts |
|---|---|
| `scripts/e2e/read-state-convergence.spec.ts` | Two contexts seeded with the same nsec on `public.obelisk.ar`. Context A advances a cursor; within 12s (8s debounce + grace) context B's `obelisk-read-state:<pubkey>.groupCursors[gid]` reflects the advance. |
