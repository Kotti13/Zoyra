import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Sheet, T, Tap, Toggle } from '../components';
import { formatDuration } from '../lib/catalog';
import { usePlayerPick, type SleepTimer } from '../state/player';
import { colors, fonts, withAlpha } from '../theme/tokens';

const options: { label: string; value: number | 'endOfTrack' | 'custom' }[] = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '45 min', value: 45 },
  { label: '1 hr', value: 60 },
  { label: 'End of track', value: 'endOfTrack' },
  { label: 'Custom', value: 'custom' },
];

/** "mm:ss" left on the active timer, ticking every second. */
function useCountdown(sleep: SleepTimer) {
  const [now, setNow] = useState(() => Date.now());
  const timed = !!sleep && 'endsAt' in sleep;
  useEffect(() => {
    if (!timed) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0); // refresh right away when a new timer starts
    const id = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [timed, sleep]);
  if (!sleep) return null;
  if ('endOfTrack' in sleep) return 'after this song';
  return `in ${formatDuration(Math.max(0, (sleep.endsAt - now) / 1000))}`;
}

const initialFor = (sleep: SleepTimer) => {
  if (!sleep) return 1;
  if ('endOfTrack' in sleep) return 4;
  const i = options.findIndex((o) => o.value === sleep.minutes);
  return i === -1 ? 5 : i;
};

export default function SleepSheet() {
  const { sleep, setSleepTimer } = usePlayerPick('sleep');
  const countdown = useCountdown(sleep);
  const [sel, setSel] = useState(() => initialFor(sleep));
  const [customMin, setCustomMin] = useState(() => (sleep && 'minutes' in sleep ? String(sleep.minutes) : '20'));
  const [fade, setFade] = useState(() => sleep?.fadeOut ?? true);

  const custom = options[sel].value === 'custom';
  const customValue = Math.round(Number(customMin));
  const customOk = Number.isFinite(customValue) && customValue >= 1 && customValue <= 600;

  const start = () => {
    const v = options[sel].value;
    if (v === 'custom') {
      if (!customOk) return;
      setSleepTimer(customValue, { fadeOut: fade });
    } else setSleepTimer(v, { fadeOut: fade });
    router.back();
  };

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Sleep timer
      </T>
      {countdown ? (
        <T size={14} color={colors.accentLight} style={{ marginTop: -6 }}>
          {`Music stops ${countdown}`}
        </T>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {options.map((o, i) => {
          const on = i === sel;
          return (
            <Tap
              key={o.label}
              onPress={() => setSel(i)}
              accessibilityState={{ selected: on }}
              style={[
                { width: '31%', flexGrow: 1, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
                on
                  ? { borderWidth: 2, borderColor: colors.accentLight, backgroundColor: withAlpha(colors.accent, 0.25) }
                  : { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgTertiary },
              ]}
            >
              <T size={15} weight={600} numberOfLines={1}>
                {o.label}
              </T>
            </Tap>
          );
        })}
      </View>

      {custom ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}>
          <T size={16} weight={500} style={{ flex: 1 }}>
            Minutes
          </T>
          <TextInput
            value={customMin}
            onChangeText={(v) => setCustomMin(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            maxLength={3}
            accessibilityLabel="Custom minutes"
            style={{ width: 80, height: 44, borderRadius: 22, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 16, textAlign: 'center' }}
          />
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={16} weight={500}>
            Fade out
          </T>
          <T size={14} color={colors.textSecondary}>
            {fade ? 'Volume lowers over the last 30 seconds' : 'Off — music stops at full volume'}
          </T>
        </View>
        <Toggle value={fade} onChange={setFade} label="Fade out" />
      </View>

      <Button label={sleep ? 'Update timer' : 'Start timer'} variant={custom && !customOk ? 'disabled' : 'primary'} onPress={start} />
      {sleep ? (
        <Button
          label="Cancel timer"
          variant="secondary"
          onPress={() => {
            setSleepTimer(null);
            router.back();
          }}
        />
      ) : null}
    </Sheet>
  );
}
