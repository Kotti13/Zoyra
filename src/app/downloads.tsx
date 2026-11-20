import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { Art, Button, Cover, EmptyState, Glass, Icon, IconButton, ListRow, MiniPlayer, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, T, Toast, Toggle } from '../components';
import { downloads, formatBytes } from '../lib/downloads';
import { toggleCollectionDownload, useCollectionDownload, useDownloads } from '../state/downloads';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const CONTEXT = 'Downloads';

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <Row gap={6}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </Row>
  );
}

const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function Downloads() {
  const { liked, playlists, reload: reloadLibrary } = useLibrary();
  const player = usePlayerPick('track', 'shuffle');
  const dl = useDownloads();
  const [note, setNote] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: string) => {
    setNote(m);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setNote(null), 3500);
  }, []);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);
  useEffect(() => {
    setCacheBytes(downloads.cacheBytes());
  }, [dl.totalBytes]);

  // Pull to refresh: re-scan the files on disk, re-measure the cache and reload liked songs / playlists.
  const refresh = async () => {
    const [dropped] = await Promise.all([downloads.rescan().catch(() => 0), reloadLibrary().catch(() => undefined)]);
    setCacheBytes(downloads.cacheBytes());
    if (dropped) show(`Removed ${dropped} ${dropped === 1 ? 'download' : 'downloads'} whose file was missing`);
  };

  const tracks = useMemo(() => dl.list.map((e) => e.track), [dl.list]);
  const likedIds = useMemo(() => liked.map((x) => x.id), [liked]);
  const likedStatus = useCollectionDownload(likedIds);
  const active = Object.values(dl.active);
  const queuedCount = dl.queued.length;

  const used = dl.totalBytes + (cacheBytes ?? 0);
  const dlPct = used > 0 ? (dl.totalBytes / used) * 100 : 0;
  const cachePct = used > 0 ? ((cacheBytes ?? 0) / used) * 100 : 0;

  const playAll = (shuffle: boolean) => {
    if (!tracks.length) return;
    if (player.shuffle !== shuffle) player.setShuffle(shuffle);
    player.playTracks(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0, CONTEXT);
  };

  const removeAll = () => {
    if (!confirmAll) {
      setConfirmAll(true);
      return show('Tap “Remove all” again to delete every download');
    }
    setConfirmAll(false);
    const n = tracks.length;
    downloads.removeAll();
    show(`Removed ${n} ${n === 1 ? 'download' : 'downloads'}`);
  };

  return (
    <Screen backdrop={{ pattern: 'lines', mesh: 'gold' }} top={4} gap={16} bottom={16} footer={<MiniPlayer />} onRefresh={refresh}>
      <ScreenHeader title="Downloads" />

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <T size={24} weight={700}>
              {dl.ready ? formatBytes(dl.totalBytes) : '…'}
            </T>
            <T mono size={12} color={colors.textSecondary}>
              {tracks.length} {tracks.length === 1 ? 'song' : 'songs'} downloaded
            </T>
          </Row>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={`Downloads ${formatBytes(dl.totalBytes)}, cache ${formatBytes(cacheBytes ?? 0)}`}
            accessibilityValue={{ min: 0, max: 100, now: Math.round(dlPct) }}
            style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.track }}
          >
            <View style={{ width: `${dlPct}%`, backgroundColor: colors.accent }} />
            <View style={{ width: `${cachePct}%`, backgroundColor: colors.orange }} />
          </View>
          <Row gap={16}>
            <Legend color={colors.accent} label={`Downloads ${formatBytes(dl.totalBytes)}`} />
            <Legend color={colors.orange} label={`Cache ${cacheBytes == null ? '…' : formatBytes(cacheBytes)}`} />
          </Row>
          <T size={13} color={colors.textSecondary} lineHeight={18}>
            Downloads are kept privately inside Zoyra for offline listening. They can’t be exported or opened in other apps.
          </T>
        </View>
      </Glass>

      {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}

      <Glass padding={4}>
        <ListRow
          minHeight={64}
          title="Download over Wi-Fi only"
          subtitle={dl.connection === 'wifi' ? 'On Wi-Fi now' : dl.online ? 'Save mobile data' : 'You are offline'}
          right={<Toggle value={dl.wifiOnly} label="Wi-Fi only" onChange={downloads.setWifiOnly} />}
        />
      </Glass>

      {active.length > 0 || queuedCount > 0 ? (
        <>
          <SectionHeader title={`Downloading${queuedCount ? ` · ${queuedCount} waiting` : ''}`} />
          <Glass padding={4}>
            {active.map((a, i) => {
              return (
                <View key={a.trackId} style={[{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T size={14} weight={500} numberOfLines={1} style={{ flex: 1 }}>
                      {a.title}
                    </T>
                    <T mono size={12} color={colors.textSecondary}>
                      {a.totalBytes > 0 ? `${formatBytes(a.bytesWritten)} / ${formatBytes(a.totalBytes)}` : formatBytes(a.bytesWritten)}
                    </T>
                    <IconButton icon="close" label="Cancel download" color={colors.textSecondary} onPress={() => downloads.cancel(a.trackId)} />
                  </Row>
                  <ProgressBar value={a.progress} />
                </View>
              );
            })}
          </Glass>
        </>
      ) : null}

      <SectionHeader title="Downloaded" />
      {!dl.ready ? null : tracks.length === 0 ? (
        <EmptyState icon="download" title="No downloads yet" body="Tap Download on an album or playlist, or pick Download from any song’s ⋯ menu." />
      ) : (
        <>
          <Row gap={12}>
            <Button label="Play" icon="play" style={{ flex: 1 }} onPress={() => playAll(false)} />
            <Button label="Shuffle" icon="shuffle" variant="glass" style={{ flex: 1 }} onPress={() => playAll(true)} />
          </Row>
          <Glass padding={4}>
            {dl.list.map((e, i) => {
              const current = player.track?.id === e.track.id;
              return (
                <ListRow
                  key={e.track.id}
                  divider={i > 0}
                  minHeight={64}
                  title={e.track.title}
                  titleColor={current ? colors.accentLight : colors.text}
                  subtitle={`${e.track.artist.name} · ${mins(e.track.duration)} · ${formatBytes(e.bytes)}`}
                  leading={<Cover uri={e.artworkPath} artwork={e.track.artwork} id={e.track.id} size={48} radius={14} />}
                  onPress={() => player.playTracks(tracks, i, CONTEXT)}
                  right={
                    <IconButton
                      icon="trash"
                      label={`Remove ${e.track.title} from downloads`}
                      color={colors.textSecondary}
                      onPress={() => {
                        downloads.remove(e.track.id);
                        show('Removed from downloads');
                      }}
                    />
                  }
                />
              );
            })}
          </Glass>
          <Button label={confirmAll ? 'Tap again to remove all' : 'Remove all downloads'} variant="destructive" onPress={removeAll} />
        </>
      )}

      {liked.length > 0 || playlists.length > 0 ? (
        <>
          <SectionHeader title="Download more" />
          <Glass padding={4}>
            {liked.length > 0 ? (
              <ListRow
                minHeight={72}
                title="Liked Songs"
                subtitle={
                  likedStatus.downloading
                    ? `Downloading · ${likedStatus.downloaded}/${likedStatus.total}`
                    : `${likedStatus.downloaded}/${liked.length} ${liked.length === 1 ? 'song' : 'songs'} downloaded`
                }
                href={{ pathname: '/playlist', params: { liked: '1' } }}
                leading={
                  <Art art="sunrise" size={48} radius={14} style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="heart" size={20} color={colors.white} />
                  </Art>
                }
                right={
                  <IconButton
                    icon={likedStatus.complete ? 'check' : 'download'}
                    iconSize={20}
                    label={likedStatus.downloading ? 'Cancel Liked Songs download' : likedStatus.complete ? 'Remove Liked Songs download' : 'Download Liked Songs'}
                    color={likedStatus.complete ? colors.success : likedStatus.downloading ? colors.accentLight : colors.textSecondary}
                    onPress={() => toggleCollectionDownload(liked, likedStatus, show)}
                  />
                }
              />
            ) : null}
            {playlists.map((p, i) => (
              <ListRow
                key={p.id}
                href={{ pathname: '/playlist', params: { id: p.id } }}
                divider={i > 0 || liked.length > 0}
                minHeight={72}
                title={p.title}
                subtitle={`Playlist · ${p.track_count ?? 0} ${(p.track_count ?? 0) === 1 ? 'song' : 'songs'} · open to download`}
                leading={<Cover uri={p.cover_url} id={p.id} size={48} radius={14} />}
              />
            ))}
          </Glass>
        </>
      ) : null}
    </Screen>
  );
}
