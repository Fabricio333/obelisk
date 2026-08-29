'use client';

import { useEffect, useRef } from 'react';
import {
  cellsOf,
  ghostOf,
  BUFFER,
  HEIGHT,
  WIDTH,
  GARBAGE_CELL,
  PIECES,
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

const CELL = 26;
const RADIUS = 4;

/**
 * The playfield.
 *
 * It renders itself: the component subscribes to the runner's frame callback
 * and paints straight to the canvas, so drawing never goes through React. That
 * is the difference between this feeling like a game and feeling like a web
 * page pretending to be one.
 *
 * Only the visible twenty rows are painted — the buffer above exists so pieces
 * have somewhere to spawn.
 */
export default function StackerBoard({
  runner,
  dimmed,
}: {
  runner: StackerRunner;
  dimmed?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The draw loop runs outside React, so the dim flag reaches it through a
  // ref. Written in an effect rather than during render.
  const dimmedRef = useRef(dimmed);
  useEffect(() => { dimmedRef.current = dimmed; }, [dimmed]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Draw at device resolution so the blocks have clean edges on retina.
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const w = WIDTH * CELL;
    const h = HEIGHT * CELL;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const draw = (state: GameState) => {
      ctx.clearRect(0, 0, w, h);

      // Well, with a faint vertical gradient so it has some depth.
      const bg = ctx.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#0d0d0f');
      bg.addColorStop(1, '#08080a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255,255,255,0.035)';
      ctx.lineWidth = 1;
      for (let x = 1; x < WIDTH; x++) {
        ctx.beginPath();
        ctx.moveTo(x * CELL + 0.5, 0);
        ctx.lineTo(x * CELL + 0.5, h);
        ctx.stroke();
      }
      for (let y = 1; y < HEIGHT; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * CELL + 0.5);
        ctx.lineTo(w, y * CELL + 0.5);
        ctx.stroke();
      }

      // Locked cells
      for (let by = 0; by < state.board.length; by++) {
        const vy = by - BUFFER;
        if (vy < 0 || vy >= HEIGHT) continue;
        for (let bx = 0; bx < WIDTH; bx++) {
          const cell = state.board[by][bx];
          if (cell === 0) continue;
          block(ctx, bx * CELL, vy * CELL, PIECE_COLORS[cell] ?? '#888', cell === GARBAGE_CELL);
        }
      }

      // Ghost first, then the live piece on top, with a glow.
      const ghost = ghostOf(state);
      if (state.active) {
        const color = PIECE_COLORS[PIECES.indexOf(state.active.kind) + 1] ?? '#fff';
        if (ghost) {
          for (const [x, y] of cellsOf(ghost)) {
            const vy = y - BUFFER;
            if (vy < 0 || vy >= HEIGHT) continue;
            ctx.strokeStyle = color;
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 2;
            roundRect(ctx, x * CELL + 3, vy * CELL + 3, CELL - 6, CELL - 6, RADIUS - 1);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        for (const [x, y] of cellsOf(state.active)) {
          const vy = y - BUFFER;
          if (vy < 0 || vy >= HEIGHT) continue;
          block(ctx, x * CELL, vy * CELL, color, false);
        }
        ctx.restore();
      }

      // Danger: the well glows red as the stack approaches the ceiling.
      let top = HEIGHT;
      for (let by = BUFFER; by < state.board.length; by++) {
        if (state.board[by].some((c) => c !== 0)) { top = by - BUFFER; break; }
      }
      const danger = Math.max(0, 1 - top / 6);
      if (danger > 0) {
        const glow = ctx.createLinearGradient(0, 0, 0, h * 0.5);
        glow.addColorStop(0, `rgba(239,68,68,${0.32 * danger})`);
        glow.addColorStop(1, 'rgba(239,68,68,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h * 0.5);
      }

      if (dimmedRef.current || state.dead) {
        ctx.fillStyle = 'rgba(0,0,0,0.62)';
        ctx.fillRect(0, 0, w, h);
      }
    };

    return runner.onFrame(draw);
  }, [runner]);

  return (
    <canvas
      ref={ref}
      style={{ width: WIDTH * CELL, height: HEIGHT * CELL }}
      className="rounded-xl border border-lc-border shadow-[0_0_40px_-12px_rgba(180,249,83,0.25)]"
      data-testid="stacker-board"
      aria-label="Stacker playfield"
    />
  );
}

/** A single block: base colour, a lit top edge, and a darker foot. */
function block(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, flat: boolean): void {
  const pad = 1;
  const size = CELL - pad * 2;
  roundRect(ctx, x + pad, y + pad, size, size, RADIUS);
  if (flat) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  const grad = ctx.createLinearGradient(x, y, x, y + CELL);
  grad.addColorStop(0, mix(color, '#ffffff', 0.28));
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, mix(color, '#000000', 0.32));
  ctx.fillStyle = grad;
  ctx.fill();

  // Specular line along the top edge — cheap, and it reads as three-dimensional.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + pad + RADIUS, y + pad + 1);
  ctx.lineTo(x + pad + size - RADIUS, y + pad + 1);
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
export function PieceChip({ kind, label, dim }: { kind: PieceKind | null; label?: string; dim?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 15;

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

    ctx.globalAlpha = dim ? 0.35 : 1;
    for (const [x, y] of cells) {
      const px = (x + offsetX) * size;
      const py = (y + offsetY) * size;
      const grad = ctx.createLinearGradient(px, py, px, py + size);
      grad.addColorStop(0, mix(color, '#ffffff', 0.25));
      grad.addColorStop(1, mix(color, '#000000', 0.25));
      roundRect(ctx, px + 1, py + 1, size - 2, size - 2, 3);
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [kind, dim]);

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

/** A compact opponent well: how buried they are, nothing more. */
export function MiniBoard({ height, dead }: { height: number; dead: boolean }) {
  const blocks = 10;
  const filled = Math.round((Math.min(HEIGHT, height) / HEIGHT) * blocks);
  return (
    <div className="flex h-20 w-9 flex-col-reverse gap-[2px] rounded-lg border border-lc-border bg-lc-black/70 p-1">
      {Array.from({ length: blocks }, (_, i) => {
        const on = i < filled;
        const danger = i >= blocks - 3;
        return (
          <span
            key={i}
            className="block flex-1 rounded-[2px] transition-colors duration-200"
            style={{
              background: dead
                ? '#3f3f46'
                : on
                  ? (danger ? '#ef4444' : '#b4f953')
                  : 'rgba(255,255,255,0.05)',
              boxShadow: on && !dead ? `0 0 6px ${danger ? '#ef4444' : '#b4f953'}55` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}
