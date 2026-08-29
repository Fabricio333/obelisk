import { describe, it, expect } from 'vitest';
import { chainReaction, criticalMassAt, CR_SIZES } from './chain-reaction';

const CR_COLS = CR_SIZES.medium.cols;
const CR_ROWS = CR_SIZES.medium.rows;
const criticalMass = (i: number) => criticalMassAt(CR_ROWS, CR_COLS, i);

const A = 'pk-a';
const B = 'pk-b';
const C = 'pk-c';

function init(players: string[]) {
  return chainReaction.initialState(players);
}

describe('chain-reaction', () => {
  it('critical mass: corners=2, edges=3, interior=4', () => {
    expect(criticalMass(0)).toBe(2); // top-left corner
    expect(criticalMass(CR_COLS - 1)).toBe(2); // top-right
    expect(criticalMass((CR_ROWS - 1) * CR_COLS)).toBe(2); // bottom-left
    expect(criticalMass(CR_ROWS * CR_COLS - 1)).toBe(2); // bottom-right
    expect(criticalMass(1)).toBe(3); // top edge
    expect(criticalMass(CR_COLS)).toBe(3); // left edge
    expect(criticalMass(CR_COLS + 1)).toBe(4); // interior
  });

  it('places an orb on empty cell and passes turn', () => {
    const s0 = init([A, B]);
    const r = chainReaction.applyAction(s0, { cell: 0 }, A, [A, B]);
    expect(r.state.cells[0].count).toBe(1);
    expect(r.state.cells[0].owner).toBe(0);
    expect(r.nextTurn).toBe(B);
  });

  it('rejects placing on opponent cell', () => {
    let s = init([A, B]);
    s = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]).state;
    const v = chainReaction.validateAction(s, { cell: 0 }, B, [A, B]);
    expect(v.ok).toBe(false);
  });

  it('corner explodes at 2 orbs and converts neighbors', () => {
    let s = init([A, B]);
    // A plays corner 0, B plays somewhere far, A plays corner 0 again → explodes
    s = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]).state;
    s = chainReaction.applyAction(s, { cell: CR_COLS * CR_ROWS - 1 }, B, [A, B]).state;
    const r = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]);
    // Corner 0 should now be empty, neighbors (1 and CR_COLS) should belong to A with 1 orb
    expect(r.state.cells[0].count).toBe(0);
    expect(r.state.cells[0].owner).toBeNull();
    expect(r.state.cells[1].owner).toBe(0);
    expect(r.state.cells[1].count).toBe(1);
    expect(r.state.cells[CR_COLS].owner).toBe(0);
  });

  it('capture by explosion converts opponent orbs', () => {
    let s = init([A, B]);
    // A stacks corner 0 to 1 orb
    s = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]).state;
    // B plays at cell 1 (neighbor of corner 0)
    s = chainReaction.applyAction(s, { cell: 1 }, B, [A, B]).state;
    // A plays corner 0 again -> explodes, cell 1 should flip to A
    const r = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]);
    expect(r.state.cells[1].owner).toBe(0);
    expect(r.state.cells[1].count).toBe(2);
  });

  it('eliminates opponent with no orbs after everyone placed', () => {
    let s = init([A, B]);
    // A at 0, B at 1, A at 0 -> explodes, captures cell 1. B has no orbs left and has placed.
    s = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]).state;
    s = chainReaction.applyAction(s, { cell: 1 }, B, [A, B]).state;
    const r = chainReaction.applyAction(s, { cell: 0 }, A, [A, B]);
    expect(r.winner).toBe(A);
    expect(r.nextTurn).toBeNull();
  });

  it('does not eliminate players who have not placed yet', () => {
    const s0 = init([A, B, C]);
    const r = chainReaction.applyAction(s0, { cell: 0 }, A, [A, B, C]);
    // B and C haven't played — game must continue.
    expect(r.winner).toBeUndefined();
    expect(r.nextTurn).toBe(B);
  });

  it('timeout eliminates timed-out player and wipes their orbs', () => {
    let s = init([A, B, C]);
    s = chainReaction.applyAction(s, { cell: 0 }, A, [A, B, C]).state;
    s = chainReaction.applyAction(s, { cell: 10 }, B, [A, B, C]).state;
    const r = chainReaction.onTimeout(s, B, [A, B, C]);
    expect(r.eliminated).toEqual([B]);
    expect(r.state.cells[10].owner).toBeNull();
    expect(r.nextTurn).toBe(C);
  });

  it('rejects non-participant', () => {
    const s = init([A, B]);
    const v = chainReaction.validateAction(s, { cell: 0 }, 'pk-z', [A, B]);
    expect(v.ok).toBe(false);
  });
});
