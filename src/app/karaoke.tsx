import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, ProgressBar, Row, Screen, ScreenHeader, T, Tap } from '../components';
import { useSyncedLyrics } from '../components/LyricTicker';
import { boundsOf, LyricSyncControl, useLyricShift, useLyricTime } from '../components/lyric-sync';
import { useReduceMotion } from '../components/motion';
import { formatDuration, type CatalogTrack } from '../lib/catalog';
import { activeLine, timedLines, type Lyrics, type TimedLine } from '../lib/lyrics';
import { seekTargetFor } from '../lib/lyrics-sync';
import { useLoadedDuration, usePlaybackProgress, usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

/* ------------------------------------------------------------------ lyrics */

/** Big centred sing-along lines: previous, current (word fill + red glow), next two. Tap any to jump there. */
function KaraokeLines({ lyrics }: { lyrics: Lyrics }) {
  const reduce = useReduceMotion();
  const { position } = usePlaybackProgress();
  const { seekTo: seekAudio, track } = usePlayerPick('track');
  const duration = useLoadedDuration(track?.id) || track?.duration || 0;
  const lines = useMemo(() => timedLines(lyrics.synced, duration), [lyrics.synced, duration]);
  // Shared playback clock (lead, Bluetooth delay and Sync offset applied): exact line + word timing.
  const shift = useLyricShift(track?.id);
  const bounds = useMemo(() => boundsOf(lines, true), [lines]);
  const t = useLyricTime(bounds, shift);
  const i = activeLine(lines, t);
  const seekTo = (time: number) => seekAudio(seekTargetFor(time, shift));
  const line: TimedLine | null = i >= 0 ? lines[i] : null;
  const prev = i > 0 ? lines[i - 1] : null;
  const upcoming = lines.slice(i + 1, i + 3);

  const [enter] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (reduce) {
      enter.setValue(1);
      return;
    }
    enter.setValue(0);
    const a = Animated.timing(enter, { toValue: 1, duration: 360, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [i, reduce, enter]);

  const dim = withAlpha(colors.white, 0.3);
  const words = line?.words.filter((w) => w.text.trim()) ?? [];
  const startsIn = i < 0 && lines.length ? Math.max(0, lines[0].time - shift - position) : 0;

  return (
    <View style={styles.lines}>
      {prev ? (
        <Tap accessibilityLabel={`${prev.text || 'Instrumental break'}. Tap to sing it again.`} onPress={() => seekTo(prev.time)}>
          <T size={18} weight={700} align="center" numberOfLines={2} style={{ opacity: 0.4 }}>
            {prev.text || '♪'}
          </T>
        </Tap>
      ) : null}

      <Animated.View
        style={{
          opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }, { scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.93, 1] }) }],
        }}
      >
        {line ? (
          <Tap accessibilityLabel={`Current line: ${line.text || 'instrumental break'}. Tap to sing it again.`} onPress={() => seekTo(line.time)}>
            <T size={30} weight={800} tracking={-0.5} lineHeight={36} align="center" style={styles.glowText}>
              {words.length
                ? words.map((w, j) => (
                    <T key={j} size={30} weight={800} tracking={-0.5} color={w.time <= t ? colors.white : dim}>
                      {w.text}
                    </T>
                  ))
                : '♪'}
            </T>
          </Tap>
        ) : (
          <View style={{ gap: 6 }} accessible accessibilityLabel={`Get ready. Singing starts in ${Math.ceil(startsIn)} seconds.`}>
            <T size={30} weight={300} tracking={-0.8} align="center">
              Get ready…
            </T>
            <T mono size={13} align="center" color={colors.textSecondary}>
              {`Starts in ${formatDuration(startsIn)}`}
            </T>
          </View>
        )}
      </Animated.View>

      {upcoming.map((l, j) => (
        <Tap key={`${l.time}-${j}`} accessibilityLabel={`${l.text || 'Instrumental break'}. Tap to jump here.`} onPress={() => seekTo(l.time)}>
          <T size={j === 0 ? 22 : 18} weight={700} align="center" numberOfLines={2} style={{ opacity: j === 0 ? 0.45 : 0.28 }}>
            {l.text || '♪'}
          </T>
        </Tap>
      ))}
    </View>
  );
}

/** Real facts about the sing-along: how the words are timed and where you are in the song. */
function SingInfo({ lyrics }: { lyrics: Lyrics }) {
  const { track } = usePlayerPick('track');
  const bounds = useMemo(() => boundsOf(lyrics.synced, false), [lyrics.synced]);
  const i = activeLine(lyrics.synced, useLyricTime(bounds, useLyricShift(track?.id)));
  const total = lyrics.synced.length;
  return (
    <Row gap={10}>
      <Glass radius={22} padding={12} style={{ flex: 1, gap: 2 }}>
        <T size={11} mono tracking={1} color={colors.textSecondary}>
          WORD TIMING
        </T>
        <T size={15} weight={600}>
          {lyrics.wordSynced ? 'Word-synced' : 'Estimated'}
        </T>
      </Glass>
      <Glass radius={22} padding={12} style={{ flex: 1, gap: 2 }}>
        <T size={11} mono tracking={1} color={colors.textSecondary}>
          LINE
        </T>
        <T size={15} weight={600} mono>
          {`${Math.max(0, i + 1)} / ${total}`}
        </T>
      </Glass>
    </Row>
  );
}

/** Accent corner brackets framing the lyrics stage. */
function Corners() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={[styles.corner, { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 8 }]} />
      <View style={[styles.corner, { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 8 }]} />
      <View style={[styles.corner, { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 8 }]} />
      <View style={[styles.corner, { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 8 }]} />
    </View>
  );
}

function KaraokeStage({ track }: { track: CatalogTrack }) {
  const { loading, error, lyrics, reload } = useSyncedLyrics(track);
  let body;
  if (loading) body = <Loading label="Finding lyrics" />;
  else if (error) body = <ErrorState message={`Could not load lyrics. ${error}`} onRetry={reload} />;
  else if (lyrics?.synced.length) body = <KaraokeLines lyrics={lyrics} />;
  else {
    const title = !lyrics ? 'No sing-along lyrics' : lyrics.instrumental ? 'Instrumental' : 'Lyrics are not synced';
    const text = !lyrics
      ? "LRCLIB, a community lyrics library, doesn't have this track yet. You can still play the song and sing along."
      : lyrics.instrumental
        ? 'This track has no lyrics. Hum along!'
        : lyrics.timingMismatch
          ? 'The timed lyrics we found are for a different version of this song, so they can’t follow this audio. Open Lyrics to read them.'
          : 'This track only has plain lyrics, so they cannot follow the music. Open Lyrics to read them.';
    body = (
      <View style={{ gap: 12, alignItems: 'center', paddingHorizontal: 8 }}>
        <T variant="headlineLight" align="center">
          {title}
        </T>
        <T size={15} align="center" color={colors.textSecondary} lineHeight={21}>
          {text}
        </T>
        {lyrics && !lyrics.instrumental ? <LinkText label="Open Lyrics" href="/lyrics" /> : null}
      </View>
    );
  }
  return (
    <>
      {lyrics?.synced.length ? <SingInfo lyrics={lyrics} /> : null}
      <View style={styles.stage}>
        <Corners />
        {body}
      </View>
      {lyrics?.synced.length ? (
        <>
          <View style={{ alignItems: 'center' }}>
            <LyricSyncControl trackId={track.id} />
          </View>
          <T size={11} align="center" color={colors.textTertiary}>
            Lyrics from LRCLIB (community)
          </T>
        </>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ dock */

/** Pulsing rings behind the play button while the song plays (still under Reduce Motion or when paused). */
function PulseRing({ active, delay }: { active: boolean; delay: number }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    v.stopAnimation();
    v.setValue(0);
    if (!active || reduce) return;
    const loop = Animated.loop(Animated.sequence([Animated.delay(delay), Animated.timing(v, { toValue: 1, duration: 2000, easing: Easing.out(Easing.quad), useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [active, reduce, delay, v]);
  if (!active || reduce) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.ring, { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }] }]}
    />
  );
}

function DockStatus({ playing }: { playing: boolean }) {
  const { position, duration } = usePlaybackProgress();
  return (
    <View style={{ flex: 1, minWidth: 0, alignItems: 'center', gap: 4 }} accessible accessibilityLabel={`${playing ? 'Singing along' : 'Paused'}, ${formatDuration(position)} of ${formatDuration(duration)}`}>
      <T size={13} weight={600}>
        {playing ? 'Singing along' : 'Paused'}
      </T>
      <T size={11} mono color={colors.textSecondary}>
        {`${formatDuration(position)} / ${formatDuration(duration)}`}
      </T>
    </View>
  );
}

function Progress() {
  const { progress } = usePlaybackProgress();
  return <ProgressBar value={progress} height={4} />;
}

/* ------------------------------------------------------------------ screen */

export default function Karaoke() {
  const { track, playing, toggle, seekTo } = usePlayerPick('track', 'playing');

  if (!track) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'rose' }} swipeDown="top">
        <ScreenHeader title="Karaoke" />
        <EmptyState icon="music" title="Nothing playing" body="Play a song, then come back to sing along." action="Go to Home" href="/" />
      </Screen>
    );
  }

  return (
    <Screen top={4} bottom={18} gap={14} backdrop={{ pattern: 'dots', mesh: 'rose', orbs: true }} contentStyle={{ flexGrow: 1 }} swipeDown="top">
      {/* Header */}
      <Row gap={8}>
        <IconButton icon="back" label="Back" bg={colors.chipGhost} href="back" />
        <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
          <T size={15} weight={600} accessibilityRole="header">
            Karaoke
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {`${track.title} · ${track.artist.name}`}
          </T>
        </View>
        <IconButton icon="file" label="Open full lyrics" bg={colors.chipGhost} href="/lyrics" />
      </Row>

      <KaraokeStage key={track.id} track={track} />

      {/* Honest note: no live audio engine for these yet. */}
      <Glass radius={22} padding={12}>
        <Row gap={10} align="flex-start">
          <Icon name="info" size={18} color={colors.textSecondary} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <T size={13} color={colors.textSecondary} lineHeight={18}>
              Pitch scoring, mic level and duets need a live mic engine, so they aren&apos;t in this version.
            </T>
            <LinkText label="Remove vocals in Create studio" size={13} href="/create" />
          </View>
        </Row>
      </Glass>

      <View style={{ flex: 1 }} />

      <Progress />

      {/* Dock */}
      <Glass radius={34} style={styles.dock}>
        <IconButton icon="repeat" label="Restart song" size={48} bg={colors.chipGhost} onPress={() => seekTo(0)} />
        <DockStatus playing={playing} />
        <View style={styles.playWrap}>
          <PulseRing active={playing} delay={0} />
          <PulseRing active={playing} delay={1000} />
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} size={64} iconSize={30} bg={colors.accent} color={colors.onAccent} onPress={toggle} />
        </View>
        <IconButton
          icon="share"
          label="Share song"
          size={48}
          bg={colors.chipGhost}
          onPress={() => {
            setSheetTrack(track);
            router.push('/share-sheet');
          }}
        />
      </Glass>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stage: { minHeight: 300, justifyContent: 'center', paddingVertical: 22, paddingHorizontal: 10 },
  lines: { gap: 18 },
  glowText: { textShadowColor: withAlpha(colors.accent, 0.85), textShadowRadius: 14, textShadowOffset: { width: 0, height: 0 } },
  corner: { position: 'absolute', width: 22, height: 22, borderColor: colors.accent },
  dock: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  playWrap: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: colors.accent },
});
