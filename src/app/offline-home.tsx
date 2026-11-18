import NetInfo, { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, EmptyState, Glass, Icon, ListGroup, ListRow, Loading, PageTitle, Row, Screen, T, TrackItem } from '../components';
import type { IconName, NavTarget } from '../components';
import { downloads, formatBytes } from '../lib/downloads';
import { describeConnection } from '../lib/network';
import { useImported } from '../lib/local-music';
import { useDownloads } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const SHOW = 40;
const ONLINE_ONLY: { title: string; icon: IconName; href: NavTarget }[] = [
  { title: 'Search', icon: 'search', href: '/search' },
  { title: 'Charts', icon: 'trophy', href: '/charts' },
  { title: 'Podcasts', icon: 'mic', href: '/podcasts' },
];

export default function OfflineHome() {
  const net = useNetInfo();
  const c = describeConnection(net);
  const dl = useDownloads();
  const imported = useImported();
  const player = usePlayerPick();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();

  const tracks = useMemo(() => dl.list.map((e) => e.track), [dl.list]);
  const files = useMemo(() => (imported ?? []).map((l) => l.track), [imported]);
  const all = useMemo(() => [...tracks, ...files], [tracks, files]);

  const play = (shuffle: boolean) => {
    if (!all.length) return;
    const list = shuffle ? [...all].sort(() => Math.random() - 0.5) : all;
    const r = player.playTracks(list, 0, 'Offline');
    if (r.played === 0) return setNote({ ok: false, text: r.reason ?? 'Nothing could be played' });
    router.push('/player');
  };

  const retry = async () => {
    if (checking) return;
    setChecking(true);
    setNote(undefined);
    try {
      const s = await NetInfo.refresh();
      const online = s.isConnected === true && s.isInternetReachable !== false;
      if (online) router.replace('/');
      else setNote({ ok: false, text: 'Still offline. Check Wi-Fi or mobile data.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not check the connection' });
    } finally {
      setChecking(false);
    }
  };

  const status = !c.known ? 'Checking connection…' : c.online ? `${c.label} connected` : 'No internet';
  const playingLine = all.length ? `${all.length} ${all.length === 1 ? 'song' : 'songs'} ready offline · ${formatBytes(dl.totalBytes)}` : 'Nothing saved offline yet';

  return (
    <Screen onRefresh={() => downloads.rescan()} top={8} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <PageTitle title="Offline mode" />
      <T size={14} color={colors.textSecondary} style={{ marginTop: -10 }}>
        Your downloads and device files
      </T>

      <Glass padding={14}>
        <Row gap={12}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(c.online ? colors.success : colors.warning, 0.18), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={c.online ? 'globe' : 'wifiOff'} size={22} color={c.online ? colors.success : colors.warning} />
          </View>
          <View style={{ flex: 1, gap: 2 }} accessibilityLiveRegion="polite">
            <T size={16} weight={600}>
              {status}
            </T>
            <T size={13} color={colors.textSecondary}>
              {playingLine}
            </T>
          </View>
          <Button label={c.online ? 'Go online' : checking ? 'Checking…' : 'Retry'} variant={checking ? 'disabled' : 'glass'} height={40} onPress={() => void retry()} />
        </Row>
        {note ? (
          <T size={13} color={note.ok ? colors.success : colors.error} style={{ marginTop: 10 }}>
            {note.text}
          </T>
        ) : null}
      </Glass>

      {!dl.ready ? (
        <Loading label="Loading downloads" />
      ) : all.length ? (
        <>
          <Row gap={12}>
            <Button label="Play all" icon="play" style={{ flex: 1 }} onPress={() => play(false)} />
            <Button label="Shuffle" icon="shuffle" variant="glass" style={{ flex: 1 }} onPress={() => play(true)} />
          </Row>

          {tracks.length ? (
            <View style={{ gap: 4 }}>
              <T variant="section" accessibilityRole="header">
                Downloaded songs
              </T>
              {tracks.slice(0, SHOW).map((t, i) => (
                <TrackItem key={t.id} track={t} list={all} index={i} context="Offline" />
              ))}
              {tracks.length > SHOW ? <ListRow title={`See all ${tracks.length} downloads`} icon="download" href="/downloads" /> : null}
            </View>
          ) : null}

          {files.length ? (
            <View style={{ gap: 4 }}>
              <T variant="section" accessibilityRole="header">
                Files on this device
              </T>
              {files.slice(0, SHOW).map((t, i) => (
                <TrackItem key={t.id} track={t} list={all} index={tracks.length + i} context="Offline" />
              ))}
            </View>
          ) : null}
        </>
      ) : (
        <EmptyState icon="download" title="No offline music yet" body="Download songs, albums or playlists while you’re online, or add music files from your device." action="Local files" href="/local-music" />
      )}

      <ListGroup title="ONLINE ONLY">
        {ONLINE_ONLY.map((r, i) => (
          <ListRow
            key={r.title}
            title={r.title}
            subtitle={c.online ? 'Available now' : 'Needs internet'}
            icon={r.icon}
            iconColor={c.online ? colors.accentLight : colors.textSecondary}
            iconBg={c.online ? colors.accentTint : colors.iconGhost}
            titleColor={c.online ? colors.text : colors.textSecondary}
            divider={i > 0}
            href={c.online ? r.href : undefined}
            right={c.online ? undefined : <Icon name="lock" size={16} color={colors.textSecondary} />}
          />
        ))}
      </ListGroup>
    </Screen>
  );
}
