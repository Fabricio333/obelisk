# Web of Trust integration + mute-system revision

## Context

Today, Obelisk renders every event the relay sends, regardless of who authored it. The mute system (`src/store/moderation.ts` zustand + bridge NIP-51 kind 10000) only filters at React **render time** — so muted/unwanted authors' events still hit `messagesByGroup`, the localStorage cache (`cacheSet` calls in `ingestGroupMetadata`, `ingestAdminMember`, etc.), and trigger amplifying `ensureUserMetadata()` REQs for kind:0 lookups. That's spam-attack surface and a privacy leak (the user's relay history records exposure to authors they never wanted to see).

The user wants to plug in the **nostr-wot extension** (`window.nostr.wot`, exposes `getDistance`, `getDistanceBatch`, `isInMyWoT`, `getStatus`, etc. — all async, Promise-returning), drop events from out-of-WoT npubs **before they reach the cache or in-memory stores**, and avoid REQ'ing data tied to those pubkeys when feasible — the same way muted accounts *should* be treated. The mute system also needs revision: today there are two parallel mute lists (NIP-51 in the bridge + local zustand in `moderation.ts`) and neither stops events from reaching the cache.

The extension API is **async**, the ingest path is a hot **sync** loop, and WoT verdicts can be **stale** (graph changes, extension reconfigured, batch in flight). The design reconciles those three constraints with a sync verdict cache populated by debounced batch lookups, and an explicit fail-open policy when verdicts are unknown.

## Design decisions (locked with the user)

- **Fail policy:** fail-open + WoT off when the extension is absent/unconfigured, AND fail-open while a verdict is pending. Only events for which we hold a *resolved* "out of WoT" verdict get dropped. Mutes still apply unconditionally.
- **Mute consolidation:** keep BOTH systems (per user). NIP-51 kind 10000 = cross-device synced mutes. `src/store/moderation.ts` = device-local quick mute (re-purpose: actually wire it into the predicate so it stops being dead weight). `mutedPubkeys` is the union of both. `blockedPubkeys` (already in `moderation.ts`) becomes a hard local denylist that, unlike mutes, also bypasses always-allow exemptions.
- **Exempt kinds (always pass, even if author untrusted):** own events; group metadata (kind 39000); group admins/members (kinds 39001/39002); group-create (kind 9007); DM counterparties for whom an outgoing DM exists in `dm-cache` (consensual conversation). Mute/block are NOT exempt — explicit user action overrides.
- **Cache lifetime:** WoT verdicts cached in-memory only (per session). On extension status change or maxHops change, cache is wiped. TTL = 30min on the verdict itself so the graph staying live picks up new follows.

## Approach

Single new module `src/lib/wot/`. One sync predicate `isAllowed(pubkey, kind?)` consulted at exactly two ingest choke points (bridge `subscribeWatched.onevent` + DM `verifyAndIngest`) and one REQ-amplification choke point (`ensureUserMetadata`). Settings + UI surface for enable/disable/maxHops. Mute filter moves from React `useMemo` (render-time) to the same predicate (ingest-time), and the dead `moderation.ts` store gets wired into the predicate too. No changes to relay protocol — pure client-side gating.

## Files to add / modify

### NEW

| File | Purpose |
|---|---|
| `src/lib/wot/extension.ts` | Typed wrapper around `window.nostr.wot`. Probes `getStatus()` on load. Exposes `wotProbe()`, `wotBatch(pubkeys, maxHops)`, `wotDistance(pubkey)`. Returns `null` when extension absent — never throws. |
| `src/lib/wot/engine.ts` | The verdict cache + batch loader. In-memory `Map<pubkey, { verdict: 'allow' \| 'deny', expiresAt }>`. `markUnknown(pubkey)` enqueues into a 100ms debounced flush that calls `wotBatch` and writes verdicts. `isAllowed(pubkey, kind?)` is sync, consults cache + always-allow + mutes/block + fail policy, and returns boolean. Emits a "verdicts changed" event so consumers can prune already-stored entries. |
| `src/lib/wot/store.ts` | Zustand store, persisted: `{ enabled, maxHops, status: 'absent'\|'configured'\|'error' }`. Wired to `wotProbe()` on app mount and on visibility change. |
| `src/lib/wot/index.ts` | Public re-exports: `isAllowed`, `useWotStatus`, `useWotDistance(pubkey)`, `useWotEnabled`, `setWotConfig`. |
| `src/lib/wot/engine.test.ts` | Vitest: cache hit/miss, batch coalescing, fail-open behavior, prune-on-verdict-change, TTL expiry, exemption matrix per kind, mute/block override path. Mocks `window.nostr.wot`. |
| `src/components/settings/WotSettings.tsx` | Card with toggle, maxHops slider (1–4, default 2), live "extension status" indicator, "purge cached events from now-untrusted authors" button. Slots into wherever ProfileEditor is rendered (likely UserPanel-adjacent). |
| `src/components/chat/WotBadge.tsx` | Tiny pill showing `1°/2°/…/—` next to display names in `MessageContent` and `ProfilePopover`. Reads `useWotDistance(pubkey)`. |

### EDIT

| File | Change |
|---|---|
| `src/lib/nostr-bridge/client.ts` line 1796–1805 (`subscribeWatched.onevent`) | Insert `if (!isAllowed(ev.pubkey, ev.kind)) { wot.markUnknown(ev.pubkey); return; }` before `onevent(ev)`. This single line gates ALL relay-derived events: groups, messages, reactions, DMs (kind:4 incoming sub), admin/member, contact list, mute list, profile, and voice signaling that flows through the bridge. |
| `src/lib/nostr-bridge/client.ts` `ensureUserMetadata(pk)` (~line 1959) | Skip the kind:0 REQ if `isAllowed(pk, 0) === false` AND verdict is resolved (not unknown). Prevents profile-fetch amplification for confirmed-out-of-WoT pubkeys. Unknown pubkeys still REQ — they may be allowed once verdict resolves. |
| `src/lib/nostr-bridge/client.ts` `ingestGroupMetadata`, `ingestAdminMember`, `ingestMessage`, `ingestReaction`, `ingestDM`, `ingestUserMetadata` | No code changes (the choke-point above gates them). Add a defensive `if (!isAllowed(...)) return;` only in `ingestDM` because it can also be called from the dm.ts path (belt-and-suspenders). |
| `src/lib/nostr-bridge/client.ts` `subscribeMyMuteList` (~line 2085) | When the mute list updates, call `wot.notifyMutesChanged()` so the engine can re-evaluate cached verdicts and the prune event fires for newly-muted pubkeys. |
| `src/lib/dm/dm.ts` `verifyAndIngest` (line 28) | After signature check, before `putEvent`, gate with `isAllowed(event.pubkey, event.kind)` AND check the consensual-DM exemption (does `dm-cache` have an outgoing event to this pubkey?). Prevents NIP-04 history loads, gift-wraps, and inbox-walker hits from caching untrusted authors. |
| `src/lib/voice/client.ts` lines 408–417 | Augment the existing `isMember(from)` gate: `if (!isMember(from) || !isAllowed(from, KIND_VOICE_SIGNAL)) return;`. Voice signaling from an untrusted author should never be routed even if they're nominally a "member". |
| `src/lib/nostr-bridge/stores.ts` `useMessages` (line 165) and `useDirectMessages` (line 201) | DELETE the render-time mute filter. Filtering happens at ingest now; if it didn't pass the predicate, it's not in the store at all. (Keep the `useMyMutes` hook itself — UI still uses it for "is this user muted?" toggles in `ProfilePopover`.) |
| `src/store/moderation.ts` | KEEP, but actually use it. Subscribe to its `mutedPubkeys` and `blockedPubkeys` from inside `wot/engine.ts` so they participate in the predicate. Add a comment marking it as "device-local quick mutes — NOT synced; for cross-device use the bridge mute toggle." Remove unused `isMuted`/`isBlocked` selectors if nothing reads them. |
| `src/components/chat/ProfilePopover.tsx` | Show WoT badge + distance, and surface the `moderation.toggleMute` / `moderation.toggleBlock` actions next to the existing NIP-51 mute toggle so the user can pick local-vs-synced. |
| `src/components/chat/MessageContent.tsx` | Render `<WotBadge pubkey={...} />` next to author name. |

### Pruning already-cached untrusted entries

When a verdict resolves to "deny" for a pubkey that already has events in stores/cache (because they came in fail-open while we were waiting), `wot/engine.ts` emits `verdict-deny`. A small subscriber inside the bridge wipes:

- `messagesByGroup`: `.update(filterOutPubkey)` for every group
- `dmsByPeer`: delete the peer entry
- `userMetadata.delete(pubkey)`
- `cacheDelete(relay, KIND_USER_METADATA, pubkey)` and any per-pubkey cache entries
- For DM cache: a sweep helper in `dm/dm-cache.ts` to drop entries by pubkey

This keeps the "events from untrusted npubs never persist" invariant *eventually*: the moment we know they're untrusted, they're gone — even if they briefly slipped in.

## How the choke point works (the load-bearing edit)

```
src/lib/nostr-bridge/client.ts:1796 (inside subscribeWatched > start > pool.subscribe)

  onevent: (ev) => {
    alive = true;
    armed = false;
    clearTimer();
    for (const url of relays) this.setRelayAccess(url, 'ok');
+   if (!isAllowed(ev.pubkey, ev.kind)) {
+     wot.markUnknown(ev.pubkey);  // no-op if already known
+     return;                        // event dropped: never cached, never stored
+   }
    onevent(ev);
  },
```

The bridge has a single `subscribeWatched` that wraps `pool.subscribe`. **Every** relay-derived event (groups, messages, reactions, DMs, admin/member, profiles, contact list, mute list, voice) flows through this one callback. That makes it the cheapest possible integration: one line of code controls the entire ingest surface.

## Verification

Manual smoke (foreground):

1. `npm install nostr-wot-sdk` if any types are needed (the API itself is just `window.nostr.wot`, no dep required for runtime).
2. `npm run dev`, log in with NIP-07 + the nostr-wot extension installed and configured.
3. In a channel where you have a follow + a non-follow posting, confirm only the follow's messages appear once `Settings → WoT → enabled, maxHops=1`.
4. DevTools → Application → Local Storage: confirm no `obelisk:cache:*` entry has the non-follow's pubkey as the value of any kind:0 / admin/member list.
5. Toggle WoT off → both authors visible again. Toggle on → non-follow disappears AND any prior in-memory entry from that pubkey is pruned.
6. Mute a different follow via `ProfilePopover → Mute (synced)` → kind 10000 publishes → on next session, that pubkey is dropped at ingest (not at render).
7. Quick-mute a follow via `ProfilePopover → Quick mute (this device)` → drops immediately, no relay publish.
8. Disable extension entirely → app behaves exactly as today (fail-open, WoT off, mutes still work).

Automated:

- `src/lib/wot/engine.test.ts` — full predicate matrix: combinations of {extension absent / unknown / allow / deny} × {own / exempt-kind / mute / block / generic} × {maxHops 1/2/3}.
- `src/lib/dm/dm.test.ts` — extend with one case per branch (fail-open, untrusted denied, consensual exemption).
- `npm run test` must pass green before this is considered done (per CLAUDE.md "tests are part of the implementation").

## Alternatives considered

The implementation above is what we're shipping. The other approaches below were evaluated and rejected for v1, but are documented so future work can pivot without re-deriving the trade space. **None of these change the file list above** — they're alternative *backends* for the same `isAllowed()` predicate.

### Alternative A — Browser extension only (CHOSEN)

The chosen approach. `window.nostr.wot.getDistanceBatch(...)` from the [nostr-wot-extension](https://github.com/nostr-wot/nostr-wot-extension), in-memory verdict cache, debounced batch flush.

- **Pros:** zero new server dependency; private (graph never leaves the browser in Local mode); same signer surface the user already has via NIP-07; works offline once IndexedDB is warm.
- **Cons:** requires extension install (fail-open until then); cold-start latency on first batch; per-account graph rebuild when switching identities.
- **When to revisit:** never — this stays the default. Other backends slot in *behind* this if absent.

### Alternative B — WoT Oracle REST API

`POST https://oracle.nostr-wot.com/...` (or self-hosted) for batch distance lookups. The [nostr-wot-oracle](https://github.com/nostr-wot/nostr-wot-oracle) repo exposes sub-millisecond queries on a Rust backend.

- **Pros:** works without the extension installed; no graph build cost client-side; consistent across users; useful for new-user onboarding when their extension graph is empty.
- **Cons:** privacy leak (every pubkey you encounter gets queried against an external service that learns your social-adjacency map); availability dependency; rate limits; can't be used in fail-closed mode without a network round-trip on the hot path.
- **When to revisit:** if v1 telemetry shows >50% of users without the extension, add Oracle as a fallback behind a settings toggle. The `wotProbe()` seam in `wot/extension.ts` is where Oracle plugs in — same `isAllowed()` interface, no other code changes.

### Alternative C — `nostr-wot-sdk` JavaScript SDK

The npm package wraps Oracle calls with React hooks and retry logic.

- **Pros:** typed, tested, drop-in; less code to maintain than a hand-rolled Oracle client.
- **Cons:** same privacy/availability cons as Oracle (it's a thin wrapper); adds a dep when our needs are 1–2 endpoints; bundle-size cost (estimate ~15–30KB gzipped). For only batch distance + status, hand-rolled fetch is ~30 lines.
- **When to revisit:** if we adopt Oracle (Alt B) and find we're re-implementing the SDK's React hooks anyway. Until then, the engine's bespoke verdict cache + batch coalescer fits Obelisk's existing patterns better.

### Alternative D — Self-built local WoT (no extension, no Oracle)

Compute distance ourselves: walk kind:3 follow lists from the user's pubkey breadth-first, store the graph in IndexedDB, query locally.

- **Pros:** zero external dependency; full control; offline; handles fail-closed mode trivially.
- **Cons:** significant code (graph build + traversal + cache invalidation + relay-load to fetch follow lists for thousands of pubkeys); duplicates exactly what the extension already does; days of work vs. hours.
- **When to revisit:** only if the nostr-wot project becomes unmaintained AND we still want WoT. Today's CLAUDE.md "easy and fast" goal rules this out.

### Alternative E — Render-time filter only (status quo, rejected)

What the codebase does today for mutes: subscribe everything, filter in `useMessages` / `useDirectMessages` via `useMemo`.

- **Pros:** simplest possible code change (1-line filter per hook).
- **Cons:** **violates the user's explicit requirement.** Untrusted events still hit `messagesByGroup`, `dmsByPeer`, `userMetadata`, and `cacheSet(...)` — they live in localStorage and consume memory. Profile-fetch amplification (`ensureUserMetadata`) still REQs kind:0 for every author. Reactions, admin lists, and voice signaling have no render-time filter at all so they leak through entirely.
- **When to revisit:** never — this is the bug we're fixing.

### Alternative F — Relay-side filtering (NIP-XX trusted-relay set)

Configure a relay that already enforces a WoT (e.g. `wss://relay.nostr.band` with author allowlists) and rely on the relay to drop untrusted events server-side.

- **Pros:** zero client code; no in-browser computation.
- **Cons:** every user would have to configure their relay set; does not compose uniformly across the dex built-in relays; can't enforce per-user WoT (only a relay-operator-chosen set); doesn't help with NIP-29 groups whose canonical relay is fixed; and it just shifts the trust to the relay operator. Useful for *defense in depth* alongside client filtering, not as a replacement.
- **When to revisit:** once a NIP for "give me events authored by these pubkeys only" lands and major relays implement it, we can pre-filter on the wire to save bandwidth — but the client predicate stays as the source of truth.

## Out of scope (deliberately punted)

- Trust-score-weighted ranking (only hop-distance gating in v1; the engine returns boolean, not score).
- WoT-aware search ranking in `bridge.searchMessages` (search returns everything; ranking happens at render).
- Group admin permission gating by WoT (kept render-only since the user explicitly needs to *see* admins to know who runs a channel).
- Cross-account verdict cache reuse on identity switch (cache wiped per-account; matches the extension's per-account graph isolation).
