import { useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { formatDuration } from '../lib/catalog';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';
import { IconButton, Tap } from './controls';
import { Icon, Row, T } from './primitives';

/**
 * The player controls of the Now Playing screen, shared so other screens (Queue) use exactly the same pattern:
 * the thin white seek bar with elapsed / remaining time, and the shuffle · previous · play · next · repeat row.
 */

/** Large plain play/pause button. */
export function PlayButton({ playing, onPress }: { playing: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={playing ? 'Pause' : 'Play'} style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={playing ? 'pause' : 'play'} size={44} color={colors.white} filled />
    </Tap>
  );
}

/* ------------------------------------------------------------------ seek */

/** Thin scrubber driven by live playback progress; tap or drag anywhere on it to seek. */
export function LiveSeekBar() {
  const { seekTo } = usePlayerPick();
  const { position, duration, progress } = usePlaybackProgress();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const box = useRef({ x: 0, w: 1 });
  const [drag, setDrag] = useState<number | null>(null);

  const measure = () => ref.current?.measureInWindow((x, _y, w) => (box.current = { x, w: Math.max(1, w) }));
  const fracAt = (e: GestureResponderEvent) => Math.min(1, Math.max(0, (e.nativeEvent.pageX - box.current.x) / box.current.w));
  const value = drag ?? progress;
  const shown = value * duration;

  return (
    <View
      ref={ref}
      onLayout={measure}
      onStartShouldSetResponder={() => duration > 0}
      onMoveShouldSetResponder={() => duration > 0}
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
      <View style={{ gap: 6 }}>
        <View style={{ height: 24, justifyContent: 'center' }}>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: withAlpha(colors.white, 0.22), overflow: 'hidden' }}>
            <View style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: 5, backgroundColor: colors.white }} />
          </View>
        </View>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={12} weight={500} color={colors.textSecondary}>
            {formatDuration(shown)}
          </T>
          <T size={12} weight={500} color={colors.textSecondary}>
            {`-${formatDuration(Math.max(0, duration - shown))}`}
          </T>
        </Row>
      </View>
    </View>
  );
}

/** Shuffle · previous · play/pause · next · repeat, wired to the music player. */
export function TransportControls() {
  const { playing, toggle, next, previous, shuffle, setShuffle, repeat, cycleRepeat } = usePlayerPick('playing', 'shuffle', 'repeat');
  const repeatLabel = repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one';
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <IconButton icon="shuffle" label={shuffle ? 'Shuffle on' : 'Shuffle off'} size={52} color={shuffle ? colors.accentLight : colors.textSecondary} onPress={() => setShuffle(!shuffle)} />
      <IconButton icon="prev" label="Previous track" size={56} iconSize={32} onPress={previous} />
      <PlayButton playing={playing} onPress={toggle} />
      <IconButton icon="next" label="Next track" size={56} iconSize={32} onPress={next} />
      <View>
        <IconButton icon="repeat" label={repeatLabel} size={52} color={repeat === 'off' ? colors.textSecondary : colors.accentLight} onPress={cycleRepeat} />
        {repeat === 'one' ? (
          <View pointerEvents="none" style={styles.repeatOne}>
            <T size={9} weight={700} color={colors.onAccent}>
              1
            </T>
          </View>
        ) : null}
      </View>
    </Row>
  );
}

const styles = StyleSheet.create({
  repeatOne: { position: 'absolute', right: 8, top: 8, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
});
