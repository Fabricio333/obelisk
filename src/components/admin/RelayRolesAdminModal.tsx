'use client';

import { useMemo, useRef, useState } from 'react';
import { nip19 } from 'nostr-tools';
import ModalShell from '@/components/ModalShell';
import EmojiPicker from '@/components/chat/EmojiPicker';
import { useRelayPeople, useUserMetadata, type JsMemberInfo } from '@/lib/nostr-bridge';
import { shortNpub } from '@/lib/mentions';
import {
  DEFAULT_ROLE_COLOR,
  MAX_ROLES,
  normalizeRoleColor,
  normalizeRoleEmoji,
  normalizeRoleId,
  publishRoleCatalog,
  publishRoleHolders,
  sortRoles,
  type RelayRole,
  type RelayRoles,
} from '@/lib/relay-roles';

const fieldClass = 'rounded-lg border border-lc-border bg-lc-black px-3 py-2 text-sm text-lc-white outline-none focus:border-lc-green';

/** Accepts an npub or a raw hex pubkey; returns hex, or null if neither. */
export function parsePubkeyInput(value: string): string | null {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === 'npub') return decoded.data;
    if (decoded.type === 'nprofile') return decoded.data.pubkey;
  } catch {
    // Not a bech32 entity — fall through.
  }
  return null;
}

function serializeRoles(list: ReadonlyArray<RelayRole>): string {
  return JSON.stringify(list.map((role) => [role.id, role.name, role.tier, role.color, role.emoji]));
}

/** Tiers are dense and descending by list position: top row is most senior. */
function retier(roles: ReadonlyArray<RelayRole>): RelayRole[] {
  return roles.map((role, index) => ({ ...role, tier: roles.length - index }));
}

export default function RelayRolesAdminModal({
  relayUrl,
  roles,
  onClose,
}: {
  relayUrl: string;
  roles: RelayRoles;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RelayRole[]>(() => sortRoles(roles.roles));
  const [newName, setNewName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const savedIds = useMemo(() => new Set(roles.roles.map((role) => role.id)), [roles.roles]);

  const savedKey = useMemo(() => serializeRoles(sortRoles(roles.roles)), [roles.roles]);
  const [baseKey, setBaseKey] = useState(savedKey);
  // The catalog usually lands after this modal opens. Seeding the draft only at
  // mount left it empty against a relay that had roles — which read as an edit,
  // so Save lit up and publishing it would have wiped the catalog. Adopt each
  // new catalog while the draft is untouched, and never clobber real edits.
  if (savedKey !== baseKey) {
    setBaseKey(savedKey);
    if (serializeRoles(draft) === baseKey) setDraft(sortRoles(roles.roles));
  }

  // Compare what Save would actually publish: re-tiering is applied on the way
  // out, so a reorder back to the original order is not a change.
  const dirty = serializeRoles(retier(draft)) !== savedKey;

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage(label);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not reach the relay.');
    } finally {
      setBusy(false);
    }
  };

  const addRole = () => {
    const name = newName.trim().slice(0, 32);
    const id = normalizeRoleId(name);
    if (!id) return setMessage('Give the role a name with at least one letter or number.');
    if (draft.some((role) => role.id === id)) return setMessage(`“${name}” already exists.`);
    if (draft.length >= MAX_ROLES) return setMessage(`A relay can define up to ${MAX_ROLES} roles.`);
    // New roles start at the bottom of the ladder; the operator moves them up.
    setDraft(retier([...draft, { id, name, tier: 0, color: DEFAULT_ROLE_COLOR, emoji: '' }]));
    setNewName('');
    setMessage(null);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft];
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(retier(next));
  };

  const removeRole = (role: RelayRole) => {
    if (savedIds.has(role.id) && !confirm(`Delete “${role.name}”? Everyone holding it loses the badge.`)) return;
    setDraft(retier(draft.filter((value) => value.id !== role.id)));
    if (expanded === role.id) setExpanded(null);
  };

  const saveRoles = () => run('Roles saved.', async () => {
    await publishRoleCatalog(relayUrl, retier(draft));
  });

  const grant = (role: RelayRole, pubkey: string) => run(`Granted “${role.name}”.`, async () => {
    const current = roles.holders[role.id] ?? [];
    if (current.includes(pubkey)) return;
    await publishRoleHolders(relayUrl, role.id, [...current, pubkey]);
  });

  const revoke = (role: RelayRole, pubkey: string) => run(`Revoked “${role.name}”.`, async () => {
    await publishRoleHolders(relayUrl, role.id, (roles.holders[role.id] ?? []).filter((value) => value !== pubkey));
  });

  return (
    <ModalShell
      onClose={onClose}
      testId="relay-roles-modal"
      panelClassName="lc-card mx-4 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden bg-lc-dark"
    >
      <header className="flex items-start justify-between gap-4 border-b border-lc-border px-5 py-4">
        <div>
          <h2 className="text-base font-bold text-lc-white">Roles &amp; ranks</h2>
          <p className="mt-1 text-xs text-lc-muted">
            Ordered most senior first. Members can hold several roles — the top one they hold is the badge
            shown in chat and the member list, until you revoke it.
          </p>
        </div>
        <button onClick={onClose} className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white" aria-label="Close">✕</button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-4 flex flex-wrap gap-2">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addRole(); }}
            placeholder="New role name…"
            aria-label="New role name"
            maxLength={32}
            className={`${fieldClass} min-w-[200px] flex-1`}
          />
          <button type="button" onClick={addRole} className="lc-pill lc-pill-secondary text-xs">Add role</button>
        </div>

        {draft.length === 0 && (
          <p className="py-10 text-center text-sm text-lc-muted">No roles yet. Create one above.</p>
        )}

        <ul className="grid gap-2">
          {draft.map((role, index) => (
            <li key={role.id} data-testid={`role-row-${role.id}`} className="rounded-xl border border-lc-border bg-lc-black/40">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <span className="text-[10px] font-mono text-lc-muted" title="Tier — higher wins">T{role.tier}</span>
                <RoleEmojiField
                  role={role}
                  onPick={(emoji) => setDraft(draft.map((value) => value.id === role.id ? { ...value, emoji } : value))}
                />
                <input
                  value={role.name}
                  onChange={(event) => setDraft(draft.map((value) => value.id === role.id ? { ...value, name: event.target.value.slice(0, 32) } : value))}
                  aria-label={`${role.id} name`}
                  className={`${fieldClass} min-w-[120px] flex-1`}
                />
                <input
                  type="color"
                  value={normalizeRoleColor(role.color)}
                  onChange={(event) => setDraft(draft.map((value) => value.id === role.id ? { ...value, color: normalizeRoleColor(event.target.value) } : value))}
                  aria-label={`${role.id} color`}
                  className="h-9 w-10 shrink-0 cursor-pointer rounded border border-lc-border bg-lc-black"
                />
                <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="rounded border border-lc-border px-2 py-1 text-xs text-lc-white disabled:opacity-30" aria-label={`Move ${role.name} up`}>↑</button>
                <button type="button" onClick={() => move(index, 1)} disabled={index === draft.length - 1} className="rounded border border-lc-border px-2 py-1 text-xs text-lc-white disabled:opacity-30" aria-label={`Move ${role.name} down`}>↓</button>
                <button
                  type="button"
                  onClick={() => setExpanded(expanded === role.id ? null : role.id)}
                  disabled={!savedIds.has(role.id)}
                  aria-expanded={expanded === role.id}
                  title={savedIds.has(role.id) ? undefined : 'Save roles before assigning members.'}
                  className={'flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold disabled:opacity-30 ' + (
                    expanded === role.id
                      ? 'border-lc-green bg-lc-green/15 text-lc-green'
                      : 'border-lc-green/60 bg-lc-green/5 text-lc-green hover:bg-lc-green/15'
                  )}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M17 11h4M19 9v4" />
                  </svg>
                  {(roles.holders[role.id] ?? []).length} members
                </button>
                <button type="button" onClick={() => removeRole(role)} className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-300" aria-label={`Delete ${role.name}`}>Delete</button>
              </div>
              {expanded === role.id && savedIds.has(role.id) && (
                <RoleMembers
                  role={role}
                  holders={roles.holders[role.id] ?? []}
                  busy={busy}
                  onGrant={(pubkey) => grant(role, pubkey)}
                  onRevoke={(pubkey) => revoke(role, pubkey)}
                  onError={setMessage}
                />
              )}
            </li>
          ))}
        </ul>
      </div>

      {message && <div className="border-t border-lc-border px-5 py-2 text-xs text-lc-green" role="status">{message}</div>}
      <footer className="flex items-center justify-between gap-3 border-t border-lc-border px-5 py-3">
        <span className="text-xs text-lc-muted">{draft.length} roles · relay operator only</span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="lc-pill lc-pill-secondary text-xs">Close</button>
          <button
            type="button"
            onClick={saveRoles}
            disabled={busy || !dirty}
            className="lc-pill lc-pill-primary text-xs disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save roles'}
          </button>
        </div>
      </footer>
    </ModalShell>
  );
}

const EMOJI_POPOVER_W = 360;
const EMOJI_POPOVER_H = 430;

function RoleEmojiField({ role, onPick }: { role: RelayRole; onPick: (emoji: string) => void }) {
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The picker lives in a fixed layer rather than inside this row: the roles
  // panel is overflow-hidden and the list scrolls, so an absolutely positioned
  // popover gets clipped away entirely. Anchored off the button's rect and
  // flipped/clamped so it stays on screen from any row.
  const open = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const room = window.innerHeight - rect.bottom;
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - EMOJI_POPOVER_W - 8)),
      top: room >= EMOJI_POPOVER_H + 12 ? rect.bottom + 4 : Math.max(8, rect.top - EMOJI_POPOVER_H - 4),
    });
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (anchor ? setAnchor(null) : open())}
        aria-label={`${role.id} emoji`}
        aria-expanded={!!anchor}
        title="Badge emoji"
        className="flex h-9 w-10 items-center justify-center rounded-lg border border-lc-border bg-lc-black text-base hover:border-lc-green/50"
      >
        {role.emoji || <span className="text-xs text-lc-muted">+</span>}
      </button>
      {role.emoji && (
        <button
          type="button"
          onClick={() => onPick('')}
          aria-label={`Clear ${role.id} emoji`}
          className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-lc-border bg-lc-dark text-[9px] text-lc-muted hover:text-lc-white"
        >
          ✕
        </button>
      )}
      {anchor && (
        <>
          {/* Catches the click that dismisses the picker without closing the
              surrounding roles modal. */}
          <div className="fixed inset-0 z-40" onClick={() => setAnchor(null)} data-testid="role-emoji-backdrop" />
          <div className="fixed z-50" style={{ left: anchor.left, top: anchor.top }} data-testid={`role-emoji-popover-${role.id}`}>
            <EmojiPicker
              placement="below"
              align="left"
              skipRecent
              customEmojis={{}}
              onPick={(emoji) => {
                // Unicode only: a custom emoji is a relay-scoped image, and the
                // badge has to render from the catalog alone on any client.
                const glyph = normalizeRoleEmoji(emoji);
                if (glyph && !glyph.startsWith(':')) onPick(glyph);
                setAnchor(null);
              }}
              onClose={() => setAnchor(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function RoleMembers({ role, holders, busy, onGrant, onRevoke, onError }: {
  role: RelayRole;
  holders: readonly string[];
  busy: boolean;
  onGrant: (pubkey: string) => void;
  onRevoke: (pubkey: string) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState('');
  const people = useRelayPeople();
  const held = useMemo(() => new Set(holders), [holders]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = people.filter((person) => !held.has(person.pubkey));
    if (!q) return pool.slice(0, 40);
    return pool
      .filter((person) => `${person.displayName} ${person.nip05 ?? ''} ${person.pubkey}`.toLowerCase().includes(q))
      .slice(0, 40);
  }, [held, people, query]);

  // A pubkey pasted for someone the relay has never seen still has to work.
  const pasted = parsePubkeyInput(query);
  const pastedIsNew = !!pasted && !held.has(pasted) && !matches.some((person) => person.pubkey === pasted);

  const grantPasted = () => {
    if (!pasted) {
      onError('No match — search by name, or paste an npub or hex pubkey.');
      return;
    }
    onGrant(pasted);
    setQuery('');
  };

  return (
    <div className="border-t border-lc-border/60 px-3 pb-3 pt-2" data-testid={`role-members-${role.id}`}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && pastedIsNew) grantPasted(); }}
        placeholder="Search members by name, NIP-05 or npub…"
        aria-label={`Grant ${role.name} to`}
        className={`${fieldClass} w-full`}
      />

      {pastedIsNew && (
        <button
          type="button"
          onClick={grantPasted}
          disabled={busy}
          className="mt-2 w-full rounded-lg border border-lc-green/60 px-3 py-2 text-left text-xs text-lc-green disabled:opacity-40"
        >
          Grant to {shortNpub(pasted)} — not a member of this relay yet
        </button>
      )}

      <div className="mt-2 max-h-56 overflow-y-auto" data-testid={`role-candidates-${role.id}`}>
        <ul className="grid gap-1">
          {matches.map((person) => (
            <RolePersonRow
              key={person.pubkey}
              person={person}
              busy={busy}
              action="grant"
              roleName={role.name}
              onClick={() => { onGrant(person.pubkey); setQuery(''); }}
            />
          ))}
          {matches.length === 0 && !pastedIsNew && (
            <li className="py-3 text-center text-xs text-lc-muted">
              {people.length === 0 ? 'Loading relay members…' : 'No members match that search.'}
            </li>
          )}
        </ul>
      </div>

      <div className="mt-3 border-t border-lc-border/60 pt-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-lc-muted">
          Holds this role — {holders.length}
        </div>
        <ul className="grid gap-1">
          {holders.map((pubkey) => (
            <RoleHolderRow key={pubkey} pubkey={pubkey} roleName={role.name} busy={busy} onRevoke={() => onRevoke(pubkey)} />
          ))}
          {holders.length === 0 && <li className="py-2 text-xs text-lc-muted">Nobody holds this role yet.</li>}
        </ul>
      </div>
    </div>
  );
}

function RolePersonRow({ person, busy, roleName, onClick }: {
  person: JsMemberInfo;
  busy: boolean;
  action: 'grant';
  roleName: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label={`Grant ${roleName} to ${person.displayName}`}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-lc-card disabled:opacity-40"
      >
        <PersonAvatar person={person} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-lc-white">{person.displayName}</span>
          <span className="block truncate text-[10px] text-lc-muted">{person.nip05 ?? shortNpub(person.pubkey)}</span>
        </span>
        {person.role === 'admin' && (
          <span className="shrink-0 rounded-full bg-lc-green/15 px-1.5 py-px text-[9px] font-bold uppercase text-lc-green">admin</span>
        )}
        <span className="shrink-0 text-xs font-semibold text-lc-green">Grant</span>
      </button>
    </li>
  );
}

function PersonAvatar({ person }: { person: JsMemberInfo }) {
  if (person.picture) {
    return <img src={person.picture} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-lc-olive text-[10px] font-medium text-lc-green">
      {person.displayName.slice(0, 2).toUpperCase()}
    </span>
  );
}

function RoleHolderRow({ pubkey, roleName, busy, onRevoke }: {
  pubkey: string;
  roleName: string;
  busy: boolean;
  onRevoke: () => void;
}) {
  const meta = useUserMetadata(pubkey);
  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-lc-card">
      <span className="min-w-0 flex-1 truncate text-sm text-lc-white">
        {meta?.displayName || meta?.name || shortNpub(pubkey)}
      </span>
      <span className="hidden truncate font-mono text-[10px] text-lc-muted sm:block">{pubkey.slice(0, 16)}…</span>
      <button
        type="button"
        onClick={onRevoke}
        disabled={busy}
        className="rounded border border-red-500/30 px-2 py-0.5 text-xs text-red-300 disabled:opacity-40"
        aria-label={`Revoke ${roleName} from ${shortNpub(pubkey)}`}
      >
        Revoke
      </button>
    </li>
  );
}
