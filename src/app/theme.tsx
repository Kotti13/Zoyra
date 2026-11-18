import { useState } from 'react';
import { View } from 'react-native';

import { Glass, Icon, ListRow, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toggle } from '../components';
import { usePref } from '../lib/prefs';
import { useAuth, type Settings } from '../state/auth';
import { colors } from '../theme/tokens';

/** Device-only preference (shared live store in `prefs.ts`). */
function useDevicePref<V>(key: string, fallback: V) {
  return usePref<V>(key, fallback);
}

type ThemeOpt = { name: string; preview: 'dark' | 'black' | 'light' | 'auto' };
/** `preview` doubles as the value stored in user_settings.theme. */
const themes: ThemeOpt[] = [
  { name: 'Dark', preview: 'dark' },
  { name: 'AMOLED black', preview: 'black' },
  { name: 'Light', preview: 'light' },
  { name: 'Auto', preview: 'auto' },
];

const accents: { label: string; color: string }[] = [
  { label: 'Accent cyan', color: colors.accent },
  { label: 'Accent violet', color: colors.violet },
  { label: 'Accent pink', color: colors.like },
  { label: 'Accent amber', color: colors.amber },
  { label: 'Accent blue', color: colors.info },
  { label: 'Accent green', color: colors.success },
];

function Preview({ kind }: { kind: ThemeOpt['preview'] }) {
  const bg = kind === 'dark' ? colors.bg : kind === 'black' ? colors.black : colors.paper;
  return (
    <View style={{ height: 64, borderRadius: 10, backgroundColor: bg, overflow: 'hidden' }}>
      {kind === 'auto' ? (
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '50%', backgroundColor: colors.bg }} />
      ) : null}
      <View style={{ position: 'absolute', left: 8, top: 8, width: 36, height: 6, borderRadius: 3, backgroundColor: colors.accent }} />
      <View style={{ position: 'absolute', left: 8, top: 20, width: 56, height: 6, borderRadius: 3, backgroundColor: colors.accent, opacity: 0.5 }} />
    </View>
  );
}

const themeIndex = (v: string | undefined) => Math.max(0, themes.findIndex((t) => t.preview === v));
const accentIndex = (v: string | undefined) => Math.max(0, accents.findIndex((a) => a.color.toLowerCase() === (v ?? '').toLowerCase()));

export default function Theme() {
  const { settings, updateSettings } = useAuth();
  const [theme, setTheme] = useState(() => themeIndex(settings?.theme));
  const [accent, setAccent] = useState(() => accentIndex(settings?.accent));
  const [error, setError] = useState<string | null>(null);
  const [matchArt, setMatchArt] = useDevicePref('matchAlbumArt', true);
  const [compact, setCompact] = useDevicePref('compactMode', false);
  // Same key the UI kit's useReduceMotion / reduceMotionNow read, so it applies app-wide immediately.
  const [reduceMotion, setReduceMotion] = usePref('reduceMotion', false);

  // Pick up the saved theme/accent once settings arrive (adjust state during render, not in an effect).
  const settingsReady = !!settings;
  const [synced, setSynced] = useState(settingsReady);
  if (settings && !synced) {
    setSynced(true);
    setTheme(themeIndex(settings.theme));
    setAccent(accentIndex(settings.accent));
  }

  const save = (patch: Partial<Settings>) => {
    setError(null);
    updateSettings(patch).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not save your theme'));
  };

  return (
    <Screen
      top={4}
      gap={16}
      backdrop={{
        pattern: 'dots',
        mesh: 'none',
        glows: [
          { x: 0.5, y: 0, color: colors.violet, opacity: 0.34 },
          { x: 0, y: 0.6, color: colors.accent, opacity: 0.22 },
        ],
      }}
    >
      <ScreenHeader title="Display and theme" />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {themes.map((t, i) => {
          const on = i === theme;
          return (
            <Tap
              key={t.name}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${t.name} theme`}
              onPress={() => {
                setTheme(i);
                save({ theme: t.preview });
              }}
              style={{
                width: '47%',
                flexGrow: 1,
                borderRadius: 26,
                backgroundColor: colors.bgSecondary,
                borderWidth: on ? 2 : 1,
                borderColor: on ? colors.accentLight : colors.border,
                padding: on ? 11 : 12,
                gap: 10,
              }}
            >
              <Preview kind={t.preview} />
              <T size={14} weight={600}>
                {t.name}
              </T>
            </Tap>
          );
        })}
      </View>

      <SectionHeader title="Accent color" />
      <Row gap={12} style={{ flexWrap: 'wrap' }}>
        {accents.map((a, i) => {
          const on = i === accent;
          return (
            <Tap
              key={a.label}
              accessibilityRole="radio"
              accessibilityLabel={a.label}
              accessibilityState={{ selected: on }}
              onPress={() => {
                setAccent(i);
                save({ accent: a.color });
              }}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: a.color,
                borderWidth: on ? 3 : 0,
                borderColor: colors.text,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {on ? <Icon name="check" size={18} color={colors.onAccent} /> : null}
            </Tap>
          );
        })}
      </Row>
      <T size={12} color={colors.textSecondary} lineHeight={17}>
        Theme and accent are saved to your account. The app-wide theming switch arrives in a later update.
      </T>
      {error ? (
        <T size={13} color={colors.error}>
          {error}
        </T>
      ) : null}

      <Glass padding={4}>
        <ListRow title="Match album art" subtitle="Accent follows the playing cover" minHeight={64} right={<Toggle value={matchArt} onChange={setMatchArt} label="Match album art" />} />
      </Glass>

      <Glass padding={4}>
        <ListRow title="Text size, bold text and contrast" subtitle="Accessibility settings" icon="sliders" minHeight={64} href="/accessibility" />
      </Glass>

      <Glass padding={4}>
        <ListRow title="Compact mode" minHeight={56} right={<Toggle value={compact} onChange={setCompact} label="Compact mode" />} />
        <ListRow title="Reduce motion" subtitle="Calmer animations" minHeight={56} divider right={<Toggle value={reduceMotion} onChange={setReduceMotion} label="Reduce motion" />} />
      </Glass>
    </Screen>
  );
}
