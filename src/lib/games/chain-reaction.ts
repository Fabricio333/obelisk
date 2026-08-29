import type { ApplyResult, GameDefinition } from './types';

export const CR_MAX_PLAYERS = 8;

export const CR_SIZES = {
  small: { rows: 7, cols: 5, label: 'Chico (5×7)' },
  medium: { rows: 9, cols: 6, label: 'Mediano (6×9)' },
  large: { rows: 12, cols: 8, label: 'Grande (8×12)' },
} as const;
export type CRSizeKey = keyof typeof CR_SIZES;

export interface CRCell {
  count: number;
  owner: number | null; // seat index
}

export interface CRState {
  rows: number;
  cols: number;
  cells: CRCell[]; // length rows*cols, row-major
  seats: Record<string, number>; // pubkey -> seat index
  order: string[]; // seat index -> pubkey
  placed: boolean[]; // per seat; true once that player has moved
  eliminated: string[]; // pubkeys
}

export interface CRAction {
  cell: number;
}

function idx(cols: number, r: number, c: number) {
  return r * cols + c;
}

function neighbors(rows: number, cols: number, i: number): number[] {
  const r = Math.floor(i / cols);
  const c = i % cols;
  const out: number[] = [];
  if (r > 0) out.push(idx(cols, r - 1, c));
  if (r < rows - 1) out.push(idx(cols, r + 1, c));
  if (c > 0) out.push(idx(cols, r, c - 1));
  if (c < cols - 1) out.push(idx(cols, r, c + 1));
  return out;
}

export function criticalMassAt(rows: number, cols: number, i: number): number {
  return neighbors(rows, cols, i).length;
}

function aliveSeats(state: CRState): Set<number> {
  const owners = new Set<number>();
  for (const c of state.cells) if (c.owner !== null) owners.add(c.owner);
  return owners;
}

function nextTurnPubkey(state: CRState, currentActor: string): string | null {
  const n = state.order.length;
  const start = state.order.indexOf(currentActor);
  for (let step = 1; step <= n; step++) {
    const cand = state.order[(start + step) % n];
    if (state.eliminated.includes(cand)) continue;
    return cand;
  }
  return null;
}

function clone(state: CRState): CRState {
  return {
    ...state,
    cells: state.cells.map((c) => ({ ...c })),
    placed: state.placed.slice(),
    eliminated: state.eliminated.slice(),
  };
}

function explode(state: CRState, actorSeat: number) {
  const { rows, cols } = state;
  const total = rows * cols;
  const queue: number[] = [];
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i].count >= criticalMassAt(rows, cols, i)) queue.push(i);
  }
  let guard = 0;
  while (queue.length > 0) {
    if (guard++ > total * 64) break;
    const i = queue.shift()!;
    const crit = criticalMassAt(rows, cols, i);
    const cell = state.cells[i];
    if (cell.count < crit) continue;
    cell.count -= crit;
    if (cell.count === 0) cell.owner = null;
    for (const n of neighbors(rows, cols, i)) {
      const nc = state.cells[n];
      nc.count += 1;
      nc.owner = actorSeat;
      if (nc.count >= criticalMassAt(rows, cols, n)) queue.push(n);
    }
    if (isDominant(state, actorSeat)) break;
  }
}

function isDominant(state: CRState, seat: number): boolean {
  if (!state.placed.every(Boolean)) return false;
  for (const c of state.cells) {
    if (c.owner !== null && c.owner !== seat) return false;
  }
  return state.cells.some((c) => c.owner === seat);
}

function resolveSize(opts?: unknown): { rows: number; cols: number } {
  // Accept either { size: 'small'|'medium'|'large' }, explicit {rows, cols}, or
  // a prior state object carrying rows/cols (so a table can be re-initialized
  // from its own board when the roster changes before `start`).
  if (opts && typeof opts === 'object') {
    const o = opts as { rows?: unknown; cols?: unknown; size?: unknown };
    if (typeof o.rows === 'number' && typeof o.cols === 'number') {
      return { rows: o.rows, cols: o.cols };
    }
    if (typeof o.size === 'string' && o.size in CR_SIZES) {
      const s = CR_SIZES[o.size as CRSizeKey];
      return { rows: s.rows, cols: s.cols };
    }
  }
  return { rows: CR_SIZES.medium.rows, cols: CR_SIZES.medium.cols };
}

export const chainReaction: GameDefinition<CRState, CRAction> = {
  type: 'chain-reaction',
  displayName: 'Chain Reaction',
  description: 'Colocá orbes, detoná cadenas y capturá el tablero. 2–8 jugadores.',
  minPlayers: 2,
  maxPlayers: CR_MAX_PLAYERS,
  defaultTurnTimeoutS: 45,

  initialState(participants, opts) {
    const { rows, cols } = resolveSize(opts);
    const seats: Record<string, number> = {};
    participants.forEach((p, i) => { seats[p] = i; });
    return {
      rows,
      cols,
      cells: Array.from({ length: rows * cols }, () => ({ count: 0, owner: null })),
      seats,
      order: participants.slice(),
      placed: participants.map(() => false),
      eliminated: [],
    };
  },

  firstTurn(participants) {
    return participants[0];
  },

  validateAction(state, action, actorPubkey) {
    if (!(actorPubkey in state.seats)) return { ok: false, error: 'Not a participant' };
    if (state.eliminated.includes(actorPubkey)) return { ok: false, error: 'Eliminated' };
    const total = state.rows * state.cols;
    if (typeof action?.cell !== 'number' || action.cell < 0 || action.cell >= total) {
      return { ok: false, error: 'Invalid cell' };
    }
    const seat = state.seats[actorPubkey];
    const cell = state.cells[action.cell];
    if (cell.owner !== null && cell.owner !== seat) {
      return { ok: false, error: 'Cell owned by opponent' };
    }
    return { ok: true };
  },

  applyAction(state, action, actorPubkey): ApplyResult<CRState> {
    const next = clone(state);
    const seat = next.seats[actorPubkey];
    const cell = next.cells[action.cell];
    cell.count += 1;
    cell.owner = seat;

    explode(next, seat);

    next.placed[seat] = true;

    const owners = aliveSeats(next);
    const newlyEliminated: string[] = [];
    for (let s = 0; s < next.order.length; s++) {
      const pk = next.order[s];
      if (next.eliminated.includes(pk)) continue;
      if (next.placed[s] && !owners.has(s) && pk !== actorPubkey) {
        newlyEliminated.push(pk);
      }
    }
    next.eliminated.push(...newlyEliminated);

    const remaining = next.order.filter((pk) => !next.eliminated.includes(pk));
    if (remaining.length <= 1 && next.placed.every(Boolean)) {
      return {
        state: next,
        nextTurn: null,
        winner: remaining[0] ?? null,
        eliminated: newlyEliminated.length ? newlyEliminated : undefined,
      };
    }

    return {
      state: next,
      nextTurn: nextTurnPubkey(next, actorPubkey),
      eliminated: newlyEliminated.length ? newlyEliminated : undefined,
    };
  },

  onTimeout(state, timedOutPubkey): ApplyResult<CRState> {
    const next = clone(state);
    const seat = next.seats[timedOutPubkey];
    for (const cell of next.cells) {
      if (cell.owner === seat) { cell.owner = null; cell.count = 0; }
    }
    if (!next.eliminated.includes(timedOutPubkey)) next.eliminated.push(timedOutPubkey);
    next.placed[seat] = true;

    const remaining = next.order.filter((pk) => !next.eliminated.includes(pk));
    if (remaining.length <= 1) {
      return {
        state: next,
        nextTurn: null,
        winner: remaining[0] ?? null,
        eliminated: [timedOutPubkey],
      };
    }
    return {
      state: next,
      nextTurn: nextTurnPubkey(next, timedOutPubkey),
      eliminated: [timedOutPubkey],
    };
  },
};
