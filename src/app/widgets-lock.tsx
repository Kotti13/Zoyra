import { Platform, View } from 'react-native';

import { Cover, Glass, Icon, IconButton, ListGroup, ListRow, Overline, ProgressBar, Row, Screen, ScreenHeader, Sticker, T } from '../components';
import { formatDuration } from '../lib/catalog';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

function Progress() {
  const { position, duration, progress } = usePlaybackProgress();
  return (
    <View style={{ gap: 4 }}>
      <ProgressBar value={progress} height={4} />
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={11} mono color={colors.textSecondary}>
          {formatDuration(position)}
        </T>
        <T size={11} mono color={colors.textSecondary}>
          {duration ? `-${formatDuration(Math.max(0, duration - position))}` : '--:--'}
        </T>
      </Row>
    </View>
  );
}

/** Live copy of what the system media card shows: same title, artist, art and buttons. */
function LockPreview() {
  const { track, playing, toggle, next, previous } = usePlayerPick('track', 'playing');
  return (
    <Glass padding={16} radius={26} strong>
      <View style={{ gap: 12 }}>
        <Row gap={12}>
          <Cover artwork={track?.artwork} id={track?.id} size={56} radius={18} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {track?.title ?? 'Nothing playing'}
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              {track ? track.artist.name : 'Play a song to see it here and on your lock screen'}
            </T>
          </View>
        </Row>
        {track ? <Progress /> : null}
        <Row style={{ justifyContent: 'center' }} gap={24}>
          <IconButton icon="prev" label="Previous" onPress={previous} />
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} filled onPress={toggle} bg={colors.text} color={colors.onLight} size={52} />
          <IconButton icon="next" label="Next" onPress={next} />
        </Row>
      </View>
    </Glass>
  );
}

export default function WidgetsLock() {
  const sys = Platform.OS === 'ios' ? 'lock screen and Control Center' : Platform.OS === 'android' ? 'lock screen and media notification' : 'browser’s media controls (where supported)';
  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Widgets and lock screen" />

      <View style={{ gap: 8 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Overline color={colors.textSecondary}>LOCK SCREEN</Overline>
          <Sticker label="ALWAYS ON" bg={colors.accent} rotate={0} />
        </Row>
        <LockPreview />
        <T size={13} color={colors.textSecondary}>
          Whenever music plays, Zoyra shows the song, artist and artwork on your {sys}, with play and pause, previous and next, scrubbing and 10-second skips. These buttons control the same player.
        </T>
      </View>

      <ListGroup title="WHAT YOU GET">
        <ListRow title="Media controls" subtitle="Play, pause, skip and scrub" icon="play" right={<Icon name="check" size={18} color={colors.success} />} minHeight={60} />
        <ListRow title="Album art" subtitle="The cover of the playing song" icon="music" right={<Icon name="check" size={18} color={colors.success} />} minHeight={60} divider />
        <ListRow
          title="Now playing in the status bar"
          subtitle={Platform.OS === 'android' ? 'The media notification in your shade' : 'The Now Playing card in Control Center'}
          icon="bell"
          right={<Icon name="check" size={18} color={colors.success} />}
          minHeight={60}
          divider
        />
      </ListGroup>

      <Glass padding={14}>
        <Row gap={10} align="flex-start">
          <Icon name="info" size={18} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            These are always on while music plays, so there’s nothing to switch. Like and shuffle buttons, a lyrics line and Live Activities aren’t available on the system card in this version.
          </T>
        </Row>
      </Glass>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>HOME SCREEN WIDGETS</Overline>
        <Glass padding={16}>
          <Row gap={12} align="flex-start">
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.iconGhost, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="home" size={20} color={colors.textSecondary} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <T size={15} weight={600}>
                Not available in this version
              </T>
              <T size={13} color={colors.textSecondary}>
                Home screen widgets need a native widget extension that this build doesn’t include yet. Use the lock screen controls above in the meantime.
              </T>
            </View>
          </Row>
        </Glass>
      </View>
    </Screen>
  );
}
