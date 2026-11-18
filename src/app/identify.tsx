import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Linking, View } from 'react-native';

import { Button, Icon, IconButton, Row, Screen, T, Tap, useReduceMotion } from '../components';
import { useIdentify, type IdentifyMode } from '../lib/identify';
import { colors, withAlpha } from '../theme/tokens';

const MODES: { key: IdentifyMode; label: string; idle: string; hint: string }[] = [
  { key: 'listen', label: 'Listen', idle: 'Tap to listen', hint: 'Hold your phone near the music' },
  { key: 'hum', label: 'Hum or sing', idle: 'Tap, then hum or sing', hint: 'Hum or sing a few lines, about 12 seconds' },
];

/**
 * Identify song (`/identify[?mode=hum]`). Records a short clip, asks the server to match it and opens the
 * result. Nothing is stored; the clip is deleted as soon as it is sent.
 */
export default function Identify() {
  const params = useLocalSearchParams<{ mode?: string; auto?: string }>();
  const [mode, setMode] = useState<IdentifyMode>(params.mode === 'hum' ? 'hum' : 'listen');
  const { st, busy, start, cancel } = useIdentify((m, used) => {
    router.replace({
      pathname: '/identify-result',
      params: { title: m.title, artist: m.artist, ...(m.album ? { album: m.album } : {}), ...(m.isrc ? { isrc: m.isrc } : {}), ...(m.offsetMs !== undefined ? { offsetMs: String(m.offsetMs) } : {}), ...(m.score !== undefined ? { score: String(m.score) } : {}), mode: used },
    });
  });
  const cur = MODES.find((m) => m.key === mode) ?? MODES[0];

  // "What is playing?" opens this screen with ?auto=1 to start listening straight away.
  const auto = params.auto === '1';
  const started = useRef(false);
  useEffect(() => {
    if (!auto || started.current) return;
    started.current = true;
    void start('listen');
  }, [auto, start]);

  const status =
    st.state === 'listening' ? `${mode === 'hum' ? 'Listening to you' : 'Listening'}… ${st.left}s` : st.state === 'identifying' ? 'Finding your song…' : st.state === 'nomatch' ? 'No match' : st.state === 'error' ? 'Could not identify' : cur.idle;
  const sub =
    st.state === 'nomatch'
      ? mode === 'hum'
        ? 'Try humming the chorus a little louder and steadier.'
        : 'Try again closer to the music, away from other noise.'
      : st.state === 'error'
        ? st.message
        : cur.hint;

  return (
    <Screen top={4} gap={20} scroll={false} backdrop={{ pattern: 'dots', mesh: 'coral' }} contentStyle={{ flex: 1 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="close" label="Close" glass onPress={() => (router.canGoBack() ? router.back() : router.replace('/search'))} />
        <T size={15} weight={600} accessibilityRole="header">
          Identify
        </T>
        <View style={{ width: 44 }} />
      </Row>

      <Row gap={8} style={{ justifyContent: 'center' }}>
        {MODES.map((m) => {
          const on = m.key === mode;
          return (
            <Tap
              key={m.key}
              disabled={busy}
              onPress={() => setMode(m.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: busy }}
              style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: on ? colors.accent : withAlpha(colors.white, 0.06), borderWidth: on ? 0 : 1, borderColor: withAlpha(colors.white, 0.12) }}
            >
              <T size={13} weight={600}>
                {m.label}
              </T>
            </Tap>
          );
        })}
      </Row>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Ripples active={busy && st.state === 'listening'} />
        <Tap
          onPress={() => (busy ? undefined : void start(mode))}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={busy ? status : mode === 'hum' ? 'Start humming search' : 'Start listening'}
          accessibilityState={{ busy }}
          pressScale={0.95}
          style={{ width: 132, height: 132, borderRadius: 66, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', opacity: st.state === 'identifying' ? 0.75 : 1 }}
        >
          <Icon name="mic" size={54} color={colors.white} />
        </Tap>
      </View>

      <View style={{ alignItems: 'center', gap: 8, paddingBottom: 12 }}>
        <T size={22} weight={300} accessibilityLiveRegion="polite" align="center">
          {status}
        </T>
        <T size={13} color={st.state === 'error' ? colors.error : colors.textSecondary} align="center" style={{ maxWidth: 300 }}>
          {sub}
        </T>
        {busy ? (
          <Button label="Cancel" variant="secondary" onPress={cancel} style={{ marginTop: 8, minWidth: 160 }} />
        ) : st.state === 'error' && st.settings ? (
          <Button label="Open Settings" variant="secondary" onPress={() => void Linking.openSettings()} style={{ marginTop: 8, minWidth: 160 }} />
        ) : st.state === 'nomatch' || st.state === 'error' ? (
          <Button label="Try again" onPress={() => void start(mode)} style={{ marginTop: 8, minWidth: 160 }} />
        ) : null}
      </View>
    </Screen>
  );
}

/** Three staggered rings expanding from the mic while listening. */
function Ripples({ active }: { active: boolean }) {
  const reduce = useReduceMotion();
  const [vals] = useState(() => [new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]);
  useEffect(() => {
    if (!active || reduce) return;
    const loops = vals.map((v, i) => {
      v.setValue(0);
      return Animated.loop(Animated.sequence([Animated.delay(i * 900), Animated.timing(v, { toValue: 1, duration: 2800, easing: Easing.out(Easing.quad), useNativeDriver: true })]));
    });
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, reduce, vals]);
  if (!active) return null;
  return (
    <>
      {vals.map((v, i) => (
        <Animated.View
          key={i}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: 120,
            height: 120,
            borderRadius: 60,
            borderWidth: 2,
            borderColor: colors.accent,
            opacity: reduce ? 0.35 : v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: reduce ? 1.4 + i * 0.4 : v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 2.6] }) }],
          }}
        />
      ))}
    </>
  );
}
