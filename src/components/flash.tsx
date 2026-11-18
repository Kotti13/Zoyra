import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { onFlash } from '../lib/flash';
import { colors, withAlpha } from '../theme/tokens';
import { reduceMotionNow } from './motion';
import { T } from './primitives';

/**
 * App-wide confirmation pill ("Added to Liked songs", "You are now following", "Saved to your library").
 * Call `flash(message)` from anywhere (state, libs, screens); `<FlashHost />` is mounted once at the root.
 */
export { flash, FLASH } from '../lib/flash';

export function FlashHost() {
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState<{ text: string; key: number } | null>(null);
  const [t] = useState(() => new Animated.Value(0));

  useEffect(() => {
    return onFlash((text) => setMsg({ text, key: Date.now() }));
  }, []);

  useEffect(() => {
    if (!msg) return;
    t.stopAnimation();
    t.setValue(0);
    const quick = reduceMotionNow();
    const anim = Animated.sequence([
      Animated.timing(t, { toValue: 1, duration: quick ? 0 : 220, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }),
      Animated.delay(1450),
      Animated.timing(t, { toValue: 2, duration: quick ? 0 : 230, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => finished && setMsg((m) => (m?.key === msg.key ? null : m)));
    return () => anim.stop();
  }, [msg, t]);

  if (!msg) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 120 + insets.bottom }]}>
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        style={{
          height: 40,
          paddingHorizontal: 18,
          borderRadius: 20,
          justifyContent: 'center',
          backgroundColor: withAlpha(colors.black, 0.78),
          borderWidth: 1,
          borderColor: withAlpha(colors.white, 0.18),
          opacity: t.interpolate({ inputRange: [0, 1, 2], outputRange: [0, 1, 0] }),
          transform: [
            { translateY: t.interpolate({ inputRange: [0, 1, 2], outputRange: [16, 0, -8] }) },
            { scale: t.interpolate({ inputRange: [0, 1, 2], outputRange: [0.9, 1, 1] }) },
          ],
        }}
      >
        <T size={13} weight={600} color={colors.white} numberOfLines={1}>
          {msg.text}
        </T>
      </Animated.View>
    </View>
  );
}
