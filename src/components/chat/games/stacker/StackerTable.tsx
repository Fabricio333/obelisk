'use client';

import { useCallback, useMemo } from 'react';
import type { GameSession } from '@/lib/games/session';
import { incomingFor, type MatchState } from '@/lib/games/stacker/match';
import { useStackerLoop } from '@/hooks/chat/useStackerLoop';
import StackerBoard, { MiniBoard, PieceChip } from './StackerBoard';

export interface StackerTableProps {
  session: GameSession;
  match: MatchState;
  /** Seats this client plays. One board per person, so one seat. */
  mySeats: string[];
  seatLabel: (seatId: string) => string;
  onAttack: (seat: string, target: string, lines: number, hole: number, nonce: number) => void;
  onCheckpoint: (seat: string, payload: {
    frame: number;
    attacksSent: number;
    linesCleared: number;
    stackHeight: number;
    inputs: string;
  }) => void;
  onTopOut: (seat: string) => void;
}

/**
 * A match: your board at full speed, everyone else's as a meter.
 *
 * Opponents are deliberately coarse. Their real boards run on their own
 * machines and only reach us through checkpoints every few seconds — drawing a
 * detailed board that is seconds stale would be a lie, so we show the one thing
 * that stays true between updates: how buried they are.
 */
export default function StackerTable({
  session,
  match,
  mySeats,
  seatLabel,
  onAttack,
  onCheckpoint,
  onTopOut,
}: StackerTableProps) {
  const mySeat = mySeats[0] ?? null;
  const alive = match.alive;
  const iAmAlive = !!mySeat && alive.includes(mySeat);

  const incoming = useMemo(
    () => (mySeat ? incomingFor(match, mySeat) : []),
    [match, mySeat],
  );

  /**
   * Who gets the garbage. With one opponent it is obvious; with several we
   * spread it, which stops a three-way match turning into everybody burying
   * whoever happens to be first in the list.
   */
  const pickTarget = useCallback((): string | null => {
    const others = alive.filter((s) => s !== mySeat);
    if (others.length === 0) return null;
    return others[Math.floor(Math.random() * others.length)];
  }, [alive, mySeat]);

  const { runner, stats, prefs, toggleMuted, toggleMusic } = useStackerLoop({
    seed: match.seed,
    incoming,
    enabled: iAmAlive && !match.over,
    onAttack: useCallback((lines: number, hole: number, nonce: number) => {
      if (!mySeat) return;
      const target = pickTarget();
      if (!target) return;
      onAttack(mySeat, target, lines, hole, nonce);
    }, [mySeat, pickTarget, onAttack]),
    onCheckpoint: useCallback((payload: Parameters<StackerTableProps['onCheckpoint']>[1]) => {
      if (mySeat) onCheckpoint(mySeat, payload);
    }, [mySeat, onCheckpoint]),
    onTopOut: useCallback(() => {
      if (mySeat) onTopOut(mySeat);
    }, [mySeat, onTopOut]),
  });

  const opponents = session.participants.filter((s) => s !== mySeat);
  const banner = stats.lastClear;

  return (
    <div className="space-y-3" data-testid="stacker-table">
      <div className="flex items-start justify-center gap-3">
        {/* Left rail: hold and the numbers that matter */}
        <div className="flex w-[74px] flex-col gap-2">
          <div className="rounded-lg border border-lc-border bg-lc-black/40 p-1.5">
            <PieceChip kind={runner.state.hold} label="Hold" dim={!runner.state.hold} />
          </div>
          <Stat label="Sent" value={stats.attacksSent} accent="#b4f953" testId="stacker-sent" />
          <Stat label="Lines" value={stats.linesCleared} />
          {stats.combo > 1 && <Stat label="Combo" value={`${stats.combo}×`} accent="#facc15" />}
          {stats.backToBack > 0 && <Stat label="B2B" value={stats.backToBack} accent="#a855f7" />}
        </div>

        {/* Board, with the incoming-garbage meter running up its left side */}
        <div className="relative flex items-stretch gap-1.5">
          <div
            className="flex w-2 flex-col-reverse overflow-hidden rounded-full bg-white/5"
            title={`${stats.incoming} lines incoming`}
            data-testid="stacker-garbage-meter"
          >
            <div
              className="w-full rounded-full bg-gradient-to-t from-red-600 to-red-400 transition-[height] duration-150 ease-out"
              style={{ height: `${Math.min(100, (stats.incoming / 12) * 100)}%` }}
            />
          </div>

          <StackerBoard runner={runner} dimmed={!iAmAlive || match.over} />

          {/* Clear banner — brief, centred, never in the way of the stack */}
          {banner && (
            <div className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center">
              <span
                className="cr-win-title rounded-lg bg-black/70 px-3 py-1 text-center text-sm font-black tracking-wide"
                style={{ color: banner.spin ? '#a855f7' : banner.lines >= 4 ? '#22d3ee' : '#b4f953' }}
                data-testid="stacker-banner"
              >
                {banner.spin ? 'SPIN' : banner.lines === 4 ? 'QUAD' : `${banner.lines}×`}
                {banner.attack > 0 && <span className="ml-1 text-lc-white">+{banner.attack}</span>}
              </span>
            </div>
          )}

          {(stats.dead || !iAmAlive) && (
            <div className="absolute inset-0 flex items-center justify-center" data-testid="stacker-dead">
              <span className="rounded-lg bg-black/80 px-4 py-2 text-base font-black tracking-wide text-red-400">
                TOPPED OUT
              </span>
            </div>
          )}
        </div>

        {/* Right rail: what's coming */}
        <div className="flex w-[74px] flex-col gap-1.5">
          <div className="rounded-lg border border-lc-border bg-lc-black/40 p-1.5">
            <PieceChip kind={runner.state.queue[0] ?? null} label="Next" />
            <div className="mt-1 space-y-1 opacity-80">
              {runner.state.queue.slice(1, 5).map((kind, i) => (
                <PieceChip key={`${kind}-${i}`} kind={kind} dim />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Opponents */}
      {opponents.length > 0 && (
        <div className="flex flex-wrap items-end justify-center gap-3" data-testid="stacker-opponents">
          {opponents.map((seat) => {
            const p = match.progress[seat];
            if (!p) return null;
            return (
              <div key={seat} className="text-center" data-testid={`stacker-opponent-${seat}`}>
                <MiniBoard height={p.stackHeight} dead={!p.alive} />
                <div className="mt-1 max-w-[72px] truncate text-[10px] text-lc-white">{seatLabel(seat)}</div>
                <div className="text-[10px] text-lc-muted">{p.attacksSent}⚔ · {p.linesCleared}▤</div>
                {p.verified === false && (
                  <div className="text-[9px] text-red-400" title={p.suspect ?? undefined} data-testid={`stacker-suspect-${seat}`}>
                    ⚠ unverified
                  </div>
                )}
                {p.verified === true && (
                  <div className="text-[9px] text-lc-green" data-testid={`stacker-verified-${seat}`}>✓ checked</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-center gap-3 text-[10px] text-lc-muted">
        <span>← → move · ↓ soft · space drop · ↑/X rotate · Z counter · A flip · C hold</span>
        <button
          type="button"
          onClick={toggleMuted}
          className="rounded-full border border-lc-border px-2 py-0.5 hover:text-lc-white"
          data-testid="stacker-mute"
        >
          {prefs.muted ? '🔇 muted' : '🔊 sound'}
        </button>
        <button
          type="button"
          onClick={toggleMusic}
          disabled={prefs.muted}
          className="rounded-full border border-lc-border px-2 py-0.5 hover:text-lc-white disabled:opacity-30"
          data-testid="stacker-music"
        >
          {prefs.music ? '♫ music' : '♪ off'}
        </button>
      </div>

      {match.over && (
        <p className="text-center text-xs text-lc-white" data-testid="stacker-result">
          {match.winner
            ? `${seatLabel(match.winner)} is the last one standing`
            : 'Everybody topped out'}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, accent, testId }: { label: string; value: number | string; accent?: string; testId?: string }) {
  return (
    <div className="rounded-lg border border-lc-border bg-lc-black/40 px-2 py-1 text-center">
      <div className="text-[9px] uppercase tracking-[0.12em] text-lc-muted">{label}</div>
      <div className="text-sm font-bold" style={{ color: accent ?? '#fafafa' }} data-testid={testId}>
        {value}
      </div>
    </div>
  );
}
