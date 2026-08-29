import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StackerRunner, DAS_FRAMES } from './runner';
import { canFall, TOTAL_HEIGHT, WIDTH } from './engine';

const canStillFall = (runner: StackerRunner) => canFall(runner.state);

/**
 * These are the tests that guard the *feel*, not the rules. The engine's own
 * suite covers what a piece does; this covers whether the thing that runs it
 * stays out of its own way.
 */

function makeRunner(overrides: Partial<ConstructorParameters<typeof StackerRunner>[0]> = {}) {
  const onAttack = vi.fn();
  const onCheckpoint = vi.fn();
  const onTopOut = vi.fn();
  const onEvent = vi.fn();
  const runner = new StackerRunner({ seed: 4242, onAttack, onCheckpoint, onTopOut, onEvent, ...overrides });
  return { runner, onAttack, onCheckpoint, onTopOut, onEvent };
}

/** Drive frames without a real clock. */
function advance(frames: number) {
  vi.advanceTimersByTime(Math.ceil(frames * (1000 / 60)));
}

describe('StackerRunner', () => {
  let rafCallbacks: FrameRequestCallback[] = [];
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    rafCallbacks = [];
    now = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Run the queued rAF callbacks, advancing the clock by `ms` each pass. */
  function pump(passes: number, ms = 100) {
    for (let i = 0; i < passes; i++) {
      const queued = rafCallbacks;
      rafCallbacks = [];
      now += ms;
      for (const cb of queued) cb(now);
    }
  }

  it('does not publish anything from inside a frame', () => {
    const { runner, onAttack, onCheckpoint } = makeRunner();
    runner.start();
    pump(20);
    // Frames have run, but the outbound timer has not fired yet.
    expect(onAttack).not.toHaveBeenCalled();
    expect(onCheckpoint).not.toHaveBeenCalled();
    runner.stop();
  });

  it('coalesces several clears into one attack event', () => {
    const { runner, onAttack } = makeRunner();
    runner.start();

    // Two separate clears' worth of attack queued between flushes.
    (runner as unknown as { pendingAttack: number }).pendingAttack = 4;
    (runner as unknown as { pendingAttack: number }).pendingAttack += 2;
    advance(0);
    vi.advanceTimersByTime(300); // past the flush interval

    expect(onAttack).toHaveBeenCalledTimes(1);
    expect(onAttack.mock.calls[0][0]).toBe(6);
    runner.stop();
  });

  it('flushes whatever is queued when it stops, rather than dropping it', () => {
    const { runner, onAttack } = makeRunner();
    runner.start();
    (runner as unknown as { pendingAttack: number }).pendingAttack = 3;
    runner.stop();
    expect(onAttack).toHaveBeenCalledWith(3, expect.any(Number), expect.any(Number));
  });

  it('pushes frames to canvas subscribers and stats to React subscribers separately', () => {
    const { runner } = makeRunner();
    const frames = vi.fn();
    const stats = vi.fn();
    runner.onFrame(frames);
    runner.onStats(stats);
    frames.mockClear();
    stats.mockClear();

    runner.start();
    pump(10);

    // Frames flow freely; stats are throttled to their own timer.
    expect(frames).toHaveBeenCalled();
    expect(stats).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(stats).toHaveBeenCalled();
    runner.stop();
  });

  it('paints immediately on a keypress instead of waiting for the next tick', () => {
    const { runner } = makeRunner();
    const frames = vi.fn();
    runner.onFrame(frames);
    frames.mockClear();

    runner.press('left');
    expect(frames).toHaveBeenCalledTimes(1);
  });

  it('repeats a held key only after the delay, then at the repeat rate', () => {
    const { runner } = makeRunner();
    runner.start();
    const startX = runner.state.active!.x;

    runner.press('left');
    expect(runner.state.active!.x).toBe(startX - 1); // the tap moves at once

    // Well inside DAS: no repeat yet.
    pump(1, (DAS_FRAMES - 4) * (1000 / 60));
    expect(runner.state.active!.x).toBe(startX - 1);

    // Past DAS: it starts sliding.
    pump(4, 100);
    expect(runner.state.active!.x).toBeLessThan(startX - 1);
    runner.stop();
  });

  it('gives a landed piece its lock delay before cementing', () => {
    const { runner, onEvent } = makeRunner();
    runner.start();

    // Soft-drop the piece onto the floor without locking it. `press` only
    // fires once per key, so go through the runner's own input path directly.
    for (let i = 0; i < TOTAL_HEIGHT + 4 && canStillFall(runner); i++) {
      runner.press('soft');
      runner.release('soft');
    }
    const kindBefore = runner.state.active?.kind;
    expect(kindBefore).toBeDefined();

    // A handful of frames on the floor: still the same piece. The loop caps
    // catch-up at eight frames a pass, so time moves in small passes.
    pump(2, 60);
    expect(runner.state.active?.kind).toBe(kindBefore);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'lock' }));

    // Past the delay it cements and the next piece arrives.
    pump(8, 100);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lock' }));
    runner.stop();
  });

  it('reports a top-out exactly once', () => {
    const { runner, onTopOut } = makeRunner();
    // Fill the well, leaving one column so nothing clears.
    for (let y = 2; y < TOTAL_HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) runner.state.board[y][x] = x === 9 ? 0 : 1;
    }
    runner.start();
    runner.press('hard');
    pump(6);
    expect(runner.state.dead).toBe(true);
    expect(onTopOut).toHaveBeenCalledTimes(1);
    pump(6);
    expect(onTopOut).toHaveBeenCalledTimes(1);
    runner.stop();
  });

  it('applies each incoming attack once, however often it is handed over', () => {
    const { runner, onEvent } = makeRunner();
    const attack = { from: 'pk-b', to: 'pk-a', lines: 3, hole: 2, nonce: 7, at: 100 };
    runner.receive([attack]);
    runner.receive([attack]);
    runner.receive([attack]);
    expect(runner.state.incoming.reduce((n, g) => n + g.lines, 0)).toBe(3);
    expect(onEvent).toHaveBeenCalledWith({ kind: 'garbage', lines: 3 });
  });

  it('ignores input once the board is dead', () => {
    const { runner } = makeRunner();
    runner.state.dead = true;
    const before = JSON.stringify(runner.state.board);
    runner.press('hard');
    runner.press('left');
    expect(JSON.stringify(runner.state.board)).toBe(before);
  });

  it('reports the numbers a player actually reads', () => {
    const { runner } = makeRunner();
    runner.receive([{ from: 'x', to: 'y', lines: 4, hole: 1, nonce: 1, at: 1 }]);
    const stats = runner.stats();
    expect(stats.incoming).toBe(4);
    expect(stats.dead).toBe(false);
    expect(stats.linesCleared).toBe(0);
  });
});
