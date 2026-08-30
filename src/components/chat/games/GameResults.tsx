'use client';

import type { GameSession } from '@/lib/games/session';
import type { GameState as VestaState } from 'vesta';
import type { CRState } from '@/lib/games/chain-reaction';
import { gameIcon, gameName } from '@/lib/games/catalog';
import { SEAT_COLORS } from './ChainReactionBoard';
import { VESTA_PLAYER_COLORS } from './vesta/VestaBoard';

/**
 * How a match ended, for everyone.
 *
 * A finished table is not private: the log is on the relay, so anybody in the
 * channel can replay it. This is that replay made readable — final standings
 * with each game's own idea of a score, shown to players and spectators alike,
 * whether or not they were sitting at the table.
 */
export default function GameResults({
  session,
  seatLabel,
  myPubkey,
}: {
  session: GameSession;
  seatLabel: (seatId: string) => string;
  myPubkey: string | null;
}) {
  const rows = standingsFor(session);
  const mine = session.seats.filter((s) => s.by === myPubkey).map((s) => s.id);

  return (
    <div className="space-y-3" data-testid="game-results">
      <div className="text-center">
        <div className="text-[10px] uppercase tracking-[0.14em] text-lc-muted">Final result</div>
        <div className="mt-0.5 text-sm font-semibold text-lc-white">
          {gameIcon(session.game)} {gameName(session.game)}
          {session.draw || !session.winner
            ? ' · draw'
            : ` · ${seatLabel(session.winner)} won`}
        </div>
      </div>

      <ol className="space-y-1.5" data-testid="results-standings">
        {rows.map((row, i) => {
          const isWinner = row.seat === session.winner;
          return (
            <li
              key={row.seat}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                isWinner ? 'border-lc-green/60 bg-lc-green/10' : 'border-lc-border'
              }`}
              data-testid={`result-row-${row.seat}`}
            >
              <span className="w-4 text-center text-[11px] text-lc-muted">{i + 1}</span>
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
              <span className={`min-w-0 flex-1 truncate text-xs ${isWinner ? 'text-lc-white' : 'text-lc-muted'}`}>
                {seatLabel(row.seat)}
                {mine.includes(row.seat) && <span className="ml-1 text-[10px] text-lc-muted">(you)</span>}
              </span>
              {isWinner && <span className="shrink-0 text-sm" aria-label="winner">🏆</span>}
              <span className="shrink-0 font-mono text-[11px] text-lc-white" data-testid={`result-score-${row.seat}`}>
                {row.score}
              </span>
            </li>
          );
        })}
      </ol>

      {rows.length > 0 && rows[0].detail && (
        <p className="text-center text-[10px] text-lc-muted">{rows[0].detail}</p>
      )}
    </div>
  );
}

interface Standing {
  seat: string;
  score: string;
  color: string;
  detail?: string;
}

/**
 * Each game scores differently, so each gets its own reading of the final
 * state. Anything unrecognised still gets a standings list — winner first,
 * everyone else after — rather than nothing at all.
 */
function standingsFor(session: GameSession): Standing[] {
  const seats = session.participants;

  if (session.game === 'vesta' && session.state) {
    const state = session.state as VestaState;
    return seats
      .map((seat, i) => ({
        seat,
        color: VESTA_PLAYER_COLORS[i] ?? '#a3a3a3',
        score: `${state.players[i]?.vp ?? 0} VP`,
        sort: state.players[i]?.vp ?? 0,
        detail: 'Victory points at the end of the game',
      }))
      .sort((a, b) => b.sort - a.sort);
  }

  if (session.match) {
    // Stacker: lines sent is the number that decided the match.
    return seats
      .map((seat, i) => {
        const p = session.match!.progress[seat];
        return {
          seat,
          color: SEAT_COLORS[i]?.hex ?? '#a3a3a3',
          score: `${p?.attacksSent ?? 0}⚔ · ${p?.linesCleared ?? 0}▤`,
          sort: (p?.attacksSent ?? 0) * 1000 + (p?.linesCleared ?? 0),
          detail: 'Garbage sent · lines cleared',
        };
      })
      .sort((a, b) => b.sort - a.sort);
  }

  if (session.game === 'chain-reaction' && session.state) {
    const state = session.state as CRState;
    // Cells owned at the end is the closest thing this game has to a score.
    const owned = new Map<string, number>();
    for (const cell of state.cells) {
      if (cell.owner === null) continue;
      const seat = state.order[cell.owner];
      if (seat) owned.set(seat, (owned.get(seat) ?? 0) + cell.count);
    }
    return seats
      .map((seat, i) => ({
        seat,
        color: SEAT_COLORS[i]?.hex ?? '#a3a3a3',
        score: session.eliminated.includes(seat) ? 'out' : `${owned.get(seat) ?? 0} orbs`,
        sort: session.eliminated.includes(seat) ? -1 : (owned.get(seat) ?? 0),
        detail: 'Orbs held when the board was taken',
      }))
      .sort((a, b) => b.sort - a.sort);
  }

  return seats.map((seat, i) => ({
    seat,
    color: SEAT_COLORS[i]?.hex ?? '#a3a3a3',
    score: seat === session.winner ? 'winner' : session.eliminated.includes(seat) ? 'out' : '—',
  }));
}
