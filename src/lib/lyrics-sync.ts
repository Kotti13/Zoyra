/**
 * Pure timing helpers for synced lyrics: the interpolated playback clock, active-line lookup,
 * lyric offsets and version matching. No React / React Native imports, so the logic can be
 * checked with plain Node (`node scripts/check-lyrics-sync.ts`).
 */

/* ------------------------------------------------------------------ playback clock */

/**
 * One linear segment of the playback clock: at wall time `at` (ms, monotonic) the audio was at
 * `base` seconds and advances `slope` audio-seconds per wall-second (0 while paused/buffering).
 */
export type ClockState = {
  base: number;
  at: number;
  slope: number;
  /** Playing and not buffering. */
  running: boolean;
  rate: number;
  /** Loaded audio duration in seconds (0 = unknown). */
  duration: number;
  /** Playlist index the native status was reported for (-1 = unknown). */
  index: number;
  /** After an explicit seek: ignore native samples far from the target until `until` (ms). */
  seek: { until: number } | null;
  /** Last native time reported while "playing" (detects audio that says playing but hasn't started). */
  native?: number;
};

/** One native status sample (expo-audio `playlistStatusUpdate`). */
export type ClockSample = {
  time: number;
  playing: boolean;
  buffering: boolean;
  rate: number;
  duration: number;
  index: number;
  /** Audio loaded (expo-audio `isLoaded`). Omitted = assume loaded. */
  loaded?: boolean;
};

/** Native time this far from the interpolated clock is a seek / stall / track change: snap to it. */
export const CLOCK_SNAP_S = 0.3;
/** Smaller differences than this are status jitter and ignored. */
export const CLOCK_DEADBAND_S = 0.04;
/** Small drift is corrected by speeding up / slowing down the clock over about this long. */
const CLOCK_CONVERGE_S = 1;
/** Max ± slope correction while converging (keeps the clock monotonic and smooth). */
const CLOCK_MAX_ADJUST = 0.2;
/** How long a seek target wins over stale native samples. */
export const SEEK_GUARD_MS = 2000;

export const initialClock = (): ClockState => ({ base: 0, at: 0, slope: 0, running: false, rate: 1, duration: 0, index: -1, seek: null });

/** Interpolated audio position (seconds) at wall time `nowMs`, clamped to [0, duration]. */
export function clockAt(s: ClockState, nowMs: number): number {
  const t = s.base + (s.slope > 0 ? ((nowMs - s.at) / 1000) * s.slope : 0);
  const max = s.duration > 0 ? s.duration : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(max, t));
}

const snapTo = (s: ClockState, time: number, nowMs: number, running: boolean, rate: number, duration: number, index: number): ClockState => ({
  base: Math.max(0, time),
  at: nowMs,
  slope: running ? rate : 0,
  running,
  rate,
  duration,
  index,
  seek: null,
});

/**
 * Folds a native status sample into the clock. Returns the same object when nothing observable
 * changed (callers notify subscribers only when the state object changes).
 * - play/pause/buffering/rate/track changes and jumps > {@link CLOCK_SNAP_S} snap to the native time;
 * - small drift is absorbed by a slight slope change (no visible jump, never runs backwards);
 * - while a seek guard is active, stale samples far from the target are ignored.
 */
export function reconcileClock(s: ClockState, n: ClockSample, nowMs: number): ClockState {
  const next = reconcileInner(s, n, nowMs);
  // Remember the native time without forcing a new object (unchanged state keeps its identity so
  // subscribers aren't notified needlessly).
  next.native = n.time;
  return next;
}

function reconcileInner(s: ClockState, n: ClockSample, nowMs: number): ClockState {
  const rate = n.rate > 0 ? n.rate : 1;
  // A streamed track can report playing=true while still loading with its time stuck (often at 0). Only
  // run the clock when the audio is loaded and its position actually moves; otherwise lyrics run ahead.
  const sameTrack = n.index === s.index;
  const stuck = sameTrack && s.native !== undefined && n.time <= s.native + 0.001 && !s.seek;
  const running = n.playing && !n.buffering && n.loaded !== false && !(stuck && !s.running) && !(stuck && s.running && n.time <= 0.05);
  const duration = n.duration > 0 ? n.duration : s.duration;
  const predicted = clockAt(s, nowMs);
  const diff = n.time - predicted;

  if (s.seek) {
    if (nowMs < s.seek.until && Math.abs(diff) > CLOCK_SNAP_S) return s; // the seek hasn't landed yet
    s = { ...s, seek: null };
  }
  if (n.index !== s.index || running !== s.running || rate !== s.rate) return snapTo(s, n.time, nowMs, running, rate, duration, n.index);
  if (!running) {
    if (Math.abs(n.time - s.base) > 0.001 || duration !== s.duration) return snapTo(s, n.time, nowMs, false, rate, duration, n.index);
    return s;
  }
  if (Math.abs(diff) > CLOCK_SNAP_S) return snapTo(s, n.time, nowMs, true, rate, duration, n.index);
  if (Math.abs(diff) > CLOCK_DEADBAND_S) {
    const adjust = Math.max(-CLOCK_MAX_ADJUST, Math.min(CLOCK_MAX_ADJUST, diff / CLOCK_CONVERGE_S));
    return { ...s, base: predicted, at: nowMs, slope: rate * (1 + adjust), duration };
  }
  if (s.slope !== rate || duration !== s.duration) return { ...s, base: predicted, at: nowMs, slope: rate, duration };
  return s;
}

/** An explicit seek: jump at once and keep the target until the native player catches up. */
export function seekClock(s: ClockState, time: number, nowMs: number): ClockState {
  const t = Math.max(0, s.duration > 0 ? Math.min(time, s.duration) : time);
  return { ...s, base: t, at: nowMs, slope: s.running ? s.rate : 0, seek: { until: nowMs + SEEK_GUARD_MS } };
}

/** Track changed: restart at 0, frozen until the next native sample says it's playing. */
export function resetClock(s: ClockState, index: number, nowMs: number): ClockState {
  return { ...s, base: 0, at: nowMs, slope: 0, running: false, duration: 0, index, seek: null, native: undefined };
}

/** Milliseconds of wall time until the clock reaches `target` seconds (null when it never will). */
export function msUntil(s: ClockState, nowMs: number, target: number): number | null {
  if (!s.running || s.slope <= 0) return null;
  const left = target - clockAt(s, nowMs);
  return left <= 0 ? 0 : (left / s.slope) * 1000;
}

/* ------------------------------------------------------------------ line lookup */

/** Index of the last entry whose `time` is <= `position` (-1 before the first). Entries sorted by time. */
export function activeLine(lines: readonly { time: number }[], position: number) {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= position) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Index of the last boundary <= `t` in a sorted list of seconds (-1 before the first). */
export function bucketOf(bounds: readonly number[], t: number) {
  let lo = 0;
  let hi = bounds.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/* ------------------------------------------------------------------ offsets */

/**
 * The highlight runs this far ahead of the audio so a line lights up as it's sung (eyes need a
 * moment; this also covers the native status report being slightly stale).
 */
export const LYRIC_LEAD_S = 0.15;
/** Step of the per-song Sync control. */
export const OFFSET_STEP_S = 0.5;
export const OFFSET_MAX_S = 10;

/**
 * Seconds to add to the audio position to get the lyric time to highlight.
 * - `outputDelayMs`: audio output latency (Bluetooth headphones); the sound reaches the ears later,
 *   so the lyrics wait for it.
 * - `trackOffset`: per-song correction from the Sync control; positive shows lyrics earlier.
 */
export function lyricShift(outputDelayMs: number, trackOffset: number): number {
  return LYRIC_LEAD_S - Math.max(0, outputDelayMs) / 1000 + trackOffset;
}

/** Audio position to seek to so `lineTime` becomes the active lyric at once. */
export function seekTargetFor(lineTime: number, shift: number): number {
  return Math.max(0, lineTime - shift + 0.01);
}

export const clampOffset = (v: number) => Math.max(-OFFSET_MAX_S, Math.min(OFFSET_MAX_S, Math.round(v * 10) / 10));

/** "+1.0s", "−0.5s", "0.0s". */
export const formatOffset = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}s`;

/* ------------------------------------------------------------------ version matching */

/** Synced lyrics only line up when their song length is within this of the audio's. */
export const DURATION_TOLERANCE_S = 2;

export const durationMatches = (a: number | undefined | null, b: number | undefined | null, tol = DURATION_TOLERANCE_S) =>
  !!a && !!b && a > 0 && b > 0 && Math.abs(a - b) <= tol;

/** The candidate whose `duration` is closest to `target` (first one when none carries a duration). */
export function closestByDuration<T extends { duration?: number | null }>(items: readonly T[], target: number): T | undefined {
  let best: T | undefined;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const d = it.duration && it.duration > 0 && target > 0 ? Math.abs(it.duration - target) : Number.POSITIVE_INFINITY;
    if (!best || d < bestDiff) {
      best = it;
      bestDiff = d;
    }
  }
  return best;
}

const NOISE =
  /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|hd|hq|4k|1080p|720p|remaster(ed)?|explicit|clean|color coded|full song|topic)\b/i;

/**
 * Video-style title → song title: drops "(Official Video)", "[HD]", "(Lyrics)", "ft. X",
 * "| channel stuff" and a leading "Artist - " that repeats the artist name.
 */
export function cleanTitle(title: string, artist = ''): string {
  let t = title;
  // Bracket groups that are just video noise or a featured credit.
  t = t.replace(/\s*[([{【]([^)\]}】]*)[)\]}】]/g, (m, inner: string) => (NOISE.test(inner) || /^\s*(feat\.?|ft\.?|featuring|with)\s/i.test(inner) ? ' ' : m));
  t = t.split(/\s+[|｜]\s+/)[0];
  t = t.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '');
  const a = artist.trim().toLowerCase();
  const dash = t.split(/\s+[-–—]\s+/);
  if (dash.length >= 2 && a && dash[0].trim().toLowerCase() === a) t = dash.slice(1).join(' - ');
  t = t.replace(/\s+/g, ' ').trim();
  return t || title.trim();
}

/** Main credited artist: "A, B & C feat. D" → "A". */
export const primaryArtist = (artist: string) => artist.split(/\s*,\s*|\s+&\s+|\s+x\s+|\s+(?:feat\.?|ft\.?|featuring)\s+/i)[0].trim() || artist.trim();
