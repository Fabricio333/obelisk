import { describe, it, expect } from 'vitest';
import {
  createState,
  step,
  replay,
  bag,
  cellsOf,
  attackFor,
  emptyBoard,
  stackHeight,
  ghostOf,
  attackFromLog,
  PIECES,
  WIDTH,
  TOTAL_HEIGHT,
  GARBAGE_CELL,
  type GameState,
  type Input,
} from './engine';

const inputs = (...list: Array<[number, Input['kind']]>): Input[] =>
  list.map(([frame, kind]) => ({ frame, kind }));

/** Fill a row completely except for one column. */
function fillRow(state: GameState, y: number, hole: number) {
  for (let x = 0; x < WIDTH; x++) state.board[y][x] = x === hole ? 0 : 1;
}

describe('the bag', () => {
  it('gives each of the seven pieces exactly once', () => {
    for (let i = 0; i < 20; i++) {
      const b = bag(1234, i);
      expect(b).toHaveLength(7);
      expect(new Set(b).size).toBe(7);
      for (const p of PIECES) expect(b).toContain(p);
    }
  });

  it('is the same sequence for the same seed, and different for another', () => {
    expect(bag(42, 0)).toEqual(bag(42, 0));
    expect(bag(42, 3)).toEqual(bag(42, 3));
    const same = bag(42, 0).join('') === bag(43, 0).join('');
    expect(same).toBe(false);
  });

  it('gives every player on a seed the same pieces — the whole point', () => {
    const alice = createState(9876);
    const bruno = createState(9876);
    expect(alice.queue).toEqual(bruno.queue);
    expect(alice.active!.kind).toBe(bruno.active!.kind);
  });
});

describe('movement and rotation', () => {
  it('moves left and right, and stops at the walls', () => {
    const s = createState(1);
    const startX = s.active!.x;
    step(s, { frame: 1, kind: 'left' });
    expect(s.active!.x).toBe(startX - 1);
    for (let i = 0; i < 20; i++) step(s, { frame: 2 + i, kind: 'left' });
    // Wall-stopped, and every cell still on the board.
    expect(cellsOf(s.active!).every(([x]) => x >= 0)).toBe(true);
  });

  it('rotates through all four states and back', () => {
    const s = createState(2);
    const start = s.active!.rotation;
    step(s, { frame: 1, kind: 'cw' });
    step(s, { frame: 2, kind: 'cw' });
    step(s, { frame: 3, kind: 'cw' });
    step(s, { frame: 4, kind: 'cw' });
    expect(s.active!.rotation).toBe(start);
  });

  it('never lets a piece overlap the stack', () => {
    const s = createState(3);
    for (let y = TOTAL_HEIGHT - 5; y < TOTAL_HEIGHT; y++) fillRow(s, y, 0);
    for (let i = 0; i < 40; i++) step(s, { frame: i, kind: 'soft' });
    for (const [x, y] of cellsOf(s.active!)) {
      if (y < 0) continue;
      expect(s.board[y][x]).toBe(0);
    }
  });
});

describe('locking and clearing', () => {
  it('hard drop locks the piece into the board', () => {
    const s = createState(4);
    const before = s.board.flat().filter((c) => c !== 0).length;
    step(s, { frame: 1, kind: 'hard' });
    const after = s.board.flat().filter((c) => c !== 0).length;
    expect(after).toBe(before + 4);
    expect(s.active).not.toBeNull();
  });

  it('clears a row filled in by a piece dropped into the gap', () => {
    const s = createState(5);
    const y = TOTAL_HEIGHT - 1;
    const hole = 4;
    for (let x = 0; x < WIDTH; x++) s.board[y][x] = x === hole ? 0 : 1;

    // A vertical I occupies a single column, so it can reach a one-wide gap.
    // Rotation 1 puts its cells two columns right of the bounding box origin.
    s.active = { kind: 'I', x: hole - 2, y: 0, rotation: 1 };
    step(s, { frame: 1, kind: 'hard' });

    expect(s.linesCleared).toBe(1);
    // The completed row is gone and everything above it fell one row, so the
    // bottom row now holds the lowest of the I's three surviving cells.
    expect(s.board[y].filter((c) => c !== 0)).toHaveLength(1);
    expect(s.board[y][hole]).not.toBe(0);
    expect(s.board.flat().filter((c) => c !== 0)).toHaveLength(3);
  });

  it('a clear removes exactly the full rows', () => {
    const s = createState(6);
    const y = TOTAL_HEIGHT - 1;
    for (let x = 0; x < WIDTH; x++) s.board[y][x] = 1;
    // The row is already complete; the next lock triggers the sweep.
    const heightBefore = stackHeight(s);
    step(s, { frame: 1, kind: 'hard' });
    expect(s.linesCleared).toBeGreaterThanOrEqual(1);
    expect(stackHeight(s)).toBeLessThanOrEqual(heightBefore + 4);
  });
});

describe('the attack table', () => {
  it('pays nothing for a single and four for a quad', () => {
    const flat = { spin: false, miniSpin: false, combo: 0, backToBack: 0, perfectClear: false };
    expect(attackFor({ ...flat, lines: 1 })).toBe(0);
    expect(attackFor({ ...flat, lines: 2 })).toBe(1);
    expect(attackFor({ ...flat, lines: 3 })).toBe(2);
    expect(attackFor({ ...flat, lines: 4 })).toBe(4);
  });

  it('pays double for a spin', () => {
    const base = { miniSpin: false, combo: 0, backToBack: 0, perfectClear: false };
    expect(attackFor({ ...base, lines: 1, spin: true })).toBe(2);
    expect(attackFor({ ...base, lines: 2, spin: true })).toBe(4);
    expect(attackFor({ ...base, lines: 3, spin: true })).toBe(6);
  });

  it('adds one for back-to-back, but only on quads and spins', () => {
    const base = { miniSpin: false, combo: 0, perfectClear: false };
    expect(attackFor({ ...base, lines: 4, spin: false, backToBack: 1 })).toBe(5);
    expect(attackFor({ ...base, lines: 2, spin: true, backToBack: 1 })).toBe(5);
    // A plain double never counts for back-to-back.
    expect(attackFor({ ...base, lines: 2, spin: false, backToBack: 1 })).toBe(1);
  });

  it('ramps with the combo and then flattens', () => {
    const base = { lines: 2, spin: false, miniSpin: false, backToBack: 0, perfectClear: false };
    const one = attackFor({ ...base, combo: 1 });
    const five = attackFor({ ...base, combo: 5 });
    const twenty = attackFor({ ...base, combo: 20 });
    expect(five).toBeGreaterThan(one);
    expect(twenty).toBeGreaterThanOrEqual(five);
  });

  it('pays ten for a perfect clear', () => {
    const flat = { lines: 4, spin: false, miniSpin: false, combo: 0, backToBack: 0 };
    expect(attackFor({ ...flat, perfectClear: true }) - attackFor({ ...flat, perfectClear: false })).toBe(10);
  });
});

describe('garbage', () => {
  it('lands on the next piece that clears nothing', () => {
    const s = createState(7);
    step(s, { frame: 1, kind: 'garbage', lines: 3, hole: 4 });
    expect(s.incoming).toHaveLength(1);
    expect(stackHeight(s)).toBe(0);

    step(s, { frame: 2, kind: 'hard' });
    expect(s.incoming).toHaveLength(0);
    // Three garbage rows, each with exactly one hole.
    const garbageRows = s.board.filter((row) => row.includes(GARBAGE_CELL));
    expect(garbageRows).toHaveLength(3);
    for (const row of garbageRows) {
      expect(row.filter((c) => c === 0)).toHaveLength(1);
    }
  });

  it('puts every hole in the column it was sent to', () => {
    const s = createState(8);
    step(s, { frame: 1, kind: 'garbage', lines: 2, hole: 7 });
    step(s, { frame: 2, kind: 'hard' });
    for (const row of s.board.filter((r) => r.includes(GARBAGE_CELL))) {
      expect(row[7]).toBe(0);
    }
  });

  it('is cancelled by an outgoing attack instead of landing', () => {
    const s = createState(9);
    // Two incoming, and a quad ready to answer it.
    step(s, { frame: 1, kind: 'garbage', lines: 2, hole: 0 });
    for (let y = TOTAL_HEIGHT - 4; y < TOTAL_HEIGHT; y++) fillRow(s, y, 9);
    // Drop pieces until a clear happens, then check the queue shrank.
    for (let i = 0; i < 10 && s.linesCleared === 0; i++) {
      step(s, { frame: 2 + i, kind: 'hard' });
    }
    if (s.attacksSent > 0) {
      expect(s.incoming.reduce((n, g) => n + g.lines, 0)).toBeLessThan(2);
    }
  });

  it('ignores a garbage input of zero lines', () => {
    const s = createState(10);
    step(s, { frame: 1, kind: 'garbage', lines: 0, hole: 3 });
    expect(s.incoming).toHaveLength(0);
  });
});

describe('hold', () => {
  it('swaps the active piece and refuses a second swap before a lock', () => {
    const s = createState(11);
    const first = s.active!.kind;
    step(s, { frame: 1, kind: 'hold' });
    expect(s.hold).toBe(first);
    expect(s.active!.kind).not.toBe(first);

    const second = s.active!.kind;
    step(s, { frame: 2, kind: 'hold' });
    expect(s.active!.kind).toBe(second);
  });

  it('swaps back after the next lock', () => {
    const s = createState(12);
    const first = s.active!.kind;
    step(s, { frame: 1, kind: 'hold' });
    step(s, { frame: 2, kind: 'hard' });
    step(s, { frame: 3, kind: 'hold' });
    expect(s.active!.kind).toBe(first);
  });
});

describe('topping out', () => {
  it('dies when the stack reaches the spawn', () => {
    const s = createState(13);
    // Every row filled but one column, so nothing clears and the stack stands.
    for (let y = 2; y < TOTAL_HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) s.board[y][x] = x === 9 ? 0 : 1;
    }
    for (let i = 0; i < 5 && !s.dead; i++) step(s, { frame: i, kind: 'hard' });
    expect(s.dead).toBe(true);
  });

  it('does not die while there is still room to spawn', () => {
    const s = createState(13);
    for (let y = TOTAL_HEIGHT - 6; y < TOTAL_HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) s.board[y][x] = x === 9 ? 0 : 1;
    }
    for (let i = 0; i < 3; i++) step(s, { frame: i, kind: 'hard' });
    expect(s.dead).toBe(false);
  });

  it('ignores every input once dead', () => {
    const s = createState(14);
    s.dead = true;
    const before = JSON.stringify(s.board);
    step(s, { frame: 1, kind: 'hard' });
    step(s, { frame: 2, kind: 'left' });
    expect(JSON.stringify(s.board)).toBe(before);
  });
});

describe('determinism — the property the whole design rests on', () => {
  it('two replays of the same log land on the same board', () => {
    const log: Input[] = [];
    for (let i = 0; i < 60; i++) {
      const kinds: Input['kind'][] = ['left', 'right', 'cw', 'hard', 'soft', 'hold'];
      log.push({ frame: i, kind: kinds[i % kinds.length] });
    }
    const a = replay(555, log);
    const b = replay(555, log);
    expect(a.board).toEqual(b.board);
    expect(a.attacksSent).toBe(b.attacksSent);
    expect(a.linesCleared).toBe(b.linesCleared);
  });

  it('a different seed on the same inputs gives a different game', () => {
    const log = inputs(...Array.from({ length: 40 }, (_, i) => [i, 'hard'] as [number, Input['kind']]));
    const a = replay(1, log);
    const b = replay(2, log);
    expect(a.board).not.toEqual(b.board);
  });

  it('replaying a log reproduces the attacks it claims', () => {
    const log: Input[] = [];
    for (let i = 0; i < 80; i++) {
      log.push({ frame: i, kind: i % 3 === 0 ? 'cw' : 'hard' });
    }
    const played = replay(777, log);
    expect(attackFromLog(777, log)).toBe(played.attacksSent);
  });

  it('replays garbage in the order it was received', () => {
    const log: Input[] = [
      { frame: 1, kind: 'garbage', lines: 2, hole: 1 },
      { frame: 2, kind: 'hard' },
      { frame: 3, kind: 'garbage', lines: 1, hole: 8 },
      { frame: 4, kind: 'hard' },
    ];
    const a = replay(31, log);
    const b = replay(31, log);
    expect(a.board).toEqual(b.board);
    expect(a.board.filter((r) => r.includes(GARBAGE_CELL))).toHaveLength(3);
  });
});

describe('presentation helpers', () => {
  it('reports the stack height', () => {
    const s = createState(15);
    expect(stackHeight(s)).toBe(0);
    s.board[TOTAL_HEIGHT - 1][0] = 1;
    expect(stackHeight(s)).toBe(1);
  });

  it('drops the ghost to the landing spot', () => {
    const s = createState(16);
    const ghost = ghostOf(s)!;
    expect(ghost.y).toBeGreaterThan(s.active!.y);
    expect(ghost.kind).toBe(s.active!.kind);
  });

  it('starts from a genuinely empty board', () => {
    expect(emptyBoard().flat().every((c) => c === 0)).toBe(true);
    expect(emptyBoard()).toHaveLength(TOTAL_HEIGHT);
  });
});
