/**
 * Game engine contract. An engine is PURE: same log in, same board out, on
 * every client. That purity is what replaces the classic stack's authoritative
 * server — there is no referee here, only a deterministic reducer every player
 * runs over the same relay-delivered event log (see `session.ts`).
 *
 * Rules an engine must hold to, or clients will disagree about the board:
 *   - no wall-clock reads, no randomness, no I/O;
 *   - never mutate the state it is handed — return a fresh object;
 *   - `applyAction` must be total for any input `validateAction` accepted.
 *
 * Lifecycle: waiting → in_progress → finished, or waiting → cancelled.
 * An engine ends the game by returning `nextTurn: null`.
 */

/**
 * Everything an engine is allowed to know beyond the board and the action.
 *
 * `entropy` is a string fixed by the log BEFORE this turn (the id of the last
 * accepted event, plus the turn index). Engines that need a die roll derive it
 * from here instead of reaching for `Math.random`, which would make replay
 * disagree between clients. See `src/lib/games/vesta/dice.ts`.
 */
export interface MoveContext {
  entropy: string;
}

export interface ApplyResult<S> {
  state: S;
  /** Pubkey to move next; `null` finishes the game. */
  nextTurn: string | null;
  winner?: string | null;
  draw?: boolean;
  eliminated?: string[];
}

export interface GameDefinition<S = unknown, A = unknown> {
  type: string;
  displayName: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  defaultTurnTimeoutS: number;

  /**
   * Real-time games run every player's board at once, locally, and publish
   * only consequences (see src/lib/games/stacker/match.ts). The reducer skips
   * all turn machinery for these — there is no seat "to move".
   */
  realtime?: boolean;

  initialState(participants: string[], opts?: unknown): S;
  firstTurn(participants: string[]): string;

  validateAction(state: S, action: A, actorSeat: string, participants: string[]): { ok: boolean; error?: string };
  applyAction(
    state: S,
    action: A,
    actorSeat: string,
    participants: string[],
    ctx?: MoveContext,
  ): ApplyResult<S>;
  /**
   * Called when the player to move blew the clock, or resigned. Both are the
   * same thing to an engine: that seat is out, the board moves on.
   */
  onTimeout(state: S, timedOutSeat: string, participants: string[]): ApplyResult<S>;

  /**
   * Optional: may this seat act right now, even though it is not on move?
   *
   * Most games answer "only the seat on move", which is the default when an
   * engine leaves this out. Some genuinely need more — Vesta lets a trade
   * partner accept or reject, and makes every over-full hand discard on a
   * seven, all while somebody else holds the turn.
   *
   * Answering `true` here does not weaken replay: an out-of-turn move is
   * still ordered by `(created_at, id)`, still carries the sequence number it
   * was published against, and is still dropped if `validateAction` rejects
   * it.
   */
  canAct?(state: S, seat: string, action: A, participants: string[]): boolean;
}
