/**
 * Wire format for Obelisk games on Nostr.
 *
 * The classic stack ran games on a Postgres row plus a socket.io broadcast:
 * the server validated a move, mutated `game.state`, and pushed the new board
 * to everyone. There is no server here, so the *log is the game*. Every
 * create / join / start / move / timeout / resign / cancel is one signed kind
 * 2390 event on the channel's relay, and each client replays the log through
 * the pure engine (`session.ts`) to rebuild the identical board.
 *
 * This mirrors how voice signaling works (`src/lib/voice/transport.ts`):
 * plaintext signed events, addressed by tags, gated in the handler rather
 * than trusted from the relay. The differences are deliberate:
 *
 *   - stored kind, not ephemeral — a spectator joining at move 40 must be
 *     able to replay moves 1-39;
 *   - `["h", channelId]` NIP-29 group scoping, so the relay applies the same
 *     write policy it applies to chat: only people who may post in the
 *     channel may play in it;
 *   - a turn index `n` on every move, so two clients that disagree about
 *     wall-clock still agree about move order.
 *
 * Authority model: nobody. A client that publishes an illegal move just
 * publishes garbage — every other client re-validates through
 * `validateAction` and drops it. What a malicious client CAN do is refuse to
 * publish its own losing move; the turn clock (`timeout`) is the answer to
 * that, and it is enforced by every player, not by a referee.
 */
import { KIND_GAME } from '@/lib/nip-kinds';

export const GAME_TAG = 'obelisk-game';

/** How long a `waiting` table stays joinable before clients call it stale. */
export const WAITING_EXPIRY_MINUTES = 60;

/** History window for the channel subscription. Older tables are dead anyway. */
export const GAME_LOG_WINDOW_SECONDS = 24 * 60 * 60;

export type GameOp =
  | 'create' | 'join' | 'start' | 'move' | 'timeout' | 'resign' | 'cancel'
  // Real-time games (see src/lib/games/stacker/) don't take turns. Their
  // players run their own boards locally and only put these on the wire.
  | 'attack' | 'topout' | 'checkpoint';

export interface GameEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: string[][];
  readonly content: string;
}

interface BaseParsed {
  id: string;
  pubkey: string;
  createdAt: number;
  channelId: string;
  /** Table id — the `create` event's id. For `create` itself, its own id. */
  gameId: string;
}

/**
 * A seat at the table. `id` is the engine's identity for the player — NOT a
 * pubkey, because one person can hold several seats (hot-seat: two players
 * sharing one browser and one account). `by` is the pubkey allowed to publish
 * that seat's moves.
 *
 * For an ordinary all-remote table `id === by`, which is why every
 * single-seat-per-person table reads exactly as it did before seats existed.
 */
export interface SeatSpec {
  id: string;
  by: string;
  label?: string;
}

export type ParsedGameEvent =
  | (BaseParsed & { op: 'create'; game: string; opts: Record<string, unknown>; turnTimeoutS: number; nonce?: string })
  | (BaseParsed & { op: 'join' })
  | (BaseParsed & { op: 'start'; seats: SeatSpec[] })
  | (BaseParsed & { op: 'move'; n: number; action: unknown; seat?: string })
  | (BaseParsed & { op: 'timeout'; n: number })
  | (BaseParsed & { op: 'resign'; seat?: string })
  | (BaseParsed & { op: 'cancel' })
  /** Garbage sent from one seat to another. */
  | (BaseParsed & { op: 'attack'; seat: string; target: string; lines: number; hole: number; nonce: number })
  /** "I topped out" — the sender removing themselves from a real-time match. */
  | (BaseParsed & { op: 'topout'; seat: string })
  /**
   * A periodic "here is my board, and here is the input log that produced it".
   * Anyone can replay the log against the shared seed and check the claim.
   */
  | (BaseParsed & {
      op: 'checkpoint';
      seat: string;
      frame: number;
      attacksSent: number;
      linesCleared: number;
      stackHeight: number;
      /** Compressed input log since the start of the match. */
      inputs?: string;
    });

function tag(tags: string[][], name: string): string | undefined {
  return tags.find((t) => t[0] === name)?.[1];
}

/**
 * Normalize a `start` seat list. Accepts both the object form and the older
 * bare-pubkey array — a table opened by a client that predates hot-seat is
 * simply a table where every seat is its own controller.
 */
export function parseSeats(raw: unknown): SeatSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: SeatSpec[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let spec: SeatSpec | null = null;
    if (typeof entry === 'string' && entry.length > 0) {
      spec = { id: entry, by: entry };
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as { id?: unknown; by?: unknown; label?: unknown };
      if (typeof e.id === 'string' && e.id.length > 0 && typeof e.by === 'string' && e.by.length > 0) {
        spec = {
          id: e.id,
          by: e.by,
          ...(typeof e.label === 'string' && e.label.length > 0 ? { label: e.label } : {}),
        };
      }
    }
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    out.push(spec);
  }
  return out;
}

/** Seat id for the nth extra seat a pubkey holds. Seat 0 is the pubkey itself. */
export function localSeatId(pubkey: string, n: number): string {
  return n === 0 ? pubkey : `${pubkey}#${n}`;
}

/** Template for a `create` — the event id it lands with becomes the table id. */
export function buildCreate(channelId: string, params: {
  game: string;
  opts?: Record<string, unknown>;
  turnTimeoutS: number;
  /**
   * Client-chosen id for this attempt. It exists so a publish whose
   * confirmation never came back can be looked up afterwards: the relay may
   * well have stored the event while the OK was lost with the socket. See
   * `publishCreate`.
   */
  nonce?: string;
}) {
  return {
    kind: KIND_GAME,
    content: JSON.stringify({
      game: params.game,
      opts: params.opts ?? {},
      turnTimeoutS: params.turnTimeoutS,
      ...(params.nonce ? { nonce: params.nonce } : {}),
    }),
    tags: [
      ['h', channelId],
      ['t', GAME_TAG],
      ['op', 'create'],
      ['game', params.game],
    ],
  };
}

/** Template for any op that references an existing table. */
export function buildGameOp(
  channelId: string,
  gameId: string,
  op: Exclude<GameOp, 'create'>,
  payload: Record<string, unknown> = {},
) {
  const tags: string[][] = [
    ['h', channelId],
    ['t', GAME_TAG],
    ['op', op],
    ['e', gameId, '', 'root'],
  ];
  // `n` is duplicated into a tag so a client can filter a long log down to a
  // single turn without parsing every content blob.
  if (typeof payload.n === 'number') tags.push(['n', String(payload.n)]);
  return { kind: KIND_GAME, content: JSON.stringify(payload), tags };
}

/**
 * Parse a raw relay event into a game op, or `null` if it is not one of ours /
 * is malformed. Never throws — a peer can put anything on the wire.
 */
export function parseGameEvent(ev: GameEvent): ParsedGameEvent | null {
  if (ev.kind !== KIND_GAME) return null;
  const channelId = tag(ev.tags, 'h');
  if (!channelId) return null;
  const op = tag(ev.tags, 'op') as GameOp | undefined;
  if (!op) return null;

  let body: Record<string, unknown> = {};
  if (ev.content) {
    try {
      const parsed: unknown = JSON.parse(ev.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      body = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const base = { id: ev.id, pubkey: ev.pubkey, createdAt: ev.created_at, channelId };

  if (op === 'create') {
    const game = typeof body.game === 'string' ? body.game : tag(ev.tags, 'game');
    if (!game) return null;
    const turnTimeoutS = typeof body.turnTimeoutS === 'number' && body.turnTimeoutS >= 0
      ? Math.floor(body.turnTimeoutS)
      : 0;
    const opts = body.opts && typeof body.opts === 'object' && !Array.isArray(body.opts)
      ? (body.opts as Record<string, unknown>)
      : {};
    return {
      ...base,
      gameId: ev.id,
      op,
      game,
      opts,
      turnTimeoutS,
      ...(typeof body.nonce === 'string' ? { nonce: body.nonce } : {}),
    };
  }

  const gameId = ev.tags.find((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0)?.[1];
  if (!gameId) return null;

  switch (op) {
    case 'join':
      return { ...base, gameId, op };
    case 'start': {
      const seats = parseSeats(body.seats);
      if (seats.length === 0) return null;
      return { ...base, gameId, op, seats };
    }
    case 'move': {
      if (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < 0) return null;
      if (body.action === undefined) return null;
      return {
        ...base,
        gameId,
        op,
        n: body.n,
        action: body.action,
        ...(typeof body.seat === 'string' && body.seat.length > 0 ? { seat: body.seat } : {}),
      };
    }
    case 'timeout': {
      if (typeof body.n !== 'number' || !Number.isInteger(body.n) || body.n < 0) return null;
      return { ...base, gameId, op, n: body.n };
    }
    case 'attack': {
      const seat = typeof body.seat === 'string' ? body.seat : ev.pubkey;
      const target = typeof body.target === 'string' ? body.target : '';
      const lines = typeof body.lines === 'number' ? Math.floor(body.lines) : 0;
      if (!target || lines <= 0) return null;
      return {
        ...base,
        gameId,
        op,
        seat,
        target,
        lines,
        hole: typeof body.hole === 'number' ? Math.abs(Math.floor(body.hole)) : 0,
        nonce: typeof body.nonce === 'number' ? body.nonce : 0,
      };
    }

    case 'topout':
      return { ...base, gameId, op, seat: typeof body.seat === 'string' ? body.seat : ev.pubkey };

    case 'checkpoint': {
      if (typeof body.frame !== 'number') return null;
      return {
        ...base,
        gameId,
        op,
        seat: typeof body.seat === 'string' ? body.seat : ev.pubkey,
        frame: Math.floor(body.frame),
        attacksSent: typeof body.attacksSent === 'number' ? Math.floor(body.attacksSent) : 0,
        linesCleared: typeof body.linesCleared === 'number' ? Math.floor(body.linesCleared) : 0,
        stackHeight: typeof body.stackHeight === 'number' ? Math.floor(body.stackHeight) : 0,
        ...(typeof body.inputs === 'string' ? { inputs: body.inputs } : {}),
      };
    }

    case 'resign':
      return {
        ...base,
        gameId,
        op,
        ...(typeof body.seat === 'string' && body.seat.length > 0 ? { seat: body.seat } : {}),
      };
    case 'cancel':
      return { ...base, gameId, op };
    default:
      return null;
  }
}

/** Marker posted as a kind 9 chat message so the table shows up in the channel. */
export const GAME_MARKER_REGEX = /\[\[game:([0-9a-f]{64})\]\]/g;

export function gameMarker(gameId: string): string {
  return `[[game:${gameId}]]`;
}

/** All table ids referenced by a chat message body, in order, deduped. */
export function extractGameMarkers(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(GAME_MARKER_REGEX)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}
