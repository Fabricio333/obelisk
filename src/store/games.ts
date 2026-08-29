/**
 * Client state for relay-hosted games.
 *
 * The store holds the raw event log per table — never a derived board. The
 * board is recomputed from the log by `deriveSession` on read, so an event
 * that arrives late (relay reconnect, a peer's re-publish, history backfill)
 * can never leave a client on a state some other client disagrees with. The
 * cost is a replay per render; a Chain Reaction match is a few hundred events
 * of pure array work, which is nothing next to a re-render.
 */
import { create } from 'zustand';
import type { ParsedGameEvent } from '@/lib/games/protocol';
import { deriveSession, type GameSession } from '@/lib/games/session';

interface GamesStore {
  /** gameId → its log, unsorted. `deriveSession` owns ordering. */
  logs: Record<string, ParsedGameEvent[]>;
  /** gameId → channelId, so the UI can find a table's home without a scan. */
  channelOf: Record<string, string>;
  /** Table currently open in the game modal. */
  openGameId: string | null;

  ingest: (ev: ParsedGameEvent) => void;
  ingestMany: (evs: readonly ParsedGameEvent[]) => void;
  clearChannel: (channelId: string) => void;
  setOpenGame: (gameId: string | null) => void;
}

export const useGamesStore = create<GamesStore>((set) => ({
  logs: {},
  channelOf: {},
  openGameId: null,

  ingest: (ev) => set((s) => mergeEvents(s, [ev])),
  ingestMany: (evs) => set((s) => mergeEvents(s, evs)),

  clearChannel: (channelId) => set((s) => {
    const logs = { ...s.logs };
    const channelOf = { ...s.channelOf };
    for (const [gameId, ch] of Object.entries(s.channelOf)) {
      if (ch !== channelId) continue;
      delete logs[gameId];
      delete channelOf[gameId];
    }
    return { logs, channelOf };
  }),

  setOpenGame: (gameId) => set({ openGameId: gameId }),
}));

function mergeEvents(
  s: { logs: Record<string, ParsedGameEvent[]>; channelOf: Record<string, string> },
  evs: readonly ParsedGameEvent[],
): Partial<GamesStore> {
  let logs: Record<string, ParsedGameEvent[]> | null = null;
  let channelOf: Record<string, string> | null = null;

  for (const ev of evs) {
    const existing = (logs ?? s.logs)[ev.gameId] ?? [];
    if (existing.some((e) => e.id === ev.id)) continue;
    logs = logs ?? { ...s.logs };
    logs[ev.gameId] = [...existing, ev];
    if (s.channelOf[ev.gameId] !== ev.channelId) {
      channelOf = channelOf ?? { ...s.channelOf };
      channelOf[ev.gameId] = ev.channelId;
    }
  }

  if (!logs) return {};
  return channelOf ? { logs, channelOf } : { logs };
}

/** Rebuild one table. Returns `null` until its `create` event has arrived. */
export function selectSession(
  state: { logs: Record<string, ParsedGameEvent[]> },
  gameId: string,
  now?: number,
): GameSession | null {
  const log = state.logs[gameId];
  if (!log || log.length === 0) return null;
  return deriveSession(log, now);
}

/** Every table in a channel, newest first. */
export function selectChannelSessions(
  state: { logs: Record<string, ParsedGameEvent[]>; channelOf: Record<string, string> },
  channelId: string,
  now?: number,
): GameSession[] {
  const out: GameSession[] = [];
  for (const [gameId, ch] of Object.entries(state.channelOf)) {
    if (ch !== channelId) continue;
    const session = selectSession(state, gameId, now);
    if (session) out.push(session);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
