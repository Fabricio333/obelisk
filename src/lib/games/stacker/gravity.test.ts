import { describe, it, expect } from 'vitest';
import { GRAVITY_BY_LEVEL, LINES_PER_LEVEL, gravityFramesFor, levelFor } from './runner';

describe('the game gets faster over lines', () => {
  it('counts ten lines to a level', () => {
    expect(levelFor(0)).toBe(0);
    expect(levelFor(9)).toBe(0);
    expect(levelFor(10)).toBe(1);
    expect(levelFor(95)).toBe(9);
    expect(LINES_PER_LEVEL).toBe(10);
  });

  it('never gets slower as the lines pile up', () => {
    let previous = Infinity;
    for (let lines = 0; lines < 400; lines += 10) {
      const frames = gravityFramesFor(lines);
      expect(frames).toBeLessThanOrEqual(previous);
      previous = frames;
    }
  });

  it('is noticeably faster by the time you have played a while', () => {
    // Ten lines in, and a hundred lines in, should not feel the same.
    expect(gravityFramesFor(100)).toBeLessThan(gravityFramesFor(10) / 2);
  });

  it('keeps a floor so it stays humanly playable', () => {
    expect(gravityFramesFor(10_000)).toBeGreaterThanOrEqual(1);
    expect(Math.min(...GRAVITY_BY_LEVEL)).toBeGreaterThanOrEqual(1);
  });

  it('holds the fastest level once the table runs out', () => {
    const last = GRAVITY_BY_LEVEL[GRAVITY_BY_LEVEL.length - 1];
    expect(gravityFramesFor(GRAVITY_BY_LEVEL.length * 10)).toBe(last);
    expect(gravityFramesFor(99_999)).toBe(last);
  });
});
