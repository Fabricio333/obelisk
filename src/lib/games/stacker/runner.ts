/**
 * The thing that actually runs a match on your machine.
 *
 * This is deliberately not a React hook and holds no React state. The first
 * version drove the board through React — a store notification every frame, a
 * re-render of the table, a canvas redraw from props — and it stuttered,
 * because sixty reconciliations a second is sixty reconciliations a second.
 *
 * So the split is:
 *
 *   - **hot path** (60 Hz): the engine steps, and `onFrame` subscribers draw.
 *     No React involved. The canvas subscribes directly.
 *   - **cold path** (~8 Hz): scores, combo, incoming count — the numbers a
 *     human reads. React re-renders on these, and only these.
 *   - **outbound** (~4 Hz): attacks and checkpoints leave on a timer, never
 *     inside a frame. Signing an event takes milliseconds with a local key and
 *     can take a *lot* longer with a browser extension, and doing it between
 *     two frames is exactly what made sending feel like a stutter.
 *
 * Attacks are coalesced while queued: three quick clears become one event with
 * the lines summed, which is fewer signatures, fewer publishes, and the same
 * garbage arriving at the other end.
 */
import {
  canFall,
  createState,
  stackHeight,
  step,
  type GameState,
  type Input,
  type InputKind,
} from './engine';
import { CHECKPOINT_INTERVAL_FRAMES, encodeInputs, type AttackEvent } from './match';
import { encodeBoard } from './engine';

const FRAME_MS = 1000 / 60;
/** Frames a held key waits before it starts repeating. */
export const DAS_FRAMES = 10;
/** Frames between repeats once it does. */
export const ARR_FRAMES = 2;
/** Gravity interval at the start, in frames. */
export const BASE_GRAVITY_FRAMES = 48;
/** Grace a landed piece gets before it cements. */
export const LOCK_DELAY_FRAMES = 30;
/** How many slides may refresh that grace. */
export const LOCK_RESETS = 15;
/** How often the readable numbers are pushed to React. */
const STATS_INTERVAL_MS = 120;
/** How often queued attacks and checkpoints leave. */
const FLUSH_INTERVAL_MS = 250;
/**
 * How often a snapshot of the well goes out so opponents can watch.
 *
 * Separate from the verification checkpoint, which carries the whole input log
 * and only needs to be occasional. A board is 200 characters, so it can travel
 * often enough to be worth looking at without flooding the relay.
 */
const BOARD_INTERVAL_FRAMES = 180;

export interface StackerStats {
  linesCleared: number;
  attacksSent: number;
  incoming: number;
  combo: number;
  backToBack: number;
  stackHeight: number;
  dead: boolean;
  frame: number;
  /** Most recent clear, for the banner. Cleared after a moment. */
  lastClear: { lines: number; spin: boolean; attack: number; at: number } | null;
}

export interface StackerRunnerOptions {
  seed: number;
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
  /** Fired for sound: one per meaningful event, on the frame it happened. */
  onEvent?: (event: StackerSoundEvent) => void;
}

export type StackerSoundEvent =
  | { kind: 'move' } | { kind: 'rotate' } | { kind: 'hold' } | { kind: 'drop' }
  | { kind: 'lock' } | { kind: 'garbage'; lines: number } | { kind: 'topout' }
  | { kind: 'clear'; lines: number; spin: boolean; combo: number };

export const DEFAULT_STACKER_KEYS: Record<string, InputKind> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowDown: 'soft',
  ArrowUp: 'cw',
  KeyX: 'cw',
  KeyZ: 'ccw',
  KeyA: 'flip',
  Space: 'hard',
  KeyC: 'hold',
  ShiftLeft: 'hold',
};

/** Kept for callers that just want the defaults. */
export const STACKER_KEYS = DEFAULT_STACKER_KEYS;

export class StackerRunner {
  state: GameState;
  frame = 0;

  private log: Input[] = [];
  private held = new Map<InputKind, { since: number; last: number }>();
  private gravity = 0;
  private grounded = 0;
  private lockResets = 0;
  private appliedAttacks = new Set<string>();
  private lastCheckpointFrame = 0;
  private lastBoardFrame = 0;
  private reportedDeath = false;

  private raf: number | null = null;
  private lastTick = 0;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private frameListeners = new Set<(state: GameState) => void>();
  private statsListeners = new Set<(stats: StackerStats) => void>();

  /** Attack lines waiting to be published, summed. */
  private pendingAttack = 0;
  private pendingCheckpoint = false;
  private pendingBoard = false;
  private lastClear: StackerStats['lastClear'] = null;

  private running = false;

  constructor(private opts: StackerRunnerOptions) {
    this.state = createState(opts.seed);
  }

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = 0;
    this.raf = requestAnimationFrame(this.tick);
    this.statsTimer = setInterval(() => this.emitStats(), STATS_INTERVAL_MS);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.raf = null;
    this.statsTimer = null;
    this.flushTimer = null;
    // Anything still queued goes out now rather than being lost on unmount.
    this.flush();
  }

  /* ── subscriptions ──────────────────────────────────────────────────── */

  /** Every frame. For canvases; never for React state. */
  onFrame(listener: (state: GameState) => void): () => void {
    this.frameListeners.add(listener);
    listener(this.state);
    return () => { this.frameListeners.delete(listener); };
  }

  /** The readable numbers, a few times a second. Safe for React. */
  onStats(listener: (stats: StackerStats) => void): () => void {
    this.statsListeners.add(listener);
    listener(this.stats());
    return () => { this.statsListeners.delete(listener); };
  }

  stats(): StackerStats {
    return {
      linesCleared: this.state.linesCleared,
      attacksSent: this.state.attacksSent,
      incoming: this.state.incoming.reduce((n, g) => n + g.lines, 0),
      combo: this.state.combo,
      backToBack: this.state.backToBack,
      stackHeight: stackHeight(this.state),
      dead: this.state.dead,
      frame: this.frame,
      lastClear: this.lastClear,
    };
  }

  /* ── input ──────────────────────────────────────────────────────────── */

  press(kind: InputKind): void {
    if (this.state.dead) return;
    if (this.held.has(kind)) return;
    this.held.set(kind, { since: this.frame, last: this.frame });
    this.apply({ frame: this.frame, kind });
    // Sliding or spinning a landed piece buys a little more time, to a limit.
    if (kind !== 'hard' && this.grounded > 0 && this.lockResets < LOCK_RESETS) {
      this.grounded = 0;
      this.lockResets += 1;
    }
    if (kind === 'left' || kind === 'right') this.opts.onEvent?.({ kind: 'move' });
    else if (kind === 'cw' || kind === 'ccw' || kind === 'flip') this.opts.onEvent?.({ kind: 'rotate' });
    else if (kind === 'hold') this.opts.onEvent?.({ kind: 'hold' });
    else if (kind === 'hard') this.opts.onEvent?.({ kind: 'drop' });
    // A key press must show up on the very next paint, not at the next
    // stats tick — that delay is what makes controls feel mushy.
    this.emitFrame();
  }

  release(kind: InputKind): void {
    this.held.delete(kind);
  }

  /** Garbage that arrived from the relay. */
  receive(attacks: readonly AttackEvent[]): void {
    let landed = 0;
    for (const attack of attacks) {
      const key = `${attack.from}:${attack.nonce}:${attack.at}`;
      if (this.appliedAttacks.has(key)) continue;
      this.appliedAttacks.add(key);
      this.apply({ frame: this.frame, kind: 'garbage', lines: attack.lines, hole: attack.hole });
      landed += attack.lines;
    }
    if (landed > 0) {
      this.opts.onEvent?.({ kind: 'garbage', lines: landed });
      this.emitFrame();
      this.emitStats();
    }
  }

  /* ── the loop ───────────────────────────────────────────────────────── */

  private apply(input: Input): void {
    this.log.push(input);
    const before = this.state.clears.length;
    step(this.state, input);
    const clear = this.state.clears[this.state.clears.length - 1];
    if (this.state.clears.length > before && clear) {
      this.lastClear = { lines: clear.lines, spin: clear.spin, attack: clear.attack, at: this.frame };
      this.opts.onEvent?.({
        kind: 'clear',
        lines: clear.lines,
        spin: clear.spin,
        combo: this.state.combo,
      });
      if (clear.attack > 0) this.pendingAttack += clear.attack;
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);
    if (this.lastTick === 0) this.lastTick = now;
    // Catch up in whole frames, capped so a backgrounded tab does not resume
    // by simulating half a minute of gravity at once.
    const elapsed = Math.min(now - this.lastTick, FRAME_MS * 8);
    let steps = Math.floor(elapsed / FRAME_MS);
    if (steps <= 0) return;
    this.lastTick += steps * FRAME_MS;

    if (this.state.dead) {
      if (!this.reportedDeath) {
        this.reportedDeath = true;
        this.opts.onEvent?.({ kind: 'topout' });
        this.opts.onTopOut();
        this.emitStats();
      }
      return;
    }

    while (steps-- > 0) {
      this.frame += 1;

      for (const [kind, held] of this.held) {
        if (kind !== 'left' && kind !== 'right' && kind !== 'soft') continue;
        if (this.frame - held.since < DAS_FRAMES) continue;
        if (this.frame - held.last < ARR_FRAMES) continue;
        held.last = this.frame;
        this.apply({ frame: this.frame, kind });
      }

      // Gravity quickens as the match goes on.
      const gravityFrames = Math.max(4, BASE_GRAVITY_FRAMES - Math.floor(this.state.linesCleared / 10) * 4);
      this.gravity += 1;
      if (this.gravity >= gravityFrames) {
        this.gravity = 0;
        if (canFall(this.state)) this.apply({ frame: this.frame, kind: 'gravity' });
      }

      // Lock delay: a landed piece gets a moment before it cements.
      if (this.state.active && !canFall(this.state)) {
        this.grounded += 1;
        if (this.grounded >= LOCK_DELAY_FRAMES) {
          this.apply({ frame: this.frame, kind: 'gravity' });
          this.grounded = 0;
          this.lockResets = 0;
          this.opts.onEvent?.({ kind: 'lock' });
        }
      } else {
        this.grounded = 0;
      }

      if (this.state.dead) break;
    }

    if (this.frame - this.lastCheckpointFrame >= CHECKPOINT_INTERVAL_FRAMES) {
      this.lastCheckpointFrame = this.frame;
      this.pendingCheckpoint = true;
    }
    if (this.frame - this.lastBoardFrame >= BOARD_INTERVAL_FRAMES) {
      this.lastBoardFrame = this.frame;
      this.pendingBoard = true;
    }

    this.emitFrame();
  };

  /**
   * Everything outbound leaves here, on its own timer, off the frame path.
   * Queued attacks are summed into one event: same garbage, one signature.
   */
  private flush(): void {
    if (this.pendingAttack > 0) {
      const lines = this.pendingAttack;
      this.pendingAttack = 0;
      // The hole column travels with the attack, so the receiver's board and
      // any later replay of it agree on where the gap was.
      this.opts.onAttack(lines, Math.floor(Math.random() * 10), this.frame);
    }
    // The verification checkpoint carries the whole input log; the frequent
    // one carries only the board. Both go out as one event when they coincide.
    if (this.pendingCheckpoint || this.pendingBoard) {
      const withProof = this.pendingCheckpoint;
      this.pendingCheckpoint = false;
      this.pendingBoard = false;
      this.opts.onCheckpoint({
        frame: this.frame,
        attacksSent: this.state.attacksSent,
        linesCleared: this.state.linesCleared,
        stackHeight: stackHeight(this.state),
        board: encodeBoard(this.state),
        ...(withProof ? { inputs: encodeInputs(this.log) } : {}),
      });
    }
  }

  private emitFrame(): void {
    for (const listener of this.frameListeners) listener(this.state);
  }

  private emitStats(): void {
    // The clear banner fades on its own rather than needing a timer per clear.
    if (this.lastClear && this.frame - this.lastClear.at > 90) this.lastClear = null;
    const stats = this.stats();
    for (const listener of this.statsListeners) listener(stats);
  }
}
