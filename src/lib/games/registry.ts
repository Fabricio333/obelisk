import type { GameDefinition } from './types';
import { chainReaction } from './chain-reaction';
import { vesta } from './vesta/definition';
import { stacker } from './stacker/definition';

/**
 * Games available on the relay.
 *
 * Chain Reaction was ported from the classic Obelisk stack; Vesta is consumed
 * as a tracked upstream package (see `./vesta/definition.ts`). Chess and
 * tic-tac-toe still live in obelisk-classic and would each need the same
 * treatment — a pure engine is enough, everything in `session.ts` is
 * game-agnostic.
 */
export const GAMES: Record<string, GameDefinition> = {
  [chainReaction.type]: chainReaction as GameDefinition,
  [vesta.type]: vesta as unknown as GameDefinition,
  [stacker.type]: stacker as unknown as GameDefinition,
};

export function getGameDef(type: string): GameDefinition | null {
  return GAMES[type] ?? null;
}

export function listGames() {
  return Object.values(GAMES).map((g) => ({
    type: g.type,
    displayName: g.displayName,
    description: g.description,
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
    defaultTurnTimeoutS: g.defaultTurnTimeoutS,
  }));
}
