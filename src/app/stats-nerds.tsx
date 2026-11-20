import { useNetInfo } from '@react-native-community/netinfo';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import { useAudioPlaylistStatus } from 'expo-audio';
import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button, Cover, EmptyState, Glass, IconButton, Row, Screen, T, useAsync } from '../components';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { formatBytes } from '../lib/downloads';
import { isLocalTrack } from '../lib/local-music';
import { STREAM_KBPS } from '../lib/usage';
import { useAuth } from '../state/auth';
import { useDownloads } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors } from '../theme/tokens';

const hostOf = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1] ?? null;

const FORMAT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'MP3',
  'audio/mp3': 'MP3',
  'audio/mp4': 'MPEG-4 audio (M4A)',
  'audio/x-m4a': 'MPEG-4 audio (M4A)',
  'audio/aac': 'AAC',
  'audio/flac': 'FLAC',
  'audio/x-flac': 'FLAC',
  'audio/ogg': 'Ogg',
  'audio/opus': 'Opus',
  'audio/wav': 'WAV',
  'audio/x-wav': 'WAV',
};
const FORMAT_BY_EXT: Record<string, string> = { mp3: 'MP3', m4a: 'MPEG-4 audio (M4A)', mp4: 'MPEG-4 audio', aac: 'AAC', flac: 'FLAC', ogg: 'Ogg', opus: 'Opus', wav: 'WAV' };

const formatFromMime = (mime: string | null) => {
  if (!mime) return null;
  const base = mime.split(';')[0].trim().toLowerCase();
  return FORMAT_BY_MIME[base] ?? base;
};
const formatFromPath = (path: string) => {
  const ext = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(path)?.[1]?.toLowerCase();
  return ext ? (FORMAT_BY_EXT[ext] ?? ext.toUpperCase()) : null;
};

type Quality = 'low' | 'normal' | 'high' | 'lossless';
const QUALITY_NAMES: Record<Quality, string> = { low: 'Low', normal: 'Normal', high: 'High', lossless: 'Lossless' };

/** file:// URI of a device track (local-music tracks carry it on the track object). */
const deviceUriOf = (t: CatalogTrack) => ('localUri' in t && typeof t.localUri === 'string' ? t.localUri : null);

type StreamProbe = { id: string; host: string | null; mime: string | null; bytes: number | null; status: number; ms: number };

/** HEAD request on the stream URL: follows the redirect to the CDN and reads headers only (no audio is downloaded). */
async function probeStream(trackId: string): Promise<StreamProbe> {
  const t0 = Date.now();
  const res = await fetch(catalog.streamUrl(trackId), { method: 'HEAD' });
  const ms = Date.now() - t0;
  const len = Number(res.headers.get('content-length'));
  return { id: trackId, host: res.url ? hostOf(res.url) : null, mime: res.headers.get('content-type'), bytes: Number.isFinite(len) && len > 0 ? len : null, status: res.status, ms };
}

function Label({ children }: { children: string }) {
  return (
    <T size={11} weight={700} tracking={1.4} color={colors.textSecondary} style={{ marginHorizontal: 4, marginTop: 2, marginBottom: -6 }}>
      {children}
    </T>
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <Glass radius={26} style={{ paddingVertical: 6, paddingHorizontal: 16 }}>
      {children}
    </Glass>
  );
}

function StatRow({ label, value, tone, note }: { label: string; value: string; tone?: string; note?: string }) {
  return (
    <View style={{ paddingVertical: 7 }} accessible accessibilityLabel={`${label}: ${value}${note ? `. ${note}` : ''}`}>
      <Row style={{ justifyContent: 'space-between' }} gap={12} align="flex-start">
        <T mono size={12} color={colors.textSecondary}>
          {label}
        </T>
        <T mono size={12} color={tone ?? '#E5E5E5'} align="right" style={{ flexShrink: 1 }}>
          {value}
        </T>
      </Row>
      {note ? (
        <T size={11} color={colors.textTertiary} style={{ marginTop: 2 }}>
          {note}
        </T>
      ) : null}
    </View>
  );
}

/** Stats for nerds (`/stats-nerds`): only what the app can actually know. No codec details are guessed. */
export default function StatsNerds() {
  const { track: playing, playlist, index, queue } = usePlayerPick('track', 'queue', 'index', 'playlist');
  const track = useSheetTrack(playing);
  const s = useAudioPlaylistStatus(playlist);
  const net = useNetInfo();
  const dl = useDownloads();
  const { settings } = useAuth();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(id);
  }, [copied]);

  const entry = track ? dl.entries[track.id] : undefined;
  const source: 'local' | 'download' | 'stream' = track && isLocalTrack(track) ? 'local' : entry ? 'download' : 'stream';
  const trackId = track?.id ?? '';
  const probe = useAsync<StreamProbe | null>(async () => (trackId && source === 'stream' && net.isConnected !== false ? probeStream(trackId) : null), [trackId, source]);

  if (!track) {
    return (
      <Screen top={4} backdrop={{ pattern: 'dots', mesh: 'coral', orbs: true }}>
        <Row style={{ minHeight: 44 }}>
          <IconButton icon="back" label="Back" href="back" />
        </Row>
        <EmptyState title="Nothing playing" body="Play a song to see its live playback details." />
      </Screen>
    );
  }

  const isCurrent = playing?.id === track.id;
  const p = probe.data?.id === track.id ? probe.data : null;
  const quality: Quality = settings?.audio_quality ?? 'normal';
  const deviceUri = deviceUriOf(track);
  const duration = isCurrent && s.duration > 0 ? s.duration : track.duration;
  const bytes = source === 'download' ? (entry?.bytes ?? null) : (p?.bytes ?? null);
  const avgKbps = bytes && duration > 0 ? Math.round((bytes * 8) / duration / 1000) : null;
  const format = source === 'download' && entry ? formatFromPath(entry.path) : source === 'local' ? (deviceUri ? formatFromPath(deviceUri) : null) : formatFromMime(p?.mime ?? null);
  const streamHost = source === 'stream' ? hostOf(catalog.streamUrl(track.id)) : null;

  const state = !isCurrent ? 'Not playing' : !s.isLoaded ? 'Loading' : s.isBuffering ? 'Buffering' : s.playing ? 'Playing' : 'Paused';
  let network = net.type === 'unknown' ? 'Unknown' : net.type === 'none' ? 'Offline' : net.type.charAt(0).toUpperCase() + net.type.slice(1);
  if (net.type === 'cellular' && net.details.cellularGeneration) network += ` (${net.details.cellularGeneration.toUpperCase()})`;
  if (net.isInternetReachable === false && net.type !== 'none') network += ' · no internet';
  if (net.details && 'isConnectionExpensive' in net.details && net.details.isConnectionExpensive) network += ' · metered';
  const offline = net.type === 'none' || net.isConnected === false;

  const version = Constants.expoConfig?.version ?? 'unknown';
  const sourceLabel = source === 'local' ? 'Local file' : source === 'download' ? 'Downloaded file' : 'Audius stream';

  const lines: [string, string][] = [
    ['Track', `${track.title} · ${track.artist.name}`],
    ['Track ID', track.id],
    ['Source', sourceLabel],
    ['Format', format ?? 'Unknown'],
    ['Size', bytes ? formatBytes(bytes) : 'Unknown'],
    ['Average bitrate', avgKbps ? `${avgKbps} kbps` : 'Unknown'],
    ['Duration', duration > 0 ? formatDuration(duration) : 'Unknown'],
    ['Player state', state],
    ['Volume', `${Math.round((s.muted ? 0 : s.volume) * 100)}%`],
    ['Network', network],
    ['Stream host', p?.host ?? streamHost ?? 'n/a'],
    ['Header latency', p ? `${p.ms} ms` : 'n/a'],
    ['Queue', `${index + 1} of ${queue.length}`],
    ['App version', version],
  ];
  const copy = () => {
    Clipboard.setStringAsync(lines.map(([k, v]) => `${k}: ${v}`).join('\n'))
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <Screen
      top={4}
      gap={14}
      backdrop={{ pattern: 'dots', mesh: 'coral', orbs: true }}
      footer={<Button variant="glass" icon="copy" label={copied ? 'Copied' : 'Copy debug info'} height={50} onPress={copy} />}
    >
      <Row gap={10} style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" href="back" />
        <Cover artwork={track.artwork} id={track.id} size={44} radius={22} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={17} weight={700} accessibilityRole="header">
            Stats for nerds
          </T>
          <T size={12} color="#FF9AA0" numberOfLines={1}>
            {`${track.title} · ${track.artist.name}`}
          </T>
        </View>
        <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: isCurrent && s.playing ? colors.mint : colors.textTertiary }} />
          <T mono size={11} weight={700} color={isCurrent && s.playing ? colors.mint : colors.textSecondary}>
            LIVE
          </T>
        </View>
      </Row>

      <Label>AUDIO</Label>
      <Group>
        <StatRow label="Source" value={sourceLabel} note={source === 'download' ? 'If it finished downloading after it was queued, it streams until played again.' : undefined} />
        {format ? <StatRow label="Format" value={format} note={source === 'stream' ? 'From the server’s Content-Type header' : 'From the file name'} /> : null}
        {source === 'stream' && probe.loading && !p ? <StatRow label="Stream details" value="Checking…" /> : null}
        {source === 'stream' && probe.error ? <StatRow label="Stream details" value="Unavailable" note={probe.error} /> : null}
        {bytes ? <StatRow label={source === 'stream' ? 'Stream size' : 'File size'} value={formatBytes(bytes)} /> : null}
        {avgKbps ? <StatRow label="Average bitrate" value={`≈ ${avgKbps} kbps`} note="File size ÷ length (includes tags and artwork)" /> : null}
        {source === 'stream' ? (
          <StatRow label="Bitrate estimate" value={`~${STREAM_KBPS} kbps`} note={`Quality setting: ${QUALITY_NAMES[quality]}. Audius serves one stream for every setting, so data estimates use ${STREAM_KBPS} kbps.`} />
        ) : null}
        <StatRow label="Duration" value={duration > 0 ? formatDuration(duration) : 'Unknown'} />
        <StatRow label="Volume" value={`${Math.round((s.muted ? 0 : s.volume) * 100)}%`} />
      </Group>

      <Label>PLAYBACK</Label>
      <Group>
        <StatRow label="Player state" value={state} tone={state === 'Playing' ? colors.mint : state === 'Buffering' ? colors.gold : undefined} />
        <StatRow label="Position" value={`${formatDuration(isCurrent ? s.currentTime : 0)}${isCurrent && s.playbackRate && s.playbackRate !== 1 ? ` · ${s.playbackRate}x` : ''}`} />
        <StatRow label="Buffering" value={isCurrent && s.isBuffering ? 'Yes' : 'No'} tone={isCurrent && s.isBuffering ? colors.gold : colors.mint} note="The player does not report how far ahead it has buffered." />
        <StatRow label="Queue" value={`${index + 1} of ${queue.length}`} />
      </Group>

      <Label>NETWORK</Label>
      <Group>
        <StatRow label="Connection" value={network} tone={offline ? colors.gold : undefined} />
        {streamHost ? <StatRow label="Stream host" value={streamHost} /> : null}
        {p?.host && p.host !== streamHost ? <StatRow label="Audio served by" value={p.host} /> : null}
        {p ? <StatRow label="Header latency" value={`${p.ms} ms`} note="Time for the server to answer a header-only request" /> : null}
      </Group>

      <Label>SESSION</Label>
      <Group>
        <StatRow label="Track ID" value={track.id} />
        <StatRow label="App version" value={version} />
      </Group>

    </Screen>
  );
}
