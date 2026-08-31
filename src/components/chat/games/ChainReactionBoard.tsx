'use client';

import { useEffect, useRef, useState } from 'react';
import type { GameSession } from '@/lib/games/session';
import type { CRState } from '@/lib/games/chain-reaction';

interface Props {
  game: GameSession;
  /**
   * Seats this client may play. Usually one; several when the table is being
   * played at this keyboard, in which case the board follows whichever of
   * them is on move.
   */
  mySeats: string[];
  onAction: (action: { cell: number }, seat: string) => Promise<void>;
  /** Cap on the rendered board width — the modal gives it more room than a card. */
  maxWidth?: number;
  /** Names seats for the legend; two local players must read as two people. */
  seatLabel?: (seatId: string) => string;
}

/**
 * Seat colours, picked to stay apart from each other on a near-black board.
 *
 * The first four are the ones most games actually use, so they are the most
 * separated: warm red, the brand lime, a cold cyan, and amber. Nothing sits
 * next to its neighbour in hue, and every one is bright enough to read as a
 * glowing orb rather than a dark dot.
 */
export const SEAT_COLORS = [
  { hex: '#ff4d5e', dot: 'bg-red-500' },     // red
  { hex: '#b4f953', dot: 'bg-lc-green' },    // lime (brand)
  { hex: '#38bdf8', dot: 'bg-sky-400' },     // sky
  { hex: '#fbbf24', dot: 'bg-amber-400' },   // amber
  { hex: '#c084fc', dot: 'bg-purple-400' },  // violet
  { hex: '#f472b6', dot: 'bg-pink-400' },    // pink
  { hex: '#fb923c', dot: 'bg-orange-400' },  // orange
  { hex: '#2dd4bf', dot: 'bg-teal-400' },    // teal
];

// CSS custom properties aren't in React's CSSProperties, so styles that set
// one need a widened type rather than an `any` cast.
type CSSVars = React.CSSProperties & Record<`--${string}`, string>;

function Orbs({ count, hex, orbit }: { count: number; hex: string; orbit: boolean }) {
  if (count <= 0) return null;
  const dots = Math.min(count, 3);
  // Orbs touch each other — offsets are tuned so a 10px-diameter ball sits
  // flush against its neighbours (center-to-center ≈ diameter).
  const offsets: Array<[number, number]> =
    dots === 1 ? [[0, 0]]
    : dots === 2 ? [[-4.5, 0], [4.5, 0]]
    : [[-4.5, 3], [4.5, 3], [0, -4.5]];
  const dur = `${Math.max(0.9, 2.6 - dots * 0.5)}s`;
  // Stack three gradients: a tight specular highlight, the main lit sphere,
  // and a dark crescent on the far side — reads much more 3D than one ramp.
  const sphere = [
    // Tight specular, then the lit body, then a dark crescent on the far
    // side. Three stops read as a sphere; one reads as a circle.
    `radial-gradient(circle at 30% 24%, rgba(255,255,255,0.98) 0%, rgba(255,255,255,0) 20%)`,
    `radial-gradient(circle at 34% 32%, color-mix(in srgb, ${hex} 8%, white) 0%, ${hex} 42%, color-mix(in srgb, ${hex} 55%, black) 88%)`,
    `radial-gradient(circle at 74% 80%, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 42%)`,
  ].join(', ');
  return (
    <div
      className={`cr-orb-group ${orbit ? '' : 'cr-orb-group--still'}`}
      style={{ '--cr-orbit-dur': dur } as CSSVars}
    >
      {offsets.map(([dx, dy], i) => (
        <span
          key={`${count}-${i}`}
          className="cr-orb cr-orb--3d"
          style={{
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`,
            background: sphere,
            boxShadow: [
              `0 0 10px ${hex}`,
              `0 0 20px color-mix(in srgb, ${hex} 45%, transparent)`,
              `0 1px 2px rgba(0,0,0,0.6)`,
              `inset -1.5px -2px 2.5px color-mix(in srgb, ${hex} 40%, black)`,
              `inset 1.5px 2px 1.5px rgba(255,255,255,0.35)`,
            ].join(', '),
            color: hex,
          }}
        />
      ))}
    </div>
  );
}

type CellSnapshot = { count: number; owner: number | null };

function neighborIndices(rows: number, cols: number, i: number): number[] {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const out: number[] = [];
  if (r > 0) out.push((r - 1) * cols + c);
  if (r < rows - 1) out.push((r + 1) * cols + c);
  if (c > 0) out.push(r * cols + (c - 1));
  if (c < cols - 1) out.push(r * cols + (c + 1));
  return out;
}

// One BFS round: every currently-critical cell explodes simultaneously.
// Returns null when nothing is critical any more.
function oneCascadeRound(
  cells: CellSnapshot[],
  rows: number,
  cols: number,
  actorSeat: number,
): { cells: CellSnapshot[]; exploded: number[] } | null {
  const exploding: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].count >= neighborIndices(rows, cols, i).length) exploding.push(i);
  }
  if (exploding.length === 0) return null;
  const next = cells.map((c) => ({ ...c }));
  for (const i of exploding) {
    const crit = neighborIndices(rows, cols, i).length;
    next[i].count -= crit;
    if (next[i].count <= 0) { next[i].count = 0; next[i].owner = null; }
  }
  for (const i of exploding) {
    for (const n of neighborIndices(rows, cols, i)) {
      next[n].count += 1;
      next[n].owner = actorSeat;
    }
  }
  return { cells: next, exploded: exploding };
}

// Full cascade — used to brute-force which cell was clicked for opponents.
function simulateFull(
  prev: CellSnapshot[],
  rows: number,
  cols: number,
  actorSeat: number,
  clickCell: number,
): CellSnapshot[] {
  const start = prev.map((c) => ({ ...c }));
  start[clickCell] = { count: start[clickCell].count + 1, owner: actorSeat };
  let cur = start;
  for (let guard = 0; guard < 400; guard++) {
    const step = oneCascadeRound(cur, rows, cols, actorSeat);
    if (!step) break;
    cur = step.cells;
  }
  return cur;
}

// Our simulator ignores the engine's dominance-break optimisation, so in
// end-game positions the states can diverge. We consider them equal if every
// non-zero cell matches — close enough to pick the right click.
function cellsRoughlyEqual(a: CellSnapshot[], b: CellSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].count !== b[i].count) return false;
    if (a[i].owner !== b[i].owner) return false;
  }
  return true;
}

/**
 * How closely a simulated board resembles the real one.
 *
 * The engine stops a cascade the moment the mover owns everything
 * (`isDominant` in chain-reaction.ts), so on the winning move — and only on
 * the winning move — a full local simulation always overshoots and nothing
 * matches exactly. That used to mean the biggest explosion in the game was
 * the one nobody got to watch. Scoring the candidates lets us animate the
 * closest one and snap to the authoritative board at the end.
 */
function matchScore(a: CellSnapshot[], b: CellSnapshot[]): number {
  let score = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i].owner === b[i].owner) score += 1;
    if (a[i].count === b[i].count) score += 1;
  }
  return score;
}

function Explosion({ hex }: { hex: string }) {
  // Bright burst fills the cell then blooms outward; four shards fly to
  // adjacent cells. Absolutely-positioned overlay — overflows the cell
  // so shards leak into neighbour cells, which is exactly the feel we want.
  const shardStyle = (dx: number, dy: number): CSSVars => ({
    background: `radial-gradient(circle at 30% 28%, rgba(255,255,255,0.95) 0%, ${hex} 45%, color-mix(in srgb, ${hex} 45%, black) 100%)`,
    boxShadow: `0 0 10px ${hex}`,
    '--cr-shard-dx': `${dx}px`,
    '--cr-shard-dy': `${dy}px`,
    color: hex,
  });
  return (
    <div className="cr-burst" style={{ color: hex }} aria-hidden>
      <span
        className="cr-burst-core"
        style={{
          background: `radial-gradient(circle, rgba(255,255,255,0.95) 0%, ${hex} 40%, transparent 70%)`,
        }}
      />
      <span
        className="cr-burst-ring"
        style={{ borderColor: hex, boxShadow: `0 0 12px ${hex}` }}
      />
      <span className="cr-shard" style={shardStyle(0, -22)} />
      <span className="cr-shard" style={shardStyle(0, 22)} />
      <span className="cr-shard" style={shardStyle(-22, 0)} />
      <span className="cr-shard" style={shardStyle(22, 0)} />
    </div>
  );
}

export default function ChainReactionBoard({ game, mySeats, onAction, maxWidth = 320, seatLabel }: Props) {
  const [busy, setBusy] = useState(false);
  const state = (game.state ?? {}) as Partial<CRState>;
  const rows: number = state.rows ?? 9;
  const cols: number = state.cols ?? 6;
  const cells: CellSnapshot[] = state.cells ?? Array.from({ length: rows * cols }, () => ({ count: 0, owner: null }));
  const seats: Record<string, number> = state.seats ?? {};
  const order: string[] = state.order ?? [];
  const eliminated: string[] = state.eliminated ?? [];
  const boardWidth = Math.min(maxWidth, cols * 44);

  // The seat being played right now: the one on move if we hold it, otherwise
  // our only seat (so a spectator-ish view still colours the right player).
  const actingSeatId = game.currentTurn && mySeats.includes(game.currentTurn)
    ? game.currentTurn
    : mySeats.length === 1 ? mySeats[0] : null;
  const mySeat = actingSeatId !== null ? seats[actingSeatId] ?? null : null;
  const myTurn = game.status === 'in_progress'
    && !!game.currentTurn
    && mySeats.includes(game.currentTurn);
  const myColor = mySeat !== null && mySeat >= 0 ? SEAT_COLORS[mySeat] : null;

  // The grid inherits the active player's color so the matrix visibly
  // changes hue every turn. Falls back to neutral when waiting/finished.
  const turnSeat = game.currentTurn ? seats[game.currentTurn] : undefined;
  const turnHex = typeof turnSeat === 'number' ? SEAT_COLORS[turnSeat]?.hex : undefined;
  const matrixHex = turnHex ?? '#3f3f46';

  // A move event carries only the clicked cell; the reducer hands us the
  // settled post-cascade board. To actually SEE the cascade we re-simulate it
  // locally from the previous board: apply the move, then play each round of
  // explosions with a delay between rounds.
  const prevCellsRef = useRef<CellSnapshot[]>(cells);
  const prevSeatsRef = useRef<Record<string, number>>(seats);
  const prevTurnRef = useRef<string | null>(game.currentTurn ?? null);
  const myClickRef = useRef<number | null>(null);
  // Cells and "is a cascade still playing" move together — they are set from
  // the same effect, so one state holds both and the effect only writes once.
  // `animating` blocks clicks (including the next player's move) until the
  // reveal finishes; otherwise the board would still be visibly rearranging
  // itself under them.
  const [reveal, setReveal] = useState<{ cells: CellSnapshot[]; animating: boolean }>(
    { cells, animating: false },
  );
  const displayCells = reveal.cells;
  const animating = reveal.animating;
  const [explosions, setExplosions] = useState<Record<number, { hex: string; id: number }>>({});
  // Fast enough to feel like a reaction rather than a wait. The original
  // timings (520/420) meant a long chain locked the board for several seconds,
  // which reads as the game lagging rather than as an animation.
  const EXPLOSION_MS = 260;
  const STEP_MS = 150; // delay between BFS rounds — still readable, far snappier

  useEffect(() => {
    const prev = prevCellsRef.current;
    const prevSeats = prevSeatsRef.current;
    const mover = prevTurnRef.current;

    // Nothing to do on first mount / board resize / when there's no mover.
    const syncRefs = () => {
      prevCellsRef.current = cells;
      prevSeatsRef.current = seats;
      prevTurnRef.current = game.currentTurn ?? null;
    };

    if (!mover || !(mover in prevSeats) || prev.length !== cells.length) {
      syncRefs();
      setReveal({ cells, animating: false });
      return;
    }

    let changed = false;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].count !== prev[i].count || cells[i].owner !== prev[i].owner) { changed = true; break; }
    }
    if (!changed) {
      syncRefs();
      return;
    }

    const actorSeat = prevSeats[mover];

    // Find the clicked cell. For the local player we captured it at click
    // time; for remote players we brute-force each legal cell and pick the
    // one whose full simulation produces the observed final state.
    const findClick = (): number => {
      const ownClick = myClickRef.current;
      if (ownClick !== null && mySeats.includes(mover)) {
        myClickRef.current = null;
        return ownClick;
      }
      let best = -1;
      let bestScore = -1;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].owner !== null && prev[i].owner !== actorSeat) continue;
        const sim = simulateFull(prev, rows, cols, actorSeat, i);
        if (cellsRoughlyEqual(sim, cells)) return i;
        const score = matchScore(sim, cells);
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      // No exact match: the winning move, where the engine cut the cascade
      // short. Animate the closest candidate rather than snapping silently.
      return best;
    };
    const clickCell = findClick();

    if (clickCell < 0) {
      // Couldn't reconstruct (e.g. dominance early-exit, timeout): fall back
      // to instant reveal.
      syncRefs();
      setReveal({ cells, animating: false });
      return;
    }

    // Build step-by-step frames: [placed, after-round-1, after-round-2, ...].
    const frames: Array<{ cells: CellSnapshot[]; exploded: number[] }> = [];
    const placed = prev.map((c) => ({ ...c }));
    placed[clickCell] = { count: placed[clickCell].count + 1, owner: actorSeat };
    frames.push({ cells: placed, exploded: [] });

    let current = placed;
    for (let guard = 0; guard < 400; guard++) {
      const step = oneCascadeRound(current, rows, cols, actorSeat);
      if (!step) break;
      frames.push(step);
      current = step.cells;
    }

    // If the click itself made a cell critical, the first explosion should
    // fire simultaneously with the click (no "placed but not yet exploded"
    // pause). When there's no cascade, show frame 0 as-is.
    const hasCascade = frames.length > 1;
    setReveal({ cells: hasCascade ? frames[1].cells : frames[0].cells, animating: hasCascade });
    const timers: ReturnType<typeof setTimeout>[] = [];

    const fireBursts = (frame: { exploded: number[] }, prevFrame: { cells: CellSnapshot[] }, idx: number) => {
      if (!frame.exploded.length) return;
      const bursts: Record<number, { hex: string; id: number }> = {};
      const now = Date.now();
      for (const i of frame.exploded) {
        const prevOwner = prevFrame.cells[i].owner;
        const hex = prevOwner !== null ? SEAT_COLORS[prevOwner]?.hex ?? '#ffffff' : '#ffffff';
        bursts[i] = { hex, id: now + i + idx * 10000 };
      }
      const keys = Object.keys(bursts);
      setExplosions((cur) => ({ ...cur, ...bursts }));
      const cleanup = setTimeout(() => {
        setExplosions((cur) => {
          const nx = { ...cur };
          for (const k of keys) delete nx[+k];
          return nx;
        });
      }, EXPLOSION_MS + 40);
      timers.push(cleanup);
    };

    if (hasCascade) fireBursts(frames[1], frames[0], 1);

    for (let idx = 2; idx < frames.length; idx++) {
      const frame = frames[idx];
      const prevFrame = frames[idx - 1];
      const delay = (idx - 1) * STEP_MS;
      const t = setTimeout(() => {
        setReveal({ cells: frame.cells, animating: true });
        fireBursts(frame, prevFrame, idx);
      }, delay);
      timers.push(t);
    }

    const settleAt = Math.max(1, frames.length - 2) * STEP_MS + EXPLOSION_MS;
    const finalT = setTimeout(() => {
      setReveal({ cells, animating: false });
      syncRefs();
    }, settleAt);
    timers.push(finalT);

    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, rows, cols]);

  const click = async (i: number) => {
    if (busy || animating || !myTurn || mySeat === null || !actingSeatId) return;
    const cell = cells[i];
    if (cell.owner !== null && cell.owner !== mySeat) return;
    myClickRef.current = i;
    setBusy(true);
    try {
      await onAction({ cell: i }, actingSeatId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div
        className="cr-matrix grid mx-auto rounded-md"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          width: `${boardWidth}px`,
          '--cr-turn': matrixHex,
        } as CSSVars}
      >
        {displayCells.map((cell, i) => {
          const owner = cell.owner;
          const color = owner !== null ? SEAT_COLORS[owner] : null;
          const burst = explosions[i];
          const canClick = myTurn && !busy && !animating && (owner === null || owner === mySeat);
          return (
            <button
              key={i}
              onClick={() => click(i)}
              disabled={!canClick}
              className={`
                cr-cell relative aspect-square
                ${canClick ? 'cursor-pointer' : 'cursor-not-allowed'}
                transition-colors
              `}
              style={color ? { color: color.hex } : undefined}
              aria-label={`cell ${i}`}
            >
              {color && <Orbs count={cell.count} hex={color.hex} orbit={cell.count >= 2} />}
              {burst && <Explosion key={burst.id} hex={burst.hex} />}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 justify-center text-[10px]">
        {order.map((pk, seat) => {
          const c = SEAT_COLORS[seat];
          const isMe = mySeats.includes(pk);
          const out = eliminated.includes(pk);
          const turn = game.currentTurn === pk;
          return (
            <span
              key={pk}
              className={`
                inline-flex items-center gap-1 px-2 py-0.5 rounded-full border
                ${turn ? 'border-lc-white' : 'border-lc-border'}
                ${out ? 'opacity-40 line-through' : ''}
              `}
            >
              <span className={`w-2 h-2 rounded-full ${c.dot}`} />
              <span className={isMe ? 'text-lc-white' : 'text-lc-muted'}>
                {seatLabel ? seatLabel(pk) : pk.slice(0, 6)}
                {isMe && <span className="ml-1 opacity-70">(you)</span>}
              </span>
            </span>
          );
        })}
      </div>
      {myColor && (
        <div className="text-center text-[11px] text-lc-muted">
          Jugás con <span className="font-semibold" style={{ color: myColor.hex }}>●</span>
        </div>
      )}
    </div>
  );
}
