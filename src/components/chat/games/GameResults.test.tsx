import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createGame } from 'vesta';
import GameResults from './GameResults';
import { deriveSession, type GameSession } from '@/lib/games/session';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';
import { applyMatchEvent } from '@/lib/games/stacker/match';

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';
const label = (s: string) => (s === A ? 'Ana' : s === B ? 'Bruno' : s);

function parsed(id: string, pubkey: string, at: number, t: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const p = parseGameEvent({ id, pubkey, created_at: at, kind: t.kind, tags: t.tags, content: t.content } as GameEvent);
  if (!p) throw new Error('unparseable');
  return p;
}

/** Chain Reaction, played until the host resigns and Bruno takes it. */
function finishedChainReaction(): GameSession {
  const id = 'c'.repeat(64);
  return deriveSession([
    parsed(id, A, 1000, buildCreate(CH, { game: 'chain-reaction', opts: { size: 'small' }, turnTimeoutS: 0 })),
    parsed('j1', B, 1001, buildGameOp(CH, id, 'join')),
    parsed('s1', A, 1002, buildGameOp(CH, id, 'start', { seats: [{ id: A, by: A }, { id: B, by: B }] })),
    parsed('m1', A, 1003, buildGameOp(CH, id, 'move', { n: 0, seat: A, action: { cell: 0 } })),
    parsed('r1', A, 1004, buildGameOp(CH, id, 'resign', { seat: A })),
  ], 2000)!;
}

describe('GameResults', () => {
  it('names the winner and lists everyone', () => {
    const session = finishedChainReaction();
    render(<GameResults session={session} seatLabel={label} myPubkey={A} />);
    expect(screen.getByTestId('game-results')).toHaveTextContent('Bruno won');
    expect(screen.getByTestId(`result-row-${A}`)).toBeInTheDocument();
    expect(screen.getByTestId(`result-row-${B}`)).toBeInTheDocument();
  });

  it('marks which seat belongs to the person looking', () => {
    const session = finishedChainReaction();
    render(<GameResults session={session} seatLabel={label} myPubkey={A} />);
    expect(screen.getByTestId(`result-row-${A}`)).toHaveTextContent('(you)');
    expect(screen.getByTestId(`result-row-${B}`)).not.toHaveTextContent('(you)');
  });

  it('shows a spectator the same standings, with nothing marked as theirs', () => {
    const session = finishedChainReaction();
    render(<GameResults session={session} seatLabel={label} myPubkey="pk-nobody" />);
    expect(screen.getByTestId('game-results')).toHaveTextContent('Bruno won');
    expect(screen.queryByText('(you)')).not.toBeInTheDocument();
  });

  it('scores Chain Reaction by orbs held, and marks the eliminated', () => {
    const session = finishedChainReaction();
    render(<GameResults session={session} seatLabel={label} myPubkey={A} />);
    expect(screen.getByTestId(`result-score-${A}`)).toHaveTextContent('out');
    expect(screen.getByTestId(`result-score-${B}`)).toHaveTextContent(/orbs/);
  });

  it('scores Vesta by victory points', () => {
    const base = finishedChainReaction();
    const state = createGame({ players: 2, roll: 3 });
    const session: GameSession = {
      ...base,
      game: 'vesta',
      state: { ...state, players: state.players.map((p, i) => ({ ...p, vp: i === 1 ? 10 : 4 })), winner: 1 },
      winner: B,
      match: null,
    };
    render(<GameResults session={session} seatLabel={label} myPubkey={A} />);
    expect(screen.getByTestId(`result-score-${B}`)).toHaveTextContent('10 VP');
    expect(screen.getByTestId(`result-score-${A}`)).toHaveTextContent('4 VP');
    // Highest score first.
    const rows = screen.getAllByTestId(/^result-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', `result-row-${B}`);
  });

  it('scores Stacker by garbage sent and lines cleared', () => {
    const base = finishedChainReaction();
    let match = applyMatchEvent(
      { seed: 1, seats: [A, B], progress: {
          [A]: { seat: A, alive: true, attacksSent: 0, linesCleared: 0, stackHeight: 0, frame: 0, board: null, verified: null, suspect: null },
          [B]: { seat: B, alive: true, attacksSent: 0, linesCleared: 0, stackHeight: 0, frame: 0, board: null, verified: null, suspect: null },
        }, attacks: [], alive: [A, B], winner: null, over: false },
      { op: 'checkpoint', seat: B, frame: 600, attacksSent: 21, linesCleared: 40, stackHeight: 5, board: undefined, at: 10 },
    );
    match = applyMatchEvent(match, { op: 'topout', seat: A, at: 20 });

    const session: GameSession = { ...base, game: 'stacker', state: null, match, winner: B };
    render(<GameResults session={session} seatLabel={label} myPubkey={A} />);
    expect(screen.getByTestId(`result-score-${B}`)).toHaveTextContent('21⚔');
    expect(screen.getByTestId(`result-score-${B}`)).toHaveTextContent('40▤');
  });

  it('says draw when nobody took it', () => {
    const base = finishedChainReaction();
    const session: GameSession = { ...base, winner: null, draw: true };
    render(<GameResults session={session} seatLabel={label} myPubkey={A} />);
    expect(screen.getByTestId('game-results')).toHaveTextContent('draw');
  });
});
