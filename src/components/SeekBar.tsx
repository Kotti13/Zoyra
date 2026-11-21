import { LinearGradient } from 'expo-linear-gradient';
import { useRef, useState, type ComponentRef } from 'react';
import { View, type GestureResponderEvent } from 'react-native';

import { formatDuration } from '../lib/catalog';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';
import { Row, T } from './primitives';

/**
 * Touch scrubber for the dock under the lyrics and queue screens: tap anywhere on the bar or drag to seek.
 * The track area is 32 px tall so a thumb can hit it; the visible bar stays thin. It keeps the responder
 * during a drag, so the screen's swipe-down-to-close gesture cannot steal the touch.
 */
export function TouchSeekBar() {
  const { seekTo } = usePlayerPick();
  const { position, duration, progress } = usePlaybackProgress();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const box = useRef({ x: 0, w: 1 });
  const [drag, setDrag] = useState<number | null>(null);

  const measure = () => ref.current?.measureInWindow((x, _y, w) => (box.current = { x, w: Math.max(1, w) }));
  const fracAt = (e: GestureResponderEvent) => Math.min(1, Math.max(0, (e.nativeEvent.pageX - box.current.x) / box.current.w));
  const value = Math.max(0, Math.min(1, drag ?? progress));
  const shown = value * duration;
  const pct = `${value * 100}%` as const;

  return (
    <View
      ref={ref}
      onLayout={measure}
      onStartShouldSetResponder={() => duration > 0}
      onMoveShouldSetResponder={() => duration > 0}
      onStartShouldSetResponderCapture={() => duration > 0}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        measure();
        setDrag(fracAt(e));
      }}
      onResponderMove={(e) => setDrag(fracAt(e))}
      onResponderRelease={(e) => {
        seekTo(fracAt(e) * duration);
        setDrag(null);
      }}
      onResponderTerminate={() => setDrag(null)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
      accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position), text: `${formatDuration(position)} of ${formatDuration(duration)}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => seekTo(Math.min(duration, Math.max(0, position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))))}
    >
      <View style={{ height: 32, justifyContent: 'center' }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.chipOutline, overflow: 'hidden' }}>
          <LinearGradient colors={[colors.accent, colors.white]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: pct, height: 4, borderRadius: 2 }} />
        </View>
        {/* Thumb: grows while dragging so you can see where you are. */}
        <View pointerEvents="none" style={{ position: 'absolute', left: pct, marginLeft: drag !== null ? -9 : -6, width: drag !== null ? 18 : 12, height: drag !== null ? 18 : 12, borderRadius: 9, backgroundColor: colors.white }} />
      </View>
      <Row style={{ justifyContent: 'space-between' }}>
        <T mono size={11} color={colors.peach}>
          {formatDuration(shown)}
        </T>
        <T mono size={11} color={colors.textSecondary}>
          {`-${formatDuration(Math.max(0, duration - shown))}`}
        </T>
      </Row>
    </View>
  );
}
