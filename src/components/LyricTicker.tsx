/**
 * One-line live lyric ticker (Player lyrics pill, Car mode). Shows the line being sung right now,
 * filling word by word, and slides the next line in when it starts. Real LRCLIB lyrics only:
 * when the track has no synced lyrics it renders `fallback` instead.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';

import { useReduceMotion } from './motion';
import { T } from './primitives';
import type { CatalogTrack } from '../lib/catalog';
import { activeLine, timedLines, type Lyrics } from '../lib/lyrics';
import { useLoadedDuration, usePlayerPick } from '../state/player';
import { boundsOf, useLyricShift, useLyricsForTrack, useLyricTime } from './lyric-sync';
import { colors, withAlpha, type Weight } from '../theme/tokens';

/** Real lyrics for `track`, matched to the loaded audio (cached by lib/lyrics); `null` once known to have none. */
export function useSyncedLyrics(track: CatalogTrack) {
  const { lyr, lyrics } = useLyricsForTrack(track);
  return {
    loading: lyrics === undefined && !lyr.error,
    error: lyrics === undefined ? lyr.error : null,
    lyrics: lyrics ?? null,
    reload: lyr.reload,
  };
}

export type LyricTickerProps = {
  track: CatalogTrack;
  size?: number;
  weight?: Weight;
  /** Row height (the line is vertically centred in it). */
  height?: number;
  align?: 'center' | 'left';
  /** Rendered while loading, on error, or when the track has no synced lyrics. */
  fallback?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function LyricTicker({ track, size = 15, weight = 600, height = 48, align = 'center', fallback = null, style }: LyricTickerProps) {
  const { lyrics } = useSyncedLyrics(track);
  if (!lyrics?.synced.length) return <>{fallback}</>;
  return <TickerLine lines={lyrics} size={size} weight={weight} height={height} align={align} style={style} />;
}

function TickerLine({ lines, size, weight, height, align, style }: { lines: Lyrics; size: number; weight: Weight; height: number; align: 'center' | 'left'; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const { track } = usePlayerPick('track');
  const duration = useLoadedDuration(track?.id) || track?.duration || 0;
  const timed = useMemo(() => timedLines(lines.synced, duration), [lines.synced, duration]);
  // Shared playback clock: re-renders exactly when a line or word starts.
  const bounds = useMemo(() => boundsOf(timed, true), [timed]);
  const t = useLyricTime(bounds, useLyricShift(track?.id));
  const i = activeLine(timed, t);
  const line = i >= 0 ? timed[i] : null;

  const [enter] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduce) {
      enter.setValue(1);
      return;
    }
    enter.setValue(0);
    const a = Animated.timing(enter, { toValue: 1, duration: 320, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [i, reduce, enter]);

  const dim = withAlpha(colors.white, 0.3);
  const words = line?.words.filter((w) => w.text.trim()) ?? [];
  const label = line ? line.text || 'Instrumental' : 'Intro';

  return (
    <View style={[{ height, justifyContent: 'center', overflow: 'hidden' }, style]} accessible accessibilityLabel={`Now singing: ${label}`} accessibilityLiveRegion="polite">
      <Animated.View
        style={{
          opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }),
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [height * 0.45, 0] }) }, { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
        }}
      >
        <T
          size={size}
          weight={weight}
          tracking={-0.5}
          align={align}
          numberOfLines={1}
          style={{ textShadowColor: withAlpha(colors.accent, 0.85), textShadowRadius: line ? 12 : 0, textShadowOffset: { width: 0, height: 0 } }}
        >
          {words.length
            ? words.map((w, j) => (
                <T key={j} size={size} weight={weight} tracking={-0.5} color={w.time <= t ? colors.white : dim}>
                  {w.text}
                </T>
              ))
            : (
                <T size={size} weight={weight} color={dim}>
                  ♪
                </T>
              )}
        </T>
      </Animated.View>
    </View>
  );
}
