import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, LinkText, Row, Screen, SectionHeader, Segmented, T } from '../components';
import { permissionsPending } from '../lib/permissions';
import { useAuth, type Settings } from '../state/auth';
import { colors } from '../theme/tokens';

const QUALITIES: Settings['audio_quality'][] = ['low', 'normal', 'high', 'lossless'];
/** Same values the Theme screen stores in user_settings.theme. */
const THEMES = ['dark', 'light', 'black', 'auto'] as const;

const languages = ['Tamil', 'Hindi', 'English', 'Spanish', 'Korean', 'Telugu', 'Malayalam', 'Punjabi', 'Japanese', 'Bengali'];

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

export default function Languages() {
  const { settings, updateSettings } = useAuth();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(settings?.languages ?? []));
  const [quality, setQuality] = useState(() => Math.max(0, QUALITIES.indexOf(settings?.audio_quality ?? 'normal')));
  const [theme, setTheme] = useState(() => Math.max(0, THEMES.findIndex((t) => t === settings?.theme)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const finish = async (save: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await updateSettings(
        save ? { languages: [...selected], audio_quality: QUALITIES[quality], theme: THEMES[theme], onboarded: true } : { onboarded: true },
      );
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
          <Button label={busy ? 'Saving…' : 'Finish setup'} variant={busy ? 'disabled' : 'primary'} onPress={() => void finish(true)} />
        </View>
      }
    >
      <Row gap={16}>
        <Steps done={3} total={3} />
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

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 4 }}>
        {languages.map((l) => (
          <Chip key={l} label={l} active={selected.has(l)} onPress={() => toggle(l)} />
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
