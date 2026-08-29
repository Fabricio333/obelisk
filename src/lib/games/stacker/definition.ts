/**
 * Stacker as an Obelisk game.
 *
 * The turn-based hooks below are deliberately inert: a real-time game has no
 * seat "to move", so `deriveSession` routes past them the moment it sees
 * `realtime: true`, and the match lives in `session.match` instead of
 * `session.state`. What this definition really contributes is the catalog
 * entry and the player limits.
 */
import type { ApplyResult, GameDefinition } from '../types';

export const STACKER_MIN_PLAYERS = 1;
export const STACKER_MAX_PLAYERS = 6;

/** How the attack picks its victim when more than one opponent is standing. */
export type TargetMode = 'random' | 'badges' | 'attackers';

export const stacker: GameDefinition<null, never> = {
  type: 'stacker',
  displayName: 'Stacker',
  description: 'Falling blocks, shared piece order, and every line you clear buries somebody else. 1–6 players.',
  minPlayers: STACKER_MIN_PLAYERS,
  maxPlayers: STACKER_MAX_PLAYERS,
  // The clock here is gravity, not a turn timer.
  defaultTurnTimeoutS: 0,
  realtime: true,

  initialState: () => null,
  firstTurn: (participants) => participants[0],
  validateAction: () => ({ ok: false, error: 'Stacker is played in real time' }),
  applyAction: (state): ApplyResult<null> => ({ state, nextTurn: null }),
  onTimeout: (state): ApplyResult<null> => ({ state, nextTurn: null }),
};
