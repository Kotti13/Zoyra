import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { formatDuration, type CatalogTrack } from '../lib/catalog';
import { usePlayerActions, usePlayerSelector } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';
import { Tap } from './controls';
import { Cover, MoreButton } from './media';
import { Icon, Row, T } from './primitives';

/** Wide accent "Play" pill + glass "Shuffle" pill, side by side (Apple Music collection header). */
export function PlayShufflePills({ playing, onPlay, onShuffle, shuffleOn }: { playing: boolean; onPlay: () => void; onShuffle: () => void; shuffleOn?: boolean }) {
  return (
    <Row gap={12}>
      <Tap onPress={onPlay} accessibilityLabel={playing ? 'Pause' : 'Play'} style={[pill, { backgroundColor: colors.accent }]}>
        <Icon name={playing ? 'pause' : 'play'} size={18} color={colors.onAccent} filled />
        <T size={16} weight={700} color={colors.onAccent}>
          {playing ? 'Pause' : 'Play'}
        </T>
      </Tap>
      <Tap onPress={onShuffle} accessibilityLabel="Shuffle" accessibilityState={{ selected: !!shuffleOn }} style={[pill, { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder }]}>
        <Icon name="shuffle" size={18} color={shuffleOn ? colors.accentLight : colors.text} />
        <T size={16} weight={700} color={shuffleOn ? colors.accentLight : colors.text}>
          Shuffle
        </T>
      </Tap>
    </Row>
  );
}

const pill = { flex: 1, height: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 } as const;

/** Centered square artwork with soft shadow, title, accent artist line and meta line. */
export function CollectionHeader({ art, title, artist, onArtist, meta, description }: { art: ReactNode; title: string; artist?: string; onArtist?: ReactNode; meta?: string; description?: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 6, paddingTop: 4 }}>
      <View style={styles.artShadow}>{art}</View>
      <T size={22} weight={700} align="center" accessibilityRole="header" style={{ marginTop: 14 }}>
        {title}
      </T>
      {onArtist ?? (artist ? (
        <T size={18} weight={500} color={colors.accentLight} align="center">
          {artist}
        </T>
      ) : null)}
      {meta ? (
        <T size={12} weight={600} color={colors.textSecondary} align="center" tracking={0.3}>
          {meta}
        </T>
      ) : null}
      {description ? (
        <T size={13} color={colors.textSecondary} lineHeight={18} align="center" numberOfLines={3}>
          {description}
        </T>
      ) : null}
    </View>
  );
}

/** Numbered (or artwork) track row with a hairline separator and trailing "more". */
export const AppleTrackRow = memo(function AppleTrackRow({
  track,
  list,
  index,
  context,
  right,
  withArt = false,
  subtitle,
  last,
}: {
  track: CatalogTrack;
  list: CatalogTrack[];
  index: number;
  context?: string;
  right?: ReactNode;
  withArt?: boolean;
  subtitle?: string;
  last?: boolean;
}) {
  const { playTracks } = usePlayerActions();
  const status = usePlayerSelector((s) => (s.track?.id !== track.id ? 0 : s.playing ? 2 : 1));
  const active = status !== 0;
  return (
    <Tap
      accessibilityLabel={`Play ${track.title} by ${track.artist.name}`}
      onPress={() => playTracks(list, Math.max(0, list.findIndex((t) => t.id === track.id)), context)}
      pressScale={0.99}
    >
      <Row gap={12} style={[{ minHeight: withArt ? 64 : 56 }, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline }]}>
        {withArt ? (
          <Cover artwork={track.artwork} id={track.id} size={44} radius={8} />
        ) : (
          <View style={{ width: 24, alignItems: 'center' }}>
            {active ? <Icon name={status === 2 ? 'pause' : 'play'} size={16} color={colors.accentLight} filled /> : (
              <T size={15} color={colors.textSecondary} align="center">
                {index + 1}
              </T>
            )}
          </View>
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={16} weight={500} numberOfLines={1} color={active ? colors.accentLight : colors.text}>
            {track.title}
          </T>
          {subtitle !== '' ? (
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              {subtitle ?? track.artist.name}
            </T>
          ) : null}
        </View>
        <T size={13} color={withAlpha(colors.white, 0.45)}>
          {formatDuration(track.duration)}
        </T>
        {right ?? <MoreButton track={track} />}
      </Row>
    </Tap>
  );
});

const styles = StyleSheet.create({
  artShadow: { shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 12 },
});
