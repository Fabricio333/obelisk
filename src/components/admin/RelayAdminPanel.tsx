'use client';

import { useEffect, useMemo, useState } from 'react';
import ModalShell from '@/components/ModalShell';
import {
  nostrActions,
  useAdminsByGroup,
  useGroups,
} from '@/lib/nostr-bridge';
import { useUserMetadata as useProfile } from '@/lib/nostr-bridge';
import { getBridgeImpl } from '@/lib/nostr-bridge';

interface Row {
  groupId: string;
  groupName: string;
  pubkey: string;
  isAdmin: boolean;
}

const rowKey = (r: Row) => `${r.groupId}/${r.pubkey}`;

export default function RelayAdminPanel({ onClose }: { onClose: () => void }) {
  const groups = useGroups();
  const adminsByGroup = useAdminsByGroup();
  // Members lists are per-group state on the bridge — pull them in bulk via
  // the impl handle so the panel doesn't have to fan out N useMembers hooks.
  const membersByGroup = useMembersByGroupBulk();

  const [filter, setFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'member'>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const g of groups) {
      const admins = new Set(adminsByGroup[g.id] ?? []);
      const members = membersByGroup[g.id] ?? [];
      const all = new Set<string>([...admins, ...members]);
      for (const pubkey of all) {
        out.push({
          groupId: g.id,
          groupName: g.name ?? g.id.slice(0, 8),
          pubkey,
          isAdmin: admins.has(pubkey),
        });
      }
    }
    return out;
  }, [groups, adminsByGroup, membersByGroup]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (roleFilter === 'admin' && !r.isAdmin) return false;
      if (roleFilter === 'member' && r.isAdmin) return false;
      if (groupFilter !== 'all' && r.groupId !== groupFilter) return false;
      if (q && !(r.pubkey.toLowerCase().includes(q) || r.groupName.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [rows, filter, roleFilter, groupFilter]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const selectedRows = useMemo(
    () => filtered.filter((r) => selected.has(rowKey(r))),
    [filtered, selected],
  );

  async function bulk(action: 'kick' | 'demote') {
    if (selectedRows.length === 0) return;
    const verb = action === 'kick' ? 'remove' : 'demote';
    const sample = selectedRows.slice(0, 3).map((r) => `${r.pubkey.slice(0, 8)}@${r.groupName}`).join(', ');
    const more = selectedRows.length > 3 ? ` (+${selectedRows.length - 3} more)` : '';
    if (!confirm(`${verb} ${selectedRows.length} entries?\n${sample}${more}`)) return;
    setBusy(true);
    try {
      for (const r of selectedRows) {
        try {
          if (action === 'kick') {
            await nostrActions.removeUser(r.groupId, r.pubkey);
          } else if (r.isAdmin) {
            await nostrActions.removePermission(r.groupId, r.pubkey, ['admin']);
          }
        } catch (err) {
          console.warn(`[RelayAdminPanel] ${action} failed`, r, err);
        }
      }
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} panelClassName="w-full max-w-3xl mx-4 rounded-xl bg-lc-dark border border-lc-border shadow-xl flex flex-col max-h-[85vh]">
      <header className="flex items-center justify-between border-b border-lc-border px-5 py-3">
        <div>
          <h2 className="text-base font-bold text-lc-white">Relay admins &amp; members</h2>
          <p className="text-xs text-lc-muted">
            Bulk cleanup across every channel on this relay. Kick removes the user (kind 9001); demote strips the admin role only (kind 9003).
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-lc-muted hover:bg-lc-card hover:text-lc-white"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-lc-border px-5 py-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by pubkey or channel name…"
          className="min-w-[200px] flex-1 rounded border border-lc-border bg-lc-black px-3 py-1.5 text-sm text-lc-white outline-none focus:border-lc-green"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)}
          className="rounded border border-lc-border bg-lc-black px-2 py-1.5 text-xs text-lc-white outline-none focus:border-lc-green"
        >
          <option value="all">All roles</option>
          <option value="admin">Admins only</option>
          <option value="member">Members only</option>
        </select>
        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="max-w-[180px] rounded border border-lc-border bg-lc-black px-2 py-1.5 text-xs text-lc-white outline-none focus:border-lc-green"
        >
          <option value="all">All channels</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name ?? g.id.slice(0, 12)}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-lc-muted">
            {rows.length === 0
              ? 'No admin or member entries on this relay yet.'
              : 'No entries match the current filters.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-lc-dark/95 backdrop-blur">
              <tr className="text-left text-xs uppercase text-lc-muted">
                <th className="px-3 py-2 w-8" />
                <th className="px-2 py-2">User</th>
                <th className="px-2 py-2">Channel</th>
                <th className="px-2 py-2">Role</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <RowItem
                  key={rowKey(r)}
                  row={r}
                  selected={selected.has(rowKey(r))}
                  onToggle={() => toggle(rowKey(r))}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-lc-border px-5 py-3">
        <div className="text-xs text-lc-muted">
          {selectedRows.length} selected · {filtered.length} shown · {rows.length} total
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => bulk('demote')}
            disabled={busy || selectedRows.every((r) => !r.isAdmin)}
            className="lc-pill lc-pill-secondary text-xs disabled:opacity-40"
            title="Strip admin role from selected admin rows. Members are skipped."
          >
            Demote
          </button>
          <button
            onClick={() => bulk('kick')}
            disabled={busy || selectedRows.length === 0}
            className="lc-pill text-xs bg-red-500/20 text-red-300 hover:bg-red-500/30 disabled:opacity-40"
          >
            Kick
          </button>
        </div>
      </footer>
    </ModalShell>
  );
}

function RowItem({
  row,
  selected,
  onToggle,
}: {
  row: Row;
  selected: boolean;
  onToggle: () => void;
}) {
  const meta = useProfile(row.pubkey);
  return (
    <tr className="border-t border-lc-border/40 hover:bg-lc-card">
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="cursor-pointer"
        />
      </td>
      <td className="px-2 py-2">
        <div className="truncate text-lc-white">
          {meta?.displayName || meta?.name || row.pubkey.slice(0, 12)}
        </div>
        <div className="truncate font-mono text-[10px] text-lc-muted">{row.pubkey}</div>
      </td>
      <td className="px-2 py-2 text-lc-muted">{row.groupName}</td>
      <td className="px-2 py-2">
        {row.isAdmin ? (
          <span className="rounded-full bg-lc-green/20 px-2 py-0.5 text-[10px] font-bold uppercase text-lc-green">
            Admin
          </span>
        ) : (
          <span className="text-xs text-lc-muted">Member</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The bridge exposes per-group `subscribeMembers` but no bulk subscriber for
 * the whole relay. Reading the impl's `membersByGroup` StateStore directly
 * keeps this panel from spawning N hooks just to enumerate state we already
 * have in memory.
 */
function useMembersByGroupBulk(): Readonly<Record<string, ReadonlyArray<string>>> {
  const [snapshot, setSnapshot] = useState<Record<string, ReadonlyArray<string>>>({});
  useEffect(() => {
    const impl = getBridgeImpl();
    if (!impl) return;
    const unsub = impl.membersByGroup.subscribe((m) => setSnapshot(m));
    return () => unsub();
  }, []);
  return snapshot;
}
