import { useNetInfo } from '@react-native-community/netinfo';
import { BufferingNotice } from '../lib/buffering';
import { useAudioPlaylistStatus } from 'expo-audio';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Defs, Path, RadialGradient, Stop } from 'react-native-svg';

import { artFor, Cover, EmptyState, useSpin, Glass, Icon, IconButton, LinkText, Overline, Row, Screen, ScreenHeader, SeekBar, Sticker, T, Tap, Toast, useAsync } from '../components';
import type { IconName, NavTarget } from '../components';
import { LyricTicker } from '../components/LyricTicker';
import { useLyricsForTrack } from '../components/lyric-sync';
import { LyricsView, useReduceMotion, useLyricsAutoOpen } from '../components/LyricsView';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { formatBytes } from '../lib/downloads';
import { isLocalTrack } from '../lib/local-music';
import { STREAM_KBPS } from '../lib/usage';
import { isZoyraId, zoyra } from '../lib/zoyra-api';
import { useAuth } from '../state/auth';
import { useDownloads } from '../state/downloads';
import { useLibrary } from '../state/library';
import { usePlaybackProgress, usePlayerPick, type SleepTimer } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { art, colors, glow, gradients, withAlpha } from '../theme/tokens';

const formatRate = (r: number) => `${Number.isInteger(Math.round(r * 100) / 10) ? r.toFixed(1) : r.toFixed(2)}x`;

/** Live "mm:ss" label for the sleep timer (ticks every second while a timer is set). */
function useSleepLabel(sleep: SleepTimer) {
  const [now, setNow] = useState(() => Date.now());
  const timed = !!sleep && 'endsAt' in sleep;
  useEffect(() => {
    if (!timed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);
  if (!sleep) return null;
  if ('endOfTrack' in sleep) return 'End of track';
  return formatDuration(Math.max(0, (sleep.endsAt - now) / 1000));
}

/* ------------------------------------------------------------------ vinyl */

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const DARK = hex(gradients.vinyl[0]);
const LIGHT = hex(gradients.vinyl[1]);

/** Approximates `conic-gradient(vinyl dark, vinyl light, …)` with thin wedges. */
function conicWedges(size: number, steps = 96) {
  const r = size / 2;
  const out: { d: string; fill: string }[] = [];
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1.05) / steps) * Math.PI * 2;
    // Two dark→light→dark cycles around the disc.
    const t = (Math.sin(((i + 0.5) / steps) * Math.PI * 4 - Math.PI / 2) + 1) / 2;
    const c = DARK.map((d, k) => Math.round(d + (LIGHT[k] - d) * t));
    const p = (a: number) => `${(r + r * Math.sin(a)).toFixed(2)} ${(r - r * Math.cos(a)).toFixed(2)}`;
    out.push({ d: `M${r} ${r} L${p(a0)} A${r} ${r} 0 0 1 ${p(a1)} Z`, fill: `rgb(${c.join(',')})` });
  }
  return out;
}

/**
 * Slow Ken Burns zoom/pan for the label art and a breathing glow while playing.
 * Paused: both stop where they are (still). Reduce Motion: no movement at all.
 */
function useArtMotion(playing: boolean, reduce: boolean) {
  const [kb] = useState(() => new Animated.Value(0));
  const [glow] = useState(() => new Animated.Value(0.5));
  useEffect(() => {
    if (reduce) {
      kb.stopAnimation();
      glow.stopAnimation();
      kb.setValue(0);
      glow.setValue(0.5);
      return;
    }
    if (!playing) {
      kb.stopAnimation();
      glow.stopAnimation();
      return;
    }
    const ease = Easing.inOut(Easing.sin);
    const pan = Animated.loop(
      Animated.sequence([
        Animated.timing(kb, { toValue: 1, duration: 14_000, easing: ease, useNativeDriver: true }),
        Animated.timing(kb, { toValue: 0, duration: 14_000, easing: ease, useNativeDriver: true }),
      ]),
    );
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 3_200, easing: ease, useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0.4, duration: 3_200, easing: ease, useNativeDriver: true }),
      ]),
    );
    pan.start();
    breathe.start();
    return () => {
      pan.stop();
      breathe.stop();
    };
  }, [playing, reduce, kb, glow]);
  return { kb, glow };
}

function Vinyl({ size, track, playing }: { size: number; track: CatalogTrack; playing: boolean }) {
  const label = Math.round(size * 0.46);
  const reduce = useReduceMotion();
  const { kb, glow } = useArtMotion(playing, reduce);
  const spin = useSpin(playing, 8000);
  const glowSize = Math.round(size * 1.4);
  const [glowFrom, glowTo] = art[artFor(track.id)];
  const gid = `glow-${track.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <View style={{ alignSelf: 'center', alignItems: 'center', justifyContent: 'center' }}>
      {/* Soft glow in the art's gradient colours */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: glowSize,
          height: glowSize,
          opacity: glow.interpolate({ inputRange: [0, 1], outputRange: [0.2, 0.75] }),
          transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.04] }) }],
        }}
      >
        <Svg width={glowSize} height={glowSize}>
          <Defs>
            <RadialGradient id={gid} cx="50%" cy="50%" r="50%">
              <Stop offset="0.45" stopColor={glowFrom} stopOpacity={0.55} />
              <Stop offset="0.75" stopColor={glowTo} stopOpacity={0.25} />
              <Stop offset="1" stopColor={glowTo} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={glowSize / 2} cy={glowSize / 2} r={glowSize / 2} fill={`url(#${gid})`} />
        </Svg>
      </Animated.View>
      {/* The whole record spins while playing and stops in place on pause */}
      <Animated.View style={{ transform: [{ rotate: spin }] }}>
        <VinylDisc size={size} label={label} track={track} kb={kb} />
      </Animated.View>
    </View>
  );
}

function VinylDisc({ size, label, track, kb }: { size: number; label: number; track: CatalogTrack; kb: Animated.Value }) {
  const zoom = kb.interpolate({ inputRange: [0, 1], outputRange: [1.04, 1.22] });
  const panX = kb.interpolate({ inputRange: [0, 1], outputRange: [-label * 0.05, label * 0.05] });
  const panY = kb.interpolate({ inputRange: [0, 1], outputRange: [label * 0.04, -label * 0.04] });
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignSelf: 'center',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgTertiary,
        shadowColor: colors.accent,
        shadowOpacity: 0.45,
        shadowRadius: 36,
        shadowOffset: { width: 0, height: 8 },
        elevation: 18,
      }}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Artwork for ${track.title} on a record`}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        {conicWedges(size).map((w, i) => (
          <Path key={i} d={w.d} fill={w.fill} />
        ))}
      </Svg>
      <View style={[styles.ring, { top: 14, left: 14, right: 14, bottom: 14, borderRadius: size }]} />
      <View style={[styles.ring, { top: 44, left: 44, right: 44, bottom: 44, borderRadius: size }]} />
      <LinearGradient pointerEvents="none" colors={[withAlpha(colors.white, 0.35), withAlpha(colors.white, 0)]} style={styles.streak} />
      <LinearGradient
        colors={[colors.accent, art.red[1], colors.orange]}
        locations={[0, 0.6, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ width: label, height: label, borderRadius: label / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      >
        <Animated.View style={{ position: 'absolute', width: label, height: label, transform: [{ translateX: panX }, { translateY: panY }, { scale: zoom }] }}>
          <Cover artwork={track.artwork} id={track.id} size={label} radius={0} />
        </Animated.View>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: colors.playerBg }} />
      </LinearGradient>
    </View>
  );
}

/* ------------------------------------------------------------------ seek */

/** SeekBar driven by live playback progress; tap or drag anywhere on it to seek. */
function LiveSeekBar() {
  const { seekTo } = usePlayerPick();
  const { position, duration, progress } = usePlaybackProgress();
  const ref = useRef<ComponentRef<typeof View>>(null);
  const box = useRef({ x: 0, w: 1 });
  const [drag, setDrag] = useState<number | null>(null);

  const measure = () => ref.current?.measureInWindow((x, _y, w) => (box.current = { x, w: Math.max(1, w) }));
  const fracAt = (e: GestureResponderEvent) => Math.min(1, Math.max(0, (e.nativeEvent.pageX - box.current.x) / box.current.w));
  const value = drag ?? progress;
  const shown = value * duration;

  return (
    <View
      ref={ref}
      onLayout={measure}
      onStartShouldSetResponder={() => duration > 0}
      onMoveShouldSetResponder={() => duration > 0}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        measure();
        setDrag(fracAt(e));
      }}
      onResponderMove={(e) => setDrag(fracAt(e))}
      onResponderRelease={(e) => {
        seekTo(fracAt(e) * duration);
        setDrag(null);
      }}
      onResponderTerminate={() => setDrag(null)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
      accessibilityValue={{ min: 0, max: Math.round(duration), now: Math.round(position), text: `${formatDuration(position)} of ${formatDuration(duration)}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => seekTo(Math.min(duration, Math.max(0, position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))))}
    >
      <SeekBar value={value} elapsed={formatDuration(shown)} remaining={`-${formatDuration(Math.max(0, duration - shown))}`} />
    </View>
  );
}

/* ------------------------------------------------------------------ lyrics preview */

/** Compact live lyrics card (3 lines, word-synced). Hidden when LRCLIB has nothing for this song. */
function LyricsPreview({ track }: { track: CatalogTrack }) {
  const { lyr, lyrics: matched } = useLyricsForTrack(track);
  const current = matched === undefined ? undefined : { lyrics: matched };
  const data = current?.lyrics;
  // Lyrics settings › "Open lyrics automatically" (no-op unless the user turned it on).
  useLyricsAutoOpen(track, !!data?.synced.length || !!data?.plain.length);
  const plain = data && !data.synced.length ? data.plain.filter((l) => l.trim()).slice(0, 3) : [];
  if (current && (!data || (!data.synced.length && !plain.length))) return null; // nothing to show

  return (
    <Glass radius={22} padding={16} style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Overline>LYRICS</Overline>
        <LinkText label="Open" size={13} href="/lyrics" />
      </Row>
      {lyr.error && !current ? (
        <Row gap={8}>
          <T size={14} color={colors.textSecondary} style={{ flexShrink: 1 }}>
            Could not load lyrics.
          </T>
          <LinkText label="Try again" size={13} onPress={lyr.reload} />
        </Row>
      ) : !current ? (
        <T size={14} color={colors.textSecondary}>
          Finding lyrics…
        </T>
      ) : data?.synced.length ? (
        <LyricsView lines={data.synced} compact size={20} />
      ) : (
        <Tap href="/lyrics" accessibilityLabel="Open lyrics" style={{ gap: 4 }}>
          {plain.map((l, i) => (
            <T key={i} size={18} weight={700} numberOfLines={1} style={{ opacity: i === 0 ? 0.9 : 0.5 }}>
              {l}
            </T>
          ))}
          <T size={12} color={colors.textTertiary}>
            Not synced to the music
          </T>
        </Tap>
      )}
    </Glass>
  );
}

/* ------------------------------------------------------------------ lyrics pill */

/** Blinks while playing (static when paused or with Reduce Motion). */
function LiveDot({ active }: { active: boolean }) {
  const reduce = useReduceMotion();
  const [o] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!active || reduce) {
      o.stopAnimation();
      o.setValue(active ? 1 : 0.4);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(o, { toValue: 0.25, duration: 600, useNativeDriver: true }),
        Animated.timing(o, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduce, o]);
  return <Animated.View style={[styles.liveDot, { opacity: o }]} />;
}

/** Glass "open lyrics" pill with the line being sung right now (or a plain label without synced lyrics). */
function LyricsPill({ track, playing }: { track: CatalogTrack; playing: boolean }) {
  return (
    <Tap href="/lyrics" style={[styles.pill, glow(colors.accent, 13, 0.25)]} accessibilityLabel="Open lyrics">
      <Glass radius={26} style={{ flex: 1 }}>
        <View style={styles.pillInner}>
          <LiveDot active={playing} />
          <LyricTicker
            key={track.id}
            track={track}
            height={48}
            style={{ flex: 1, minWidth: 0 }}
            fallback={
              <Row gap={8} style={{ flex: 1, minWidth: 0, justifyContent: 'center' }}>
                <Icon name="file" size={18} />
                <T size={15} weight={600}>
                  Lyrics
                </T>
              </Row>
            }
          />
          <Icon name="chevronUp" size={18} color={colors.textSecondary} />
        </View>
      </Glass>
    </Tap>
  );
}

/* ------------------------------------------------------------------ stats for nerds */

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

type StreamProbe = { id: string; host: string | null; mime: string | null; bytes: number | null; status: number };

/** HEAD request on the stream URL: follows the redirect to the CDN and reads headers only (no audio is downloaded). */
async function probeStream(trackId: string): Promise<StreamProbe> {
  const res = await fetch(catalog.streamUrl(trackId), { method: 'HEAD' });
  const len = Number(res.headers.get('content-length'));
  return { id: trackId, host: res.url ? hostOf(res.url) : null, mime: res.headers.get('content-type'), bytes: Number.isFinite(len) && len > 0 ? len : null, status: res.status };
}

function StatRow({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={{ paddingVertical: 6, gap: 2 }} accessible accessibilityLabel={`${label}: ${value}${note ? `. ${note}` : ''}`}>
      <Row style={{ justifyContent: 'space-between' }} align="flex-start">
        <T size={13} color={colors.textSecondary}>
          {label}
        </T>
        <T size={13} mono align="right" style={{ flexShrink: 1 }}>
          {value}
        </T>
      </Row>
      {note ? (
        <T size={11} color={colors.textTertiary}>
          {note}
        </T>
      ) : null}
    </View>
  );
}

/** Only what the app can actually know: no codec details are guessed. */
function StatsForNerds({ track, onClose }: { track: CatalogTrack; onClose: () => void }) {
  const { playlist, index, queue } = usePlayerPick('queue', 'index', 'playlist');
  const s = useAudioPlaylistStatus(playlist);
  const net = useNetInfo();
  const dl = useDownloads();
  const { settings } = useAuth();

  const entry = dl.entries[track.id];
  const source: 'local' | 'download' | 'stream' = isLocalTrack(track) ? 'local' : entry ? 'download' : 'stream';
  const streamUrl = source === 'stream' ? catalog.streamUrl(track.id) : null;

  const probe = useAsync<StreamProbe | null>(async () => (source === 'stream' && net.isConnected !== false ? probeStream(track.id) : null), [track.id, source]);
  const p = probe.data?.id === track.id ? probe.data : null;

  const quality: Quality = settings?.audio_quality ?? 'normal';
  const deviceUri = deviceUriOf(track);

  const duration = s.duration > 0 ? s.duration : track.duration;
  const bytes = source === 'download' ? (entry?.bytes ?? null) : (p?.bytes ?? null);
  const avgKbps = bytes && duration > 0 ? Math.round((bytes * 8) / duration / 1000) : null;
  const format = source === 'download' && entry ? formatFromPath(entry.path) : source === 'local' ? (deviceUri ? formatFromPath(deviceUri) : null) : formatFromMime(p?.mime ?? null);

  const state = !s.isLoaded ? 'Loading' : s.isBuffering ? 'Buffering' : s.playing ? 'Playing' : 'Paused';
  let network = net.type === 'unknown' ? 'Unknown' : net.type === 'none' ? 'Offline' : net.type.charAt(0).toUpperCase() + net.type.slice(1);
  if (net.type === 'cellular' && net.details.cellularGeneration) network += ` (${net.details.cellularGeneration.toUpperCase()})`;
  if (net.isInternetReachable === false && net.type !== 'none') network += ' · no internet';
  if (net.details && 'isConnectionExpensive' in net.details && net.details.isConnectionExpensive) network += ' · metered';

  return (
    <Glass radius={22} padding={16}>
      <Row style={{ justifyContent: 'space-between', marginBottom: 4 }}>
        <Overline>STATS FOR NERDS</Overline>
        <LinkText label="Hide" size={13} onPress={onClose} />
      </Row>
      <StatRow
        label="Source"
        value={source === 'local' ? 'Local file' : source === 'download' ? 'Downloaded file' : 'Audius stream'}
        note={source === 'download' ? 'If it finished downloading after it was queued, it streams until played again.' : undefined}
      />
      {streamUrl ? <StatRow label="Stream host" value={hostOf(streamUrl) ?? '—'} /> : null}
      {p?.host && p.host !== hostOf(streamUrl ?? '') ? <StatRow label="Audio served by" value={p.host} /> : null}
      {source === 'stream' && probe.loading && !p ? <StatRow label="Stream details" value="Checking…" /> : null}
      {source === 'stream' && probe.error ? <StatRow label="Stream details" value="Unavailable" note={probe.error} /> : null}
      {format ? <StatRow label="Format" value={format} note={source === 'stream' ? 'From the server’s Content-Type header' : 'From the file name'} /> : null}
      {bytes ? <StatRow label={source === 'stream' ? 'Stream size' : 'File size'} value={formatBytes(bytes)} /> : null}
      {avgKbps ? <StatRow label="Average bitrate" value={`≈ ${avgKbps} kbps`} note="File size ÷ length (includes tags and artwork)" /> : null}
      {source === 'stream' ? (
        <StatRow
          label="Bitrate estimate"
          value={`~${STREAM_KBPS} kbps`}
          note={`Quality setting: ${QUALITY_NAMES[quality]}. Audius serves one stream for every setting, so data estimates use ${STREAM_KBPS} kbps.`}
        />
      ) : null}
      <StatRow label="Duration" value={duration > 0 ? formatDuration(duration) : 'Unknown'} />
      <StatRow label="Position" value={`${formatDuration(s.currentTime)}${s.playbackRate && s.playbackRate !== 1 ? ` · ${s.playbackRate}x` : ''}`} />
      <StatRow label="Player state" value={state} />
      <StatRow label="Volume" value={`${Math.round((s.muted ? 0 : s.volume) * 100)}%`} />
      <StatRow label="Network" value={network} />
      <StatRow label="Queue" value={`${index + 1} of ${queue.length}`} />
      <StatRow label="Track ID" value={track.id} />
    </Glass>
  );
}

/* ------------------------------------------------------------------ screen */

export default function Player() {
  const { track, context, playing, toggle, next, previous, shuffle, setShuffle, repeat, cycleRepeat, rate, sleep, playlist } = usePlayerPick('track', 'playing', 'shuffle', 'repeat', 'rate', 'context', 'sleep', 'playlist');
  const { isLiked, toggleLike } = useLibrary();
  const sleepLabel = useSleepLabel(sleep);
  const [note, setNote] = useState<string | null>(null);
  const [stats, setStats] = useState(false);
  const { width } = useWindowDimensions();
  const disc = Math.min(326, width - 64);
  const repeatLabel = repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one';

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  if (!track) {
    return (
      <Screen bg={colors.playerBg} gap={14} backdrop={{ pattern: 'dots', mesh: 'none' }} swipeDown>
        <ScreenHeader title="Now playing" back="back" backIcon="chevronDown" />
        <EmptyState title="Nothing playing" body="Pick a song, album or playlist to start listening." action="Go to Home" href="/" />
      </Screen>
    );
  }

  const liked = isLiked(track.id);
  const openSheet = (href: NavTarget) => {
    setSheetTrack(track);
    router.push(href as Parameters<typeof router.push>[0]);
  };
  // YouTube songs from the Zoyra backend: the audio *is* the video's soundtrack, so the
  // video can pick up at the same second. The video player pauses this audio when it starts.
  const watchVideo = isZoyraId(track.id)
    ? () =>
        router.push({
          pathname: '/video-player',
          params: { id: zoyra.videoId(track.id), t: String(Math.floor(playlist.currentTime || 0)) },
        })
    : null;
  const tools: { label: string; icon: IconName; onPress: () => void }[] = [
    ...(watchVideo ? [{ label: 'Video', icon: 'play' as IconName, onPress: watchVideo }] : []),
    { label: formatRate(rate), icon: 'bolt', onPress: () => router.push('/fx-sheet') },
    { label: sleepLabel ?? 'Sleep', icon: 'moon', onPress: () => router.push('/sleep') },
    { label: 'Karaoke', icon: 'mic', onPress: () => router.push('/karaoke') },
    { label: 'Credits', icon: 'file', onPress: () => openSheet('/credits') },
    { label: stats ? 'Hide stats' : 'Stats for nerds', icon: 'info', onPress: () => setStats((v) => !v) },
  ];

  return (
    <Screen
      swipeDown
      bg={colors.playerBg}
      gap={14}
      bottom={30}
      backdrop={{ pattern: 'dots', mesh: 'none' }}
      underlay={<LinearGradient colors={gradients.player} locations={[0, 0.38, 0.78]} style={StyleSheet.absoluteFill} />}
    >
      {/* Header */}
      <Row style={{ height: 44, justifyContent: 'space-between' }}>
        <IconButton icon="chevronDown" label="Minimize player" href="back" />
        <View style={{ alignItems: 'center', gap: 2, flex: 1, minWidth: 0 }}>
          <Overline>PLAYING FROM</Overline>
          <T size={14} weight={600} numberOfLines={1}>
            {context ?? 'Your queue'}
          </T>
        </View>
        <IconButton icon="more" label="More options" onPress={() => openSheet('/song-options')} />
      </Row>

      <Vinyl size={disc} track={track} playing={playing} />

      {/* Title row */}
      <Row>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <T variant="title" accessibilityRole="header" numberOfLines={1}>
            {track.title}
          </T>
          <Tap href={{ pathname: '/artist', params: { id: track.artist.id } }} accessibilityRole="link" style={{ alignSelf: 'flex-start' }}>
            <T size={16} color={colors.peach} numberOfLines={1}>
              {track.artist.name}
            </T>
          </Tap>
        </View>
        {track.genre ? <Sticker label={track.genre.toUpperCase()} bg={colors.orange} rotate={3} /> : null}
        {isLocalTrack(track) ? null : (
          <IconButton
            icon="heart"
            label={liked ? 'Unlike' : 'Like'}
            size={48}
            filled={liked}
            color={liked ? colors.like : colors.text}
            onPress={() => toggleLike(track).catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Could not update your likes'))}
          />
        )}
      </Row>

      <LiveSeekBar />
      <BufferingNotice />

      {/* Transport */}
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="shuffle" label={shuffle ? 'Shuffle on' : 'Shuffle off'} size={48} color={shuffle ? colors.orange : colors.textSecondary} onPress={() => setShuffle(!shuffle)} />
        <IconButton icon="prev" label="Previous track" size={56} iconSize={30} onPress={previous} />
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={playing ? 'Pause' : 'Play'}
          size={76}
          iconSize={34}
          bg={colors.accent}
          color={colors.onAccent}
          onPress={toggle}
          style={{ shadowColor: colors.shadow, shadowOpacity: 0.4, shadowRadius: 0, shadowOffset: { width: 0, height: 5 }, elevation: 5 }}
        />
        <IconButton icon="next" label="Next track" size={56} iconSize={30} onPress={next} />
        <View>
          <IconButton icon="repeat" label={repeatLabel} size={48} color={repeat === 'off' ? colors.textSecondary : colors.orange} onPress={cycleRepeat} />
          {repeat === 'one' ? (
            <View pointerEvents="none" style={styles.repeatOne}>
              <T size={9} weight={700} color={colors.onAccent}>
                1
              </T>
            </View>
          ) : null}
        </View>
      </Row>

      {/* Tools */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {tools.map((t) => (
          <Tap key={t.icon} onPress={t.onPress} style={styles.tool} accessibilityLabel={t.icon === 'moon' && sleepLabel ? `Sleep timer, ${sleepLabel} left` : t.label}>
            <Icon name={t.icon} size={18} color={t.icon === 'moon' && sleepLabel ? colors.orange : colors.text} />
            <T size={13} weight={600} mono={t.icon === 'moon' && !!sleepLabel && sleepLabel !== 'End of track'}>
              {t.label}
            </T>
          </Tap>
        ))}
      </ScrollView>

      {/* Bottom row */}
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="speaker" label="Connect to a device" href="/devices-connect" />
        <LyricsPill track={track} playing={playing} />
        <IconButton icon="queue" label="Queue" href="/queue" />
      </Row>

      <LyricsPreview track={track} />

      {stats ? <StatsForNerds track={track} onClose={() => setStats(false)} /> : null}

      {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', borderWidth: 1, borderColor: colors.iconGhost },
  tool: {
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: colors.chipGhost,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  streak: { position: 'absolute', top: 10, left: '50%', width: 6, height: 46, marginLeft: -3, borderRadius: 3 },
  pill: { flex: 1, maxWidth: 238, minWidth: 0, height: 52, borderRadius: 26 },
  pillInner: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 14, paddingRight: 16 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.mint },
  repeatOne: {
    position: 'absolute',
    right: 6,
    top: 6,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.orange,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
