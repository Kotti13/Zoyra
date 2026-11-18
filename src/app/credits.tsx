import { router } from 'expo-router';
import { View } from 'react-native';

import { Cover, EmptyState, Glass, Row, Screen, ScreenHeader, T, Tap, useAsync } from '../components';
import { catalog, formatCount, formatDuration } from '../lib/catalog';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors } from '../theme/tokens';

const backdrop = {
  pattern: 'dots' as const,
  mesh: 'none' as const,
  glows: [
    { x: 1, y: 0, color: colors.amber, opacity: 0.28 },
    { x: 0, y: 0.3, color: colors.violet, opacity: 0.2 },
  ],
};

const formatDate = (d?: string) => {
  if (!d) return undefined;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

export default function Credits() {
  const player = usePlayerPick('track');
  const selected = useSheetTrack(player.track);
  // Refresh counts from the catalogue; fall back to what we already have.
  const fresh = useAsync(async () => (selected ? catalog.track(selected.id) : null), [selected?.id]);
  const track = fresh.data ?? selected;

  if (!track) {
    return (
      <Screen top={4} gap={20} backdrop={backdrop}>
        <ScreenHeader title="Credits" />
        <EmptyState title="No song selected" body="Play or pick a song to see its credits." action="Go to Home" href="/" />
      </Screen>
    );
  }

  const credits: { label: string; value: string; onPress?: () => void }[] = [
    { label: 'Performed by', value: track.artist.name, onPress: () => router.push({ pathname: '/artist', params: { id: track.artist.id } }) },
    ...(track.genre ? [{ label: 'Genre', value: track.genre }] : []),
    ...(track.mood ? [{ label: 'Mood', value: track.mood }] : []),
    ...(formatDate(track.releaseDate) ? [{ label: 'Released', value: formatDate(track.releaseDate) ?? '' }] : []),
    { label: 'Length', value: formatDuration(track.duration) },
    ...(track.tags?.length ? [{ label: 'Tags', value: track.tags.join(', ') }] : []),
    { label: 'Plays', value: formatCount(track.plays) },
    { label: 'Likes', value: formatCount(track.likes) },
    { label: 'Source', value: 'Audius' },
  ];

  return (
    <Screen top={4} gap={20} backdrop={backdrop}>
      <ScreenHeader title="Credits" />

      <Row gap={16}>
        <Cover artwork={track.artwork} id={track.id} size={72} radius={20} />
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          <T size={22} weight={700} tracking={-0.3} accessibilityRole="header" numberOfLines={2}>
            {track.title}
          </T>
          <T size={16} color={colors.peach} numberOfLines={1}>
            {track.artist.name}
          </T>
        </View>
      </Row>

      <Glass padding={4}>
        {credits.map((c, i) => {
          const body = (
            <>
              <T size={12} tracking={0.2} color={colors.textSecondary}>
                {c.label}
              </T>
              <T size={16} color={c.onPress ? colors.accentLight : colors.text}>
                {c.value}
              </T>
            </>
          );
          const style = [{ gap: 2, paddingVertical: 12, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }];
          return c.onPress ? (
            <Tap key={c.label} onPress={c.onPress} accessibilityRole="link" style={style}>
              {body}
            </Tap>
          ) : (
            <View key={c.label} accessible style={style}>
              {body}
            </View>
          );
        })}
      </Glass>

      <T size={12} color={colors.textSecondary}>
        Credits come from the artist's upload on Audius. Writer and producer credits aren't provided by the source.
      </T>
    </Screen>
  );
}
