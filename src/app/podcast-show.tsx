import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, IconButton, Loading, MiniPlayer, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toast, useAsync, ToggleBurst } from '../components';
import { EpisodeDownload } from '../components/EpisodeDownload';
import { catalog, formatCount, formatDuration, type CatalogTrack } from '../lib/catalog';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, shadow } from '../theme/tokens';

function when(date: string | undefined) {
  if (!date) return null;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'Last week';
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const minutes = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : formatDuration(s));

export default function PodcastShow() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { playTracks, track: current, playing, toggle } = usePlayerPick('track', 'playing');
  const { isFollowingArtist, toggleFollowArtist } = useLibrary();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, reload, refresh } = useAsync(async () => {
    if (!id) return null;
    const [artist, episodes] = await Promise.all([catalog.artist(id), catalog.artistTracks(id, 50, 'date')]);
    return { artist, episodes };
  }, [id], 'app/podcast-show:35');

  if (!id) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'amber' }}>
        <ScreenHeader title="Show" />
        <EmptyState icon="search" title="No show selected" body="Pick a show from Podcasts." action="Browse podcasts" href="/podcasts" />
      </Screen>
    );
  }

  const artist = data?.artist;
  const episodes: CatalogTrack[] = data?.episodes ?? [];
  const subscribed = artist ? isFollowingArtist(artist.id) : false;
  const context = artist ? `Podcast · ${artist.name}` : 'Podcasts';
  const showPlaying = !!current && episodes.some((e) => e.id === current.id);

  const subscribe = async () => {
    if (!artist || busy) return;
    setBusy(true);
    setNote(null);
    try {
      await toggleFollowArtist(artist);
    } catch (e: unknown) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not update your subscription' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen onRefresh={refresh} top={4} bottom={12} gap={16} backdrop={{ pattern: 'dots', mesh: 'amber' }} footer={<MiniPlayer />}>
      <ScreenHeader
        title="Show"
        right={episodes[0] ? <IconButton icon="more" label="More" href="/song-options" onPress={() => setSheetTrack(episodes[0])} /> : undefined}
      />

      {loading ? (
        <Loading label="Loading show" height={240} />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : artist ? (
        <>
          <View style={{ alignItems: 'center' }}>
            <Cover uri={artist.image.large ?? artist.image.medium ?? null} artwork={episodes[0]?.artwork} id={artist.id} size={200} radius={44} style={shadow.artGlow} />
          </View>

          <View style={{ alignItems: 'center', gap: 6 }}>
            <T size={26} weight={300} tracking={-0.5} align="center" accessibilityRole="header">
              {artist.name}
            </T>
            <T size={15} align="center" color={colors.textSecondary} numberOfLines={3}>
              {artist.bio?.trim() || `${formatCount(artist.followers)} followers`}
            </T>
          </View>

          <Row>
            <Tap
              accessibilityState={{ selected: subscribed, busy }}
              onPress={() => void subscribe()}
              style={{
                flex: 1,
                height: 48,
                borderRadius: 32,
                borderWidth: 1,
                borderColor: colors.accentLight,
                backgroundColor: subscribed ? colors.accentTint : undefined,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ToggleBurst active={subscribed} size={48}>
                <T size={15} weight={600} color={colors.accentLight}>
                  {subscribed ? 'Subscribed' : 'Subscribe'}
                </T>
              </ToggleBurst>
            </Tap>
            <IconButton
              icon={showPlaying && playing ? 'pause' : 'play'}
              label={showPlaying && playing ? 'Pause' : 'Play'}
              size={56}
              iconSize={28}
              bg={colors.accent}
              color={colors.onAccent}
              onPress={() => (showPlaying ? toggle() : episodes.length ? playTracks(episodes, 0, context) : undefined)}
              style={shadow.sticker}
            />
          </Row>

          {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}

          <View style={{ gap: 12 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <SectionHeader title="Episodes" />
              <T mono size={12} color={colors.textSecondary}>
                {episodes.length} episodes
              </T>
            </Row>
            {episodes.length ? (
              <Glass radius={26} padding={4}>
                {episodes.map((e, i) => {
                  const active = current?.id === e.id;
                  const meta = [when(e.releaseDate), minutes(e.duration)].filter(Boolean).join(' · ');
                  return (
                    <Tap
                      key={e.id}
                      accessibilityLabel={`Play ${e.title}`}
                      onPress={() => playTracks(episodes, i, context)}
                      style={[{ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
                    >
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        <T size={16} weight={500} numberOfLines={1} color={active ? colors.accentLight : colors.text}>
                          {e.title}
                        </T>
                        <T size={14} color={colors.textSecondary}>
                          {meta}
                        </T>
                      </View>
                      <EpisodeDownload episode={e} onResult={setNote} />
                    </Tap>
                  );
                })}
              </Glass>
            ) : (
              <EmptyState icon="clock" title="No episodes yet" body="This show has not published anything yet." />
            )}
          </View>
        </>
      ) : null}
    </Screen>
  );
}
