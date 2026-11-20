import { useCallback, useEffect, useRef, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';

import { Glass, ListRow, Row, Screen, ScreenHeader, T, Toggle } from '../components';
import { SectionLabel } from '../components/settings-ui';
import { usePlayPref } from '../lib/play-prefs';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const MAX = 12;

/** Horizontal slider: 4 px track, accent fill, 16 px white thumb. Drag or tap to set whole seconds. */
function SecondsSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(Math.min(MAX, value + 1));
        if (e.nativeEvent.actionName === 'decrement') onChange(Math.max(0, value - 1));
      }}
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

/** One honest line for a feature this version can't do. */
function Note({ children }: { children: string }) {
  return (
    <T size={12} color={colors.textTertiary} lineHeight={17} style={{ paddingHorizontal: 4 }}>
      {children}
    </T>
  );
}

/**
 * Settings › Playback. Smooth transition (account setting `crossfade_seconds`), Autoplay similar and
 * Resume where I left off (device prefs, implemented in the player). Everything here changes real behaviour.
 */
export default function PlaybackSettings() {
  const { settings, updateSettings } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const saved = Math.max(0, Math.min(MAX, settings?.crossfade_seconds ?? 0));
  const crossfade = draft ?? saved;
  const [autoplay, setAutoplay] = usePlayPref('playback.autoplaySimilar');
  const [resume, setResume] = usePlayPref('playback.resume');
  const [, setLastSession] = usePlayPref('playback.lastSession');

  // Debounced write of the slider; flushed on unmount so the last drag is never lost.
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateRef = useRef(updateSettings);
  useEffect(() => {
    updateRef.current = updateSettings;
  }, [updateSettings]);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    if (v === null) return;
    pending.current = null;
    setError(null);
    updateRef.current({ crossfade_seconds: v })
      .then(() => setDraft(null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not save the transition length'));
  }, []);
  useEffect(() => flush, [flush]);

  const change = (v: number) => {
    if (v === crossfade) return;
    setDraft(v);
    pending.current = v;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };
  const toggleCrossfade = (on: boolean) => {
    const v = on ? crossfade || 5 : 0;
    setDraft(v);
    pending.current = v;
    flush();
  };
  const toggleResume = (on: boolean) => {
    setResume(on);
    if (!on) setLastSession(null); // forget the saved queue right away
  };

  const fadeOn = crossfade > 0;

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Playback" />
      {error ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      <View style={{ gap: 8 }}>
        <View style={{ gap: 8 }}>
        <SectionLabel>Transitions</SectionLabel>
        <Glass padding={4}>
          <ListRow
            title="Smooth transition"
            subtitle="Fade the end of one track into the next"
            minHeight={64}
            right={<Toggle value={fadeOn} onChange={toggleCrossfade} label="Smooth transition" />}
          />
          {fadeOn ? (
            <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 4 }}>
              <SecondsSlider value={crossfade} onChange={change} />
              <Row style={{ justifyContent: 'space-between' }}>
                <T mono size={12} color={colors.textSecondary}>
                  0 s
                </T>
                <T mono size={12} color={colors.text}>
                  {crossfade} s
                </T>
                <T mono size={12} color={colors.textSecondary}>
                  12 s
                </T>
              </Row>
            </View>
          ) : null}
          <ListRow title="Gapless playback" subtitle="Always on: the next track is queued natively" minHeight={64} divider right={false} />
        </Glass>
      </View>
        <Note>
          {fadeOn
            ? `Each song fades out over its last ${crossfade} s and the next fades in over its first ${crossfade} s. Songs don't overlap, so this is a smooth fade, not a true crossfade.`
            : 'Off: songs change without fading.'}
        </Note>
        <Note>Automix, volume normalising, mono audio and skip silence need an audio engine this version doesn’t have, so they aren’t offered.</Note>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel>Behaviour</SectionLabel>
        <Glass padding={4}>
        <ListRow
          title="Autoplay similar"
          subtitle="When the queue ends, keep going with songs by the same artist and in the same genre"
          minHeight={72}
          right={<Toggle value={autoplay} onChange={setAutoplay} label="Autoplay similar" />}
        />
        <ListRow
          title="Resume where I left off"
          subtitle="On app start, bring back your queue and position, paused"
          minHeight={72}
          divider
          right={<Toggle value={resume} onChange={toggleResume} label="Resume where I left off" />}
        />
      </Glass>
      </View>

      <Glass padding={16} style={{ gap: 6 }}>
        <T size={15} weight={500}>
          Now playing on the lock screen
        </T>
        <T size={13} color={colors.textSecondary} lineHeight={18}>
          The song, artist and artwork always show on the lock screen and in the notification shade, with play, pause, skip and scrubbing. The system controls this card, so there’s no switch for it.
        </T>
      </Glass>
    </Screen>
  );
}
