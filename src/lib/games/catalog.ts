/**
 * Display metadata for the games in the registry.
 *
 * The registry knows the RULES; this knows what a game looks like in the UI —
 * its name, its one-line pitch, its thumbnail. Everything user-facing reads
 * from here and is keyed by `session.game`, so a table can never be labelled
 * as a different game than the one it is running. (It could, once: the card
 * and the modal both hardcoded "Chain Reaction", which made a Vesta table
 * look like a Chain Reaction table in chat.)
 */
import { GAMES, getGameDef } from './registry';

export interface GameInfo {
  type: string;
  displayName: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  defaultTurnTimeoutS: number;
  /** Compact glyph for tight spots — chat cards, modal headers. */
  icon: string;
  /**
   * Real-time games run every board at once. That rules out hot-seat: you
   * cannot pass a keyboard between players who are all playing right now.
   */
  realtime: boolean;
}

const ICONS: Record<string, string> = {
  'chain-reaction': '⚛',
  vesta: '🏛',
  stacker: '🧱',
};

export function gameInfo(type: string): GameInfo | null {
  const def = getGameDef(type);
  if (!def) return null;
  return {
    type: def.type,
    displayName: def.displayName,
    description: def.description,
    minPlayers: def.minPlayers,
    maxPlayers: def.maxPlayers,
    defaultTurnTimeoutS: def.defaultTurnTimeoutS,
    icon: ICONS[def.type] ?? '🎲',
    realtime: def.realtime === true,
  };
}

/** Everything playable, for the picker. */
export function gameCatalog(): GameInfo[] {
  return Object.keys(GAMES)
    .map((type) => gameInfo(type))
    .filter((g): g is GameInfo => g !== null);
}

/** Name for a table whose game we may not recognise (an older or newer client). */
export function gameName(type: string): string {
  return gameInfo(type)?.displayName ?? type;
}

export function gameIcon(type: string): string {
  return gameInfo(type)?.icon ?? '🎲';
}

/** "2–8 players · 45s turns" — the line under a game's name in the picker. */
export function gameSummary(info: GameInfo): string {
  const players = info.minPlayers === info.maxPlayers
    ? `${info.minPlayers} players`
    : `${info.minPlayers}–${info.maxPlayers} players`;
  if (info.realtime) return `${players} · real time, one device each`;
  const clock = info.defaultTurnTimeoutS > 0 ? `${info.defaultTurnTimeoutS}s turns` : 'no turn clock';
  return `${players} · ${clock}`;
}
