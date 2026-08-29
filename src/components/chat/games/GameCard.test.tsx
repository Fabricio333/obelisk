import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import GameCard from './GameCard';
import ChainReactionBoard from './ChainReactionBoard';
import MessageContent from '../MessageContent';
import { useGamesStore } from '@/store/games';
import { buildCreate, buildGameOp, gameMarker, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';
import { chainReaction } from '@/lib/games/chain-reaction';
import { deriveSession } from '@/lib/games/session';

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

const now = Math.floor(Date.now() / 1000);

function seedWaitingTable() {
  useGamesStore.getState().ingestMany([
    parsed(GAME_ID, HOST, now - 10, buildCreate(CH, { game: chainReaction.type, turnTimeoutS: 45 })),
  ]);
}

function startedLog() {
  return [
    parsed(GAME_ID, HOST, now - 10, buildCreate(CH, { game: chainReaction.type, opts: { size: 'small' }, turnTimeoutS: 45 })),
    parsed('j1', B, now - 9, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', HOST, now - 8, buildGameOp(CH, GAME_ID, 'start', { seats: [HOST, B] })),
  ];
}

describe('GameCard', () => {
  beforeEach(() => {
    useGamesStore.setState({ logs: {}, channelOf: {}, openGameId: null });
  });

  it('shows a skeleton until the table\'s create event arrives', () => {
    render(<GameCard gameId={GAME_ID} />);
    expect(screen.getByTestId('game-card-loading')).toBeInTheDocument();
  });

  it('renders an open table with its seat count', () => {
    seedWaitingTable();
    render(<GameCard gameId={GAME_ID} />);
    expect(screen.getByTestId('game-card')).toBeInTheDocument();
    expect(screen.getByText(/Open table · 1\/8/)).toBeInTheDocument();
  });

  it('reflects the live status of a table, not the status when the message was sent', () => {
    useGamesStore.getState().ingestMany(startedLog());
    render(<GameCard gameId={GAME_ID} />);
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('names the winner once the table is finished', () => {
    useGamesStore.getState().ingestMany([
      ...startedLog(),
      parsed('r1', HOST, now - 5, buildGameOp(CH, GAME_ID, 'resign')),
    ]);
    render(<GameCard gameId={GAME_ID} />);
    // The host resigned, so B took the board.
    expect(screen.getByText(/🏆 pk-b won/)).toBeInTheDocument();
    expect(screen.getByText('Result')).toBeInTheDocument();
  });

  it('opens the table when clicked', () => {
    seedWaitingTable();
    render(<GameCard gameId={GAME_ID} />);
    screen.getByTestId('game-card').click();
    expect(useGamesStore.getState().openGameId).toBe(GAME_ID);
  });
});

describe('MessageContent game markers', () => {
  beforeEach(() => {
    useGamesStore.setState({ logs: {}, channelOf: {}, openGameId: null });
    useGamesStore.getState().ingestMany(startedLog());
  });

  it('renders the marker as a card and strips it from the message body', () => {
    render(<MessageContent content={`Who is in? ${gameMarker(GAME_ID)}`} channelId={CH} />);
    expect(screen.getByTestId('game-card')).toBeInTheDocument();
    expect(screen.getByText('Who is in?')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(GAME_ID))).not.toBeInTheDocument();
  });

  it('renders one card per table even when a marker is repeated', () => {
    render(<MessageContent content={`${gameMarker(GAME_ID)} ${gameMarker(GAME_ID)}`} channelId={CH} />);
    expect(screen.getAllByTestId('game-card')).toHaveLength(1);
  });
});

describe('ChainReactionBoard', () => {
  it('plays whichever of several local seats is on move', async () => {
    // One account holding both seats: the board must follow the turn, not the key.
    const hotLog = [
      parsed(GAME_ID, HOST, now - 10, buildCreate(CH, { game: chainReaction.type, opts: { size: 'small' }, turnTimeoutS: 0 })),
      parsed('s1', HOST, now - 8, buildGameOp(CH, GAME_ID, 'start', {
        seats: [{ id: HOST, by: HOST, label: 'Ana' }, { id: `${HOST}#1`, by: HOST, label: 'Beto' }],
      })),
    ];
    const session = deriveSession(hotLog, now)!;
    const onAction = vi.fn().mockResolvedValue(undefined);
    const mySeats = [HOST, `${HOST}#1`];

    render(<ChainReactionBoard game={session} mySeats={mySeats} onAction={onAction} />);
    screen.getByLabelText('cell 0').click();
    expect(onAction).toHaveBeenCalledWith({ cell: 0 }, HOST);

    // After Ana's move the turn is Beto's — same keyboard, different seat.
    const afterLog = [
      ...hotLog,
      parsed('m1', HOST, now - 7, buildGameOp(CH, GAME_ID, 'move', { n: 0, seat: HOST, action: { cell: 0 } })),
    ];
    const next = deriveSession(afterLog, now)!;
    expect(next.currentTurn).toBe(`${HOST}#1`);

    onAction.mockClear();
    render(<ChainReactionBoard game={next} mySeats={mySeats} onAction={onAction} />);
    screen.getAllByLabelText('cell 5')[1].click();
    expect(onAction).toHaveBeenCalledWith({ cell: 5 }, `${HOST}#1`);
  });

  it('publishes the clicked cell only when it is your turn', async () => {
    const session = deriveSession(startedLog(), now)!;
    const onAction = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(<ChainReactionBoard game={session} mySeats={[B]} onAction={onAction} />);
    // B is not on move — every cell is disabled.
    screen.getByLabelText('cell 0').click();
    expect(onAction).not.toHaveBeenCalled();

    rerender(<ChainReactionBoard game={session} mySeats={[HOST]} onAction={onAction} />);
    screen.getByLabelText('cell 0').click();
    expect(onAction).toHaveBeenCalledWith({ cell: 0 }, HOST);
  });

  it('refuses a cell owned by an opponent', () => {
    const log = [
      ...startedLog(),
      parsed('m1', HOST, now - 7, buildGameOp(CH, GAME_ID, 'move', { n: 0, action: { cell: 0 } })),
    ];
    const session = deriveSession(log, now)!;
    const onAction = vi.fn().mockResolvedValue(undefined);

    render(<ChainReactionBoard game={session} mySeats={[B]} onAction={onAction} />);
    screen.getByLabelText('cell 0').click();
    expect(onAction).not.toHaveBeenCalled();

    screen.getByLabelText('cell 5').click();
    expect(onAction).toHaveBeenCalledWith({ cell: 5 }, B);
  });
});
