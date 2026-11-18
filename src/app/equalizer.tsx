import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';

import { Button, ChipRow, Glass, Row, Screen, ScreenHeader, T, Toast, Toggle } from '../components';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const BANDS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
const FLAT = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50];

/** Band levels in % of the slider height (50 = 0 dB). */
const presets: { name: string; levels: number[] }[] = [
  { name: 'Custom', levels: [55, 60, 58, 52, 48, 50, 55, 60, 62, 58] },
  { name: 'Bass Boost', levels: [55, 65, 72, 50, 40, 50, 58, 68, 74, 62] },
  { name: 'Rock', levels: [66, 60, 54, 46, 44, 50, 60, 66, 70, 68] },
  { name: 'Pop', levels: [44, 50, 58, 64, 66, 62, 56, 50, 46, 44] },
  { name: 'Jazz', levels: [60, 56, 52, 56, 46, 46, 50, 56, 60, 62] },
  { name: 'Classical', levels: [62, 58, 54, 50, 46, 46, 50, 58, 64, 68] },
];

const TRACK_H = 180;

const toDb = (pct: number) => Math.round(((pct - 50) / 50) * 12);
const fromDb = (db: number) => Math.min(100, Math.max(0, Math.round(50 + (db / 12) * 50)));

/** Saved preset name → chip index (unknown names such as the default "Flat" show as Custom). */
const presetIndex = (name: string | undefined) => Math.max(0, presets.findIndex((p) => p.name === name));
const levelsFrom = (bands: number[] | undefined) => (bands && bands.length === BANDS.length ? bands.map(fromDb) : FLAT);

function BandSlider({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const set = (e: GestureResponderEvent) => {
    const y = Math.min(Math.max(e.nativeEvent.locationY, 0), TRACK_H);
    onChange(Math.round(100 - (y / TRACK_H) * 100));
  };
  const db = toDb(value);
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 8, opacity: disabled ? 0.4 : 1 }}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`${label} hertz`}
        accessibilityValue={{ min: -12, max: 12, now: db, text: `${db > 0 ? '+' : ''}${db} dB` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment') onChange(Math.min(100, value + 5));
          if (e.nativeEvent.actionName === 'decrement') onChange(Math.max(0, value - 5));
        }}
        pointerEvents={disabled ? 'none' : 'box-only'}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={set}
        onResponderMove={set}
        style={{ width: 32, height: TRACK_H, alignItems: 'center' }}
      >
        <View style={{ position: 'absolute', top: 0, bottom: 0, width: 4, borderRadius: 2, backgroundColor: colors.track }} />
        <LinearGradient
          colors={[colors.amber, colors.accent]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={{ position: 'absolute', bottom: 0, width: 4, borderRadius: 2, height: `${value}%` }}
        />
        <View style={{ position: 'absolute', bottom: `${value}%`, marginBottom: -8, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.white }} />
      </View>
      <T mono size={10} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
}

export default function Equalizer() {
  const { settings, updateSettings } = useAuth();
  const [on, setOn] = useState(settings?.equalizer.enabled ?? false);
  const [preset, setPreset] = useState(() => presetIndex(settings?.equalizer.preset));
  const [levels, setLevels] = useState<number[]>(() => levelsFrom(settings?.equalizer.bands));
  const [chipKey, setChipKey] = useState(0);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  // Sync once if settings arrive after mount.
  const settingsReady = !!settings;
  useEffect(() => {
    if (!settings) return;
    setOn(settings.equalizer.enabled);
    setPreset(presetIndex(settings.equalizer.preset));
    setLevels(levelsFrom(settings.equalizer.bands));
    setChipKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsReady]);

  const state = useRef({ on, preset, levels });
  state.current = { on, preset, levels };

  const write = useCallback(
    (eq: { on: boolean; preset: number; levels: number[] }, saved?: boolean) => {
      updateSettings({ equalizer: { enabled: eq.on, preset: presets[eq.preset].name, bands: eq.levels.map(toDb) } })
        .then(() => saved && setNote({ ok: true, text: 'Equalizer profile saved' }))
        .catch((e: unknown) => setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save the equalizer' }));
    },
    [updateSettings],
  );
  const writeRef = useRef(write);
  writeRef.current = write;

  // Debounced band writes while dragging; flushed on unmount.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (dirty.current) {
      dirty.current = false;
      writeRef.current(state.current);
    }
  }, []);
  useEffect(() => flush, [flush]);
  const schedule = () => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };

  const toggle = (v: boolean) => {
    setOn(v);
    write({ ...state.current, on: v });
  };

  const choosePreset = (i: number) => {
    setPreset(i);
    setLevels(presets[i].levels);
    write({ ...state.current, preset: i, levels: presets[i].levels });
  };

  const setBand = (band: number, v: number) => {
    setLevels((l) => {
      const next = l.map((x, i) => (i === band ? v : x));
      state.current = { ...state.current, preset: 0, levels: next };
      return next;
    });
    if (preset !== 0) {
      setPreset(0);
      setChipKey((k) => k + 1);
    }
    schedule();
  };

  return (
    <Screen
      top={4}
      gap={16}
      backdrop={{ pattern: 'grid', mesh: 'coral' }}
    >
      <ScreenHeader title="Equalizer" right={<Toggle value={on} onChange={toggle} label="Equalizer on" />} />

      <ChipRow key={chipKey} options={presets.map((p) => p.name)} initial={preset} onChange={choosePreset} />

      <Glass padding={16}>
        <Row style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <T mono size={12} color={colors.textSecondary}>
            +12 dB
          </T>
          <T mono size={12} color={colors.textSecondary}>
            0
          </T>
          <T mono size={12} color={colors.textSecondary}>
            -12 dB
          </T>
        </Row>
        <View style={styles.bands}>
          {BANDS.map((b, i) => (
            <BandSlider key={b} label={b} value={levels[i]} disabled={!on} onChange={(v) => setBand(i, v)} />
          ))}
        </View>
      </Glass>

      <Row gap={12}>
        <Button
          label="Reset"
          variant="glass"
          style={{ flex: 1 }}
          onPress={() => {
            setLevels(FLAT);
            setPreset(0);
            setChipKey((k) => k + 1);
            write({ ...state.current, preset: 0, levels: FLAT });
          }}
        />
        <Button
          label="Save profile"
          variant="glass"
          icon="plus"
          style={{ flex: 1 }}
          onPress={() => {
            dirty.current = false;
            if (timer.current) clearTimeout(timer.current);
            write(state.current, true);
          }}
        />
      </Row>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}

      <T size={12} color={colors.textSecondary} align="center" lineHeight={17}>
        Your bands are saved to your account and will shape playback once the native audio engine ships.
      </T>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bands: { flexDirection: 'row', gap: 2, justifyContent: 'space-between' },
});
