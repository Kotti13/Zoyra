import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { GOLD } from '../../lib/forever';
import { colors, withAlpha } from '../../theme/tokens';
import { Tap } from '../controls';
import { useReduceMotion } from '../motion';
import { T } from '../primitives';

/** Shared gold pieces of the Forever designs (gradient #FFD36A → #FF8A3D, ink #1A1206). */

export const goldTint = (a: number) => withAlpha(GOLD.mid, a);

/** Gold gradient pill button ("∞ Send Forever request", "Accept Forever", "Say hello", "Got it"). */
export function GoldButton({
  label,
  onPress,
  busy,
  disabled,
  height = 52,
  style,
  accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
  height?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const off = disabled || busy;
  return (
    <Tap
      onPress={off ? undefined : onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label.replace(/^∞\s*/, '')}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      style={[{ height, borderRadius: height / 2, overflow: 'hidden', opacity: disabled ? 0.5 : 1 }, style]}
    >
      <LinearGradient colors={GOLD.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, styles.center]}>
        {busy ? (
          <ActivityIndicator color={GOLD.ink} />
        ) : (
          <T size={15} weight={800} color={GOLD.ink}>
            {label}
          </T>
        )}
      </LinearGradient>
    </Tap>
  );
}

/** Neutral glass pill button used under the gold one ("Not now", "Back to chat", "Cancel request"). */
export function SoftButton({ label, onPress, height = 48, busy, color = colors.text }: { label: string; onPress?: () => void; height?: number; busy?: boolean; color?: string }) {
  return (
    <Tap
      onPress={busy ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: !!busy }}
      style={{ height, borderRadius: 32, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}
    >
      {busy ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <T size={15} weight={600} color={color}>
          {label}
        </T>
      )}
    </Tap>
  );
}

/** Round gold disc with an ∞ (between the two avatars, prompt cards). */
export function GoldInfinity({ size = 44, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <LinearGradient
      colors={GOLD.gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      <T size={Math.round(size * 0.55)} weight={800} color={GOLD.ink} style={{ lineHeight: Math.round(size * 0.7) }} accessibilityElementsHidden importantForAccessibility="no">
        ∞
      </T>
    </LinearGradient>
  );
}

/** Same disc, gently pulsing (Sent / Ask screens). Static with Reduce Motion. */
export function PulsingInfinity({ size = 48 }: { size?: number }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v, reduce]);
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  return (
    <Animated.View style={{ zIndex: 2, transform: [{ scale }] }}>
      <GoldInfinity size={size} />
    </Animated.View>
  );
}

/**
 * Gold "shine" text (`.zshine`: a white highlight sweeping across gold). React Native can't clip a gradient to text,
 * so the highlight is a soft white copy of the text fading in and out over the gold one. Static with Reduce Motion.
 */
export function ShineText({ children, size, weight = 800, style, period = 2600 }: { children: string; size: number; weight?: 600 | 700 | 800; style?: StyleProp<TextStyle>; period?: number }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: period / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: period / 2, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [v, reduce, period]);
  const opacity = v.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] });
  return (
    <View>
      <T size={size} weight={weight} color={GOLD.light} style={style}>
        {children}
      </T>
      {reduce ? null : (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <T size={size} weight={weight} color={colors.white} style={style}>
            {children}
          </T>
        </Animated.View>
      )}
    </View>
  );
}

/** Gold-tinted glass card (Forever rows, prompt cards, banners). */
export function GoldCard({ children, style, radius = 26, strong }: { children: ReactNode; style?: StyleProp<ViewStyle>; radius?: number; strong?: boolean }) {
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: goldTint(strong ? 0.5 : 0.35) }, style]}>
      <LinearGradient
        colors={[goldTint(strong ? 0.22 : 0.14), withAlpha('#141414', 0.6)]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </View>
  );
}

/** Small gold-tinted chip with an optional leading node ("No blocking", "Always rings"). */
export function GoldChip({ label, leading }: { label: string; leading?: ReactNode }) {
  return (
    <View style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: goldTint(0.14), borderWidth: 1, borderColor: goldTint(0.45), flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {leading}
      <T size={12} color={GOLD.textBright}>
        {label}
      </T>
    </View>
  );
}

/** Warm gold backdrop for the full-screen Forever steps (radial glow approximated with two gradients). */
export function GoldBackdrop({ strong }: { strong?: boolean }) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <LinearGradient colors={['#2A1A06', colors.bg]} locations={[0, strong ? 0.8 : 0.75]} style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={[goldTint(strong ? 0.42 : 0.26), goldTint(0)]}
        start={{ x: 0.5, y: 0.3 }}
        end={{ x: 0.5, y: 0.75 }}
        style={[StyleSheet.absoluteFill, { top: '8%' }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({ center: { alignItems: 'center', justifyContent: 'center' } });
