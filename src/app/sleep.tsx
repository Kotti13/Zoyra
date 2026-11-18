import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Glass, Screen, ScreenHeader, T, Tap, Toggle } from '../components';
import { formatDuration } from '../lib/catalog';
import { usePlayerPick, type SleepTimer } from '../state/player';
import { colors, fonts } from '../theme/tokens';

type Opt = { big: string; small: string; value: number | 'endOfTrack' | 'custom' };

const options: Opt[] = [
  { big: '15', small: 'min', value: 15 },
  { big: '30', small: 'min', value: 30 },
  { big: '45', small: 'min', value: 45 },
  { big: '60', small: 'min', value: 60 },
  { big: 'After', small: 'this song', value: 'endOfTrack' },
  { big: 'Custom', small: 'set time', value: 'custom' },
];

/** Seconds left on a minutes timer, ticking every second. */
function useRemaining(sleep: SleepTimer) {
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
  return sleep && 'endsAt' in sleep ? Math.max(0, (sleep.endsAt - now) / 1000) : null;
}

const selectedFor = (sleep: SleepTimer) => {
  if (!sleep) return -1;
  if ('endOfTrack' in sleep) return 4;
  const i = options.findIndex((o) => o.value === sleep.minutes);
  return i === -1 ? 5 : i;
};

export default function Sleep() {
  const { sleep, setSleepTimer, setSleepFade, track } = usePlayerPick('track', 'sleep');
  const remaining = useRemaining(sleep);
  const [custom, setCustom] = useState(false);
  const [customMin, setCustomMin] = useState('20');
  const [fade, setFadeState] = useState(() => sleep?.fadeOut ?? true);
  const setFade = (on: boolean) => {
    setFadeState(on);
    if (sleep) setSleepFade(on); // applies to the running timer without restarting it
  };
  const sel = custom ? 5 : selectedFor(sleep);

  const countdown = remaining !== null ? formatDuration(remaining) : sleep ? 'After this song' : 'Off';
  const a11y =
    remaining !== null
      ? `${Math.floor(remaining / 60)} minutes ${Math.floor(remaining % 60)} seconds remaining`
      : sleep
        ? 'Music stops at the end of this track'
        : 'No sleep timer set';

  const applyCustom = () => {
    const m = Math.round(Number(customMin));
    if (!Number.isFinite(m) || m < 1 || m > 600) return;
    setSleepTimer(m, { fadeOut: fade });
    setCustom(false);
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'peach' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Sleep timer" />

      {/* Countdown */}
      <Glass padding={16}>
        <View style={{ alignItems: 'center', gap: 6, paddingVertical: 12 }}>
          <T size={12} weight={400} tracking={0.5} color={colors.textSecondary}>
            {sleep ? (remaining !== null ? 'MUSIC STOPS IN' : 'MUSIC STOPS') : 'SLEEP TIMER'}
          </T>
          <T mono={remaining !== null} weight={500} size={remaining !== null ? 48 : 36} tracking={-1} accessibilityLabel={a11y}>
            {countdown}
          </T>
          {!track ? (
            <T size={12} color={colors.textSecondary}>
              Nothing is playing right now.
            </T>
          ) : null}
        </View>
      </Glass>

      {/* Duration grid */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {options.map((o, i) => {
          const on = i === sel;
          const inner = (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
              <T size={24} weight={700} color={on ? colors.onAccent : colors.text}>
                {o.value === 'custom' && sleep && 'minutes' in sleep && sel === 5 && !custom ? String(sleep.minutes) : o.big}
              </T>
              <T size={12} color={on ? colors.onAccent : colors.text} style={{ opacity: 0.8 }}>
                {o.value === 'custom' && sleep && 'minutes' in sleep && sel === 5 && !custom ? 'min' : o.small}
              </T>
            </View>
          );
          return (
            <Tap
              key={o.big}
              onPress={() => {
                if (o.value === 'custom') setCustom(true);
                else {
                  setCustom(false);
                  setSleepTimer(o.value, { fadeOut: fade });
                }
              }}
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.value === 'endOfTrack' ? 'Stop after this song' : `${o.big} ${o.small}`}
              style={{ width: '31%', flexGrow: 1, height: 88 }}
            >
              {on ? (
                <View style={{ flex: 1, borderRadius: 26, backgroundColor: colors.accent }}>{inner}</View>
              ) : (
                <Glass style={{ flex: 1 }}>{inner}</Glass>
              )}
            </Tap>
          );
        })}
      </View>

      {custom ? (
        <Glass padding={4}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 12 }}>
            <T size={16} weight={500} style={{ flex: 1 }}>
              Minutes
            </T>
            <TextInput
              value={customMin}
              onChangeText={(v) => setCustomMin(v.replace(/[^0-9]/g, ''))}
              keyboardType="number-pad"
              maxLength={3}
              autoFocus
              accessibilityLabel="Custom minutes"
              onSubmitEditing={applyCustom}
              style={{ width: 72, height: 44, borderRadius: 22, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 16, textAlign: 'center' }}
            />
            <Tap onPress={applyCustom} style={{ height: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
              <T size={15} weight={600} color={colors.accentLight}>
                Set
              </T>
            </Tap>
          </View>
        </Glass>
      ) : null}

      {/* Fade out */}
      <Glass padding={4}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68, paddingHorizontal: 12 }}>
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
      </Glass>

      <View style={{ flex: 1 }} />
      <Button
        label={sleep ? 'Cancel timer' : 'Close'}
        variant="secondary"
        onPress={sleep ? () => setSleepTimer(null) : undefined}
        href={sleep ? undefined : 'back'}
      />
    </Screen>
  );
}
