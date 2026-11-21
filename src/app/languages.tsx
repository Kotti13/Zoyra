import { router } from 'expo-router';
import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { Button, Cover, Gradient, Icon, LinkText, Row, Screen, SectionHeader, Segmented, T, Tap, useAsync } from '../components';
import { LANGUAGES, languageTopSongArt } from '../lib/onboarding-picks';
import { permissionsPending } from '../lib/permissions';
import { useAuth, type Settings } from '../state/auth';
import { colors } from '../theme/tokens';

const QUALITIES: Settings['audio_quality'][] = ['low', 'normal', 'high', 'lossless'];
/** Same values the Theme screen stores in user_settings.theme. */
const THEMES = ['dark', 'light', 'black', 'auto'] as const;


const qualityNotes = [
  'Low streams at 24 kbps. You can change this any time in Settings.',
  'Normal streams at 96 kbps. You can change this any time in Settings.',
  'High streams at 320 kbps. You can change this any time in Settings.',
  'Lossless streams up to 24-bit FLAC. You can change this any time in Settings.',
];

function Steps({ done, total }: { done: number; total: number }) {
  return (
    <Row gap={6} style={{ flex: 1 }}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i < done ? colors.accent : colors.track }} />
      ))}
    </Row>
  );
}

/** A language as a picture tile: the cover of that language's top song, with the name over it. */
function LanguageTile({ language, on, width, onPress }: { language: string; on: boolean; width: number; onPress: () => void }) {
  const art = useAsync(() => languageTopSongArt(language), [language], 'app/languages:tile');
  const height = 104;
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${language}${art.data ? `, for example ${art.data.title}` : ''}`}
      style={{ width, height, borderRadius: 20, overflow: 'hidden', borderWidth: on ? 3 : 1, borderColor: on ? colors.accentLight : colors.glassBorder }}
    >
      <Cover artwork={art.data?.artwork} id={language} width={width} height={height} radius={0} fit="cover" />
      <Gradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.78)']} angle={180} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 64 }} />
      <View style={{ position: 'absolute', left: 12, right: 12, bottom: 10 }}>
        <T size={17} weight={700} color={colors.white} numberOfLines={1}>
          {language}
        </T>
      </View>
      {on ? (
        <View style={{ position: 'absolute', top: 8, right: 8, width: 26, height: 26, borderRadius: 13, backgroundColor: colors.accentLight, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="check" size={16} color={colors.onAccent} />
        </View>
      ) : null}
    </Tap>
  );
}

export default function Languages() {
  const { width: winW } = useWindowDimensions();
  const tileW = Math.floor((winW - 32 - 12) / 2);
  const { settings, updateSettings } = useAuth();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(settings?.languages ?? []));
  const [quality, setQuality] = useState(() => Math.max(0, QUALITIES.indexOf(settings?.audio_quality ?? 'normal')));
  const [theme, setTheme] = useState(() => Math.max(0, THEMES.findIndex((t) => t === settings?.theme)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Continue: keep the choices and go on to pick artists (the last step finishes setup). Skip: leave setup now.
  const finish = async (save: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (save) {
        await updateSettings({ languages: [...selected], audio_quality: QUALITIES[quality], theme: THEMES[theme] });
        router.push('/artists');
        return;
      }
      await updateSettings({ onboarded: true });
      // First-run permissions step (once per device), then Home.
      router.replace(permissionsPending() ? '/permissions' : '/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not finish setup');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (l: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });

  return (
    <Screen
      backdrop={{ pattern: 'lines', mesh: 'gold' }}
      gap={20}
      footer={
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24, gap: 8 }}>
          {error ? (
            <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
              {error}
            </T>
          ) : null}
          <Button label={busy ? 'Saving…' : selected.size ? `Continue (${selected.size} picked)` : 'Continue'} variant={busy ? 'disabled' : 'primary'} onPress={() => void finish(true)} />
        </View>
      }
    >
      <Row gap={16}>
        <Steps done={2} total={3} />
        <LinkText label="Skip" onPress={() => void finish(false)} />
      </Row>

      <View style={{ gap: 8 }}>
        <T variant="display" lineHeight={32} accessibilityRole="header">
          Music in your languages
        </T>
        <T size={16} color={colors.textSecondary} lineHeight={23}>
          Choose the languages you want to hear most.
        </T>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {LANGUAGES.map((l) => (
          <LanguageTile key={l} language={l} on={selected.has(l)} width={tileW} onPress={() => toggle(l)} />
        ))}
      </View>

      <SectionHeader title="Audio quality" />
      <Segmented options={['Low', 'Normal', 'High', 'Lossless']} initial={quality} onChange={setQuality} />
      <T size={13} color={colors.textSecondary} lineHeight={18} style={{ marginTop: -8 }}>
        {qualityNotes[quality]}
      </T>

      <SectionHeader title="Theme" />
      <Segmented options={['Dark', 'Light', 'AMOLED', 'Auto']} initial={theme} onChange={setTheme} />
    </Screen>
  );
}
