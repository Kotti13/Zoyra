import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { art, colors, withAlpha } from '../theme/tokens';
import { springy, useReduceMotion } from './motion';
import { T } from './primitives';

const BARS = [22, 42, 60, 36, 18];

/** One expanding outline ring behind the mark (keyframes `zRing`: scale .7 → 2.8, fade .5 → 0, 2.4 s). */
function Ring({ size, color, delay, run }: { size: number; color: string; delay: number; run: boolean }) {
  const t = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (!run) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 2400, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    const id = setTimeout(() => loop.start(), delay);
    return () => {
      clearTimeout(id);
      loop.stop();
    };
  }, [run, t, delay]);
  if (!run) return null;
  const s = size / 96;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: 36 * s,
        borderWidth: 3 * s,
        borderColor: color,
        opacity: t.interpolate({ inputRange: [0, 0.01, 1], outputRange: [0, 0.5, 0] }),
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.7, 2.8] }) }],
      }}
    />
  );
}

/**
 * The Zoyra mark: 96 px cyan→violet tile with five white equalizer bars (matches the native splash image).
 * `animated` pulses the bars; `rings` adds the expanding cyan/violet rings; `pop` plays the entrance pop
 * then a gentle float. All motion is skipped with Reduce Motion.
 */
export function ZoyraMark({ size = 96, animated, rings, pop }: { size?: number; animated?: boolean; rings?: boolean; pop?: boolean }) {
  const s = size / 96;
  const reduce = useReduceMotion();
  const pulse = useState(() => BARS.map(() => new Animated.Value(1)))[0];
  const enter = useState(() => new Animated.Value(pop ? 0 : 1))[0];
  const float = useState(() => new Animated.Value(0))[0];

  useEffect(() => {
    if (!animated || reduce) return;
    const loops = pulse.map((v) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: 0.4, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(v, { toValue: 1, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      ),
    );
    const ids = loops.map((l, i) => setTimeout(() => l.start(), i * 150));
    return () => {
      ids.forEach(clearTimeout);
      loops.forEach((l) => l.stop());
    };
  }, [animated, reduce, pulse]);

  useEffect(() => {
    if (!pop) return;
    if (reduce) {
      enter.setValue(1);
      return;
    }
    // zPop (.9 s, spring curve) then zFloat (3.2 s loop, 8 px).
    const floatLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(float, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(float, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    const a = Animated.sequence([Animated.timing(enter, { toValue: 1, duration: 900, easing: springy, useNativeDriver: true }), Animated.delay(100)]);
    a.start(({ finished }) => finished && floatLoop.start());
    return () => {
      a.stop();
      floatLoop.stop();
    };
  }, [pop, reduce, enter, float]);

  const transform = pop
    ? [
        { translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -8 * s] }) },
        { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) },
        { rotate: enter.interpolate({ inputRange: [0, 1], outputRange: ['-14deg', '0deg'] }) },
      ]
    : [];

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {rings ? (
        <>
          <Ring size={size} color={colors.accentLight} delay={0} run={!reduce} />
          <Ring size={size} color={colors.violet} delay={1200} run={!reduce} />
        </>
      ) : null}
      <Animated.View
        style={[
          { borderRadius: 36 * s, shadowColor: colors.accent, shadowOpacity: 0.5, shadowRadius: 20 * s, shadowOffset: { width: 0, height: 0 }, elevation: 12 },
          { opacity: pop ? enter.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }) : 1, transform },
        ]}
      >
        <LinearGradient
          colors={art.logo}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: size, height: size, borderRadius: 36 * s, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 * s }}
        >
          {BARS.map((h, i) => (
            <Animated.View key={i} style={{ width: 7 * s, height: h * s, borderRadius: 4 * s, backgroundColor: colors.white, transform: [{ scaleY: pulse[i] }] }} />
          ))}
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

/* ------------------------------------------------------------------ cinematic splash scene */

export type SplashMode = 'launch' | 'full';

/** Mock tile is 112 px; the native splash image is 96 px wide (app.json `expo-splash-screen.imageWidth`). */
const TILE = 112;
const TILE_R = 38;
const NATIVE_TILE = 96;
const TS = TILE / 96;
const WORD = ['Z', 'O', 'Y', 'R', 'A'] as const;
const WORD_SIZE = 46;
/** Letter tracking animates from .7em to .2em (keyframes `sTrack`). */
const TRACK_END = WORD_SIZE * 0.2;
const TRACK_START = WORD_SIZE * 0.7;

const curve = Easing.bezier(0.2, 0.8, 0.2, 1);
const wave = Easing.inOut(Easing.sin);
const rippleEase = Easing.out(Easing.quad);
const linear = Easing.linear;

type Span = readonly [delay: number, duration: number];
type Timeline = Record<'pop' | 'letters' | 'track' | 'shine' | 'tag' | 'beam' | 'fade', Span>;

/**
 * `full` follows the 7 s mock (played once). `launch` compresses the same intro into ~1.5 s so app start
 * never waits on the animation; the loops (bars, ripples, glow, floor) keep running while the app loads.
 */
const TIMELINES: Record<SplashMode, Timeline> = {
  full: { pop: [0, 1120], letters: [1120, 840], track: [1120, 1260], shine: [2380, 1120], tag: [2660, 700], beam: [560, 1820], fade: [0, 420] },
  launch: { pop: [60, 650], letters: [260, 520], track: [260, 760], shine: [1000, 600], tag: [760, 420], beam: [120, 820], fade: [100, 400] },
};

/** Deterministic pseudo-random sequence so the equalizer floor looks the same on every launch. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

type Bar = { h: number; period: number; phase: number; alpha: number };

const FLOOR: Bar[] = (() => {
  const r = seeded(7);
  return Array.from({ length: 40 }, (_, i) => ({ h: 30 + r() * 40, period: 800 + r() * 850, phase: r(), alpha: 0.25 + 0.6 * (1 - Math.abs(i - 19.5) / 19.5) }));
})();

const TILE_PERIODS = [1210, 1300, 1270, 910, 1370];
const TILE_PHASES = [0.61, 0.72, 0.72, 0.52, 0.47];
const TILE_BARS: Bar[] = BARS.map((h, i) => ({ h: h * TS, period: TILE_PERIODS[i], phase: TILE_PHASES[i], alpha: 1 }));

/**
 * A native-driver loop on 0..1 that starts part-way through its cycle (CSS negative `animation-delay`).
 * `yoyo` goes 0 → 1 → 0 each period; otherwise 0 → 1 then jumps back.
 */
function useCycle(run: boolean, period: number, phase: number, yoyo: boolean, easing: (t: number) => number) {
  const v = useState(() => new Animated.Value(yoyo ? 1 : 0))[0];
  useEffect(() => {
    if (!run) return;
    const to = (value: number, duration: number) => Animated.timing(v, { toValue: value, duration, easing, useNativeDriver: true });
    let anim: Animated.CompositeAnimation;
    if (yoyo) {
      const half = period / 2;
      const cycle = Animated.loop(Animated.sequence([to(1, half), to(0, half)]));
      if (phase < 0.5) {
        v.setValue(phase * 2);
        anim = Animated.sequence([to(1, (0.5 - phase) * period), to(0, half), cycle]);
      } else {
        v.setValue(2 - phase * 2);
        anim = Animated.sequence([to(0, (1 - phase) * period), cycle]);
      }
    } else {
      v.setValue(phase);
      anim = Animated.sequence([to(1, (1 - phase) * period), Animated.loop(Animated.sequence([to(0, 0), to(1, period)]))]);
    }
    anim.start();
    return () => anim.stop();
  }, [run, v, period, phase, yoyo, easing]);
  return v;
}

/** One expanding ripple ring around the tile (keyframes `sRipple`: scale .7 → 3, fade .55 → 0, 3.2 s). */
function Ripple({ phase, run }: { phase: number; run: boolean }) {
  const t = useCycle(run, 3200, phase, false, rippleEase);
  if (!run) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: TILE,
        height: TILE,
        borderRadius: TILE_R,
        borderWidth: 1.5,
        borderColor: withAlpha(colors.accentLight, 0.8),
        opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
        transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.7, 3] }) }],
      }}
    />
  );
}

/** One white equalizer bar inside the tile (keyframes `sBars`). Rests at the native splash height. */
function TileBar({ bar, run }: { bar: Bar; run: boolean }) {
  const v = useCycle(run, bar.period, bar.phase, true, wave);
  const scaleY = run ? v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.12] }) : 1;
  return <Animated.View style={{ width: 7 * TS, height: bar.h, borderRadius: 4 * TS, backgroundColor: colors.white, transform: [{ scaleY }] }} />;
}

/** One bar of the red equalizer floor (keyframes `sFloor`, scale from the bottom edge). */
function FloorBar({ bar, run }: { bar: Bar; run: boolean }) {
  const v = useCycle(run, bar.period, bar.phase, true, wave);
  const scaleY = run ? v.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) : 0.6;
  return (
    <Animated.View style={{ flex: 1, height: bar.h, opacity: bar.alpha, transformOrigin: 'bottom', transform: [{ scaleY }] }}>
      <LinearGradient colors={[colors.accent, withAlpha(colors.accent, 0)]} start={{ x: 0, y: 1 }} end={{ x: 0, y: 0 }} style={{ flex: 1, borderRadius: 2 }} />
    </Animated.View>
  );
}

/** Soft breathing glow behind the tile (keyframes `sGlow`: opacity .6 ↔ 1, scale 1 ↔ 1.15, 3.6 s). */
function TileGlow({ cy, width, run }: { cy: number; width: number; run: boolean }) {
  const v = useCycle(run, 3600, 0, true, wave);
  const d = 340;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: width / 2 - d / 2,
        top: cy - d / 2,
        width: d,
        height: d,
        opacity: run ? v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) : 0.8,
        transform: [{ scale: run ? v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) : 1 }],
      }}
    >
      <Svg width={d} height={d}>
        <Defs>
          <RadialGradient id="splashTileGlow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={colors.accentLight} stopOpacity={0.5} />
            <Stop offset="0.4" stopColor={colors.accentLight} stopOpacity={0.28} />
            <Stop offset="0.75" stopColor={colors.accentLight} stopOpacity={0.06} />
            <Stop offset="1" stopColor={colors.accentLight} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={d / 2} cy={d / 2} r={d / 2} fill="url(#splashTileGlow)" />
      </Svg>
    </Animated.View>
  );
}

/** The logo tile itself: red→orange gradient (same as the native splash image), top sheen, five live bars. */
function Tile({ run }: { run: boolean }) {
  return (
    <LinearGradient
      colors={art.logo}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: TILE, height: TILE, borderRadius: TILE_R, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 * TS, overflow: 'hidden' }}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[withAlpha(colors.white, 0.28), withAlpha(colors.white, 0)]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: TILE / 2 }}
      />
      {TILE_BARS.map((b, i) => (
        <TileBar key={i} bar={b} run={run} />
      ))}
    </LinearGradient>
  );
}

type Intro = Record<keyof Timeline, Animated.Value>;

/**
 * The cinematic splash artboard: radial red backdrop, light-beam sweep, logo pop with ripples and glow,
 * "ZOYRA" wordmark with letter-tracking + shine, tagline, red equalizer floor and the loading bar.
 * `progress` (0..1, native driver) is owned by the caller. `onStart` fires once layout is final and the
 * intro has started (the launch overlay hides the native splash there). Reduce Motion shows the final frame.
 */
export function SplashScene({ mode, progress, onStart, children }: { mode: SplashMode; progress: Animated.Value; onStart?: () => void; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reduce = useReduceMotion();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const intro = useState<Intro>(() => ({
    pop: new Animated.Value(0),
    letters: new Animated.Value(0),
    track: new Animated.Value(0),
    shine: new Animated.Value(0),
    tag: new Animated.Value(0),
    beam: new Animated.Value(0),
    fade: new Animated.Value(0),
  }))[0];
  const animRef = useRef<Animated.CompositeAnimation | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
  }, []);

  // Start the intro once, as soon as the real layout is known.
  useEffect(() => {
    if (!size || animRef.current) return;
    const keys = Object.keys(intro) as (keyof Intro)[];
    let a: Animated.CompositeAnimation;
    if (reduce) {
      keys.forEach((k) => intro[k].setValue(k === 'shine' || k === 'beam' ? 0 : 1));
      a = Animated.delay(0);
    } else {
      const tl = TIMELINES[mode];
      a = Animated.parallel(
        keys.map((k) =>
          Animated.timing(intro[k], {
            toValue: 1,
            delay: tl[k][0],
            duration: tl[k][1],
            easing: k === 'pop' || k === 'letters' ? curve : k === 'beam' || k === 'shine' ? Easing.inOut(Easing.ease) : Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ),
      );
    }
    a.start();
    animRef.current = a;
    onStart?.();
  }, [size, intro, reduce, mode, onStart]);

  useEffect(() => () => animRef.current?.stop(), []);

  const W = size?.width ?? window.width;
  const H = size?.height ?? window.height;
  const live = !reduce && size !== null;

  // Mock: tile centre at 330/844, kept clear of the floor + loading bar on short screens.
  const logoY = Math.max(insets.top + TILE, Math.min(H * 0.39, H - insets.bottom - 410));
  const wordTop = logoY + TILE / 2 + 34;
  const bgR = Math.hypot(W / 2, Math.max(logoY, H - logoY));
  const barW = Math.max(0, W - 120);

  const { pop, letters, track, shine, tag, beam, fade } = intro;
  const launch = mode === 'launch';
  const fromY = launch ? H / 2 - logoY : 0; // launch: start exactly where the native splash image sits
  const fromScale = launch ? NATIVE_TILE / TILE : 0.45;

  const logoStyle = {
    opacity: launch ? 1 : pop.interpolate({ inputRange: [0, 0.69, 1], outputRange: [0, 1, 1] }),
    transform: [
      { translateY: pop.interpolate({ inputRange: [0, 0.69, 1], outputRange: [fromY, 0, 0] }) },
      { scale: pop.interpolate({ inputRange: [0, 0.69, 1], outputRange: [fromScale, 1.1, 1] }) },
      { rotate: pop.interpolate({ inputRange: [0, 0.69, 1], outputRange: launch ? ['0deg', '2deg', '0deg'] : ['-10deg', '3deg', '0deg'] }) },
    ],
  };
  // Blur stand-in (CSS `filter: blur(14px)` can't run on the native driver): soft ghost copies of the tile
  // that collapse into it during the pop.
  const ghost = (spread: number) => ({
    opacity: pop.interpolate(launch ? { inputRange: [0, 0.5, 1], outputRange: [0.4, 0, 0] } : { inputRange: [0, 0.3, 0.69, 1], outputRange: [0, 0.4, 0, 0] }),
    transform: [{ scale: pop.interpolate(launch ? { inputRange: [0, 0.5, 1], outputRange: [1, spread, spread] } : { inputRange: [0, 0.69, 1], outputRange: [spread, 1, 1] }) }],
  });

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, overflow: 'hidden' }]} onLayout={onLayout}>
      {/* radial-gradient(circle at 50% 42%, red .45, deep red .35 38%, transparent 70%) */}
      <Svg width={W} height={H} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <RadialGradient id="splashBg" cx={W / 2} cy={logoY} r={bgR} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={colors.accent} stopOpacity={0.45} />
            <Stop offset="0.38" stopColor={art.red[1]} stopOpacity={0.35} />
            <Stop offset="0.7" stopColor={art.red[1]} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={W} height={H} fill="url(#splashBg)" />
      </Svg>
      <TileGlow cy={logoY} width={W} run={live} />

      {/* Light beam sweep (keyframes `sBeam`). */}
      {reduce ? null : (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: -H * 0.1,
            height: H * 1.2,
            width: 110,
            left: W / 2 - 55,
            opacity: beam.interpolate({ inputRange: [0, 0.23, 1], outputRange: [0, 0.9, 0] }),
            transform: [{ translateX: beam.interpolate({ inputRange: [0, 1], outputRange: [-W * 0.75, W * 0.75] }) }, { skewX: '-20deg' }],
          }}
        >
          <LinearGradient
            colors={[withAlpha(colors.white, 0), withAlpha(colors.white, 0.16), withAlpha(colors.white, 0)]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      )}

      {/* Ripples + tile, centred on logoY. */}
      <View pointerEvents="none" style={{ position: 'absolute', left: W / 2 - TILE / 2, top: logoY - TILE / 2, width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', opacity: pop.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0, 0, 1] }) }]}>
          {[0, 0.34, 0.67].map((p) => (
            <Ripple key={p} phase={p} run={live} />
          ))}
        </Animated.View>
        <Animated.View style={logoStyle}>
          {reduce ? null : (
            <>
              <Animated.View style={[StyleSheet.absoluteFill, ghost(1.45)]}>
                <Tile run={false} />
              </Animated.View>
              <Animated.View style={[StyleSheet.absoluteFill, ghost(1.2)]}>
                <Tile run={false} />
              </Animated.View>
            </>
          )}
          <View style={{ borderRadius: TILE_R, shadowColor: colors.accent, shadowOpacity: 0.7, shadowRadius: 30, shadowOffset: { width: 0, height: 0 }, elevation: 16 }}>
            <Tile run={live} />
          </View>
        </Animated.View>
      </View>

      {/* Wordmark + tagline. */}
      <View style={{ position: 'absolute', left: 0, right: 0, top: wordTop, alignItems: 'center', gap: 14 }}>
        <View accessible accessibilityRole="header" accessibilityLabel="Zoyra" style={{ flexDirection: 'row', paddingVertical: 4 }}>
          {WORD.map((ch, i) => {
            const c = 0.1 + i * 0.2;
            return (
              <Animated.View
                key={ch}
                importantForAccessibility="no-hide-descendants"
                style={{
                  marginHorizontal: TRACK_END / 2,
                  opacity: letters,
                  transform: [
                    { translateX: track.interpolate({ inputRange: [0, 1], outputRange: [(i - 2) * (TRACK_START - TRACK_END), 0] }) },
                    { translateY: letters.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) },
                  ],
                }}
              >
                <T variant="displayLight" size={WORD_SIZE} weight={200} tracking={0}>
                  {ch}
                </T>
                {/* Shine: a glow copy of each letter that flares in a wave from Z to A (keyframes `sShine`). */}
                <Animated.View
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, { opacity: shine.interpolate({ inputRange: [c - 0.2, c, c + 0.2], outputRange: [0, 1, 0], extrapolate: 'clamp' }) }]}
                >
                  <T
                    variant="displayLight"
                    size={WORD_SIZE}
                    weight={200}
                    tracking={0}
                    color={colors.white}
                    style={{ textShadowColor: colors.accentLight, textShadowRadius: 14, textShadowOffset: { width: 0, height: 0 } }}
                  >
                    {ch}
                  </T>
                </Animated.View>
              </Animated.View>
            );
          })}
        </View>
        <Animated.View style={{ opacity: tag, transform: [{ translateY: tag.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
          <T size={15} weight={300} tracking={4.8} color={colors.textSecondary} style={{ textTransform: 'uppercase' }}>
            Your sound · Your world
          </T>
        </Animated.View>
      </View>

      {/* Red equalizer floor (keyframes `sFloor`). */}
      <Animated.View
        pointerEvents="none"
        style={{ position: 'absolute', left: 20, right: 20, bottom: 150 + insets.bottom, height: 70, flexDirection: 'row', alignItems: 'flex-end', gap: 4, opacity: fade }}
      >
        {FLOOR.map((b, i) => (
          <FloorBar key={i} bar={b} run={live} />
        ))}
      </Animated.View>

      {/* Loading bar. */}
      <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 60, right: 60, bottom: 96 + insets.bottom, alignItems: 'center', gap: 12, opacity: fade }}>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Loading your sound"
          style={{ width: '100%', height: 3, borderRadius: 2, backgroundColor: colors.hairline, overflow: 'hidden' }}
        >
          <Animated.View
            style={{
              width: barW,
              height: 3,
              borderRadius: 2,
              shadowColor: colors.accent,
              shadowOpacity: 1,
              shadowRadius: 7,
              shadowOffset: { width: 0, height: 0 },
              transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-barW, 0], extrapolate: 'clamp' }) }],
            }}
          >
            <LinearGradient colors={[colors.accent, colors.accentLight]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1, borderRadius: 2 }} />
          </Animated.View>
        </View>
        <T mono size={11} tracking={2.75} color={colors.textTertiary}>
          LOADING YOUR SOUND
        </T>
      </Animated.View>

      {children}
    </View>
  );
}

/**
 * Launch splash overlay (design: "Splash" artboard), mounted by `LaunchSplash` in the root layout.
 * Picks up exactly where the native splash leaves off (same background, the 96 px tile at screen centre),
 * pops the tile up into the designed layout and plays the intro in ~1.5 s. The bars, ripples, glow and
 * floor keep moving while the app loads; `done` fills the bar to 100% and calls `onFinish` after a quick fade.
 */
export function SplashView({ done = false, onReady, onFinish }: { done?: boolean; onReady?: () => void; onFinish?: () => void }) {
  const reduce = useReduceMotion();
  const progress = useState(() => new Animated.Value(0))[0];
  const exit = useState(() => new Animated.Value(1))[0];
  const [started, setStarted] = useState(false);

  const onStart = useCallback(() => {
    setStarted(true);
    onReady?.(); // layout is final and the tile sits at the native splash position → safe to hide the native splash
    Animated.timing(progress, { toValue: 0.8, duration: reduce ? 0 : 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [onReady, progress, reduce]);

  useEffect(() => {
    if (!done || !started) return;
    const a = Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: reduce ? 0 : 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(exit, { toValue: 0, duration: reduce ? 160 : 260, delay: 60, easing: linear, useNativeDriver: true }),
    ]);
    a.start(({ finished }) => {
      if (finished) onFinish?.();
    });
    return () => a.stop();
  }, [done, started, progress, exit, onFinish, reduce]);

  const content = useMemo(() => <SplashScene mode="launch" progress={progress} onStart={onStart} />, [progress, onStart]);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, opacity: exit }]} accessibilityLabel="Zoyra is loading" accessible>
      {content}
    </Animated.View>
  );
}
