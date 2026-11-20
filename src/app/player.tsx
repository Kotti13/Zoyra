import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Animated, Easing, StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';

import { BufferingNotice } from '../lib/buffering';
import { EmptyState, Cover, Icon, IconButton, Row, Screen, ScreenHeader, T, Tap, Toast, ToggleBurst, useAsync } from '../components';
import { GlowBackdrop } from '../components/art-fx';
import type { IconName } from '../components';
import { LyricTicker } from '../components/LyricTicker';
import { useLyricsForTrack } from '../components/lyric-sync';
import { useReduceMotion, useLyricsAutoOpen } from '../components/LyricsView';
import { formatDuration, type CatalogTrack } from '../lib/catalog';
import { isLocalTrack } from '../lib/local-music';
import { countTrackComments } from '../lib/track-comments';
import { isZoyraId, zoyra } from '../lib/zoyra-api';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlaybackProgress, usePlayerPick, type SleepTimer } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

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

/* ------------------------------------------------------------------ artwork */

/** One-line live lyric under the artwork (synced lyrics only); also runs the "open lyrics automatically" preference. */
function LiveLyricLine({ track }: { track: CatalogTrack }) {
  const { lyrics: data } = useLyricsForTrack(track);
  const hasLines = !!data?.synced.length || !!data?.plain.length;
  useLyricsAutoOpen(track, hasLines);
  if (!data?.synced.length) return null;
  return (
    <View style={{ height: 26, justifyContent: 'center' }}>
      <LyricTicker key={track.id} track={track} size={14} weight={600} height={26} align="center" fallback={null} />
    </View>
  );
}

/**
 * Full-bleed cover art across the top of the screen, fading into the dark background below it (no hard edges,
 * no blur effect, so it renders the same on every phone). It eases slightly smaller when paused.
 */
function ArtBlend({ track, playing }: { track: CatalogTrack; playing: boolean }) {
  const { width } = useWindowDimensions();
  const reduce = useReduceMotion();
  const [scale] = useState(() => new Animated.Value(playing ? 1 : 0.94));
  useEffect(() => {
    const to = playing ? 1 : 0.94;
    if (reduce) {
      scale.setValue(to);
      return;
    }
    const a = Animated.timing(scale, { toValue: to, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [playing, reduce, scale]);
  const h = Math.round(width * 1.2);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: h, overflow: 'hidden' }}>
      <Animated.View style={{ width, height: h, transform: [{ scale }] }}>
        <Cover artwork={track.artwork} id={track.id} width={width} height={h} radius={0} />
      </Animated.View>
      {/* Soft top for the status bar, then a long fade into the background colour. */}
      <LinearGradient colors={[withAlpha(colors.playerBg, 0.55), withAlpha(colors.playerBg, 0)]} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '22%' }} />
      <LinearGradient
        colors={[0, 0.06, 0.16, 0.32, 0.54, 0.76, 0.92, 1].map((a) => withAlpha(colors.playerBg, a)) as unknown as readonly [string, string, ...string[]]}
        locations={[0, 0.14, 0.3, 0.46, 0.62, 0.78, 0.92, 1]}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '78%' }}
      />
    </View>
  );
}

/** Large plain play/pause button. */
function PlayButton({ playing, onPress }: { playing: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={playing ? 'Pause' : 'Play'} style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={playing ? 'pause' : 'play'} size={44} color={colors.white} filled />
    </Tap>
  );
}

/* ------------------------------------------------------------------ seek */

/** Thin scrubber driven by live playback progress; tap or drag anywhere on it to seek. */
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
      <View style={{ gap: 6 }}>
        <View style={{ height: 24, justifyContent: 'center' }}>
          <View style={{ height: 5, borderRadius: 3, backgroundColor: withAlpha(colors.white, 0.22), overflow: 'hidden' }}>
            <View style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: 5, backgroundColor: colors.white }} />
          </View>
        </View>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={12} weight={500} color={colors.textSecondary}>
            {formatDuration(shown)}
          </T>
          <T size={12} weight={500} color={colors.textSecondary}>
            {`-${formatDuration(Math.max(0, duration - shown))}`}
          </T>
        </Row>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ screen */

const chipBase = { flex: 0, height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', gap: 6 } as const;

function InfoChip({ onPress, label, icon, children }: { onPress: () => void; label: string; icon?: IconName; children?: React.ReactNode }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label} style={chipBase}>
      {icon ? <Icon name={icon} size={14} color={colors.text} /> : null}
      {children}
    </Tap>
  );
}

const QUALITY_CHIP = { low: 'LOW', normal: 'NORMAL', high: 'HIGH', lossless: 'LOSSLESS' } as const;

export default function Player() {
  const { track, context, playing, toggle, next, previous, shuffle, setShuffle, repeat, cycleRepeat, rate, sleep, playlist } = usePlayerPick('track', 'playing', 'shuffle', 'repeat', 'rate', 'context', 'sleep', 'playlist');
  const { isLiked, toggleLike } = useLibrary();
  const { settings } = useAuth();
  const sleepLabel = useSleepLabel(sleep);
  const { width } = useWindowDimensions();
  const [note, setNote] = useState<string | null>(null);
  const repeatLabel = repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one';
  const trackId = track?.id ?? '';
  const local = !!track && isLocalTrack(track);
  const comments = useAsync<number | null>(async () => (trackId && !local ? countTrackComments(trackId).catch(() => null) : null), [trackId, local]);

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
  const openSheet = (href: string) => {
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
  const quality = settings?.audio_quality ?? 'normal';
  const dock: { label: string; a11y?: string; icon: IconName; onPress: () => void; on?: boolean; mono?: boolean }[] = [
    { label: 'Lyrics', a11y: 'Open synced lyrics', icon: 'file', onPress: () => router.push('/lyrics') },
    { label: 'Karaoke', icon: 'mic', onPress: () => router.push('/karaoke') },
    { label: rate !== 1 ? formatRate(rate) : 'Effects', a11y: 'Effects', icon: 'sliders', onPress: () => router.push('/fx-sheet'), on: rate !== 1 },
    { label: sleepLabel ?? 'Sleep', a11y: sleepLabel ? `Sleep timer, ${sleepLabel} left` : 'Sleep timer', icon: 'moon', onPress: () => router.push('/sleep'), on: !!sleepLabel, mono: !!sleepLabel && sleepLabel !== 'End of track' },
    { label: 'Devices', icon: 'speaker', onPress: () => router.push('/devices-connect') },
    { label: 'Queue', icon: 'queue', onPress: () => router.push('/queue') },
  ];

  return (
    <Screen
      swipeDown
      bg={colors.playerBg}
      gap={12}
      bottom={22}
      backdrop={{ pattern: 'none', mesh: 'none' }}
      underlay={
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <GlowBackdrop active={playing} plain />
          <ArtBlend track={track} playing={playing} />
        </View>
      }
      // The dock is pinned to the bottom edge; the rest scrolls above it if the screen is short.
      contentStyle={{ flexGrow: 1, justifyContent: 'space-between' }}
      footer={
        <Row style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          {dock.map((d) => (
            <Tap key={d.label} onPress={d.onPress} style={styles.dock} accessibilityLabel={d.a11y ?? d.label}>
              <Icon name={d.icon} size={22} color={d.on ? colors.accentLight : colors.textSecondary} />
              <T size={10} weight={600} numberOfLines={1} mono={d.mono} color={d.on ? colors.accentLight : colors.textSecondary}>
                {d.label}
              </T>
            </Tap>
          ))}
        </Row>
      }
    >
      {/* Grab handle + header */}
      <View style={styles.handle} />
      <Row style={{ height: 40, justifyContent: 'space-between' }}>
        <IconButton icon="chevronDown" label="Minimize player" href="back" />
        <View style={{ alignItems: 'center', flex: 1, minWidth: 0 }}>
          <T size={10} weight={700} tracking={1.5} color={colors.textSecondary}>
            PLAYING FROM
          </T>
          <T size={13} weight={600} numberOfLines={1}>
            {context ?? 'Your queue'}
          </T>
        </View>
        {watchVideo ? <IconButton icon="video" label="Watch video" onPress={watchVideo} /> : <View style={{ width: 44 }} />}
      </Row>

      {/* The artwork itself is the full-bleed image behind; this keeps the title and controls below it. */}
      <View accessible accessibilityRole="image" accessibilityLabel={`Artwork for ${track.title}`} style={{ height: Math.round(width * 0.8) }} />
      <LiveLyricLine track={track} />

      {/* Title, artist and quick actions */}
      <Row gap={10}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={22} weight={700} tracking={-0.3} accessibilityRole="header" numberOfLines={1}>
            {track.title}
          </T>
          <Tap href={{ pathname: '/artist', params: { id: track.artist.id } }} accessibilityRole="link" style={{ alignSelf: 'flex-start' }}>
            <Row gap={6}>
              <T size={18} color={colors.accentLight} numberOfLines={1} style={{ flexShrink: 1 }}>
                {track.artist.name}
              </T>
              {track.artist.verified ? <Icon name="checkBold" size={14} color="#4DA3FF" /> : null}
            </Row>
          </Tap>
        </View>
        {local ? null : (
          <Tap
            onPress={() => toggleLike(track).catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Could not update your likes'))}
            accessibilityLabel={liked ? 'Unlike' : 'Like'}
            accessibilityState={{ selected: liked }}
            style={styles.round}
          >
            <ToggleBurst active={liked} kind="save" size={46}>
              <Icon name="star" size={20} filled={liked} color={liked ? colors.accentLight : colors.text} />
            </ToggleBurst>
          </Tap>
        )}
        <Tap onPress={() => openSheet('/song-options')} accessibilityLabel="More options" style={styles.round}>
          <Icon name="more" size={20} color={colors.text} />
        </Tap>
      </Row>

      <LiveSeekBar />
      <BufferingNotice />

      {/* Transport */}
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="shuffle" label={shuffle ? 'Shuffle on' : 'Shuffle off'} size={52} color={shuffle ? colors.accentLight : colors.textSecondary} onPress={() => setShuffle(!shuffle)} />
        <IconButton icon="prev" label="Previous track" size={56} iconSize={32} onPress={previous} />
        <PlayButton playing={playing} onPress={toggle} />
        <IconButton icon="next" label="Next track" size={56} iconSize={32} onPress={next} />
        <View>
          <IconButton icon="repeat" label={repeatLabel} size={52} color={repeat === 'off' ? colors.textSecondary : colors.accentLight} onPress={cycleRepeat} />
          {repeat === 'one' ? (
            <View pointerEvents="none" style={styles.repeatOne}>
              <T size={9} weight={700} color={colors.onAccent}>
                1
              </T>
            </View>
          ) : null}
        </View>
      </Row>

      <Row style={{ justifyContent: 'center' }} gap={8}>
        <InfoChip onPress={() => openSheet('/stats-nerds')} label={`Audio quality ${QUALITY_CHIP[quality]}. Open stats for nerds`}>
          <T size={12} weight={600} color={quality === 'lossless' ? colors.amber : colors.textSecondary}>
            {QUALITY_CHIP[quality]}
          </T>
        </InfoChip>
        {local || comments.data === null || comments.data === undefined ? null : (
          <InfoChip onPress={() => router.push({ pathname: '/track-comments', params: { id: track.id } })} label={`${comments.data} comments`} icon="chat">
            <T size={12} weight={600}>
              {String(comments.data)}
            </T>
          </InfoChip>
        )}
      </Row>

      {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: withAlpha(colors.white, 0.3), marginTop: -4 },
  artShadow: { shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 26, shadowOffset: { width: 0, height: 14 }, elevation: 14 },
  round: { width: 36, height: 36, borderRadius: 18, backgroundColor: withAlpha(colors.white, 0.12), alignItems: 'center', justifyContent: 'center' },
  dock: { flex: 1, height: 52, alignItems: 'center', justifyContent: 'center', gap: 4 },
  repeatOne: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
