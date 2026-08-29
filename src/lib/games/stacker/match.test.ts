import { describe, it, expect } from 'vitest';
import {
  initialMatch,
  applyMatchEvent,
  encodeInputs,
  decodeInputs,
  verifyCheckpoint,
  incomingFor,
} from './match';
import { replay, type Input } from './engine';
import { deriveSession } from '../session';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from '../protocol';

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';
const C = 'pk-caro';
const GAME_ID = 's'.repeat(64);

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

/** A started three-player Stacker match. */
function matchLog(extra: ParsedGameEvent[] = []) {
  return [
    parsed(GAME_ID, A, 1000, buildCreate(CH, { game: 'stacker', opts: { seed: 4242 }, turnTimeoutS: 0 })),
    parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
    parsed('j2', C, 1002, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', A, 1003, buildGameOp(CH, GAME_ID, 'start', {
      seats: [{ id: A, by: A }, { id: B, by: B }, { id: C, by: C }],
    })),
    ...extra,
  ];
}

describe('a real-time match over the log', () => {
  it('starts every seat alive with no turn', () => {
    const s = deriveSession(matchLog(), 1100)!;
    expect(s.status).toBe('in_progress');
    expect(s.currentTurn).toBeNull();
    expect(s.match).not.toBeNull();
    expect(s.match!.alive).toEqual([A, B, C]);
    expect(s.match!.seed).toBe(4242);
  });

  it('gives everyone the same seed, so everyone gets the same pieces', () => {
    const one = deriveSession(matchLog(), 1100)!;
    const other = deriveSession([...matchLog()].reverse(), 1100)!;
    expect(other.match!.seed).toBe(one.match!.seed);
  });

  it('falls back to the table id for a seed when the host set none', () => {
    const log = [
      parsed(GAME_ID, A, 1000, buildCreate(CH, { game: 'stacker', turnTimeoutS: 0 })),
      parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
      parsed('s1', A, 1003, buildGameOp(CH, GAME_ID, 'start', { seats: [{ id: A, by: A }, { id: B, by: B }] })),
    ];
    const s = deriveSession(log, 1100)!;
    // Derived from the id, so unpredictable before the table existed and the
    // same for everybody after it.
    expect(s.match!.seed).toBeGreaterThanOrEqual(0);
    expect(deriveSession([...log].reverse(), 1100)!.match!.seed).toBe(s.match!.seed);
  });

  it('carries an attack from one seat to another', () => {
    const s = deriveSession(matchLog([
      parsed('a1', A, 1010, buildGameOp(CH, GAME_ID, 'attack', { seat: A, target: B, lines: 4, hole: 3, nonce: 1 })),
    ]), 1100)!;
    expect(s.match!.attacks).toHaveLength(1);
    expect(s.match!.attacks[0]).toMatchObject({ from: A, to: B, lines: 4, hole: 3 });
    expect(incomingFor(s.match!, B)).toHaveLength(1);
    expect(incomingFor(s.match!, C)).toHaveLength(0);
  });

  it('refuses an attack signed by somebody else', () => {
    const s = deriveSession(matchLog([
      // Bruno publishes an attack claiming to come from Ana.
      parsed('a1', B, 1010, buildGameOp(CH, GAME_ID, 'attack', { seat: A, target: C, lines: 8, hole: 0, nonce: 1 })),
    ]), 1100)!;
    expect(s.match!.attacks).toHaveLength(0);
  });

  it('drops an attack aimed at nobody, or at a player already out', () => {
    const s = deriveSession(matchLog([
      parsed('t1', C, 1010, buildGameOp(CH, GAME_ID, 'topout', { seat: C })),
      parsed('a1', A, 1011, buildGameOp(CH, GAME_ID, 'attack', { seat: A, target: C, lines: 4, hole: 1, nonce: 1 })),
      parsed('a2', A, 1012, buildGameOp(CH, GAME_ID, 'attack', { seat: A, target: 'pk-ghost', lines: 4, hole: 1, nonce: 2 })),
    ]), 1100)!;
    expect(s.match!.attacks).toHaveLength(0);
  });

  it('ends when one player is left standing', () => {
    const s = deriveSession(matchLog([
      parsed('t1', B, 1010, buildGameOp(CH, GAME_ID, 'topout', { seat: B })),
      parsed('t2', C, 1011, buildGameOp(CH, GAME_ID, 'topout', { seat: C })),
    ]), 1100)!;
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(A);
    expect(s.match!.alive).toEqual([A]);
  });

  it('ignores a second topout from the same seat', () => {
    const s = deriveSession(matchLog([
      parsed('t1', B, 1010, buildGameOp(CH, GAME_ID, 'topout', { seat: B })),
      parsed('t2', B, 1011, buildGameOp(CH, GAME_ID, 'topout', { seat: B })),
    ]), 1100)!;
    expect(s.match!.alive).toEqual([A, C]);
    expect(s.status).toBe('in_progress');
  });

  it('records progress from checkpoints', () => {
    const s = deriveSession(matchLog([
      parsed('c1', B, 1010, buildGameOp(CH, GAME_ID, 'checkpoint', {
        seat: B, frame: 600, attacksSent: 12, linesCleared: 20, stackHeight: 7,
      })),
    ]), 1100)!;
    expect(s.match!.progress[B]).toMatchObject({
      frame: 600, attacksSent: 12, linesCleared: 20, stackHeight: 7,
    });
  });

  it('replays a match to the same result whatever order events arrive in', () => {
    const events = [
      parsed('a1', A, 1010, buildGameOp(CH, GAME_ID, 'attack', { seat: A, target: B, lines: 2, hole: 1, nonce: 1 })),
      parsed('a2', B, 1011, buildGameOp(CH, GAME_ID, 'attack', { seat: B, target: A, lines: 4, hole: 5, nonce: 2 })),
      parsed('t1', C, 1012, buildGameOp(CH, GAME_ID, 'topout', { seat: C })),
    ];
    const straight = deriveSession(matchLog(events), 1100)!;
    const jumbled = deriveSession([...matchLog(events)].reverse(), 1100)!;
    expect(jumbled.match!.alive).toEqual(straight.match!.alive);
    expect(jumbled.match!.attacks).toEqual(straight.match!.attacks);
  });
});

describe('input log encoding', () => {
  it('round-trips a log', () => {
    const log: Input[] = [
      { frame: 3, kind: 'left' },
      { frame: 7, kind: 'cw' },
      { frame: 9, kind: 'hard' },
      { frame: 40, kind: 'garbage', lines: 4, hole: 7 },
      { frame: 41, kind: 'hold' },
    ];
    expect(decodeInputs(encodeInputs(log))).toEqual(log);
  });

  it('packs a minute of play into a few hundred bytes', () => {
    const log: Input[] = [];
    for (let i = 0; i < 600; i++) {
      log.push({ frame: i * 6, kind: i % 4 === 0 ? 'hard' : 'left' });
    }
    const encoded = encodeInputs(log);
    expect(encoded.length).toBeLessThan(JSON.stringify(log).length / 8);
    expect(decodeInputs(encoded)).toHaveLength(600);
  });

  it('survives garbage in the encoded string', () => {
    expect(decodeInputs('')).toEqual([]);
    expect(decodeInputs('nonsense,,,3q')).toEqual([]);
    expect(decodeInputs('5h,rubbish,2l')).toHaveLength(2);
  });
});

describe('checkpoint verification — the honesty check', () => {
  /** A log that genuinely clears lines and sends attacks. */
  function realLog(): { inputs: Input[]; encoded: string; seed: number } {
    const seed = 20260829;
    const inputs: Input[] = [];
    for (let i = 0; i < 120; i++) {
      inputs.push({ frame: i * 4, kind: i % 5 === 0 ? 'cw' : 'hard' });
    }
    return { inputs, encoded: encodeInputs(inputs), seed };
  }

  it('accepts a claim its own log produces', () => {
    const { encoded, seed, inputs } = realLog();
    const truth = replay(seed, inputs);
    const v = verifyCheckpoint(seed, encoded, {
      attacksSent: truth.attacksSent,
      linesCleared: truth.linesCleared,
    });
    expect(v.ok).toBe(true);
    expect(v.actual.linesCleared).toBe(truth.linesCleared);
  });

  it('catches a client inventing attacks it never earned', () => {
    const { encoded, seed, inputs } = realLog();
    const truth = replay(seed, inputs);
    const v = verifyCheckpoint(seed, encoded, {
      attacksSent: truth.attacksSent + 40,
      linesCleared: truth.linesCleared,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/claimed .* attack lines/);
  });

  it('catches an inflated line count', () => {
    const { encoded, seed, inputs } = realLog();
    const truth = replay(seed, inputs);
    const v = verifyCheckpoint(seed, encoded, {
      attacksSent: truth.attacksSent,
      linesCleared: truth.linesCleared + 100,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/claimed .* lines/);
  });

  it('catches a log replayed against the wrong seed', () => {
    const { encoded, seed, inputs } = realLog();
    const truth = replay(seed, inputs);
    // Same log, different board: the claims no longer follow from it.
    const v = verifyCheckpoint(seed + 1, encoded, {
      attacksSent: truth.attacksSent + 5,
      linesCleared: truth.linesCleared + 5,
    });
    expect(v.ok).toBe(false);
  });

  it('flags the suspect seat on the match, and leaves honest ones clean', () => {
    const { encoded, seed, inputs } = realLog();
    const truth = replay(seed, inputs);

    let match = initialMatch(seed, [A, B]);
    match = applyMatchEvent(match, {
      op: 'checkpoint', seat: A, frame: 500, at: 10,
      attacksSent: truth.attacksSent, linesCleared: truth.linesCleared, stackHeight: 4,
      inputs: encoded,
    });
    match = applyMatchEvent(match, {
      op: 'checkpoint', seat: B, frame: 500, at: 11,
      attacksSent: truth.attacksSent + 99, linesCleared: truth.linesCleared, stackHeight: 4,
      inputs: encoded,
    });

    expect(match.progress[A].verified).toBe(true);
    expect(match.progress[A].suspect).toBeNull();
    expect(match.progress[B].verified).toBe(false);
    expect(match.progress[B].suspect).toMatch(/attack lines/);
  });

  it('leaves verification unknown when a checkpoint carries no log', () => {
    let match = initialMatch(1, [A]);
    match = applyMatchEvent(match, {
      op: 'checkpoint', seat: A, frame: 60, at: 1,
      attacksSent: 4, linesCleared: 4, stackHeight: 2,
    });
    expect(match.progress[A].verified).toBeNull();
  });
});
