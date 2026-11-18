/**
 * Lyrics focus mode: one synced line at a time, big and uppercase, words filling as they are sung.
 * Opened from Lyrics › WORD. Params: `highlight` (fill | wave | static), optional `view` (translate | romanize) + `target`.
 * The screen stays awake while it is open.
 */
import { useKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, IconButton, Loading, Row, Screen, T } from '../components';
import { displaySynced, LyricsFocusView, PlayRing, useSyncedLyrics, useTrackLyrics, type LyricsHighlight } from '../components/LyricsView';
import { LyricSyncControl } from '../components/lyric-sync';
import { formatDuration, type CatalogTrack } from '../lib/catalog';
import type { LyricLine, LyricsView as LyricsMode } from '../lib/lyrics';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

function Header({ sub, badge }: { sub: string; badge?: string }) {
  return (
    <Row gap={8} style={{ minHeight: 52 }}>
      <IconButton icon="back" label="Back to lyrics" href="back" bg={colors.chipGhost} />
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        <T size={15} weight={600} accessibilityRole="header">
          Focus mode
        </T>
        <T size={12} color={colors.textSecondary} numberOfLines={1}>
          {sub}
        </T>
      </View>
      {badge ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.iconGhost, borderWidth: 1, borderColor: colors.glassBorder }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success }} />
          <T mono size={10} weight={500} tracking={0.8}>
            {badge}
          </T>
        </View>
      ) : (
        <View style={{ width: 44 }} />
      )}
    </Row>
  );
}

function Progress({ track }: { track: CatalogTrack }) {
  const { position, duration, progress } = usePlaybackProgress();
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T mono size={11} color={colors.peach}>
          {formatDuration(position)}
        </T>
        <T size={12} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>
          {track.title} · {track.artist.name}
        </T>
        <T mono size={11} color={colors.textSecondary}>
          {formatDuration(duration)}
        </T>
      </Row>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${formatDuration(position)} of ${formatDuration(duration)}`}
        style={{ height: 3, borderRadius: 2, backgroundColor: colors.chipOutline, overflow: 'hidden' }}
      >
        <View style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%`, height: 3, backgroundColor: colors.accent }} />
      </View>
    </View>
  );
}

/** The focus view + line-jump controls (mounted only when synced lines exist). */
function Focus({ lines, highlight, track }: { lines: LyricLine[]; highlight: LyricsHighlight; track: CatalogTrack }) {
  const synced = useSyncedLyrics(lines);
  const { current, timed, seekLine } = synced;
  return (
    <>
      <LyricsFocusView key={track.id} synced={synced} highlight={highlight} />
      <View style={{ gap: 16, paddingBottom: 8 }}>
        <Progress track={track} />
        <View style={{ alignItems: 'center' }}>
          <LyricSyncControl trackId={track.id} />
        </View>
        <Glass radius={34} padding={8} style={{ alignSelf: 'center' }}>
          <Row gap={20} style={{ paddingHorizontal: 12 }}>
            <IconButton icon="prev" label="Previous line" size={48} onPress={() => seekLine(current <= 0 ? 0 : current - 1)} />
            <PlayRing />
            <IconButton icon="next" label="Next line" size={48} onPress={() => seekLine(Math.min(timed.length - 1, current + 1))} />
          </Row>
        </Glass>
      </View>
    </>
  );
}

export default function LyricsFocus() {
  useKeepAwake('lyrics-focus');
  const params = useLocalSearchParams<{ highlight?: string; view?: string; target?: string }>();
  const highlight: LyricsHighlight = params.highlight === 'wave' ? 'wave' : params.highlight === 'static' ? 'static' : 'fill';
  const view: LyricsMode = params.view === 'translate' || params.view === 'romanize' ? params.view : 'original';
  const target = params.target || 'English';
  const { track } = usePlayerPick('track');
  const { lyr, lyrics, aiLines } = useTrackLyrics(track, view, target);
  const lines = useMemo(() => displaySynced(lyrics, aiLines), [lyrics, aiLines]);

  const sub = aiLines ? (view === 'translate' ? `One line at a time · ${target}` : 'One line at a time · romanized') : 'One line at a time';

  return (
    <Screen scroll={false} gap={16} top={4} stagger={false} backdrop={{ pattern: 'none', mesh: 'coral' }} swipeDown>
      <Header sub={sub} badge={lines ? (lyrics?.wordSynced && !aiLines ? 'WORD SYNC' : 'SYNCED') : undefined} />
      {!track ? (
        <EmptyState title="Nothing playing" body="Play a song to follow its lyrics here." action="Go to Home" href="/" />
      ) : lines ? (
        <Focus lines={lines} highlight={highlight} track={track} />
      ) : lyr.error && lyrics === undefined ? (
        <ErrorState message={`Could not load lyrics. ${lyr.error}`} onRetry={lyr.reload} />
      ) : lyrics === undefined ? (
        <Loading label="Finding lyrics" />
      ) : (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 16 }}>
          <T variant="headlineLight" align="center">
            {lyrics?.timingMismatch ? 'Lyrics not timed for this version' : lyrics ? 'These lyrics aren’t synced' : 'No lyrics found for this song'}
          </T>
          <T align="center" color={colors.textSecondary} style={{ maxWidth: 300 }}>
            Focus mode follows the music line by line, so it needs lyrics with timing. The full lyrics screen still shows what we have.
          </T>
          <Button label="Back to lyrics" variant="glass" href="back" />
        </View>
      )}
    </Screen>
  );
}
