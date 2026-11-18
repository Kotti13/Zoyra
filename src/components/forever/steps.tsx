import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { GOLD, type ForeverPerson } from '../../lib/forever';
import { colors, withAlpha } from '../../theme/tokens';
import { useReduceMotion } from '../motion';
import { T } from '../primitives';
import { ForeverAvatar } from './ForeverRing';
import { GoldInfinity, PulsingInfinity } from './gold';

/** "1 ASK · 2 PRIYA ACCEPTS · 3 FOREVER" with the three progress bars (active = 34 px gold). `name` null = "YOU ACCEPT". */
export function ForeverSteps({ step, name }: { step: 1 | 2 | 3; name: string | null }) {
  const label = `1 ASK · 2 ${name ? `${name.toUpperCase()} ACCEPTS` : 'YOU ACCEPT'} · 3 FOREVER`;
  return (
    <View style={{ alignItems: 'center', gap: 8 }} accessible accessibilityLabel={`Step ${step} of 3`}>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {[1, 2, 3].map((i) => (
          <View key={i} style={{ height: 6, width: i === step ? 34 : 14, borderRadius: 3, backgroundColor: i <= step ? GOLD.mid : withAlpha(colors.white, 0.2) }} />
        ))}
      </View>
      <T size={11} tracking={1} color={GOLD.text} align="center">
        {label}
      </T>
    </View>
  );
}

/** Expanding gold rings (zRipple: scale .6 → 2.6, fade out, 2.6 s, 3 staggered). Hidden with Reduce Motion. */
export function GoldRipples({ size = 100, period = 2600, maxScale = 2.6, count = 3 }: { size?: number; period?: number; maxScale?: number; count?: number }) {
  const reduce = useReduceMotion();
  const [vals] = useState(() => Array.from({ length: count }, () => new Animated.Value(0)));
  useEffect(() => {
    if (reduce) return;
    const loops = vals.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay((period / count) * i),
          Animated.timing(v, { toValue: 1, duration: period, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [vals, reduce, period, count]);
  if (reduce) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      {vals.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 2,
            borderColor: GOLD.mid,
            opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, maxScale] }) }],
          }}
        />
      ))}
    </View>
  );
}

/** Me — ∞ — them, 92 px avatars with rings (them dimmed until they accept). */
export function ForeverPair({ me, them, themAccepted, pulse = true }: { me: ForeverPerson | null; them: ForeverPerson | null; themAccepted: boolean; pulse?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 150 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <GoldRipples />
      <ForeverAvatar person={me} size={92} radius={31} forever />
      {pulse ? (
        <View style={{ marginHorizontal: -8, zIndex: 2 }}>
          <PulsingInfinity size={48} />
        </View>
      ) : (
        <GoldInfinity size={48} style={{ marginHorizontal: -8, zIndex: 2 }} />
      )}
      <View style={{ opacity: themAccepted ? 1 : 0.45 }}>
        <ForeverAvatar person={them} size={92} radius={31} forever={themAccepted} />
      </View>
    </View>
  );
}
