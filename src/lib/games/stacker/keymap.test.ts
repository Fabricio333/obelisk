import { describe, it, expect, beforeEach } from 'vitest';
import {
  BINDABLE, bindKey, defaultKeyMap, keyLabel, keysFor, loadKeyMap,
  resetKeyMap, saveKeyMap, unbindKey,
} from './keymap';

describe('stacker key bindings', () => {
  beforeEach(() => localStorage.clear());

  it('starts from the defaults', () => {
    const map = loadKeyMap();
    expect(map.ArrowLeft).toBe('left');
    expect(map.Space).toBe('hard');
  });

  it('binds a key and keeps it across a reload', () => {
    const next = bindKey(defaultKeyMap(), 'KeyJ', 'left');
    saveKeyMap(next);
    expect(loadKeyMap().KeyJ).toBe('left');
  });

  it('lets one action keep several keys', () => {
    const map = bindKey(defaultKeyMap(), 'KeyJ', 'left');
    expect(keysFor(map, 'left')).toEqual(expect.arrayContaining(['ArrowLeft', 'KeyJ']));
  });

  it('reassigns a key away from whatever it did before', () => {
    const map = bindKey(defaultKeyMap(), 'ArrowLeft', 'hold');
    expect(map.ArrowLeft).toBe('hold');
    expect(keysFor(map, 'left')).not.toContain('ArrowLeft');
  });

  it('unbinds a single key', () => {
    const map = unbindKey(defaultKeyMap(), 'ArrowLeft');
    expect(map.ArrowLeft).toBeUndefined();
    expect(map.ArrowRight).toBe('right');
  });

  it('falls back to the defaults rather than trusting nonsense', () => {
    localStorage.setItem('obelisk-dex/stacker/keys', 'not json');
    expect(loadKeyMap().ArrowLeft).toBe('left');

    localStorage.setItem('obelisk-dex/stacker/keys', JSON.stringify({ KeyQ: 'launch-missiles' }));
    // An unknown action is dropped; dropping everything would leave the game
    // unplayable with no way back, so the defaults come through instead.
    expect(loadKeyMap().ArrowLeft).toBe('left');
  });

  it('resets back to the defaults', () => {
    saveKeyMap(bindKey(defaultKeyMap(), 'KeyJ', 'left'));
    expect(loadKeyMap().KeyJ).toBe('left');
    resetKeyMap();
    expect(loadKeyMap().KeyJ).toBeUndefined();
  });

  it('names keys the way a person would', () => {
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('KeyX')).toBe('X');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Digit3')).toBe('3');
  });

  it('offers every action a player needs', () => {
    const actions = BINDABLE.map((b) => b.action);
    for (const needed of ['left', 'right', 'soft', 'hard', 'cw', 'ccw', 'hold']) {
      expect(actions).toContain(needed);
    }
  });
});
