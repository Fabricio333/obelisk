import { describe, it, expect } from 'vitest';
import { isViewerRelativeLabel, seatDisplayLabel } from './seat-label';

describe('seat labels mean the same thing to everybody', () => {
  it('keeps a real name', () => {
    expect(seatDisplayLabel('Ana', 'fallback')).toBe('Ana');
    expect(seatDisplayLabel('Beto', 'fallback')).toBe('Beto');
  });

  it('rejects a label that means "whoever is looking"', () => {
    // The actual bug: the host's seat was published as "Vos", so every other
    // player saw somebody called that.
    expect(seatDisplayLabel('Vos', 'Ana')).toBe('Ana');
    expect(seatDisplayLabel('vos', 'Ana')).toBe('Ana');
    expect(seatDisplayLabel('You', 'Ana')).toBe('Ana');
    expect(seatDisplayLabel(' you ', 'Ana')).toBe('Ana');
  });

  it('falls back when there is no label at all', () => {
    expect(seatDisplayLabel(undefined, 'Ana')).toBe('Ana');
    expect(seatDisplayLabel(null, 'Ana')).toBe('Ana');
    expect(seatDisplayLabel('', 'Ana')).toBe('Ana');
  });

  it('identifies viewer-relative words without being trigger-happy', () => {
    expect(isViewerRelativeLabel('vos')).toBe(true);
    expect(isViewerRelativeLabel('YOU')).toBe(true);
    // Real names that merely contain one are still names.
    expect(isViewerRelativeLabel('Yousef')).toBe(false);
    expect(isViewerRelativeLabel('Vosloo')).toBe(false);
    expect(isViewerRelativeLabel('Ana')).toBe(false);
  });
});
