/**
 * Vesta (fchurca/vesta) as an Obelisk game engine.
 *
 * The rules are NOT reimplemented here. `vesta` is a tracked dependency
 * (`github:fchurca/vesta#semver:^0`) whose core module is already pure —
 * `createGame(seed)` builds a deterministic board, `applyMove(state, move)`
 * returns the next state — which is exactly the contract in `../types.ts`.
 * Upgrading the game is `npm update vesta`; nothing in this file encodes a
 * rule, only the translation between their vocabulary and ours:
 *
 *   theirs                          ours
 *   ──────                          ────
 *   player index (0..n-1)           seat id (a string; see protocol.ts)
 *   move.player                     injected from the acting seat
 *   move.dice on `roll-dice`        derived from the log (see ./dice.ts)
 *   state.currentPlayer             currentTurn
 *   state.winner                    winner
 *
 * The one rule we do impose: a move never gets to name its own player. The
 * seat comes from who signed the event, so a client cannot publish a move
 * "as" somebody else — upstream's hot-seat client had no reason to care,
 * because everyone shared a keyboard.
 */
import {
  createGame,
  applyMove,
  canBuildSettlement,
  canBuildRoad,
  canBuildCity,
  canBuyDevCard,
  getRobbableVertices,
  giveStartingResources,
  nextTurn,
  checkWin,
  type GameState,
  type GameMove,
} from 'vesta';
import type { ApplyResult, GameDefinition, MoveContext } from '../types';
import { diceFromEntropy } from './dice';

/** A move as it travels on the wire: upstream's move minus `player`. */
export type VestaAction = Omit<Extract<GameMove, { player: number }>, 'player'> | { type: 'end-turn' };

export const VESTA_MIN_PLAYERS = 2;
export const VESTA_MAX_PLAYERS = 4;

/** Board seeds are chosen by the host; keep them small and human-quotable. */
export function normalizeSeed(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(Math.abs(raw)) % 1_000_000;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.floor(Math.abs(n)) % 1_000_000;
  }
  return 0;
}

function seatIndex(participants: string[], seat: string): number {
  return participants.indexOf(seat);
}

/**
 * Rebuild the wire action into an upstream move, with the player index and
 * (for a roll) the dice filled in by us rather than by the sender.
 */
function toMove(action: VestaAction, playerIdx: number, ctx?: MoveContext): GameMove {
  const base = { ...(action as Record<string, unknown>), player: playerIdx };
  if (action.type === 'roll-dice') {
    return { ...base, dice: diceFromEntropy(ctx?.entropy ?? '') } as GameMove;
  }
  return base as GameMove;
}

/**
 * Resume a saved game. Upstream's export is `{startState, turns, endState}`;
 * we take `endState` because a table that resumes a save continues from where
 * the save stopped, and the turns before it are already baked into it.
 */
function stateFromOpts(opts: unknown, participants: string[]): GameState {
  const o = (opts ?? {}) as { resume?: unknown; seed?: unknown; title?: unknown };
  const resumed = readResumeState(o.resume);
  if (resumed) return resumed;
  return createGame({
    players: participants.length,
    roll: normalizeSeed(o.seed),
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
  });
}

/** Accept either a bare GameState or a full `{endState}` record. */
export function readResumeState(raw: unknown): GameState | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = 'endState' in (raw as Record<string, unknown>)
    ? (raw as { endState: unknown }).endState
    : 'startState' in (raw as Record<string, unknown>)
      ? (raw as { startState: unknown }).startState
      : raw;
  if (!candidate || typeof candidate !== 'object') return null;
  const s = candidate as Partial<GameState>;
  if (!s.board || !Array.isArray(s.players) || typeof s.currentPlayer !== 'number') return null;
  return s as GameState;
}

/** How many seats a saved game expects. Used to size the table on import. */
export function playerCountOf(resume: unknown): number | null {
  const state = readResumeState(resume);
  return state ? state.players.length : null;
}

function result(state: GameState, participants: string[]): ApplyResult<GameState> {
  if (state.winner !== null && state.winner !== undefined) {
    return { state, nextTurn: null, winner: participants[state.winner] ?? null };
  }
  return { state, nextTurn: participants[state.currentPlayer] ?? null };
}

export const vesta: GameDefinition<GameState, VestaAction> = {
  type: 'vesta',
  displayName: 'Vesta',
  description: 'Expanding Settlements Through Accord — build, trade, and take the board. 2–4 players.',
  minPlayers: VESTA_MIN_PLAYERS,
  maxPlayers: VESTA_MAX_PLAYERS,
  // No clock by default. Our clock is per ACTION, and a Vesta turn is many
  // actions (roll, build, trade, end) — a short timer would guillotine people
  // mid-thought. Hosts who want one should pick something generous.
  defaultTurnTimeoutS: 0,

  initialState(participants, opts) {
    return stateFromOpts(opts, participants);
  },

  firstTurn(participants) {
    return participants[0];
  },

  validateAction(state, action, actorSeat, participants) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
      return { ok: false, error: 'Malformed move' };
    }
    if (state.winner !== null && state.winner !== undefined) {
      return { ok: false, error: 'Game is over' };
    }
    // A dry run is the honest validator: upstream throws on anything illegal,
    // and it is pure, so running it costs us one discarded object.
    return dryRun(state, action, actorSeat, participants);
  },

  applyAction(state, action, actorSeat, participants, ctx) {
    const idx = seatIndex(participants, actorSeat);
    const next = sequence(applyMove(state, toMove(action, idx, ctx)), state, action, idx);
    return result(next, participants);
  },

  /**
   * Blowing the clock (or resigning) ends that seat's turn — it does not
   * remove the player. Vesta has no elimination: a settlement on the board
   * keeps producing whether or not its owner is paying attention, and
   * deleting a player mid-game would rewrite everyone else's board.
   */
  onTimeout(state, timedOutSeat, participants) {
    const idx = seatIndex(participants, timedOutSeat);
    if (idx < 0 || state.currentPlayer !== idx) return result(state, participants);
    try {
      return result(applyMove(state, { type: 'end-turn', player: idx }), participants);
    } catch {
      return result(state, participants);
    }
  },

  /**
   * Out-of-turn actions Vesta genuinely has: answering a trade offer, and
   * discarding when a seven is rolled. Everything else waits its turn.
   */
  canAct(state, seat, action, participants) {
    if (!action || typeof action !== 'object') return false;
    const idx = seatIndex(participants, seat);
    if (idx < 0) return false;
    switch (action.type) {
      case 'accept-trade':
      case 'reject-trade':
        return state.pendingTrade?.to === idx;
      case 'cancel-proposal':
        return state.pendingTrade?.from === idx;
      case 'discard-resources':
        // A seven hits every over-full hand at once, whoever's turn it is.
        return state.dice !== null && state.dice[0] + state.dice[1] === 7;
      default:
        return false;
    }
  },
};

/**
 * Bookkeeping this table keeps on top of upstream's state.
 *
 * Vesta's own client tracks "the robber is waiting to be moved" in the DOM,
 * because it is one browser and one player at a time. We cannot: every client
 * has to reach the same conclusion from the log alone, so the flags live in
 * the state where replay carries them. The key is namespaced, and upstream's
 * reducers preserve unknown fields (they all spread the previous state), so
 * this rides along without touching their rules.
 */
interface ObeliskFlags {
  robberPending?: boolean;
  stealPending?: boolean;
}

type StateWithFlags = GameState & { __obelisk?: ObeliskFlags };

function flags(state: GameState): ObeliskFlags {
  return (state as StateWithFlags).__obelisk ?? {};
}

function withFlags(state: GameState, next: ObeliskFlags): GameState {
  return { ...state, __obelisk: next } as GameState;
}

/** Is the table waiting for this turn's robber to be placed? */
export function isRobberPending(state: GameState): boolean {
  return flags(state).robberPending === true;
}

/** Has the robber landed, leaving a steal to resolve? */
export function isStealPending(state: GameState): boolean {
  return flags(state).stealPending === true;
}

/**
 * The sequencing upstream keeps in its UI.
 *
 * `applyMove` places a settlement but does not decide that setup now wants a
 * road, hand out second-round starting resources, or pass the turn — Vesta's
 * own client does all of that between calls (see `onVertexClick` /
 * `onEdgeClick` in their web/ui.js). Over a relay there is no shared client to
 * do it, so it happens here, deterministically, on every replay.
 */
function sequence(next: GameState, before: GameState, action: VestaAction, idx: number): GameState {
  const isSetup = before.phase === 'initial_first' || before.phase === 'initial_second';
  const f = flags(before);

  if (isSetup && action.type === 'place-settlement') {
    const a = action as Extract<GameMove, { type: 'place-settlement' }>;
    // Settlement down, road next — the pending spot is what the road must touch.
    return { ...next, pendingSettlement: { q: a.q, r: a.r, corner: a.corner }, setupStep: 'road' };
  }

  if (isSetup && action.type === 'place-road') {
    let out = next;
    const pending = before.pendingSettlement;
    // Second time around, your settlement pays out immediately.
    if (before.phase === 'initial_second' && pending) {
      out = giveStartingResources(out, idx, pending.q, pending.r, pending.corner);
    }
    out = { ...out, pendingSettlement: null };
    return nextTurn(out);
  }

  if (action.type === 'roll-dice') {
    const total = (next.dice?.[0] ?? 0) + (next.dice?.[1] ?? 0);
    // A seven sends the robber; everything else just produces.
    return withFlags(next, { ...f, robberPending: total === 7, stealPending: false });
  }

  if (action.type === 'play-dev-card' && (action as { cardType?: string }).cardType === 'knight') {
    return declareWinner(withFlags(next, { ...f, robberPending: true, stealPending: false }));
  }

  if (action.type === 'move-robber') {
    return withFlags(next, { ...f, robberPending: false, stealPending: true });
  }

  if (action.type === 'steal-resource') {
    return withFlags(next, { ...f, stealPending: false });
  }

  if (action.type === 'end-turn') {
    return withFlags(next, {});
  }

  return declareWinner(next);
}

/** Ten victory points ends it. Upstream's client checks; so must we. */
function declareWinner(state: GameState): GameState {
  if (state.winner !== null && state.winner !== undefined) return state;
  const winner = checkWin(state);
  if (winner < 0) return state;
  return { ...state, winner, phase: 'gameover' };
}

/**
 * Upstream splits validation from application: `canBuildSettlement` and
 * friends are the rules, and `placeSettlement` just does as it is told. Their
 * hot-seat UI calls the guard before the mutator, so nothing illegal ever
 * reaches it.
 *
 * Over a relay there is no UI in the path — a hostile client calls the mutator
 * directly by publishing the move. So the guards run HERE, on every client,
 * for every move, before it is allowed into the board. Without this you could
 * publish a settlement onto an occupied vertex and every client would agree
 * you own it.
 */
function checkRules(state: GameState, action: VestaAction, idx: number): { ok: boolean; error?: string } {
  const isInitial = state.phase === 'initial_first' || state.phase === 'initial_second';

  switch (action.type) {
    case 'roll-dice': {
      if (isInitial) return { ok: false, error: 'Not in the rolling phase' };
      if (state.rolled) return { ok: false, error: 'Already rolled this turn' };
      return { ok: true };
    }
    case 'end-turn': {
      if (state.phase === 'play' && !state.rolled) return { ok: false, error: 'Roll before ending your turn' };
      if (flags(state).robberPending) return { ok: false, error: 'Move the robber first' };
      return { ok: true };
    }
    case 'place-settlement': {
      const a = action as Extract<GameMove, { type: 'place-settlement' }>;
      if (isInitial && state.setupStep !== 'settlement') {
        return { ok: false, error: 'Place your road first' };
      }
      if (!isInitial && !state.rolled) return { ok: false, error: 'Roll first' };
      const v = canBuildSettlement(state, idx, a.q, a.r, a.corner, isInitial);
      return v.ok ? { ok: true } : { ok: false, error: v.reason };
    }
    case 'place-road': {
      const a = action as Extract<GameMove, { type: 'place-road' }>;
      if (isInitial && state.setupStep !== 'road') {
        return { ok: false, error: 'Place your settlement first' };
      }
      if (!isInitial && !state.rolled) return { ok: false, error: 'Roll first' };
      const v = canBuildRoad(
        state, idx, a.q1, a.r1, a.corner1, a.q2, a.r2, a.corner2,
        isInitial, isInitial ? state.pendingSettlement : null,
      );
      return v.ok ? { ok: true } : { ok: false, error: v.reason };
    }
    case 'place-city': {
      const a = action as Extract<GameMove, { type: 'place-city' }>;
      if (isInitial) return { ok: false, error: 'No cities during setup' };
      if (!state.rolled) return { ok: false, error: 'Roll first' };
      const v = canBuildCity(state, idx, a.q, a.r, a.corner);
      return v.ok ? { ok: true } : { ok: false, error: v.reason };
    }
    case 'buy-dev-card': {
      if (isInitial || !state.rolled) return { ok: false, error: 'Roll first' };
      if (state.devDeck.cards.length === 0) return { ok: false, error: 'The deck is empty' };
      return canBuyDevCard(state, idx) ? { ok: true } : { ok: false, error: 'Not enough resources' };
    }
    case 'move-robber': {
      const a = action as Extract<GameMove, { type: 'move-robber' }>;
      // The robber only moves when something sent it: a seven, or a knight.
      // Upstream enforces this by only opening its robber UI at those moments.
      if (!flags(state).robberPending) return { ok: false, error: 'Nothing has sent the robber' };
      if (a.q === state.board.robber.q && a.r === state.board.robber.r) {
        return { ok: false, error: 'The robber is already there' };
      }
      return { ok: true };
    }
    case 'steal-resource': {
      const a = action as Extract<GameMove, { type: 'steal-resource' }>;
      if (!flags(state).stealPending) return { ok: false, error: 'Move the robber first' };
      const robbable = getRobbableVertices(state, idx, state.board.robber.q, state.board.robber.r);
      if (!robbable.some((v) => v.owner === a.victim)) {
        return { ok: false, error: 'That player is not on the robbed tile' };
      }
      const victim = state.players[a.victim];
      if (!victim || (victim.resources[a.resource as keyof typeof victim.resources] ?? 0) < 1) {
        return { ok: false, error: 'They do not hold that resource' };
      }
      return { ok: true };
    }
    case 'discard-resources': {
      const a = action as Extract<GameMove, { type: 'discard-resources' }>;
      const player = state.players[idx];
      if (!player) return { ok: false, error: 'Unknown player' };
      for (const [res, amount] of Object.entries(a.resources)) {
        if ((player.resources[res as keyof typeof player.resources] ?? 0) < (amount as number)) {
          return { ok: false, error: 'Cannot discard what you do not hold' };
        }
      }
      return { ok: true };
    }
    default:
      // Trades and dev-card plays validate inside `applyMove`, which throws.
      return { ok: true };
  }
}

function dryRun(
  state: GameState,
  action: VestaAction,
  actorSeat: string,
  participants: string[],
): { ok: boolean; error?: string } {
  const idx = seatIndex(participants, actorSeat);
  if (idx < 0) return { ok: false, error: 'Not seated at this table' };

  const rules = checkRules(state, action, idx);
  if (!rules.ok) return rules;

  // Whatever the guards don't cover, the mutator will complain about.
  try {
    applyMove(state, toMove(action, idx, { entropy: 'validation' }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Illegal move' };
  }
}
