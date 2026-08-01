'use client';

import { useMemo, useState } from 'react';
import { nip19 } from 'nostr-tools';
import ModalShell from '@/components/ModalShell';
import { useUserMetadata } from '@/lib/nostr-bridge';
import { shortNpub } from '@/lib/mentions';
import {
  DEFAULT_ROLE_COLOR,
  MAX_ROLES,
  normalizeRoleColor,
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

  const dirty = useMemo(() => {
    const serialize = (list: ReadonlyArray<RelayRole>) =>
      JSON.stringify(list.map((role) => [role.id, role.name, role.tier, role.color]));
    return serialize(draft) !== serialize(sortRoles(roles.roles));
  }, [draft, roles.roles]);

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
    setDraft(retier([...draft, { id, name, tier: 0, color: DEFAULT_ROLE_COLOR }]));
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
                  title={savedIds.has(role.id) ? undefined : 'Save roles before assigning members.'}
                  className="rounded border border-lc-border px-2 py-1 text-xs text-lc-white disabled:opacity-30"
                >
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

function RoleMembers({ role, holders, busy, onGrant, onRevoke, onError }: {
  role: RelayRole;
  holders: readonly string[];
  busy: boolean;
  onGrant: (pubkey: string) => void;
  onRevoke: (pubkey: string) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState('');

  const submit = () => {
    const pubkey = parsePubkeyInput(value);
    if (!pubkey) {
      onError('Enter an npub or a 64-character hex pubkey.');
      return;
    }
    onGrant(pubkey);
    setValue('');
  };

  return (
    <div className="border-t border-lc-border/60 px-3 pb-3 pt-2" data-testid={`role-members-${role.id}`}>
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          placeholder="npub1… or hex pubkey"
          aria-label={`Grant ${role.name} to`}
          className={`${fieldClass} min-w-[200px] flex-1`}
        />
        <button type="button" onClick={submit} disabled={busy} className="lc-pill lc-pill-secondary text-xs disabled:opacity-40">Grant</button>
      </div>
      <ul className="mt-2 grid gap-1">
        {holders.map((pubkey) => (
          <RoleHolderRow key={pubkey} pubkey={pubkey} roleName={role.name} busy={busy} onRevoke={() => onRevoke(pubkey)} />
        ))}
        {holders.length === 0 && <li className="py-2 text-xs text-lc-muted">Nobody holds this role yet.</li>}
      </ul>
    </div>
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
