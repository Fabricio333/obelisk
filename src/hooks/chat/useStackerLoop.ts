'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { StackerRunner, STACKER_KEYS, type StackerStats, type StackerSoundEvent } from '@/lib/games/stacker/runner';
import { loadKeyMap, type KeyMap } from '@/lib/games/stacker/keymap';
import type { AttackEvent } from '@/lib/games/stacker/match';
import {
  ensureAudio, loadPrefs, playClear, playSfx, savePrefs, setMuted,
  startMusic, stopMusic, setMusicIntensity, type AudioPrefs,
} from '@/lib/games/stacker/audio';

export { STACKER_KEYS };

/**
 * Owns one `StackerRunner` and wires it to the browser: keyboard in, sound
 * out, stats into React.
 *
 * React only ever sees `stats`, which updates a few times a second. The board
 * itself subscribes to the runner directly and draws without re-rendering
 * anything — see `StackerBoard`.
 */
export function useStackerLoop(opts: {
  seed: number;
  incoming: readonly AttackEvent[];
  enabled: boolean;
  onAttack: (lines: number, hole: number, nonce: number) => void;
  onCheckpoint: (payload: {
    frame: number;
    attacksSent: number;
    linesCleared: number;
    stackHeight: number;
    inputs?: string;
    board: string;
  }) => void;
  onTopOut: () => void;
}) {
  const { seed, incoming, enabled, onAttack, onCheckpoint, onTopOut } = opts;

  const cb = useRef({ onAttack, onCheckpoint, onTopOut });
  useEffect(() => {
    cb.current = { onAttack, onCheckpoint, onTopOut };
  }, [onAttack, onCheckpoint, onTopOut]);

  const [prefs, setPrefs] = useState<AudioPrefs>(() => loadPrefs());
  // Re-read on every mount so a rebind in the panel takes effect on close.
  const [keyMap, setKeyMap] = useState<KeyMap>(() => loadKeyMap());
  const keyMapRef = useRef(keyMap);
  useEffect(() => { keyMapRef.current = keyMap; }, [keyMap]);
  // The runner is built once per match and lives outside React, so it reads
  // preferences through a ref rather than closing over a stale value.
  // Assigned in an effect: writing a ref during render is a render side
  // effect, even when it looks harmless.
  const prefsRef = useRef(prefs);
  useEffect(() => { prefsRef.current = prefs; }, [prefs]);

  // One runner per match. A new seed is a new match.
  //
  // The ref reads below happen inside callbacks the runner invokes later, not
  // while this memo is evaluating — the lint rule cannot tell the difference
  // between "reads a ref" and "reads a ref during render", and this is the
  // latter only in the syntactic sense.
  // eslint-disable-next-line react-hooks/refs
  const runner = useMemo(() => new StackerRunner({
    seed,
    onAttack: (lines, hole, nonce) => cb.current.onAttack(lines, hole, nonce),
    onCheckpoint: (payload) => cb.current.onCheckpoint(payload),
    onTopOut: () => cb.current.onTopOut(),
    onEvent: (event: StackerSoundEvent) => {
      if (prefsRef.current.muted) return;
      switch (event.kind) {
        case 'clear': playClear(event.lines, event.spin, event.combo); break;
        case 'garbage': playSfx('garbage'); break;
        case 'topout': playSfx('topout'); break;
        case 'move': playSfx('move'); break;
        case 'rotate': playSfx('rotate'); break;
        case 'hold': playSfx('hold'); break;
        case 'drop': playSfx('drop'); break;
        case 'lock': playSfx('lock'); break;
      }
    },
  }), [seed]);

  const [stats, setStats] = useState<StackerStats>(() => runner.stats());

  useEffect(() => runner.onStats(setStats), [runner]);

  useEffect(() => {
    if (!enabled) return;
    runner.start();
    return () => runner.stop();
  }, [runner, enabled]);

  useEffect(() => {
    runner.receive(incoming);
  }, [runner, incoming]);

  // Danger music: the fuller the well, the more insistent the bed.
  useEffect(() => {
    if (prefs.muted || !prefs.music) return;
    setMusicIntensity(Math.max(0, (stats.stackHeight - 8) / 12));
  }, [stats.stackHeight, prefs.muted, prefs.music]);

  /* ── keyboard ─────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!enabled) return;

    const down = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'KeyM') {
        setPrefs((p) => {
          const next = { ...p, muted: !p.muted };
          savePrefs(next);
          setMuted(next.muted);
          if (next.muted) stopMusic();
          else if (next.music) startMusic();
          return next;
        });
        return;
      }
      const kind = keyMapRef.current[e.code];
      if (!kind) return;
      // The game owns these keys while it is on screen: arrows must not
      // scroll the channel underneath and space must not page down.
      e.preventDefault();
      // Browsers only allow audio to start from a gesture, so the first
      // keypress is where the sound comes up.
      if (!prefsRef.current.muted && ensureAudio() && prefsRef.current.music) startMusic();
      runner.press(kind);
    };

    const up = (e: KeyboardEvent) => {
      const kind = keyMapRef.current[e.code];
      if (kind) runner.release(kind);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      stopMusic();
    };
  }, [runner, enabled]);

  const toggleMuted = () => {
    setPrefs((p) => {
      const next = { ...p, muted: !p.muted };
      savePrefs(next);
      ensureAudio();
      setMuted(next.muted);
      if (next.muted) stopMusic();
      else if (next.music) startMusic();
      return next;
    });
  };

  const toggleMusic = () => {
    setPrefs((p) => {
      const next = { ...p, music: !p.music };
      savePrefs(next);
      ensureAudio();
      if (next.music && !next.muted) startMusic();
      else stopMusic();
      return next;
    });
  };

  /** Called when the rebinding panel closes, so new keys apply at once. */
  const reloadKeys = () => setKeyMap(loadKeyMap());

  return { runner, stats, prefs, toggleMuted, toggleMusic, reloadKeys };
}
