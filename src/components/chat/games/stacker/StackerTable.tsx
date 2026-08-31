'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameSession } from '@/lib/games/session';
import { incomingFor, type MatchState } from '@/lib/games/stacker/match';
import { useStackerLoop } from '@/hooks/chat/useStackerLoop';
import { MUSIC_CREDIT, currentTrack, setTrackListener } from '@/lib/games/stacker/audio';
import StackerBoard, { MiniBoard, PieceChip } from './StackerBoard';
import StackerKeysPanel from './StackerKeysPanel';
import { HEIGHT } from '@/lib/games/stacker/engine';

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
    inputs?: string;
    board: string;
  }) => void;
  onTopOut: (seat: string) => void;
  /** Fullscreen gives the board the whole viewport; the modal sets this. */
  fullscreen?: boolean;
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
  fullscreen,
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

  const { runner, stats, prefs, toggleMuted, reloadKeys } = useStackerLoop({
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
  const [keysOpen, setKeysOpen] = useState(false);
  // The credit line follows whatever the playlist moved on to.
  const [track, setTrack] = useState(() => currentTrack().title);
  useEffect(() => {
    setTrackListener(setTrack);
    return () => setTrackListener(null);
  }, []);

  /**
   * Size the cells to the space available rather than to a constant. A fixed
   * 26px board is 520px tall, which is taller than a phone's usable area and
   * taller than the modal — so it was getting cut off at the top and bottom.
   */
  const [cell, setCell] = useState(26);
  useEffect(() => {
    const measure = () => {
      if (typeof window === 'undefined') return;
      // Leave room for the rails, the opponents strip and the controls line.
      const chrome = fullscreen ? 190 : 260;
      const byHeight = Math.floor((window.innerHeight - chrome) / HEIGHT);
      const byWidth = Math.floor((window.innerWidth - 190) / 10);
      setCell(Math.max(12, Math.min(30, byHeight, byWidth)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [fullscreen]);

  return (
    <div className="space-y-3" data-testid="stacker-table">
      <div className="flex items-start justify-center gap-3">
        {/* Left rail: hold and the numbers that matter */}
        <div className="flex w-[68px] shrink-0 flex-col gap-2">
          <div className="rounded-lg border border-lc-border bg-lc-black/40 p-1.5">
            <PieceChip kind={runner.state.hold} label="Hold" dim={!runner.state.hold} />
          </div>
          <Stat label="Sent" value={stats.attacksSent} accent="#b4f953" testId="stacker-sent" />
          <Stat label="Lines" value={stats.linesCleared} />
          <Stat label="Level" value={stats.level} accent="#22d3ee" testId="stacker-level" />
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

          <StackerBoard runner={runner} cell={cell} dimmed={!iAmAlive || match.over} />

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
        <div className="flex w-[68px] shrink-0 flex-col gap-1.5">
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
                <MiniBoard board={p.board} height={p.stackHeight} dead={!p.alive} cell={Math.max(4, Math.round(cell / 4))} />
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

      <div className="flex flex-wrap items-center justify-center gap-2 text-[10px] text-lc-muted">
        <button
          type="button"
          onClick={() => setKeysOpen(true)}
          className="rounded-full border border-lc-border px-2 py-0.5 hover:text-lc-white"
          data-testid="stacker-keys-open"
        >
          ⌨ controls
        </button>
        <button
          type="button"
          onClick={toggleMuted}
          className="rounded-full border border-lc-border px-2 py-0.5 hover:text-lc-white"
          data-testid="stacker-mute"
        >
          {prefs.muted ? '🔇 muted' : '🔊 sound'}
        </button>
        {!prefs.muted && (
          <a
            href={MUSIC_CREDIT.source}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[10px] text-lc-muted underline decoration-dotted hover:text-lc-white"
            title={`${track} — ${MUSIC_CREDIT.author}, ${MUSIC_CREDIT.note}`}
            data-testid="stacker-music-credit"
          >
            ♫ {track} — {MUSIC_CREDIT.author}
          </a>
        )}
      </div>

      {keysOpen && (
        <StackerKeysPanel onClose={() => { setKeysOpen(false); reloadKeys(); }} />
      )}

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
