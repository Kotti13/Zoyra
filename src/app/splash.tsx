import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, Rise, T, Tap, useReduceMotion } from '../components';
import { SplashScene } from '../components/SplashView';
import { colors } from '../theme/tokens';

/**
 * Timings from the Splash mock (7 s loop), played once: the bar starts at 0.42 s; it fills a little faster
 * than the mock so the screen never feels stuck. "Tap to continue" appears at 3.6 s, auto-continue at 5.2 s.
 */
const FILL_DELAY = 420;
const FILL_MS = 3980;
const CTA_AT = 3600;
const AUTO_CONTINUE_MS = 5200;

/** Standalone branded splash route: full cinematic sequence; the root auth gate takes signed-in users on from Welcome. */
export default function Splash() {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const progress = useState(() => new Animated.Value(0))[0];
  const [started, setStarted] = useState(false);

  const go = useCallback(() => router.replace('/welcome'), []);

  useEffect(() => {
    const id = setTimeout(go, AUTO_CONTINUE_MS);
    return () => clearTimeout(id);
  }, [go]);

  const onStart = useCallback(() => {
    setStarted(true);
    Animated.timing(progress, {
      toValue: 1,
      duration: reduce ? 0 : FILL_MS,
      delay: reduce ? 0 : FILL_DELAY,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      useNativeDriver: true,
    }).start();
  }, [progress, reduce]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tap accessibilityRole="button" accessibilityLabel="Zoyra. Your sound, your world. Tap to continue" onPress={go} style={StyleSheet.absoluteFill}>
        <SplashScene mode="full" progress={progress} onStart={onStart} />
      </Tap>
      {started ? (
        <Rise delay={reduce ? 0 : CTA_AT} distance={6} style={{ position: 'absolute', bottom: 36 + insets.bottom, alignSelf: 'center' }}>
          <Tap
            accessibilityRole="button"
            accessibilityLabel="Tap to continue"
            onPress={go}
            style={{
              height: 48,
              paddingHorizontal: 24,
              borderRadius: 24,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              backgroundColor: colors.chipGhost,
              borderWidth: 1,
              borderColor: colors.glassBorder,
            }}
          >
            <T size={14} weight={600}>
              Tap to continue
            </T>
            <Icon name="arrowRight" size={18} strokeWidth={1.8} />
          </Tap>
        </Rise>
      ) : null}
    </View>
  );
}
