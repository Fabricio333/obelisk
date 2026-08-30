/**
 * Key bindings, stored per browser.
 *
 * Everyone who plays these games has opinions about the controls, and the
 * defaults suit exactly nobody but their author. The map lives in
 * localStorage under the UI-state convention in CLAUDE.md — it is a device
 * preference, not account state, so it does not belong on the relay.
 */
import type { InputKind } from './engine';
import { DEFAULT_STACKER_KEYS } from './runner';

const STORAGE_KEY = 'obelisk-dex/stacker/keys';

/** The actions a player can bind, in the order the settings list shows them. */
export const BINDABLE: Array<{ action: InputKind; label: string }> = [
  { action: 'left', label: 'Move left' },
  { action: 'right', label: 'Move right' },
  { action: 'soft', label: 'Soft drop' },
  { action: 'hard', label: 'Hard drop' },
  { action: 'cw', label: 'Rotate right' },
  { action: 'ccw', label: 'Rotate left' },
  { action: 'flip', label: 'Rotate 180°' },
  { action: 'hold', label: 'Hold' },
];

export type KeyMap = Record<string, InputKind>;

export function defaultKeyMap(): KeyMap {
  return { ...DEFAULT_STACKER_KEYS };
}

export function loadKeyMap(): KeyMap {
  if (typeof localStorage === 'undefined') return defaultKeyMap();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultKeyMap();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultKeyMap();
    const valid = new Set(BINDABLE.map((b) => b.action));
    const map: KeyMap = {};
    for (const [code, action] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof action === 'string' && valid.has(action as InputKind)) {
        map[code] = action as InputKind;
      }
    }
    // A map that binds nothing would leave the game unplayable with no way
    // back, so fall through to the defaults rather than trusting it.
    return Object.keys(map).length > 0 ? map : defaultKeyMap();
  } catch {
    return defaultKeyMap();
  }
}

export function saveKeyMap(map: KeyMap): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* a full quota is not worth breaking the game over */
  }
}

export function resetKeyMap(): KeyMap {
  const fresh = defaultKeyMap();
  saveKeyMap(fresh);
  return fresh;
}

/**
 * Bind `code` to `action`, dropping whatever else that key did.
 *
 * An action may keep several keys (the defaults give rotate both ↑ and X), so
 * only the key being reassigned is cleared, not the action's other bindings.
 */
export function bindKey(map: KeyMap, code: string, action: InputKind): KeyMap {
  const next: KeyMap = { ...map };
  delete next[code];
  next[code] = action;
  return next;
}

/** Unbind one key. */
export function unbindKey(map: KeyMap, code: string): KeyMap {
  const next = { ...map };
  delete next[code];
  return next;
}

/** Every key currently bound to an action, for display. */
export function keysFor(map: KeyMap, action: InputKind): string[] {
  return Object.entries(map).filter(([, a]) => a === action).map(([code]) => code);
}

/** "ArrowLeft" → "←", "KeyX" → "X" — what a person recognises. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift',
    ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', Enter: 'Enter', Tab: 'Tab',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
