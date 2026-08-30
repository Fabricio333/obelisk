/**
 * The multiplayer layer: what actually crosses the relay during a match.
 *
 * Everything in the turn-based games goes on the wire — every move is an
 * event, and the board is the log. That is exactly wrong for a game running at
 * 60 frames a second: a relay round-trip per input would make it feel awful,
 * and nobody wants to pay for 3,600 events a minute.
 *
 * So Stacker splits it:
 *
 *   - **the board is local.** Each client runs `engine.ts` on its own machine
 *     at full frame rate. Nothing about drawing a frame waits for the network.
 *   - **only consequences are published.** An `attack` when you send garbage,
 *     a `topout` when you die, and a periodic `checkpoint` carrying your input
 *     log so far.
 *
 * That last one is what keeps it honest. Everyone starts from the same seed,
 * so everyone gets the same pieces; a checkpoint's input log replayed against
 * that seed reproduces the sender's board exactly, and with it the attacks
 * they claimed to have sent. A client that invents attacks publishes a log
 * that does not produce them, and `verifyCheckpoint` says so.
 *
 * Cheating is therefore *detectable*, not *prevented*: garbage lands before
 * the checkpoint that justifies it arrives. That is the deliberate trade for a
 * game that has to feel instant — see docs/games.md.
 */
import { replay, type Input } from './engine';

/** How often a client publishes its progress. Every ~10s of play. */
export const CHECKPOINT_INTERVAL_FRAMES = 600;

export interface AttackEvent {
  from: string;
  to: string;
  lines: number;
  hole: number;
  /** Distinguishes two identical attacks in the same second. */
  nonce: number;
  at: number;
}

export interface SeatProgress {
  seat: string;
  alive: boolean;
  attacksSent: number;
  linesCleared: number;
  stackHeight: number;
  frame: number;
  /** Latest snapshot of their well, as published. A few seconds behind. */
  board: string | null;
  /** null until a checkpoint with a log arrives, then true/false. */
  verified: boolean | null;
  /** Set when a checkpoint's claims do not match its own input log. */
  suspect: string | null;
}

export interface MatchState {
  seed: number;
  seats: string[];
  progress: Record<string, SeatProgress>;
  /** Every attack seen, in arrival order. */
  attacks: AttackEvent[];
  /** Seats still standing. */
  alive: string[];
  winner: string | null;
  over: boolean;
}

export function initialMatch(seed: number, seats: readonly string[]): MatchState {
  const progress: Record<string, SeatProgress> = {};
  for (const seat of seats) {
    progress[seat] = {
      seat,
      alive: true,
      attacksSent: 0,
      linesCleared: 0,
      stackHeight: 0,
      frame: 0,
      board: null,
      verified: null,
      suspect: null,
    };
  }
  return {
    seed,
    seats: [...seats],
    progress,
    attacks: [],
    alive: [...seats],
    winner: null,
    over: false,
  };
}

/** Garbage aimed at me, in the order it arrived. */
export function incomingFor(match: MatchState, seat: string, since = 0): AttackEvent[] {
  return match.attacks.filter((a) => a.to === seat && a.at > since);
}

/**
 * Fold one real-time event into the match.
 *
 * Ordering is by arrival, not by turn: two attacks landing in the same second
 * both count, and neither invalidates the other. What the reducer enforces is
 * attribution — an event only speaks for a seat its signer controls, which is
 * checked before this is called.
 */
export function applyMatchEvent(
  match: MatchState,
  event:
    | { op: 'attack'; seat: string; target: string; lines: number; hole: number; nonce: number; at: number }
    | { op: 'topout'; seat: string; at: number }
    | {
        op: 'checkpoint';
        seat: string;
        frame: number;
        attacksSent: number;
        linesCleared: number;
        stackHeight: number;
        inputs?: string;
        board?: string;
        at: number;
      },
): MatchState {
  const next: MatchState = {
    ...match,
    progress: { ...match.progress },
    attacks: match.attacks,
    alive: [...match.alive],
  };

  const seat = next.progress[event.seat];
  if (!seat) return match;

  switch (event.op) {
    case 'attack': {
      if (!next.progress[event.target]) return match;
      // Garbage aimed at someone already out goes nowhere.
      if (!next.progress[event.target].alive) return match;
      next.attacks = [...match.attacks, {
        from: event.seat,
        to: event.target,
        lines: event.lines,
        hole: event.hole,
        nonce: event.nonce,
        at: event.at,
      }];
      break;
    }

    case 'topout': {
      if (!seat.alive) return match;
      next.progress[event.seat] = { ...seat, alive: false };
      next.alive = next.alive.filter((s) => s !== event.seat);
      break;
    }

    case 'checkpoint': {
      const verification = event.inputs !== undefined
        ? verifyCheckpoint(next.seed, event.inputs, {
            attacksSent: event.attacksSent,
            linesCleared: event.linesCleared,
          })
        : null;
      next.progress[event.seat] = {
        ...seat,
        board: event.board ?? seat.board,
        frame: Math.max(seat.frame, event.frame),
        attacksSent: Math.max(seat.attacksSent, event.attacksSent),
        linesCleared: Math.max(seat.linesCleared, event.linesCleared),
        stackHeight: event.stackHeight,
        verified: verification === null ? seat.verified : verification.ok,
        suspect: verification === null ? seat.suspect : verification.reason ?? null,
      };
      break;
    }
  }

  // Last one standing takes it. A solo run ends when its only player dies.
  if (next.alive.length <= 1 && next.seats.length > 1) {
    next.over = true;
    next.winner = next.alive[0] ?? null;
  } else if (next.alive.length === 0) {
    next.over = true;
    next.winner = null;
  }

  return next;
}

/* ── input log encoding ───────────────────────────────────────────────── */

const KIND_CODES: Record<string, string> = {
  left: 'l', right: 'r', cw: 'c', ccw: 'z', flip: 'f',
  soft: 's', hard: 'h', hold: 'o', gravity: 'g', garbage: 'x',
};
const CODE_KINDS: Record<string, Input['kind']> = Object.fromEntries(
  Object.entries(KIND_CODES).map(([k, v]) => [v, k as Input['kind']]),
) as Record<string, Input['kind']>;

/**
 * Pack an input log small enough to publish repeatedly.
 *
 * `frame:kind[:lines:hole]`, comma-separated, with the frame stored as a delta
 * from the previous input — a minute of play is a few hundred bytes rather
 * than a few tens of kilobytes of JSON.
 */
export function encodeInputs(inputs: readonly Input[]): string {
  let last = 0;
  const parts: string[] = [];
  for (const input of inputs) {
    const code = KIND_CODES[input.kind];
    if (!code) continue;
    const delta = input.frame - last;
    last = input.frame;
    parts.push(
      input.kind === 'garbage'
        ? `${delta}${code}${input.lines ?? 0}.${input.hole ?? 0}`
        : `${delta}${code}`,
    );
  }
  return parts.join(',');
}

export function decodeInputs(encoded: string): Input[] {
  if (!encoded) return [];
  const out: Input[] = [];
  let frame = 0;
  for (const part of encoded.split(',')) {
    const match = /^(\d+)([a-z])(?:(\d+)\.(\d+))?$/.exec(part);
    if (!match) continue;
    const kind = CODE_KINDS[match[2]];
    if (!kind) continue;
    frame += Number(match[1]);
    if (kind === 'garbage') {
      out.push({ frame, kind, lines: Number(match[3] ?? 0), hole: Number(match[4] ?? 0) });
    } else {
      out.push({ frame, kind });
    }
  }
  return out;
}

/**
 * Replay a published input log and check it produces what its author claimed.
 *
 * This is the whole anti-cheat story. It is honest about its limits: it proves
 * a claim is consistent with a playable game on the shared seed, which is
 * enough to catch a client inventing attacks, and not enough to catch one that
 * plays legitimately with superhuman help.
 */
export function verifyCheckpoint(
  seed: number,
  encodedInputs: string,
  claim: { attacksSent: number; linesCleared: number },
): { ok: boolean; reason?: string; actual: { attacksSent: number; linesCleared: number } } {
  const inputs = decodeInputs(encodedInputs);
  const state = replay(seed, inputs);
  const actual = { attacksSent: state.attacksSent, linesCleared: state.linesCleared };

  if (claim.attacksSent > actual.attacksSent) {
    return {
      ok: false,
      reason: `claimed ${claim.attacksSent} attack lines, log produces ${actual.attacksSent}`,
      actual,
    };
  }
  if (claim.linesCleared > actual.linesCleared) {
    return {
      ok: false,
      reason: `claimed ${claim.linesCleared} lines, log produces ${actual.linesCleared}`,
      actual,
    };
  }
  return { ok: true, actual };
}
