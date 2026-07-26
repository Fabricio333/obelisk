/**
 * Phase 3 contract: the whitelist preflight surfaces a rejection within
 * ~1.5s — well before the 4s deferred soak the rest of the fan-out uses.
 *
 * Seeds a fresh nsec onto the restricted relay (default
 * `wss://lacrypta-relay.obelisk.ar`, overridable via `OBELISK_E2E_RESTRICTED_RELAY`),
 * then asserts `[data-testid="relay-access-banner"]` flips to
 * `data-state="restricted"` (or `auth-required`) within 3500ms — under
 * the legacy 4000ms soak.
 *
 * Run with the restricted relay (default is provided):
 *   npm run test:e2e -- scripts/e2e/whitelist-rejection.spec.ts
 *
 * Or override:
 *   OBELISK_E2E_RESTRICTED_RELAY=wss://your.relay npm run test:e2e
 */
import { test, expect } from '@playwright/test';
import {
  attachClientCapture,
  DEFAULT_RESTRICTED_RELAY,
  generateIdentity,
  logObserved,
  logOk,
  logStep,
  restrictedNsecSession,
  seedSession,
} from './lib';

const RESTRICTED_RELAY = process.env.OBELISK_E2E_RESTRICTED_RELAY ?? DEFAULT_RESTRICTED_RELAY;

test('preflight surfaces whitelist rejection within ~1.5s (no 4s soak)', async ({ page, context }) => {
  test.setTimeout(60_000);

  logStep(
    'Seed identity + restricted relay',
    `Fresh nsec → ${RESTRICTED_RELAY}; preflight should flip relay-access to restricted/auth-required quickly.`,
  );
  const id = generateIdentity();
  await seedSession(context, restrictedNsecSession(id));
  logObserved(`npub  ${id.npub}`);
  logObserved(`relay ${RESTRICTED_RELAY}`);
  attachClientCapture(page);

  const start = Date.now();
  await page.goto('/app', { waitUntil: 'domcontentloaded' });

  // Banner with data-state in {restricted, auth-required}. The
  // immediate-downgrade path bypasses the 4s soak, so we give the
  // assertion a 3.5s budget — under the soak.
  const banner = page.locator('[data-testid="relay-access-banner"]').first();
  await banner.waitFor({ state: 'visible', timeout: 5_000 });
  const observed = await banner.getAttribute('data-state');
  const elapsed = Date.now() - start;
  logObserved(`relay-access banner state=${observed} after ${elapsed}ms`);

  expect(observed === 'restricted' || observed === 'auth-required').toBeTruthy();
  // Soft assertion: the preflight should land well under 4000ms (the
  // legacy soak). Allow up to 3500ms for navigation + cold-handshake.
  expect(elapsed).toBeLessThan(3500);
  logOk(`whitelist rejection surfaced in ${elapsed}ms — under 4s soak`);
});
