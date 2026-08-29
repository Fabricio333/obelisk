import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GameOverOverlay from './GameOverOverlay';
import { deriveSession, type GameSession } from '@/lib/games/session';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';
import { chainReaction } from '@/lib/games/chain-reaction';

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';
const GAME_ID = 'a'.repeat(64);

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

/** A finished table: host resigned at t=1010, so B took the board. */
function finishedSession(): GameSession {
  const log = [
    parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: chainReaction.type, opts: { size: 'small' }, turnTimeoutS: 45 })),
    parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', { seats: [HOST, B] })),
    parsed('r1', HOST, 1010, buildGameOp(CH, GAME_ID, 'resign')),
  ];
  return deriveSession(log, 1020)!;
}

function inProgressSession(): GameSession {
  const log = [
    parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 })),
    parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', { seats: [HOST, B] })),
  ];
  return deriveSession(log, 1020)!;
}

const props = {
  nameOf: (pk: string) => (pk === B ? 'Bruno' : 'Hostess'),
  pictureOf: () => null,
};

describe('GameOverOverlay', () => {
  it('stays out of the way while the game is running', () => {
    render(<GameOverOverlay session={inProgressSession()} myPubkey={B} onClose={vi.fn()} {...props} />);
    expect(screen.queryByTestId('game-over-overlay')).not.toBeInTheDocument();
  });

  it('shouts YOU WON at the winner', () => {
    render(<GameOverOverlay session={finishedSession()} myPubkey={B} onClose={vi.fn()} {...props} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('YOU WON');
    expect(screen.queryByTestId('game-over-winner')).not.toBeInTheDocument();
  });

  it('tells the loser they lost, and who took the board', () => {
    render(<GameOverOverlay session={finishedSession()} myPubkey={HOST} onClose={vi.fn()} {...props} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('YOU LOST');
    expect(screen.getByTestId('game-over-winner')).toHaveTextContent('Bruno took the board');
  });

  it('shows spectators a neutral result', () => {
    render(<GameOverOverlay session={finishedSession()} myPubkey="pk-nobody" onClose={vi.fn()} {...props} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('GAME OVER');
    expect(screen.getByTestId('game-over-winner')).toHaveTextContent('Bruno took the board');
  });

  it('colours the headline with the winner\'s seat', () => {
    render(<GameOverOverlay session={finishedSession()} myPubkey={B} onClose={vi.fn()} {...props} />);
    // Seat 1 is lc-green in SEAT_COLORS.
    expect(screen.getByTestId('game-over-headline')).toHaveStyle({ color: '#b4f953' });
  });

  it('dismisses on the close button and calls back', () => {
    const onClose = vi.fn();
    render(<GameOverOverlay session={finishedSession()} myPubkey={B} onClose={onClose} {...props} />);
    fireEvent.click(screen.getByTestId('game-over-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('game-over-overlay')).not.toBeInTheDocument();
  });

  it('dismisses when the backdrop itself is clicked', () => {
    const onClose = vi.fn();
    render(<GameOverOverlay session={finishedSession()} myPubkey={B} onClose={onClose} {...props} />);
    fireEvent.click(screen.getByTestId('game-over-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports a draw with no winner named', () => {
    const drawn: GameSession = { ...finishedSession(), winner: null, draw: true };
    render(<GameOverOverlay session={drawn} myPubkey={B} onClose={vi.fn()} {...props} />);
    expect(screen.getByTestId('game-over-headline')).toHaveTextContent('DRAW');
    expect(screen.getByText('Nobody took the board.')).toBeInTheDocument();
  });
});
