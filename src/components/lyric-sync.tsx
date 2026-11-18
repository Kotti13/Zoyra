/**
 * Lyric timing hooks shared by every synced-lyrics surface (lyrics screen, focus mode, karaoke,
 * player card, ticker), all driven by the player's interpolating playback clock:
 *
 * - `useLyricShift`: lead + output (Bluetooth) delay + the per-song Sync offset.
 * - `useLyricTime`: re-renders exactly when the lyric time crosses a line/word boundary (timers
 *   scheduled from the clock; no per-frame JS work, nothing runs while paused).
 * - `useLyricAnimatedClock`: an Animated value of the lyric time, run on the native driver between
 *   clock changes, for smooth word fills.
 * - `useLyricsForTrack`: fetches lyrics using the real loaded audio length and drops synced timing
 *   made for a different version of the song.
 * - `LyricSyncControl`: the compact −0.5 s / +0.5 s / reset control.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Animated, Easing, View } from 'react-native';

import type { CatalogTrack } from '../lib/catalog';
import { fetchLyrics, matchToAudio, type Lyrics } from '../lib/lyrics';
import { bucketOf, clampOffset, formatOffset, lyricShift, OFFSET_STEP_S } from '../lib/lyrics-sync';
import { usePlayPref } from '../lib/play-prefs';
import { useLoadedDuration, usePlaybackClockStore } from '../state/player';
import { colors } from '../theme/tokens';
import { Tap } from './controls';
import { useAsync, type AsyncState } from './media';
import { Row, T } from './primitives';

/** Per-song offsets kept (oldest dropped beyond this). */
const MAX_SAVED_OFFSETS = 300;

/** `[offset seconds, set]` for one track's Sync control (positive = lyrics earlier). Persisted per track id. */
export function useLyricOffset(trackId: string | null | undefined): readonly [number, (v: number) => void] {
  const [all, setAll] = usePlayPref('lyrics.offsets');
  const value = (trackId && all[trackId]) || 0;
  const set = useCallback(
    (v: number) => {
      if (!trackId) return;
      const next = { ...all };
      delete next[trackId];
      const c = clampOffset(v);
      if (c !== 0) next[trackId] = c;
      const keys = Object.keys(next);
      if (keys.length > MAX_SAVED_OFFSETS) keys.slice(0, keys.length - MAX_SAVED_OFFSETS).forEach((k) => delete next[k]);
      setAll(next);
    },
    [all, setAll, trackId],
  );
  return [value, set] as const;
}

/** Seconds added to the audio position to get the lyric time (lead − output delay + Sync offset). */
export function useLyricShift(trackId: string | null | undefined): number {
  const [delayMs] = usePlayPref('lyrics.outputDelayMs');
  const [offset] = useLyricOffset(trackId);
  return lyricShift(delayMs, offset);
}

/**
 * The current lyric time (audio position + `shift`), quantised to `bounds` (sorted seconds: line
 * and/or word start times): returns the last boundary passed, or -Infinity before the first. The
 * caller re-renders exactly when a boundary is crossed, or at once on seek/pause/track change.
 * Comparisons like `word.time <= t` and `activeLine(lines, t)` are exact for times in `bounds`.
 */
export function useLyricTime(bounds: readonly number[], shift: number): number {
  const clock = usePlaybackClockStore();
  const subscribe = useCallback(
    (notify: () => void) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const st = clock.state();
        if (!st.running || st.slope <= 0) return;
        const t = clock.now() + shift;
        const next = bounds[bucketOf(bounds, t) + 1];
        if (next === undefined) return;
        const ms = ((next - t) / st.slope) * 1000;
        timer = setTimeout(
          () => {
            notify();
            schedule();
          },
          Math.min(60_000, Math.max(0, ms) + 2),
        );
      };
      schedule();
      const unsub = clock.subscribe(() => {
        notify();
        schedule();
      });
      return () => {
        if (timer) clearTimeout(timer);
        unsub();
      };
    },
    [clock, bounds, shift],
  );
  const b = useSyncExternalStore(subscribe, () => bucketOf(bounds, clock.now() + shift));
  return b >= 0 ? bounds[b] : Number.NEGATIVE_INFINITY;
}

/** Longest stretch one native timing animation covers (it's restarted on every clock change anyway). */
const MAX_RUN_S = 600;

/** Animated lyric time (audio position + `shift`) running on the native driver; for word fills. */
export function useLyricAnimatedClock(shift: number): Animated.Value {
  const clock = usePlaybackClockStore();
  const [value] = useState(() => new Animated.Value(0));
  useEffect(() => {
    let anim: Animated.CompositeAnimation | null = null;
    const run = () => {
      anim?.stop();
      anim = null;
      const st = clock.state();
      const pos = clock.now();
      value.setValue(pos + shift);
      if (!st.running || st.slope <= 0) return;
      const secs = Math.min(MAX_RUN_S, st.duration > 0 ? st.duration - pos : MAX_RUN_S);
      if (secs <= 0) return;
      anim = Animated.timing(value, { toValue: pos + shift + secs, duration: (secs / st.slope) * 1000, easing: Easing.linear, useNativeDriver: true });
      anim.start();
    };
    run();
    const unsub = clock.subscribe(run);
    return () => {
      unsub();
      anim?.stop();
    };
  }, [clock, value, shift]);
  return value;
}

type Loaded = { id: string; lyrics: Lyrics | null };

/**
 * Lyrics for `track`, matched to the audio actually loaded: once the player knows the real length
 * and it differs from the catalogue's, lyrics are looked up again with it, and synced timing made
 * for another length is shown plain (`timingMismatch`) rather than out of sync.
 */
export function useLyricsForTrack(track: CatalogTrack | null): { lyr: AsyncState<Loaded>; lyrics: Lyrics | null | undefined } {
  const trackId = track?.id ?? '';
  const audioDuration = useLoadedDuration(track?.id);
  const catalogDuration = track?.duration ?? 0;
  const want = audioDuration > 0 && Math.abs(audioDuration - catalogDuration) > 1.5 ? Math.round(audioDuration) : 0;
  const lyr = useAsync<Loaded>(async () => ({ id: trackId, lyrics: track ? await fetchLyrics(track, want ? { duration: want } : undefined) : null }), [trackId, want]);
  const raw = lyr.data?.id === trackId ? lyr.data.lyrics : undefined;
  const lyrics = useMemo(() => (raw && audioDuration > 0 ? matchToAudio(raw, audioDuration) : raw), [raw, audioDuration]);
  return { lyr, lyrics };
}

/** Line/word start times of timed lines, sorted (for `useLyricTime`). */
export function boundsOf(lines: readonly { time: number; words?: readonly { time: number }[] }[], withWords: boolean): number[] {
  const out: number[] = [];
  for (const l of lines) {
    out.push(l.time);
    if (withWords) l.words?.forEach((w) => out.push(w.time));
  }
  return out.sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ Sync control */

function SyncButton({ label, text, onPress }: { label: string; text: string; onPress: () => void }) {
  return (
    <Tap accessibilityLabel={label} onPress={onPress} style={{ minWidth: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ height: 30, minWidth: 44, paddingHorizontal: 10, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.iconGhost, borderWidth: 1, borderColor: colors.chipOutline }}>
        <T mono size={12} weight={600}>
          {text}
        </T>
      </View>
    </Tap>
  );
}

/**
 * Compact per-song lyric sync: shift the lyrics 0.5 s earlier/later, see the current offset, reset.
 * Saved per track id on this device.
 */
export function LyricSyncControl({ trackId }: { trackId: string }) {
  const [offset, setOffset] = useLyricOffset(trackId);
  return (
    <Row gap={2} style={{ alignItems: 'center' }}>
      <T mono size={10} tracking={1} color={colors.textSecondary} style={{ marginRight: 4 }}>
        SYNC
      </T>
      <SyncButton label={`Show lyrics ${OFFSET_STEP_S} seconds later`} text={`−${OFFSET_STEP_S}`} onPress={() => setOffset(offset - OFFSET_STEP_S)} />
      <View accessible accessibilityLabel={`Lyrics offset ${formatOffset(offset)}`} accessibilityLiveRegion="polite" style={{ minWidth: 48, alignItems: 'center' }}>
        <T mono size={12} weight={600} color={offset ? colors.accentLight : colors.text}>
          {formatOffset(offset)}
        </T>
      </View>
      <SyncButton label={`Show lyrics ${OFFSET_STEP_S} seconds earlier`} text={`+${OFFSET_STEP_S}`} onPress={() => setOffset(offset + OFFSET_STEP_S)} />
      {offset ? (
        <Tap accessibilityLabel="Reset lyrics sync" onPress={() => setOffset(0)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
          <T size={12} weight={600} color={colors.accentLight}>
            Reset
          </T>
        </Tap>
      ) : null}
    </Row>
  );
}
