/**
 * Stacker — the falling-block engine.
 *
 * (Named Stacker, not the obvious thing: that word is a trademark and this is
 * shipping in a product, so the genre stays and the name doesn't.)
 *
 * Deterministic by construction: the whole game is a pure function of
 * `(seed, ordered inputs)`. No wall clock, no randomness, no I/O — time enters
 * only as a frame number the caller supplies. That is what makes a match over
 * a relay both smooth and checkable:
 *
 *   - **smooth**, because each client simulates its own board locally at
 *     60 Hz and never waits for the network to draw a frame;
 *   - **checkable**, because a client publishes its input log alongside the
 *     attacks it claims, and anyone can replay that log against the shared
 *     seed and confirm the attacks were real.
 *
 * Two players on the same seed get the same pieces in the same order, so a
 * match is a fair race rather than a comparison of luck.
 */

export const WIDTH = 10;
/** Visible rows. */
export const HEIGHT = 20;
/** Extra rows above the ceiling where pieces spawn and stacks may briefly poke. */
export const BUFFER = 20;
export const TOTAL_HEIGHT = HEIGHT + BUFFER;

export const PIECES = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'] as const;
export type PieceKind = (typeof PIECES)[number];
/** 0 = empty, 8 = garbage, otherwise the 1-based index into PIECES. */
export type Cell = number;

export const GARBAGE_CELL = 8;

/** Spawn shapes, as offsets from the piece origin, in rotation state 0. */
const SHAPES: Record<PieceKind, Array<[number, number]>> = {
  I: [[0, 1], [1, 1], [2, 1], [3, 1]],
  J: [[0, 0], [0, 1], [1, 1], [2, 1]],
  L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  O: [[1, 0], [2, 0], [1, 1], [2, 1]],
  S: [[1, 0], [2, 0], [0, 1], [1, 1]],
  T: [[1, 0], [0, 1], [1, 1], [2, 1]],
  Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
};

/** Rotation is about the piece's bounding box: 3×3 for most, 4×4 for I and O. */
const BOX: Record<PieceKind, number> = { I: 4, J: 3, L: 3, O: 4, S: 3, T: 3, Z: 3 };

export type Rotation = 0 | 1 | 2 | 3;

export interface ActivePiece {
  kind: PieceKind;
  /** Top-left of the piece's bounding box, in board coordinates. */
  x: number;
  y: number;
  rotation: Rotation;
}

export type InputKind =
  | 'left' | 'right'
  | 'cw' | 'ccw' | 'flip'
  | 'soft' | 'hard'
  | 'hold'
  | 'gravity'
  | 'garbage';

export interface Input {
  /** Frame this input happens on. Must be non-decreasing across the log. */
  frame: number;
  kind: InputKind;
  /** For `garbage`: how many lines, and which column the hole sits in. */
  lines?: number;
  hole?: number;
}

export interface ClearEvent {
  frame: number;
  lines: number;
  /** Lines of garbage this clear sends, after combo / back-to-back / spin. */
  attack: number;
  spin: boolean;
  miniSpin: boolean;
  perfectClear: boolean;
  combo: number;
  backToBack: number;
}

export interface GameState {
  board: Cell[][];
  active: ActivePiece | null;
  hold: PieceKind | null;
  holdUsed: boolean;
  /** Upcoming pieces; always kept at least 5 deep. */
  queue: PieceKind[];
  bagIndex: number;
  seed: number;
  frame: number;
  linesCleared: number;
  /** Garbage waiting to land, oldest first. */
  incoming: Array<{ lines: number; hole: number }>;
  attacksSent: number;
  combo: number;
  backToBack: number;
  dead: boolean;
  /** Every clear so far — the record a checkpoint's claims are checked against. */
  clears: ClearEvent[];
}

/* ── deterministic randomness ─────────────────────────────────────────── */

/** mulberry32, same generator Vesta uses, so both games shuffle alike. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The 7-bag: every seven pieces contain each shape exactly once, shuffled.
 * Bag `n` is derived from `seed + n`, so any client can produce the sequence
 * from any point without replaying the ones before it.
 */
export function bag(seed: number, index: number): PieceKind[] {
  const rng = mulberry32((seed + index * 0x9e3779b9) >>> 0);
  const out = [...PIECES];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ── geometry ─────────────────────────────────────────────────────────── */

/** Cells a piece occupies, in board coordinates. */
export function cellsOf(piece: ActivePiece): Array<[number, number]> {
  const box = BOX[piece.kind];
  return SHAPES[piece.kind].map(([sx, sy]) => {
    let x = sx;
    let y = sy;
    for (let r = 0; r < piece.rotation; r++) {
      const nx = box - 1 - y;
      const ny = x;
      x = nx;
      y = ny;
    }
    return [piece.x + x, piece.y + y] as [number, number];
  });
}

export function emptyBoard(): Cell[][] {
  return Array.from({ length: TOTAL_HEIGHT }, () => Array<Cell>(WIDTH).fill(0));
}

function collides(board: Cell[][], piece: ActivePiece): boolean {
  for (const [x, y] of cellsOf(piece)) {
    if (x < 0 || x >= WIDTH || y >= TOTAL_HEIGHT) return true;
    if (y < 0) continue;
    if (board[y][x] !== 0) return true;
  }
  return false;
}

/** SRS wall kicks. Index by `from*4 + to`; I has its own table. */
const KICKS_JLSTZ: Record<string, Array<[number, number]>> = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I: Record<string, Array<[number, number]>> = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

function kicksFor(kind: PieceKind, from: Rotation, to: Rotation): Array<[number, number]> {
  if (kind === 'O') return [[0, 0]];
  const table = kind === 'I' ? KICKS_I : KICKS_JLSTZ;
  return table[`${from}>${to}`] ?? [[0, 0]];
}

/* ── attack table ─────────────────────────────────────────────────────── */

/** Combo bonus, tetr.io-ish: it ramps and then flattens. */
const COMBO_BONUS = [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5];

/**
 * Lines of garbage a clear sends.
 *
 * Roughly the modern multiplayer table: a quad is worth four, spins pay
 * double what the same line count pays flat, back-to-back adds one, combo
 * ramps, and a perfect clear is worth ten.
 */
export function attackFor(opts: {
  lines: number;
  spin: boolean;
  miniSpin: boolean;
  combo: number;
  backToBack: number;
  perfectClear: boolean;
}): number {
  const { lines, spin, miniSpin, combo, backToBack, perfectClear } = opts;
  if (lines === 0) return 0;

  let base: number;
  if (spin) base = lines * 2;
  else if (miniSpin) base = lines === 1 ? 0 : lines - 1;
  else base = lines === 1 ? 0 : lines === 2 ? 1 : lines === 3 ? 2 : 4;

  if (backToBack > 0 && (spin || lines === 4)) base += 1;
  base += COMBO_BONUS[Math.min(combo, COMBO_BONUS.length - 1)];
  if (perfectClear) base += 10;
  return base;
}

/* ── the engine ───────────────────────────────────────────────────────── */

export function createState(seed: number): GameState {
  const state: GameState = {
    board: emptyBoard(),
    active: null,
    hold: null,
    holdUsed: false,
    queue: [],
    bagIndex: 0,
    seed,
    frame: 0,
    linesCleared: 0,
    incoming: [],
    attacksSent: 0,
    combo: 0,
    backToBack: 0,
    dead: false,
    clears: [],
  };
  refillQueue(state);
  spawn(state);
  return state;
}

function refillQueue(state: GameState): void {
  while (state.queue.length < 7) {
    state.queue.push(...bag(state.seed, state.bagIndex));
    state.bagIndex += 1;
  }
}

function spawnPositionFor(kind: PieceKind): ActivePiece {
  return {
    kind,
    x: kind === 'I' || kind === 'O' ? 3 : 3,
    // Spawn just above the visible ceiling, the way every modern client does.
    y: BUFFER - 2,
    rotation: 0,
  };
}

function spawn(state: GameState, forced?: PieceKind): void {
  refillQueue(state);
  const kind = forced ?? state.queue.shift()!;
  const piece = spawnPositionFor(kind);
  if (collides(state.board, piece)) {
    // Blocked at spawn — the stack reached the ceiling.
    state.dead = true;
    state.active = null;
    return;
  }
  state.active = piece;
  state.holdUsed = false;
  refillQueue(state);
}

function tryMove(state: GameState, dx: number, dy: number): boolean {
  if (!state.active) return false;
  const moved = { ...state.active, x: state.active.x + dx, y: state.active.y + dy };
  if (collides(state.board, moved)) return false;
  state.active = moved;
  return true;
}

function tryRotate(state: GameState, delta: 1 | 2 | 3): boolean {
  if (!state.active) return false;
  const from = state.active.rotation;
  const to = ((from + delta) % 4) as Rotation;
  const kicks = delta === 2 ? [[0, 0] as [number, number]] : kicksFor(state.active.kind, from, to);
  for (const [kx, ky] of kicks) {
    const candidate: ActivePiece = { ...state.active, rotation: to, x: state.active.x + kx, y: state.active.y - ky };
    if (!collides(state.board, candidate)) {
      state.active = candidate;
      return true;
    }
  }
  return false;
}

/** Is the piece pinned on three of its four corners? That's a spin. */
function detectSpin(state: GameState, piece: ActivePiece, lastWasKick: boolean): { spin: boolean; mini: boolean } {
  if (piece.kind !== 'T') return { spin: false, mini: false };
  const box = BOX.T;
  const corners: Array<[number, number]> = [
    [piece.x, piece.y],
    [piece.x + box - 1, piece.y],
    [piece.x, piece.y + box - 1],
    [piece.x + box - 1, piece.y + box - 1],
  ];
  const filled = corners.filter(([x, y]) =>
    x < 0 || x >= WIDTH || y >= TOTAL_HEIGHT || (y >= 0 && state.board[y][x] !== 0));
  if (filled.length < 3) return { spin: false, mini: false };
  // Front corners are the two the T points toward; both filled = full spin.
  const frontByRotation: Record<Rotation, Array<0 | 1 | 2 | 3>> = {
    0: [0, 1], 1: [1, 3], 2: [2, 3], 3: [0, 2],
  };
  const front = frontByRotation[piece.rotation];
  const frontFilled = front.filter((i) => {
    const [x, y] = corners[i];
    return x < 0 || x >= WIDTH || y >= TOTAL_HEIGHT || (y >= 0 && state.board[y][x] !== 0);
  }).length;
  if (frontFilled === 2) return { spin: true, mini: false };
  return { spin: false, mini: lastWasKick };
}

function clearLines(state: GameState): number {
  let cleared = 0;
  for (let y = TOTAL_HEIGHT - 1; y >= 0; y--) {
    if (state.board[y].every((c) => c !== 0)) {
      state.board.splice(y, 1);
      state.board.unshift(Array<Cell>(WIDTH).fill(0));
      cleared += 1;
      y += 1;
    }
  }
  return cleared;
}

function boardEmpty(state: GameState): boolean {
  return state.board.every((row) => row.every((c) => c === 0));
}

/** Push queued garbage up from the bottom, each row with one hole. */
function applyGarbage(state: GameState): void {
  while (state.incoming.length > 0) {
    const next = state.incoming.shift()!;
    for (let i = 0; i < next.lines; i++) {
      state.board.shift();
      const row = Array<Cell>(WIDTH).fill(GARBAGE_CELL);
      row[next.hole % WIDTH] = 0;
      state.board.push(row);
    }
  }
  // If the stack was pushed into the active piece, nudge it up.
  if (state.active) {
    let guard = 0;
    while (collides(state.board, state.active) && guard++ < TOTAL_HEIGHT) {
      state.active = { ...state.active, y: state.active.y - 1 };
    }
    if (collides(state.board, state.active)) state.dead = true;
  }
}

function lockPiece(state: GameState, lastWasKick: boolean): void {
  const piece = state.active;
  if (!piece) return;

  const { spin, mini } = detectSpin(state, piece, lastWasKick);

  const index = PIECES.indexOf(piece.kind) + 1;
  for (const [x, y] of cellsOf(piece)) {
    if (y < 0 || y >= TOTAL_HEIGHT || x < 0 || x >= WIDTH) continue;
    state.board[y][x] = index;
  }
  state.active = null;

  const lines = clearLines(state);
  const perfect = lines > 0 && boardEmpty(state);

  if (lines > 0) {
    state.combo += 1;
    const isB2BClear = lines === 4 || spin;
    const attack = attackFor({
      lines,
      spin,
      miniSpin: mini,
      combo: state.combo - 1,
      backToBack: state.backToBack,
      perfectClear: perfect,
    });
    state.backToBack = isB2BClear ? state.backToBack + 1 : 0;
    state.linesCleared += lines;
    state.attacksSent += attack;
    state.clears.push({
      frame: state.frame,
      lines,
      attack,
      spin,
      miniSpin: mini,
      perfectClear: perfect,
      combo: state.combo - 1,
      backToBack: state.backToBack,
    });
    // Outgoing attacks cancel what is waiting to land on you.
    let remaining = attack;
    while (remaining > 0 && state.incoming.length > 0) {
      const head = state.incoming[0];
      const eaten = Math.min(remaining, head.lines);
      head.lines -= eaten;
      remaining -= eaten;
      if (head.lines === 0) state.incoming.shift();
    }
  } else {
    state.combo = 0;
    // A piece that cleared nothing lets the queued garbage in.
    applyGarbage(state);
  }

  if (!state.dead) spawn(state);
}

/**
 * Apply one input to the state. Pure in spirit — it mutates the state it is
 * given, and callers that need history keep their own copies (`replay` below
 * always starts from a fresh state).
 */
export function step(state: GameState, input: Input): GameState {
  if (state.dead) return state;
  state.frame = Math.max(state.frame, input.frame);

  switch (input.kind) {
    case 'left':
      tryMove(state, -1, 0);
      break;
    case 'right':
      tryMove(state, 1, 0);
      break;
    case 'cw':
      tryRotate(state, 1);
      break;
    case 'ccw':
      tryRotate(state, 3);
      break;
    case 'flip':
      tryRotate(state, 2);
      break;
    case 'soft':
      tryMove(state, 0, 1);
      break;
    case 'gravity':
      if (!tryMove(state, 0, 1)) lockPiece(state, false);
      break;
    case 'hard': {
      while (tryMove(state, 0, 1)) { /* fall to the floor */ }
      lockPiece(state, false);
      break;
    }
    case 'hold': {
      if (state.holdUsed || !state.active) break;
      const current = state.active.kind;
      const swap = state.hold;
      state.hold = current;
      spawn(state, swap ?? undefined);
      state.holdUsed = true;
      break;
    }
    case 'garbage': {
      const lines = Math.max(0, Math.floor(input.lines ?? 0));
      if (lines > 0) {
        state.incoming.push({ lines, hole: Math.abs(Math.floor(input.hole ?? 0)) % WIDTH });
      }
      break;
    }
  }
  return state;
}

/**
 * Rebuild a board from nothing but the seed and the inputs.
 *
 * This is the honest-play check: a player publishes their input log with the
 * attacks they claim, and anyone can run this and see whether those attacks
 * actually happened. It is also how the local client recovers from a reload.
 */
export function replay(seed: number, inputs: readonly Input[]): GameState {
  const state = createState(seed);
  for (const input of inputs) step(state, input);
  return state;
}

/** Total attack a log actually produces — what a claim gets measured against. */
export function attackFromLog(seed: number, inputs: readonly Input[]): number {
  return replay(seed, inputs).attacksSent;
}

/** Height of the tallest column, for the danger meter and mini-boards. */
export function stackHeight(state: GameState): number {
  for (let y = 0; y < TOTAL_HEIGHT; y++) {
    if (state.board[y].some((c) => c !== 0)) return TOTAL_HEIGHT - y;
  }
  return 0;
}

/**
 * Can the active piece still fall? The loop needs this to implement lock
 * delay: a piece that has landed gets a moment to slide before it cements,
 * which is the difference between this feeling right and feeling stiff.
 */
export function canFall(state: GameState): boolean {
  if (!state.active) return false;
  return !collides(state.board, { ...state.active, y: state.active.y + 1 });
}

/** Where the active piece would land — the ghost. */
export function ghostOf(state: GameState): ActivePiece | null {
  if (!state.active) return null;
  let ghost = state.active;
  for (;;) {
    const next = { ...ghost, y: ghost.y + 1 };
    if (collides(state.board, next)) return ghost;
    ghost = next;
  }
}
