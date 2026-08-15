# Post-Quantum DMs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show users whether their DMs are quantum-safe, per conversation and per message, and send post-quantum DMs when the signer supports it.

**Architecture:** A new `src/lib/pq/` module owns all post-quantum state: attestation lookup with a stale-while-revalidate cache, capability detection, and a pure status layer. Protocol knowledge (kinds, envelope format, parsing) comes from `@nostr-wot/pq`; Obelisk holds none of its own. The only change to the 6,848-line bridge is widening `nip44Encrypt` to pass post-quantum options through on the nip07 path.

**Tech Stack:** Next.js 16, TypeScript, Zustand, Vitest + React Testing Library, `@nostr-wot/pq`, `nostr-tools`.

**Spec:** `docs/superpowers/specs/2026-08-15-post-quantum-dms-design.md`

## Global Constraints

- **Obelisk never holds post-quantum secret key material.** Key custody stays in the extension. No key-file import, nothing in `localStorage`.
- **Obelisk never derives post-quantum keys.** It has no BIP-39 seed. `derivePqKeys()` must not be called anywhere in `src/`.
- **Never block a send.** When a conversation cannot be quantum-secured, the message still sends over classic NIP-17/NIP-04.
- Post-quantum encryption is reachable **only** on `loginMethod === 'nip07'`. `nsec` and `bunker` get detection and indicators only.
- Attestation kind is `10203`, from `PQC_KIND` in `@nostr-wot/pq` — never hardcode the number.
- Locales are **en** and **es** only. Every user-facing string needs both.
- `vitest.config.ts` inlines `@nostr-wot/*`. Any `vi.mock` of a module that `@nostr-wot/pq` imports depends on this.

---

### Task 1: Dependency and the pure status layer

**Files:**
- Modify: `package.json`
- Create: `src/lib/pq/status.ts`
- Test: `src/lib/pq/status.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PqConversationStatus = 'secured' | 'not-secured'`; `type PqMessageMark = 'no-giftwrap' | 'no-pq' | null`; `conversationStatus(input: ConversationStatusInput): PqConversationStatus`; `messageMark(input: MessageMarkInput): PqMessageMark`.

- [ ] **Step 1: Add the dependency**

```bash
npm install @nostr-wot/pq@^0.2.1
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/pq/status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { conversationStatus, messageMark } from './status';

describe('conversationStatus', () => {
  const on = { enabled: true, selfHasKeys: true, peerHasKeys: true };

  it('is secured only when the preference is on and both parties advertise keys', () => {
    expect(conversationStatus(on)).toBe('secured');
  });

  it('is not secured when the preference is off, even if both have keys', () => {
    expect(conversationStatus({ ...on, enabled: false })).toBe('not-secured');
  });

  it('is not secured when the peer has no keys', () => {
    expect(conversationStatus({ ...on, peerHasKeys: false })).toBe('not-secured');
  });

  it('is not secured when we have no keys', () => {
    expect(conversationStatus({ ...on, selfHasKeys: false })).toBe('not-secured');
  });
});

describe('messageMark', () => {
  it('marks a nip04 message as not gift-wrapped', () => {
    expect(messageMark({ protocol: 'nip04', pq: false })).toBe('no-giftwrap');
  });

  it('marks a nip17 message without a post-quantum envelope', () => {
    expect(messageMark({ protocol: 'nip17', pq: false })).toBe('no-pq');
  });

  it('leaves a post-quantum nip17 message unmarked', () => {
    expect(messageMark({ protocol: 'nip17', pq: true })).toBeNull();
  });

  it('treats an undefined pq flag as not post-quantum', () => {
    expect(messageMark({ protocol: 'nip17', pq: undefined })).toBe('no-pq');
  });

  it('prefers the gift-wrap mark when a nip04 message is somehow flagged pq', () => {
    expect(messageMark({ protocol: 'nip04', pq: true })).toBe('no-giftwrap');
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/lib/pq/status.test.ts`
Expected: FAIL — `Failed to resolve import "./status"`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/pq/status.ts`:

```ts
import type { DMProtocol } from '@/store/dm';

/** Whether a conversation can carry post-quantum protection right now. */
export type PqConversationStatus = 'secured' | 'not-secured';

/**
 * What a single message lacked. `null` means it lacked nothing — only
 * deficient messages are marked, so a healthy thread stays quiet.
 */
export type PqMessageMark = 'no-giftwrap' | 'no-pq' | null;

export interface ConversationStatusInput {
  /** The `postQuantumEnabled` preference. */
  enabled: boolean;
  /** We advertise a usable post-quantum attestation. */
  selfHasKeys: boolean;
  /** The peer advertises a usable post-quantum attestation. */
  peerHasKeys: boolean;
}

export interface MessageMarkInput {
  protocol: DMProtocol;
  pq: boolean | undefined;
}

/**
 * Capability-and-configuration state, deliberately not a claim about the
 * messages already in the thread. We can verify a peer published an
 * attestation; we cannot verify their client uses it.
 */
export function conversationStatus(input: ConversationStatusInput): PqConversationStatus {
  const { enabled, selfHasKeys, peerHasKeys } = input;
  return enabled && selfHasKeys && peerHasKeys ? 'secured' : 'not-secured';
}

export function messageMark(input: MessageMarkInput): PqMessageMark {
  // Gift-wrap is the stronger claim: a nip04 message leaks metadata to relays
  // whatever its payload, so that mark wins.
  if (input.protocol === 'nip04') return 'no-giftwrap';
  return input.pq === true ? null : 'no-pq';
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/lib/pq/status.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/pq/status.ts src/lib/pq/status.test.ts
git commit -m "pq: add the pure post-quantum status layer"
```

---

### Task 2: Attestation lookup with a stale-while-revalidate cache

**Files:**
- Create: `src/lib/pq/attestations.ts`
- Test: `src/lib/pq/attestations.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `hasUsableKeys(pubkey: string): Promise<boolean>`; `getAttestation(pubkey: string): Promise<PqAttestation | null>`; `clearAttestationCache(): void`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pq/attestations.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const querySync = vi.fn();
vi.mock('@/lib/nostr-bridge/client', () => ({
  getBridgeSync: () => ({ pool: { querySync }, relays: ['wss://r.example'] }),
}));

import { getAttestation, hasUsableKeys, clearAttestationCache } from './attestations';

const PUBKEY = 'a'.repeat(64);

// A well-formed kind:10203 carrying a 1568-byte ML-KEM key, base64-encoded.
function attestationEvent(pubkey = PUBKEY) {
  const kem = Buffer.from(new Uint8Array(1568).fill(7)).toString('base64');
  return {
    id: 'e'.repeat(64),
    pubkey,
    kind: 10203,
    created_at: 1_700_000_000,
    tags: [
      ['profile', 'nip-pqc/v1'],
      ['kem', 'ml-kem-1024', kem],
    ],
    content: '',
  };
}

beforeEach(() => {
  clearAttestationCache();
  querySync.mockReset();
});

describe('getAttestation', () => {
  it('returns a parsed attestation when the relay has one', async () => {
    querySync.mockResolvedValue([attestationEvent()]);
    const att = await getAttestation(PUBKEY);
    expect(att?.pubkey).toBe(PUBKEY);
    expect(att?.usable).toBe(true);
  });

  it('returns null when the relay has none', async () => {
    querySync.mockResolvedValue([]);
    expect(await getAttestation(PUBKEY)).toBeNull();
  });

  it('serves the second call from cache without re-querying', async () => {
    querySync.mockResolvedValue([attestationEvent()]);
    await getAttestation(PUBKEY);
    await getAttestation(PUBKEY);
    expect(querySync).toHaveBeenCalledTimes(1);
  });

  it('returns null and does not throw when the relay query fails', async () => {
    querySync.mockRejectedValue(new Error('relay down'));
    expect(await getAttestation(PUBKEY)).toBeNull();
  });
});

describe('hasUsableKeys', () => {
  it('is true for a usable attestation', async () => {
    querySync.mockResolvedValue([attestationEvent()]);
    expect(await hasUsableKeys(PUBKEY)).toBe(true);
  });

  it('is false when there is no attestation', async () => {
    querySync.mockResolvedValue([]);
    expect(await hasUsableKeys(PUBKEY)).toBe(false);
  });

  it('is false when the attestation carries no usable KEM key', async () => {
    const bad = attestationEvent();
    bad.tags = [['profile', 'nip-pqc/v1']];
    querySync.mockResolvedValue([bad]);
    expect(await hasUsableKeys(PUBKEY)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/pq/attestations.test.ts`
Expected: FAIL — `Failed to resolve import "./attestations"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pq/attestations.ts`:

```ts
'use client';

import { attestationFilter, parseAttestation, type PqAttestation } from '@nostr-wot/pq';
import { getBridgeSync } from '@/lib/nostr-bridge/client';

/** How long a looked-up attestation stays fresh. Attestations are replaceable
 *  events that change rarely, so this is generous on purpose. */
const TTL_MS = 6 * 60 * 60 * 1000;

interface Entry {
  attestation: PqAttestation | null;
  fetchedAt: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<PqAttestation | null>>();

export function clearAttestationCache(): void {
  cache.clear();
  inflight.clear();
}

async function fetchAttestation(pubkey: string): Promise<PqAttestation | null> {
  const bridge = getBridgeSync();
  if (!bridge) return null;
  try {
    const events = await bridge.pool.querySync(bridge.relays, attestationFilter([pubkey]));
    if (!events?.length) return null;
    // Replaceable kind: the newest wins.
    const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    return parseAttestation(newest);
  } catch {
    // A relay failure is not evidence of absence, but the caller needs an
    // answer now. Cache it briefly and let the TTL retry.
    return null;
  }
}

export async function getAttestation(pubkey: string): Promise<PqAttestation | null> {
  const hit = cache.get(pubkey);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.attestation;

  const existing = inflight.get(pubkey);
  if (existing) return existing;

  const promise = fetchAttestation(pubkey)
    .then((attestation) => {
      cache.set(pubkey, { attestation, fetchedAt: Date.now() });
      return attestation;
    })
    .finally(() => {
      inflight.delete(pubkey);
    });

  inflight.set(pubkey, promise);
  return promise;
}

/** Whether this pubkey advertises post-quantum keys we could encrypt to. */
export async function hasUsableKeys(pubkey: string): Promise<boolean> {
  const att = await getAttestation(pubkey);
  return att?.usable === true;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/pq/attestations.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pq/attestations.ts src/lib/pq/attestations.test.ts
git commit -m "pq: look up and cache kind:10203 attestations"
```

---

### Task 3: Capability detection

**Files:**
- Create: `src/lib/pq/capability.ts`
- Test: `src/lib/pq/capability.test.ts`

**Interfaces:**
- Consumes: `hasUsableKeys` from Task 2.
- Produces: `signerSupportsPq(): boolean`; `selfPqState(pubkey: string | null, loginMethod: string | null): Promise<SelfPqState>` where `interface SelfPqState { canSend: boolean; hasKeys: boolean; attestationPublished: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pq/capability.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hasUsableKeys = vi.fn();
vi.mock('./attestations', () => ({ hasUsableKeys: (pk: string) => hasUsableKeys(pk) }));

import { signerSupportsPq, selfPqState } from './capability';

const PUBKEY = 'b'.repeat(64);

beforeEach(() => {
  hasUsableKeys.mockReset();
});

afterEach(() => {
  // @ts-expect-error test cleanup
  delete globalThis.window.nostr;
});

describe('signerSupportsPq', () => {
  it('is true when the extension advertises the pq scheme', () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['nip44', 'pq'] } };
    expect(signerSupportsPq()).toBe(true);
  });

  it('is false when the extension advertises schemes without pq', () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['nip44'] } };
    expect(signerSupportsPq()).toBe(false);
  });

  it('is false when there is no extension at all', () => {
    expect(signerSupportsPq()).toBe(false);
  });

  it('is false when the extension publishes no schemes marker', () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };
    expect(signerSupportsPq()).toBe(false);
  });
});

describe('selfPqState', () => {
  it('reports no keys when logged out', async () => {
    expect(await selfPqState(null, null)).toEqual({
      canSend: false, hasKeys: false, attestationPublished: false,
    });
  });

  it('can send on nip07 when the marker is present and keys are published', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { schemes: ['pq'] } };
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'nip07')).toEqual({
      canSend: true, hasKeys: true, attestationPublished: true,
    });
  });

  it('falls back to the attestation when the extension publishes no marker', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'nip07')).toEqual({
      canSend: true, hasKeys: true, attestationPublished: true,
    });
  });

  it('cannot send on nsec even with published keys', async () => {
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'nsec')).toEqual({
      canSend: false, hasKeys: true, attestationPublished: true,
    });
  });

  it('cannot send on bunker even with published keys', async () => {
    hasUsableKeys.mockResolvedValue(true);
    expect(await selfPqState(PUBKEY, 'bunker')).toEqual({
      canSend: false, hasKeys: true, attestationPublished: true,
    });
  });

  it('cannot send on nip07 when nothing is published', async () => {
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: {} };
    hasUsableKeys.mockResolvedValue(false);
    expect(await selfPqState(PUBKEY, 'nip07')).toEqual({
      canSend: false, hasKeys: false, attestationPublished: false,
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/pq/capability.test.ts`
Expected: FAIL — `Failed to resolve import "./capability"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pq/capability.ts`:

```ts
'use client';

import { hasUsableKeys } from './attestations';

interface Nip44WithSchemes {
  schemes?: string[];
}

interface MaybePqWindow {
  nostr?: { nip44?: Nip44WithSchemes };
}

export interface SelfPqState {
  /** We can actually encrypt post-quantum from this session. */
  canSend: boolean;
  /** We advertise usable post-quantum keys. */
  hasKeys: boolean;
  /** The kind:10203 attestation is on a relay. Currently identical to
   *  `hasKeys` — they diverge only once a signer can report keys it has
   *  not published. */
  attestationPublished: boolean;
}

/**
 * Whether the connected extension can encrypt post-quantum.
 *
 * Post-quantum is an optional third argument to `nip44.encrypt`, so a
 * supporting extension and an unaware one are shaped identically. The only
 * honest signal is an explicit marker. Until the extension ships one this
 * returns false, and `selfPqState` falls back to attestation presence.
 */
export function signerSupportsPq(): boolean {
  if (typeof window === 'undefined') return false;
  const schemes = (window as unknown as MaybePqWindow).nostr?.nip44?.schemes;
  return Array.isArray(schemes) && schemes.includes('pq');
}

export async function selfPqState(
  pubkey: string | null,
  loginMethod: string | null,
): Promise<SelfPqState> {
  if (!pubkey) return { canSend: false, hasKeys: false, attestationPublished: false };

  const published = await hasUsableKeys(pubkey);

  // Only the NIP-07 surface exposes post-quantum encryption. nsec has no seed
  // to derive from, and a bunker signs remotely with no post-quantum path.
  const viaExtension = loginMethod === 'nip07';

  // Until the extension publishes a capability marker there is nothing better
  // to go on than "this user has published post-quantum keys and is on a
  // NIP-07 session". Once `signerSupportsPq()` can return a real answer, this
  // becomes `viaExtension && published && signerSupportsPq()`.
  const canSend = viaExtension && published;

  return { canSend, hasKeys: published, attestationPublished: published };
}
```

`signerSupportsPq` is exported and tested now but deliberately not yet consulted by `selfPqState`: today it would always return false and would wrongly disable a working path. The test `falls back to the attestation when the extension publishes no marker` is what pins the current behaviour, and the test `is true when the extension advertises the pq scheme` is what will keep the marker path honest when it lands.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/pq/capability.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pq/capability.ts src/lib/pq/capability.test.ts
git commit -m "pq: detect whether this session can send post-quantum"
```

---

### Task 4: The `postQuantumEnabled` preference

**Files:**
- Modify: `src/lib/preferences.ts`
- Test: `src/lib/preferences.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: `Preferences.postQuantumEnabled: boolean`, default `true`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/preferences.test.ts` (create the file with these imports if it does not exist):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getPreferences, setPreference } from './preferences';

describe('postQuantumEnabled', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to true', () => {
    expect(getPreferences().postQuantumEnabled).toBe(true);
  });

  it('round-trips through setPreference', () => {
    setPreference('postQuantumEnabled', false);
    expect(getPreferences().postQuantumEnabled).toBe(false);
  });

  it('falls back to the default when storage holds a non-boolean', () => {
    localStorage.setItem('obelisk:preferences', JSON.stringify({ postQuantumEnabled: 'yes' }));
    expect(getPreferences().postQuantumEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/preferences.test.ts`
Expected: FAIL — `postQuantumEnabled` is `undefined`.

- [ ] **Step 3: Add the field to the interface**

In `src/lib/preferences.ts`, add to `interface Preferences` immediately after `directMessagesEnabled`:

```ts
  postQuantumEnabled: boolean;
```

- [ ] **Step 4: Add the default**

In the same file, add to `const DEFAULTS` immediately after `directMessagesEnabled: false,`:

```ts
  postQuantumEnabled: true,
```

Default on: the indicator is informational and sending degrades gracefully, so there is nothing to opt into that could surprise a user.

- [ ] **Step 5: Add normalization**

In `normalizePreferences`, add immediately after the `directMessagesEnabled` block:

```ts
    postQuantumEnabled: typeof raw.postQuantumEnabled === 'boolean'
      ? raw.postQuantumEnabled
      : DEFAULTS.postQuantumEnabled,
```

- [ ] **Step 6: Run the test and confirm it passes**

Run: `npx vitest run src/lib/preferences.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the settings toggle**

Find the settings surface that already renders the `directMessagesEnabled` switch:

```bash
grep -rn "directMessagesEnabled" src/components/settings/
```

Add a sibling row immediately after it, matching that row's markup exactly:

```tsx
<label className="flex items-center justify-between gap-3 py-2">
  <span>
    <span className="block text-sm">{t('settings.postQuantum')}</span>
    <span className="block text-xs opacity-70">{t('settings.postQuantumHint')}</span>
  </span>
  <input
    type="checkbox"
    checked={prefs.postQuantumEnabled}
    onChange={(e) => setPreference('postQuantumEnabled', e.target.checked)}
  />
</label>
```

Add to `src/i18n/locales/en.json` under `settings`:

```json
"postQuantum": "Post-quantum protection",
"postQuantumHint": "Use post-quantum encryption for direct messages when both people support it. Messages still send when they do not."
```

And to `src/i18n/locales/es.json` under `settings`:

```json
"postQuantum": "Protección post-cuántica",
"postQuantumHint": "Usa cifrado post-cuántico en los mensajes directos cuando ambas personas lo admitan. Los mensajes se envían igualmente cuando no."
```

- [ ] **Step 8: Run the settings tests**

Run: `npx vitest run src/components/settings`
Expected: PASS — existing settings tests still green with the new row present.

- [ ] **Step 9: Commit**

```bash
git add src/lib/preferences.ts src/lib/preferences.test.ts src/components/settings src/i18n/locales/en.json src/i18n/locales/es.json
git commit -m "pq: add the postQuantumEnabled preference and settings toggle"
```

---

### Task 5: Record post-quantum provenance on received messages

**Files:**
- Modify: `src/store/dm.ts` (the `DMMessage` interface)
- Modify: `src/lib/nostr-bridge/client.ts` (the NIP-17 receive path)
- Test: `src/store/dm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DMMessage.pq?: boolean`.

- [ ] **Step 1: Write the failing test**

Append to `src/store/dm.test.ts`:

```ts
import { isPqEnvelope } from '@nostr-wot/pq';

describe('DMMessage post-quantum provenance', () => {
  it('carries an optional pq flag', () => {
    const msg = {
      id: 'a', senderPubkey: 'b', recipientPubkey: 'c',
      content: 'hi', createdAt: 1, protocol: 'nip17' as const, pq: true,
    };
    expect(msg.pq).toBe(true);
  });

  it('recognises a non-post-quantum payload as classic', () => {
    expect(isPqEnvelope('AgreeAAAA')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/store/dm.test.ts`
Expected: FAIL — TypeScript rejects `pq` as an unknown property on the object literal.

- [ ] **Step 3: Add the field**

In `src/store/dm.ts`, add to `interface DMMessage` immediately after `protocol: DMProtocol;`:

```ts
  /**
   * True when the NIP-17 payload was a post-quantum envelope. Undefined on
   * messages decoded before this existed, which `messageMark` treats as
   * classic — the honest reading for a thread that predates the feature.
   */
  pq?: boolean;
```

- [ ] **Step 4: Set the flag on the receive path**

In `src/lib/nostr-bridge/client.ts`, find where a NIP-17 rumor is turned into a `DMMessage` (search for `protocol: 'nip17'`). Before decryption, capture the inner ciphertext and pass the flag through:

```ts
import { isPqEnvelope } from '@nostr-wot/pq';

// ...where the DMMessage is constructed from a decrypted NIP-17 rumor:
const pq = isPqEnvelope(innerCiphertext);
// then include `pq` in the DMMessage object literal alongside `protocol: 'nip17'`.
```

`innerCiphertext` is the NIP-44 payload string handed to `nip44Decrypt` for that rumor. Decryption itself needs no change: the payload is self-describing and the extension routes it.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/store/dm.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/dm.ts src/store/dm.test.ts src/lib/nostr-bridge/client.ts
git commit -m "pq: record post-quantum provenance on received messages"
```

---

### Task 6: Pass post-quantum options through the bridge on send

**Files:**
- Modify: `src/lib/nostr-bridge/client.ts:6346-6362`
- Test: `src/lib/nostr-bridge/bridge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `nip44Encrypt(recipientPubkey: string, plaintext: string, pqOpts?: { scheme: 'pq'; recipientKemKey: string }): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/nostr-bridge/bridge.test.ts`:

```ts
describe('nip44Encrypt post-quantum options', () => {
  it('forwards post-quantum options to the extension on nip07', async () => {
    const encrypt = vi.fn().mockResolvedValue('ciphertext');
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { encrypt } };

    const signer = makeSignerForLoginMethod('nip07');
    await signer.nip44Encrypt('a'.repeat(64), 'hello', {
      scheme: 'pq', recipientKemKey: 'BASE64KEM',
    });

    expect(encrypt).toHaveBeenCalledWith('a'.repeat(64), 'hello', {
      scheme: 'pq', recipientKemKey: 'BASE64KEM',
    });
  });

  it('omits the third argument entirely when no options are given', async () => {
    const encrypt = vi.fn().mockResolvedValue('ciphertext');
    // @ts-expect-error partial extension shape is enough here
    globalThis.window.nostr = { nip44: { encrypt } };

    const signer = makeSignerForLoginMethod('nip07');
    await signer.nip44Encrypt('a'.repeat(64), 'hello');

    expect(encrypt).toHaveBeenCalledWith('a'.repeat(64), 'hello');
  });
});
```

`makeSignerForLoginMethod` is the existing helper in that test file for building a signer bound to a login method. If it is named differently there, use the existing helper rather than adding one.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/nostr-bridge/bridge.test.ts`
Expected: FAIL — the third argument is dropped.

- [ ] **Step 3: Widen the signature and forward on the nip07 branch**

In `src/lib/nostr-bridge/client.ts`, change line 6346 from:

```ts
      nip44Encrypt: async (recipientPubkey, plaintext) => {
```

to:

```ts
      nip44Encrypt: async (recipientPubkey, plaintext, pqOpts) => {
```

and change the nip07 branch at line 6357 from:

```ts
          return w.nip44.encrypt(recipientPubkey, plaintext);
```

to:

```ts
          // Only the extension can encrypt post-quantum: it owns the seed the
          // ML-KEM key is derived from. Pass the options through untouched, and
          // omit the argument entirely when there are none so unaware
          // extensions see the exact two-argument call they always did.
          return pqOpts
            ? w.nip44.encrypt(recipientPubkey, plaintext, pqOpts)
            : w.nip44.encrypt(recipientPubkey, plaintext);
```

Leave the `nsec` and `bunker` branches untouched — they ignore `pqOpts` by construction.

- [ ] **Step 4: Update the signer type**

In the same file, extend the `nip44Encrypt` member of the signer interface (near line 49) to accept the optional third parameter:

```ts
  nip44Encrypt: (
    recipientPubkey: string,
    plaintext: string,
    pqOpts?: { scheme: 'pq'; recipientKemKey: string },
  ) => Promise<string>;
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/nostr-bridge/bridge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostr-bridge/client.ts src/lib/nostr-bridge/bridge.test.ts
git commit -m "pq: pass post-quantum options through nip44Encrypt on nip07"
```

---

### Task 7: The conversation notice and per-message marks

**Files:**
- Create: `src/components/chat/PqConversationNotice.tsx`
- Create: `src/components/chat/PqMessageMark.tsx`
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/es.json`
- Test: `src/components/chat/PqConversationNotice.test.tsx`

**Interfaces:**
- Consumes: `conversationStatus`, `messageMark` (Task 1); `PqConversationStatus`, `PqMessageMark` (Task 1).
- Produces: `<PqConversationNotice status={PqConversationStatus} guideHref={string} />`; `<PqMessageMark mark={PqMessageMark} />`.

- [ ] **Step 1: Add the strings**

In `src/i18n/locales/en.json` add:

```json
"pq": {
  "secured": "Quantum-secured",
  "securedDetail": "Both of you publish post-quantum keys, so messages sent from now on stay confidential even against a future quantum computer.",
  "notSecured": "Not quantum-safe",
  "notSecuredDetail": "This conversation can be recorded now and decrypted later, once a quantum computer breaks the classic key exchange.",
  "learnHow": "How to fix this",
  "markNoGiftwrap": "Not gift-wrapped — relays can see who you are talking to",
  "markNoPq": "Not quantum-safe"
}
```

In `src/i18n/locales/es.json` add:

```json
"pq": {
  "secured": "Protegido contra cuántica",
  "securedDetail": "Ambos publican claves post-cuánticas, así que los mensajes que envíen a partir de ahora seguirán siendo confidenciales incluso frente a una futura computadora cuántica.",
  "notSecured": "Sin protección cuántica",
  "notSecuredDetail": "Esta conversación se puede grabar ahora y descifrar más adelante, cuando una computadora cuántica rompa el intercambio de claves clásico.",
  "learnHow": "Cómo solucionarlo",
  "markNoGiftwrap": "Sin gift wrap — los relays pueden ver con quién hablas",
  "markNoPq": "Sin protección cuántica"
}
```

- [ ] **Step 2: Write the failing test**

Create `src/components/chat/PqConversationNotice.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import PqConversationNotice from './PqConversationNotice';

describe('PqConversationNotice', () => {
  it('shows the secured state without a guide link', () => {
    render(<PqConversationNotice status="secured" guideHref="/guides/en/quantum-safe-dms" />);
    expect(screen.getByText(/Quantum-secured/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the warning and links to the guide when not secured', () => {
    render(<PqConversationNotice status="not-secured" guideHref="/guides/en/quantum-safe-dms" />);
    expect(screen.getByText(/Not quantum-safe/i)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/guides/en/quantum-safe-dms');
  });
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run src/components/chat/PqConversationNotice.test.tsx`
Expected: FAIL — cannot resolve `./PqConversationNotice`.

- [ ] **Step 4: Write the components**

Create `src/components/chat/PqConversationNotice.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useTranslations } from '@/i18n';
import type { PqConversationStatus } from '@/lib/pq/status';

export default function PqConversationNotice({
  status,
  guideHref,
}: {
  status: PqConversationStatus;
  guideHref: string;
}) {
  const t = useTranslations();
  const secured = status === 'secured';

  return (
    <div
      role="status"
      className={
        secured
          ? 'flex items-center gap-2 px-3 py-2 text-xs text-emerald-300/90'
          : 'flex items-center gap-2 px-3 py-2 text-xs text-amber-300/90'
      }
    >
      <span className="font-medium">{secured ? t('pq.secured') : t('pq.notSecured')}</span>
      <span className="opacity-80">
        {secured ? t('pq.securedDetail') : t('pq.notSecuredDetail')}
      </span>
      {!secured && (
        <Link href={guideHref} className="underline underline-offset-2">
          {t('pq.learnHow')}
        </Link>
      )}
    </div>
  );
}
```

Create `src/components/chat/PqMessageMark.tsx`:

```tsx
'use client';

import { useTranslations } from '@/i18n';
import type { PqMessageMark as Mark } from '@/lib/pq/status';

export default function PqMessageMark({ mark }: { mark: Mark }) {
  const t = useTranslations();
  if (mark === null) return null;

  return (
    <span className="text-[10px] uppercase tracking-wide opacity-60" data-testid="pq-mark">
      {mark === 'no-giftwrap' ? t('pq.markNoGiftwrap') : t('pq.markNoPq')}
    </span>
  );
}
```

Use the project's existing translation hook. If `useTranslations` is not the correct import for this codebase, match whatever `src/components/chat/MessageContent.tsx` already uses.

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npx vitest run src/components/chat/PqConversationNotice.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/PqConversationNotice.tsx src/components/chat/PqMessageMark.tsx src/components/chat/PqConversationNotice.test.tsx src/i18n/locales/en.json src/i18n/locales/es.json
git commit -m "pq: add the conversation notice and per-message marks"
```

---

### Task 8: The onboarding guide

**Files:**
- Create: `content/guides/en/quantum-safe-dms.mdx`
- Create: `content/guides/es/quantum-safe-dms.mdx`
- Create: `src/components/guides/svg/QuantumSafeHero.tsx`
- Modify: the `HERO_REGISTRY` map and `src/components/guides/svg/asset-meta.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: guide slug `quantum-safe-dms` in both locales, hero component key `quantum-safe`.

- [ ] **Step 1: Write the English guide**

Create `content/guides/en/quantum-safe-dms.mdx`:

```mdx
---
title: Making your DMs quantum-safe
description: Encrypted messages you send today can be recorded now and read years from now, once a quantum computer breaks the key exchange Nostr uses. This is the one part of the problem you can fix in advance, and there are two ways to do it.
heroComponent: quantum-safe
publishedAt: '2026-08-15'
updatedAt: '2026-08-15'
tags: [security, post-quantum, direct-messages, encryption]
---

## Why this matters now

Nostr's encrypted messages derive their key from secp256k1, the same elliptic curve that secures your identity. Anyone can copy an encrypted message off a public relay today and simply keep it. The day a quantum computer can break that curve, everything they kept becomes readable.

This is called **harvest now, decrypt later**, and it is the only half of the quantum problem you can fix ahead of time. A message protected today stays protected permanently, whenever the break arrives. Forgery is different — nobody can forge your signature until the break happens, so that gets fixed when the whole network moves.

Post-quantum keys close the confidentiality half. The protection is **hybrid**: the post-quantum secret is combined with today's ordinary key, so it is never weaker than what you already have.

## Two ways to get post-quantum keys

### A new account from a 24-word phrase

The cleanest option if you are starting fresh. Your post-quantum keys are derived from the same recovery phrase as your Nostr key, as *siblings* rather than children. That has a specific consequence worth understanding: if someone breaks your Nostr key, they still cannot reach your post-quantum keys, because the derivation only runs one way. One phrase restores both.

It has to be **24 words**. A 12-word phrase carries 128 bits of entropy, which would make the phrase itself the weakest part of the system rather than the cryptography.

Nothing extra to back up: your existing phrase already covers it.

### Attach an independent identity to the npub you already have

If you already have an npub you do not want to abandon — or you imported it from an `nsec` and have no phrase to derive from — you can generate a post-quantum key pair locally and attach it to your existing account.

Your npub does not change. Your follows, your history, your identity all stay exactly as they are. The extension generates the key pair offline and publishes an attestation signed by your existing key, which is what tells other people your account can receive post-quantum messages.

The trade-off: this key **cannot be recovered from your recovery phrase**, because it was never derived from it. It needs its own separate backup. Store it the way you store the phrase itself.

## How to set it up

Both paths run through the [Nostr WoT extension](https://nostr-wot.com), which owns your keys. Obelisk never sees them — it only reads the public attestation that says your account has post-quantum keys, which is why the notice can tell you whether a conversation is protected.

Once your attestation is published, any conversation where the other person also has post-quantum keys shows as quantum-secured, and messages you send from then on carry the stronger protection.

## Reading the marks

A conversation you have had for a while will contain messages of different kinds, because both of you may have used several clients over the years. Each message is marked for what it actually had:

- **Not gift-wrapped** — an older NIP-04 message. The contents are encrypted, but relays can see who you were talking to.
- **Not quantum-safe** — a modern gift-wrapped message, but without post-quantum protection. Safe today, harvestable for later.
- **No mark** — gift-wrapped and post-quantum. Nothing to flag.

Only the messages that lack something are marked, so a healthy conversation stays quiet.
```

- [ ] **Step 2: Write the Spanish guide**

Create `content/guides/es/quantum-safe-dms.mdx`. The slug must stay identical so `guideHref` resolves in both locales. Frontmatter, verbatim:

```mdx
---
title: Cómo proteger tus mensajes contra la computación cuántica
description: Los mensajes cifrados que envías hoy se pueden grabar ahora y leer dentro de unos años, cuando una computadora cuántica rompa el intercambio de claves que usa Nostr. Esta es la única parte del problema que puedes resolver por adelantado, y hay dos formas de hacerlo.
heroComponent: quantum-safe
publishedAt: '2026-08-15'
updatedAt: '2026-08-15'
tags: [seguridad, post-cuantico, mensajes-directos, cifrado]
---
```

Then translate the English body section by section, keeping the same headings and the same three-item mark list at the end. Two terms to keep consistent with the UI strings from Task 7: use **"Sin protección cuántica"** for "not quantum-safe" and **"Sin gift wrap"** for "not gift-wrapped", so the guide and the in-app marks read as the same vocabulary.

- [ ] **Step 3: Create the hero component**

Read `src/components/guides/svg/WotHero.tsx` first and match its export shape, `viewBox` convention and prop signature exactly. Then create `src/components/guides/svg/QuantumSafeHero.tsx`:

```tsx
export default function QuantumSafeHero() {
  return (
    <svg viewBox="0 0 640 320" role="img" aria-label="A message sealed by two layers of protection" className="w-full h-auto">
      {/* Outer shell: the post-quantum layer wrapping the classic one. */}
      <rect x="40" y="60" width="560" height="200" rx="24"
            fill="none" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="2" />
      <rect x="90" y="100" width="460" height="120" rx="16"
            fill="none" stroke="var(--accent)" strokeOpacity="0.7" strokeWidth="2" />
      <circle cx="320" cy="160" r="26" fill="var(--accent)" fillOpacity="0.15"
              stroke="var(--accent)" strokeWidth="2" />
      <path d="M310 158v-8a10 10 0 0 1 20 0v8" fill="none"
            stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
      <rect x="308" y="158" width="24" height="18" rx="4" fill="var(--accent)" fillOpacity="0.8" />
    </svg>
  );
}
```

If `WotHero.tsx` takes props or uses a different CSS variable than `--accent`, follow it rather than the sketch above — the surrounding conventions win.

- [ ] **Step 4: Register the hero**

Add the component to `HERO_REGISTRY` under the key `quantum-safe` (find the registry via `grep -rn "HERO_REGISTRY" src/components/guides/`), and add a matching entry to `HERO_ASSET_META` in `src/components/guides/svg/asset-meta.ts` following the shape of the entries already there.

- [ ] **Step 5: Verify both guides load**

Run: `npx vitest run src/lib/guides.test.ts`
Expected: PASS — the guide loader picks up the new slug in both locales.

- [ ] **Step 6: Run the full suite and build**

```bash
npx vitest run
npm run build
```

Expected: all tests pass; build clean; `/guides/en/quantum-safe-dms` and `/guides/es/quantum-safe-dms` appear in the route list.

- [ ] **Step 7: Commit**

```bash
git add content/guides/en/quantum-safe-dms.mdx content/guides/es/quantum-safe-dms.mdx src/components/guides/svg/QuantumSafeHero.tsx src/components/guides/svg/asset-meta.ts
git commit -m "pq: add the quantum-safe DMs guide in both locales"
```

---

## Wiring note for the executor

Tasks 1-8 build the pieces. The final wiring — mounting `PqConversationNotice` in the DM view and `PqMessageMark` in the message list, and calling `selfPqState`/`hasUsableKeys` to feed them — belongs to whichever component owns the DM thread view. Find it via `grep -rn "activeDMPubkey" src/app/app/`, and follow the loading conventions already in that component rather than introducing new ones. Add the wiring as a ninth commit once the pieces are green.
