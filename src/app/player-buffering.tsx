import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, EmptyState, IconButton, Overline, Row, Screen, ScreenHeader, SeekBar, T } from '../components';
import { BufferingNotice, useBuffering } from '../lib/buffering';
import { formatDuration } from '../lib/catalog';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

/** Seconds the current stall has lasted (ticks once a second). */
function useStallSeconds(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since == null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

export default function PlayerBuffering() {
  const { track, playing, toggle, next, previous, context } = usePlayerPick('track', 'playing', 'context');
  const { position, duration, progress } = usePlaybackProgress();
  const { stalled, since } = useBuffering();
  const waited = useStallSeconds(since);

  if (!track) {
    return (
      <Screen top={4} swipeDown>
        <ScreenHeader title="Now playing" backIcon="chevronDown" />
        <EmptyState title="Nothing is playing" body="Start a song and this screen shows how the stream is loading." action="Browse music" href="/" />
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'dots', mesh: 'coral' }} swipeDown>
      <ScreenHeader title="" backIcon="chevronDown" />
      <View style={{ alignItems: 'center', gap: 2, marginTop: -44 }}>
        <Overline color={colors.textSecondary}>PLAYING FROM</Overline>
        <T size={14} weight={600} numberOfLines={1}>
          {context ?? 'Your queue'}
        </T>
      </View>

      <BufferingNotice always />

      <View style={{ alignItems: 'center' }}>
        <Cover artwork={track.artwork} id={track.id} size={260} radius={28} style={{ opacity: stalled ? 0.6 : 1 }} />
      </View>

      <View style={{ gap: 4 }}>
        <T variant="title" numberOfLines={1}>
          {track.title}
        </T>
        <T size={15} color={stalled ? colors.warning : colors.textSecondary} accessibilityLiveRegion="polite">
          {stalled ? `Buffering… ${waited > 0 ? `${waited}s` : ''}` : track.artist.name}
        </T>
      </View>

      <SeekBar value={progress} elapsed={formatDuration(position)} remaining={`-${formatDuration(Math.max(0, duration - position))}`} />

      <Row gap={20} style={{ justifyContent: 'center' }}>
        <IconButton icon="prev" label="Previous" size={56} iconSize={28} onPress={previous} />
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} size={72} iconSize={34} bg={colors.accent} color={colors.onAccent} filled onPress={toggle} />
        <IconButton icon="next" label="Next" size={56} iconSize={28} onPress={next} />
      </Row>

      <Button label="Open player" variant="glass" href="/player" />
    </Screen>
  );
}
