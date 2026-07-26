# obelisk-dex e2e harness

Playwright-driven end-to-end tests that drive a real browser against a
running app, capture every signal the client emits, and assert each
step against the auth/data-loading contract documented in
`docs/data-system.md`.

The harness skips the LoginModal — it seeds an nsec PersistedSession
into `localStorage` before the page loads, so `BridgeImpl.initialize()`
rehydrates as if the user had already logged in. Identity is generated
fresh per run; nothing real ever signs anything.

## Run

The harness defaults to `http://localhost:3001` (the port the PM2 /
production config in `ecosystem.config.js` uses). `npm run dev` serves
on Next's default `3000`, so one of these has to give:

```bash
# Option A — align dev with the harness default
PORT=3001 npm run dev                            # in another shell
npm run test:e2e                                 # headless
npm run test:e2e:headed                          # watch the browser

# Option B — point the harness at a 3000 dev server
npm run dev                                      # in another shell, :3000
OBELISK_E2E_BASE_URL=http://localhost:3000 npm run test:e2e
```

Against production:

```bash
OBELISK_E2E_BASE_URL=https://obelisk.ar npm run test:e2e
```

Run a single spec while iterating (parallel workers are off, so looping
the whole suite over a public relay is wasteful):

```bash
npx playwright test --config=scripts/e2e/playwright.config.ts paint-order
```

Useful overrides:

| Variable | Default | What it does |
|---|---|---|
| `OBELISK_E2E_BASE_URL` | `http://localhost:3001` | Origin under test. |
| `OBELISK_E2E_RELAY` | `wss://public.obelisk.ar` | Open relay used by every spec except the whitelist-rejection one. |
| `OBELISK_E2E_RESTRICTED_RELAY` | `wss://lacrypta-relay.obelisk.ar` | Restricted relay used by `whitelist-rejection.spec.ts`. Must reject fresh pubkeys with `auth-required` or `restricted` CLOSED reasons. |
| `OBELISK_E2E_CHANNEL` | `general` | Channel name to open + post into. Falls back to the first visible channel if not found. |
| `HEADED` | unset | Set to `1` to launch a non-headless browser. |

## First-time smoke check

Before writing a new spec, confirm the harness works end-to-end in this
environment (browser binaries present, dev server reachable, real relay
reachable, NIP-42 AUTH completes):

```bash
npx playwright test --config=scripts/e2e/playwright.config.ts paint-order
```

A green run proves the full chain: bridge rehydrates from
`localStorage`, relay handshake + AUTH succeeds, `channels-loading`
spinner → first channel row → chat-pane loader unmounts on
`messagesEose`. If this fails, fix the harness before chasing a new
spec — every spec inherits the same plumbing.

## Specs

| Spec | What it asserts | Relay |
|---|---|---|
| `login-and-send.spec.ts` | Smoke: rehydrate → relay-ok → open channel → publish kind 9. | `OBELISK_E2E_RELAY` |
| `paint-order.spec.ts` | Channel menu spinner / row paints before the chat content. | `OBELISK_E2E_RELAY` |
| `transparent-banner.spec.ts` | `lc-banner-placeholder` until branding lands; title skeleton until grace+real value. | `OBELISK_E2E_RELAY` |
| `members-loading.spec.ts` | "Loading members…" until `useMembershipReady` flips. | `OBELISK_E2E_RELAY` |
| `whitelist-rejection.spec.ts` | Preflight surfaces `relay-access-banner[data-state=restricted\|auth-required]` within ~3.5s — under the 4s soak. | `OBELISK_E2E_RESTRICTED_RELAY` |
| `connection-loss.spec.ts` | `connection-loss-banner` appears on `setOffline(true)` and clears on `setOffline(false)`. | `OBELISK_E2E_RELAY` |
| `cache-second-load.spec.ts` | Reload paints first channel row in <1500ms from cache. | `OBELISK_E2E_RELAY` |
| `clear-cache.spec.ts` | Preferences → Clear cache wipes relay/UI/read-state keys; preserves session + preferences. | `OBELISK_E2E_RELAY` |
| `read-state-convergence.spec.ts` | Two contexts seeded with the same nsec converge cursors within ~12s. | `OBELISK_E2E_RELAY` |

## What gets logged

Every run streams structured progress to stdout:

```
▸ Generate ephemeral identity + seed session — expected: …
  10:42:15.881 npub  npub1q5…
  10:42:15.882 nsec  nsec1xy…  (ephemeral, do not reuse)
  10:42:15.882 relay wss://public.obelisk.ar
  ✓ session seeded into localStorage via addInitScript

▸ Wait for NIP-42 AUTH + first EOSE — expected: relay-access banner unmounts.
  10:42:16.412 relay-access → unknown
  10:42:16.671 relay-access → authenticating
  10:42:16.870 ← AUTH  public.obelisk.ar  ["challenge-string"]
  10:42:16.918 → AUTH  public.obelisk.ar  [{"id":"…","kind":22242,…}]
  10:42:16.948 ← OK    public.obelisk.ar  ["…",true,""]
  10:42:17.122 ← EOSE  public.obelisk.ar  ["sub-1"]
  10:42:17.221 relay-access → ok
  ✓ relay confirmed read access (banner gone, channelsVisible=true)
```

Captured streams:

- **Browser console** — every `console.log/warn/error` and uncaught
  page error, mirrored with the test step it landed under.
- **WebSocket frames** — every `AUTH`, `CLOSED`, `NOTICE`, `OK`, `EOSE`
  on every relay socket, in either direction. Use this to debug a
  stuck NIP-42 round-trip or a relay sending CLOSED `restricted:` for
  an unrelated channel sub.
- **Relay-access state transitions** — read straight off
  `[data-testid="relay-access-banner"][data-state="…"]`, so the trail
  exactly matches what a user would see in the UI.
- **DOM checkpoints** — sidebar populate, channel selection, message
  paint, post-publish access state.

## Failure artifacts

On failure the harness retains:

- Full trace zip — replay frame-by-frame with
  `npx playwright show-trace scripts/e2e/test-results/<…>/trace.zip`.
- Video recording.
- Screenshot.
- HTML report at `scripts/e2e/playwright-report/` — open with
  `npx playwright show-report scripts/e2e/playwright-report`.

## Adding a new spec

### Wiring (every spec)

1. Drop a `*.spec.ts` next to `login-and-send.spec.ts`.
2. Import helpers from `./lib`.
3. Seed the session via `seedSession(context, …)` **before** `page.goto`
   so the bridge rehydrates cleanly.
4. Use `attachClientCapture(page)` to mirror console + websocket
   traffic. Keep a reference to the returned `ClientCapture` if you
   want to assert on console errors at the end.
5. Use `waitForRelayOk(page)` rather than `waitForTimeout` — that's the
   contract every read-side feature depends on.

### Patterns for catching "needs a refresh" bugs

The existing suite proves things *appear* (channel rows, members loader
unmounts, transparent banner flips, etc.). To catch the class where a
load looks complete but avatars / banners are blank or pubkeys are
still rendered as `npub1…`, two extra assertions are needed:

**1. Image readiness.** An `<img>` with `src` set is not proof it
loaded — the request could have failed silently and the element is a
broken image. Assert `naturalWidth > 0`:

```ts
const images = page.locator('img[src]').filter({ visible: true });
const count = await images.count();
for (let i = 0; i < count; i++) {
  const img = images.nth(i);
  await expect
    .poll(
      () => img.evaluate((el: HTMLImageElement) => el.naturalWidth),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
}
```

Scope it tightly — sidebar avatars, the user-panel pill, or
`[data-testid="profile-banner"]` after opening a profile popover. A
blanket page-wide scan against a public relay is flaky.

**2. Profile-name resolution.** A pubkey with no kind 0 renders as a
truncated `npub1abcd…`. A regression where kind 0 ingest stops
updating the UI looks fine on the surface — pubkeys just never resolve
to display names. Assert against the resolved text on a known testid:

```ts
const handle = page.getByTestId('profile-handle');
await expect(handle).not.toHaveText(/^npub1[a-z0-9]+…?$/i, {
  timeout: 10_000,
});
```

Existing testids you can lean on: `profile-name`, `profile-handle`,
`profile-banner` (on `ProfilePopover`), plus `lc-banner-placeholder`
for the pre-branding state.

**3. Pair with a console-error assertion** so a silent ingest crash
doesn't masquerade as "still loading":

```ts
const cap = attachClientCapture(page);
// … test body …
const errors = cap.console.filter(
  (e) => e.type === 'error' || e.type === 'pageerror',
);
expect(errors, JSON.stringify(errors, null, 2)).toHaveLength(0);
```

### Cost / iteration notes

- The harness is text-cheap (console + WS frames are text) and
  screenshot-cheap (`screenshot: 'only-on-failure'`). Adding specs
  scales linearly in dev-relay time, not in vision tokens.
- When a spec fails, open the trace before adding logs:
  `npx playwright show-trace scripts/e2e/test-results/<…>/trace.zip`.
  The trace already has the DOM timeline — new logs usually duplicate
  it.
- Public-relay flake is real; lean on `retries: 1` (already set) and
  generous per-assertion timeouts (8–10s) rather than chasing zero
  flake.

## Notes / gotchas

- **Port mismatch**: the harness defaults to `http://localhost:3001`
  (the PM2 / production port from `ecosystem.config.js`). `npm run
  dev` serves on Next's default `3000`. Either run dev with `PORT=3001
  npm run dev` or override the harness with
  `OBELISK_E2E_BASE_URL=http://localhost:3000`. Confirm with
  `curl -sI http://localhost:3000` / `curl -sI http://localhost:3001`.
- Posting to `wss://public.obelisk.ar` produces a real, public message
  on a real, public relay. The probe text is timestamped + tagged with
  the test pubkey so it's easy to grep in relay logs.
- `OBELISK_E2E_RELAY` must be a relay your *fresh* test pubkey is
  allowed to read+post on. Whitelist relays will produce a clean,
  expected `auth-required` / `restricted` failure that the harness
  surfaces in the relay-access transition log.
