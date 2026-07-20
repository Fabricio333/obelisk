# nostr-wot-sdk fork — local dev workflow

We work on the `@nostr-wot/ui` login modal (and friends) out of a local
clone of [`Fabricio333/nostr-wot-sdk`](https://github.com/Fabricio333/nostr-wot-sdk),
a fork of [`nostr-wot/nostr-wot-sdk`](https://github.com/nostr-wot/nostr-wot-sdk).
Push access on the org repo is read-only for us, so the fork is the
push target until changes land upstream.

## Layout (sibling to the obelisk repos)

```
WebstormProjects/
├── nostr-wot-sdk/                ← fork clone (its own git repo)
│   ├── packages/ui               ← login modal + widget + button
│   ├── packages/signers          ← NIP-07/46/55/PrivateKey backends
│   ├── packages/data             ← session context + data hooks
│   └── examples/login-playground ← Vite sandbox (added by this fork)
├── obelisk-dex/                  ← consumes via file:../nostr-wot-sdk/...
│   └── docs/nostr-wot-sdk-fork.md   (this file)
└── obelisk/                      ← (also consumes the same fork — same file: pattern)
```

The clone lives next to the obelisk repos, not inside them. Both
obelisk-dex and obelisk-classic point at the same checkout via
`file:../nostr-wot-sdk/packages/*`, so a single edit + rebuild flows
to every consumer.

## Where the login lives

| File | Role |
|------|------|
| `packages/ui/src/login/LoginButton.tsx` | Pill button → opens `LoginModal` |
| `packages/ui/src/login/LoginModal.tsx` | Portal wrapper around `LoginWidget` |
| `packages/ui/src/login/LoginWidget.tsx` | Picker + per-method dispatch + `onLogin` plumbing |
| `packages/ui/src/login/methods/Nip07Method.tsx` | Browser extension flow |
| `packages/ui/src/login/methods/Nip46Method.tsx` | Bunker (QR + paste URI) flow |
| `packages/ui/src/login/methods/GenerateMethod.tsx` | Create-new-keypair flow + optional kind-0 publish |
| `packages/ui/src/login/methods/ImportMethod.tsx` | Paste-nsec flow |
| `packages/ui/src/primitives/Modal.tsx` | Generic portal modal (ESC, scroll lock, backdrop) |
| `packages/ui/src/session-shell.tsx` | `<NostrSessionProvider>` + auto-restore wiring |
| `packages/ui/src/signer-storage*.ts(x)` | Pluggable persistence (default = localStorage) |
| `packages/ui/src/auth-handshake.ts` | Optional NIP-98 → JWT cookie flow (server-backed) |
| `packages/signers/src/{nip07,nip46,nip55,private-key}/index.ts` | The four `NostrSigner` backends |

The session is held in `<NostrSessionProvider>` (from `@nostr-wot/data/react`,
re-exported by `@nostr-wot/ui`). Every other `@nostr-wot/*` hook reads the
same context, so once login completes the signer is available app-wide.

## Sandbox: `examples/login-playground`

A Vite + React + TS app added under the fork. Boots in seconds, exercises
all four login methods, and aliases `@nostr-wot/*` imports to the package
sources so edits in `packages/ui/src/**` and `packages/signers/src/**`
hot-reload without a rebuild.

```bash
cd ../nostr-wot-sdk
npm install                                   # one-time, hoists workspace deps
npm run dev -w @nostr-wot/login-playground    # http://localhost:5173
```

Toggles in the playground:

- `methods` — pick which of `nip07 | nip46 | generate | import` render
- `nip46Mode` — `qr` (nostrconnect QR) vs `paste` (bunker:// URI)
- `hideAdvanced` — collapse / expose generate + import
- `profileSetup` — show kind-0 setup step after generate
- Inline `<LoginWidget>` rendered alongside the modal for comparison

The session panel reads `useSession()` and prints pubkey, signer
constructor name, and NIP-04 / NIP-44 capability flags.

## Sync flow

```bash
cd ../nostr-wot-sdk

# pull from upstream main
git fetch upstream
git checkout main
git merge upstream/main          # fast-forward; no conflicts on a clean fork
git push origin main

# work on a feature branch
git checkout -b login/<short-slug>
# ... edit packages/ui/src/login/** ...
git add -p && git commit
git push -u origin login/<short-slug>

# open PR back to nostr-wot/nostr-wot-sdk
gh pr create --repo nostr-wot/nostr-wot-sdk \
  --base main --head Fabricio333:login/<short-slug>
```

Branches stay on `Fabricio333/nostr-wot-sdk` until the org maintainers
merge — at which point `git pull upstream main` brings the merged
version back.

## Consuming the fork from obelisk-dex

`obelisk-dex/package.json` declares the three runtime packages as
`file:..` deps pointing at the sibling clone:

```json
"@nostr-wot/data":    "file:../nostr-wot-sdk/packages/data",
"@nostr-wot/signers": "file:../nostr-wot-sdk/packages/signers",
"@nostr-wot/ui":      "file:../nostr-wot-sdk/packages/ui"
```

npm 9+ symlinks (not copies) for `file:` deps, so rebuilds inside the
SDK propagate to obelisk's `node_modules/@nostr-wot/*` immediately —
no `npm install` needed after a rebuild.

```bash
cd ../nostr-wot-sdk
npm run build -w @nostr-wot/ui      # rebuild only what changed
# back in obelisk-dex: Next dev picks it up on next request
```

For tight inner-loop work, do iteration in the playground (instant HMR,
no rebuild), then rebuild only when ready to wire into the chat shell.

> **Status (2026-05-07):** the cutover has shipped.
> `src/app/app/LoginModal.tsx` is a thin wrapper around the SDK's
> `<LoginModal>`. The bridge (`src/lib/nostr-bridge/client.ts`) still
> owns the session — the SDK constructs the signer, hands the bridging
> material to the host via `onLogin`, and the host adapts each method
> to the existing bridge entrypoints.

## Consuming the fork from obelisk-classic (or any sibling)

Same pattern. From the consumer's `package.json`:

```json
"@nostr-wot/data":    "file:../nostr-wot-sdk/packages/data",
"@nostr-wot/signers": "file:../nostr-wot-sdk/packages/signers",
"@nostr-wot/ui":      "file:../nostr-wot-sdk/packages/ui"
```

Then `npm install`. The symlinks resolve to the same checkout, so a
single edit + rebuild updates every consumer.

If you need to ship the fork without expecting consumers to clone it
locally, the alternatives are:

1. **Git URL with a tarball proxy** (e.g. `gitpkg.now.sh`) — supports
   monorepo subpaths. Fragile but zero-publish.
2. **Publish under your own scope** (e.g. `@fabricio333/ui`) — most
   portable, requires npm publish access.

## Fork-only API the cutover depends on

The published `@nostr-wot/ui` on npm passes `{ signer, pubkey, method }`
to `onLogin`. Hosts that bridge to a separate session layer (like
obelisk's `NostrBridge`) need *more* than that — `PrivateKeySigner` keeps
its secret key private (`#sk`), so we cannot pull the nsec back out for
`bridge.loginWithNsec(skHex, pkHex)`, and reconstructing a usable
NIP-46 connection requires the same client identity the SDK paired
with.

This fork extends `onLogin` with three optional fields, set per-method:

```ts
onLogin?: (args: {
  signer: NostrSigner;
  pubkey: string;
  method: LoginMethodId;
  // Fork-only additions:
  nsec?: string;        // generate / import — the freshly minted / pasted nsec
  bunkerUri?: string;   // nip46 — `bunker://<pk>?relay=…`, reconstructed for QR flow
  clientNsec?: string;  // nip46 — the SDK's local client identity. MUST be reused
                        //         by hosts that re-attach via their own
                        //         BunkerSigner — a fresh client key is rejected
                        //         by the remote signer with "no secret".
}) => Promise<void> | void;
```

The fork also auto-skips the picker view when `methods.length === 1`
(no point re-rendering a one-button picker the host already drove) and
exposes `showRememberToggle` so hosts with their own session layer can
suppress the SDK's localStorage-based toggle.

These additions live in:

- `packages/ui/src/login/LoginWidget.tsx` — `onLogin` typing, picker auto-skip, `showRememberToggle` plumbing
- `packages/ui/src/login/methods/Nip46Method.tsx` — emits `bunkerUri` + `clientNsec` (both paste and QR)
- `packages/ui/src/login/methods/GenerateMethod.tsx` — emits `nsec`, supports hidden back button + toggle
- `packages/ui/src/login/methods/ImportMethod.tsx` — same as Generate

Branch where this lives: `examples/login-playground` on
`Fabricio333/nostr-wot-sdk`. When this lands upstream, drop
`file:../nostr-wot-sdk/packages/*` for the published versions and
delete this section.

## Bridge-side adaptation (`src/lib/nostr-bridge/client.ts`)

`bridge.loginWithBunker(bunkerUrl, options)` accepts an optional
`clientSecretHex` so the host can hand it the SDK's pre-paired
identity:

```ts
await nostrActions.loginWithBunker(bunkerUri, {
  clientSecretHex: nsecToSkHex(clientNsec),
});
```

Without that, the bridge's fresh `generateSecretKey()` produces a
client pubkey the remote signer never authorized → `connect` request
rejected ("no secret"). The bridge persists `bunkerLocalSecretHex`
either way, so silent rehydrate on reload still works.

`src/app/app/LoginModal.tsx` wires this together: it pulls
`{ nsec, bunkerUri, clientNsec }` out of `onLogin`, decodes
nsec → hex via `nostr-tools/nip19`, and routes to the corresponding
bridge entrypoint.

## Migration history — obelisk-dex login modal

**Decided 2026-05-04, shipped 2026-05-07.** `src/app/app/LoginModal.tsx`
now wraps the SDK's `<LoginModal>` and forwards `onLogin` extras to the
bridge (see "Fork-only API" above). The bridge stays authoritative for
session state — the SDK only owns the login UI and signer construction.

**Distribution model while pre-release:** `file:../nostr-wot-sdk/packages/*`
deps (npm 9 symlinks). Rebuild SDK → consumer picks it up on next
request. No `npm install` between iterations. Switch to `@nostr-wot/*`
from npm once the changes on `Fabricio333/nostr-wot-sdk` land upstream
and a version is published.

### Sibling project (`../obelisk`)

Already on the published `@nostr-wot/{ui,signers,data}` from npm via
`SdkLoginModal.tsx`. To iterate on unreleased fork changes from there,
swap its npm deps to the same `file:../nostr-wot-sdk/packages/*` paths
temporarily — see `obelisk/docs/nostr-wot-sdk-fork.md`.

## Cleanup if you're done with the fork

```bash
# Delete the local clone:
rm -rf ../nostr-wot-sdk
# Drop the file: deps from each consumer's package.json + npm install.
# Delete the fork on GitHub (irreversible):
gh repo delete Fabricio333/nostr-wot-sdk --yes
```
