import { describe, it, expect } from 'vitest';
import { deriveSession, type GameSession } from './session';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from './protocol';
import { isDraw, scoreFor, standingsFor } from './standings';

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';

function parsed(id: string, pubkey: string, at: number, t: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const p = parseGameEvent({ id, pubkey, created_at: at, kind: t.kind, tags: t.tags, content: t.content } as GameEvent);
  if (!p) throw new Error('unparseable');
  return p;
}

/** A one-player Stacker run that ends when its only player tops out. */
function soloRun(): GameSession {
  const id = 's'.repeat(64);
  return deriveSession([
    parsed(id, A, 1000, buildCreate(CH, { game: 'stacker', opts: { seed: 7 }, turnTimeoutS: 0 })),
    parsed('s1', A, 1001, buildGameOp(CH, id, 'start', { seats: [{ id: A, by: A, label: 'Ana' }] })),
    parsed('c1', A, 1002, buildGameOp(CH, id, 'checkpoint', {
      seat: A, frame: 600, attacksSent: 9, linesCleared: 31, stackHeight: 14,
    })),
    parsed('t1', A, 1003, buildGameOp(CH, id, 'topout', { seat: A })),
  ], 2000)!;
}

describe('a solo run that ends', () => {
  it('is over, and is NOT a draw', () => {
    const session = soloRun();
    expect(session.status).toBe('finished');
    expect(session.winner).toBeNull();
    // The bug: "no winner" was recorded as a draw, so a player who had just
    // topped out with a score was told nobody took the board.
    expect(session.draw).toBe(false);
    expect(isDraw(session)).toBe(false);
  });

  it('still knows what the player finished with', () => {
    const session = soloRun();
    expect(scoreFor(session, A)).toBe('9⚔ · 31▤');
  });
});

describe('a real draw', () => {
  it('needs more than one player and nobody left standing', () => {
    const id = 'd'.repeat(64);
    const session = deriveSession([
      parsed(id, A, 1000, buildCreate(CH, { game: 'stacker', opts: { seed: 7 }, turnTimeoutS: 0 })),
      parsed('j1', B, 1001, buildGameOp(CH, id, 'join')),
      parsed('s1', A, 1002, buildGameOp(CH, id, 'start', {
        seats: [{ id: A, by: A }, { id: B, by: B }],
      })),
      parsed('t1', A, 1003, buildGameOp(CH, id, 'topout', { seat: A })),
    ], 2000)!;
    // Two players, one out: that is a win for the survivor, not a draw.
    expect(session.winner).toBe(B);
    expect(isDraw(session)).toBe(false);
  });
});

describe('standings', () => {
  it('sorts by score, best first', () => {
    const id = 'x'.repeat(64);
    const session = deriveSession([
      parsed(id, A, 1000, buildCreate(CH, { game: 'stacker', opts: { seed: 7 }, turnTimeoutS: 0 })),
      parsed('j1', B, 1001, buildGameOp(CH, id, 'join')),
      parsed('s1', A, 1002, buildGameOp(CH, id, 'start', {
        seats: [{ id: A, by: A }, { id: B, by: B }],
      })),
      parsed('c1', A, 1003, buildGameOp(CH, id, 'checkpoint', { seat: A, frame: 60, attacksSent: 2, linesCleared: 5, stackHeight: 3 })),
      parsed('c2', B, 1004, buildGameOp(CH, id, 'checkpoint', { seat: B, frame: 60, attacksSent: 11, linesCleared: 20, stackHeight: 4 })),
    ], 2000)!;

    const rows = standingsFor(session);
    expect(rows[0].seat).toBe(B);
    expect(rows[1].seat).toBe(A);
  });

  it('returns nothing useful for a seat that never played', () => {
    expect(scoreFor(soloRun(), 'pk-stranger')).toBeNull();
    expect(scoreFor(soloRun(), null)).toBeNull();
  });
});
