/**
 * Pure checks for the lyric clock + active-line selection + version matching.
 * Run: node scripts/check-lyrics-sync.ts   (Node >= 22.6, type stripping)
 */
import assert from 'node:assert/strict';

import {
  activeLine,
  bucketOf,
  cleanTitle,
  clockAt,
  closestByDuration,
  durationMatches,
  formatOffset,
  initialClock,
  lyricShift,
  msUntil,
  reconcileClock,
  resetClock,
  seekClock,
  seekTargetFor,
  type ClockSample,
} from '../src/lib/lyrics-sync.ts';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const sample = (time: number, extra: Partial<ClockSample> = {}): ClockSample => ({ time, playing: true, buffering: false, rate: 1, duration: 200, index: 0, ...extra });

// Interpolation between ticks.
let c = reconcileClock(initialClock(), sample(10), 1000);
near(clockAt(c, 1000), 10);
near(clockAt(c, 1250), 10.25);
near(clockAt(c, 1500), 10.5);
// Jitter inside the deadband: no change.
assert.equal(reconcileClock(c, sample(10.27), 1250), c);
// Small drift: no jump, converges via slope, stays monotonic.
const d = reconcileClock(c, sample(10.35), 1250);
near(clockAt(d, 1250), 10.25);
assert.ok(d.slope > 1 && d.slope <= 1.2);
// Big divergence (seek elsewhere / stall): snap.
const s = reconcileClock(c, sample(42), 1250);
near(clockAt(s, 1250), 42);
// Playback rate.
const r = reconcileClock(c, sample(10.25, { rate: 1.5 }), 1250);
near(clockAt(r, 2250), 11.75);
// Pause and buffering freeze the clock.
const p = reconcileClock(c, sample(10.25, { playing: false }), 1250);
near(clockAt(p, 9000), 10.25);
assert.equal(msUntil(p, 9000, 20), null);
const b = reconcileClock(c, sample(10.25, { buffering: true }), 1250);
near(clockAt(b, 5000), 10.25);
// Clamp to duration.
near(clockAt(c, 1000 + 500_000), 200);
// Explicit seek is immediate and survives stale native samples, then follows the native player.
const k = seekClock(c, 90, 1300);
near(clockAt(k, 1300), 90);
const stale = reconcileClock(k, sample(10.3), 1400);
assert.equal(stale, k);
near(clockAt(stale, 1400), 90.1);
const landed = reconcileClock(k, sample(90.12), 1420);
assert.equal(landed.seek, null);
near(clockAt(landed, 1420), 90.12, 0.05);
// Track change resets to 0 until playing is reported.
const t = resetClock(c, 1, 2000);
near(clockAt(t, 5000), 0);
near(clockAt(reconcileClock(t, sample(0.2, { index: 1 }), 2100), 2600), 0.7);
// Time to the next boundary.
near(msUntil(c, 1000, 12) ?? -1, 2000);

// Active line + boundaries.
const lines = [{ time: 5 }, { time: 9.5 }, { time: 12 }, { time: 12 }, { time: 20 }];
assert.equal(activeLine(lines, 0), -1);
assert.equal(activeLine(lines, 5), 0);
assert.equal(activeLine(lines, 9.49), 0);
assert.equal(activeLine(lines, 9.5), 1);
assert.equal(activeLine(lines, 12), 3);
assert.equal(activeLine(lines, 99), 4);
assert.equal(bucketOf([1, 2, 3], 2.5), 1);
// Lead/delay/offset: tapping a line makes it active at once.
const shift = lyricShift(200, 1);
near(shift, 0.15 - 0.2 + 1);
assert.equal(activeLine(lines, seekTargetFor(9.5, shift) + shift), 1);
assert.equal(formatOffset(1), '+1.0s');
assert.equal(formatOffset(-0.5), '−0.5s');

// Version matching.
assert.ok(durationMatches(200, 201.9));
assert.ok(!durationMatches(200, 202.5));
assert.ok(!durationMatches(undefined, 200));
assert.equal(closestByDuration([{ duration: 180 }, { duration: 207 }, { duration: 199 }], 200)?.duration, 199);
assert.equal(cleanTitle('Artist - Song (Official Video) [HD]', 'Artist'), 'Song');
assert.equal(cleanTitle('Song ft. Someone (Lyrics)'), 'Song');
assert.equal(cleanTitle('Song (Remix) | Channel'), 'Song (Remix)');

console.log('lyrics-sync checks passed');
