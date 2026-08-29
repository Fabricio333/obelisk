/**
 * Dice for a game with no referee.
 *
 * Vesta's `roll-dice` move carries its own values — upstream's hot-seat client
 * rolls locally and records the result. That cannot survive contact with a
 * relay: a player who picks their own numbers picks their own resources.
 *
 * So we ignore whatever values a move claims and derive them from the log:
 * `entropy` is the id of the last accepted event plus the turn index, both
 * fixed before the roller published anything. The roller cannot grind the
 * result by rewriting their own event, because their own event is not an
 * input.
 *
 * What this does NOT solve: the player who published the *previous* accepted
 * event can grind that event to steer the next roll. In practice the previous
 * event is usually another player's end-turn, so the grinder is steering
 * someone else's roll — but it is a real weakness, and it is exactly what
 * upstream's URD dependency (verifiable randomness) is meant to close. When
 * Vesta ships URD-backed rolls, this module is the one thing that changes.
 *
 * `mulberry32` comes from the tracked upstream package, so our dice use the
 * same PRNG as their board generation.
 */
import { mulberry32 } from 'vesta';

/** xmur3: string → 32-bit seed. Cheap, synchronous, and stable across engines. */
function seedFrom(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Two d6, decided by the log rather than by whoever is rolling. */
export function diceFromEntropy(entropy: string): [number, number] {
  const rng = mulberry32(seedFrom(entropy));
  const a = 1 + Math.floor(rng() * 6);
  const b = 1 + Math.floor(rng() * 6);
  // mulberry32 returns [0,1); clamp defensively so a 1.0 can never yield a 7.
  return [Math.min(6, a), Math.min(6, b)];
}
