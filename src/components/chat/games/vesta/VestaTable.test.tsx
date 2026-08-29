import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { createGame, applyMove, type GameState } from 'vesta';
import VestaTable from './VestaTable';
import StartTableModal from '../StartTableModal';
import { deriveSession, type GameSession } from '@/lib/games/session';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';
import { vertices, edges, nearestVertex } from '@/lib/games/vesta/geometry';

const CH = 'channel-1';
const HOST = 'pk-host';
const B = 'pk-b';
const GAME_ID = 'v'.repeat(64);

beforeAll(() => {
  // jsdom has no canvas backend; the board's draw pass is not what these
  // tests are about, so a no-op context keeps it quiet.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

function table(seats: Array<{ id: string; by: string; label?: string }>): GameSession {
  const log = [
    parsed(GAME_ID, HOST, 1000, buildCreate(CH, { game: 'vesta', opts: { seed: 42 }, turnTimeoutS: 0 })),
    parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', HOST, 1002, buildGameOp(CH, GAME_ID, 'start', { seats })),
  ];
  return deriveSession(log, 1100)!;
}

const remoteSeats = [{ id: HOST, by: HOST, label: 'Ana' }, { id: B, by: B, label: 'Bruno' }];

describe('VestaTable', () => {
  const label = (seat: string) => (seat === HOST ? 'Ana' : seat === B ? 'Bruno' : seat);

  it('renders the board and every player', () => {
    const session = table(remoteSeats);
    render(
      <VestaTable
        session={session}
        state={session.state as GameState}
        mySeats={[HOST]}
        seatLabel={label}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByTestId('vesta-board')).toBeInTheDocument();
    expect(screen.getByTestId('vesta-player-0')).toHaveTextContent('Ana');
    expect(screen.getByTestId('vesta-player-1')).toHaveTextContent('Bruno');
  });

  it('shows the setup prompt to the player on move and a wait to the other', () => {
    const session = table(remoteSeats);
    const { rerender } = render(
      <VestaTable session={session} state={session.state as GameState} mySeats={[HOST]} seatLabel={label} onAction={vi.fn()} />,
    );
    expect(screen.getByText(/Setup — Ana places a settlement/)).toBeInTheDocument();

    rerender(
      <VestaTable session={session} state={session.state as GameState} mySeats={[B]} seatLabel={label} onAction={vi.fn()} />,
    );
    expect(screen.getByText(/Waiting for Ana/)).toBeInTheDocument();
  });

  it('hides turn actions during setup and shows them in play', () => {
    const session = table(remoteSeats);
    const { rerender } = render(
      <VestaTable session={session} state={session.state as GameState} mySeats={[HOST]} seatLabel={label} onAction={vi.fn()} />,
    );
    expect(screen.queryByTestId('vesta-actions')).not.toBeInTheDocument();

    const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false };
    rerender(<VestaTable session={session} state={playing} mySeats={[HOST]} seatLabel={label} onAction={vi.fn()} />);
    expect(screen.getByTestId('vesta-actions')).toBeInTheDocument();
    expect(screen.getByText('🎲 Roll')).toBeEnabled();
    // Can't end a turn before rolling — the engine says so, so the button says so.
    expect(screen.getByText('↪ End turn')).toBeDisabled();
  });

  it('publishes a roll for the acting seat', async () => {
    const session = table(remoteSeats);
    const onAction = vi.fn().mockResolvedValue(undefined);
    const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false };
    render(<VestaTable session={session} state={playing} mySeats={[HOST]} seatLabel={label} onAction={onAction} />);

    fireEvent.click(screen.getByText('🎲 Roll'));
    expect(onAction).toHaveBeenCalledWith({ type: 'roll-dice' }, HOST);
  });

  it('offers no actions to a player whose turn it is not', () => {
    const session = table(remoteSeats);
    const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false };
    render(<VestaTable session={session} state={playing} mySeats={[B]} seatLabel={label} onAction={vi.fn()} />);
    expect(screen.queryByTestId('vesta-actions')).not.toBeInTheDocument();
  });

  it('asks over-full hands to discard on a seven', () => {
    const session = table(remoteSeats);
    const base = session.state as GameState;
    const fat = {
      ...base,
      phase: 'play' as const,
      dice: [3, 4] as [number, number],
      players: base.players.map((p, i) => i === 1
        ? { ...p, resources: { ...p.resources, brick: 5, ore: 5 } }
        : p),
    };
    // B is not on move, but a seven does not care whose turn it is.
    render(<VestaTable session={session} state={fat} mySeats={[B]} seatLabel={label} onAction={vi.fn()} />);
    expect(screen.getByTestId('vesta-discard')).toHaveTextContent('discard 5 of your 10 cards');
  });

  it('shows a trade offer to its target with accept and reject', () => {
    const session = table(remoteSeats);
    const base = session.state as GameState;
    const offered = {
      ...base,
      pendingTrade: { from: 0, to: 1, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, take: { ore: 1, brick: 0, lumber: 0, wool: 0, grain: 0 } },
    } as GameState;

    const onAction = vi.fn().mockResolvedValue(undefined);
    render(<VestaTable session={session} state={offered} mySeats={[B]} seatLabel={label} onAction={onAction} />);
    expect(screen.getByTestId('vesta-trade-offer')).toHaveTextContent('Ana offers 1🧱 for 1🪨');
    fireEvent.click(screen.getByText('Accept'));
    expect(onAction).toHaveBeenCalledWith({ type: 'accept-trade' }, B);
  });

  it('offers the proposer a withdraw instead of an accept', () => {
    const session = table(remoteSeats);
    const base = session.state as GameState;
    const offered = {
      ...base,
      pendingTrade: { from: 0, to: 1, give: { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 }, take: { ore: 1, brick: 0, lumber: 0, wool: 0, grain: 0 } },
    } as GameState;
    render(<VestaTable session={session} state={offered} mySeats={[HOST]} seatLabel={label} onAction={vi.fn()} />);
    expect(screen.getByText('Withdraw')).toBeInTheDocument();
    expect(screen.queryByText('Accept')).not.toBeInTheDocument();
  });

  describe('hot-seat', () => {
    const hotSeats = [
      { id: HOST, by: HOST, label: 'Ana' },
      { id: `${HOST}#1`, by: HOST, label: 'Beto' },
      { id: B, by: B, label: 'Bruno' },
    ];

    it('acts as whichever of its own seats is on move', () => {
      const session = table(hotSeats);
      const onAction = vi.fn().mockResolvedValue(undefined);
      const playing = { ...(session.state as GameState), phase: 'play' as const, rolled: false, currentPlayer: 1 };
      // The session's turn is seat 0; hand it a state where seat 1 is on move
      // by deriving a session whose currentTurn matches.
      const withTurn: GameSession = { ...session, currentTurn: `${HOST}#1` };
      render(<VestaTable session={withTurn} state={playing} mySeats={[HOST, `${HOST}#1`]} seatLabel={(s) => hotSeats.find((h) => h.id === s)?.label ?? s} onAction={onAction} />);

      fireEvent.click(screen.getByText('🎲 Roll'));
      // Signed by the host's key, but played as Beto's seat.
      expect(onAction).toHaveBeenCalledWith({ type: 'roll-dice' }, `${HOST}#1`);
    });

    it('names both local players separately on the board', () => {
      const session = table(hotSeats);
      render(
        <VestaTable
          session={session}
          state={session.state as GameState}
          mySeats={[HOST, `${HOST}#1`]}
          seatLabel={(s) => hotSeats.find((h) => h.id === s)?.label ?? s}
          onAction={vi.fn()}
        />,
      );
      expect(screen.getByTestId('vesta-player-0')).toHaveTextContent('Ana');
      expect(screen.getByTestId('vesta-player-1')).toHaveTextContent('Beto');
      expect(screen.getByTestId('vesta-player-2')).toHaveTextContent('Bruno');
    });
  });

  it('announces the winner', () => {
    const session = table(remoteSeats);
    const won = { ...(session.state as GameState), winner: 1 };
    render(<VestaTable session={session} state={won} mySeats={[HOST]} seatLabel={label} onAction={vi.fn()} />);
    expect(screen.getByText('Bruno wins')).toBeInTheDocument();
  });
});

describe('board geometry', () => {
  it('builds the standard 54 vertices and 72 edges', () => {
    expect(vertices().size).toBe(54);
    expect(edges().size).toBe(72);
  });

  it('finds the vertex nearest a click, and nothing when the click is far', () => {
    const first = [...vertices().values()][0];
    expect(nearestVertex(first.x + 2, first.y + 2, 20)?.key).toBe(first.key);
    expect(nearestVertex(first.x + 500, first.y + 500, 20)).toBeNull();
  });

  it('agrees with the engine about vertex keys', () => {
    // Every settlement the engine places must land on a vertex we can draw.
    const state = applyMove(createGame({ players: 2, roll: 42 }), {
      type: 'place-settlement', player: 0, q: 0, r: 0, corner: 0,
    });
    const s = state.players[0].settlements[0];
    const positions = [...vertices().values()].filter((v) =>
      v.hexes.some((h) => h.q === s.q && h.r === s.r && h.corner === s.corner));
    expect(positions).toHaveLength(1);
  });
});

describe('StartTableModal', () => {
  const session = table(remoteSeats);
  const waiting: GameSession = { ...session, status: 'waiting', joined: [HOST, B], seats: [], participants: [] };
  const nameOf = (pk: string) => (pk === HOST ? 'Ana' : 'Bruno');

  it('gives every joined account a seat of its own, played remotely', () => {
    render(<StartTableModal session={waiting} nameOf={nameOf} onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByTestId('seat-mode-0')).toHaveTextContent('remote');
    expect(screen.getByTestId('seat-mode-1')).toHaveTextContent('remote');
  });

  it('turns two seats on one account into a shared machine', () => {
    render(<StartTableModal session={waiting} nameOf={nameOf} onClose={vi.fn()} onStart={vi.fn()} />);
    // Hand Bruno's seat to Ana: now Ana holds two, so both are hot-seat.
    fireEvent.click(screen.getByTestId(`seat-1-by-${HOST}`));
    expect(screen.getByTestId('seat-mode-0')).toHaveTextContent("on Ana's machine");
    expect(screen.getByTestId('seat-mode-1')).toHaveTextContent("on Ana's machine");
  });

  it('publishes seat ids that encode who signs for each', () => {
    const onStart = vi.fn();
    render(<StartTableModal session={waiting} nameOf={nameOf} onClose={vi.fn()} onStart={onStart} />);
    fireEvent.click(screen.getByTestId('add-seat'));
    fireEvent.click(screen.getByTestId('confirm-start'));

    const seats = onStart.mock.calls[0][0];
    expect(seats).toHaveLength(3);
    expect(seats[0]).toMatchObject({ id: HOST, by: HOST });
    expect(seats[1]).toMatchObject({ id: B, by: B });
    // The extra seat defaults to the host and becomes their second seat.
    expect(seats[2]).toMatchObject({ id: `${HOST}#1`, by: HOST });
  });

  it('reorders seats, because seat order is turn order', () => {
    const onStart = vi.fn();
    render(<StartTableModal session={waiting} nameOf={nameOf} onClose={vi.fn()} onStart={onStart} />);
    fireEvent.click(screen.getAllByLabelText('Move down')[0]);
    fireEvent.click(screen.getByTestId('confirm-start'));
    expect(onStart.mock.calls[0][0][0]).toMatchObject({ id: B });
  });

  it('carries the seat names people typed', () => {
    const onStart = vi.fn();
    render(<StartTableModal session={waiting} nameOf={nameOf} onClose={vi.fn()} onStart={onStart} />);
    fireEvent.change(screen.getByLabelText('Seat 1 name'), { target: { value: 'La jefa' } });
    fireEvent.click(screen.getByTestId('confirm-start'));
    expect(onStart.mock.calls[0][0][0].label).toBe('La jefa');
  });

  it('will not start below the minimum', () => {
    const alone: GameSession = { ...waiting, joined: [HOST] };
    render(<StartTableModal session={alone} nameOf={nameOf} onClose={vi.fn()} onStart={vi.fn()} />);
    expect(screen.getByTestId('confirm-start')).toBeDisabled();
    expect(screen.getByText(/needs more players/)).toBeInTheDocument();
  });

  describe('resuming a save', () => {
    /** A three-player saved game, as the create event would carry it. */
    const saved = (() => {
      const state = createGame({ players: 3, roll: 7 });
      return {
        ...state,
        players: state.players.map((p, i) => ({ ...p, name: ['Ana', 'Beto', 'Caro'][i] })),
      };
    })();

    const resuming: GameSession = {
      ...waiting,
      opts: { resume: { startState: saved, turns: [], endState: saved } },
    };

    it('shows one row per saved player, named as they were in the save', () => {
      render(<StartTableModal session={resuming} nameOf={nameOf} onClose={vi.fn()} onStart={vi.fn()} />);
      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(3);
      expect(screen.getByText(/Takes over “Ana”/)).toBeInTheDocument();
      expect(screen.getByText(/Takes over “Beto”/)).toBeInTheDocument();
      expect(screen.getByText(/Takes over “Caro”/)).toBeInTheDocument();
    });

    it('lets the host assign each saved player to an account', () => {
      const onStart = vi.fn();
      render(<StartTableModal session={resuming} nameOf={nameOf} onClose={vi.fn()} onStart={onStart} />);

      // Saved player 1 → Bruno (remote), players 2 and 3 → Ana's machine.
      fireEvent.click(screen.getByTestId(`seat-0-by-${B}`));
      fireEvent.click(screen.getByTestId(`seat-1-by-${HOST}`));
      fireEvent.click(screen.getByTestId(`seat-2-by-${HOST}`));
      fireEvent.click(screen.getByTestId('confirm-start'));

      const seats = onStart.mock.calls[0][0];
      expect(seats[0]).toMatchObject({ id: B, by: B, label: 'Ana' });
      expect(seats[1]).toMatchObject({ id: HOST, by: HOST, label: 'Beto' });
      expect(seats[2]).toMatchObject({ id: `${HOST}#1`, by: HOST, label: 'Caro' });
    });

    it('marks the shared seats and leaves the solo one remote', () => {
      render(<StartTableModal session={resuming} nameOf={nameOf} onClose={vi.fn()} onStart={vi.fn()} />);
      fireEvent.click(screen.getByTestId(`seat-0-by-${B}`));
      fireEvent.click(screen.getByTestId(`seat-1-by-${HOST}`));
      fireEvent.click(screen.getByTestId(`seat-2-by-${HOST}`));
      expect(screen.getByTestId('seat-mode-0')).toHaveTextContent('remote');
      expect(screen.getByTestId('seat-mode-1')).toHaveTextContent("on Ana's machine");
    });

    it('will not let the host change how many players the save had', () => {
      render(<StartTableModal session={resuming} nameOf={nameOf} onClose={vi.fn()} onStart={vi.fn()} />);
      expect(screen.queryByTestId('add-seat')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Remove seat')).not.toBeInTheDocument();
    });
  });
});
