import { memo, useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Ellipse, Line, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useIsFocused } from 'expo-router';

import { colors, withAlpha } from '../theme/tokens';
import { useReduceMotion } from './motion';

/** One radial "mesh" glow: CSS `radial-gradient(ellipse at X% Y%, color, transparent stop%)`. */
export type Glow = { x: number; y: number; color: string; opacity: number; stop?: number };
export type BackdropPattern = 'dots' | 'lines' | 'grid' | 'none';

/**
 * Mesh presets from the "Backgrounds" section of the Components board (cinematic theme).
 * The original coral-era names are kept so every screen keeps working; each now maps to its cinematic mesh.
 */
export const meshes = {
  /** Red mesh: red top-left, orange right (Home, Login, Settings). */
  coral: [
    { x: 0.1, y: 0, color: colors.accent, opacity: 0.45, stop: 0.55 },
    { x: 1, y: 0.35, color: colors.violet, opacity: 0.18, stop: 0.5 },
  ],
  /** Ember mesh: orange top-right, red left (Search, Update). */
  amber: [
    { x: 0.9, y: 0, color: colors.violet, opacity: 0.38, stop: 0.55 },
    { x: 0, y: 0.4, color: colors.accent, opacity: 0.2, stop: 0.55 },
  ],
  /** Rose slot: deep red top-centre, red left (Library). */
  rose: [
    { x: 0.5, y: 0, color: colors.indigo, opacity: 0.34, stop: 0.55 },
    { x: 0, y: 0.6, color: colors.accent, opacity: 0.22, stop: 0.55 },
  ],
  /** Amber mesh: amber top-right, deep red left. */
  amberRose: [
    { x: 1, y: 0, color: colors.amber, opacity: 0.28, stop: 0.55 },
    { x: 0, y: 0.3, color: colors.indigo, opacity: 0.2, stop: 0.55 },
  ],
  /** Gold mesh: gold top-left, red right. */
  peach: [
    { x: 0, y: 0, color: colors.sky, opacity: 0.32, stop: 0.55 },
    { x: 1, y: 0.5, color: colors.accent, opacity: 0.25, stop: 0.55 },
  ],
  /** Green mesh: green top-right, orange left. */
  gold: [
    { x: 1, y: 0, color: colors.success, opacity: 0.32, stop: 0.55 },
    { x: 0, y: 0.45, color: colors.violet, opacity: 0.16, stop: 0.55 },
  ],
  none: [],
} satisfies Record<string, Glow[]>;

export type MeshName = keyof typeof meshes;

type Props = {
  pattern?: BackdropPattern;
  mesh?: MeshName;
  /** Extra / custom glows layered on top of the mesh preset. */
  glows?: Glow[];
  /** Blurred drifting orbs (glass 2). Defaults to on whenever there is a mesh or glows. */
  orbs?: boolean;
  /** Accent for the first orb (defaults to the theme accent). */
  accent?: string;
};

/** The three drifting orbs from every glass 2 artboard (390 px wide reference). */
const ORBS = [
  { size: 280, top: -70, right: -90, alpha: 0.4, duration: 9000, accent: true },
  { size: 260, top: 330, left: -110, alpha: 0.5, duration: 12000, color: colors.violet },
  { size: 240, bottom: 80, right: -80, alpha: 0.45, duration: 10000, color: colors.indigo },
] as const;

/** Extra room so the soft edge (CSS `filter: blur(34px)`) isn't clipped by the gradient's circle. */
const BLUR_PAD = 36;

/** The orb's gradient. Memoized so pausing/resuming the drift on focus changes doesn't re-render the SVG
 * (which would also invalidate the rasterized bitmap on the parent). */
const OrbArt = memo(function OrbArt({ id, d, color, alpha }: { id: string; d: number; color: string; alpha: number }) {
  return (
    <Svg width={d} height={d}>
      <Defs>
        {/* radial-gradient(circle, color, transparent 70%) softened by the blur → wider, gentler falloff. */}
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={alpha * 0.9} />
          <Stop offset="0.35" stopColor={color} stopOpacity={alpha * 0.6} />
          <Stop offset="0.7" stopColor={color} stopOpacity={alpha * 0.15} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={d / 2} cy={d / 2} r={d / 2} fill={`url(#${id})`} />
    </Svg>
  );
});

function Orb({ o, color, reduce }: { o: (typeof ORBS)[number]; color: string; reduce: boolean }) {
  const t = useState(() => new Animated.Value(0))[0];
  // Built once: new interpolation nodes on every render would re-attach the native animated graph
  // each time the orb pauses/resumes (focus changes happen exactly during tab / push transitions).
  const [transform] = useState(() => [
    { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [0, -18] }) },
    { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [0, 22] }) },
    { scale: t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) },
  ]);
  useEffect(() => {
    if (reduce) {
      t.setValue(0);
      return;
    }
    const half = o.duration / 2;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: half, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t, o.duration, reduce]);

  const d = o.size + BLUR_PAD * 2;
  const pos = {
    top: 'top' in o ? o.top - BLUR_PAD : undefined,
    bottom: 'bottom' in o ? o.bottom - BLUR_PAD : undefined,
    left: 'left' in o ? o.left - BLUR_PAD : undefined,
    right: 'right' in o ? o.right - BLUR_PAD : undefined,
  };
  const id = `orb${o.duration}`;
  return (
    <Animated.View
      // Cache the SVG gradient as a bitmap: otherwise it is re-rasterized on every animation frame.
      renderToHardwareTextureAndroid
      shouldRasterizeIOS
      style={{
        position: 'absolute',
        width: d,
        height: d,
        ...pos,
        transform,
      }}
    >
      <OrbArt id={id} d={d} color={color} alpha={o.alpha} />
    </Animated.View>
  );
}

/** Drifting blurred orbs (keyframes `zOrb`): three absolutely positioned views, native-driver loops. */
export const Orbs = memo(function Orbs({ accent = colors.accent }: { accent?: string }) {
  // Screens left in the stack stay mounted: stop their loops so only the visible screen animates.
  const focused = useIsFocused();
  const reduce = useReduceMotion() || !focused;
  return (
    <View style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} pointerEvents="none">
      {ORBS.map((o) => (
        <Orb key={o.duration} o={o} color={'accent' in o ? accent : o.color} reduce={reduce} />
      ))}
    </View>
  );
});

const PATTERN_DOT = withAlpha(colors.white, 0.08);
const PATTERN_LINE = withAlpha(colors.white, 0.04);
const PATTERN_GRID = withAlpha(colors.white, 0.045);

const NO_GLOWS: Glow[] = [];

const sameGlow = (a: Glow, b: Glow) => a.x === b.x && a.y === b.y && a.color === b.color && a.opacity === b.opacity && a.stop === b.stop;

/**
 * Screens pass `backdrop={{ … }}` inline, so `glows` is a new array on every parent render. Compare by
 * value: a screen re-rendering (data arriving, typing, player changes) must not re-render and re-rasterize
 * two full-screen SVGs + three orb gradients.
 */
function sameBackdrop(a: Props, b: Props) {
  if (a.pattern !== b.pattern || a.mesh !== b.mesh || a.orbs !== b.orbs || a.accent !== b.accent) return false;
  const ga = a.glows ?? NO_GLOWS;
  const gb = b.glows ?? NO_GLOWS;
  return ga === gb || (ga.length === gb.length && ga.every((g, i) => sameGlow(g, gb[i])));
}

/**
 * Full-bleed decorative background: radial mesh glows, drifting orbs and a subtle pattern
 * (dots 16 px, diagonal lines 14 px, grid 24 px). Pointer-events none; place as first child of a screen.
 */
export const Backdrop = memo(function Backdrop({ pattern = 'dots', mesh = 'coral', glows = NO_GLOWS, orbs, accent }: Props) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.w || height !== size.h) setSize({ w: width, h: height });
  };
  const all = [...meshes[mesh], ...glows];
  const showOrbs = orbs ?? all.length > 0;
  const { w, h } = size;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={onLayout}>
      {w > 0 ? (
        <Svg width={w} height={h} style={StyleSheet.absoluteFill}>
          <Defs>
            {all.map((g, i) => (
              <RadialGradient key={i} id={`g${i}`} cx="50%" cy="50%" r="50%">
                <Stop offset="0" stopColor={g.color} stopOpacity={g.opacity} />
                <Stop offset={g.stop ?? 0.55} stopColor={g.color} stopOpacity={0} />
              </RadialGradient>
            ))}
          </Defs>
          {all.map((g, i) => {
            // CSS "ellipse farthest-corner": radii reach the farthest corner from the center.
            const cx = g.x * w;
            const cy = g.y * h;
            const rx = Math.max(cx, w - cx) * Math.SQRT2;
            const ry = Math.max(cy, h - cy) * Math.SQRT2;
            return <Ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} fill={`url(#g${i})`} />;
          })}
        </Svg>
      ) : null}
      {showOrbs ? <Orbs accent={accent} /> : null}
      {w > 0 && pattern !== 'none' ? (
        <Svg width={w} height={h} style={StyleSheet.absoluteFill}>
          <Defs>
            <Pattern id="dots" width={16} height={16} patternUnits="userSpaceOnUse">
              <Circle cx={1} cy={1} r={1} fill={PATTERN_DOT} />
            </Pattern>
            <Pattern id="lines" width={14} height={14} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <Line x1={0} y1={0} x2={0} y2={14} stroke={PATTERN_LINE} strokeWidth={1} />
            </Pattern>
            <Pattern id="grid" width={24} height={24} patternUnits="userSpaceOnUse">
              <Line x1={0} y1={0} x2={24} y2={0} stroke={PATTERN_GRID} strokeWidth={1} />
              <Line x1={0} y1={0} x2={0} y2={24} stroke={PATTERN_GRID} strokeWidth={1} />
            </Pattern>
          </Defs>
          <Rect x={0} y={0} width={w} height={h} fill={`url(#${pattern})`} />
        </Svg>
      ) : null}
    </View>
  );
}, sameBackdrop);
