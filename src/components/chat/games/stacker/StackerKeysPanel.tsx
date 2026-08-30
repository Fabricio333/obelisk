'use client';

import { useEffect, useState } from 'react';
import ModalShell from '@/components/ModalShell';
import {
  BINDABLE, bindKey, keyLabel, keysFor, loadKeyMap, resetKeyMap, saveKeyMap, unbindKey,
  type KeyMap,
} from '@/lib/games/stacker/keymap';
import type { InputKind } from '@/lib/games/stacker/engine';

/**
 * Rebind the controls.
 *
 * Bindings live in localStorage, per browser: they are a property of the
 * keyboard in front of you, not of your account, so they have no business on
 * the relay. An action can hold several keys — the defaults bind rotate to
 * both ↑ and X — so binding one key never clears the others.
 */
export default function StackerKeysPanel({ onClose }: { onClose: () => void }) {
  const [map, setMap] = useState<KeyMap>(() => loadKeyMap());
  const [listening, setListening] = useState<InputKind | null>(null);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        setListening(null);
        return;
      }
      const next = bindKey(map, e.code, listening);
      setMap(next);
      saveKeyMap(next);
      setListening(null);
    };
    // Capture, so the game's own handler does not also see this keypress.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening, map]);

  return (
    <ModalShell
      onClose={onClose}
      testId="stacker-keys-panel"
      panelClassName="w-full max-w-sm mx-4 rounded-xl bg-lc-dark border border-lc-border p-5"
    >
      <h2 className="text-sm font-semibold text-lc-white">Controls</h2>
      <p className="mt-1 text-[11px] text-lc-muted">
        Click an action, then press the key you want. Saved in this browser.
      </p>

      <ul className="mt-3 space-y-1.5" data-testid="stacker-key-list">
        {BINDABLE.map(({ action, label }) => {
          const bound = keysFor(map, action);
          return (
            <li key={action} className="flex items-center gap-2">
              <span className="flex-1 text-xs text-lc-white">{label}</span>
              {bound.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => {
                    const next = unbindKey(map, code);
                    setMap(next);
                    saveKeyMap(next);
                  }}
                  title="Remove this key"
                  className="rounded border border-lc-border px-1.5 py-0.5 font-mono text-[10px] text-lc-muted hover:border-red-400 hover:text-red-400"
                >
                  {keyLabel(code)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setListening(action)}
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  listening === action
                    ? 'border-lc-green text-lc-green'
                    : 'border-lc-border text-lc-muted hover:text-lc-white'
                }`}
                data-testid={`bind-${action}`}
              >
                {listening === action ? 'press a key…' : '+ key'}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex justify-between">
        <button
          type="button"
          onClick={() => setMap(resetKeyMap())}
          className="lc-pill-secondary px-4 py-1.5 text-xs"
          data-testid="stacker-keys-reset"
        >
          Reset
        </button>
        <button type="button" onClick={onClose} className="lc-pill-primary px-4 py-1.5 text-xs">
          Done
        </button>
      </div>
    </ModalShell>
  );
}
