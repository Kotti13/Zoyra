import { useCallback, useEffect, useRef, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';

import { Glass, ListRow, Row, Screen, ScreenHeader, T } from '../components';
import { useAuth, type Settings } from '../state/auth';
import { colors } from '../theme/tokens';

const MAX = 12;

/** Horizontal slider: 4px track, accent fill, 16px white thumb. Drag or tap to set. */
function CrossfadeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [width, setWidth] = useState(0);
  const pct = value / MAX;
  const set = (e: GestureResponderEvent) => {
    if (!width) return;
    const x = Math.min(Math.max(e.nativeEvent.locationX, 0), width);
    onChange(Math.round((x / width) * MAX));
  };
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Smooth transition length"
      accessibilityValue={{ min: 0, max: MAX, now: value, text: value ? `${value} seconds` : 'Off' }}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(Math.min(MAX, value + 1));
        if (e.nativeEvent.actionName === 'decrement') onChange(Math.max(0, value - 1));
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      pointerEvents="box-only"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={set}
      onResponderMove={set}
      style={{ height: 32, justifyContent: 'center' }}
    >
      <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.track }} />
      <View style={{ position: 'absolute', left: 0, width: `${pct * 100}%`, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
      <View style={{ position: 'absolute', left: `${pct * 100}%`, marginLeft: -8, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.white }} />
    </View>
  );
}

export default function AudioSettings() {
  const { settings, updateSettings } = useAuth();
  const [error, setError] = useState<string | null>(null);
  /** Value being dragged/saved; falls back to the saved setting. */
  const [draft, setDraft] = useState<number | null>(null);
  const crossfade = draft ?? settings?.crossfade_seconds ?? 0;

  const save = useCallback(
    (patch: Partial<Settings>) => {
      setError(null);
      updateSettings(patch).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not save your settings'));
    },
    [updateSettings],
  );

  // Debounced crossfade write; flushes on unmount so a last drag is never lost.
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current !== null) {
      saveRef.current({ crossfade_seconds: pending.current });
      pending.current = null;
    }
  }, []);
  useEffect(() => flush, [flush]);
  const changeCrossfade = (v: number) => {
    if (v === crossfade) return;
    setDraft(v);
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };

  const eq = settings?.equalizer;

  return (
    <Screen
      top={4}
      gap={16}
      backdrop={{
        pattern: 'lines',
        mesh: 'amber',
      }}
    >
      <ScreenHeader title="Audio" />

      {/*
        The catalogue's stream endpoint (Audius GET /v1/tracks/{id}/stream) takes no bitrate or quality
        parameter and always serves a 320 kbps MP3, so per-network quality pickers would do nothing.
      */}
      <Glass padding={16}>
        <View style={{ gap: 6 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={16} weight={500}>
              Streaming and download quality
            </T>
            <T mono size={14}>
              320 kbps
            </T>
          </Row>
          <T size={13} color={colors.textSecondary} lineHeight={18}>
            Every song streams and downloads as a 320 kbps MP3, on Wi-Fi and on cellular. Our music source does not offer other bitrates, so there is no quality to pick yet. Downloaded songs use no data when played.
          </T>
        </View>
      </Glass>
      {error ? (
        <T size={13} color={colors.error}>
          {error}
        </T>
      ) : null}

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={16} weight={500}>
              Smooth transition
            </T>
            <T mono size={14}>
              {crossfade} s
            </T>
          </Row>
          <CrossfadeSlider value={crossfade} onChange={changeCrossfade} />
          <Row style={{ justifyContent: 'space-between' }}>
            <T mono size={12} color={colors.textSecondary}>
              Off
            </T>
            <T mono size={12} color={colors.textSecondary}>
              12 s
            </T>
          </Row>
          <T size={13} color={colors.textSecondary} lineHeight={18}>
            {crossfade > 0
              ? `Each song fades out over its last ${crossfade} s and the next fades in over its first ${crossfade} s. Songs don't overlap: this is a fade between tracks, not a true crossfade.`
              : 'Off. Songs change without fading.'}
          </T>
        </View>
      </Glass>

      <Glass padding={4}>
        <ListRow title="Gapless playback" subtitle="Always on — the next song is queued ahead" minHeight={56} />
        <ListRow title="Playback settings" subtitle="Smooth transitions, autoplay, resume" minHeight={56} divider href="/playback-settings" />
        <ListRow title="Volume normalizing and mono audio" subtitle="Not available in this version: they need a native audio engine" minHeight={56} divider right={false} />
        <ListRow title="Equalizer" subtitle={eq?.enabled ? `${eq.preset}, 10 band` : 'Off'} minHeight={56} divider href="/equalizer" />
      </Glass>
    </Screen>
  );
}
