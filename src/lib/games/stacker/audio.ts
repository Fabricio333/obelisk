/**
 * Stacker's sound.
 *
 * **Effects** are synthesized by Web Audio at runtime — no files, no licensing
 * surface, a couple of kilobytes of code instead of megabytes of assets. It
 * suits the game too: sounds are consequences of engine events, so they fire
 * exactly where those events happen and are pitched by how big they were.
 *
 * **Music** is a recorded track (see `MUSIC_CREDIT`), with a generative synth
 * bed as the fallback when it cannot load or autoplay is refused. The game is
 * never silent for want of a file.
 *
 * The audio context is created lazily on the first user gesture, because
 * browsers refuse to start one otherwise.
 */

export type Sfx =
  | 'move' | 'rotate' | 'lock' | 'hold' | 'drop'
  | 'clear1' | 'clear2' | 'clear3' | 'clear4'
  | 'spin' | 'combo' | 'garbage' | 'danger' | 'topout' | 'win';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let sfxGain: GainNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicStep = 0;

const STORAGE_KEY = 'obelisk-dex/stacker/audio';

export interface AudioPrefs {
  muted: boolean;
  music: boolean;
}

export function loadPrefs(): AudioPrefs {
  if (typeof localStorage === 'undefined') return { muted: false, music: true };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { muted: false, music: true };
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return { muted: parsed.muted === true, music: parsed.music !== false };
  } catch {
    return { muted: false, music: true };
  }
}

export function savePrefs(prefs: AudioPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* a full quota is not worth breaking the game over */
  }
}

/** Start (or resume) the audio graph. Must be called from a user gesture. */
export function ensureAudio(): boolean {
  if (typeof window === 'undefined') return false;
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return false;

  if (!ctx) {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);

    musicGain = ctx.createGain();
    musicGain.gain.value = 0.16;
    musicGain.connect(master);

    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.7;
    sfxGain.connect(master);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return true;
}

export function setMuted(muted: boolean): void {
  if (trackEl) trackEl.muted = muted;
  if (!master || !ctx) return;
  master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.02);
}

/* ── voices ───────────────────────────────────────────────────────────── */

function blip(opts: {
  freq: number;
  to?: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}): void {
  if (!ctx || !sfxGain) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = opts.type ?? 'square';
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + opts.duration);
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(opts.gain ?? 0.3, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.duration);
  osc.connect(env);
  env.connect(sfxGain);
  osc.start(t0);
  osc.stop(t0 + opts.duration + 0.02);
}

/** Filtered noise — thuds, garbage, impacts. */
function noise(opts: { duration: number; gain?: number; freq?: number; delay?: number }): void {
  if (!ctx || !sfxGain) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const frames = Math.floor(ctx.sampleRate * opts.duration);
  const buffer = ctx.createBuffer(1, Math.max(1, frames), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Decaying noise, so it reads as an impact rather than a hiss.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = opts.freq ?? 800;
  const env = ctx.createGain();
  env.gain.value = opts.gain ?? 0.25;
  src.connect(filter);
  filter.connect(env);
  env.connect(sfxGain);
  src.start(t0);
}

/** Play one of the game's sounds. Silent (and harmless) before `ensureAudio`. */
export function playSfx(sfx: Sfx): void {
  if (!ctx || !sfxGain) return;

  switch (sfx) {
    case 'move':
      blip({ freq: 220, duration: 0.03, type: 'square', gain: 0.08 });
      break;
    case 'rotate':
      blip({ freq: 330, to: 420, duration: 0.05, type: 'triangle', gain: 0.12 });
      break;
    case 'hold':
      blip({ freq: 520, to: 380, duration: 0.08, type: 'triangle', gain: 0.14 });
      break;
    case 'drop':
      blip({ freq: 180, to: 60, duration: 0.09, type: 'sawtooth', gain: 0.16 });
      noise({ duration: 0.06, gain: 0.18, freq: 500 });
      break;
    case 'lock':
      noise({ duration: 0.05, gain: 0.14, freq: 400 });
      break;
    // Clears climb in pitch and length with the line count, so a quad
    // announces itself without needing a caption.
    case 'clear1':
      blip({ freq: 523, to: 784, duration: 0.16, type: 'triangle', gain: 0.22 });
      break;
    case 'clear2':
      blip({ freq: 523, duration: 0.1, type: 'square', gain: 0.2 });
      blip({ freq: 659, duration: 0.16, type: 'square', gain: 0.2, delay: 0.07 });
      break;
    case 'clear3':
      blip({ freq: 523, duration: 0.09, type: 'square', gain: 0.2 });
      blip({ freq: 659, duration: 0.09, type: 'square', gain: 0.2, delay: 0.07 });
      blip({ freq: 784, duration: 0.2, type: 'square', gain: 0.22, delay: 0.14 });
      break;
    case 'clear4':
      // The big one: a rising arpeggio with a shimmer on top.
      [523, 659, 784, 1047].forEach((f, i) => {
        blip({ freq: f, duration: 0.22, type: 'square', gain: 0.22, delay: i * 0.055 });
      });
      blip({ freq: 2093, duration: 0.5, type: 'sine', gain: 0.12, delay: 0.2 });
      break;
    case 'spin':
      blip({ freq: 880, to: 1320, duration: 0.18, type: 'sine', gain: 0.2 });
      blip({ freq: 660, to: 990, duration: 0.22, type: 'triangle', gain: 0.14, delay: 0.03 });
      break;
    case 'combo':
      blip({ freq: 1200, to: 1800, duration: 0.1, type: 'sine', gain: 0.16 });
      break;
    case 'garbage':
      noise({ duration: 0.22, gain: 0.3, freq: 260 });
      blip({ freq: 90, to: 55, duration: 0.24, type: 'sawtooth', gain: 0.2 });
      break;
    case 'danger':
      blip({ freq: 160, to: 120, duration: 0.3, type: 'sawtooth', gain: 0.1 });
      break;
    case 'topout':
      [440, 370, 294, 220].forEach((f, i) => {
        blip({ freq: f, duration: 0.35, type: 'sawtooth', gain: 0.2, delay: i * 0.12 });
      });
      noise({ duration: 0.7, gain: 0.2, freq: 300, delay: 0.1 });
      break;
    case 'win':
      [523, 659, 784, 1047, 1319].forEach((f, i) => {
        blip({ freq: f, duration: 0.4, type: 'triangle', gain: 0.24, delay: i * 0.1 });
      });
      break;
  }
}

/** The clear sound for a given line count and spin, in one call. */
export function playClear(lines: number, spin: boolean, combo: number): void {
  if (spin) playSfx('spin');
  else if (lines >= 4) playSfx('clear4');
  else if (lines === 3) playSfx('clear3');
  else if (lines === 2) playSfx('clear2');
  else if (lines === 1) playSfx('clear1');
  if (combo >= 2) playSfx('combo');
}

/* ── music ────────────────────────────────────────────────────────────── */

/**
 * The soundtrack.
 *
 * From TETRA (github.com/soyezequiel/tetris-para-luna-negra), a La Crypta
 * hackathon project. That repo marks its royalty-free tracks with an `ncc`
 * filename prefix — see `ROYALTY_FREE_PREFIX` in its `src/audio/music.ts` —
 * and this is one of them, generated with Suno. Credited in the UI and in
 * docs/games.md.
 *
 * If it will not load or play, the synthesized bed below takes over, so the
 * game is never silent because of a missing file or an autoplay policy.
 */
export const MUSIC_SOURCE = 'https://github.com/soyezequiel/tetris-para-luna-negra';
export const MUSIC_AUTHOR = 'soyezequiel';

/**
 * The playlist — the `ncc`-prefixed (royalty-free) tracks from TETRA.
 *
 * It just plays: no picker, no per-track controls. One track ends and the
 * next starts, shuffled once per session so a match does not always open on
 * the same song.
 */
export const MUSIC_TRACKS: Array<{ url: string; title: string }> = [
  { url: '/games/stacker/retro-game-ncc.mp3', title: 'Retro Game' },
  { url: '/games/stacker/digital-circus-ncc.mp3', title: 'Digital Circus' },
  { url: '/games/stacker/shoebody-bop-ncc.mp3', title: 'Shoebody Bop' },
];

export const MUSIC_CREDIT = {
  author: MUSIC_AUTHOR,
  source: MUSIC_SOURCE,
  note: 'royalty-free (Suno)',
};

let trackEl: HTMLAudioElement | null = null;
let trackFailed = false;
let order: number[] = [];
let orderPos = 0;
let onTrackChange: ((title: string) => void) | null = null;

function ensureOrder(): void {
  if (order.length === MUSIC_TRACKS.length) return;
  order = MUSIC_TRACKS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  orderPos = 0;
}

/** Which track is playing, for the credit line. */
export function currentTrack(): { url: string; title: string } {
  ensureOrder();
  return MUSIC_TRACKS[order[orderPos % order.length]];
}

/** Lets the credit line follow the music without the player having to care. */
export function setTrackListener(listener: ((title: string) => void) | null): void {
  onTrackChange = listener;
}

/**
 * A generative bed rather than a loop: a bass line under a shifting arpeggio,
 * stepped on a timer. It never repeats exactly, which wears better over a long
 * match than an eight-bar loop, and it costs nothing to ship.
 *
 * Swap this function's body for an <audio> element if you bring your own
 * track — nothing else in the game touches music.
 */
const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic: hard to make sound wrong
const ROOTS = [110, 110, 98, 87.31, 98]; // A, A, G, F, G

/**
 * Start the soundtrack, falling back to the synth bed if it cannot play.
 *
 * The <audio> element is deliberately not routed through the AudioContext:
 * that would need CORS-clean decoding for no benefit here, and volume and
 * muting are simpler on the element itself.
 */
export function startMusic(): void {
  if (!trackFailed && typeof Audio !== 'undefined') {
    if (!trackEl) {
      trackEl = new Audio(currentTrack().url);
      trackEl.volume = 0.35;
      // One track ends, the next begins. Nobody has to choose anything.
      trackEl.addEventListener('ended', advance);
      trackEl.addEventListener('error', () => {
        // Missing or undecodable: move on, and fall back to the synth only
        // once the whole playlist has failed.
        if (orderPos + 1 < MUSIC_TRACKS.length) {
          advance();
          return;
        }
        trackFailed = true;
        trackEl = null;
        startSynthMusic();
      });
    }
    void trackEl.play().catch(() => {
      // Autoplay refused, or the file will not play. Same answer.
      trackFailed = true;
      trackEl = null;
      startSynthMusic();
    });
    onTrackChange?.(currentTrack().title);
    return;
  }
  startSynthMusic();
}

function advance(): void {
  ensureOrder();
  orderPos = (orderPos + 1) % order.length;
  if (trackEl) {
    trackEl.src = currentTrack().url;
    trackEl.currentTime = 0;
    void trackEl.play().catch(() => { /* the error handler moves us along */ });
  }
  onTrackChange?.(currentTrack().title);
}

export function stopMusic(): void {
  if (trackEl) {
    trackEl.pause();
    trackEl.currentTime = 0;
  }
  stopSynthMusic();
}

function startSynthMusic(): void {
  if (!ctx || !musicGain || musicTimer) return;
  const stepMs = 150;

  musicTimer = setInterval(() => {
    if (!ctx || !musicGain) return;
    const t = ctx.currentTime;
    const bar = Math.floor(musicStep / 16) % ROOTS.length;
    const root = ROOTS[bar];

    // Bass on the downbeat and the off-beat.
    if (musicStep % 4 === 0) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = root / 2;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.5, t + 0.01);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      osc.connect(env);
      env.connect(musicGain);
      osc.start(t);
      osc.stop(t + 0.3);
    }

    // Arpeggio, wandering up and down the scale.
    const degree = SCALE[(musicStep * 3) % SCALE.length];
    const octave = musicStep % 8 < 4 ? 2 : 4;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = root * octave * Math.pow(2, degree / 12);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.12, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(env);
    env.connect(musicGain);
    osc.start(t);
    osc.stop(t + 0.16);

    musicStep += 1;
  }, stepMs);
}

function stopSynthMusic(): void {
  if (musicTimer) {
    clearInterval(musicTimer);
    musicTimer = null;
  }
}

/** Lift the music a little when things get tense. */
export function setMusicIntensity(danger: number): void {
  const lift = Math.min(1, Math.max(0, danger));
  if (trackEl) trackEl.volume = 0.3 + lift * 0.2;
  if (!ctx || !musicGain) return;
  musicGain.gain.setTargetAtTime(0.12 + lift * 0.12, ctx.currentTime, 0.3);
}

/** For tests and teardown. */
export function disposeAudio(): void {
  stopMusic();
  trackEl = null;
  trackFailed = false;
  if (ctx) void ctx.close().catch(() => {});
  ctx = null;
  master = null;
  musicGain = null;
  sfxGain = null;
  musicStep = 0;
}
