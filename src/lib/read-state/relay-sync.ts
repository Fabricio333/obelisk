/**
 * Encrypted multi-device read-state sync over NIP-59 gift-wrapped events.
 *
 * Two scopes share the same engine:
 *   - **Groups state** (per relay): published to the SINGLE relay whose
 *     groups it tracks. Each cursor advance for a group "belonging to"
 *     that relay debounces a fresh wrap.
 *   - **DM state** (account-global): published to the union of read+write
 *     relays from the user's NIP-65 (kind 10002) list. DM cursors plus
 *     `inboxLastReadAt` ride together so the bell badge syncs across
 *     devices.
 *
 * Why NIP-59 and not "kind 30078 + NIP-44 self-encrypted":
 *   The relay sees only `kind:1059 from random pubkey #p=me` — same
 *   shape as a NIP-17 DM. There is no plaintext `d` tag, no app
 *   fingerprint, no replaceable-event slot announcing "this user has
 *   Obelisk read state on this relay." See docs/read-state.md.
 *
 * The downside (no event replacement) is mitigated by a 60-second
 * debounce — bursts of cursor advances during active reading collapse
 * into one wrap. Newest-wins on read; old wraps stay on the relay but
 * never affect correctness.
 */
import type { Filter } from 'nostr-tools';
import { getBridgeImpl } from '@/lib/nostr-bridge/client';
import { unwrapForSelf, wrapForSelf, type Rumor } from '@/lib/nip-59';
import { hasSeenWrap, markWrapSeen, type WrapLedgerScope } from '@/lib/nostr-bridge/wrap-ledger';
import { useReadStateStore, type RemoteReadState } from '@/store/read-state';
import { useNotificationsStore } from '@/store/notifications';
import { cacheGet, cacheSet } from '@/lib/nostr-bridge/cache';
import { KIND_GIFT_WRAP, KIND_NIP78_APP_DATA as KIND_INNER } from '@/lib/nip-kinds';

/** Inner rumor d-tag for groups-scope state events. */
export const D_TAG_GROUPS = 'obelisk:readstate:v1';
/** Inner rumor d-tag for DM-scope state events (also carries inboxLastReadAt). */
export const D_TAG_DMS = 'obelisk:dm-readstate:v1';

// 8s coalesces a burst of cursor advances during active reading without making
// the publish feel deferred. The previous 60s window collapsed against
// real-world usage: users read for less than a minute, then close the tab or
// navigate, and the cleanup cleared the pending timer before flush — so the
// gift wrap was never published and devices never converged. We now also
// flush eagerly on cleanup, visibilitychange→hidden, and pagehide so a partial
// debounce window doesn't lose the publish.
const DEBOUNCE_MS = 8_000;

/** Schema version for the JSON payload inside the rumor. */
const SCHEMA_VERSION = 1;

interface GroupsPayload {
  v: 1;
  groups: Record<string, { lastReadAt: number }>;
  /**
   * Relay-scoped mention read cursor (unix ms). Optional and additive —
   * `v` stays at 1 because older clients simply ignore the field and
   * newer ones treat its absence as "no remote cursor". Rides in the
   * groups-scope wrap because mentions are per-relay, exactly like the
   * group cursors around it.
   */
  mentionsReadAt?: number;
}

interface DmsPayload {
  v: 1;
  dms: Record<string, { lastReadAt: number }>;
  inboxLastReadAt: number;
}

function findInnerDTag(rumor: Rumor): string | null {
  const t = rumor.tags.find((t) => t[0] === 'd');
  return t?.[1] ?? null;
}

function parsePayload<T>(rumor: Rumor): T | null {
  try {
    const obj = JSON.parse(rumor.content) as { v?: number };
    if (obj.v !== SCHEMA_VERSION) return null;
    return obj as T;
  } catch {
    return null;
  }
}

interface SyncOptions {
  /** Where to subscribe + publish gift wraps. For groups-scope this is the
   * single home relay; for DM-scope this is the NIP-65 union. */
  readonly relays: ReadonlyArray<string>;
  /** Inner rumor d-tag — distinguishes groups state from DM state inside
   * the wrap. */
  readonly dTag: string;
  /** Cache key namespace under bridgeCache (per-relay). For DM scope there
   * are multiple relays — cache the merged snapshot under each one. */
  readonly cacheNamespace: string;
  /** Which slot of the wrap ledger this scope marks. Each consumer of the
   * kind-1059 stream tracks its own progress — see `wrap-ledger.ts`. */
  readonly ledgerScope: WrapLedgerScope;
}

/**
 * Subscribe to incoming gift wraps on `relays`, unwrap matching rumors,
 * and merge their cursors into the read-state store. Returns a cleanup
 * fn that closes the sub.
 */
function subscribeAndIngest<T>(
  opts: SyncOptions,
  apply: (payload: T, rumorCreatedAt: number) => void,
): () => void {
  const impl = getBridgeImpl();
  if (!impl) return () => {};
  // Background lane: read-state sync is invisible housekeeping. It must never
  // sit in front of a signature the user is waiting on. (`getNipSigner`
  // defaults to `interactive` because it also backs the zap/NWC flow.)
  const signer = impl.getNipSigner('background');
  if (!signer) return () => {};

  // Track newest seen so we don't re-apply older wraps that arrive late
  // from a different relay (DM scope subscribes to multiple relays).
  let newestApplied = 0;

  // Stale-while-revalidate: paint cached snapshot first.
  for (const relay of opts.relays) {
    const cached = cacheGet<{ payload: T; createdAt: number }>(
      relay, KIND_GIFT_WRAP, opts.dTag,
    );
    if (cached && cached.value.createdAt > newestApplied) {
      apply(cached.value.payload, cached.value.createdAt);
      newestApplied = cached.value.createdAt;
    }
  }

  const filter: Filter = {
    kinds: [KIND_GIFT_WRAP],
    '#p': [signer.pubkey],
  };

  const unsubFns: Array<() => void> = [];
  for (const relay of opts.relays) {
    const unsub = impl.subscribeFilterWatched(filter, async (ev) => {
      // The `#p`-only filter delivers every gift wrap addressed to us —
      // overwhelmingly NIP-17 DMs, which this scope opens (two signer
      // round-trips) only to discard on the `kind`/`d` checks below. Skip the
      // ones a previous session already classified.
      if (hasSeenWrap(opts.ledgerScope, ev.id)) return;
      const rumor = await unwrapForSelf(ev, signer);
      if (!rumor) return;
      // Marked before the filters, not after: "not my scope's rumor" is a
      // permanent property of an immutable event, and it is precisely the
      // verdict we don't want to re-buy every reload.
      markWrapSeen(opts.ledgerScope, ev.id);
      if (rumor.kind !== KIND_INNER) return;
      if (findInnerDTag(rumor) !== opts.dTag) return;
      if (rumor.created_at <= newestApplied) return;
      const payload = parsePayload<T>(rumor);
      if (!payload) return;
      apply(payload, rumor.created_at);
      newestApplied = rumor.created_at;
      cacheSet(relay, KIND_GIFT_WRAP, opts.dTag, {
        payload,
        createdAt: rumor.created_at,
      });
    }, { relays: [relay] });
    unsubFns.push(unsub);
  }
  return () => unsubFns.forEach((fn) => fn());
}

/**
 * Watch the read-state store for changes that affect this scope and
 * publish a fresh gift wrap, debounced. Returns a cleanup fn.
 *
 * `selectFingerprint` must produce a stable string from the parts of the
 * store that this scope cares about. Cursors-only changes that happen
 * outside this scope (e.g. another relay's groups when watching the
 * DM scope) won't trigger a publish.
 */
function watchAndPublish(
  opts: SyncOptions,
  selectFingerprint: () => string,
  buildPayload: () => unknown | null,
): () => void {
  const impl = getBridgeImpl();
  if (!impl) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFingerprint = selectFingerprint();
  // Tracks the fingerprint that was last *published*. On flush we bump it
  // forward; if cleanup/page-hide fires while the fingerprint matches the
  // last publish, there's nothing new to push.
  let lastPublishedFingerprint = lastFingerprint;
  // Groups-scope fingerprints span two stores (cursors in read-state, the
  // mention cursor in notifications), so both are watched.
  const watchedStores = [useReadStateStore, useNotificationsStore] as const;

  const flush = async () => {
    timer = null;
    // Background lane: read-state sync is invisible housekeeping. It must never
  // sit in front of a signature the user is waiting on. (`getNipSigner`
  // defaults to `interactive` because it also backs the zap/NWC flow.)
  const signer = impl.getNipSigner('background');
    if (!signer) return;
    const payload = buildPayload();
    if (!payload) return;
    const fpAtFlush = lastFingerprint;
    const wrap = await wrapForSelf(
      {
        kind: KIND_INNER,
        tags: [['d', opts.dTag]],
        content: JSON.stringify(payload),
        created_at: Math.floor(Date.now() / 1000),
      },
      signer,
    );
    try {
      await impl.publishEvent(wrap, {
        extraRelays: [...opts.relays],
        mode: 'replace',
      });
      lastPublishedFingerprint = fpAtFlush;
      // Update cache so a reload paints the freshly-published state
      // even before the relay ACKs it back.
      for (const relay of opts.relays) {
        cacheSet(relay, KIND_GIFT_WRAP, opts.dTag, {
          payload,
          createdAt: Math.floor(Date.now() / 1000),
        });
      }
    } catch {
      // Publish errors are best-effort; the next cursor advance will
      // schedule another attempt. Avoid surfacing transient relay errors.
    }
  };

  // Eager flush — fires immediately if there's a pending publish that hasn't
  // been sent yet. Used by cleanup, visibilitychange→hidden, and pagehide
  // so closing the tab or switching devices doesn't drop the publish.
  const flushNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastFingerprint === lastPublishedFingerprint) return;
    void flush();
  };

  const onStoreChange = () => {
    const fp = selectFingerprint();
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  };
  const storeUnsubs = watchedStores.map((s) => s.subscribe(onStoreChange));
  const unsub = () => storeUnsubs.forEach((fn) => fn());

  // Browser lifecycle hooks — flush before the page goes away so the
  // multi-device sync converges even when the user just closes the tab.
  // `pagehide` is the most reliable on mobile Safari (which often skips
  // `beforeunload`); `visibilitychange→hidden` covers tab switches and
  // app-switch on iOS PWA. Both are no-ops in non-browser environments
  // (tests, SSR).
  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') flushNow();
  };
  const onPageHide = () => flushNow();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide);
  }

  return () => {
    unsub();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', onPageHide);
    }
    flushNow();
  };
}

/**
 * Start syncing groups-scope state with one relay. Returns a cleanup
 * function that stops the subscription and cancels any pending publish.
 *
 * `groupIdsForRelay` is a snapshot of which group ids belong to this
 * relay — they're the only cursors we'll publish in this scope.
 * Pass an updated snapshot by re-mounting; the engine doesn't re-read it.
 */
export function startGroupsRelaySync(
  relayUrl: string,
  groupIdsForRelay: ReadonlyArray<string>,
): () => void {
  const ids = new Set(groupIdsForRelay);
  const opts: SyncOptions = {
    relays: [relayUrl],
    dTag: D_TAG_GROUPS,
    cacheNamespace: relayUrl,
    ledgerScope: 'readstate:groups',
  };

  const apply = (payload: GroupsPayload) => {
    const groupCursors: Record<string, number> = {};
    for (const [gid, entry] of Object.entries(payload.groups)) {
      if (!ids.has(gid)) continue;
      if (typeof entry?.lastReadAt === 'number') {
        groupCursors[gid] = entry.lastReadAt;
      }
    }
    if (Object.keys(groupCursors).length > 0) {
      useReadStateStore.getState().applyRemoteState({ groupCursors });
    }
    // Mention cursor converges across devices under the same max() rule as
    // the group cursors — dismiss the bell on desktop, it's dismissed on
    // the phone. Absent on wraps written by older clients.
    if (typeof payload.mentionsReadAt === 'number') {
      useNotificationsStore
        .getState()
        .applyRemoteMentionCursor(relayUrl, payload.mentionsReadAt);
    }
  };

  const unsubIngest = subscribeAndIngest(opts, apply);

  const fingerprintCursors = (cursors: Record<string, number>): string => {
    const parts: string[] = [];
    for (const gid of ids) {
      const v = cursors[gid];
      if (typeof v === 'number') parts.push(`${gid}:${v}`);
    }
    parts.sort();
    return parts.join('|');
  };

  const mentionCursor = (): number =>
    useNotificationsStore.getState().mentionCursorByRelay[relayUrl] ?? 0;

  const unsubPublish = watchAndPublish(
    opts,
    () =>
      `m:${mentionCursor()}|`
      + fingerprintCursors(useReadStateStore.getState().groupCursors),
    (): GroupsPayload | null => {
      const cursors = useReadStateStore.getState().groupCursors;
      const groups: Record<string, { lastReadAt: number }> = {};
      let any = false;
      for (const gid of ids) {
        const v = cursors[gid];
        if (typeof v === 'number' && v > 0) {
          groups[gid] = { lastReadAt: v };
          any = true;
        }
      }
      const mentionsReadAt = mentionCursor();
      if (!any && mentionsReadAt <= 0) return null;
      return mentionsReadAt > 0 ? { v: 1, groups, mentionsReadAt } : { v: 1, groups };
    },
  );

  return () => {
    unsubIngest();
    unsubPublish();
  };
}

/**
 * Start syncing DM-scope state to the user's NIP-65 relays. Inboxes
 * `inboxLastReadAt` rides along here.
 */
export function startDMRelaySync(relays: ReadonlyArray<string>): () => void {
  if (relays.length === 0) return () => {};
  const opts: SyncOptions = {
    relays,
    dTag: D_TAG_DMS,
    cacheNamespace: 'dm',
    ledgerScope: 'readstate:dms',
  };

  const apply = (payload: DmsPayload) => {
    const dmCursors: Record<string, number> = {};
    for (const [peer, entry] of Object.entries(payload.dms)) {
      if (typeof entry?.lastReadAt === 'number') {
        dmCursors[peer] = entry.lastReadAt;
      }
    }
    useReadStateStore.getState().applyRemoteState({
      dmCursors,
      inboxLastReadAt: payload.inboxLastReadAt,
    });
  };

  const unsubIngest = subscribeAndIngest(opts, apply);

  const fingerprintDms = (
    cursors: Record<string, number>,
    inboxAt: number,
  ): string => {
    const parts: string[] = [];
    for (const [peer, v] of Object.entries(cursors)) {
      parts.push(`${peer}:${v}`);
    }
    parts.sort();
    return `inbox:${inboxAt}|${parts.join('|')}`;
  };

  const unsubPublish = watchAndPublish(
    opts,
    () => {
      const s = useReadStateStore.getState();
      return fingerprintDms(s.dmCursors, s.inboxLastReadAt);
    },
    (): DmsPayload | null => {
      const s = useReadStateStore.getState();
      const dms: Record<string, { lastReadAt: number }> = {};
      let any = false;
      for (const [peer, v] of Object.entries(s.dmCursors)) {
        if (typeof v === 'number' && v > 0) {
          dms[peer] = { lastReadAt: v };
          any = true;
        }
      }
      if (!any && s.inboxLastReadAt === 0) return null;
      return { v: 1, dms, inboxLastReadAt: s.inboxLastReadAt };
    },
  );

  return () => {
    unsubIngest();
    unsubPublish();
  };
}

/** Internal export for tests. */
export const __INTERNAL = {
  parsePayload,
  findInnerDTag,
  DEBOUNCE_MS,
  SCHEMA_VERSION,
};

// Suppress the unused RemoteReadState import warning — it's part of the
// public surface that the store action accepts and is referenced from
// docs/read-state.md as the apply shape.
export type { RemoteReadState };
