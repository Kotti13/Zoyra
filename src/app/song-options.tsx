import { router, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, ActivityIndicator, View } from 'react-native';

import { Cover, EmptyState, Icon, PopRing, Sheet, T, Tap, Toast, usePop, type IconName } from '../components';
import { useContentFilter } from '../lib/content-filter';
import { downloads } from '../lib/downloads';
import { isLocalTrack } from '../lib/local-music';
import { isZoyraId, zoyra } from '../lib/zoyra-api';
import { useDownloads } from '../state/downloads';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { setSheetTrack, useSheetTrack } from '../state/selection';
import { colors } from '../theme/tokens';

function ActionRow({ label, icon, filled, onPress, busy }: { label: string; icon: IconName; filled?: boolean; onPress?: () => void; busy?: boolean }) {
  const pop = usePop(filled);
  return (
    <Tap onPress={busy ? undefined : onPress} accessibilityState={{ busy: !!busy }} style={{ flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 48 }}>
      {busy ? (
        <ActivityIndicator size="small" color={colors.accentLight} style={{ width: 22 }} />
      ) : (
        <Animated.View style={{ width: 22, alignItems: 'center', justifyContent: 'center', transform: [{ scale: pop }] }}>
          {filled !== undefined ? <PopRing active={filled} size={34} color={colors.accentLight} /> : null}
          <Icon name={icon} size={22} color={colors.accentLight} filled={filled} />
        </Animated.View>
      )}
      <T size={16}>{label}</T>
    </Tap>
  );
}

/** Set when this sheet hands its track to another sheet, so unmount doesn't clear the selection. */
const handoff = { current: false };

export default function SongOptions() {
  const player = usePlayerPick('track', 'playlist');
  // Keep the selection when handing off to another sheet; clear it ourselves otherwise.
  const track = useSheetTrack(player.track, false);
  useEffect(() => {
    handoff.current = false;
    return () => {
      if (!handoff.current) setSheetTrack(null);
    };
  }, []);
  const { isLiked, toggleLike } = useLibrary();
  const [note, setNote] = useState<string | null>(null);
  const [noteError, setNoteError] = useState(false);
  const [hiding, setHiding] = useState<'song' | 'artist' | null>(null);
  const content = useContentFilter();
  const dl = useDownloads();

  if (!track) {
    return (
      <Sheet>
        <EmptyState title="No song selected" body="Play or pick a song to see its options." />
      </Sheet>
    );
  }

  const liked = isLiked(track.id);
  const songHidden = content.hiddenTracks.has(track.id);
  const artistHidden = content.hiddenArtists.has(track.artist.id);

  /** Hide (or unhide) this song or its artist everywhere: lists, search, radio and autoplay. */
  const toggleHidden = async (kind: 'song' | 'artist') => {
    if (hiding) return;
    setHiding(kind);
    setNote(null);
    setNoteError(false);
    try {
      if (kind === 'song') {
        if (songHidden) await content.unhide('track', track.id);
        else await content.hideSong(track);
      } else if (artistHidden) await content.unhide('artist', track.artist.id);
      else await content.hideArtist({ id: track.artist.id, name: track.artist.name, image: track.artist.image ?? null });
      const was = kind === 'song' ? songHidden : artistHidden;
      const what = kind === 'song' ? `“${track.title}”` : track.artist.name;
      done(was ? `${what} is visible again` : `${what} is hidden. Undo in Settings › Content controls.`);
    } catch (e) {
      setNoteError(true);
      setNote(e instanceof Error ? e.message : 'Could not update hidden content');
    } finally {
      setHiding(null);
    }
  };

  /** Open another track sheet/screen in place of this one, passing the track along. */
  const open = (href: Href) => {
    handoff.current = true;
    setSheetTrack(track);
    router.replace(href);
  };

  const done = (message: string) => {
    setNote(message);
    setTimeout(() => router.canGoBack() && router.back(), 900);
  };

  const downloaded = !!dl.entries[track.id];
  const active = dl.active[track.id];
  const onDownload = () => {
    if (active) {
      downloads.cancel(track.id);
      return setNote('Download cancelled');
    }
    if (downloaded) {
      downloads.remove(track.id);
      return setNote('Removed from downloads');
    }
    setNote('Downloading…');
    downloads
      .downloadTrack(track)
      .then(() => setNote('Downloaded — plays offline'))
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Download failed'));
  };
  const downloadLabel = active
    ? `Downloading ${active.totalBytes > 0 ? `${Math.round(active.progress * 100)}%` : '…'} · tap to cancel`
    : downloaded
      ? 'Remove download'
      : 'Download';

  // Files on this device have no catalogue page, stream URL or server copy.
  const local = isLocalTrack(track);
  const allActions: { label: string; icon: IconName; onPress: () => void; server?: boolean }[] = [
    { label: downloadLabel, icon: downloaded ? 'trash' : 'download', onPress: onDownload, server: true },
    { label: 'Add to playlist', icon: 'plus', onPress: () => open('/add-to-playlist'), server: true },
    {
      label: 'Add to queue',
      icon: 'queue',
      onPress: () => {
        if (!player.track) player.playTrack(track);
        else player.addToQueue(track);
        done('Added to queue');
      },
    },
    {
      label: 'Play next',
      icon: 'play',
      onPress: () => {
        if (!player.track) player.playTrack(track);
        else player.playNext(track);
        done('Playing next');
      },
    },
    ...(isZoyraId(track.id)
      ? [
          {
            label: 'Watch video',
            icon: 'play' as IconName,
            onPress: () => {
              // Same song already playing → start the video where the audio is.
              const at = player.track?.id === track.id ? Math.floor(player.playlist.currentTime || 0) : 0;
              router.replace({ pathname: '/video-player', params: { id: zoyra.videoId(track.id), t: String(at) } });
            },
            server: true,
          },
        ]
      : []),
    { label: 'Go to artist', icon: 'user', onPress: () => router.replace({ pathname: '/artist', params: { id: track.artist.id } }), server: true },
    { label: 'Share', icon: 'share', onPress: () => open('/share-sheet'), server: true },
    { label: 'Dedicate this song', icon: 'heart', onPress: () => open('/dedication'), server: true },
    { label: 'Song credits', icon: 'file', onPress: () => open('/credits'), server: true },
    { label: 'Sleep timer', icon: 'moon', onPress: () => router.replace('/sleep-sheet') },
  ];
  const actions = allActions.filter((a) => !(local && a.server));

  return (
    <Sheet>
      {/* Track header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: colors.glassBorder }}>
        <Cover artwork={track.artwork} id={track.id} size={56} radius={28} />
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          <T size={16} weight={600} accessibilityRole="header" numberOfLines={1}>
            {track.title}
          </T>
          <T size={14} color={colors.textSecondary} numberOfLines={1}>
            {track.artist.name}
          </T>
        </View>
      </View>

      {local ? null : (
      <ActionRow
        label={liked ? 'Liked' : 'Like'}
        icon="heart"
        filled={liked}
        onPress={() => toggleLike(track).catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Could not update your likes'))}
      />
      )}
      {actions.map(({ server: _server, ...a }) => (
        <ActionRow key={a.label} {...a} />
      ))}
      {local ? null : (
        <>
          <ActionRow label={songHidden ? 'Unhide song' : 'Hide song'} icon="close" busy={hiding === 'song'} onPress={() => void toggleHidden('song')} />
          <ActionRow label={artistHidden ? `Unhide ${track.artist.name}` : `Hide artist`} icon="user" busy={hiding === 'artist'} onPress={() => void toggleHidden('artist')} />
        </>
      )}

      {note ? <Toast message={note} icon={noteError ? 'info' : 'check'} iconColor={noteError ? colors.error : colors.success} /> : null}
    </Sheet>
  );
}
