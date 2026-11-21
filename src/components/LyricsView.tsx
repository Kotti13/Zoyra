/**
 * Animated, word-synced lyrics (Apple Music style), built on RN `Animated` only.
 *
 * - The active line is large, bright and full size; past and future lines are dimmed and slightly smaller.
 * - Auto-scroll keeps the active line about a third of the way down (centred in `compact` mode).
 * - Words on the active line fill progressively (real enhanced-LRC timing, or an even estimate).
 *   `highlight="wave"` also lifts each word as it is sung.
 * - Tap a line to seek there. Dragging the list pauses auto-follow for 4 s.
 * - Reduce Motion: no scaling, lifting or animated scrolling; lines and words switch state instantly.
 *
 * Also exports the focus-mode view (one line at a time), the progress-ring play button and
 * `useTrackLyrics`, the shared loader for the lyrics screens.
 */
import { router } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, View, type LayoutChangeEvent, type ScrollViewInstance, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle } from 'react-native-svg';

import { useReduceLyricMotion } from '../lib/a11y';
import type { AiResult } from '../lib/ai';
import { formatDuration, type CatalogTrack } from '../lib/catalog';
import { getPlayPref, usePlayPref } from '../lib/play-prefs';
import { activeLine, timedLines, transformLyrics, type LyricLine, type Lyrics, type LyricsView as LyricsMode, type LyricWord, type TimedLine } from '../lib/lyrics';
import { seekTargetFor } from '../lib/lyrics-sync';
import { useLoadedDuration, usePlaybackProgress, usePlayerPick, usePlaybackClockStore } from '../state/player';
import { colors, fontForWeight, withAlpha, type Weight } from '../theme/tokens';
import { Tap } from './controls';
import { resolveFont } from './fonts';
import { useLyricAnimatedClock, useLyricShift, useLyricsForTrack, useLyricTime } from './lyric-sync';
import { useAsync, type AsyncState } from './media';
import { useReduceMotion } from './motion';
import { Icon, T } from './primitives';

export { useReduceMotion } from './motion';

const FOLLOW_PAUSE_MS = 4000;
const DIM_PAST = 0.3;
const DIM_FUTURE = 0.5;
const WORD_DIM = 0.3;
const INACTIVE_SCALE = 0.93;
/** Red glow on the active line (mock: drop-shadow 0 0 14px accent 85%). */
const GLOW = {
  textShadowColor: withAlpha(colors.accent, 0.85),
  textShadowRadius: 14,
  textShadowOffset: { width: 0, height: 0 },
} as const;

/** `fill`: words brighten as sung; `wave`: fill + a small lift per word; `static`: the whole active line lights at once. */
export type LyricsHighlight = 'fill' | 'wave' | 'static';

/** The highlight style chosen in Settings › Lyrics. */
export function useLyricsHighlight(): LyricsHighlight {
  return usePlayPref('lyrics.highlight')[0];
}

/**
 * Settings › Lyrics › "Open lyrics automatically": call on the player screen. Opens the lyrics screen
 * once per song when the song has lyrics, only while the pref is on.
 */
export function useLyricsAutoOpen(track: CatalogTrack | null, hasLyrics: boolean) {
  const [on] = usePlayPref('lyrics.autoOpen');
  const opened = useRef<string | null>(null);
  const id = track?.id ?? null;
  useEffect(() => {
    if (!on || !id || !hasLyrics || opened.current === id) return;
    opened.current = id;
    if (getPlayPref('lyrics.autoOpen')) router.push('/lyrics');
  }, [on, id, hasLyrics]);
}

/**
 * Timed lines + the active line for the current track, on the shared playback clock (interpolated
 * between native ticks, lead/output-delay/Sync offset applied). `seekToLine` makes a line active at once.
 */
function useLyricTiming(lines: LyricLine[]) {
  const { seekTo, track } = usePlayerPick('track');
  const shift = useLyricShift(track?.id);
  const duration = useLoadedDuration(track?.id) || track?.duration || 0;
  const timed = useMemo(() => timedLines(lines, duration), [lines, duration]);
  const bounds = useMemo(() => timed.map((l) => l.time), [timed]);
  const t = useLyricTime(bounds, shift);
  const current = activeLine(timed, t);
  const clock = useLyricAnimatedClock(shift);
  const seekToLine = useCallback((l: TimedLine) => seekTo(seekTargetFor(l.time, shift)), [seekTo, shift]);
  return { timed, current, clock, seekToLine };
}

/* ------------------------------------------------------------------ word fill */

/** The words of the active line, each brightening (and in wave mode lifting) as it is sung. */
function WordFill({
  words,
  clock,
  size,
  lineHeight,
  weight,
  reduce,
  highlight,
  upper,
  center,
}: {
  words: LyricWord[];
  clock: Animated.Value;
  size: number;
  lineHeight: number;
  weight: Weight;
  reduce: boolean;
  highlight: LyricsHighlight;
  upper?: boolean;
  center?: boolean;
}) {
  const base: TextStyle = {
    fontFamily: resolveFont(fontForWeight(weight)),
    fontSize: size,
    lineHeight,
    letterSpacing: -0.5,
    color: colors.text,
  };
  const lift = Math.round(size * 0.16);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: center ? 'center' : 'flex-start' }}>
      {words.map((w, i) => {
        const end = Math.max(w.end, w.time + 0.05);
        const opacity = reduce
          ? clock.interpolate({ inputRange: [w.time - 0.001, w.time], outputRange: [WORD_DIM, 1], extrapolate: 'clamp' })
          : clock.interpolate({ inputRange: [w.time, end], outputRange: [WORD_DIM, 1], extrapolate: 'clamp' });
        const translateY =
          highlight === 'wave' && !reduce
            ? clock.interpolate({ inputRange: [w.time - 0.12, w.time + 0.08, end + 0.3], outputRange: [0, -lift, 0], extrapolate: 'clamp' })
            : 0;
        return (
          <Animated.Text key={i} style={[base, GLOW, { opacity, transform: [{ translateY }] }]}>
            {upper ? w.text.toUpperCase() : w.text}
          </Animated.Text>
        );
      })}
    </View>
  );
}

/* ------------------------------------------------------------------ list view */

type RowState = 'past' | 'active' | 'future';

type RowProps = {
  line: TimedLine;
  index: number;
  state: RowState;
  size: number;
  compact: boolean;
  reduce: boolean;
  highlight: LyricsHighlight;
  clock: Animated.Value | null;
  onSeek: (line: TimedLine) => void;
  onLayout: (index: number, e: LayoutChangeEvent) => void;
  /** Card style (Lyrics screen): highlighted card on the active line, distance fade + blur, optional line underneath. */
  card?: boolean;
  /** Distance in lines from the active one (card style). */
  dist?: number;
  /** Translation / romanization shown under the line (card style). */
  sub?: string;
};

/** A line that is only a section tag, e.g. "[Chorus]" or "(Verse 2)". Real data only: nothing is invented. */
const SECTION_RE = /^[[(]\s*((?:pre-?|post-?)?(?:verse|chorus|bridge|intro|outro|hook|refrain|interlude|breakdown|solo)[^\])]*)[\])]$/i;
const DIST_OPACITY = [1, 0.75, 0.5, 0.32, 0.2];
const DIST_BLUR = [0, 0, 0.8, 1.6, 2.2];

const LyricRow = memo(function LyricRow({ line, index, state, size, compact, reduce, highlight, clock, onSeek, onLayout, card, dist = 0, sub }: RowProps) {
  const on = state === 'active';
  const level = on ? 1 : state === 'past' ? 0 : 0.5; // 0 = past, 0.5 = future, 1 = active
  const anim = useState(() => new Animated.Value(level))[0];
  useEffect(() => {
    if (reduce) return anim.setValue(level);
    const a = Animated.spring(anim, { toValue: level, damping: 20, stiffness: 140, mass: 1, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [anim, level, reduce]);

  const opacity = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [DIM_PAST, DIM_FUTURE, 1] });
  const scale = reduce ? 1 : anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [INACTIVE_SCALE, INACTIVE_SCALE, 1] });
  const lh = Math.round(size * 1.28);
  const empty = !line.text.trim();
  const section = card ? SECTION_RE.exec(line.text.trim())?.[1] : undefined;

  if (section) {
    return (
      <View onLayout={(e) => onLayout(index, e)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 12, paddingHorizontal: 16, opacity: on ? 1 : 0.7 }}>
        <View style={{ width: 18, height: 2, backgroundColor: colors.accentLight }} />
        <T size={11} weight={700} tracking={1.6} color={colors.accentLight}>
          {section.toUpperCase()}
        </T>
      </View>
    );
  }

  const body = (
    <Animated.View style={{ opacity, transform: [{ scale }], transformOrigin: 'left center' }}>
      {on && clock && !empty && highlight !== 'static' ? (
        <WordFill words={line.words} clock={clock} size={size} lineHeight={lh} weight={700} reduce={reduce} highlight={highlight} />
      ) : (
        <T size={size} weight={700} tracking={-0.5} lineHeight={lh} color={colors.text} numberOfLines={compact ? 2 : undefined} style={on ? GLOW : null}>
          {empty ? '♪' : line.text}
        </T>
      )}
      {card && sub && !empty ? (
        <T size={Math.round(size * 0.47)} color="#FFD9A8" lineHeight={Math.round(size * 0.65)} style={{ marginTop: 4 }}>
          {sub}
        </T>
      ) : null}
    </Animated.View>
  );

  if (!card) {
    return (
      <Tap
        accessibilityLabel={`${line.text || 'Instrumental break'}, at ${formatDuration(line.time)}. Tap to jump here.`}
        accessibilityState={{ selected: on }}
        onPress={() => onSeek(line)}
        onLayout={(e) => onLayout(index, e)}
        style={{ paddingVertical: compact ? 4 : 10 }}
      >
        {body}
      </Tap>
    );
  }

  const d = Math.min(DIST_OPACITY.length - 1, dist);
  const blur = reduce ? 0 : DIST_BLUR[d];
  return (
    <Tap
      accessibilityLabel={`${line.text || 'Instrumental break'}${sub ? `. ${sub}` : ''}, at ${formatDuration(line.time)}. Tap to jump here.`}
      accessibilityState={{ selected: on }}
      onPress={() => onSeek(line)}
      onLayout={(e) => onLayout(index, e)}
      style={{ marginVertical: 4 }}
    >
      <View style={[{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: 26, opacity: DIST_OPACITY[d] }, blur ? { filter: [{ blur }] } : null]}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 26, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(colors.white, 0.1), opacity: anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0, 1] }) }]}>
          <LinearGradient colors={[withAlpha(colors.accent, 0.22), withAlpha(colors.accent, 0.04)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
          <LinearGradient colors={[colors.orange, colors.accent]} style={{ position: 'absolute', left: 0, top: 14, bottom: 14, width: 4, borderRadius: 2 }} />
        </Animated.View>
        {body}
      </View>
    </Tap>
  );
});

export type LyricsViewProps = {
  lines: LyricLine[];
  /** Base font size before the active/inactive scaling (default 28; compact 20). */
  size?: number;
  /** Small fixed-height card: shows about three lines, active one centred, no manual scrolling. */
  compact?: boolean;
  /** Height of the compact card (default 3 lines). */
  height?: number;
  /** Word highlight style; defaults to the Settings › Lyrics choice. */
  highlight?: LyricsHighlight;
  /** Rendered below the last line (full mode only), e.g. attribution. */
  footer?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Lyrics-screen card style: highlighted active card, lines fade and blur with distance, section labels. */
  card?: boolean;
  /** Lines shown under each line (translation / romanization), same order and count as `lines`. */
  subLines?: string[] | null;
};

/** Word-synced, auto-following lyrics for the current track. `lines` must be sorted by time. */
export function LyricsView({ lines, size, compact = false, height, highlight: highlightProp, footer, style, card = false, subLines }: LyricsViewProps) {
  const prefHighlight = useLyricsHighlight();
  // Accessibility › Reduce lyric motion: a static line highlight, no word fill, scaling or animated follow.
  const [calmLyrics] = useReduceLyricMotion();
  const highlight = calmLyrics ? 'static' : highlightProp ?? prefHighlight;
  const reduce = useReduceMotion() || calmLyrics;
  const { timed, current, clock, seekToLine } = useLyricTiming(lines);
  const fontSize = size ?? (compact ? 20 : 28);

  const scroll = useRef<ScrollViewInstance>(null);
  const rows = useRef<{ y: number; h: number }[]>([]);
  const [viewport, setViewport] = useState(compact ? (height ?? Math.round(fontSize * 1.28 * 3 + 24)) : 0);
  const followAt = useRef(0);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = compact ? 0.5 : 1 / 3;

  const latest = useRef(current);
  /** Set once the list has been positioned on the active line (later moves animate). */
  const placed = useRef(false);

  /** Scrolls so the line sits at the anchor. Returns false when layout isn't known yet or follow is paused. */
  const follow = useCallback(
    (index: number, animated: boolean) => {
      const r = rows.current[index];
      if (!r || !viewport || Date.now() < followAt.current) return false;
      scroll.current?.scrollTo({ y: Math.max(0, r.y + r.h / 2 - viewport * anchor), animated });
      return true;
    },
    [viewport, anchor],
  );

  useEffect(() => {
    latest.current = current;
    if (current < 0) return;
    if (follow(current, !reduce && placed.current)) placed.current = true;
  }, [current, follow, reduce]);

  useEffect(() => () => void (resumeTimer.current && clearTimeout(resumeTimer.current)), []);

  // Any seek (seek bar, skip, tapping a line elsewhere) ends the "you scrolled" pause and brings the list to the
  // line now playing. Without this the highlight moved but the list stayed put for up to 4 s after a touch.
  const clockStore = usePlaybackClockStore();
  useEffect(() => {
    let last = clockStore.state().seek;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const off = clockStore.subscribe(() => {
      const seek = clockStore.state().seek;
      const fresh = !!seek && seek !== last;
      last = seek;
      if (!fresh) return;
      followAt.current = 0;
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      // `latest` updates once the new line has rendered; follow right after, also when the line didn't change.
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => void follow(latest.current, !reduce), 60);
    });
    return () => {
      off();
      if (settle) clearTimeout(settle);
    };
  }, [clockStore, follow, reduce]);

  const pauseFollow = useCallback(() => {
    followAt.current = Date.now() + FOLLOW_PAUSE_MS;
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
  }, []);
  const scheduleResume = useCallback(() => {
    followAt.current = Date.now() + FOLLOW_PAUSE_MS;
    if (resumeTimer.current) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => {
      followAt.current = 0;
      follow(latest.current, !reduce);
    }, FOLLOW_PAUSE_MS);
  }, [follow, reduce]);

  const onSeek = useCallback(
    (line: TimedLine) => {
      followAt.current = 0;
      if (resumeTimer.current) clearTimeout(resumeTimer.current);
      // The clock jumps synchronously, so the tapped line lights up right away.
      seekToLine(line);
    },
    [seekToLine],
  );
  const onLayout = useCallback(
    (index: number, e: LayoutChangeEvent) => {
      const { y, height: h } = e.nativeEvent.layout;
      rows.current[index] = { y, h };
      // First layout of the active line: jump there without animating.
      if (index === latest.current && !placed.current && follow(index, false)) placed.current = true;
    },
    [follow],
  );

  return (
    <ScrollView
      ref={scroll}
      style={[compact ? { height: viewport } : { flex: 1 }, style]}
      onLayout={compact ? undefined : (e) => setViewport(e.nativeEvent.layout.height)}
      scrollEnabled={!compact}
      onScrollBeginDrag={pauseFollow}
      onScrollEndDrag={scheduleResume}
      onMomentumScrollEnd={scheduleResume}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingTop: viewport * anchor, paddingBottom: viewport * (1 - anchor) }}
    >
      {timed.map((l, i) => (
        <LyricRow
          key={`${l.time}-${i}`}
          line={l}
          index={i}
          state={i === current ? 'active' : i < current ? 'past' : 'future'}
          size={fontSize}
          compact={compact}
          reduce={reduce}
          highlight={highlight}
          clock={i === current ? clock : null}
          onSeek={onSeek}
          onLayout={onLayout}
          card={card}
          dist={card ? (current < 0 ? i + 1 : Math.abs(i - current)) : 0}
          sub={subLines?.[i]}
        />
      ))}
      {!compact && footer ? footer : null}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ focus mode */

/** Synced timing + the active line, with line jumps (focus mode). */
export function useSyncedLyrics(lines: LyricLine[]) {
  const [calmLyrics] = useReduceLyricMotion();
  const reduce = useReduceMotion() || calmLyrics;
  const { timed, current, clock, seekToLine } = useLyricTiming(lines);
  const seekLine = useCallback(
    (i: number) => {
      const l = timed[Math.max(0, Math.min(timed.length - 1, i))];
      if (l) seekToLine(l);
    },
    [timed, seekToLine],
  );
  return { timed, current, clock, reduce, seekLine };
}

const RIPPLES = [0, 1, 2];

/** Three rings that expand from the centre whenever the line changes. */
function Ripples({ trigger, reduce }: { trigger: number; reduce: boolean }) {
  const [vals] = useState(() => RIPPLES.map(() => new Animated.Value(0)));
  useEffect(() => {
    if (reduce) return;
    vals.forEach((v) => v.setValue(0));
    const a = Animated.stagger(
      220,
      vals.map((v) => Animated.timing(v, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true })),
    );
    a.start();
    return () => a.stop();
  }, [trigger, reduce, vals]);
  if (reduce) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      {vals.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: 120,
            height: 120,
            borderRadius: 60,
            borderWidth: 1.5,
            borderColor: withAlpha(colors.accent, 0.6),
            opacity: v.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 0.6, 0] }),
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 3] }) }],
          }}
        />
      ))}
    </View>
  );
}

/**
 * Focus mode: the active line alone, big and uppercase, with the previous and next lines faint above
 * and below. The new line rises in and the ripple rings pulse on every line change.
 */
export function LyricsFocusView({ synced, highlight: highlightProp = 'fill', size = 40 }: { synced: ReturnType<typeof useSyncedLyrics>; highlight?: LyricsHighlight; size?: number }) {
  const { timed, current, clock, reduce, seekLine } = synced;
  const [calmLyrics] = useReduceLyricMotion();
  const highlight: LyricsHighlight = calmLyrics ? 'static' : highlightProp;
  const enter = useState(() => new Animated.Value(1))[0];
  useEffect(() => {
    if (reduce) return enter.setValue(1);
    enter.setValue(0);
    const a = Animated.spring(enter, { toValue: 1, damping: 18, stiffness: 160, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [current, reduce, enter]);

  const line = current >= 0 ? timed[current] : undefined;
  const prev = current > 0 ? timed[current - 1] : undefined;
  const next = timed[current + 1];
  const lh = Math.round(size * 1.15);
  const empty = !line || !line.text.trim();

  const side = (l: TimedLine | undefined, i: number, label: string) =>
    l ? (
      <Tap accessibilityLabel={`${label}: ${l.text || 'Instrumental break'}. Tap to jump here.`} onPress={() => seekLine(i)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
        <T variant="headlineLight" size={20} align="center" color={colors.textSecondary} numberOfLines={2} style={{ opacity: 0.6 }}>
          {l.text.trim() || '♪'}
        </T>
      </Tap>
    ) : (
      <View style={{ minHeight: 44 }} />
    );

  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: 28 }}>
      {side(prev, current - 1, 'Previous line')}
      <View style={{ minHeight: lh * 3, justifyContent: 'center' }}>
        <Ripples trigger={current} reduce={reduce} />
        <Animated.View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={empty ? (current < 0 ? 'Waiting for the first line' : 'Instrumental break') : line.text}
          style={{
            opacity: enter,
            transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }, { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
          }}
        >
          {empty ? (
            <T size={size} weight={300} align="center" color={colors.textSecondary}>
              ♪
            </T>
          ) : highlight === 'static' ? (
            <T size={size} weight={800} align="center" lineHeight={lh} tracking={-0.5} style={GLOW}>
              {line.text.toUpperCase()}
            </T>
          ) : (
            <WordFill words={line.words} clock={clock} size={size} lineHeight={lh} weight={800} reduce={reduce} highlight={highlight} upper center />
          )}
        </Animated.View>
      </View>
      {side(next, current + 1, 'Next line')}
    </View>
  );
}

/* ------------------------------------------------------------------ play button with progress ring */

/** Accent play/pause button wrapped in a thin ring that fills with track progress. */
export function PlayRing({ size = 64 }: { size?: number }) {
  const { playing, toggle } = usePlayerPick('playing');
  const { progress } = usePlaybackProgress();
  const stroke = 2;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const inner = size - 16;
  return (
    <Tap accessibilityLabel={playing ? 'Pause' : 'Play'} onPress={toggle} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.chipOutline} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.accent}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(1, progress)))}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={{ width: inner, height: inner, borderRadius: inner / 2, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', shadowColor: colors.accent, shadowOpacity: 0.55, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } }}>
        <Icon name={playing ? 'pause' : 'play'} size={24} color={colors.onAccent} filled glow={false} />
      </View>
    </Tap>
  );
}

/* ------------------------------------------------------------------ shared loader */

type Loaded = { id: string; lyrics: Lyrics | null };
type Transformed = { key: string; res: AiResult<string[]> } | null;

/** True when the lyrics carry at least one sung word (not just instrumental markers). */
export const hasWords = (l: Lyrics | null | undefined) => !!l && (l.synced.some((x) => x.text.trim()) || l.plain.some((x) => x.trim()));

export type TrackLyrics = {
  /** Fetch state (keyed by track id, so a stale track's lyrics are never shown). */
  lyr: AsyncState<Loaded>;
  /** `undefined` while loading, `null` when LRCLIB has nothing. */
  lyrics: Lyrics | null | undefined;
  ready: boolean;
  ai: AsyncState<Transformed>;
  /** The AI result for the current view/target, once loaded. */
  result: AiResult<string[]> | undefined;
  aiLoading: boolean;
  /** Replacement line texts (same count/order as the source), or null for the original. */
  aiLines: string[] | null;
};

/** Loads LRCLIB lyrics for `track` and, for translate/romanize views, the AI-transformed lines. */
export function useTrackLyrics(track: CatalogTrack | null, view: LyricsMode, target: string): TrackLyrics {
  const trackId = track?.id ?? '';
  const { lyr, lyrics } = useLyricsForTrack(track);
  const ready = hasWords(lyrics);
  const key = `${trackId}|${view}|${view === 'translate' ? target : ''}`;
  const ai = useAsync<Transformed>(async () => (view === 'original' || !lyrics || !ready ? null : { key, res: await transformLyrics(trackId, lyrics, view, target) }), [key, ready]);
  const result = ai.data?.key === key ? ai.data.res : undefined;
  const aiLoading = view !== 'original' && ready && (ai.loading || !result) && !ai.error;
  const aiLines = view !== 'original' && result?.ok ? result.data : null;
  return { lyr, lyrics, ready, ai, result, aiLoading, aiLines };
}

/** Synced lines with translated/romanized text swapped in (line timing kept; word timing re-estimated). */
export function displaySynced(lyrics: Lyrics | null | undefined, aiLines: string[] | null): LyricLine[] | null {
  if (!lyrics?.synced.length) return null;
  if (!aiLines) return lyrics.synced;
  return lyrics.synced.map((l, i) => ({ time: l.time, text: aiLines[i] ?? l.text }));
}
