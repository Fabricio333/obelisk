/**
 * Relay roles — operator-defined ranks ("Moderator", "Contributor", "OG") that
 * render next to a user's name in chat and in the member list.
 *
 * Stored as NIP-78 (kind 30078) replaceable parameterized events authored by
 * the **relay operator** (NIP-11 `pubkey`), the same trust model as
 * `channel-layout.ts` and `relay-branding.ts`: a channel admin must not gain
 * relay-wide authority, so readers filter on the operator as author and a
 * forged roles event from anyone else is never parsed.
 *
 * Two d-tags:
 *
 *   `obelisk:roles:<relayUrl>`          — the catalog (which roles exist)
 *     ["role", id, name, tier, color]
 *
 *   `obelisk:role:<relayUrl>:<roleId>`  — that role's holders
 *     ["role", id]
 *     ["p", pubkey] …
 *
 * Holders live in one event per role rather than inside the catalog so that
 * granting or revoking one role never rewrites the others (no lost-update race
 * between two operator sessions) and a role with many holders can't push the
 * catalog past a relay's event-size limit.
 *
 * A user may hold any number of roles; `topRole()` decides the one that shows —
 * highest tier wins, ties broken by id so every client picks the same badge.
 * Revoking is removing the pubkey from that role's holder list: the badge falls
 * back to the next-highest role the user still holds, or disappears.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { getBridge, getBridgeImpl } from '@/lib/nostr-bridge/client';
import { cacheGet, cacheSet } from '@/lib/nostr-bridge/cache';
import { KIND_NIP78_APP_DATA as KIND_ROLES } from '@/lib/nip-kinds';

export interface RelayRole {
  /** Stable slug used in the holders d-tag. */
  readonly id: string;
  readonly name: string;
  /** Higher is more senior. Only the highest-tier held role is shown. */
  readonly tier: number;
  /** Badge color, `#rgb` or `#rrggbb`. */
  readonly color: string;
}

export interface RelayRoles {
  /** Catalog, ordered most senior first. */
  readonly roles: readonly RelayRole[];
  /** roleId -> pubkeys holding it. */
  readonly holders: Readonly<Record<string, readonly string[]>>;
  /** created_at of the catalog event, or 0 if none seen yet. */
  readonly updatedAt: number;
}

export const EMPTY_RELAY_ROLES: RelayRoles = { roles: [], holders: {}, updatedAt: 0 };

export const DEFAULT_ROLE_COLOR = '#b4f953';
export const MAX_ROLES = 24;
const ROLE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const PUBKEY_RE = /^[0-9a-f]{64}$/i;

export function normalizeRoleId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
}

/**
 * Always returns a 6-digit hex so the badge can append an alpha pair
 * (`#rrggbb` + `1f`) for its tint without special-casing shorthand.
 */
export function normalizeRoleColor(value: string | undefined): string {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!COLOR_RE.test(trimmed)) return DEFAULT_ROLE_COLOR;
  return trimmed.length === 4
    ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
    : trimmed;
}

/** Most senior first; id breaks ties so every client agrees on the badge. */
export function sortRoles(roles: ReadonlyArray<RelayRole>): RelayRole[] {
  return [...roles].sort((a, b) => (b.tier - a.tier) || a.id.localeCompare(b.id));
}

export function roleCatalogDTag(relayUrl: string): string {
  return `obelisk:roles:${relayUrl}`;
}

export function roleHoldersDTag(relayUrl: string, roleId: string): string {
  return `obelisk:role:${relayUrl}:${roleId}`;
}

function roleFromTag(tag: ReadonlyArray<string>): RelayRole | null {
  const id = normalizeRoleId(tag[1] ?? '');
  if (!ROLE_ID_RE.test(id)) return null;
  const name = (tag[2] ?? '').trim().slice(0, 32) || id;
  const tier = Number.parseInt(tag[3] ?? '', 10);
  return {
    id,
    name,
    tier: Number.isFinite(tier) ? Math.min(999, Math.max(0, tier)) : 0,
    color: normalizeRoleColor(tag[4]),
  };
}

export function parseRoleCatalog(ev: NostrEvent): RelayRoles {
  const byId = new Map<string, RelayRole>();
  for (const tag of ev.tags) {
    if (tag[0] !== 'role') continue;
    const role = roleFromTag(tag);
    // First tag wins: a duplicate id would otherwise make the badge depend on
    // tag order, and the writer already de-duplicates.
    if (role && !byId.has(role.id)) byId.set(role.id, role);
  }
  return {
    roles: sortRoles(Array.from(byId.values())).slice(0, MAX_ROLES),
    holders: {},
    updatedAt: ev.created_at,
  };
}

export function toRoleCatalogTags(roles: ReadonlyArray<RelayRole>, relayUrl: string): string[][] {
  const tags: string[][] = [['d', roleCatalogDTag(relayUrl)]];
  const seen = new Set<string>();
  for (const role of sortRoles(roles)) {
    const id = normalizeRoleId(role.id);
    if (!ROLE_ID_RE.test(id) || seen.has(id) || seen.size >= MAX_ROLES) continue;
    seen.add(id);
    tags.push(['role', id, role.name.trim().slice(0, 32) || id, String(role.tier), normalizeRoleColor(role.color)]);
  }
  return tags;
}

export interface RoleHolders {
  readonly roleId: string;
  readonly pubkeys: readonly string[];
  readonly updatedAt: number;
}

/**
 * Reads a holders event. `relayUrl` is required because the role id is only
 * trustworthy when the event's `d` tag is the one we asked for — otherwise a
 * holders list published for relay A could claim to grant roles on relay B.
 */
export function parseRoleHolders(ev: NostrEvent, relayUrl: string): RoleHolders | null {
  const d = ev.tags.find((tag) => tag[0] === 'd')?.[1] ?? '';
  const prefix = `obelisk:role:${relayUrl}:`;
  if (!d.startsWith(prefix)) return null;
  const roleId = normalizeRoleId(d.slice(prefix.length));
  if (!ROLE_ID_RE.test(roleId)) return null;
  const pubkeys: string[] = [];
  const seen = new Set<string>();
  for (const tag of ev.tags) {
    if (tag[0] !== 'p') continue;
    const pubkey = (tag[1] ?? '').trim().toLowerCase();
    if (!PUBKEY_RE.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    pubkeys.push(pubkey);
  }
  return { roleId, pubkeys, updatedAt: ev.created_at };
}

export function toRoleHoldersTags(
  relayUrl: string,
  roleId: string,
  pubkeys: ReadonlyArray<string>,
): string[][] {
  const id = normalizeRoleId(roleId);
  const tags: string[][] = [['d', roleHoldersDTag(relayUrl, id)], ['role', id]];
  const seen = new Set<string>();
  for (const raw of pubkeys) {
    const pubkey = raw.trim().toLowerCase();
    if (!PUBKEY_RE.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    tags.push(['p', pubkey]);
  }
  return tags;
}

// -- Pure helpers used by the UI ---------------------------------------------

/** Every role the pubkey holds, most senior first. */
export function rolesForPubkey(state: RelayRoles, pubkey: string): RelayRole[] {
  if (!pubkey) return [];
  return state.roles.filter((role) => state.holders[role.id]?.includes(pubkey));
}

/** The single role that shows next to the name — highest tier held. */
export function topRole(state: RelayRoles, pubkey: string): RelayRole | null {
  return rolesForPubkey(state, pubkey)[0] ?? null;
}

/** Fan the holder lists out into the per-pubkey map the chat store keeps. */
export function rolesByPubkey(state: RelayRoles): Record<string, RelayRole[]> {
  const out: Record<string, RelayRole[]> = {};
  for (const role of state.roles) {
    for (const pubkey of state.holders[role.id] ?? []) {
      (out[pubkey] ??= []).push(role);
    }
  }
  // `state.roles` is already sorted, so each list comes out most-senior-first.
  return out;
}

// -- Relay I/O ---------------------------------------------------------------

interface CachedCatalog {
  readonly roles: readonly RelayRole[];
  readonly updatedAt: number;
}

/** Last created_at we published per d-tag, so a same-second edit still wins. */
const publishedAt = new Map<string, number>();

export function subscribeRelayRoles(
  relayUrl: string,
  authors: ReadonlyArray<string>,
  onChange: (roles: RelayRoles) => void,
): () => void {
  const impl = getBridgeImpl();
  if (!impl) {
    let cancelled = false;
    let unsub: (() => void) | null = null;
    void getBridge().then(() => {
      if (cancelled) return;
      unsub = subscribeRelayRoles(relayUrl, authors, onChange);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }

  if (authors.length === 0) return () => {};

  const catalogD = roleCatalogDTag(relayUrl);
  const holderAt = new Map<string, number>();
  let state: RelayRoles = EMPTY_RELAY_ROLES;
  let holdersUnsub: (() => void) | null = null;
  let holdersKey = '';

  const applyCatalog = (catalog: CachedCatalog) => {
    const live: Record<string, readonly string[]> = {};
    for (const role of catalog.roles) {
      const held = state.holders[role.id];
      if (held) live[role.id] = held;
    }
    state = { roles: sortRoles(catalog.roles), holders: live, updatedAt: catalog.updatedAt };
  };

  // One REQ covering every role's holder list; re-opened whenever the catalog
  // adds or drops a role (the `#d` values are derived from it).
  const syncHolders = () => {
    const dTags = state.roles.map((role) => roleHoldersDTag(relayUrl, role.id));
    const key = dTags.join('|');
    if (key === holdersKey) return;
    holdersKey = key;
    holdersUnsub?.();
    holdersUnsub = null;
    if (dTags.length === 0) return;

    for (const role of state.roles) {
      const cached = cacheGet<RoleHolders>(relayUrl, KIND_ROLES, roleHoldersDTag(relayUrl, role.id));
      if (!cached || cached.value.updatedAt <= (holderAt.get(role.id) ?? 0)) continue;
      holderAt.set(role.id, cached.value.updatedAt);
      state = { ...state, holders: { ...state.holders, [role.id]: cached.value.pubkeys } };
    }
    onChange(state);

    const filter: Filter = { kinds: [KIND_ROLES], authors: [...authors], '#d': dTags };
    holdersUnsub = impl.subscribeFilterWatched(filter, (ev) => {
      const parsed = parseRoleHolders(ev, relayUrl);
      if (!parsed || ev.created_at <= (holderAt.get(parsed.roleId) ?? 0)) return;
      holderAt.set(parsed.roleId, ev.created_at);
      cacheSet(relayUrl, KIND_ROLES, roleHoldersDTag(relayUrl, parsed.roleId), parsed);
      state = { ...state, holders: { ...state.holders, [parsed.roleId]: parsed.pubkeys } };
      onChange(state);
    });
  };

  // Stale-while-revalidate: badges paint from cache instead of popping in a
  // second after the message they belong to.
  const cachedCatalog = cacheGet<CachedCatalog>(relayUrl, KIND_ROLES, catalogD);
  if (cachedCatalog) {
    applyCatalog(cachedCatalog.value);
    onChange(state);
    syncHolders();
  }

  const catalogFilter: Filter = { kinds: [KIND_ROLES], authors: [...authors], '#d': [catalogD] };
  const catalogUnsub = impl.subscribeFilterWatched(catalogFilter, (ev) => {
    if (ev.created_at <= state.updatedAt) return;
    const parsed = parseRoleCatalog(ev);
    cacheSet<CachedCatalog>(relayUrl, KIND_ROLES, catalogD, { roles: parsed.roles, updatedAt: parsed.updatedAt });
    applyCatalog(parsed);
    onChange(state);
    syncHolders();
  });

  return () => {
    catalogUnsub();
    holdersUnsub?.();
  };
}

async function publishRoleEvent(relayUrl: string, dTag: string, tags: string[][]): Promise<NostrEvent> {
  await getBridge();
  const impl = getBridgeImpl();
  if (!impl) throw new Error('nostr bridge not initialized');
  const previousAt = publishedAt.get(dTag) ?? 0;
  const event = await impl.publishEvent(
    {
      kind: KIND_ROLES,
      content: '',
      tags,
      created_at: Math.max(Math.floor(Date.now() / 1000), previousAt + 1),
    },
    { extraRelays: [relayUrl], mode: 'replace' },
  );
  publishedAt.set(dTag, event.created_at);
  return event;
}

export async function publishRoleCatalog(
  relayUrl: string,
  roles: ReadonlyArray<RelayRole>,
): Promise<void> {
  const dTag = roleCatalogDTag(relayUrl);
  const event = await publishRoleEvent(relayUrl, dTag, toRoleCatalogTags(roles, relayUrl));
  cacheSet<CachedCatalog>(relayUrl, KIND_ROLES, dTag, {
    roles: parseRoleCatalog(event).roles,
    updatedAt: event.created_at,
  });
}

export async function publishRoleHolders(
  relayUrl: string,
  roleId: string,
  pubkeys: ReadonlyArray<string>,
): Promise<void> {
  const id = normalizeRoleId(roleId);
  if (!ROLE_ID_RE.test(id)) throw new Error('invalid role id');
  const dTag = roleHoldersDTag(relayUrl, id);
  const event = await publishRoleEvent(relayUrl, dTag, toRoleHoldersTags(relayUrl, id, pubkeys));
  const parsed = parseRoleHolders(event, relayUrl);
  if (parsed) cacheSet(relayUrl, KIND_ROLES, dTag, parsed);
}

export function useRelayRoles(
  relayUrl: string | null,
  authors: ReadonlyArray<string>,
): RelayRoles {
  const authorsKey = useMemo(() => [...authors].sort().join(','), [authors]);
  const [state, setState] = useState<RelayRoles>(EMPTY_RELAY_ROLES);
  // Reset on relay change only — authors arriving after first paint would
  // otherwise blank every badge mid-load.
  useEffect(() => {
    setState(EMPTY_RELAY_ROLES);
  }, [relayUrl]);
  useEffect(() => {
    if (!relayUrl || authorsKey.length === 0) return;
    return subscribeRelayRoles(relayUrl, authorsKey.split(','), setState);
  }, [relayUrl, authorsKey]);
  return state;
}
