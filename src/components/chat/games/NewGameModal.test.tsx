import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import NewGameModal from './NewGameModal';
import GameCard from './GameCard';
import { useGamesStore } from '@/store/games';
import { buildCreate, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';

const publishCreate = vi.hoisted(() => vi.fn());
const publishStart = vi.hoisted(() => vi.fn());
vi.mock('@/lib/games/transport', () => ({ publishCreate, publishStart }));
vi.mock('@/lib/nostr-bridge', () => ({ useMyPubkey: () => 'pk-host', useGroupMemberInfo: () => [] }));

const CH = 'channel-1';
const HOST = 'pk-host';

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

describe('NewGameModal', () => {
  beforeEach(() => {
    publishCreate.mockReset();
    publishStart.mockReset();
    publishCreate.mockResolvedValue('a'.repeat(64));
    publishStart.mockResolvedValue(undefined);
    useGamesStore.setState({ logs: {}, channelOf: {}, openGameId: null });
  });

  const open = () => render(
    <NewGameModal channelId={CH} onClose={vi.fn()} onPostMarker={vi.fn()} />,
  );

  it('lists every registered game with its own thumbnail', () => {
    open();
    expect(screen.getByTestId('pick-chain-reaction')).toBeInTheDocument();
    expect(screen.getByTestId('pick-vesta')).toBeInTheDocument();
    expect(screen.getByLabelText('Chain Reaction preview')).toBeInTheDocument();
    expect(screen.getByLabelText('Vesta preview')).toBeInTheDocument();
  });

  it('shows each game\'s own player range and default clock', () => {
    open();
    expect(screen.getByTestId('pick-chain-reaction')).toHaveTextContent('2–8 players · 45s turns');
    expect(screen.getByTestId('pick-vesta')).toHaveTextContent('2–4 players · no turn clock');
  });

  it('creates a VESTA table when Vesta is picked', async () => {
    open();
    fireEvent.click(screen.getByTestId('pick-vesta'));
    expect(screen.getByTestId('config-title')).toHaveTextContent('Vesta');

    fireEvent.click(screen.getByTestId('game-create'));
    await waitFor(() => expect(publishCreate).toHaveBeenCalled());

    const [channelId, params] = publishCreate.mock.calls[0];
    expect(channelId).toBe(CH);
    expect(params.game).toBe('vesta');
    expect(params.opts).toHaveProperty('seed');
  });

  it('creates a Chain Reaction table when Chain Reaction is picked', async () => {
    open();
    fireEvent.click(screen.getByTestId('pick-chain-reaction'));
    fireEvent.click(screen.getByTestId('game-size-large'));
    fireEvent.click(screen.getByTestId('game-create'));
    await waitFor(() => expect(publishCreate).toHaveBeenCalled());

    const [, params] = publishCreate.mock.calls[0];
    expect(params.game).toBe('chain-reaction');
    expect(params.opts).toEqual({ size: 'large' });
  });

  it('goes back to the list and can then create the other game', async () => {
    open();
    fireEvent.click(screen.getByTestId('pick-vesta'));
    fireEvent.click(screen.getByTestId('game-back'));
    fireEvent.click(screen.getByTestId('pick-chain-reaction'));
    fireEvent.click(screen.getByTestId('game-create'));
    await waitFor(() => expect(publishCreate).toHaveBeenCalled());
    expect(publishCreate.mock.calls[0][1].game).toBe('chain-reaction');
  });

  it('offers each game only its own options', () => {
    open();
    fireEvent.click(screen.getByTestId('pick-vesta'));
    expect(screen.getByTestId('vesta-seed')).toBeInTheDocument();
    expect(screen.queryByTestId('game-size-large')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('game-back'));
    fireEvent.click(screen.getByTestId('pick-chain-reaction'));
    expect(screen.getByTestId('game-size-large')).toBeInTheDocument();
    expect(screen.queryByTestId('vesta-seed')).not.toBeInTheDocument();
  });

  it('takes each game\'s default clock when it is picked', async () => {
    open();
    fireEvent.click(screen.getByTestId('pick-chain-reaction'));
    fireEvent.click(screen.getByTestId('game-create'));
    await waitFor(() => expect(publishCreate).toHaveBeenCalled());
    expect(publishCreate.mock.calls[0][1].turnTimeoutS).toBe(45);
  });

  describe('playing on one machine', () => {
    it('defaults to a table other people join, and starts nothing', async () => {
      open();
      fireEvent.click(screen.getByTestId('pick-chain-reaction'));
      fireEvent.click(screen.getByTestId('game-create'));
      await waitFor(() => expect(publishCreate).toHaveBeenCalled());
      expect(publishStart).not.toHaveBeenCalled();
    });

    it('seats every local player on this account and starts immediately', async () => {
      open();
      fireEvent.click(screen.getByTestId('pick-chain-reaction'));
      fireEvent.click(screen.getByTestId('players-local-3'));
      fireEvent.click(screen.getByTestId('game-create'));
      await waitFor(() => expect(publishStart).toHaveBeenCalled());

      const [channelId, gameId, seats] = publishStart.mock.calls[0];
      expect(channelId).toBe(CH);
      expect(gameId).toBe('a'.repeat(64));
      expect(seats).toHaveLength(3);
      // Separate players, one signature.
      expect(seats.map((s: { id: string }) => s.id)).toEqual([HOST, `${HOST}#1`, `${HOST}#2`]);
      expect(seats.every((s: { by: string }) => s.by === HOST)).toBe(true);
    });

    it('offers only the seat counts the game allows', () => {
      open();
      fireEvent.click(screen.getByTestId('pick-vesta'));
      expect(screen.getByTestId('players-local-2')).toBeInTheDocument();
      expect(screen.getByTestId('players-local-4')).toBeInTheDocument();
      // Vesta tops out at four.
      expect(screen.queryByTestId('players-local-5')).not.toBeInTheDocument();
      // Chain Reaction goes to eight.
      fireEvent.click(screen.getByTestId('game-back'));
      fireEvent.click(screen.getByTestId('pick-chain-reaction'));
      expect(screen.getByTestId('players-local-8')).toBeInTheDocument();
    });

    it('forgets the local choice when a different game is picked', async () => {
      open();
      fireEvent.click(screen.getByTestId('pick-chain-reaction'));
      fireEvent.click(screen.getByTestId('players-local-4'));
      fireEvent.click(screen.getByTestId('game-back'));
      fireEvent.click(screen.getByTestId('pick-vesta'));
      fireEvent.click(screen.getByTestId('game-create'));
      await waitFor(() => expect(publishCreate).toHaveBeenCalled());
      expect(publishStart).not.toHaveBeenCalled();
    });

    it('still posts the card so the channel can watch', async () => {
      const onPostMarker = vi.fn();
      render(<NewGameModal channelId={CH} onClose={vi.fn()} onPostMarker={onPostMarker} />);
      fireEvent.click(screen.getByTestId('pick-chain-reaction'));
      fireEvent.click(screen.getByTestId('players-local-2'));
      fireEvent.click(screen.getByTestId('game-create'));
      await waitFor(() => expect(onPostMarker).toHaveBeenCalled());
    });
  });

  it('posts the marker for the table it just created', async () => {
    const onPostMarker = vi.fn();
    render(<NewGameModal channelId={CH} onClose={vi.fn()} onPostMarker={onPostMarker} />);
    fireEvent.click(screen.getByTestId('pick-vesta'));
    fireEvent.click(screen.getByTestId('game-create'));
    await waitFor(() => expect(onPostMarker).toHaveBeenCalledWith(`[[game:${'a'.repeat(64)}]]`));
  });
});

describe('a table is labelled with its own game', () => {
  beforeEach(() => {
    useGamesStore.setState({ logs: {}, channelOf: {}, openGameId: null });
  });

  it('calls a Vesta table Vesta, not Chain Reaction', () => {
    const id = 'v'.repeat(64);
    useGamesStore.getState().ingest(
      parsed(id, HOST, Math.floor(Date.now() / 1000) - 5, buildCreate(CH, { game: 'vesta', opts: { seed: 1 }, turnTimeoutS: 0 })),
    );
    render(<GameCard gameId={id} />);
    expect(screen.getByTestId('game-card-name')).toHaveTextContent('Vesta');
    expect(screen.getByTestId('game-card-name')).not.toHaveTextContent('Chain Reaction');
  });

  it('still calls a Chain Reaction table Chain Reaction', () => {
    const id = 'c'.repeat(64);
    useGamesStore.getState().ingest(
      parsed(id, HOST, Math.floor(Date.now() / 1000) - 5, buildCreate(CH, { game: 'chain-reaction', turnTimeoutS: 45 })),
    );
    render(<GameCard gameId={id} />);
    expect(screen.getByTestId('game-card-name')).toHaveTextContent('Chain Reaction');
  });
});
