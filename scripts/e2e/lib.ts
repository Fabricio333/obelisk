/**
 * E2E harness for obelisk-dex.
 *
 * Goal: drive a real browser against a running app (local dev or
 * production) with a fresh nsec identity, log everything the client does
 * (console, websocket frames, relay-access state transitions, activity
 * indicator entries, toasts), and assert each step against the contract
 * documented in `docs/data-system.md`.
 *
 * The harness skips the LoginModal: it seeds the bridge's persisted-
 * session shape directly into `localStorage` before the page loads, so
 * `BridgeImpl.initialize()` rehydrates as if the user had already logged
 * in via nsec. The persisted shape is the same one the bridge writes
 * itself in `finalizeLogin → persist()`.
 *
 * See `scripts/e2e/README.md` for usage.
 */

import type { Page, BrowserContext, ConsoleMessage } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';

// Mirror of `src/lib/nostr-bridge/client.ts` constants. Duplicated rather
// than imported because the harness runs under Node and the bridge module
// pulls a chain of browser-only deps.
export const STORAGE_KEY = 'obelisk-dex/session';
export const RELAYS_KEY = 'obelisk-dex/relays';
export const DEFAULT_RELAY = 'wss://public.obelisk.ar';

/** Whitelist-rejection specs use this restricted relay by default. */
export const DEFAULT_RESTRICTED_RELAY = 'wss://lacrypta-relay.obelisk.ar';

export interface PersistedSession {
  privKeyHex?: string;
  pubKeyHex: string;
  relayUrl: string;
  loginMethod: 'nsec' | 'nip07' | 'bunker';
  bunkerUrl?: string;
  bunkerLocalSecretHex?: string;
}

export interface FreshIdentity {
  skHex: string;
  pkHex: string;
  nsec: string;
  npub: string;
}

/** Generate a fresh keypair. Never used to sign anything outside the test. */
export function generateIdentity(): FreshIdentity {
  const sk = generateSecretKey();
  const skHex = Array.from(sk).map((b) => b.toString(16).padStart(2, '0')).join('');
  const pkHex = getPublicKey(sk);
  return {
    skHex,
    pkHex,
    nsec: nip19.nsecEncode(sk),
    npub: nip19.npubEncode(pkHex),
  };
}

/** Build an nsec PersistedSession ready to write to localStorage. */
export function nsecSession(id: FreshIdentity, relayUrl = DEFAULT_RELAY): PersistedSession {
  return {
    privKeyHex: id.skHex,
    pubKeyHex: id.pkHex,
    relayUrl,
    loginMethod: 'nsec',
  };
}

/**
 * Seed the bridge's localStorage entries before the first page load.
 * Uses `addInitScript` so the values are present in *every* document
 * served by this context, including reloads. Storage is per-origin, so
 * the `baseURL` of the test target governs which origin gets seeded.
 */
export async function seedSession(
  context: BrowserContext,
  session: PersistedSession,
): Promise<void> {
  const sessionJson = JSON.stringify(session);
  const relaysJson = JSON.stringify([session.relayUrl]);
  await context.addInitScript(
    ({ key, relaysKey, sessionJson, relaysJson }) => {
      try {
        window.localStorage.setItem(key, sessionJson);
        window.localStorage.setItem(relaysKey, relaysJson);
      } catch {
        // Private mode etc. — let the test fail with a clearer message
        // when the bridge can't rehydrate.
      }
    },
    { key: STORAGE_KEY, relaysKey: RELAYS_KEY, sessionJson, relaysJson },
  );
}

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

const dim = '\x1b[2m';
const reset = '\x1b[0m';
const cyan = '\x1b[36m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const green = '\x1b[32m';
const magenta = '\x1b[35m';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

export function logStep(name: string, expectation: string): void {
  // eslint-disable-next-line no-console
  console.log(`\n${cyan}▸ ${name}${reset} ${dim}— expected:${reset} ${expectation}`);
}

export function logObserved(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${dim}${ts()}${reset} ${line}`);
}

export function logOk(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${green}✓${reset} ${line}`);
}

export function logWarn(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${yellow}!${reset} ${line}`);
}

export function logFail(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`  ${red}✗${reset} ${line}`);
}

// ---------------------------------------------------------------------------
// Browser capture
// ---------------------------------------------------------------------------

export interface ClientCapture {
  console: Array<{ type: string; text: string; at: string }>;
  ws: Array<{ direction: 'send' | 'recv'; payload: string; at: string }>;
  /** Detach all listeners. */
  detach: () => void;
}

/**
 * Attach console + websocket capture to a Page. Console messages are
 * mirrored to the host process's stdout (so they interleave with test
 * output), and every Nostr-shaped frame is also dumped — so a relay's
 * AUTH challenge or NOTICE shows up live.
 */
export function attachClientCapture(page: Page, opts?: { mirror?: boolean }): ClientCapture {
  const mirror = opts?.mirror ?? true;
  const cap: ClientCapture = {
    console: [],
    ws: [],
    detach: () => undefined,
  };

  const onConsole = (msg: ConsoleMessage) => {
    const entry = { type: msg.type(), text: msg.text(), at: ts() };
    cap.console.push(entry);
    if (mirror) {
      const color =
        entry.type === 'error' ? red : entry.type === 'warning' ? yellow : dim;
      // eslint-disable-next-line no-console
      console.log(`    ${color}console.${entry.type}${reset} ${entry.text}`);
    }
  };
  page.on('console', onConsole);

  const onPageError = (err: Error) => {
    cap.console.push({ type: 'pageerror', text: err.message, at: ts() });
    if (mirror) {
      // eslint-disable-next-line no-console
      console.log(`    ${red}pageerror${reset} ${err.message}`);
    }
  };
  page.on('pageerror', onPageError);

  page.on('websocket', (ws) => {
    const url = ws.url();
    if (mirror) logObserved(`${magenta}ws open${reset} ${url}`);
    ws.on('framesent', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      cap.ws.push({ direction: 'send', payload: text, at: ts() });
      if (mirror) maybeLogNostrFrame('send', url, text);
    });
    ws.on('framereceived', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8');
      cap.ws.push({ direction: 'recv', payload: text, at: ts() });
      if (mirror) maybeLogNostrFrame('recv', url, text);
    });
    ws.on('close', () => {
      if (mirror) logObserved(`${magenta}ws close${reset} ${url}`);
    });
  });

  cap.detach = () => {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  };

  return cap;
}

function maybeLogNostrFrame(direction: 'send' | 'recv', url: string, text: string): void {
  // Nostr frames are JSON arrays starting with the verb. Trim noise to
  // make the test log readable while still exposing AUTH / CLOSED / OK.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return;
  const verb = parsed[0];
  const interesting = new Set(['AUTH', 'CLOSED', 'NOTICE', 'OK', 'EOSE']);
  if (!interesting.has(verb)) return;
  const arrow = direction === 'send' ? '→' : '←';
  const host = (() => {
    try { return new URL(url).host; } catch { return url; }
  })();
  const tail = (() => {
    try { return JSON.stringify(parsed.slice(1)).slice(0, 200); } catch { return ''; }
  })();
  // eslint-disable-next-line no-console
  console.log(`    ${magenta}${arrow} ${verb}${reset} ${dim}${host}${reset} ${tail}`);
}

// ---------------------------------------------------------------------------
// DOM helpers — tied to the data-testids and labels in AppShell
// ---------------------------------------------------------------------------

export type RelayAccessUiState =
  | 'unknown'
  | 'authenticating'
  | 'auth-required'
  | 'restricted'
  | 'unreachable'
  | 'error'
  | 'ok';

/**
 * Read the current relay-access banner state from the DOM. Returns
 * `'ok'` when the banner is absent (the banner only renders for non-ok
 * access — see RelayAccessBanner).
 */
export async function getRelayAccessState(page: Page): Promise<RelayAccessUiState> {
  const banner = page.locator('[data-testid="relay-access-banner"]').first();
  if ((await banner.count()) === 0) return 'ok';
  const state = await banner.getAttribute('data-state');
  return (state as RelayAccessUiState) ?? 'unknown';
}

/**
 * Wait until the relay-access UI flips to `'ok'` (banner unmounts) or the
 * deadline elapses. Logs the trail of state transitions so a flaky relay
 * is visible in test output.
 */
export async function waitForRelayOk(page: Page, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: RelayAccessUiState | null = null;
  while (Date.now() < deadline) {
    const state = await getRelayAccessState(page);
    if (state !== last) {
      logObserved(`relay-access → ${stateChip(state)}`);
      last = state;
    }
    if (state === 'ok') return;
    await page.waitForTimeout(250);
  }
  throw new Error(`relay-access did not reach 'ok' within ${timeoutMs}ms (last=${last})`);
}

function stateChip(s: RelayAccessUiState): string {
  if (s === 'ok') return `${green}ok${reset}`;
  if (s === 'authenticating' || s === 'unknown') return `${yellow}${s}${reset}`;
  return `${red}${s}${reset}`;
}

/**
 * Locate a channel-row button in the sidebar by visible name. Channel
 * rows render as `# <name>`; category headers render as `▶/▼ NAME` and
 * are also buttons (collapse/expand) — matching them by name would
 * silently click a category, which is why we require the `#␣` prefix.
 *
 * Resolution order:
 *   1. Exact match on `# <name>` (case-insensitive).
 *   2. Substring match on `# …<name>…` (channels with emoji prefixes).
 *   3. First channel-row button on the page (last-resort fallback so
 *      tests can still drive a target on relays where the named
 *      channel doesn't exist).
 */
export async function findChannelByName(page: Page, name: string, timeoutMs = 15000) {
  // Channel-row markup: <button><span>#</span><span>{name}</span>…</button>.
  // textContent concatenates without separator, so the accessible text is
  // `#<name>` (no leading space). Categories are `▶NAME<n>`, so the `^#`
  // prefix uniquely identifies channel rows.
  const channelButtons = page.getByRole('button').filter({ hasText: /^#/ });
  const exact = channelButtons.filter({
    hasText: new RegExp(`^#\\s*${escapeRe(name)}\\s*$`, 'i'),
  });
  if ((await exact.count()) > 0) {
    await exact.first().waitFor({ state: 'visible', timeout: timeoutMs });
    return exact.first();
  }
  const loose = channelButtons.filter({ hasText: new RegExp(escapeRe(name), 'i') });
  if ((await loose.count()) > 0) {
    await loose.first().waitFor({ state: 'visible', timeout: 2000 });
    return loose.first();
  }
  await channelButtons.first().waitFor({ state: 'visible', timeout: 2000 });
  return channelButtons.first();
}

/** First channel-row button on the page (channels render as `# name`). */
export function firstChannelRow(page: Page) {
  return page.getByRole('button').filter({ hasText: /^#/ }).first();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the active session's PersistedSession scoped to a restricted relay.
 * Caller is responsible for `test.skip()`ing when no restricted relay is
 * available (see `whitelist-rejection.spec.ts`). The relay is read from
 * `OBELISK_E2E_RESTRICTED_RELAY` and defaults to {@link DEFAULT_RESTRICTED_RELAY}.
 */
export function restrictedNsecSession(id: FreshIdentity): PersistedSession {
  const relayUrl = process.env.OBELISK_E2E_RESTRICTED_RELAY ?? DEFAULT_RESTRICTED_RELAY;
  return {
    privKeyHex: id.skHex,
    pubKeyHex: id.pkHex,
    relayUrl,
    loginMethod: 'nsec',
  };
}

/**
 * Open the PreferencesPanel and click the "Clear local cache" button,
 * confirming the modal. The page is expected to reload as part of the
 * confirm action; the caller should wait for `domcontentloaded` again.
 */
export async function clearLocalCacheViaSettings(page: Page): Promise<void> {
  // The desktop chat header has a Settings icon (gear) that opens
  // UserPanel into the Preferences tab via `setSettingsTab('preferences')`.
  // Mobile lives behind the bottom-nav "you" tab → preferences.
  // The shared affordance: a `[data-testid="clear-cache-button"]` is in
  // PreferencesPanel regardless of how the user navigated there.
  //
  // Tests open the user-edit modal directly via the avatar pill on
  // desktop. We just rely on the button's testid being unique.
  const button = page.getByTestId('clear-cache-button');
  await button.waitFor({ state: 'visible', timeout: 10_000 });
  await button.click();
  const confirm = page.getByTestId('clear-cache-confirm-button');
  await confirm.waitFor({ state: 'visible', timeout: 2_000 });
  await confirm.click();
  // The implementation reloads via window.location.reload() after a small
  // pause. Wait for the next domcontentloaded so callers can assert the
  // post-clear state cleanly.
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Read a localStorage value as JSON. Returns `null` if the key is absent
 * or doesn't parse. Useful for cross-context cursor convergence asserts.
 */
export async function readLocalStorageJSON<T>(
  page: Page,
  key: string,
): Promise<T | null> {
  return page.evaluate((k) => {
    try {
      const raw = window.localStorage.getItem(k);
      if (raw === null) return null;
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }, key) as Promise<T | null>;
}

/**
 * Type into the channel composer and click Send. Resolves once the new
 * message is visible in the scroll list (matched by content).
 */
export async function sendMessageInActiveChannel(page: Page, content: string): Promise<void> {
  const composer = page.getByPlaceholder(/^Message #/i).first();
  await composer.waitFor({ state: 'visible', timeout: 10000 });
  await composer.click();
  await composer.fill(content);
  await page.getByRole('button', { name: /^Send$/ }).first().click();
  // Verify it lands in the scroll. nostr-tools publishes via SimplePool
  // and the relay echoes the kind 9 back to the same sub, so the
  // bridge's ingestMessage path should paint it within a few hundred ms
  // on a healthy relay.
  await page.getByText(content, { exact: false }).first().waitFor({
    state: 'visible',
    timeout: 15000,
  });
}
