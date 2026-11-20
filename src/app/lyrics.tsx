import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, Row, Screen, T, Tap, type AsyncState } from '../components';
import { GlowBackdrop } from '../components/art-fx';
import { displaySynced, LyricsView, PlayRing, useTrackLyrics, type LyricsHighlight } from '../components/LyricsView';
import { LyricSyncControl } from '../components/lyric-sync';
import { formatDuration } from '../lib/catalog';
import { LYRICS_SIZES, usePlayPref, type LyricsSizePref } from '../lib/play-prefs';
import type { Lyrics as LyricsData, LyricsView as LyricsMode } from '../lib/lyrics';
import { useAuth } from '../state/auth';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';


/* ------------------------------------------------------------------ small pieces */

/** Live progress (isolated so only this re-renders every tick). */
function Progress() {
  const { position, duration, progress } = usePlaybackProgress();
  const pct = `${Math.max(0, Math.min(1, progress)) * 100}%` as const;
  return (
    <View style={{ gap: 6 }} accessible accessibilityRole="progressbar" accessibilityLabel={`${formatDuration(position)} of ${formatDuration(duration)}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T mono size={11} color={colors.peach}>
          {formatDuration(position)}
        </T>
        <T mono size={11} color={colors.textSecondary}>
          / {formatDuration(duration)}
        </T>
      </Row>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.chipOutline, overflow: 'hidden' }}>
        <LinearGradient colors={[colors.accent, colors.white]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: pct, height: 4, borderRadius: 2 }} />
      </View>
    </View>
  );
}

/** Pill used for the FILL / WAVE / WORD style switch (accent when selected). */
function ModePill({ label, active, onPress, hint }: { label: string; active?: boolean; onPress: () => void; hint: string }) {
  return (
    <Tap accessibilityLabel={label} accessibilityHint={hint} accessibilityState={{ selected: !!active }} onPress={onPress} style={{ height: 44, justifyContent: 'center' }}>
      <View
        style={{
          height: 34,
          paddingHorizontal: 16,
          borderRadius: 17,
          justifyContent: 'center',
          backgroundColor: active ? colors.accent : colors.iconGhost,
          borderWidth: active ? 0 : 1,
          borderColor: colors.chipOutline,
        }}
      >
        <T size={12} weight={700} tracking={0.5} color={active ? colors.onAccent : colors.text}>
          {label}
        </T>
      </View>
    </Tap>
  );
}

/** Glass dock button (icon + label); `on` tints it. */
function DockButton({ label, a11y, on, onPress, children }: { label: string; a11y: string; on?: boolean; onPress: () => void; children: ReactNode }) {
  return (
    <Tap accessibilityLabel={a11y} accessibilityState={{ selected: !!on }} onPress={onPress} style={{ flex: 1 }}>
      <View style={{ height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center', gap: 3, backgroundColor: on ? colors.accentTint : withAlpha(colors.white, 0.07), borderWidth: 1, borderColor: on ? withAlpha(colors.accent, 0.6) : colors.glassBorder }}>
        {children}
        <T size={10} weight={600} color={on ? colors.accentLight : colors.textSecondary} numberOfLines={1}>
          {label}
        </T>
      </View>
    </Tap>
  );
}

/** Real sync status, shown in the header badge. */
function syncBadge(l: LyricsData | null | undefined): { label: string; dot: string } | null {
  if (l === undefined) return null;
  if (!l) return { label: 'NO LYRICS', dot: colors.textTertiary };
  if (l.synced.length) return { label: l.wordSynced ? 'WORD SYNC' : 'SYNCED', dot: colors.success };
  if (l.instrumental) return { label: 'INSTRUMENTAL', dot: colors.textTertiary };
  return { label: 'NOT SYNCED', dot: colors.warning };
}

/* ------------------------------------------------------------------ states */

/** Centered message used for not-found / instrumental states. */
function LyricsMessage({ title, body, k }: { title: string; body: string; k: number }) {
  return (
    <View style={{ alignItems: 'center', gap: 14 * k }} accessible accessibilityLabel={`${title}. ${body}`}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="file" size={26} color={colors.accentLight} />
      </View>
      <T variant="headlineLight" size={26 * k} align="center" lineHeight={Math.round(26 * k * 1.25)}>
        {title}
      </T>
      <T size={15 * k} align="center" lineHeight={Math.round(15 * k * 1.45)} color={colors.textSecondary} style={{ maxWidth: 300 }}>
        {body}
      </T>
    </View>
  );
}

const Attribution = ({ view }: { view: LyricsMode }) => (
  <T size={12} align="center" color={colors.textTertiary} style={{ marginTop: 16 }}>
    {view === 'translate' ? 'Lyrics from LRCLIB (community) · translated by AI' : view === 'romanize' ? 'Lyrics from LRCLIB (community) · romanized by AI' : 'Lyrics from LRCLIB (community)'}
  </T>
);

type Loaded = { id: string; lyrics: LyricsData | null };

/** Loading, error, not-found, instrumental and unsynced (plain) states. */
function StaticLyrics({ lyr, data, shown, view, k }: { lyr: AsyncState<Loaded>; data: LyricsData | null | undefined; shown: string[] | null; view: LyricsMode; k: number }) {
  if (lyr.error && data === undefined) return <ErrorState message={`Could not load lyrics. ${lyr.error}`} onRetry={lyr.reload} />;
  if (data === undefined) return <Loading label="Finding lyrics" />;
  if (!data)
    return (
      <LyricsMessage
        k={k}
        title="No lyrics found for this song"
        body="Most songs in the current catalogue are independent uploads, remixes and instrumentals that no lyrics library covers yet. Licensed lyrics arrive with the licensed music catalogue."
      />
    );
  if (data.instrumental && !data.synced.length) return <LyricsMessage k={k} title="Instrumental" body="This track has no lyrics. Enjoy the music." />;
  const plain = shown ?? data.plain;
  return (
    <View style={{ gap: 10 * k }}>
      <T size={12} color={colors.textTertiary}>
        {data.source === 'original'
          ? `Lyrics of the original song${data.matchedTitle ? ` “${data.matchedTitle}”` : ''}${data.matchedArtist ? ` by ${data.matchedArtist}` : ''} · this version may differ, so they aren't synced`
          : data.timingMismatch
            ? 'Lyrics not timed for this version'
            : 'Not synced to the music'}
      </T>
      {plain.map((l, i) => (
        <T key={i} size={22 * k} weight={300} tracking={-0.4} lineHeight={Math.round(22 * k * 1.35)} style={{ opacity: l.trim() ? 0.9 : 0 }}>
          {l || ' '}
        </T>
      ))}
      <Attribution view={shown ? view : 'original'} />
    </View>
  );
}

/* ------------------------------------------------------------------ screen */

export default function Lyrics() {
  const { track, playing, next, previous } = usePlayerPick('track', 'playing');
  const { settings } = useAuth();
  // Text size and highlight style are Settings › Lyrics prefs; changing them here saves them too.
  const [scale, setScale] = usePlayPref('lyrics.size');
  const k = (LYRICS_SIZES[scale] ?? LYRICS_SIZES[0]).scale;
  const [highlight, setHighlight] = usePlayPref('lyrics.highlight');
  const [prefTarget] = usePlayPref('lyrics.target');
  const [romanizeDefault] = usePlayPref('lyrics.romanizeDefault');

  /** Translation targets: the Settings › Lyrics language first, then English and the user's chosen languages. */
  const targets = useMemo(() => [...new Set([prefTarget || 'English', 'English', ...(settings?.languages ?? []).filter(Boolean)])], [prefTarget, settings?.languages]);
  const [view, setView] = useState<LyricsMode>(() => (romanizeDefault ? 'romanize' : 'original'));
  const [targetIdx, setTargetIdx] = useState(0);
  const target = targets[targetIdx % targets.length];
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  const { lyr, lyrics, ready, ai, result, aiLoading, aiLines } = useTrackLyrics(track, view, target);
  const synced = useMemo(() => displaySynced(lyrics, aiLines), [lyrics, aiLines]);
  const badge = syncBadge(lyrics);
  // Translation / romanization sits under each original line (the original keeps its word timing).
  const baseLines = lyrics?.synced.length ? lyrics.synced : null;

  const pick = (v: Exclude<LyricsMode, 'original'>) => {
    if (view === v) return setView('original');
    if (lyrics !== undefined && !ready) return setNote(lyrics ? 'This song has no words to change.' : 'No lyrics to change for this song.');
    setView(v);
  };

  const label = view === 'translate' ? `Translating to ${target}` : 'Romanizing';
  let status: { text: string; retry?: boolean } | null = null;
  if (view !== 'original' && ready) {
    if (aiLoading) status = { text: `${label}…` };
    else if (ai.error) status = { text: `${label} failed. ${ai.error}`, retry: true };
    else if (result && !result.ok)
      status =
        result.reason === 'not_configured'
          ? { text: `${view === 'translate' ? 'Translation' : 'Romanization'} needs Anthropic setup.` }
          : { text: `${label} failed. ${result.message}`, retry: true };
    else status = { text: view === 'translate' ? `Translated to ${target}` : 'Romanized' };
  }

  if (!track) {
    return (
      <Screen top={4} swipeDown="top" backdrop={{ pattern: 'grid', mesh: 'coral' }}>
        <Row gap={8} style={{ minHeight: 44 }}>
          <IconButton icon="chevronDown" label="Back" href="back" bg={colors.chipGhost} />
          <T variant="section" align="center" style={{ flex: 1 }} accessibilityRole="header">
            Lyrics
          </T>
          <View style={{ width: 44 }} />
        </Row>
        <EmptyState title="Nothing playing" body="Play a song to see its lyrics here." action="Go to Home" href="/" />
      </Screen>
    );
  }

  const openFocus = () => {
    if (!synced) return setNote(lyrics === undefined ? 'Lyrics are still loading.' : 'Focus mode needs lyrics synced to the music.');
    const h: LyricsHighlight = highlight;
    router.push({ pathname: '/lyrics-focus', params: view === 'original' ? { highlight: h } : { highlight: h, view, target } });
  };
  const shareLyrics = () => {
    if (ready) return router.push('/lyrics-share');
    // Nothing to put on a card: fall back to sharing the song itself.
    setSheetTrack(track);
    router.push('/share-sheet');
  };

  const sub = badge?.label === 'SYNCED' || badge?.label === 'WORD SYNC' ? 'Synced lyrics' : lyrics?.source === 'original' ? 'Original song lyrics' : 'Lyrics';

  return (
    <Screen
      swipeDown="top"
      scroll={false}
      gap={0}
      top={4}
      stagger={false}
      backdrop={{ pattern: 'dots', mesh: 'none' }}
      underlay={<GlowBackdrop active={playing && !!synced} />}
      footer={
        <View style={{ paddingTop: 6, paddingHorizontal: 16, paddingBottom: 18, gap: 10 }}>
          {status || note ? (
            <Row gap={8} style={{ paddingHorizontal: 4 }}>
              <T size={13} color={colors.textSecondary} accessibilityLiveRegion="polite" style={{ flexShrink: 1 }} numberOfLines={2}>
                {note ?? status?.text}
              </T>
              {!note && status?.retry ? <LinkText label="Try again" size={13} onPress={ai.reload} /> : null}
              {!note && view === 'translate' && !aiLoading && targets.length > 1 ? (
                <LinkText label={`To ${targets[(targetIdx + 1) % targets.length]}`} size={13} onPress={() => setTargetIdx((i) => (i + 1) % targets.length)} />
              ) : null}
            </Row>
          ) : null}
          {synced ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
              <ModePill label="FILL" hint="Words fill in as they are sung" active={highlight === 'fill'} onPress={() => setHighlight('fill')} />
              <ModePill label="WAVE" hint="Words lift as they are sung" active={highlight === 'wave'} onPress={() => setHighlight('wave')} />
              <ModePill label="STATIC" hint="The whole line lights up at once" active={highlight === 'static'} onPress={() => setHighlight('static')} />
              <ModePill label="Rō" hint="Show romanized lyrics" active={view === 'romanize'} onPress={() => pick('romanize')} />
              <ModePill label="Aa" hint={`Text size, ${(LYRICS_SIZES[scale] ?? LYRICS_SIZES[0]).label.toLowerCase()}`} onPress={() => setScale(((scale + 1) % LYRICS_SIZES.length) as LyricsSizePref)} />
            </ScrollView>
          ) : null}
          {synced ? <LyricSyncControl trackId={track.id} /> : null}
          <Glass radius={34} padding={12} style={{ gap: 8 }}>
            <Progress />
            <Row style={{ justifyContent: 'space-between', paddingHorizontal: 28 }}>
              <IconButton icon="prev" label="Previous track" size={48} iconSize={26} onPress={previous} />
              <PlayRing />
              <IconButton icon="next" label="Next track" size={48} iconSize={26} onPress={next} />
            </Row>
            <Row gap={8}>
              <DockButton label="Focus" a11y="Focus mode" onPress={openFocus}>
                <Icon name="eye" size={20} />
              </DockButton>
              <DockButton label="Karaoke" a11y="Karaoke" onPress={() => router.push('/karaoke')}>
                <Icon name="mic" size={20} />
              </DockButton>
              <DockButton label={view === 'translate' ? 'Original' : 'Translate'} a11y={view === 'translate' ? 'Show original lyrics' : `Translate to ${target}`} on={view === 'translate'} onPress={() => pick('translate')}>
                <Icon name="globe" size={20} color={view === 'translate' ? colors.accentLight : colors.text} />
              </DockButton>
              <DockButton label="Share" a11y={ready ? 'Share lyrics' : 'Share song'} onPress={shareLyrics}>
                <Icon name="share" size={20} />
              </DockButton>
            </Row>
          </Glass>
        </View>
      }
    >
      {/* Header */}
      <Row gap={10} style={{ minHeight: 52 }}>
        <IconButton icon="chevronDown" label="Back to player" iconSize={24} href="back" bg={colors.chipGhost} />
        <Cover artwork={track.artwork} id={track.id} size={44} radius={14} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={15} weight={700} numberOfLines={1}>
            {track.title}
          </T>
          <T size={12} color={colors.accentLight} numberOfLines={1}>
            {track.artist.name}
            {badge ? '' : ` · ${sub}`}
          </T>
        </View>
        {badge ? (
          <View
            accessible
            accessibilityLabel={`Lyrics status: ${badge.label.toLowerCase()}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: colors.iconGhost, borderWidth: 1, borderColor: colors.glassBorder }}
          >
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: badge.dot }} />
            <T mono size={10} weight={500} tracking={0.8} color={badge.dot === colors.success ? colors.success : colors.text}>
              {badge.label}
            </T>
          </View>
        ) : null}
        <IconButton icon="sliders" label="Lyrics settings" href="/lyrics-settings" bg={colors.chipGhost} />
      </Row>

      {/* Lyrics */}
      <View style={{ flex: 1, marginTop: 6 }}>
        {synced ? (
          <LyricsView
            key={track.id}
            lines={baseLines ?? synced}
            subLines={aiLines}
            card
            size={Math.round(30 * k)}
            highlight={highlight}
            footer={
              <View>
                <Attribution view={aiLines ? view : 'original'} />
                {!aiLines && lyrics?.wordSynced ? (
                  <T size={12} align="center" color={colors.textTertiary} style={{ marginTop: 4 }}>
                    Word-by-word timing from LRCLIB
                  </T>
                ) : null}
              </View>
            }
          />
        ) : (
          <ScrollView
            key={track.id}
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', gap: 12, paddingTop: 24, paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
          >
            <StaticLyrics lyr={lyr} data={lyrics} shown={aiLines} view={view} k={k} />
          </ScrollView>
        )}
      </View>
    </Screen>
  );
}
