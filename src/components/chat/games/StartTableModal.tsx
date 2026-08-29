'use client';

import { useMemo, useState } from 'react';
import ModalShell from '@/components/ModalShell';
import type { GameSession } from '@/lib/games/session';
import { localSeatId, type SeatSpec } from '@/lib/games/protocol';
import { readResumeState } from '@/lib/games/vesta/definition';
import { gameInfo, gameName } from '@/lib/games/catalog';

interface Row {
  /** Stable identity while editing; the published seat id is derived at the end. */
  rowId: string;
  label: string;
  /** Pubkey that will sign this seat's moves. */
  by: string;
  /** Name this seat had in the loaded save, when there is one. */
  savedName?: string;
}

/**
 * The host's last decision before a table starts: who plays which seat, and
 * from where.
 *
 * There is exactly one control that matters per seat — **which account signs
 * its moves** — and everything else follows from it:
 *
 *   - an account holding one seat plays it **remotely**, from their own
 *     client, with their own key;
 *   - an account holding several is playing them **on one machine** — the
 *     hot-seat case. They are still separate players with separate resources;
 *     they just share a keyboard and a signature.
 *
 * When the table is resuming a save, the rows are fixed: one per player in the
 * saved game, in the save's own order, showing the name that player had. Seat
 * order is player order, so row 1 inherits saved player 1's board. That
 * mapping used to be implicit in the row order and unexplained — now the host
 * assigns each saved player to an account on purpose.
 */
export default function StartTableModal({
  session,
  nameOf,
  onClose,
  onStart,
}: {
  session: GameSession;
  nameOf: (pubkey: string) => string;
  onClose: () => void;
  onStart: (seats: SeatSpec[]) => void;
}) {
  // Real-time games give every player their own board, running at the same
  // time, so an account can hold exactly one seat. Hot-seat is meaningless
  // there: you cannot pass a keyboard between people who are all playing.
  const realtime = gameInfo(session.game)?.realtime === true;

  // A resumed table's shape is decided by the save, not by the host.
  const savedPlayers = useMemo(() => {
    const state = readResumeState((session.opts as { resume?: unknown }).resume);
    return state?.players.map((p) => p.name) ?? null;
  }, [session.opts]);

  const [rows, setRows] = useState<Row[]>(() => {
    if (savedPlayers) {
      // One row per saved player, all initially on the host, so a solo host
      // can carry on a whole hot-seat game they imported.
      return savedPlayers.map((name, i) => ({
        rowId: `saved-${i}`,
        label: name || `Player ${i + 1}`,
        by: session.joined[Math.min(i, session.joined.length - 1)] ?? session.createdBy,
        savedName: name,
      }));
    }
    return session.joined.map((pubkey, i) => ({
      rowId: `join-${i}`,
      label: nameOf(pubkey),
      by: pubkey,
    }));
  });

  const seatsFor = (pubkey: string) => rows.filter((r) => r.by === pubkey).length;

  const setController = (rowId: string, by: string) =>
    setRows((cur) => cur.map((r) => (r.rowId === rowId ? { ...r, by } : r)));

  const rename = (rowId: string, label: string) =>
    setRows((cur) => cur.map((r) => (r.rowId === rowId ? { ...r, label: label.slice(0, 32) } : r)));

  const addRow = () => {
    if (rows.length >= session.maxPlayers) return;
    setRows((cur) => [...cur, {
      rowId: `extra-${cur.length}-${cur.length}`,
      label: `Player ${cur.length + 1}`,
      by: session.createdBy,
    }]);
  };

  const removeRow = (rowId: string) => setRows((cur) => cur.filter((r) => r.rowId !== rowId));

  const move = (index: number, delta: number) => {
    setRows((cur) => {
      const next = [...cur];
      const target = index + delta;
      if (target < 0 || target >= next.length) return cur;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  /**
   * Seat ids: the first seat an account holds is its pubkey, the rest are
   * `<pubkey>#n`. That keeps an ordinary one-seat-each table byte-identical
   * to what clients published before hot-seat existed.
   */
  const seats: SeatSpec[] = useMemo(() => {
    const counts = new Map<string, number>();
    return rows.map((r) => {
      const n = counts.get(r.by) ?? 0;
      counts.set(r.by, n + 1);
      return { id: localSeatId(r.by, n), by: r.by, label: r.label || nameOf(r.by) };
    });
  }, [rows, nameOf]);

  const tooFew = rows.length < session.minPlayers;
  const tooMany = rows.length > session.maxPlayers;
  const wrongForSave = !!savedPlayers && rows.length !== savedPlayers.length;

  return (
    <ModalShell
      onClose={onClose}
      testId="start-table-modal"
      panelClassName="w-full max-w-lg mx-4 rounded-xl bg-lc-dark border border-lc-border p-5 max-h-[85vh] overflow-y-auto"
    >
      <h2 className="text-sm font-semibold text-lc-white">Seats and turn order</h2>
      <p className="mt-1 text-[11px] text-lc-muted">
        {realtime
          ? `Every player needs their own device: ${gameName(session.game)} runs all the boards at once, so one seat per account.`
          : savedPlayers
            ? `Resuming a saved ${gameName(session.game)} game with ${savedPlayers.length} players. Assign each one to an account — several seats on the same account are played at that person's keyboard.`
            : 'Assign each seat to an account. Give one account several seats and those players share that machine; one seat each means everyone plays from their own client.'}
      </p>

      <ul className="mt-4 space-y-2" data-testid="seat-list">
        {rows.map((row, i) => {
          const shared = seatsFor(row.by) > 1;
          return (
            <li key={row.rowId} className="rounded-lg border border-lc-border p-2">
              <div className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-center text-[11px] text-lc-muted">{i + 1}</span>
                <input
                  value={row.label}
                  onChange={(e) => rename(row.rowId, e.target.value)}
                  className="min-w-0 flex-1 rounded bg-lc-black/50 px-2 py-1 text-xs text-lc-white outline-none focus:ring-1 focus:ring-lc-green"
                  aria-label={`Seat ${i + 1} name`}
                />
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
                    shared ? 'border-lc-green/60 text-lc-green' : 'border-lc-border text-lc-muted'
                  }`}
                  data-testid={`seat-mode-${i}`}
                >
                  {realtime ? 'own device' : shared ? `on ${nameOf(row.by)}'s machine` : 'remote'}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button type="button" onClick={() => move(i, -1)} className="px-1 text-lc-muted hover:text-lc-white" aria-label="Move up">↑</button>
                  <button type="button" onClick={() => move(i, 1)} className="px-1 text-lc-muted hover:text-lc-white" aria-label="Move down">↓</button>
                  {!savedPlayers && rows.length > session.minPlayers && (
                    <button
                      type="button"
                      onClick={() => removeRow(row.rowId)}
                      className="px-1 text-lc-muted hover:text-red-400"
                      aria-label="Remove seat"
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>

              {/* Who signs for this seat */}
              <div className="mt-1.5 flex flex-wrap items-center gap-1 pl-7">
                <span className="text-[10px] uppercase tracking-wide text-lc-muted">Played by</span>
                {session.joined.map((pubkey) => (
                  <button
                    key={pubkey}
                    type="button"
                    disabled={realtime && row.by !== pubkey && seatsFor(pubkey) > 0}
                    onClick={() => setController(row.rowId, pubkey)}
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                      row.by === pubkey ? 'border-lc-green text-lc-green' : 'border-lc-border text-lc-muted hover:text-lc-white'
                    } disabled:opacity-30`}
                    data-testid={`seat-${i}-by-${pubkey}`}
                  >
                    {nameOf(pubkey)}
                  </button>
                ))}
              </div>

              {row.savedName && (
                <p className="mt-1 pl-7 text-[10px] text-lc-muted">
                  Takes over “{row.savedName}” from the save
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {!savedPlayers && !realtime && (
        <button
          type="button"
          disabled={rows.length >= session.maxPlayers}
          onClick={addRow}
          className="mt-3 rounded-full border border-lc-border px-3 py-1 text-[11px] text-lc-muted hover:text-lc-white disabled:opacity-30"
          data-testid="add-seat"
        >
          + add a seat
        </button>
      )}

      <p className="mt-3 text-[11px] text-lc-muted">
        {rows.length} of {session.minPlayers}–{session.maxPlayers} seats
        {tooFew && ' · needs more players'}
        {tooMany && ' · too many'}
        {wrongForSave && ` · the save has ${savedPlayers!.length}`}
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="lc-pill-secondary px-4 py-1.5 text-xs">
          Cancel
        </button>
        <button
          type="button"
          disabled={tooFew || tooMany || wrongForSave}
          onClick={() => onStart(seats)}
          className="lc-pill-primary px-4 py-1.5 text-xs"
          data-testid="confirm-start"
        >
          Start game
        </button>
      </div>
    </ModalShell>
  );
}
