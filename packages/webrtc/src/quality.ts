/**
 * Adaptive quality. WebRTC's congestion control already adapts the bitrate
 * continuously; on top of that the host steps through a small ladder of
 * resolution / frame-rate / bitrate caps based on measured RTT and loss, so
 * the encoder is never asked for more than the link can carry.
 */
import type { QualityPreset } from './datachannel';

export interface QualityLevel {
  /** Passed to RTCRtpEncodingParameters.scaleResolutionDownBy. */
  scale: number;
  maxFramerate: number;
  /** bits per second */
  maxBitrate: number;
}

export const QUALITY_LADDER: readonly QualityLevel[] = [
  { scale: 1, maxFramerate: 30, maxBitrate: 8_000_000 },
  { scale: 1, maxFramerate: 24, maxBitrate: 4_000_000 },
  { scale: 1.5, maxFramerate: 20, maxBitrate: 2_500_000 },
  { scale: 2, maxFramerate: 15, maxBitrate: 1_200_000 },
  { scale: 3, maxFramerate: 10, maxBitrate: 600_000 },
];

/** Allowed ladder range per preset: [best, worst]. */
export const PRESET_RANGE: Readonly<Record<QualityPreset, readonly [number, number]>> = {
  auto: [0, 4],
  quality: [0, 2],
  balanced: [1, 3],
  speed: [3, 4],
};

export interface LinkStats {
  /** Round-trip time in ms (from the ICE candidate pair or RTCP). */
  rttMs: number | null;
  /** Fraction 0..1 of packets lost in the last interval. */
  lossRate: number | null;
}

export interface QualityState {
  level: number;
  /** Consecutive good intervals since the last change. */
  goodIntervals: number;
  /** Intervals to wait after a change before changing again. */
  cooldown: number;
}

export const INITIAL_QUALITY: QualityState = { level: 1, goodIntervals: 0, cooldown: 0 };

const BAD_RTT_MS = 350;
const BAD_LOSS = 0.06;
const GOOD_RTT_MS = 150;
const GOOD_LOSS = 0.015;
const GOOD_INTERVALS_TO_UPGRADE = 8;
const COOLDOWN_INTERVALS = 3;

function clamp(level: number, preset: QualityPreset): number {
  const [best, worst] = PRESET_RANGE[preset];
  return Math.min(Math.max(level, best), worst);
}

/**
 * One step of the controller (call once per stats interval, ~1 s). Degrades
 * quickly on congestion and recovers slowly, which avoids oscillation.
 */
export function nextQuality(
  state: QualityState,
  stats: LinkStats,
  preset: QualityPreset,
): QualityState {
  const level = clamp(state.level, preset);
  if (state.cooldown > 0) {
    return { level, goodIntervals: 0, cooldown: state.cooldown - 1 };
  }
  const bad =
    (stats.rttMs !== null && stats.rttMs > BAD_RTT_MS) ||
    (stats.lossRate !== null && stats.lossRate > BAD_LOSS);
  if (bad) {
    const worse = clamp(level + 1, preset);
    return { level: worse, goodIntervals: 0, cooldown: worse === level ? 0 : COOLDOWN_INTERVALS };
  }
  const good =
    stats.rttMs !== null &&
    stats.rttMs < GOOD_RTT_MS &&
    (stats.lossRate === null || stats.lossRate < GOOD_LOSS);
  if (!good) return { level, goodIntervals: 0, cooldown: 0 };
  const goodIntervals = state.goodIntervals + 1;
  if (goodIntervals >= GOOD_INTERVALS_TO_UPGRADE) {
    const better = clamp(level - 1, preset);
    return { level: better, goodIntervals: 0, cooldown: better === level ? 0 : COOLDOWN_INTERVALS };
  }
  return { level, goodIntervals, cooldown: 0 };
}

/** Loss fraction between two cumulative samples. */
export function lossBetween(
  previous: { packetsLost: number; packetsReceived: number } | null,
  current: { packetsLost: number; packetsReceived: number },
): number | null {
  if (!previous) return null;
  const lost = current.packetsLost - previous.packetsLost;
  const received = current.packetsReceived - previous.packetsReceived;
  const total = lost + received;
  if (total <= 0) return null;
  return Math.max(0, Math.min(1, lost / total));
}
