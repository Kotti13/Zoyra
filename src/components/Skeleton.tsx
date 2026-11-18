import { useFocusEffect, useNavigation } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { colors, layout, radius, withAlpha } from '../theme/tokens';
import { reduceMotionNow } from './motion';

/* ------------------------------------------------------------------ one shared pulse */

// Every skeleton block reads the same native-driver value, so 40 placeholders cost one animation, not 40.
const pulse = new Animated.Value(0);
let users = 0;
let loop: Animated.CompositeAnimation | null = null;

function retainPulse() {
  users += 1;
  if (users === 1 && !reduceMotionNow()) {
    loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
  }
  return () => {
    users -= 1;
    if (users === 0) {
      loop?.stop();
      loop = null;
    }
  };
}

const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.85] });
const FILL = withAlpha(colors.white, 0.08);

/** A single shimmering placeholder block. */
export function SkeletonBlock({ width = '100%', height = 16, r = radius.xs, style }: { width?: DimensionValue; height?: number; r?: number; style?: StyleProp<ViewStyle> }) {
  useEffect(retainPulse, []);
  return <Animated.View style={[{ width, height, borderRadius: r, backgroundColor: FILL, opacity }, style]} />;
}

/** Placeholder track/list rows: square art + two text lines. */
export function SkeletonRows({ rows = 5, art = 48 }: { rows?: number; art?: number }) {
  return (
    <View style={{ gap: 14 }} accessibilityRole="progressbar" accessibilityLabel="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <SkeletonBlock width={art} height={art} r={radius.sm} />
          <View style={{ flex: 1, gap: 8 }}>
            <SkeletonBlock width={`${70 - ((i * 13) % 30)}%`} height={14} />
            <SkeletonBlock width={`${45 - ((i * 7) % 20)}%`} height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Placeholder for a whole screen while its real content mounts after the navigation transition. */
export function SkeletonScreen() {
  return (
    <View style={{ gap: 22 }} accessibilityRole="progressbar" accessibilityLabel="Loading">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <SkeletonBlock width={44} height={44} r={22} />
        <SkeletonBlock width="45%" height={20} />
      </View>
      <SkeletonBlock height={160} r={radius.card} />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <SkeletonBlock width={layout.gutter * 8} height={36} r={18} />
        <SkeletonBlock width={layout.gutter * 6} height={36} r={18} />
        <SkeletonBlock width={layout.gutter * 5} height={36} r={18} />
      </View>
      <SkeletonRows rows={5} />
    </View>
  );
}

/* ------------------------------------------------------------------ defer heavy content past the transition */

/**
 * False until the screen's push/modal animation has finished (navigation `transitionEnd`, capped at
 * `maxWait` ms). Rendering a heavy screen *during* the slide is what makes
 * navigation stutter; showing a cheap skeleton first keeps the animation at 60 fps.
 */
export function useAfterTransition(enabled = true, maxWait = 420): boolean {
  const navigation = useNavigation();
  const [ready, setReady] = useState(!enabled);
  useEffect(() => {
    if (!enabled) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setReady(true);
    };
    // Stack navigators emit `transitionEnd`; other navigators (tabs, sheets) fall back to the timer.
    const nav = navigation as unknown as { addListener: (event: 'transitionEnd', cb: () => void) => () => void };
    const unsub = nav.addListener('transitionEnd', finish);
    const timer = setTimeout(finish, maxWait);
    return () => {
      done = true;
      unsub();
      clearTimeout(timer);
    };
  }, [enabled, navigation, maxWait]);
  return ready;
}

/**
 * `useFocusEffect`, but the callback runs once the tab / push transition has finished (`transitionEnd`,
 * capped at `maxWait` ms) instead of on the first focused frame. Use for refetches on focus, so their
 * setState re-renders land after the 150 ms tab shift / 320 ms push instead of in the middle of it.
 * Cancelled if the screen blurs first. The latest `effect` is always used (no need to memoize it).
 */
export function useFocusEffectAfterTransition(effect: () => void, maxWait = 360) {
  const navigation = useNavigation();
  const latest = useRef(effect);
  useLayoutEffect(() => {
    latest.current = effect;
  });
  useFocusEffect(
    useCallback(() => {
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        latest.current();
      };
      const nav = navigation as unknown as { addListener: (event: 'transitionEnd', cb: () => void) => () => void };
      const unsub = nav.addListener('transitionEnd', run);
      const timer = setTimeout(run, maxWait);
      return () => {
        done = true;
        unsub();
        clearTimeout(timer);
      };
    }, [navigation, maxWait]),
  );
}
