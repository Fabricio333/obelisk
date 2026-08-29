import { describe, it, expect } from 'vitest';
import { getValidPositions, type GameState } from 'vesta';
import { deriveSession, type GameSession } from '../session';
import {
  buildCreate,
  buildGameOp,
  parseGameEvent,
  type GameEvent,
  type ParsedGameEvent,
  type SeatSpec,
} from '../protocol';
import { vertices, edges } from './geometry';

/**
 * A whole game, played the way the app plays it: every move is an event, and
 * the board only ever comes from replaying the log.
 *
 * This is the test that would catch a break between the UI, the wire format,
 * and upstream's rules — each of the three could be internally consistent and
 * still disagree with the other two.
 */

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';
const GAME_ID = 'g'.repeat(64);

function parse(ev: GameEvent): ParsedGameEvent {
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable event');
  return p;
}

/** A tiny harness standing in for "a client that publishes and re-derives". */
class Table {
  private log: ParsedGameEvent[] = [];
  private clock = 1000;

  constructor(seats: SeatSpec[], opts: Record<string, unknown> = { seed: 42 }) {
    this.push(GAME_ID, A, buildCreate(CH, { game: 'vesta', opts, turnTimeoutS: 0 }));
    this.push('join-b', B, buildGameOp(CH, GAME_ID, 'join'));
    this.push('start', A, buildGameOp(CH, GAME_ID, 'start', { seats }));
  }

  private push(id: string, pubkey: string, template: { kind: number; content: string; tags: string[][] }) {
    this.log.push(parse({
      id,
      pubkey,
      created_at: this.clock++,
      kind: template.kind,
      tags: template.tags,
      content: template.content,
    }));
  }

  session(): GameSession {
    return deriveSession(this.log, 9_999_999)!;
  }

  state(): GameState {
    return this.session().state as GameState;
  }

  /** Publish a move the way the UI does: as the seat currently on move. */
  move(action: unknown, by?: string, seat?: string): GameSession {
    const s = this.session();
    const actingSeat = seat ?? s.currentTurn!;
    const controller = by ?? s.seats.find((x) => x.id === actingSeat)!.by;
    this.push(
      `m${this.log.length}`,
      controller,
      buildGameOp(CH, GAME_ID, 'move', { n: s.turnIndex, action, seat: actingSeat }),
    );
    return this.session();
  }

  /** Everything published so far, shuffled — replay must not care about order. */
  shuffledLog(): ParsedGameEvent[] {
    return [...this.log].reverse();
  }

  rawLog(): ParsedGameEvent[] {
    return [...this.log];
  }
}

/** Place a settlement and its road for whoever is on move during setup. */
function placeSetupPair(table: Table): void {
  const before = table.state();
  const spot = getValidPositions(before, 'initial-settlement')[0];
  const vertex = vertices().get(spot.key)!;
  const hex = vertex.hexes[0];
  table.move({ type: 'place-settlement', q: hex.q, r: hex.r, corner: hex.corner });

  const afterSettlement = table.state();
  const roadSpot = getValidPositions(afterSettlement, 'initial-road')[0];
  const edge = edges().get(roadSpot.key)!;
  table.move({
    type: 'place-road',
    q1: edge.hex.q, r1: edge.hex.r, corner1: edge.hex.c1,
    q2: edge.hex.q, r2: edge.hex.r, corner2: edge.hex.c2,
  });
}

describe('a game played over the log', () => {
  const seats: SeatSpec[] = [{ id: A, by: A, label: 'Ana' }, { id: B, by: B, label: 'Bruno' }];

  it('runs the whole setup snake and reaches the play phase', () => {
    const table = new Table(seats);
    expect(table.state().phase).toBe('initial_first');

    // Two players: A, B (first round), then B, A (second round).
    for (let i = 0; i < 4; i++) placeSetupPair(table);

    const s = table.session();
    const state = table.state();
    expect(state.phase).toBe('play');
    expect(state.players[0].settlements).toHaveLength(2);
    expect(state.players[1].settlements).toHaveLength(2);
    expect(state.players[0].roads).toHaveLength(2);
    expect(s.currentTurn).toBe(A);
  });

  it('rolls, produces, and passes the turn', () => {
    const table = new Table(seats);
    for (let i = 0; i < 4; i++) placeSetupPair(table);

    const rolled = table.move({ type: 'roll-dice' });
    const state = rolled.state as GameState;
    expect(state.rolled).toBe(true);
    expect(state.dice).not.toBeNull();
    expect(state.dice![0] + state.dice![1]).toBeGreaterThanOrEqual(2);
    expect(state.dice![0] + state.dice![1]).toBeLessThanOrEqual(12);

    const ended = table.move({ type: 'end-turn' });
    expect(ended.currentTurn).toBe(B);
    expect((ended.state as GameState).rolled).toBe(false);
  });

  it('lands on the same board no matter what order the events arrive in', () => {
    const table = new Table(seats);
    for (let i = 0; i < 4; i++) placeSetupPair(table);
    table.move({ type: 'roll-dice' });
    table.move({ type: 'end-turn' });

    const straight = deriveSession(table.rawLog(), 9_999_999)!;
    const jumbled = deriveSession(table.shuffledLog(), 9_999_999)!;
    expect(jumbled.state).toEqual(straight.state);
    expect(jumbled.currentTurn).toBe(straight.currentTurn);
    expect(jumbled.turnIndex).toBe(straight.turnIndex);
  });

  it('refuses a move published by the wrong account', () => {
    const table = new Table(seats);
    const before = table.session();
    const spot = getValidPositions(table.state(), 'initial-settlement')[0];
    const hex = vertices().get(spot.key)!.hexes[0];

    // Bruno signs a move for Ana's seat, on Ana's turn.
    const after = table.move(
      { type: 'place-settlement', q: hex.q, r: hex.r, corner: hex.corner },
      B,
      A,
    );
    expect(after.turnIndex).toBe(before.turnIndex);
    expect((after.state as GameState).players[0].settlements).toHaveLength(0);
  });

  it('refuses a settlement on an occupied vertex, whoever publishes it', () => {
    const table = new Table(seats);
    const spot = getValidPositions(table.state(), 'initial-settlement')[0];
    const hex = vertices().get(spot.key)!.hexes[0];
    table.move({ type: 'place-settlement', q: hex.q, r: hex.r, corner: hex.corner });

    // Skip ahead to Bruno by placing Ana's road, then aim at the same vertex.
    const roadSpot = getValidPositions(table.state(), 'initial-road')[0];
    const edge = edges().get(roadSpot.key)!;
    table.move({
      type: 'place-road',
      q1: edge.hex.q, r1: edge.hex.r, corner1: edge.hex.c1,
      q2: edge.hex.q, r2: edge.hex.r, corner2: edge.hex.c2,
    });

    const before = table.session();
    expect(before.currentTurn).toBe(B);
    const after = table.move({ type: 'place-settlement', q: hex.q, r: hex.r, corner: hex.corner });
    expect(after.turnIndex).toBe(before.turnIndex);
    expect((after.state as GameState).players[1].settlements).toHaveLength(0);
  });

  it('plays a hot-seat table where one account holds two seats', () => {
    const hotSeats: SeatSpec[] = [
      { id: A, by: A, label: 'Ana' },
      { id: `${A}#1`, by: A, label: 'Beto' },
      { id: B, by: B, label: 'Bruno' },
    ];
    const table = new Table(hotSeats);
    expect(table.session().participants).toEqual([A, `${A}#1`, B]);

    // Three players → six setup placements.
    for (let i = 0; i < 6; i++) placeSetupPair(table);

    const state = table.state();
    expect(state.phase).toBe('play');
    // Ana and Beto are separate players with separate boards…
    expect(state.players[0].settlements).toHaveLength(2);
    expect(state.players[1].settlements).toHaveLength(2);
    // …even though both of their seats were signed by the same key.
    const s = table.session();
    expect(s.seats[0].by).toBe(A);
    expect(s.seats[1].by).toBe(A);
    expect(s.seats[2].by).toBe(B);
  });

  it('continues a table created from a saved game', () => {
    const seeded = new Table(seats);
    for (let i = 0; i < 4; i++) placeSetupPair(seeded);
    const saved = seeded.state();

    const resumed = new Table(seats, { resume: { startState: saved, turns: [], endState: saved } });
    expect(resumed.state()).toEqual(saved);
    expect(resumed.state().phase).toBe('play');

    // And it keeps playing from there.
    const rolled = resumed.move({ type: 'roll-dice' });
    expect((rolled.state as GameState).rolled).toBe(true);
  });

  describe('the robber (sequencing upstream keeps in its UI)', () => {
    /** Roll until the log hands us a seven, so the robber is genuinely out. */
    function rollUntilSeven(table: Table, maxTurns = 60): boolean {
      for (let i = 0; i < maxTurns; i++) {
        const rolled = table.move({ type: 'roll-dice' });
        const state = rolled.state as GameState;
        if (state.dice![0] + state.dice![1] === 7) return true;
        table.move({ type: 'end-turn' });
      }
      return false;
    }

    it('will not move without a seven or a knight', () => {
      const table = new Table(seats);
      for (let i = 0; i < 4; i++) placeSetupPair(table);
      table.move({ type: 'roll-dice' });
      const state = table.state();
      if (state.dice![0] + state.dice![1] === 7) return; // covered by the next test

      const before = table.session();
      const target = state.board.tiles.find(
        (t) => t.coord.q !== state.board.robber.q || t.coord.r !== state.board.robber.r,
      )!;
      const after = table.move({ type: 'move-robber', q: target.coord.q, r: target.coord.r });
      expect(after.turnIndex).toBe(before.turnIndex);
      expect(after.state).toEqual(before.state);
    });

    it('is sent by a seven, blocks the turn from ending, and then allows a steal', () => {
      const table = new Table(seats);
      for (let i = 0; i < 4; i++) placeSetupPair(table);
      expect(rollUntilSeven(table)).toBe(true);

      // The turn cannot be handed over with the robber still in the air.
      const stuck = table.session();
      const tryEnd = table.move({ type: 'end-turn' });
      expect(tryEnd.turnIndex).toBe(stuck.turnIndex);

      const state = table.state();
      const target = state.board.tiles.find(
        (t) => t.coord.q !== state.board.robber.q || t.coord.r !== state.board.robber.r,
      )!;
      const moved = table.move({ type: 'move-robber', q: target.coord.q, r: target.coord.r });
      expect((moved.state as GameState).board.robber).toEqual({ q: target.coord.q, r: target.coord.r });

      // And now the turn can end.
      const ended = table.move({ type: 'end-turn' });
      expect(ended.turnIndex).toBeGreaterThan(moved.turnIndex);
    });
  });

  it('gives every client the same dice for the same turn', () => {
    const one = new Table(seats);
    for (let i = 0; i < 4; i++) placeSetupPair(one);
    const rolledOnce = one.move({ type: 'roll-dice' });

    // A second client replaying the identical log must roll identically.
    const replayed = deriveSession(one.rawLog(), 9_999_999)!;
    expect((replayed.state as GameState).dice).toEqual((rolledOnce.state as GameState).dice);
  });
});
