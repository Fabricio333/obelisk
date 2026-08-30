'use client';

import { useEffect, useRef } from 'react';
import {
  cellsOf,
  decodeBoard,
  ghostOf,
  BUFFER,
  HEIGHT,
  WIDTH,
  GARBAGE_CELL,
  PIECES,
  type Cell,
  type GameState,
  type PieceKind,
} from '@/lib/games/stacker/engine';
import type { StackerRunner } from '@/lib/games/stacker/runner';

/** One colour per piece, plus grey for garbage. */
export const PIECE_COLORS: Record<number, string> = {
  1: '#22d3ee', // I
  2: '#3b82f6', // J
  3: '#f97316', // L
  4: '#facc15', // O
  5: '#b4f953', // S
  6: '#a855f7', // T
  7: '#ef4444', // Z
  [GARBAGE_CELL]: '#4b5563',
};

const RADIUS_RATIO = 0.22;

/**
 * The playfield.
 *
 * It renders itself: the component subscribes to the runner's frame callback
 * and paints straight to the canvas, so drawing never goes through React.
 *
 * Blocks are drawn **connected** — a cell only rounds the corners and draws the
 * bevel on edges where its neighbour is a different colour. Four separate
 * rounded squares read as four squares; the same four with their shared seams
 * removed read as a tetromino, which is the whole difference between this
 * looking like a grid of blocks and looking like a piece.
 */
export default function StackerBoard({
  runner,
  cell = 26,
  dimmed,
}: {
  runner: StackerRunner;
  /** Pixel size of a cell. The table sizes this to the space it has. */
  cell?: number;
  dimmed?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dimmedRef = useRef(dimmed);
  useEffect(() => { dimmedRef.current = dimmed; }, [dimmed]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const w = WIDTH * cell;
    const h = HEIGHT * cell;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const draw = (state: GameState) => {
      ctx.clearRect(0, 0, w, h);

      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#0e0e11');
      bg.addColorStop(1, '#08080a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      for (let x = 1; x < WIDTH; x++) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x * cell) + 0.5, 0);
        ctx.lineTo(Math.round(x * cell) + 0.5, h);
        ctx.stroke();
      }
      for (let y = 1; y < HEIGHT; y++) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y * cell) + 0.5);
        ctx.lineTo(w, Math.round(y * cell) + 0.5);
        ctx.stroke();
      }

      // The settled stack, drawn connected.
      const at = (x: number, y: number): Cell =>
        (x < 0 || x >= WIDTH || y < 0 || y >= state.board.length) ? -1 : state.board[y][x];

      for (let by = BUFFER; by < state.board.length; by++) {
        const vy = by - BUFFER;
        if (vy < 0 || vy >= HEIGHT) continue;
        for (let bx = 0; bx < WIDTH; bx++) {
          const value = state.board[by][bx];
          if (value === 0) continue;
          drawConnected(ctx, bx * cell, vy * cell, cell, PIECE_COLORS[value] ?? '#888', {
            up: at(bx, by - 1) === value,
            down: at(bx, by + 1) === value,
            left: at(bx - 1, by) === value,
            right: at(bx + 1, by) === value,
          }, value === GARBAGE_CELL);
        }
      }

      // Ghost, then the live piece over it.
      if (state.active) {
        const color = PIECE_COLORS[PIECES.indexOf(state.active.kind) + 1] ?? '#fff';
        const live = cellsOf(state.active);
        const ghost = ghostOf(state);

        if (ghost) {
          ctx.save();
          ctx.globalAlpha = 0.3;
          for (const [x, y] of cellsOf(ghost)) {
            const vy = y - BUFFER;
            if (vy < 0 || vy >= HEIGHT) continue;
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(1.5, cell * 0.08);
            roundRect(ctx, x * cell + cell * 0.15, vy * cell + cell * 0.15, cell * 0.7, cell * 0.7, cell * 0.12);
            ctx.stroke();
          }
          ctx.restore();
        }

        const member = new Set(live.map(([x, y]) => `${x},${y}`));
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = cell * 0.5;
        for (const [x, y] of live) {
          const vy = y - BUFFER;
          if (vy < 0 || vy >= HEIGHT) continue;
          drawConnected(ctx, x * cell, vy * cell, cell, color, {
            up: member.has(`${x},${y - 1}`),
            down: member.has(`${x},${y + 1}`),
            left: member.has(`${x - 1},${y}`),
            right: member.has(`${x + 1},${y}`),
          }, false);
        }
        ctx.restore();
      }

      // Danger glow as the stack nears the ceiling.
      let top = HEIGHT;
      for (let by = BUFFER; by < state.board.length; by++) {
        if (state.board[by].some((c) => c !== 0)) { top = by - BUFFER; break; }
      }
      const danger = Math.max(0, 1 - top / 6);
      if (danger > 0) {
        const glow = ctx.createLinearGradient(0, 0, 0, h * 0.45);
        glow.addColorStop(0, `rgba(239,68,68,${0.3 * danger})`);
        glow.addColorStop(1, 'rgba(239,68,68,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h * 0.45);
      }

      if (dimmedRef.current || state.dead) {
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(0, 0, w, h);
      }
    };

    return runner.onFrame(draw);
  }, [runner, cell]);

  return (
    <canvas
      ref={ref}
      style={{ width: WIDTH * cell, height: HEIGHT * cell }}
      className="rounded-xl border border-lc-border shadow-[0_0_50px_-16px_rgba(180,249,83,0.35)]"
      data-testid="stacker-board"
      aria-label="Stacker playfield"
    />
  );
}

interface Neighbours { up: boolean; down: boolean; left: boolean; right: boolean }

/**
 * One cell of a larger shape: rounded and bevelled only where it meets empty
 * space, square and seamless where it meets its own kind.
 */
function drawConnected(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  n: Neighbours,
  flat: boolean,
): void {
  const r = size * RADIUS_RATIO;
  // Overlap by half a pixel into joined neighbours so no seam shows through.
  const bleed = 0.5;
  const left = x - (n.left ? bleed : 0);
  const top = y - (n.up ? bleed : 0);
  const right = x + size + (n.right ? bleed : 0);
  const bottom = y + size + (n.down ? bleed : 0);

  ctx.beginPath();
  path(ctx, left, top, right, bottom, {
    tl: !n.up && !n.left ? r : 0,
    tr: !n.up && !n.right ? r : 0,
    br: !n.down && !n.right ? r : 0,
    bl: !n.down && !n.left ? r : 0,
  });

  if (flat) {
    const grad = ctx.createLinearGradient(x, y, x, y + size);
    grad.addColorStop(0, mix(color, '#ffffff', 0.12));
    grad.addColorStop(1, mix(color, '#000000', 0.2));
    ctx.fillStyle = grad;
    ctx.fill();
  } else {
    const grad = ctx.createLinearGradient(x, y, x + size * 0.4, y + size);
    grad.addColorStop(0, mix(color, '#ffffff', 0.34));
    grad.addColorStop(0.5, color);
    grad.addColorStop(1, mix(color, '#000000', 0.3));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Bevel: light along the outer top and left, shadow along bottom and right.
  ctx.lineWidth = Math.max(1, size * 0.07);
  if (!n.up) edge(ctx, x + r * 0.6, y + ctx.lineWidth / 2, x + size - r * 0.6, y + ctx.lineWidth / 2, 'rgba(255,255,255,0.5)');
  if (!n.left) edge(ctx, x + ctx.lineWidth / 2, y + r * 0.6, x + ctx.lineWidth / 2, y + size - r * 0.6, 'rgba(255,255,255,0.3)');
  if (!n.down) edge(ctx, x + r * 0.6, y + size - ctx.lineWidth / 2, x + size - r * 0.6, y + size - ctx.lineWidth / 2, 'rgba(0,0,0,0.45)');
  if (!n.right) edge(ctx, x + size - ctx.lineWidth / 2, y + r * 0.6, x + size - ctx.lineWidth / 2, y + size - r * 0.6, 'rgba(0,0,0,0.35)');
}

function edge(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function path(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  right: number,
  bottom: number,
  r: { tl: number; tr: number; br: number; bl: number },
): void {
  ctx.moveTo(left + r.tl, top);
  ctx.lineTo(right - r.tr, top);
  if (r.tr) ctx.quadraticCurveTo(right, top, right, top + r.tr);
  ctx.lineTo(right, bottom - r.br);
  if (r.br) ctx.quadraticCurveTo(right, bottom, right - r.br, bottom);
  ctx.lineTo(left + r.bl, bottom);
  if (r.bl) ctx.quadraticCurveTo(left, bottom, left, bottom - r.bl);
  ctx.lineTo(left, top + r.tl);
  if (r.tl) ctx.quadraticCurveTo(left, top, left + r.tl, top);
  ctx.closePath();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  path(ctx, x, y, x + w, y + h, { tl: r, tr: r, br: r, bl: r });
}

function mix(hex: string, other: string, amount: number): string {
  const a = parseHex(hex);
  const b = parseHex(other);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * amount));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** A piece drawn in miniature, for the next queue and the hold slot. */
export function PieceChip({ kind, label, dim, size = 15 }: { kind: PieceKind | null; label?: string; dim?: boolean; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    canvas.width = size * 4 * dpr;
    canvas.height = size * 2 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size * 4, size * 2);
    if (!kind) return;

    const color = PIECE_COLORS[PIECES.indexOf(kind) + 1] ?? '#fff';
    const cells = cellsOf({ kind, x: 0, y: 0, rotation: 0 });
    const xs = cells.map(([x]) => x);
    const ys = cells.map(([, y]) => y);
    const offsetX = (4 - (Math.max(...xs) - Math.min(...xs) + 1)) / 2 - Math.min(...xs);
    const offsetY = (2 - (Math.max(...ys) - Math.min(...ys) + 1)) / 2 - Math.min(...ys);
    const member = new Set(cells.map(([x, y]) => `${x},${y}`));

    ctx.globalAlpha = dim ? 0.45 : 1;
    for (const [x, y] of cells) {
      drawConnected(ctx, (x + offsetX) * size, (y + offsetY) * size, size, color, {
        up: member.has(`${x},${y - 1}`),
        down: member.has(`${x},${y + 1}`),
        left: member.has(`${x - 1},${y}`),
        right: member.has(`${x + 1},${y}`),
      }, false);
    }
    ctx.globalAlpha = 1;
  }, [kind, dim, size]);

  return (
    <div className="text-center">
      {label && <div className="text-[9px] uppercase tracking-[0.12em] text-lc-muted">{label}</div>}
      <canvas
        ref={ref}
        style={{ width: size * 4, height: size * 2 }}
        className="mt-0.5"
        data-testid={label ? `chip-${label.toLowerCase()}` : 'chip'}
      />
    </div>
  );
}

/**
 * An opponent's well.
 *
 * Drawn from the snapshot they published a few seconds ago, which is the
 * honest thing to show: their real board is on their machine, and the relay
 * carries a picture of it every few seconds rather than every frame.
 */
export function MiniBoard({
  board,
  height,
  dead,
  cell = 6,
}: {
  board: string | null;
  height: number;
  dead: boolean;
  cell?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const w = WIDTH * cell;
    const h = HEIGHT * cell;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#08080a';
    ctx.fillRect(0, 0, w, h);

    const rows = board ? decodeBoard(board) : null;
    if (rows) {
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const value = rows[y][x];
          if (!value) continue;
          ctx.fillStyle = dead ? '#3f3f46' : (PIECE_COLORS[value] ?? '#888');
          ctx.fillRect(x * cell, y * cell, cell - 0.5, cell - 0.5);
        }
      }
    } else {
      // No snapshot yet: fall back to a bar for how buried they are.
      const filled = Math.min(HEIGHT, height);
      ctx.fillStyle = dead ? '#3f3f46' : '#b4f953';
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, h - filled * cell, w, filled * cell);
      ctx.globalAlpha = 1;
    }

    if (dead) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, w, h);
    }
  }, [board, height, dead, cell]);

  return (
    <canvas
      ref={ref}
      style={{ width: WIDTH * cell, height: HEIGHT * cell }}
      className="rounded-md border border-lc-border"
      data-testid="stacker-miniboard"
    />
  );
}
