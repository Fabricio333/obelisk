import { describe, it, expect } from 'vitest';
import { deriveSession, canJoin, canStart, isSoloTable, isTurnExpired, turnSecondsLeft } from './session';
import { parseGameEvent, buildCreate, buildGameOp, type GameEvent, type ParsedGameEvent } from './protocol';
import { chainReaction, CR_SIZES } from './chain-reaction';
import { KIND_GAME } from '@/lib/nip-kinds';

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';
const C = 'pk-c';

let seq = 0;
/** Build a signed-looking event. Ids are deterministic so tiebreaks are testable. */
function ev(
  pubkey: string,
  createdAt: number,
  template: { kind: number; content: string; tags: string[][] },
  id?: string,
): GameEvent {
  return {
    id: id ?? `id-${String(seq++).padStart(4, '0')}`,
    pubkey,
    created_at: createdAt,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  };
}

function parse(e: GameEvent): ParsedGameEvent {
  const p = parseGameEvent(e);
  if (!p) throw new Error(`unparseable event: ${e.content}`);
  return p;
}

/** A table with host+B seated and started at t=1000, 45s clock. */
function startedTable(timeoutS = 45) {
  const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, opts: { size: 'small' }, turnTimeoutS: timeoutS }), 'game-1');
  const gameId = createEv.id;
  const log = [
    parse(createEv),
    parse(ev(B, 1001, buildGameOp(CH, gameId, 'join'))),
    parse(ev(HOST, 1002, buildGameOp(CH, gameId, 'start', { seats: [HOST, B] }))),
  ];
  return { gameId, log };
}

describe('deriveSession', () => {
  it('returns null without a create event', () => {
    expect(deriveSession([parse(ev(B, 10, buildGameOp(CH, 'game-x', 'join')))], 20)).toBeNull();
  });

  it('seats the host at creation without a join event', () => {
    const s = deriveSession([parse(ev(HOST, 100, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 })))], 120)!;
    expect(s.status).toBe('waiting');
    expect(s.joined).toEqual([HOST]);
    expect(s.createdBy).toBe(HOST);
  });

  it('is order-independent: shuffled logs derive the same board', () => {
    const { log } = startedTable();
    const straight = deriveSession(log, 1100)!;
    const shuffled = deriveSession([...log].reverse(), 1100)!;
    expect(shuffled.state).toEqual(straight.state);
    expect(shuffled.currentTurn).toBe(straight.currentTurn);
    expect(shuffled.status).toBe('in_progress');
  });

  it('honours the create opts (board size) at start', () => {
    const { log } = startedTable();
    const s = deriveSession(log, 1100)!;
    const state = s.state as { rows: number; cols: number };
    expect(state.rows).toBe(CR_SIZES.small.rows);
    expect(state.cols).toBe(CR_SIZES.small.cols);
  });

  it('ignores joins after start and joins beyond maxPlayers', () => {
    const { gameId, log } = startedTable();
    const s = deriveSession([...log, parse(ev(C, 1500, buildGameOp(CH, gameId, 'join')))], 1600)!;
    expect(s.participants).toEqual([HOST, B]);
    expect(s.joined).toEqual([HOST, B]);
  });

  it('only the host can start, and only with players who joined', () => {
    const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g2');
    const base = [parse(createEv), parse(ev(B, 1001, buildGameOp(CH, 'g2', 'join')))];

    const byImpostor = deriveSession([...base, parse(ev(B, 1002, buildGameOp(CH, 'g2', 'start', { seats: [HOST, B] })))], 1100)!;
    expect(byImpostor.status).toBe('waiting');

    // C never joined — the host cannot drag them to the table.
    const withGhost = deriveSession(
      [...base, parse(ev(HOST, 1002, buildGameOp(CH, 'g2', 'start', { seats: [HOST, B, C] })))],
      1100,
    )!;
    expect(withGhost.participants).toEqual([HOST, B]);
  });

  it('applies a legal move and advances the turn', () => {
    const { gameId, log } = startedTable();
    const s = deriveSession([...log, parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 0 } })))], 1020)!;
    expect(s.turnIndex).toBe(1);
    expect(s.currentTurn).toBe(B);
    const state = s.state as { cells: Array<{ count: number; owner: number | null }> };
    expect(state.cells[0]).toEqual({ count: 1, owner: 0 });
  });

  it('drops a move from the wrong player', () => {
    const { gameId, log } = startedTable();
    const s = deriveSession([...log, parse(ev(B, 1010, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 0 } })))], 1020)!;
    expect(s.currentTurn).toBe(HOST);
    expect(s.turnIndex).toBe(0);
  });

  it('drops a move carrying the wrong turn index (replay / stale view)', () => {
    const { gameId, log } = startedTable();
    const s = deriveSession([...log, parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'move', { n: 3, action: { cell: 0 } })))], 1020)!;
    expect(s.turnIndex).toBe(0);
  });

  it('drops an illegal move (cell owned by an opponent)', () => {
    const { gameId, log } = startedTable();
    const withHostCell = [
      ...log,
      parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 0 } }))),
    ];
    // B tries to drop an orb on the host's cell.
    const s = deriveSession(
      [...withHostCell, parse(ev(B, 1011, buildGameOp(CH, gameId, 'move', { n: 1, action: { cell: 0 } })))],
      1020,
    )!;
    expect(s.currentTurn).toBe(B);
    expect(s.turnIndex).toBe(1);
  });

  it('resolves two moves for the same turn by (created_at, id) — first one wins', () => {
    const { gameId, log } = startedTable();
    const late = parse(ev(HOST, 1011, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 5 } }), 'id-aaa'));
    const early = parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 0 } }), 'id-zzz'));
    const s = deriveSession([...log, late, early], 1020)!;
    const state = s.state as { cells: Array<{ count: number; owner: number | null }> };
    expect(state.cells[0].count).toBe(1);
    expect(state.cells[5].count).toBe(0);
  });

  it('breaks a same-second tie by event id, identically for every client', () => {
    const { gameId, log } = startedTable();
    const a = parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 0 } }), 'id-aaa'));
    const z = parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 5 } }), 'id-zzz'));
    const one = deriveSession([...log, a, z], 1020)!;
    const other = deriveSession([...log, z, a], 1020)!;
    expect(one.state).toEqual(other.state);
    const state = one.state as { cells: Array<{ count: number }> };
    expect(state.cells[0].count).toBe(1);
  });

  describe('turn clock', () => {
    it('accepts a timeout claim published after the deadline', () => {
      const { gameId, log } = startedTable(45);
      const s = deriveSession([...log, parse(ev(B, 1002 + 45, buildGameOp(CH, gameId, 'timeout', { n: 0 })))], 1100)!;
      // Host was eliminated on time; B is the only one left.
      expect(s.status).toBe('finished');
      expect(s.winner).toBe(B);
    });

    it('rejects a timeout claim published before the deadline', () => {
      const { gameId, log } = startedTable(45);
      const s = deriveSession([...log, parse(ev(B, 1010, buildGameOp(CH, gameId, 'timeout', { n: 0 })))], 1100)!;
      expect(s.status).toBe('in_progress');
      expect(s.currentTurn).toBe(HOST);
    });

    it('rejects any timeout on a table with no clock', () => {
      const { gameId, log } = startedTable(0);
      const s = deriveSession([...log, parse(ev(B, 99999, buildGameOp(CH, gameId, 'timeout', { n: 0 })))], 100000)!;
      expect(s.status).toBe('in_progress');
      expect(s.turnDeadline).toBeNull();
    });

    it('a move beats a timeout claim for the same turn when it came first', () => {
      const { gameId, log } = startedTable(45);
      const move = parse(ev(HOST, 1020, buildGameOp(CH, gameId, 'move', { n: 0, action: { cell: 0 } })));
      const claim = parse(ev(B, 1047, buildGameOp(CH, gameId, 'timeout', { n: 0 })));
      const s = deriveSession([...log, claim, move], 1100)!;
      expect(s.status).toBe('in_progress');
      expect(s.currentTurn).toBe(B);
      // The stale claim names turn 0; the table is on turn 1, so it is inert.
      expect(s.turnIndex).toBe(1);
    });

    it('exposes deadline helpers', () => {
      const { log } = startedTable(45);
      const s = deriveSession(log, 1010)!;
      expect(s.turnDeadline).toBe(1002 + 45);
      expect(turnSecondsLeft(s, 1010)).toBe(37);
      expect(isTurnExpired(s, 1010)).toBe(false);
      expect(isTurnExpired(s, 1047)).toBe(true);
      expect(turnSecondsLeft(s, 1099)).toBe(0);
    });
  });

  describe('resign', () => {
    it('ends a two-player game and crowns the other player', () => {
      const { gameId, log } = startedTable();
      const s = deriveSession([...log, parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'resign')))], 1020)!;
      expect(s.status).toBe('finished');
      expect(s.winner).toBe(B);
    });

    it('out-of-turn resign does not steal the turn from the player on move', () => {
      const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g3');
      const log = [
        parse(createEv),
        parse(ev(B, 1001, buildGameOp(CH, 'g3', 'join'))),
        parse(ev(C, 1001, buildGameOp(CH, 'g3', 'join'))),
        parse(ev(HOST, 1002, buildGameOp(CH, 'g3', 'start', { seats: [HOST, B, C] }))),
      ];
      // Host is on move; C resigns out of turn.
      const s = deriveSession([...log, parse(ev(C, 1005, buildGameOp(CH, 'g3', 'resign')))], 1010)!;
      expect(s.status).toBe('in_progress');
      expect(s.currentTurn).toBe(HOST);
      expect(s.eliminated).toContain(C);
    });

    it('ignores a resign from someone who is not at the table', () => {
      const { gameId, log } = startedTable();
      const s = deriveSession([...log, parse(ev(C, 1010, buildGameOp(CH, gameId, 'resign')))], 1020)!;
      expect(s.status).toBe('in_progress');
      expect(s.eliminated).toEqual([]);
    });
  });

  describe('cancel and expiry', () => {
    it('lets the host cancel a waiting table', () => {
      const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g4');
      const s = deriveSession([parse(createEv), parse(ev(HOST, 1005, buildGameOp(CH, 'g4', 'cancel')))], 1010)!;
      expect(s.status).toBe('cancelled');
    });

    it('ignores a cancel from anyone else', () => {
      const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g5');
      const s = deriveSession([parse(createEv), parse(ev(B, 1005, buildGameOp(CH, 'g5', 'cancel')))], 1010)!;
      expect(s.status).toBe('waiting');
    });

    it('treats a waiting table older than an hour as stale, with no event', () => {
      const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g6');
      expect(deriveSession([parse(createEv)], 1000 + 3599)!.status).toBe('waiting');
      expect(deriveSession([parse(createEv)], 1000 + 3601)!.status).toBe('cancelled');
    });

    it('does not expire a table that already started', () => {
      const { log } = startedTable();
      expect(deriveSession(log, 1000 + 99999)!.status).toBe('in_progress');
    });
  });

  it('ignores events published after the game finished', () => {
    const { gameId, log } = startedTable();
    const finished = [...log, parse(ev(HOST, 1010, buildGameOp(CH, gameId, 'resign')))];
    const s = deriveSession(
      [...finished, parse(ev(B, 1020, buildGameOp(CH, gameId, 'move', { n: 1, action: { cell: 0 } })))],
      1030,
    )!;
    expect(s.status).toBe('finished');
    expect(s.winner).toBe(B);
  });

  it('returns null for an unknown game type', () => {
    const createEv = ev(HOST, 1000, buildCreate(CH, { game: 'battleship', turnTimeoutS: 45 }));
    expect(deriveSession([parse(createEv)], 1010)).toBeNull();
  });
});

describe('seat helpers', () => {
  it('canJoin only while waiting, once, and under maxPlayers', () => {
    const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g7');
    const waiting = deriveSession([parse(createEv)], 1010)!;
    expect(canJoin(waiting, B)).toBe(true);
    expect(canJoin(waiting, HOST)).toBe(false);
    expect(canJoin(waiting, null)).toBe(false);
    const { log } = startedTable();
    expect(canJoin(deriveSession(log, 1010)!, C)).toBe(false);
  });

  it('canStart is the host\'s call, head-count or not', () => {
    const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g8');
    // A host on their own can start: they may be taking every seat themselves.
    const alone = deriveSession([parse(createEv)], 1010)!;
    expect(canStart(alone, HOST)).toBe(true);
    const two = deriveSession([parse(createEv), parse(ev(B, 1001, buildGameOp(CH, 'g8', 'join')))], 1010)!;
    expect(canStart(two, HOST)).toBe(true);
    expect(canStart(two, B)).toBe(false);
  });

  it('but the reducer still refuses a start with too few seats', () => {
    const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }), 'g9');
    const s = deriveSession([
      parse(createEv),
      parse(ev(HOST, 1002, buildGameOp(CH, 'g9', 'start', { seats: [{ id: HOST, by: HOST }] }))),
    ], 1010)!;
    expect(s.status).toBe('waiting');
  });

  it('starts a table where the host holds every seat', () => {
    const createEv = ev(HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 0 }), 'g10');
    const s = deriveSession([
      parse(createEv),
      parse(ev(HOST, 1002, buildGameOp(CH, 'g10', 'start', {
        seats: [
          { id: HOST, by: HOST, label: 'Ana' },
          { id: `${HOST}#1`, by: HOST, label: 'Beto' },
          { id: `${HOST}#2`, by: HOST, label: 'Caro' },
        ],
      }))),
    ], 1010)!;
    expect(s.status).toBe('in_progress');
    expect(s.participants).toEqual([HOST, `${HOST}#1`, `${HOST}#2`]);
    expect(isSoloTable(s)).toBe(true);
  });
});

describe('parseGameEvent', () => {
  it('rejects the wrong kind, missing h tag, and unparseable content', () => {
    const good = ev(HOST, 1, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 }));
    expect(parseGameEvent({ ...good, kind: 1 })).toBeNull();
    expect(parseGameEvent({ ...good, tags: good.tags.filter((t) => t[0] !== 'h') })).toBeNull();
    expect(parseGameEvent({ ...good, content: '{oops' })).toBeNull();
    expect(parseGameEvent({ ...good, content: '[]' })).toBeNull();
  });

  it('rejects ops that reference no table', () => {
    const e = ev(B, 1, buildGameOp(CH, 'g', 'join'));
    expect(parseGameEvent({ ...e, tags: e.tags.filter((t) => t[0] !== 'e') })).toBeNull();
  });

  it('rejects malformed moves and timeouts', () => {
    expect(parseGameEvent(ev(B, 1, buildGameOp(CH, 'g', 'move', { action: { cell: 1 } })))).toBeNull();
    expect(parseGameEvent(ev(B, 1, buildGameOp(CH, 'g', 'move', { n: -1, action: { cell: 1 } })))).toBeNull();
    expect(parseGameEvent(ev(B, 1, buildGameOp(CH, 'g', 'move', { n: 0 })))).toBeNull();
    expect(parseGameEvent(ev(B, 1, buildGameOp(CH, 'g', 'timeout', { n: 'soon' })))).toBeNull();
    expect(parseGameEvent(ev(HOST, 1, buildGameOp(CH, 'g', 'start', { seats: [] })))).toBeNull();
  });

  it('round-trips a create with its opts and duplicates n into a tag', () => {
    const created = parseGameEvent(ev(HOST, 5, buildCreate(CH, { game: 'chain-reaction', opts: { size: 'large' }, turnTimeoutS: 30 })));
    expect(created).toMatchObject({ op: 'create', game: 'chain-reaction', turnTimeoutS: 30, opts: { size: 'large' } });
    const move = ev(B, 6, buildGameOp(CH, 'g', 'move', { n: 4, action: { cell: 2 } }));
    expect(move.kind).toBe(KIND_GAME);
    expect(move.tags).toContainEqual(['n', '4']);
  });
});
