import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Avatar, Button, Chip, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toast, TrackItem, artFor, useAsync } from '../components';
import { countTrackComments } from '../lib/track-comments';
import { catalog, formatCount, formatDuration } from '../lib/catalog';
import { fetchLyrics, sourceLines } from '../lib/lyrics';
import { PosterBadge, Poster } from '../lib/poster';
import { formatReleaseDate, loadTrackDetail } from '../lib/premieres';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors } from '../theme/tokens';

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 2 }} accessible accessibilityLabel={`${value} ${label}`}>
      <T size={18} weight={700}>
        {value}
      </T>
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
}

export default function TrackDetail() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { playTrack, track: current, playing, toggle } = usePlayerPick('track', 'playing');
  const { isLiked, toggleLike } = useLibrary();
  const [expanded, setExpanded] = useState(false);
  const [liking, setLiking] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const detail = useAsync(async () => (id ? loadTrackDetail(id) : null), [id]);
  const track = detail.data?.track;
  const extras = detail.data?.extras;

  const lyrics = useAsync(async () => (track ? fetchLyrics(track) : null), [track?.id]);
  const commentCount = useAsync(async () => (id ? countTrackComments(id).catch(() => null) : null), [id]);
  const more = useAsync(async () => (track ? (await catalog.artistTracks(track.artist.id, 8)).filter((t) => t.id !== track.id).slice(0, 5) : []), [track?.id]);

  if (!id) {
    return (
      <Screen top={4} gap={20}>
        <ScreenHeader title="Track" />
        <EmptyState title="No song selected" body="Open a song from Home, Search or Premieres to see its details." action="Go to Home" href="/" />
      </Screen>
    );
  }

  if (detail.loading && !detail.data) {
    return (
      <Screen top={4} gap={20}>
        <ScreenHeader title="Track" />
        <Loading height={320} label="Loading song" />
      </Screen>
    );
  }

  if (detail.error || !track || !extras) {
    return (
      <Screen top={4} gap={20}>
        <ScreenHeader title="Track" />
        <ErrorState message={detail.error ?? 'This song is not available.'} onRetry={detail.reload} />
      </Screen>
    );
  }

  const isCurrent = current?.id === track.id;
  const liked = isLiked(track.id);
  const released = formatReleaseDate(track.releaseDate, { year: 'numeric', month: 'long', day: 'numeric' });

  const onPlay = () => {
    if (isCurrent) return toggle();
    const res = playTrack(track, track.title);
    if (!res.played) setNote({ ok: false, text: res.reason ?? 'This song cannot be played right now.' });
  };

  const onLike = async () => {
    if (liking) return;
    setLiking(true);
    try {
      await toggleLike(track);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not update your likes' });
    } finally {
      setLiking(false);
    }
  };

  const openSheet = (href: '/add-to-playlist' | '/share-sheet' | '/credits' | '/song-options') => {
    setSheetTrack(track);
    router.push(href);
  };

  const lyricLines = lyrics.data ? sourceLines(lyrics.data).filter((l) => l.trim()) : [];
  const artists = [{ id: track.artist.id, name: track.artist.name }, ...extras.collaborators.filter((c) => c.id !== track.artist.id)];
  const details: { label: string; value: string }[] = [
    ...(released ? [{ label: 'Released', value: released }] : []),
    { label: 'Length', value: formatDuration(track.duration) },
    ...(extras.bpm ? [{ label: 'Tempo', value: `${extras.bpm} BPM` }] : []),
    ...(extras.musicalKey ? [{ label: 'Key', value: extras.musicalKey }] : []),
    ...(extras.license ? [{ label: 'License', value: extras.license }] : []),
    ...(extras.copyright ? [{ label: 'Copyright', value: extras.copyright }] : []),
    ...(extras.isrc ? [{ label: 'ISRC', value: extras.isrc }] : []),
  ];

  return (
    <Screen onRefresh={() => Promise.all([detail.refresh(), lyrics.refresh(), more.refresh()])} top={4} gap={20} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <ScreenHeader title="" right={<IconButton icon="share" label="Share song" onPress={() => openSheet('/share-sheet')} />} />

      {/* Poster hero */}
      <Poster artwork={track.artwork} id={track.id} height={360} radius={34}>
        <View style={{ flex: 1, justifyContent: 'space-between', padding: 6 }}>
          <Row gap={8}>
            {track.genre ? <PosterBadge label={track.genre.toUpperCase()} /> : null}
            {track.mood ? <PosterBadge label={track.mood.toUpperCase()} /> : null}
          </Row>
          <View style={{ gap: 4 }}>
            <T variant="displayLight" size={40} lineHeight={42} numberOfLines={3} accessibilityRole="header">
              {track.title}
            </T>
            <Tap href={{ pathname: '/artist', params: { id: track.artist.id } }} accessibilityLabel={`Go to artist ${track.artist.name}`} style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}>
              <T size={15} color={colors.peach}>
                {track.artist.name}
                {released ? ` · ${released}` : ''}
              </T>
            </Tap>
          </View>
        </View>
      </Poster>

      {/* Real counts instead of the mock's star rating */}
      <Glass radius={26} padding={14} style={{ flexDirection: 'row' }}>
        <Stat value={formatCount(track.plays)} label="Plays" />
        <Stat value={formatCount(track.likes)} label="Favourites" />
        <Stat value={formatCount(extras.reposts)} label="Reposts" />
        {extras.comments ? <Stat value={formatCount(extras.comments)} label="Comments" /> : null}
      </Glass>

      {/* Actions */}
      <Row gap={10}>
        <Button label={isCurrent && playing ? 'Pause' : 'Play'} icon={isCurrent && playing ? 'pause' : 'play'} onPress={onPlay} style={{ flex: 1 }} />
        <IconButton icon="heart" filled={liked} color={liked ? colors.like : colors.text} label={liked ? 'Remove from liked songs' : 'Like song'} glass size={48} onPress={() => void onLike()} />
        <IconButton icon="plus" label="Add to playlist" glass size={48} onPress={() => openSheet('/add-to-playlist')} />
        <IconButton icon="more" label="More options" glass size={48} onPress={() => openSheet('/song-options')} />
      </Row>

      <Tap href={{ pathname: '/track-comments', params: { id: track.id } }} accessibilityLabel="Open comments" pressScale={0.98}>
        <Glass radius={26} padding={16} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Icon name="mail" size={20} color={colors.accentLight} />
          <T size={15} weight={600} style={{ flex: 1 }}>
            Comments{commentCount.data ? ` · ${formatCount(commentCount.data)}` : ''}
          </T>
          <T size={13} color={colors.textSecondary}>
            Add yours
          </T>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </Glass>
      </Tap>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.amber} message={note.text} /> : null}

      {/* Tags */}
      {track.tags?.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          {track.tags.slice(0, 8).map((tag) => (
            <Chip key={tag} label={`#${tag}`} onPress={() => router.push({ pathname: '/genre', params: { name: track.genre ?? tag } })} />
          ))}
        </ScrollView>
      ) : null}

      {/* About */}
      {extras.description ? (
        <View style={{ gap: 8 }}>
          <SectionHeader title="About the song" />
          <T size={15} lineHeight={22} color={colors.textSecondary} numberOfLines={expanded ? undefined : 4}>
            {extras.description}
          </T>
          {extras.description.length > 180 ? (
            <Tap onPress={() => setExpanded((v) => !v)} accessibilityLabel={expanded ? 'Show less' : 'Show more'} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
              <T size={14} weight={600} color={colors.accentLight}>
                {expanded ? 'Less' : 'More'}
              </T>
            </Tap>
          ) : null}
        </View>
      ) : null}

      {/* Artists */}
      <View style={{ gap: 12 }}>
        <SectionHeader title={artists.length > 1 ? 'Featured artists' : 'Artist'} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 16, paddingHorizontal: 16 }}>
          {artists.map((a, i) => (
            <Tap key={a.id} href={{ pathname: '/artist', params: { id: a.id } }} accessibilityLabel={`Go to artist ${a.name}`} style={{ width: 72, alignItems: 'center', gap: 6 }}>
              {i === 0 && track.artist.image ? <Cover uri={track.artist.image} id={a.id} size={64} radius={32} /> : <Avatar initial={a.name[0]?.toUpperCase()} art={artFor(a.id)} size={64} />}
              <T size={12} color={colors.textSecondary} numberOfLines={1} align="center">
                {a.name}
              </T>
            </Tap>
          ))}
        </ScrollView>
      </View>

      {/* Lyrics preview */}
      <View style={{ gap: 8 }}>
        <SectionHeader
          title="Lyrics"
          action={lyricLines.length ? 'Open lyrics' : undefined}
          onAction={() => {
            if (!isCurrent) playTrack(track, track.title);
            router.push('/lyrics');
          }}
        />
        {lyrics.loading && !lyrics.data ? (
          <Loading height={80} />
        ) : lyrics.error ? (
          <ErrorState message={lyrics.error} onRetry={lyrics.reload} />
        ) : lyrics.data?.instrumental ? (
          <T size={14} color={colors.textSecondary}>
            This one is an instrumental.
          </T>
        ) : lyricLines.length ? (
          <Glass radius={26} padding={16} style={{ gap: 6 }}>
            {lyricLines.slice(0, 4).map((l, i) => (
              <T key={`${i}-${l}`} size={17} weight={i === 0 ? 600 : 400} color={i === 0 ? colors.text : colors.textSecondary}>
                {l}
              </T>
            ))}
            {lyrics.data?.source === 'original' ? (
              <T size={12} color={colors.textTertiary}>
                Lyrics of the original song{lyrics.data.matchedArtist ? ` by ${lyrics.data.matchedArtist}` : ''}.
              </T>
            ) : null}
          </Glass>
        ) : (
          <T size={14} color={colors.textSecondary}>
            No lyrics found for this song.
          </T>
        )}
      </View>

      {/* Details + credits */}
      <View style={{ gap: 8 }}>
        <SectionHeader title="Details" action="View credits" onAction={() => openSheet('/credits')} />
        <Glass radius={26} padding={16} style={{ gap: 10 }}>
          {details.map((d) => (
            <Row key={d.label} style={{ justifyContent: 'space-between' }} align="flex-start">
              <T size={14} color={colors.textSecondary}>
                {d.label}
              </T>
              <T size={14} weight={500} align="right" style={{ flex: 1, marginLeft: 16 }} numberOfLines={2}>
                {d.value}
              </T>
            </Row>
          ))}
          <T size={12} color={colors.textTertiary}>
            Source: Audius
          </T>
        </Glass>
      </View>

      {/* More by artist */}
      <View>
        <SectionHeader title={`More by ${track.artist.name}`} action="Artist" href={{ pathname: '/artist', params: { id: track.artist.id } }} />
        {more.loading && !more.data ? (
          <Loading height={80} />
        ) : more.error ? (
          <ErrorState message={more.error} onRetry={more.reload} />
        ) : !more.data?.length ? (
          <T size={14} color={colors.textSecondary}>
            No other songs from this artist yet.
          </T>
        ) : (
          more.data.map((t, i, list) => <TrackItem key={t.id} track={t} list={list} index={i} context={`More by ${track.artist.name}`} />)
        )}
      </View>
    </Screen>
  );
}
