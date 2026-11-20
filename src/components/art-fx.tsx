/**
 * Decorative, UI-thread-only motion shared by Now Playing, the mini player and Lyrics:
 * equaliser bars, a light streak sweeping across artwork, drifting colour light and rising sparks.
 * Everything uses RN Animated with the native driver, runs only while `active`, and is static with Reduce Motion.
 * None of it is audio analysis.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, withAlpha } from '../theme/tokens';
import { useReduceMotion } from './motion';

/** A looping 0..1 value (restarts from 0 each cycle); stopped when inactive or Reduce Motion is on. */
export function useLoop(active: boolean, periodMs: number, opts?: { pingPong?: boolean; delay?: number; easing?: (t: number) => number }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  const pingPong = opts?.pingPong ?? false;
  const delay = opts?.delay ?? 0;
  const easing = opts?.easing ?? Easing.linear;
  useEffect(() => {
    if (!active || reduce) {
      v.stopAnimation();
      return;
    }
    const step = (to: number, d: number) => Animated.timing(v, { toValue: to, duration: d, easing, useNativeDriver: true });
    const anim = Animated.loop(pingPong ? Animated.sequence([step(1, periodMs / 2), step(0, periodMs / 2)]) : Animated.sequence([step(1, periodMs), Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true })]));
    const t = setTimeout(() => anim.start(), delay);
    return () => {
      clearTimeout(t);
      anim.stop();
    };
  }, [active, reduce, periodMs, pingPong, delay, easing, v]);
  return v;
}

const EQ_PERIODS = [620, 780, 540, 700, 860, 580];

function EqBar({ active, i, height, width, color }: { active: boolean; i: number; height: number; width: number; color: string }) {
  const v = useLoop(active, EQ_PERIODS[i % EQ_PERIODS.length], { pingPong: true, delay: i * 70, easing: Easing.inOut(Easing.sin) });
  return (
    <Animated.View
      style={{
        width,
        height,
        borderRadius: width / 2,
        backgroundColor: color,
        transformOrigin: 'bottom',
        transform: [{ scaleY: v.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] }) }],
      }}
    />
  );
}

/** Small bouncing equaliser (bars rest at a low height when paused). */
export function EqBars({ active, bars = 4, height = 14, barWidth = 3, color = colors.white, style }: { active: boolean; bars?: number; height?: number; barWidth?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={[{ flexDirection: 'row', alignItems: 'flex-end', gap: Math.max(1, barWidth - 1), height }, style]}>
      {Array.from({ length: bars }, (_, i) => (
        <EqBar key={i} active={active} i={i} height={height} width={barWidth} color={color} />
      ))}
    </View>
  );
}

/** A soft diagonal light streak that glides across its (overflow-hidden) parent every few seconds. */
export function LightSweep({ active, width, periodMs = 5500, opacity = 0.35 }: { active: boolean; width: number; periodMs?: number; opacity?: number }) {
  const v = useLoop(active, periodMs, { easing: Easing.inOut(Easing.quad) });
  const streak = Math.max(16, width * 0.3);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        width: streak,
        // Rests off the left edge for the first ~45 % of each cycle, then sweeps across.
        transform: [{ translateX: v.interpolate({ inputRange: [0, 0.45, 1], outputRange: [-streak * 1.5, -streak * 1.5, width + streak] }) }, { skewX: '-18deg' }],
      }}
    >
      <LinearGradient colors={[withAlpha(colors.white, 0), withAlpha(colors.white, opacity), withAlpha(colors.white, 0)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

/** Big blurred-looking colour light that drifts slowly (radial fade, no blur filter). */
export function DriftOrb({ size, color, style, periodMs = 10_000, reverse, active = true }: { size: number; color: string; style?: StyleProp<ViewStyle>; periodMs?: number; reverse?: boolean; active?: boolean }) {
  const v = useLoop(active, periodMs, { pingPong: true, easing: Easing.inOut(Easing.sin) });
  const k = reverse ? -1 : 1;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', width: size, height: size, borderRadius: size / 2, overflow: 'hidden' },
        style,
        { transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, 30 * k] }) }, { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -24 * k] }) }] },
      ]}
    >
      <LinearGradient colors={[color, withAlpha(color, 0)]} start={{ x: 0.5, y: 0.5 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

const SPARKS = Array.from({ length: 12 }, (_, i) => ({
  left: `${(i * 29 + 7) % 96}%` as const,
  bottom: 40 + ((i * 53) % 260),
  size: 2 + (i % 3),
  period: 6000 + (i % 5) * 1000,
  delay: (i * 1300) % 7000,
}));

function Spark({ s, active }: { s: (typeof SPARKS)[number]; active: boolean }) {
  const v = useLoop(active, s.period, { delay: s.delay });
  return (
    <Animated.View
      style={{
        position: 'absolute',
        left: s.left,
        bottom: s.bottom,
        width: s.size,
        height: s.size,
        borderRadius: s.size / 2,
        backgroundColor: '#FFD9A8',
        opacity: v.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.9, 0] }),
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -300] }) }],
      }}
    />
  );
}

/** Warm sparks rising through the background. */
export function Sparks({ active = true }: { active?: boolean }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {SPARKS.map((s, i) => (
        <Spark key={i} s={s} active={active} />
      ))}
    </View>
  );
}

/** Drifting orange/red light + sparks, used as an `underlay` behind Now Playing and Lyrics. */
export function GlowBackdrop({ active = true, plain = false }: { active?: boolean; plain?: boolean }) {
  // `plain`: only the rising sparks, on whatever background the screen already has (no gradient or glow blobs),
  // so a full-bleed image above it can fade into one continuous background.
  if (plain) return <Sparks active={active} />;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={[withAlpha(colors.accent, 0.3), '#0A0A0A', '#0A0A0A']} locations={[0, 0.55, 1]} style={StyleSheet.absoluteFill} />
      <DriftOrb size={380} color={withAlpha('#FF8A3D', 0.5)} style={{ left: -110, top: -40 }} periodMs={10_000} active={active} />
      <DriftOrb size={400} color={withAlpha(colors.accent, 0.55)} style={{ right: -130, top: 320 }} periodMs={13_000} reverse active={active} />
      <Sparks active={active} />
    </View>
  );
}
