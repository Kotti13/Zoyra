import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar, Chip, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, Row, Screen, ScreenHeader, T, Tap, Toast, TrackItem, artFor, useAsync } from '../components';
import { countTrackComments } from '../lib/track-comments';
import type { NavTarget } from '../components/controls';
import { catalog, formatCount, formatDuration } from '../lib/catalog';
import { fetchLyrics, sourceLines } from '../lib/lyrics';
import { formatReleaseDate, loadTrackDetail } from '../lib/premieres';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

const WAVE = Array.from({ length: 38 }, (_, i) => 22 + Math.round(Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.31)) * 88));

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
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { playTrack, track: current, playing, toggle } = usePlayerPick('track', 'playing');
  const { isLiked, toggleLike } = useLibrary();
  const [expanded, setExpanded] = useState(false);
  const [liking, setLiking] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const detail = useAsync(async () => (id ? loadTrackDetail(id) : null), [id], 'app/track-detail:44');
  const track = detail.data?.track;
  const extras = detail.data?.extras;

  const lyrics = useAsync(async () => (track ? fetchLyrics(track) : null), [track?.id], 'app/track-detail:48');
  const commentCount = useAsync(async () => (id ? countTrackComments(id).catch(() => null) : null), [id], 'app/track-detail:49');
  const more = useAsync(async () => (track ? (await catalog.artistTracks(track.artist.id, 8)).filter((t) => t.id !== track.id).slice(0, 5) : []), [track?.id], 'app/track-detail:50');

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

  const pill = { height: 34, paddingHorizontal: 16, borderRadius: 17, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' } as const;
  const heading = (title: string, action?: string, onAction?: () => void, href?: NavTarget) => (
    <Row style={{ justifyContent: 'space-between' }}>
      <T size={17} weight={500} accessibilityRole="header">
        {title}
      </T>
      {action ? <LinkText label={action} href={href} onPress={onAction} size={13} /> : null}
    </Row>
  );

  return (
    <Screen onRefresh={() => Promise.all([detail.refresh(), lyrics.refresh(), more.refresh()])} top={4} gap={0} bottom={0} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      {/* Full-bleed hero: artwork, back / more, centered play, waveform */}
      <View style={{ marginTop: -(insets.top + 4), marginHorizontal: -16, height: 420 + insets.top * 0, overflow: 'hidden' }}>
        <Cover artwork={track.artwork} id={track.id} size={420} width={width} height={420} radius={0} />
        <LinearGradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.7)]} locations={[0.38, 1]} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View pointerEvents="none" style={{ position: 'absolute', left: 18, right: 18, bottom: 50, height: 120, flexDirection: 'row', alignItems: 'flex-end', gap: 4 }}>
          {WAVE.map((h, i) => (
            <View key={i} style={{ flex: 1, height: h, borderRadius: 3, backgroundColor: withAlpha(colors.rose, 0.7), opacity: 0.4 + 0.6 * Math.sin((Math.PI * (i + 1)) / (WAVE.length + 1)) }} />
          ))}
        </View>
        <View style={{ position: 'absolute', top: insets.top + 12, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' }}>
          <IconButton icon="back" label="Back" href="back" bg="rgba(0,0,0,0.38)" color={colors.text} />
          <IconButton icon="more" label="More options" bg="rgba(0,0,0,0.38)" color={colors.text} onPress={() => openSheet('/song-options')} />
        </View>
        <Tap
          onPress={onPlay}
          accessibilityLabel={isCurrent && playing ? 'Pause' : 'Play'}
          style={{ position: 'absolute', left: '50%', top: '44%', marginLeft: -34, marginTop: -34, width: 68, height: 68, borderRadius: 34, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', backgroundColor: 'rgba(40,40,40,0.55)' }}
        >
          {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={20} style={StyleSheet.absoluteFill} /> : null}
          <Icon name={isCurrent && playing ? 'pause' : 'play'} size={30} color={colors.white} filled />
        </Tap>
      </View>

      {/* Glass sheet overlapping the hero */}
      <Glass radius={36} style={{ marginTop: -56, marginHorizontal: -16, borderBottomLeftRadius: 0, borderBottomRightRadius: 0, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 24, gap: 16 }}>
        <View style={{ alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' }} />
        <View style={{ alignItems: 'center', gap: 4 }}>
          <T size={38} weight={300} tracking={-1} lineHeight={42} align="center" numberOfLines={3} accessibilityRole="header">
            {track.title}
          </T>
          <Tap href={{ pathname: '/artist', params: { id: track.artist.id } }} accessibilityLabel={`Go to artist ${track.artist.name}`} style={{ minHeight: 32, justifyContent: 'center' }}>
            <T size={14} weight={300} style={{ fontStyle: "italic" }} color={colors.textSecondary}>
              {track.artist.name}
              {released ? ` · ${released}` : ''}
            </T>
          </Tap>
        </View>
        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.1)' }} />

        <Row gap={8}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 8, alignItems: 'center' }}>
            {track.genre ? (
              <View style={pill}>
                <T size={13} weight={500}>{track.genre}</T>
              </View>
            ) : null}
            {track.mood ? (
              <View style={pill}>
                <T size={13} weight={500}>{track.mood}</T>
              </View>
            ) : null}
            <View style={[pill, { paddingHorizontal: 14, gap: 4 }]}>
              <Icon name="play" size={13} color={colors.amber} filled />
              <T size={13} weight={700} color={colors.amber}>{formatCount(track.plays)}</T>
            </View>
          </ScrollView>
          <IconButton icon="share" label="Share song" onPress={() => openSheet('/share-sheet')} />
          <IconButton icon="plus" label="Add to playlist" onPress={() => openSheet('/add-to-playlist')} />
          <IconButton icon="heart" filled={liked} color={liked ? colors.like : colors.text} label={liked ? 'Remove from liked songs' : 'Like song'} onPress={() => void onLike()} />
        </Row>

        {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.amber} message={note.text} /> : null}

        {/* Real counts */}
        <Row>
          <Stat value={formatCount(track.plays)} label="Plays" />
          <Stat value={formatCount(track.likes)} label="Favourites" />
          <Stat value={formatCount(extras.reposts)} label="Reposts" />
          {extras.comments ? <Stat value={formatCount(extras.comments)} label="Comments" /> : null}
        </Row>

        <Tap href={{ pathname: '/track-comments', params: { id: track.id } }} accessibilityLabel="Open comments" pressScale={0.98}>
          <Row gap={12} style={{ minHeight: 44 }}>
            <Icon name="mail" size={20} color={colors.accentLight} />
            <T size={15} weight={600} style={{ flex: 1 }}>
              Comments{commentCount.data ? ` · ${formatCount(commentCount.data)}` : ''}
            </T>
            <T size={13} color={colors.textSecondary}>
              Add yours
            </T>
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </Row>
        </Tap>

        {track.tags?.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -20 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}>
            {track.tags.slice(0, 8).map((tag) => (
              <Chip key={tag} label={`#${tag}`} onPress={() => router.push({ pathname: '/genre', params: { name: track.genre ?? tag } })} />
            ))}
          </ScrollView>
        ) : null}

        {extras.description ? (
          <View style={{ gap: 8 }}>
            {heading('About the song')}
            <T size={14} weight={300} lineHeight={22} color={colors.textSecondary} numberOfLines={expanded ? undefined : 4}>
              {extras.description}
            </T>
            {extras.description.length > 180 ? (
              <Tap onPress={() => setExpanded((v) => !v)} accessibilityLabel={expanded ? 'Show less' : 'Show more'} style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}>
                <T size={14} weight={600} color={colors.live}>
                  {expanded ? 'Less' : 'More'}
                </T>
              </Tap>
            ) : null}
          </View>
        ) : null}

        <View style={{ gap: 12 }}>
          {heading(artists.length > 1 ? 'Featured artists' : 'Artist')}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -20 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 20 }}>
            {artists.map((a, i) => (
              <Tap key={a.id} href={{ pathname: '/artist', params: { id: a.id } }} accessibilityLabel={`Go to artist ${a.name}`} style={{ width: 76, alignItems: 'center', gap: 6 }}>
                {i === 0 && track.artist.image ? <Cover uri={track.artist.image} id={a.id} size={76} radius={25} /> : <Avatar initial={a.name[0]?.toUpperCase()} art={artFor(a.id)} size={76} radius={25} />}
                <T size={12} numberOfLines={1} align="center">
                  {a.name}
                </T>
              </Tap>
            ))}
          </ScrollView>
        </View>

        {/* Lyrics preview */}
        <View style={{ gap: 8 }}>
          {heading('Lyrics', lyricLines.length ? 'Open lyrics' : undefined, () => {
            if (!isCurrent) playTrack(track, track.title);
            router.push('/lyrics');
          })}
          {lyrics.loading && !lyrics.data ? (
            <Loading height={80} />
          ) : lyrics.error ? (
            <ErrorState message={lyrics.error} onRetry={lyrics.reload} />
          ) : lyrics.data?.instrumental ? (
            <T size={14} color={colors.textSecondary}>
              This one is an instrumental.
            </T>
          ) : lyricLines.length ? (
            <View style={{ gap: 6 }}>
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
            </View>
          ) : (
            <T size={14} color={colors.textSecondary}>
              No lyrics found for this song.
            </T>
          )}
        </View>

        {/* Details */}
        <View style={{ gap: 10 }}>
          {heading('Details')}
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
        </View>

        {/* More by artist */}
        <View>
          {heading(`More by ${track.artist.name}`, 'Artist', undefined, { pathname: '/artist', params: { id: track.artist.id } })}
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

        <Tap href="/credits" onPress={() => setSheetTrack(track)} accessibilityLabel="View credits">
          <Glass radius={24} style={{ height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Icon name="music" size={18} color={colors.text} />
            <T size={15} weight={600}>View credits</T>
          </Glass>
        </Tap>
      </Glass>
    </Screen>
  );
}
