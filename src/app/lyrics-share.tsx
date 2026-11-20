/**
 * Share lyrics: pick up to four real lines of the current track's lyrics (LRCLIB), choose a card style
 * (NEON / GLASS / POSTER / MINIMAL), optionally include the cover art, then save or share the card as a PNG.
 *
 * The PNG is rendered with react-native-view-shot, which needs a development build; in Expo Go the
 * image actions explain that and "Copy link" still works.
 */
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { NativeModules, Platform, Share, StyleSheet, TurboModuleRegistry, View, type TurboModule } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { Art, artFor, Button, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, pickArt, Row, Screen, T, Tap, Toast, Toggle } from '../components';
import { useTrackLyrics } from '../components/LyricsView';
import { catalog, type CatalogTrack } from '../lib/catalog';
import { lyricShareUrl, shareContent } from '../lib/share-links';
import { activeLine, sourceLines } from '../lib/lyrics';
import { isLocalTrack, usePlaybackProgress, usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

const STYLES = ['NEON', 'GLASS', 'POSTER', 'MINIMAL'] as const;
type CardStyle = (typeof STYLES)[number];
const MAX_LINES = 4;
const CARD_W = 300;
const CARD_H = 340;

/** view-shot's native module is missing in Expo Go (and in builds made before it was added). */
const canCapture = Platform.OS !== 'web' && !!(TurboModuleRegistry.get<TurboModule>('RNViewShot') ?? NativeModules.RNViewShot);
const NEEDS_BUILD = 'Saving the card as an image needs the latest app build (it isn’t available in Expo Go). Copy link still works.';

/** Fits the lyric text to the card: fewer, shorter lines get bigger type. */
function fitSize(lines: string[], base: number) {
  const chars = lines.join(' ').length;
  return chars > 120 ? Math.round(base * 0.6) : chars > 70 ? Math.round(base * 0.74) : chars > 36 ? Math.round(base * 0.88) : base;
}

/* ------------------------------------------------------------------ card */

function CardFooter({ track, cover, light }: { track: CatalogTrack; cover: boolean; light?: boolean }) {
  return (
    <Row gap={10}>
      {cover ? <Cover artwork={track.artwork} id={track.id} size={36} radius={12} /> : <Art art={artFor(track.id)} size={36} radius={12} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={12} weight={600} numberOfLines={1}>
          {track.title}
        </T>
        <T size={12} color={light ? withAlpha(colors.white, 0.75) : colors.textSecondary} numberOfLines={1}>
          {track.artist.name}
        </T>
      </View>
      <T mono size={10} tracking={1.5} color={light ? withAlpha(colors.white, 0.8) : colors.textSecondary}>
        ZOYRA
      </T>
    </Row>
  );
}

function Card({ style, lines, track, cover }: { style: CardStyle; lines: string[]; track: CatalogTrack; cover: boolean }) {
  const art = pickArt(track.artwork, CARD_W * 2);
  const meta = `${track.title} · ${track.artist.name}`.toUpperCase();

  if (style === 'NEON') {
    const size = fitSize(lines, 34);
    const words = lines.join('\n');
    const cut = words.lastIndexOf(' ') > words.lastIndexOf('\n') ? words.lastIndexOf(' ') : words.lastIndexOf('\n');
    const head = cut > 0 ? words.slice(0, cut + 1) : '';
    const tail = cut > 0 ? words.slice(cut + 1) : words;
    return (
      <View style={styles.card}>
        <LinearGradient colors={[colors.rose, colors.accent, colors.accentDark]} locations={[0, 0.55, 1]} start={{ x: 0.3, y: 0 }} end={{ x: 0.7, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={styles.cardInner}>
          <T size={11} tracking={2} numberOfLines={1}>
            {meta}
          </T>
          <T size={size} weight={800} tracking={-1} lineHeight={Math.round(size * 1.1)} style={{ textShadowColor: withAlpha(colors.black, 0.35), textShadowRadius: 12, textShadowOffset: { width: 0, height: 2 } }}>
            {head}
            <T size={size} weight={800} tracking={-1} color={colors.gold}>
              {tail}
            </T>
          </T>
          <CardFooter track={track} cover={cover} light />
        </View>
      </View>
    );
  }

  if (style === 'GLASS') {
    const size = fitSize(lines, 30);
    return (
      <View style={[styles.card, { backgroundColor: colors.surface1 }]}>
        {cover && art ? <Image source={{ uri: art }} blurRadius={40} contentFit="cover" style={StyleSheet.absoluteFill} accessibilityIgnoresInvertColors /> : null}
        <LinearGradient colors={[withAlpha(colors.accent, 0.45), withAlpha(colors.bg, 0.6)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <Glass radius={26} style={{ position: 'absolute', top: 14, left: 14, right: 14, bottom: 14 }}>
          <View style={[styles.cardInner, { padding: 18 }]}>
            <T size={11} tracking={2} color={colors.peach}>
              LYRIC CARD
            </T>
            <T size={size} weight={300} tracking={-0.6} lineHeight={Math.round(size * 1.2)}>
              {lines.join('\n')}
            </T>
            <CardFooter track={track} cover={cover} />
          </View>
        </Glass>
      </View>
    );
  }

  if (style === 'POSTER') {
    const size = fitSize(lines, 32);
    return (
      <View style={styles.card}>
        {cover ? <Cover artwork={track.artwork} id={track.id} width={CARD_W} height={CARD_H} radius={0} style={StyleSheet.absoluteFill} /> : <Art art={artFor(track.id)} width={CARD_W} height={CARD_H} radius={0} style={StyleSheet.absoluteFill} />}
        <LinearGradient colors={[withAlpha(colors.bg, 0.1), withAlpha(colors.bg, 0.55), withAlpha(colors.bg, 0.95)]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
        <View style={styles.cardInner}>
          <View style={{ alignSelf: 'flex-start', paddingHorizontal: 10, height: 24, borderRadius: 12, justifyContent: 'center', backgroundColor: colors.accent }}>
            <T size={10} weight={700} tracking={1.5} color={colors.onAccent}>
              LYRICS
            </T>
          </View>
          <View style={{ gap: 10 }}>
            <T size={size} weight={800} tracking={-0.8} lineHeight={Math.round(size * 1.08)}>
              {lines.join('\n').toUpperCase()}
            </T>
            <View style={{ width: 40, height: 3, borderRadius: 2, backgroundColor: colors.accent }} />
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={12} weight={600} numberOfLines={1} style={{ flex: 1 }}>
                {meta}
              </T>
              <T mono size={10} tracking={1.5} color={colors.textSecondary}>
                ZOYRA
              </T>
            </Row>
          </View>
        </View>
      </View>
    );
  }

  // MINIMAL
  const size = fitSize(lines, 26);
  return (
    <View style={[styles.card, { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.hairline }]}>
      <View style={styles.cardInner}>
        <T size={44} weight={200} color={colors.accent} lineHeight={44}>
          “
        </T>
        <T size={size} weight={300} tracking={-0.4} lineHeight={Math.round(size * 1.3)}>
          {lines.join('\n')}
        </T>
        <Row gap={10}>
          {cover ? <Cover artwork={track.artwork} id={track.id} size={28} radius={8} /> : null}
          <T size={12} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
            — {track.title}, {track.artist.name}
          </T>
        </Row>
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ screen */

type Note = { message: string; error?: boolean };

export default function LyricsShare() {
  const { track } = usePlayerPick('track');
  const { position } = usePlaybackProgress();
  const { lyr, lyrics } = useTrackLyrics(track, 'original', 'English');

  /** Pickable lines: non-empty source lines with their index, so duplicates stay distinct. */
  const options = useMemo(() => (lyrics ? sourceLines(lyrics).map((text, i) => ({ i, text: text.trim() })).filter((l) => l.text) : []), [lyrics]);

  /** The user's pick, tagged with its track so a track change falls back to the default pick. */
  const [pick, setPick] = useState<{ id: string; lines: number[] } | null>(null);
  // Default pick: the line playing when the screen opened (synced), else the first line.
  const [startPos] = useState(position);
  const defaultPick = useMemo(() => {
    if (!lyrics || !options.length) return [];
    if (lyrics.synced.length) {
      const at = activeLine(lyrics.synced, startPos);
      const hit = options.find((o) => o.i >= Math.max(0, at));
      if (hit) return [hit.i];
    }
    return [options[0].i];
  }, [lyrics, options, startPos]);
  const picked = pick && pick.id === track?.id ? pick.lines : null;
  const selected = picked ?? defaultPick;
  const lines = options.filter((o) => selected.includes(o.i)).map((o) => o.text);

  const [style, setStyle] = useState<CardStyle>('NEON');
  const [cover, setCover] = useState(true);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'share' | 'copy' | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(id);
  }, [note]);

  const cardRef = useRef<ComponentRef<typeof View>>(null);

  // Rich https lyric-card link (preview + opens the song in the app); other sources keep their own page.
  const link = !track || isLocalTrack(track) ? null : lyricShareUrl(track) ?? catalog.shareUrl(track);

  async function exportCard(kind: 'save' | 'share') {
    if (!track || busy) return;
    if (!lines.length) return setNote({ message: 'Pick at least one line first.', error: true });
    if (!canCapture) return setNote({ message: NEEDS_BUILD, error: true });
    setBusy(kind);
    try {
      const uri = await captureRef(cardRef, { format: 'png', quality: 1, result: 'tmpfile' });
      const caption = `“${lines.join(' / ')}” — ${track.title} by ${track.artist.name}${link ? `\n${link}` : ''}`;
      if (kind === 'share' && link && Platform.OS !== 'ios') {
        // Android can't send an image with text: share the link (it unfurls into the lyric card) instead.
        await shareContent({ url: link, title: track.title, message: caption.replace(`\n${link}`, '') });
      } else if (kind === 'share' && Platform.OS === 'ios') {
        // iOS shares the image and the caption + link together.
        await Share.share({ url: uri, message: caption });
      } else {
        if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn’t available on this device.');
        await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: kind === 'save' ? 'Save lyric card' : 'Share lyric card' });
      }
    } catch (e) {
      setNote({ message: e instanceof Error ? `Couldn’t export the card. ${e.message}` : 'Couldn’t export the card.', error: true });
    } finally {
      setBusy(null);
    }
  }

  const copyLink = async () => {
    if (!link) return setNote({ message: 'Songs from your device have no public link to copy.', error: true });
    setBusy('copy');
    try {
      await Clipboard.setStringAsync(link);
      setNote({ message: 'Link copied' });
    } catch {
      setNote({ message: 'Could not copy the link', error: true });
    } finally {
      setBusy(null);
    }
  };

  const header = (
    <Row gap={8} style={{ minHeight: 52 }}>
      <IconButton icon="back" label="Back" href="back" bg={colors.chipGhost} />
      <View style={{ flex: 1, alignItems: 'center' }}>
        <T size={15} weight={600} accessibilityRole="header">
          Share lyrics
        </T>
        <T size={12} color={colors.textSecondary}>
          Pick lines, choose a style
        </T>
      </View>
      {track && lines.length ? <IconButton icon="download" label="Save image" bg={colors.chipGhost} onPress={() => void exportCard('save')} /> : <View style={{ width: 44 }} />}
    </Row>
  );

  if (!track) {
    return (
      <Screen top={4} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
        {header}
        <EmptyState title="Nothing playing" body="Play a song to share its lyrics." action="Go to Home" href="/" />
      </Screen>
    );
  }

  const toggleLine = (i: number) => {
    const has = selected.includes(i);
    if (!has && selected.length >= MAX_LINES) return setNote({ message: `Pick up to ${MAX_LINES} lines.`, error: true });
    setPick({ id: track.id, lines: has ? selected.filter((x) => x !== i) : [...selected, i].sort((a, b) => a - b) });
  };

  const shareSong = () => {
    setSheetTrack(track);
    router.push('/share-sheet');
  };

  let body;
  if (lyr.error && lyrics === undefined) body = <ErrorState message={`Could not load lyrics. ${lyr.error}`} onRetry={lyr.reload} />;
  else if (lyrics === undefined) body = <Loading label="Finding lyrics" />;
  else if (!options.length)
    body = (
      <EmptyState
        icon="music"
        title={lyrics?.instrumental ? 'Instrumental' : 'No lyrics to share'}
        body={lyrics?.instrumental ? 'This track has no words to put on a card.' : 'We couldn’t find lyrics for this song. You can still share the song itself.'}
        action="Share the song"
        onAction={shareSong}
      />
    );
  else
    body = (
      <>
        {/* Card preview (this exact view is captured as the PNG) */}
        <View style={{ alignItems: 'center' }}>
          <View ref={cardRef} collapsable={false} accessible accessibilityLabel={`${style.toLowerCase()} lyric card: ${lines.join(', ') || 'no lines picked'}. ${track.title} by ${track.artist.name}.`}>
            {lines.length ? (
              <Card style={style} lines={lines} track={track} cover={cover} />
            ) : (
              <View style={[styles.card, { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.chipOutline, borderStyle: 'dashed' }]}>
                <T color={colors.textSecondary} align="center" style={{ maxWidth: 220 }}>
                  Pick a line below to build your card
                </T>
              </View>
            )}
          </View>
        </View>

        {/* Style pills */}
        <Row gap={8} style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          {STYLES.map((s) => {
            const on = s === style;
            return (
              <Tap key={s} accessibilityLabel={`${s.toLowerCase()} style`} accessibilityState={{ selected: on }} onPress={() => setStyle(s)} style={{ height: 44, justifyContent: 'center' }}>
                <View style={{ height: 34, paddingHorizontal: 16, borderRadius: 17, justifyContent: 'center', backgroundColor: on ? colors.accent : colors.iconGhost, borderWidth: on ? 0 : 1, borderColor: colors.chipOutline }}>
                  <T size={12} weight={700} tracking={0.5} color={on ? colors.onAccent : colors.text}>
                    {s}
                  </T>
                </View>
              </Tap>
            );
          })}
        </Row>

        {/* Options */}
        <Glass padding={16} style={{ gap: 14 }}>
          <Row>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="file" size={20} color={colors.accentLight} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={16} weight={500}>
                Selected lines
              </T>
              <T size={14} color={colors.textSecondary} numberOfLines={editing ? undefined : 2}>
                {lines.length ? lines.join(' / ') : 'None yet'}
              </T>
            </View>
            <LinkText label={editing ? 'Done' : 'Edit'} onPress={() => setEditing((e) => !e)} />
          </Row>
          {editing ? (
            <View style={{ gap: 2 }}>
              <T size={12} color={colors.textTertiary}>
                Tap up to {MAX_LINES} lines · lyrics from LRCLIB
              </T>
              {options.map((o) => {
                const on = selected.includes(o.i);
                return (
                  <Tap
                    key={o.i}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={o.text}
                    onPress={() => toggleLine(o.i)}
                    style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 }}
                  >
                    <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.accent : undefined, borderWidth: on ? 0 : 1.5, borderColor: colors.chipOutline }}>
                      {on ? <Icon name="check" size={14} color={colors.onAccent} /> : null}
                    </View>
                    <T size={15} color={on ? colors.text : colors.textSecondary} style={{ flex: 1 }}>
                      {o.text}
                    </T>
                  </Tap>
                );
              })}
            </View>
          ) : null}
          <Row>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="camera" size={20} color={colors.accentLight} />
            </View>
            <View style={{ flex: 1 }}>
              <T size={16} weight={500}>
                Include cover art
              </T>
              <T size={14} color={colors.textSecondary}>
                Shows on the card
              </T>
            </View>
            <Toggle value={cover} onChange={setCover} label="Include cover art" />
          </Row>
        </Glass>

        {!canCapture ? (
          <T size={12} color={colors.textTertiary} align="center">
            {NEEDS_BUILD}
          </T>
        ) : null}
        <View style={{ alignItems: 'center' }}>
          <LinkText label="More ways to share the song" icon="share" onPress={shareSong} />
        </View>
      </>
    );

  return (
    <Screen
      top={4}
      gap={18}
      backdrop={{ pattern: 'dots', mesh: 'rose' }}
      footer={
        options.length ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 18, paddingTop: 8, gap: 10 }}>
            {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.accentLight : colors.success} message={note.message} /> : null}
            <Row gap={10}>
              <View style={{ flex: 1 }}>
                <Button label={busy === 'copy' ? 'Copying…' : 'Copy link'} icon="link" variant="glass" onPress={() => void copyLink()} />
              </View>
              <View style={{ flex: 1.3 }}>
                <Button label={busy === 'share' ? 'Preparing…' : 'Share card'} icon="share" variant={lines.length && canCapture ? 'primary' : 'disabled'} onPress={() => void exportCard('share')} />
              </View>
            </Row>
            {busy === 'save' ? (
              <T size={12} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
                Preparing image…
              </T>
            ) : null}
          </View>
        ) : note ? (
          <View style={{ paddingHorizontal: 16, paddingBottom: 18 }}>
            <Toast icon="info" iconColor={colors.accentLight} message={note.message} />
          </View>
        ) : undefined
      }
    >
      {header}
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { width: CARD_W, height: CARD_H, borderRadius: 32, overflow: 'hidden' },
  cardInner: { flex: 1, padding: 26, justifyContent: 'space-between' },
});
