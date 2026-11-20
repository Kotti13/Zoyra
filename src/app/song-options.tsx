import { router, type Href } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Animated, ActivityIndicator, View } from 'react-native';

import { Button, Cover, EmptyState, Icon, Row, Sheet, T, Tap, Toast, ToggleBurst, usePop, type IconName } from '../components';
import { formatDuration } from '../lib/catalog';
import { useContentFilter } from '../lib/content-filter';
import { downloads } from '../lib/downloads';
import { isLocalTrack } from '../lib/local-music';
import { artistStation, startStation } from '../lib/radio';
import { isZoyraId, zoyra } from '../lib/zoyra-api';
import { useDownloads } from '../state/downloads';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { setSheetTrack, useSheetTrack } from '../state/selection';
import { colors } from '../theme/tokens';

/** Quick-action tile (Liked / Playlist / Download / Share): 72 px tall, radius 22. */
function Tile({ label, icon, on, onPress, busy }: { label: string; icon: IconName; on?: boolean; onPress: () => void; busy?: boolean }) {
  const pop = usePop(on);
  return (
    <Tap
      onPress={busy ? undefined : onPress}
      accessibilityLabel={label}
      accessibilityState={{ busy: !!busy, ...(on !== undefined ? { selected: on } : null) }}
      style={{
        flex: 1,
        height: 72,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        backgroundColor: on ? 'rgba(229,9,20,0.18)' : 'rgba(255,255,255,0.07)',
        borderWidth: 1,
        borderColor: on ? 'rgba(229,9,20,0.5)' : 'rgba(255,255,255,0.12)',
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.accentLight} />
      ) : (
        <Animated.View style={{ transform: [{ scale: pop }] }}>
          {on !== undefined ? (
            <ToggleBurst active={on} kind={icon === 'heart' ? 'like' : 'save'} size={44}>
              <Icon name={icon} size={22} color={on ? colors.accentLight : colors.text} filled={on} />
            </ToggleBurst>
          ) : (
            <Icon name={icon} size={22} color={on ? colors.accentLight : colors.text} filled={on} />
          )}
        </Animated.View>
      )}
      <T size={12} weight={600} numberOfLines={1}>
        {label}
      </T>
    </Tap>
  );
}

function Label({ children }: { children: string }) {
  return (
    <T size={11} weight={700} tracking={1.4} color={colors.textSecondary} style={{ marginHorizontal: 4, marginTop: 2, marginBottom: -4 }}>
      {children}
    </T>
  );
}

/** Glass group card (radius 32) holding divided rows. */
function Group({ children }: { children: ReactNode }) {
  return <View style={{ borderRadius: 32, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>{children}</View>;
}

function ActionRow({ label, sub, icon, onPress, busy, trailing, first }: { label: string; sub?: string; icon: IconName; onPress?: () => void; busy?: boolean; trailing?: string; first?: boolean }) {
  return (
    <Tap
      onPress={busy ? undefined : onPress}
      accessibilityState={{ busy: !!busy }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 14, minHeight: 62, borderTopWidth: first ? 0 : 1, borderTopColor: 'rgba(255,255,255,0.07)' }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' }}>
        {busy ? <ActivityIndicator size="small" color={colors.accentLight} /> : <Icon name={icon} size={20} color={colors.text} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={15} weight={600} numberOfLines={1}>
          {label}
        </T>
        {sub ? (
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {sub}
          </T>
        ) : null}
      </View>
      {trailing ? (
        <T size={13} color={colors.textSecondary}>
          {trailing}
        </T>
      ) : (
        <Icon name="chevronRight" size={18} color={colors.textSecondary} />
      )}
    </Tap>
  );
}

/** Set when this sheet hands its track to another sheet, so unmount doesn't clear the selection. */
const handoff = { current: false };

export default function SongOptions() {
  const player = usePlayerPick('track', 'playlist', 'sleep');
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
  const [radioBusy, setRadioBusy] = useState(false);
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

  const startRadio = async () => {
    if (radioBusy) return;
    setRadioBusy(true);
    try {
      const r = await startStation(artistStation(track.artist), player.playTracks);
      if (r.ok) done(r.text);
      else {
        setNoteError(true);
        setNote(r.text);
      }
    } catch (e) {
      setNoteError(true);
      setNote(e instanceof Error ? e.message : 'Could not start the radio');
    } finally {
      setRadioBusy(false);
    }
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

  // Files on this device have no catalogue page, stream URL or server copy.
  const local = isLocalTrack(track);
  const isCurrent = player.track?.id === track.id;
  const openLyrics = () => {
    if (!isCurrent) player.playTrack(track);
    router.replace('/lyrics');
  };
  const downloadTitle = active
    ? `${active.totalBytes > 0 ? `${Math.round(active.progress * 100)}%` : '…'}`
    : downloaded
      ? 'Remove'
      : 'Download';

  const play: ReactNode[] = [
    <ActionRow
      key="next"
      first
      label="Play next"
      icon="play"
      onPress={() => {
        if (!player.track) player.playTrack(track);
        else player.playNext(track);
        done('Playing next');
      }}
    />,
    <ActionRow
      key="queue"
      label="Add to queue"
      icon="queue"
      onPress={() => {
        if (!player.track) player.playTrack(track);
        else player.addToQueue(track);
        done('Added to queue');
      }}
    />,
    ...(local
      ? []
      : [
          <ActionRow
            key="radio"
            label="Start song radio"
            sub="Endless mix like this artist"
            icon="bolt"
            busy={radioBusy}
            onPress={() => void startRadio()}
          />,
        ]),
    <ActionRow key="sleep" label="Sleep timer" icon="moon" trailing={player.sleep ? 'On' : 'Off'} onPress={() => router.replace('/sleep-sheet')} />,
  ];

  const explore: ReactNode[] = local
    ? []
    : [
        <ActionRow key="artist" first label="Go to artist" sub={track.artist.name} icon="user" onPress={() => router.replace({ pathname: '/artist', params: { id: track.artist.id } })} />,
        ...(isZoyraId(track.id)
          ? [
              <ActionRow
                key="video"
                label="Watch music video"
                icon="video"
                onPress={() => {
                  // Same song already playing → start the video where the audio is.
                  const at = player.track?.id === track.id ? Math.floor(player.playlist.currentTime || 0) : 0;
                  router.replace({ pathname: '/video-player', params: { id: zoyra.videoId(track.id), t: String(at) } });
                }}
              />,
            ]
          : []),
        <ActionRow key="lyrics" label="View lyrics" icon="mic" onPress={openLyrics} />,
        <ActionRow key="comments" label="Comments" icon="chat" onPress={() => router.replace({ pathname: '/track-comments', params: { id: track.id } })} />,
        <ActionRow key="credits" label="Song credits" icon="file" onPress={() => open('/credits')} />,
      ];

  const send: ReactNode[] = local
    ? []
    : [
        <ActionRow key="chat" first label="Send in chat" sub="Share with friends and groups" icon="chat" onPress={() => open('/share-sheet')} />,
        <ActionRow key="dedicate" label="Dedicate this song" icon="heart" onPress={() => open('/dedication')} />,
        <ActionRow key="nearby" label="Nearby share" icon="wifi" onPress={() => open('/nearby-share')} />,
        <ActionRow key="jam" label="Start a jam" icon="users" onPress={() => router.replace('/group-listening')} />,
      ];

  const more: ReactNode[] = local
    ? []
    : [
        <ActionRow key="stats" first label="Stats for nerds" sub="Codec, bitrate, buffer and network" icon="chart" onPress={() => open('/stats-nerds')} />,
        <ActionRow key="hs" label={songHidden ? 'Unhide this song' : 'Hide this song'} icon="close" busy={hiding === 'song'} onPress={() => void toggleHidden('song')} />,
        <ActionRow key="ha" label={artistHidden ? `Unhide ${track.artist.name}` : 'Hide artist'} icon="user" busy={hiding === 'artist'} onPress={() => void toggleHidden('artist')} />,
      ];

  const section = (title: string, rows: ReactNode[]) =>
    rows.length ? (
      <>
        <Label>{title}</Label>
        <Group>{rows}</Group>
      </>
    ) : null;

  return (
    <Sheet>
      {/* Track header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Cover artwork={track.artwork} id={track.id} size={64} radius={18} />
        <View style={{ gap: 3, flex: 1, minWidth: 0 }}>
          <T size={20} weight={700} tracking={-0.3} accessibilityRole="header" numberOfLines={1}>
            {track.title}
          </T>
          <T size={14} color="#FF9AA0" numberOfLines={1}>
            {track.artist.name}
          </T>
          <Row gap={6} style={{ marginTop: 2 }}>
            <View style={{ height: 20, paddingHorizontal: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center' }}>
              <T size={10} weight={700}>
                {formatDuration(track.duration)}
              </T>
            </View>
          </Row>
        </View>
      </View>

      {/* Quick actions */}
      <Row gap={8}>
        {local ? null : (
          <Tile label={liked ? 'Liked' : 'Like'} icon="heart" on={liked} onPress={() => toggleLike(track).catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Could not update your likes'))} />
        )}
        {local ? null : <Tile label="Playlist" icon="plus" onPress={() => open('/add-to-playlist')} />}
        {local ? null : <Tile label={downloadTitle} icon={downloaded ? 'trash' : 'download'} onPress={onDownload} />}
        {local ? null : <Tile label="Share" icon="share" onPress={() => open('/share-sheet')} />}
      </Row>

      {section('PLAY', play)}
      {section('EXPLORE', explore)}
      {section('SEND', send)}
      {section('MORE', more)}

      <Button variant="glass" label="Close" height={50} href="back" />

      {note ? <Toast message={note} icon={noteError ? 'info' : 'check'} iconColor={noteError ? colors.error : colors.success} /> : null}
    </Sheet>
  );
}
