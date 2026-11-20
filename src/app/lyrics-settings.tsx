import { useMemo } from 'react';
import { View } from 'react-native';

import { Chip, Screen, Segmented, T, Toggle } from '../components';
import { BigHeader, Panel, PanelRow, SectionLabel } from '../components/settings-ui';
import { LyricsView, useTrackLyrics } from '../components/LyricsView';
import { LYRICS_SIZES, usePlayPref, type LyricsHighlightPref, type LyricsSizePref } from '../lib/play-prefs';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const STYLES: { key: LyricsHighlightPref; label: string; hint: string }[] = [
  { key: 'fill', label: 'Fill', hint: 'Words brighten as they are sung' },
  { key: 'wave', label: 'Wave', hint: 'Words brighten and lift as they are sung' },
  { key: 'static', label: 'Static', hint: 'The whole line lights up at once' },
];

/** Translation targets offered by the AI translate tool (any language name works; these are common ones). */
/** Output delay choices (ms): Bluetooth headphones and speakers play sound a little after the app does. */
const DELAYS: { ms: number; label: string }[] = [
  { ms: 0, label: 'None' },
  { ms: 100, label: '0.1s' },
  { ms: 200, label: '0.2s' },
  { ms: 300, label: '0.3s' },
  { ms: 500, label: '0.5s' },
];

const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Hindi', 'Tamil', 'Telugu', 'Japanese', 'Korean', 'Chinese', 'Arabic'];

/** Live preview: the playing song's synced lyrics in the chosen style and size. */
function Preview({ size }: { size: number }) {
  const { track } = usePlayerPick('track');
  const { lyrics } = useTrackLyrics(track, 'original', '');
  const synced = lyrics?.synced.length ? lyrics.synced : null;
  return (
    <Panel padding={{ v: 24, h: 20 }} style={{ gap: 6 }}>
      {synced ? (
        <LyricsView key={track?.id} lines={synced} compact size={size} />
      ) : (
        <T size={13} color={colors.textSecondary} lineHeight={18}>
          {!track
            ? 'Play a song with synced lyrics to preview your style here.'
            : lyrics === undefined
              ? 'Finding lyrics for the song that’s playing…'
              : 'The song that’s playing has no synced lyrics, so there’s nothing to preview right now.'}
        </T>
      )}
    </Panel>
  );
}

/**
 * Settings › Lyrics. Device prefs read by the lyrics screen, LyricsView (player card, lyrics screen)
 * and the player screen (auto-open).
 */
export default function LyricsSettings() {
  const { settings } = useAuth();
  const [size, setSize] = usePlayPref('lyrics.size');
  const [highlight, setHighlight] = usePlayPref('lyrics.highlight');
  const [autoOpen, setAutoOpen] = usePlayPref('lyrics.autoOpen');
  const [target, setTarget] = usePlayPref('lyrics.target');
  const [romanize, setRomanize] = usePlayPref('lyrics.romanizeDefault');
  const [delayMs, setDelayMs] = usePlayPref('lyrics.outputDelayMs');
  const languages = useMemo(() => [...new Set([...LANGUAGES, ...(settings?.languages ?? []).filter(Boolean), target].filter(Boolean))], [settings?.languages, target]);

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <BigHeader title="Lyrics" />
      <Preview size={Math.round(20 * (LYRICS_SIZES[size] ?? LYRICS_SIZES[0]).scale)} />

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Style</SectionLabel>
        <Segmented key={highlight} options={STYLES.map((s) => s.label)} initial={Math.max(0, STYLES.findIndex((s) => s.key === highlight))} onChange={(i) => setHighlight(STYLES[i].key)} />
        <T size={12} color={colors.textTertiary}>
          {STYLES.find((s) => s.key === highlight)?.hint}. With Reduce Motion on, words switch without animating.
        </T>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Text size</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
          {LYRICS_SIZES.map((s, i) => (
            <Chip key={s.label} label={s.label} active={size === i} onPress={() => setSize(i as LyricsSizePref)} />
          ))}
        </View>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Bluetooth / audio delay</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
          {DELAYS.map((d) => (
            <Chip key={d.ms} label={d.label} active={delayMs === d.ms} onPress={() => setDelayMs(d.ms)} />
          ))}
        </View>
        <T size={12} color={colors.textTertiary} lineHeight={17}>
          Wireless headphones play the sound a moment after the app. If lyrics light up before the singing on Bluetooth, add a delay. For one song, use Sync on the lyrics screen (saved per song).
        </T>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Behaviour</SectionLabel>
        <Panel padding={{ v: 4, h: 16 }}>
        <PanelRow
          title="Open lyrics automatically"
          subtitle="Show the lyrics screen when you open the player and the song has lyrics"
          minHeight={72}
          right={<Toggle value={autoOpen} onChange={setAutoOpen} label="Open lyrics automatically" />}
        />
        <PanelRow
          title="Romanized by default"
          subtitle="Latin letters for other scripts when lyrics open (AI)"
          minHeight={72}
          divider
          right={<Toggle value={romanize} onChange={setRomanize} label="Romanized by default" />}
        />
      </Panel>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Translate to</SectionLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
          {languages.map((l) => (
            <Chip key={l} label={l} active={target === l} onPress={() => setTarget(l)} />
          ))}
        </View>
        <T size={12} color={colors.textTertiary} lineHeight={17}>
          The translate button on the lyrics screen uses this language first. Translation and romanization are done by AI and may not be exact.
        </T>
      </View>

      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Lyrics on the lock screen aren’t offered: the system lock-screen card can’t show lyric lines. Timed lyrics are only synced when they were made for the same version of the song; otherwise they’re shown as plain text.
      </T>
    </Screen>
  );
}
