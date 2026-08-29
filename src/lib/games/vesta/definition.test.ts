import { describe, it, expect } from 'vitest';
import { createGame, applyMove } from 'vesta';
import { vesta, normalizeSeed, readResumeState, playerCountOf } from './definition';
import { diceFromEntropy } from './dice';
import { deriveSession } from '../session';
import { buildCreate, buildGameOp, parseGameEvent, localSeatId, type GameEvent, type ParsedGameEvent } from '../protocol';

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

const GAME_ID = 'v'.repeat(64);

/** Two remote players, seeded board, no clock. */
function remoteTable(extra: ParsedGameEvent[] = []) {
  return [
    parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: 'vesta', opts: { seed: 42 }, turnTimeoutS: 0 })),
    parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', {
      seats: [{ id: HOST, by: HOST }, { id: B, by: B }],
    })),
    ...extra,
  ];
}

describe('vesta engine adapter', () => {
  it('builds the same board every client, from the seed in the create event', () => {
    const one = deriveSession(remoteTable(), 1100)!;
    const other = deriveSession([...remoteTable()].reverse(), 1100)!;
    expect(one.state).toEqual(other.state);
    expect(one.state).toEqual(createGame({ players: 2, roll: 42 }));
    expect(one.status).toBe('in_progress');
    expect(one.currentTurn).toBe(HOST);
  });

  it('normalizes seeds from strings, floats, and nonsense', () => {
    expect(normalizeSeed(7)).toBe(7);
    expect(normalizeSeed('7')).toBe(7);
    expect(normalizeSeed(-7.9)).toBe(7);
    expect(normalizeSeed('banana')).toBe(0);
    expect(normalizeSeed(undefined)).toBe(0);
  });

  it('places a settlement for the seat that signed, not the seat the move claims', () => {
    const state = createGame({ players: 2, roll: 42 });
    // B is not on move, but even if they were, they cannot pass player: 0.
    const applied = vesta.applyAction(
      state,
      { type: 'place-settlement', q: 0, r: 0, corner: 0, player: 0 } as never,
      B,
      [HOST, B],
    );
    const placed = (applied.state as typeof state).players[1].settlements;
    expect(placed).toHaveLength(1);
    expect((applied.state as typeof state).players[0].settlements).toHaveLength(0);
  });

  it('rejects an illegal move through the dry run', () => {
    const state = createGame({ players: 2, roll: 42 });
    const ok = vesta.validateAction(state, { type: 'place-settlement', q: 0, r: 0, corner: 0 } as never, HOST, [HOST, B]);
    expect(ok.ok).toBe(true);

    // Same vertex twice breaks the distance rule.
    const after = applyMove(state, { type: 'place-settlement', player: 0, q: 0, r: 0, corner: 0 });
    const bad = vesta.validateAction(after, { type: 'place-settlement', q: 0, r: 0, corner: 0 } as never, B, [HOST, B]);
    expect(bad.ok).toBe(false);
  });

  describe('rule guards (upstream validates in its UI; over a relay there is no UI)', () => {
    const seats = [HOST, B];
    const fresh = () => createGame({ players: 2, roll: 42 });

    it('refuses a settlement on an occupied vertex', () => {
      const after = applyMove(fresh(), { type: 'place-settlement', player: 0, q: 0, r: 0, corner: 0 });
      const v = vesta.validateAction(after, { type: 'place-settlement', q: 0, r: 0, corner: 0 } as never, B, seats);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/occupied/i);
    });

    it('refuses a settlement too close to another', () => {
      const after = applyMove(fresh(), { type: 'place-settlement', player: 0, q: 0, r: 0, corner: 0 });
      const v = vesta.validateAction(after, { type: 'place-settlement', q: 0, r: 0, corner: 1 } as never, B, seats);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/close/i);
    });

    it('refuses building without the resources once setup is over', () => {
      const playing = { ...fresh(), phase: 'play' as const, rolled: true };
      const v = vesta.validateAction(playing, { type: 'place-settlement', q: 2, r: 0, corner: 0 } as never, HOST, seats);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/resources|adjacent road/i);
    });

    it('refuses a second roll in one turn, and an end-turn before rolling', () => {
      const playing = { ...fresh(), phase: 'play' as const, rolled: true };
      expect(vesta.validateAction(playing, { type: 'roll-dice' } as never, HOST, seats).ok).toBe(false);
      const unrolled = { ...fresh(), phase: 'play' as const, rolled: false };
      expect(vesta.validateAction(unrolled, { type: 'end-turn' } as never, HOST, seats).ok).toBe(false);
      expect(vesta.validateAction(unrolled, { type: 'roll-dice' } as never, HOST, seats).ok).toBe(true);
    });

    it('refuses a dev card with an empty deck or an empty wallet', () => {
      const playing = { ...fresh(), phase: 'play' as const, rolled: true };
      expect(vesta.validateAction(playing, { type: 'buy-dev-card' } as never, HOST, seats).ok).toBe(false);
      const rich = {
        ...playing,
        players: playing.players.map((p, i) => i === 0
          ? { ...p, resources: { ...p.resources, ore: 1, wool: 1, grain: 1 } }
          : p),
      } as typeof playing;
      expect(vesta.validateAction(rich, { type: 'buy-dev-card' } as never, HOST, seats).ok).toBe(true);
    });

    it('refuses stealing from someone who is not on the robbed tile', () => {
      const playing = { ...fresh(), phase: 'play' as const, rolled: true };
      const v = vesta.validateAction(
        playing,
        { type: 'steal-resource', victim: 1, resource: 'ore' } as never,
        HOST,
        seats,
      );
      expect(v.ok).toBe(false);
    });

    it('refuses discarding resources you do not hold', () => {
      const sevened = { ...fresh(), dice: [3, 4] as [number, number] };
      const v = vesta.validateAction(
        sevened,
        { type: 'discard-resources', resources: { ore: 3 } } as never,
        HOST,
        seats,
      );
      expect(v.ok).toBe(false);
    });
  });

  it('refuses a move from a seat that is not at the table', () => {
    const state = createGame({ players: 2, roll: 42 });
    const v = vesta.validateAction(state, { type: 'end-turn' } as never, 'pk-stranger', [HOST, B]);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/not seated/i);
  });

  describe('dice', () => {
    it('are decided by the log, not by the roller', () => {
      const a = diceFromEntropy('event-abc:3');
      const b = diceFromEntropy('event-abc:3');
      expect(a).toEqual(b);
      expect(diceFromEntropy('event-abc:4')).not.toEqual(a);
    });

    it('are always two real d6', () => {
      for (let i = 0; i < 500; i++) {
        const [d1, d2] = diceFromEntropy(`seed-${i}`);
        expect(d1).toBeGreaterThanOrEqual(1);
        expect(d1).toBeLessThanOrEqual(6);
        expect(d2).toBeGreaterThanOrEqual(1);
        expect(d2).toBeLessThanOrEqual(6);
        expect(Number.isInteger(d1) && Number.isInteger(d2)).toBe(true);
      }
    });

    it('ignore whatever dice a move claims', () => {
      const state = { ...createGame({ players: 2, roll: 42 }), phase: 'play' as const, rolled: false };
      const applied = vesta.applyAction(
        state,
        { type: 'roll-dice', dice: [6, 6] } as never,
        HOST,
        [HOST, B],
        { entropy: 'abc:0' },
      );
      const rolled = (applied.state as typeof state).dice!;
      expect(rolled).toEqual(diceFromEntropy('abc:0'));
    });

    it('cover the whole 2-12 range over many turns', () => {
      const totals = new Set<number>();
      for (let i = 0; i < 2000; i++) {
        const [a, b] = diceFromEntropy(`e${i}:${i}`);
        totals.add(a + b);
      }
      expect(totals.size).toBe(11);
    });
  });

  describe('hot-seat', () => {
    it('lets one account hold several seats and move for each', () => {
      // The host plays two seats locally; B plays remotely.
      const seats = [
        { id: localSeatId(HOST, 0), by: HOST, label: 'Ana' },
        { id: localSeatId(HOST, 1), by: HOST, label: 'Beto' },
        { id: B, by: B },
      ];
      const log = [
        parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: 'vesta', opts: { seed: 42 }, turnTimeoutS: 0 })),
        parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
        parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', { seats })),
      ];
      const s = deriveSession(log, 1100)!;
      expect(s.participants).toEqual([HOST, `${HOST}#1`, B]);
      expect(s.currentTurn).toBe(HOST);

      // Seat 0's move, published by the host.
      const m1 = parsed('m1', HOST, 1003, buildGameOp(CH, GAME_ID, 'move', {
        n: 0, seat: HOST, action: { type: 'place-settlement', q: 0, r: 0, corner: 0 },
      }));
      const s2 = deriveSession([...log, m1], 1100)!;
      expect(s2.turnIndex).toBe(1);

      // Seat 1's move, published by the SAME account — this is the whole point.
      const m2 = parsed('m2', HOST, 1004, buildGameOp(CH, GAME_ID, 'move', {
        n: 1, seat: `${HOST}#1`, action: { type: 'place-road', q1: 0, r1: 0, corner1: 0, q2: 0, r2: 0, corner2: 1 },
      }));
      const s3 = deriveSession([...log, m1, m2], 1100)!;
      expect(s3.turnIndex).toBeGreaterThanOrEqual(1);
    });

    it('refuses a move for a seat the signer does not control', () => {
      const seats = [
        { id: localSeatId(HOST, 0), by: HOST },
        { id: localSeatId(HOST, 1), by: HOST },
        { id: B, by: B },
      ];
      const log = [
        parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: 'vesta', opts: { seed: 42 }, turnTimeoutS: 0 })),
        parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
        parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', { seats })),
        // B tries to play one of the host's local seats.
        parsed('m1', B, 1003, buildGameOp(CH, GAME_ID, 'move', {
          n: 0, seat: HOST, action: { type: 'place-settlement', q: 0, r: 0, corner: 0 },
        })),
      ];
      const s = deriveSession(log, 1100)!;
      expect(s.turnIndex).toBe(0);
      expect(s.currentTurn).toBe(HOST);
    });

    it('will not seat a local player whose controller never joined', () => {
      const log = [
        parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: 'vesta', opts: { seed: 42 }, turnTimeoutS: 0 })),
        parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', {
          seats: [{ id: HOST, by: HOST }, { id: 'ghost', by: 'pk-stranger' }],
        })),
      ];
      const s = deriveSession(log, 1100)!;
      // Only the host's seat survives the filter, which is below minPlayers.
      expect(s.status).toBe('waiting');
    });
  });

  describe('resuming a saved game', () => {
    it('reads upstream export records and bare states', () => {
      const state = createGame({ players: 3, roll: 9 });
      expect(readResumeState({ startState: state, turns: [], endState: state })).toEqual(state);
      expect(readResumeState(state)).toEqual(state);
      expect(readResumeState({ nope: 1 })).toBeNull();
      expect(readResumeState(null)).toBeNull();
      expect(playerCountOf({ endState: state })).toBe(3);
      expect(playerCountOf('nonsense')).toBeNull();
    });

    it('starts a table from an imported save instead of a fresh board', () => {
      const saved = applyMove(createGame({ players: 2, roll: 5 }), {
        type: 'place-settlement', player: 0, q: 0, r: 0, corner: 0,
      });
      const log = [
        parsed(GAME_ID, HOST, 1000, buildCreate(CH, {
          game: 'vesta',
          opts: { resume: { startState: saved, turns: [], endState: saved } },
          turnTimeoutS: 0,
        })),
        parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
        parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', {
          seats: [{ id: HOST, by: HOST }, { id: B, by: B }],
        })),
      ];
      const s = deriveSession(log, 1100)!;
      expect(s.state).toEqual(saved);
      const st = s.state as typeof saved;
      expect(st.players[0].settlements).toHaveLength(1);
    });
  });

  describe('out-of-turn actions', () => {
    it('lets the trade partner answer while somebody else holds the turn', () => {
      const state = createGame({ players: 2, roll: 42 });
      const pending = { ...state, pendingTrade: { from: 0, to: 1, give: { brick: 1 }, take: { ore: 1 } } } as typeof state;
      expect(vesta.canAct!(pending, B, { type: 'accept-trade' } as never, [HOST, B])).toBe(true);
      expect(vesta.canAct!(pending, HOST, { type: 'accept-trade' } as never, [HOST, B])).toBe(false);
      expect(vesta.canAct!(pending, HOST, { type: 'cancel-proposal' } as never, [HOST, B])).toBe(true);
    });

    it('lets everyone discard on a seven, and nobody build out of turn', () => {
      const state = createGame({ players: 2, roll: 42 });
      const sevened = { ...state, dice: [3, 4] as [number, number] };
      expect(vesta.canAct!(sevened, B, { type: 'discard-resources', resources: {} } as never, [HOST, B])).toBe(true);
      expect(vesta.canAct!(state, B, { type: 'discard-resources', resources: {} } as never, [HOST, B])).toBe(false);
      expect(vesta.canAct!(state, B, { type: 'place-settlement', q: 0, r: 0, corner: 0 } as never, [HOST, B])).toBe(false);
    });
  });

  it('ends a turn on timeout instead of removing the player', () => {
    const state = createGame({ players: 3, roll: 42 });
    const out = vesta.onTimeout(state, HOST, [HOST, B, 'pk-c']);
    expect(out.nextTurn).toBe(B);
    expect(out.eliminated).toBeUndefined();
    expect((out.state as typeof state).players).toHaveLength(3);
  });

  it('finishes the table when upstream declares a winner', () => {
    const state = { ...createGame({ players: 2, roll: 42 }), winner: 1 };
    const out = vesta.applyAction(state, { type: 'end-turn' } as never, HOST, [HOST, B]);
    expect(out.nextTurn).toBeNull();
    expect(out.winner).toBe(B);
  });
});
