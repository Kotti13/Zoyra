import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import Svg, { Circle, Defs, LinearGradient as SvgGradient, Stop } from 'react-native-svg';

import { Cover, Glass, Icon, IconButton, Row, Screen, T, Tap, Toggle } from '../components';
import { IconChip } from '../components/settings-ui';
import { formatDuration } from '../lib/catalog';
import { usePlayerPick, type SleepTimer } from '../state/player';
import { colors, fonts, withAlpha } from '../theme/tokens';

const backdrop = {
  pattern: 'dots' as const,
  mesh: 'none' as const,
  glows: [
    { x: 0, y: 0, color: colors.accent, opacity: 0.4 },
    { x: 1, y: 0.35, color: colors.amber, opacity: 0.22 },
  ],
};

type Opt = { big: string; small: string; value: number | 'endOfTrack' | 'custom' };

const options: Opt[] = [
  { big: '15', small: 'min', value: 15 },
  { big: '30', small: 'min', value: 30 },
  { big: '45', small: 'min', value: 45 },
  { big: '60', small: 'min', value: 60 },
  { big: 'End', small: 'of track', value: 'endOfTrack' },
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

  const total = sleep && 'minutes' in sleep ? sleep.minutes * 60 : 0;
  const progress = remaining !== null && total > 0 ? Math.min(1, remaining / total) : 0;
  const R = 94;
  const C = 2 * Math.PI * R;

  return (
    <Screen top={4} gap={14} backdrop={backdrop} contentStyle={{ flexGrow: 1 }}>
      <Row gap={10}>
        <IconButton icon="back" label="Back" href="back" />
        {track ? <Cover artwork={track.artwork} id={track.id} size={44} radius={22} /> : <IconChip icon="moon" size={44} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={17} weight={700} accessibilityRole="header" numberOfLines={1}>
            Sleep timer
          </T>
          <T size={12} color={colors.accentLight} numberOfLines={1}>
            Music stops automatically
          </T>
        </View>
      </Row>

      {/* Countdown ring */}
      <View style={{ width: 210, height: 210, alignSelf: 'center' }}>
        <Svg width={210} height={210} style={{ transform: [{ rotate: '-90deg' }] }}>
          <Defs>
            <SvgGradient id="sg" x1="0" x2="1" y1="0" y2="0">
              <Stop offset="0" stopColor={colors.amber} />
              <Stop offset="1" stopColor={colors.accent} />
            </SvgGradient>
          </Defs>
          <Circle cx={105} cy={105} r={R} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={10} />
          {progress > 0 ? <Circle cx={105} cy={105} r={R} fill="none" stroke="url(#sg)" strokeWidth={10} strokeLinecap="round" strokeDasharray={`${C}`} strokeDashoffset={C * (1 - progress)} /> : null}
        </Svg>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          <Icon name="moon" size={22} color={colors.accentLight} />
          <T mono={remaining !== null} weight={500} size={remaining !== null ? 40 : 28} tracking={-1} accessibilityLabel={a11y}>
            {countdown}
          </T>
          <T size={12} color={colors.textSecondary}>
            {sleep ? 'until music stops' : track ? 'no timer set' : 'Nothing is playing'}
          </T>
        </View>
      </View>

      {/* Duration grid */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {options.map((o, i) => {
          const on = i === sel;
          const inner = (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
              <T size={18} weight={700} color={on ? colors.onAccent : colors.text}>
                {o.value === 'custom' && sleep && 'minutes' in sleep && sel === 5 && !custom ? String(sleep.minutes) : o.big}
              </T>
              <T size={11} weight={500} color={on ? colors.onAccent : colors.text} style={{ opacity: 0.8 }}>
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
              style={{ width: '31%', flexGrow: 1, height: 62 }}
            >
              {on ? (
                <View style={{ flex: 1, borderRadius: 28, backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.4, shadowRadius: 22, shadowOffset: { width: 0, height: 8 } }}>{inner}</View>
              ) : (
                <Glass radius={28} style={{ flex: 1 }}>{inner}</Glass>
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingHorizontal: 12 }}>
          <IconChip icon="sliders" size={38} bg={withAlpha(colors.white, 0.08)} color={colors.text} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600}>
              Fade out
            </T>
            <T size={12} color={colors.textSecondary}>
              {fade ? 'Lower volume in the last 30 seconds' : 'Off — music stops at full volume'}
            </T>
          </View>
          <Toggle value={fade} onChange={setFade} label="Fade out" />
        </View>
      </Glass>

      <View style={{ flex: 1 }} />
      <Tap
        onPress={sleep ? () => setSleepTimer(null) : undefined}
        href={sleep ? undefined : 'back'}
        accessibilityRole="button"
        accessibilityLabel={sleep ? 'Cancel timer' : 'Close'}
        style={{ height: 50, borderRadius: 25, borderWidth: 1.5, borderColor: withAlpha(colors.accent, 0.6), alignItems: 'center', justifyContent: 'center' }}
      >
        <T size={16} weight={700} color={colors.accentLight}>
          {sleep ? 'Cancel timer' : 'Close'}
        </T>
      </Tap>
    </Screen>
  );
}
