import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  Platform,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { boldenWeight, scaledSize, statusColors, useColorBlindSafe, useHighContrast, useTextA11y } from '../lib/a11y';
import { art, colors, fontForWeight, fonts, glow as glowStyle, radius, withAlpha, type ArtName, type TypeVariant, type Weight, type as typeScale } from '../theme/tokens';
import { resolveFont } from './fonts';
import { icons, type IconName } from './icons';

/* ------------------------------------------------------------------ Text */

export type TProps = TextProps & {
  variant?: TypeVariant;
  size?: number;
  weight?: Weight;
  color?: string;
  mono?: boolean;
  align?: TextStyle['textAlign'];
  lineHeight?: number;
  tracking?: number;
  style?: StyleProp<TextStyle>;
};

/** Text with Inter / JetBrains Mono applied per weight (custom fonts need one family per weight). */
export function T({ variant = 'body', size, weight, color = colors.text, mono, align, lineHeight, tracking, style, ...rest }: TProps) {
  // One store subscription per <T> (text scale, bold, contrast); re-renders only when one of those changes.
  const { scale, bold, contrast } = useTextA11y();
  const v = typeScale[variant];
  const w = boldenWeight(weight ?? v.weight, bold);
  const fontSize = scaledSize(size ?? v.fontSize, scale);
  const lh = lineHeight === undefined ? undefined : scaledSize(lineHeight, scale);
  const fg = contrast && color === colors.textSecondary ? HIGH_CONTRAST_SECONDARY : color;
  return (
    <Text
      // Cap the phone's system font scaling: the in-app text size already applies on top of it, and uncapped
      // double scaling breaks fixed-height rows. A screen can still pass its own maxFontSizeMultiplier.
      maxFontSizeMultiplier={1.25}
      {...rest}
      style={[
        {
          fontFamily: mono ? (w >= 500 ? fonts.monoMedium : fonts.mono) : resolveFont(fontForWeight(w)),
          fontSize,
          letterSpacing: tracking ?? v.letterSpacing,
          color: fg,
          textAlign: align,
          lineHeight: lh,
        },
        style,
      ]}
    />
  );
}

/** `textSecondary` brightened for High contrast (≈ #D0D0D0 on the near-black background). */
export const HIGH_CONTRAST_SECONDARY = withAlpha(colors.text, 0.86);

/** Colour-blind-safe status colours (success/error → blue/orange when the pref is on). */
export function useStatusColors() {
  const [safe] = useColorBlindSafe();
  return statusColors({ success: colors.success, error: colors.error }, safe, { blue: colors.info, orange: colors.orange });
}

/** Maps a raw success/error colour to its colour-blind-safe equivalent; other colours pass through. */
export function useStatusColor(c: string): string {
  const st = useStatusColors();
  return c === colors.success ? st.success : c === colors.error ? st.error : c;
}

/* ------------------------------------------------------------------ Icon */

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  /** Override solid vs outline rendering (e.g. liked heart). */
  filled?: boolean;
  strokeWidth?: number;
  /**
   * Soft neon glow in the icon's colour (CSS `drop-shadow(0 0 5px currentColor/50%)`).
   * Defaults to on for coloured icons on iOS; neutral text-coloured icons skip it (invisible there and costs an offscreen pass).
   * Android can't tint shadows, so it is skipped there.
   */
  glow?: boolean;
};

/** Neutral colours whose glow would be invisible: skip the shadow pass for them. */
const NO_GLOW = new Set<string>([colors.text, colors.textSecondary, colors.textTertiary, colors.white, colors.onAccent, colors.playerBg, colors.bg]);

export function Icon({ name, size = 24, color = colors.text, filled, strokeWidth = 1.6, glow }: IconProps) {
  const def = icons[name];
  const solid = filled ?? def.filled;
  const common = solid
    ? { fill: color }
    : { fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const svg = (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {def.p.map((p, i) => {
        if (p.t === 'path') return <Path key={i} d={p.d} {...common} />;
        if (p.t === 'circle') return <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} {...common} />;
        return <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={'rx' in p ? p.rx : undefined} {...common} />;
      })}
    </Svg>
  );
  const glowing = Platform.OS === 'ios' && (glow ?? !NO_GLOW.has(color));
  if (!glowing) return svg;
  return (
    <View style={{ shadowColor: color, shadowOpacity: 0.5, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } }} pointerEvents="none">
      {svg}
    </View>
  );
}

/* ------------------------------------------------------------------ IconTile */

/**
 * Glass icon tile (Components board › "Glass icon tiles"): round tinted glass in the icon's colour,
 * 1px tinted border, top highlight and a soft colour glow (iOS).
 */
export function IconTile({ icon, color = colors.accent, size = 44, iconSize, style }: { icon: IconName; color?: string; size?: number; iconSize?: number; style?: StyleProp<ViewStyle> }) {
  const r = size / 2;
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: r, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: withAlpha(color, 0.45) },
        Platform.OS === 'ios' ? glowStyle(color, 14, 0.35) : null,
        style,
      ]}
    >
      <LinearGradient
        colors={[withAlpha(color, 0.38), withAlpha(color, 0.08), colors.glassMid]}
        locations={[0, 0.6, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: r }]}
      />
      <TopHighlight radius={r} color={withAlpha(colors.white, 0.45)} />
      <Icon name={icon} size={iconSize ?? Math.round(size * 0.5)} color={color} />
    </View>
  );
}

/** 1px inset highlight along the top edge (CSS `inset 0 1px 0 rgba(255,255,255,.28)`). */
export function TopHighlight({ radius: r, color = colors.glassHighlight }: { radius: number; color?: string }) {
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: r, borderTopWidth: 1, borderColor: 'transparent', borderTopColor: color }]} />;
}

/* ------------------------------------------------------------------ Gradient art */

export type ArtProps = {
  art?: ArtName | readonly [string, string];
  size?: number;
  width?: number;
  height?: number;
  radius?: number;
  rotate?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  sticker?: boolean;
};

/** Gradient placeholder used for album art, playlist covers and avatar fills (135deg). */
export function Art({ art: a = 'coral', size = 48, width, height, radius: r = radius.sm, rotate, style, children, sticker }: ArtProps) {
  const stops = typeof a === 'string' ? art[a] : a;
  return (
    <View
      style={[
        { width: width ?? size, height: height ?? size, borderRadius: r },
        sticker && styles.sticker,
        rotate ? { transform: [{ rotate: `${rotate}deg` }] } : null,
        style,
      ]}
    >
      <LinearGradient
        colors={[stops[0], stops[1]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: r }]}
      />
      {children}
    </View>
  );
}

export function Gradient({
  colors: c,
  angle = 135,
  style,
  children,
}: {
  colors: readonly [string, string, ...string[]];
  angle?: 90 | 135 | 180;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const end = angle === 90 ? { x: 1, y: 0 } : angle === 180 ? { x: 0, y: 1 } : { x: 1, y: 1 };
  return (
    <LinearGradient colors={c} start={{ x: 0, y: 0 }} end={end} style={style}>
      {children}
    </LinearGradient>
  );
}

/* ------------------------------------------------------------------ Avatar */

export function Avatar({
  initial,
  art: a = 'coral',
  size = 56,
  online,
  ringColor = colors.bg,
  radius: r,
}: {
  /** Corner radius; defaults to a full circle. Boards use rounded squares (~size / 3). */
  radius?: number;
  initial?: string;
  art?: ArtName;
  size?: number;
  online?: boolean;
  ringColor?: string;
}) {
  const status = useStatusColors();
  return (
    <View style={{ width: size, height: size }}>
      <Art art={a} size={size} radius={r ?? size / 2} style={styles.center}>
        {initial ? (
          <T weight={600} size={Math.round(size * 0.32)} color={colors.white}>
            {initial}
          </T>
        ) : null}
      </Art>
      {online ? (
        <View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: status.success,
            borderWidth: 3,
            borderColor: ringColor,
          }}
        />
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ Glass */

export type GlassProps = {
  children?: ReactNode;
  radius?: number;
  padding?: number;
  style?: StyleProp<ViewStyle>;
  /** Stronger, more opaque glass (mini player, tab bar). */
  strong?: boolean;
  intensity?: number;
};

/**
 * Frosted glass surface (glass 2): blur + 145deg white sheen (14% → 4% at 60% → faint red tint),
 * 1px 16% white border and an inset top highlight. Radius 26 by default.
 */
export function Glass({ children, radius: r = radius.card, padding, style, strong, intensity = 30 }: GlassProps) {
  const [contrast] = useHighContrast();
  return (
    <View
      style={[
        {
          borderRadius: r,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: contrast ? HIGH_CONTRAST_BORDER : strong ? withAlpha(colors.white, 0.18) : colors.glassBorder,
          padding,
        },
        style,
      ]}
    >
      {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={intensity} style={StyleSheet.absoluteFill} /> : null}
      {strong ? <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.glassStrong }]} /> : null}
      <LinearGradient
        colors={GLASS_STOPS}
        locations={GLASS_LOCATIONS}
        start={GLASS_START}
        end={GLASS_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <TopHighlight radius={r} />
      {children}
    </View>
  );
}

/** Glass edge under High contrast: 45% white instead of 16%. */
const HIGH_CONTRAST_BORDER = withAlpha(colors.white, 0.45);

/** 145deg in CSS ≈ from top-left-ish to bottom-right-ish. */
const GLASS_START = { x: 0.2, y: 0 } as const;
const GLASS_END = { x: 0.8, y: 1 } as const;
const GLASS_STOPS = [colors.glassTop, colors.glassMid, colors.glassTint] as const;
const GLASS_LOCATIONS = [0, 0.6, 1] as const;

/* ------------------------------------------------------------------ misc */

export function Row({ children, gap = 12, style, align = 'center', ...rest }: ViewProps & { gap?: number; align?: ViewStyle['alignItems'] }) {
  return (
    <View {...rest} style={[{ flexDirection: 'row', alignItems: align, gap }, style]}>
      {children}
    </View>
  );
}

export function Col({ children, gap = 0, style }: { children?: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: 'column', gap }, style]}>{children}</View>;
}

export function Spacer() {
  return <View style={{ flex: 1 }} />;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: 1, backgroundColor: colors.divider }, style]} />;
}

const styles = StyleSheet.create({
  sticker: {
    shadowColor: colors.shadow,
    shadowOpacity: 0.35,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  center: { alignItems: 'center', justifyContent: 'center' },
});
