import { describe, it, expect } from 'vitest';
import { createState, encodeBoard, decodeBoard, step, HEIGHT, WIDTH, TOTAL_HEIGHT, BUFFER } from './engine';

describe('board snapshots (what opponents actually see)', () => {
  it('round-trips the visible well', () => {
    const s = createState(9);
    s.board[TOTAL_HEIGHT - 1][0] = 3;
    s.board[TOTAL_HEIGHT - 2][5] = 7;
    const rows = decodeBoard(encodeBoard(s))!;
    expect(rows).toHaveLength(HEIGHT);
    expect(rows[HEIGHT - 1][0]).toBe(3);
    expect(rows[HEIGHT - 2][5]).toBe(7);
    expect(rows[0].every((c) => c === 0)).toBe(true);
  });

  it('is small enough to publish every few seconds', () => {
    const s = createState(9);
    step(s, { frame: 1, kind: 'hard' });
    expect(encodeBoard(s)).toHaveLength(HEIGHT * WIDTH);
  });

  it('carries only the visible rows, not the spawn buffer', () => {
    const s = createState(9);
    s.board[BUFFER - 1][0] = 5; // above the ceiling
    const rows = decodeBoard(encodeBoard(s))!;
    expect(rows.every((row) => row.every((c) => c === 0))).toBe(true);
  });

  it('refuses a snapshot of the wrong size', () => {
    expect(decodeBoard('abc')).toBeNull();
    expect(decodeBoard('')).toBeNull();
  });
});
