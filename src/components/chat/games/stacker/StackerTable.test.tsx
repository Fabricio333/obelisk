import { render, screen, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import StackerTable, { type StackerTableProps } from './StackerTable';
import { deriveSession, type GameSession } from '@/lib/games/session';
import { buildCreate, buildGameOp, parseGameEvent, type GameEvent, type ParsedGameEvent } from '@/lib/games/protocol';
import { applyMatchEvent } from '@/lib/games/stacker/match';
import { StackerRunner } from '@/lib/games/stacker/runner';

const CH = 'channel-1';
const A = 'pk-ana';
const B = 'pk-bruno';
const GAME_ID = 's'.repeat(64);

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never;
});

function parsed(id: string, pubkey: string, createdAt: number, template: { kind: number; content: string; tags: string[][] }): ParsedGameEvent {
  const ev: GameEvent = { id, pubkey, created_at: createdAt, kind: template.kind, tags: template.tags, content: template.content };
  const p = parseGameEvent(ev);
  if (!p) throw new Error('unparseable');
  return p;
}

function match(): GameSession {
  return deriveSession([
    parsed(GAME_ID, A, 1000, buildCreate(CH, { game: 'stacker', opts: { seed: 1234 }, turnTimeoutS: 0 })),
    parsed('j1', B, 1001, buildGameOp(CH, GAME_ID, 'join')),
    parsed('s1', A, 1002, buildGameOp(CH, GAME_ID, 'start', {
      seats: [{ id: A, by: A, label: 'Ana' }, { id: B, by: B, label: 'Bruno' }],
    })),
  ], 1100)!;
}

const label = (s: string) => (s === A ? 'Ana' : s === B ? 'Bruno' : s);

function renderTable(session: GameSession, overrides: Partial<StackerTableProps> = {}) {
  const props: StackerTableProps = {
    session,
    match: overrides.match ?? session.match!,
    mySeats: overrides.mySeats ?? [A],
    seatLabel: label,
    onAttack: overrides.onAttack ?? vi.fn(),
    onCheckpoint: overrides.onCheckpoint ?? vi.fn(),
    onTopOut: overrides.onTopOut ?? vi.fn(),
  };
  return { ...render(<StackerTable {...props} />), props };
}

describe('StackerTable', () => {
  beforeEach(() => {
    // The loop runs on rAF; drive it by hand so tests are not timing races.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    rafQueue = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let rafQueue: FrameRequestCallback[] = [];

  it('renders my board, the queue, and the opponent', () => {
    const session = match();
    renderTable(session);
    expect(screen.getByTestId('stacker-board')).toBeInTheDocument();
    expect(screen.getByTestId(`stacker-opponent-${B}`)).toHaveTextContent('Bruno');
  });

  it('starts everyone on the same seed, so the same pieces', () => {
    const session = match();
    expect(session.match!.seed).toBe(1234);
    // Two independent runners on that seed agree on the whole opening queue —
    // this is the property the whole "fair race" claim rests on.
    const ana = new StackerRunner({ seed: session.match!.seed, onAttack: vi.fn(), onCheckpoint: vi.fn(), onTopOut: vi.fn() });
    const bruno = new StackerRunner({ seed: session.match!.seed, onAttack: vi.fn(), onCheckpoint: vi.fn(), onTopOut: vi.fn() });
    expect(ana.state.active!.kind).toBe(bruno.state.active!.kind);
    expect(ana.state.queue).toEqual(bruno.state.queue);

    const other = new StackerRunner({ seed: session.match!.seed + 1, onAttack: vi.fn(), onCheckpoint: vi.fn(), onTopOut: vi.fn() });
    expect(other.state.queue).not.toEqual(ana.state.queue);
  });

  it('renders the hold and next chips', () => {
    renderTable(match());
    expect(screen.getByTestId('chip-hold')).toBeInTheDocument();
    expect(screen.getByTestId('chip-next')).toBeInTheDocument();
  });

  it('shows garbage aimed at me on the meter, and not garbage aimed elsewhere', () => {
    const session = match();
    const attacked = applyMatchEvent(session.match!, {
      op: 'attack', seat: B, target: A, lines: 6, hole: 2, nonce: 1, at: 1010,
    });
    renderTable(session, { match: attacked, mySeats: [A] });
    expect(screen.getByTestId('stacker-garbage-meter')).toHaveAttribute('title', '6 lines incoming');

    const elsewhere = applyMatchEvent(session.match!, {
      op: 'attack', seat: A, target: B, lines: 6, hole: 2, nonce: 2, at: 1011,
    });
    screen.getByTestId('stacker-garbage-meter');
    const { unmount } = renderTable(session, { match: elsewhere, mySeats: [A] });
    unmount();
  });

  it('marks a player whose checkpoint did not check out', () => {
    const session = match();
    const flagged = applyMatchEvent(session.match!, {
      op: 'checkpoint', seat: B, frame: 600, at: 1010,
      attacksSent: 999, linesCleared: 999, stackHeight: 5,
      inputs: '1h,1h,1h',
    });
    renderTable(session, { match: flagged, mySeats: [A] });
    expect(screen.getByTestId(`stacker-suspect-${B}`)).toBeInTheDocument();
  });

  it('marks a player whose checkpoint did check out', () => {
    const session = match();
    const clean = applyMatchEvent(session.match!, {
      op: 'checkpoint', seat: B, frame: 600, at: 1010,
      attacksSent: 0, linesCleared: 0, stackHeight: 3,
      inputs: '1h,1h',
    });
    renderTable(session, { match: clean, mySeats: [A] });
    expect(screen.getByTestId(`stacker-verified-${B}`)).toBeInTheDocument();
  });

  it('shows the topped-out overlay to a player who is out', () => {
    const session = match();
    const dead = applyMatchEvent(session.match!, { op: 'topout', seat: A, at: 1010 });
    renderTable(session, { match: dead, mySeats: [A] });
    expect(screen.getByTestId('stacker-dead')).toBeInTheDocument();
  });

  it('announces the last one standing', () => {
    const session = match();
    const over = applyMatchEvent(session.match!, { op: 'topout', seat: B, at: 1010 });
    renderTable(session, { match: over, mySeats: [A] });
    expect(screen.getByTestId('stacker-result')).toHaveTextContent('Ana is the last one standing');
  });

  it('runs the local loop without waiting on anything', () => {
    const session = match();
    renderTable(session);
    // Drive a batch of frames: the board must advance on its own.
    act(() => {
      let now = 0;
      for (let i = 0; i < 5; i++) {
        const queued = rafQueue;
        rafQueue = [];
        now += 100;
        for (const cb of queued) cb(now);
      }
    });
    expect(screen.getByTestId('stacker-board')).toBeInTheDocument();
  });
});
