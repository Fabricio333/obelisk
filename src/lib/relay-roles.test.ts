import { describe, expect, it } from 'vitest';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  DEFAULT_ROLE_COLOR,
  MAX_ROLES,
  normalizeRoleColor,
  normalizeRoleId,
  parseRoleCatalog,
  parseRoleHolders,
  roleCatalogDTag,
  roleHoldersDTag,
  rolesByPubkey,
  rolesForPubkey,
  toRoleCatalogTags,
  toRoleHoldersTags,
  topRole,
  type RelayRole,
  type RelayRoles,
} from './relay-roles';

const RELAY = 'wss://relay.test';
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

function event(tags: string[][], createdAt = 100): NostrEvent {
  return { id: 'id', pubkey: 'op', created_at: createdAt, kind: 30078, tags, content: '', sig: 'sig' };
}

const MOD: RelayRole = { id: 'mod', name: 'Moderator', tier: 3, color: '#ff0000' };
const OG: RelayRole = { id: 'og', name: 'OG', tier: 1, color: '#00ff00' };

describe('role catalog', () => {
  it('round-trips through tags, most senior first', () => {
    const tags = toRoleCatalogTags([OG, MOD], RELAY);

    expect(tags[0]).toEqual(['d', roleCatalogDTag(RELAY)]);
    expect(tags.slice(1)).toEqual([
      ['role', 'mod', 'Moderator', '3', '#ff0000'],
      ['role', 'og', 'OG', '1', '#00ff00'],
    ]);
    expect(parseRoleCatalog(event(tags)).roles).toEqual([MOD, OG]);
  });

  it('drops unusable roles and keeps the first of a duplicated id', () => {
    const parsed = parseRoleCatalog(event([
      ['d', roleCatalogDTag(RELAY)],
      ['role', '', 'Nameless', '5', '#fff'],
      ['role', 'mod', 'Moderator', '3', '#ff0000'],
      ['role', 'mod', 'Impostor', '99', '#000000'],
      ['p', ALICE],
    ]));

    expect(parsed.roles).toEqual([MOD]);
  });

  it('falls back to defaults for a broken tier or color', () => {
    const [role] = parseRoleCatalog(event([['role', 'vip', 'VIP', 'high', 'chartreuse']])).roles;

    expect(role).toEqual({ id: 'vip', name: 'VIP', tier: 0, color: DEFAULT_ROLE_COLOR });
  });

  it('caps the catalog so one event cannot grow unbounded', () => {
    const many = Array.from({ length: MAX_ROLES + 5 }, (_, index) => ({
      id: `role-${index}`, name: `Role ${index}`, tier: index, color: DEFAULT_ROLE_COLOR,
    }));

    expect(toRoleCatalogTags(many, RELAY)).toHaveLength(MAX_ROLES + 1);
  });

  it('slugifies names into stable ids and expands shorthand colors', () => {
    expect(normalizeRoleId('  Núcleo Duro!! ')).toBe('nucleo-duro');
    expect(normalizeRoleId('***')).toBe('');
    expect(normalizeRoleColor('#ABC')).toBe('#aabbcc');
    expect(normalizeRoleColor('rgb(1,2,3)')).toBe(DEFAULT_ROLE_COLOR);
  });
});

describe('role holders', () => {
  it('round-trips holders for one role', () => {
    const tags = toRoleHoldersTags(RELAY, 'mod', [ALICE, BOB, ALICE, 'not-a-pubkey']);

    expect(tags[0]).toEqual(['d', roleHoldersDTag(RELAY, 'mod')]);
    expect(parseRoleHolders(event(tags), RELAY)).toEqual({
      roleId: 'mod',
      pubkeys: [ALICE, BOB],
      updatedAt: 100,
    });
  });

  it('refuses a holders list addressed to another relay', () => {
    const tags = toRoleHoldersTags('wss://other.relay', 'mod', [ALICE]);

    expect(parseRoleHolders(event(tags), RELAY)).toBeNull();
  });
});

describe('which role shows', () => {
  const state: RelayRoles = {
    roles: [MOD, OG],
    holders: { mod: [ALICE], og: [ALICE, BOB] },
    updatedAt: 100,
  };

  it('shows only the highest tier a user holds', () => {
    expect(rolesForPubkey(state, ALICE)).toEqual([MOD, OG]);
    expect(topRole(state, ALICE)).toEqual(MOD);
    expect(topRole(state, BOB)).toEqual(OG);
    expect(topRole(state, 'c'.repeat(64))).toBeNull();
  });

  it('falls back to the next role once the top one is revoked', () => {
    const revoked: RelayRoles = { ...state, holders: { ...state.holders, mod: [] } };

    expect(topRole(revoked, ALICE)).toEqual(OG);
  });

  it('drops badges for roles deleted from the catalog', () => {
    const deleted: RelayRoles = { ...state, roles: [OG] };

    expect(topRole(deleted, ALICE)).toEqual(OG);
    expect(rolesByPubkey(deleted)).toEqual({ [ALICE]: [OG], [BOB]: [OG] });
  });

  it('fans holders out most-senior-first per pubkey', () => {
    expect(rolesByPubkey(state)).toEqual({ [ALICE]: [MOD, OG], [BOB]: [OG] });
  });

  it('breaks tier ties by id so every client picks the same badge', () => {
    const tied: RelayRoles = {
      roles: [{ ...MOD, id: 'aaa', tier: 5 }, { ...OG, id: 'zzz', tier: 5 }],
      holders: { aaa: [ALICE], zzz: [ALICE] },
      updatedAt: 1,
    };

    expect(topRole(tied, ALICE)?.id).toBe('aaa');
  });
});
