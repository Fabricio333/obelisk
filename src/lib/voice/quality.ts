/**
 * Video-quality presets for outbound camera/screen tracks.
 *
 * `auto` lets the encoder + adaptive loop in `stats.ts` pick the bitrate;
 * the explicit tiers cap both the resolution requested via `getUserMedia`
 * and the encoder's `maxBitrate`/`maxFramerate` via `setParameters`.
 *
 * Bitrate caps are tuned for a mesh where each peer sends N-1 outbound
 * streams. At the four-person cap, a peer sending 1080p60 at 8 Mbps ships
 * about 24 Mbps worst-case to the other three viewers — fits gigabit fiber comfortably and most modern home
 * upstream. The 60 fps tier is opt-in for users with the bandwidth budget.
 */

export type VideoQuality = 'auto' | '1080p60' | '1080p' | '720p60' | '720p' | '480p';

export const VIDEO_QUALITIES: readonly VideoQuality[] = [
  'auto', '1080p60', '1080p', '720p60', '720p', '480p',
];

export interface QualityPreset {
  /** `MediaTrackConstraints` overlay for `getUserMedia({ video: ... })`. */
  constraints: MediaTrackConstraints;
  /** Encoder cap. `null` means "let the bandwidth estimator decide". */
  maxBitrate: number | null;
  maxFramerate: number;
  /** Rough cap used when sending a `qualityhint` to ask peers to send less. */
  maxHeight: number | null;
}

const PRESETS: Record<VideoQuality, QualityPreset> = {
  auto: {
    // Loose hints only — matches pre-quality-controls behavior. Some mobile
    // cams reject combined width+height+frameRate "ideal" constraints and
    // fall back to a track that never produces frames.
    constraints: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    maxBitrate: null,
    maxFramerate: 30,
    maxHeight: null,
  },
  '1080p60': {
    constraints: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60, min: 30 },
    },
    // Smooth-motion tier — 8 Mbps matches what Twitch/YouTube use as the
    // upper bound for 1080p60 H.264. With VP9 codec preference active
    // (see `peer.ts`), the same bitrate yields visibly sharper detail.
    maxBitrate: 8_000_000,
    maxFramerate: 60,
    maxHeight: 1080,
  },
  '1080p': {
    constraints: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    // Bumped from 4 → 6 Mbps. The legacy 4 Mbps cap left visible blocking
    // on hair / textured backgrounds even on still video; 6 Mbps is the
    // floor where 1080p stays clean under typical motion.
    maxBitrate: 6_000_000,
    maxFramerate: 30,
    maxHeight: 1080,
  },
  '720p60': {
    constraints: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60, min: 30 },
    },
    // Smooth motion for users on tighter upstream — half the bitrate of
    // 1080p60 but the framerate is what makes a call feel responsive.
    maxBitrate: 5_000_000,
    maxFramerate: 60,
    maxHeight: 720,
  },
  '720p': {
    constraints: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    // Bumped from 2.5 → 3.5 Mbps. The default tier most calls land on; the
    // extra megabit keeps faces sharp through head movement.
    maxBitrate: 3_500_000,
    maxFramerate: 30,
    maxHeight: 720,
  },
  '480p': {
    constraints: {
      width: { ideal: 854 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
    },
    // Bumped from 1 → 1.5 Mbps. At 1 Mbps motion artifacts were aggressive;
    // 1.5 Mbps brings clean 480p in line with what mobile carriers push for
    // their own 480p video calls.
    maxBitrate: 1_500_000,
    maxFramerate: 30,
    maxHeight: 480,
  },
};

export function getPreset(q: VideoQuality): QualityPreset {
  return PRESETS[q];
}

/**
 * High-quality mic constraints. We always run AEC/NS/AGC; the extra hints
 * (sampleRate / channelCount) are advisory — browsers fall back gracefully
 * if the hardware can't honor them.
 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  // sampleRate/channelCount hints used to be here but real devices (iOS
  // Safari, some Android) silently failed getUserMedia when channelCount:2
  // hit a mono mic, killing the call. Encoder bitrate is still capped via
  // setParameters(AUDIO_MAX_BITRATE) on the sender.
};

/**
 * Encoder cap for outbound mic. Bumped from 128 kbps → 256 kbps so voice
 * stays crisp even when there's incidental music or ambient detail in the
 * background; Opus tops out at ~256 kbps for stereo material and the
 * extra bandwidth is negligible vs the video budget.
 */
export const AUDIO_MAX_BITRATE = 256_000;
