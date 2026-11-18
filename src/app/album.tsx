import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import {
  Cover,
  EmptyState,
  ErrorState,
  Glass,
  IconButton,
  LinkText,
  Loading,
  MiniPlayer,
  ProgressBar,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  Spacer,
  T,
  Tap,
  Toast,
  TrackItem,
  useAsync,
} from '../components';
import { catalog, formatCount } from '../lib/catalog';
import { albumShareUrl, shareContent } from '../lib/share-links';
import { useContentFilter } from '../lib/content-filter';
import { setSheetTrack } from '../state/selection';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { toggleCollectionDownload, useCollectionDownload } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { colors, shadow } from '../theme/tokens';

function useNote() {
  const [note, setNote] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string) => {
    setNote(msg);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setNote(null), 3200);
  }, []);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  return { note, show };
}

const fmtDate = (d?: string) => {
  if (!d) return undefined;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? undefined : x.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
};

export default function Album() {
  const { id: rawId } = useLocalSearchParams<{ id?: string }>();
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const { user } = useAuth();
  const lib = useLibrary();
  const player = usePlayerPick('track', 'playing', 'shuffle', 'context');
  const { note, show } = useNote();

  const album = useAsync(async () => {
    if (!id) return null;
    const [info, tracks] = await Promise.all([catalog.collection(id), catalog.collectionTracks(id)]);
    return { info, tracks };
  }, [id]);
  const artistId = album.data?.info.artist.id;
  const more = useAsync(async () => (artistId ? (await catalog.artistCollections(artistId, 12)).filter((c) => c.id !== id) : []), [artistId, id]);

  const info = album.data?.info;
  const { filter: hideFilter } = useContentFilter();
  const tracks = useMemo(() => hideFilter(album.data?.tracks ?? []), [album.data, hideFilter]);
  const ctx = `album:${id}`;
  const isCurrent = player.context === ctx;
  const playingHere = isCurrent && player.playing;
  const savedLabel = info ? `Album · ${info.artist.name}` : '';
  const saved = !!info && lib.playlists.some((p) => p.title === info.title && p.description === savedLabel);
  const [saving, setSaving] = useState(false);
  const trackIds = useMemo(() => tracks.map((t) => t.id), [tracks]);
  const dlStatus = useCollectionDownload(trackIds);

  const onPlay = () => {
    if (isCurrent && player.track) return player.toggle();
    if (tracks.length) player.playTracks(tracks, 0, ctx);
  };

  const onSave = async () => {
    if (!info) return;
    if (saved) return show('Already in your library');
    if (!user) return show('Sign in to save albums');
    setSaving(true);
    try {
      const p = await lib.createPlaylist({ title: info.title.slice(0, 100), description: savedLabel });
      await lib.addToPlaylist(p.id, tracks);
      show('Saved to your library');
    } catch (e) {
      show(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const year = info?.releaseDate ? new Date(info.releaseDate).getFullYear() : undefined;

  return (
    <Screen onRefresh={() => Promise.all([album.refresh(), more.refresh()])} backdrop={{ pattern: 'lines', mesh: 'amber' }} top={4} gap={16} bottom={16} footer={<MiniPlayer />}>
      <ScreenHeader
        title="Album"
        right={
          tracks[0] ? <IconButton icon="more" label="More" href="/song-options" onPress={() => setSheetTrack(tracks[0])} /> : <IconButton icon="more" label="More" onPress={() => show('Nothing to show yet')} />
        }
      />

      {!id ? (
        <EmptyState title="Album not found" body="Open an album from an artist page or search." action="Search" href="/search" />
      ) : album.loading && !album.data ? (
        <Loading label="Loading album" height={320} />
      ) : album.error ? (
        <ErrorState message={album.error} onRetry={album.reload} />
      ) : info ? (
        <>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ borderRadius: 26, shadowColor: colors.accent, shadowOpacity: 0.3, shadowRadius: 40, shadowOffset: { width: 0, height: 0 } }}>
              <Cover artwork={info.artwork.medium || info.artwork.large ? info.artwork : tracks[0]?.artwork} id={info.id} size={200} radius={26} style={shadow.artGlow} />
            </View>
          </View>

          <View style={{ gap: 4 }}>
            <T variant="title" accessibilityRole="header">
              {info.title}
            </T>
            <Tap href={{ pathname: '/artist', params: { id: info.artist.id } }} style={{ alignSelf: 'flex-start', minHeight: 24 }}>
              <T size={16} weight={500} color={colors.accentLight}>
                {info.artist.name}
              </T>
            </Tap>
            <T size={13} color={colors.textSecondary}>
              {[info.isAlbum ? 'Album' : 'Collection', year, `${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`].filter(Boolean).join(' · ')}
            </T>
          </View>

          <Row gap={4}>
            <IconButton
              icon={dlStatus.complete ? 'check' : 'download'}
              label={dlStatus.downloading ? 'Cancel download' : dlStatus.complete ? 'Remove download' : 'Download'}
              size={48}
              color={dlStatus.complete ? colors.success : dlStatus.downloading ? colors.accentLight : colors.text}
              onPress={() => toggleCollectionDownload(tracks, dlStatus, show)}
            />
            <IconButton icon="heart" label={saved ? 'In your library' : 'Save to library'} size={48} filled={saved} color={saved ? colors.like : saving ? colors.textSecondary : colors.text} onPress={() => void onSave()} />
            <IconButton
              icon="share"
              label="Share"
              size={48}
              onPress={() => void shareContent({ url: albumShareUrl(info.id), title: info.title, message: `${info.title} by ${info.artist.name} on Zoyra` }).catch(() => show('Could not open the share sheet'))}
            />
            <IconButton icon="more" label="More" size={48} onPress={() => (tracks.forEach((t) => player.addToQueue(t)), show(`Added ${tracks.length} songs to your queue`))} />
            <Spacer />
            <IconButton icon="shuffle" label="Shuffle" size={48} color={player.shuffle ? colors.amber : colors.textSecondary} onPress={() => player.setShuffle(!player.shuffle)} />
            <IconButton icon={playingHere ? 'pause' : 'play'} label={playingHere ? 'Pause' : 'Play'} size={56} iconSize={26} bg={colors.accent} color={colors.onAccent} onPress={onPlay} />
          </Row>

          {dlStatus.downloading ? (
            <View style={{ gap: 6 }} accessibilityLabel={`Downloading, ${dlStatus.downloaded} of ${dlStatus.total} songs saved`}>
              <ProgressBar value={dlStatus.progress} />
              <T mono size={12} color={colors.textSecondary}>
                Downloading · {dlStatus.downloaded}/{dlStatus.total}
              </T>
            </View>
          ) : dlStatus.downloaded > 0 && !dlStatus.complete ? (
            <T mono size={12} color={colors.textSecondary}>
              {dlStatus.downloaded}/{dlStatus.total} downloaded
            </T>
          ) : null}
          {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}

          {tracks.length === 0 ? (
            <EmptyState title="No playable songs" body="None of this album’s songs are available to stream right now." />
          ) : (
            <View>
              {tracks.map((t, i) => (
                <TrackItem key={t.id} track={t} list={tracks} index={i} showIndex context={ctx} artRadius={14} />
              ))}
            </View>
          )}

          <Glass padding={16}>
            <View style={{ gap: 6 }}>
              <T size={12} tracking={0.2} color={colors.textSecondary}>
                Released
              </T>
              <T size={15}>{fmtDate(info.releaseDate) ?? 'Unknown'}</T>
              <T size={12} tracking={0.2} color={colors.textSecondary} style={{ marginTop: 6 }}>
                Plays
              </T>
              <T size={15}>{formatCount(info.plays)}</T>
              {tracks[0] ? (
                <View style={{ marginTop: 6, alignSelf: 'flex-start' }}>
                  <LinkText label="View credits" href="/credits" onPress={() => setSheetTrack(tracks[0])} />
                </View>
              ) : null}
            </View>
          </Glass>

          {more.data && more.data.length > 0 ? (
            <View style={{ gap: 12 }}>
              <SectionHeader title={`More from ${info.artist.name}`} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -16 }} contentContainerStyle={{ gap: 12, paddingRight: 16 }}>
                {more.data.map((m) => (
                  <Tap key={m.id} href={{ pathname: '/album', params: { id: m.id } }} style={{ width: 120, gap: 6 }}>
                    <Cover artwork={m.artwork} id={m.id} size={120} radius={20} />
                    <T size={13} weight={600} numberOfLines={1}>
                      {m.title}
                    </T>
                  </Tap>
                ))}
              </ScrollView>
            </View>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
