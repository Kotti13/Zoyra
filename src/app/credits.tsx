import { router } from 'expo-router';
import { View } from 'react-native';

import { Cover, EmptyState, Glass, Icon, IconButton, Overline, Row, Screen, ScreenHeader, T, Tap, useAsync } from '../components';
import { catalog, formatCount, formatDuration } from '../lib/catalog';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors } from '../theme/tokens';

const backdrop = {
  pattern: 'dots' as const,
  mesh: 'none' as const,
  glows: [
    { x: 0, y: 0, color: colors.accent, opacity: 0.4 },
    { x: 1, y: 0.35, color: colors.amber, opacity: 0.22 },
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
  const fresh = useAsync(async () => (selected ? catalog.track(selected.id) : null), [selected?.id], 'app/credits:29');
  const track = fresh.data ?? selected;

  if (!track) {
    return (
      <Screen top={4} gap={20} backdrop={backdrop}>
        <ScreenHeader title="Credits" />
        <EmptyState title="No song selected" body="Play or pick a song to see its credits." action="Go to Home" href="/" />
      </Screen>
    );
  }

  const details: { label: string; value: string }[] = [
    ...(formatDate(track.releaseDate) ? [{ label: 'Released', value: formatDate(track.releaseDate) ?? '' }] : []),
    ...(track.genre ? [{ label: 'Genre', value: track.genre }] : []),
    ...(track.mood ? [{ label: 'Mood', value: track.mood }] : []),
    { label: 'Length', value: formatDuration(track.duration) },
    { label: 'Plays', value: formatCount(track.plays) },
    { label: 'Likes', value: formatCount(track.likes) },
    { label: 'Source', value: 'Audius' },
  ];

  return (
    <Screen top={4} gap={14} backdrop={backdrop}>
      <Row gap={10}>
        <IconButton icon="back" label="Back" href="back" />
        <Cover artwork={track.artwork} id={track.id} size={44} radius={22} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={17} weight={700} accessibilityRole="header" numberOfLines={1}>
            Credits
          </T>
          <T size={12} color={colors.accentLight} numberOfLines={1}>
            {track.title} · {track.artist.name}
          </T>
        </View>
      </Row>

      <Overline color={colors.textSecondary}>PERFORMED BY</Overline>
      <Glass padding={6}>
        <Tap
          onPress={() => router.push({ pathname: '/artist', params: { id: track.artist.id } })}
          accessibilityRole="link"
          accessibilityLabel={`Performed by ${track.artist.name}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 8 }}
        >
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <T size={14} weight={700} color={colors.onAccent}>
              {track.artist.name.slice(0, 1).toUpperCase()}
            </T>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {track.artist.name}
            </T>
            <T size={12} color={colors.textSecondary}>
              Main artist
            </T>
          </View>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </Tap>
      </Glass>

      <Overline color={colors.textSecondary}>SONG DETAILS</Overline>
      <Glass padding={16}>
        {details.map((c, i) => (
          <View
            key={c.label}
            accessible
            style={[{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 10 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
          >
            <T size={14} color={colors.textSecondary}>
              {c.label}
            </T>
            <T size={14} weight={600} style={{ flexShrink: 1, textAlign: 'right' }}>
              {c.value}
            </T>
          </View>
        ))}
      </Glass>

      {track.tags?.length ? (
        <Glass padding={16}>
          <Overline color={colors.amber}>TAGS</Overline>
          <T size={14} color={colors.textSecondary} style={{ marginTop: 6, lineHeight: 21 }}>
            {track.tags.join(', ')}
          </T>
        </Glass>
      ) : null}

      <T size={11} color={colors.textSecondary} align="center">
        Credits come from the artist&apos;s upload on Audius. Writer and producer credits aren&apos;t provided by the source.
      </T>
    </Screen>
  );
}
