import { router, useSegments } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Modal, TextInput, View } from 'react-native';

import { bedtimeActive, checkPin, clockLabel, kidsRouteVerdict, PIN_LENGTH, readUsageSeconds, useKids, writeUsageSeconds } from '../lib/kids';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, fonts, withAlpha } from '../theme/tokens';
import { Button, Icon, T } from '.';

/** Parent PIN entry (modal). `onSubmit` resolves an error message, or null when the PIN was accepted. */
export function PinModal({ visible, title, subtitle, onSubmit, onCancel }: { visible: boolean; title: string; subtitle?: string; onSubmit: (pin: string) => Promise<string | null>; onCancel: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (v: string) => {
    const next = v.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(next);
    setError(null);
    if (next.length === PIN_LENGTH && !busy) {
      setBusy(true);
      void onSubmit(next)
        .then((err) => {
          setError(err);
          setPin('');
        })
        .finally(() => setBusy(false));
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onCancel}>
      <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <View style={{ width: '100%', maxWidth: 360, padding: 24, gap: 14, borderRadius: 32, alignItems: 'center', backgroundColor: withAlpha(colors.bgTertiary, 0.98), borderWidth: 1, borderColor: withAlpha(colors.white, 0.14) }}>
          <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lock" size={24} color={colors.accentLight} />
          </View>
          <T size={18} weight={600} align="center" accessibilityRole="header">
            {title}
          </T>
          {subtitle ? (
            <T size={13} color={colors.textSecondary} align="center">
              {subtitle}
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 14, marginVertical: 4 }} accessibilityLabel={`${pin.length} of ${PIN_LENGTH} digits entered`}>
            {Array.from({ length: PIN_LENGTH }, (_, i) => (
              <View key={i} style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: i < pin.length ? colors.accent : 'transparent', borderWidth: 2, borderColor: i < pin.length ? colors.accent : withAlpha(colors.white, 0.35) }} />
            ))}
          </View>
          <TextInput
            value={pin}
            onChangeText={change}
            autoFocus
            keyboardType="number-pad"
            secureTextEntry
            maxLength={PIN_LENGTH}
            editable={!busy}
            accessibilityLabel={`${PIN_LENGTH} digit PIN`}
            style={{ width: 160, height: 48, textAlign: 'center', letterSpacing: 8, fontSize: 20, fontFamily: fonts.regular, color: colors.text, borderRadius: 24, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.bg }}
          />
          {error ? (
            <T size={13} color={colors.error} align="center" accessibilityRole="alert">
              {error}
            </T>
          ) : null}
          <Button label="Cancel" variant="secondary" onPress={onCancel} style={{ alignSelf: 'stretch' }} />
        </View>
      </View>
    </Modal>
  );
}

/**
 * Kids mode enforcement, mounted once under the root layout:
 *  - closes social screens (messages, calls, live, notes) and sends settings / payments screens to the PIN gate;
 *  - counts listening time per day and pauses at the daily limit or inside bedtime, with a "Time's up" card.
 * A correct parent PIN opens everything for 10 minutes (see lib/kids.ts).
 */
export function KidsGuardHost() {
  const { cfg, on, unlocked } = useKids();
  const { user } = useAuth();
  const uid = user?.id;
  const first = useSegments()[0] ?? '';
  const active = on && !unlocked;
  const { playing, pause } = usePlayerPick('playing');
  const [show, setShow] = useState<'limit' | 'bedtime' | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const sec = useRef(0);
  const loadedFor = useRef<string | null>(null);
  const day = useRef(new Date().getDate());
  const playingRef = useRef(playing);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // Route guard.
  useEffect(() => {
    if (!active) return;
    const v = kidsRouteVerdict(first);
    if (v === 'ok' || first === 'kids-mode') return;
    if (v === 'parent') router.replace('/kids-mode');
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [active, first]);

  // Today's counter for this account.
  useEffect(() => {
    if (!uid || !on || loadedFor.current === uid) return;
    loadedFor.current = uid;
    void readUsageSeconds(uid).then((s) => {
      sec.current = Math.max(sec.current, s);
    });
  }, [uid, on]);

  // One tick a second: count listening, decide whether playback is allowed.
  useEffect(() => {
    if (!active || !uid) return;
    const id = setInterval(() => {
      const now = new Date();
      if (now.getDate() !== day.current) {
        day.current = now.getDate();
        sec.current = 0;
      }
      if (playingRef.current) {
        sec.current += 1;
        if (sec.current % 15 === 0) void writeUsageSeconds(uid, sec.current);
      }
      const r = cfg.limit_min > 0 && sec.current >= cfg.limit_min * 60 ? 'limit' : bedtimeActive(cfg, now) ? 'bedtime' : null;
      // Playing while not allowed: stop and explain.
      if (r && playingRef.current) {
        pause();
        setShow(r);
      }
    }, 1000);
    return () => {
      clearInterval(id);
      if (uid) void writeUsageSeconds(uid, sec.current);
    };
  }, [active, uid, cfg, pause]);

  const title = show === 'bedtime' ? 'Quiet time' : 'That’s enough music for today';
  const body = show === 'bedtime' ? `Music is off from ${clockLabel(cfg.bed_from)} to ${clockLabel(cfg.bed_to)}.` : 'You’ve reached today’s listening limit. Come back tomorrow!';

  return (
    <>
      <Modal visible={!!show && active} transparent animationType="fade" statusBarTranslucent onRequestClose={() => setShow(null)}>
        <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{ width: '100%', maxWidth: 360, padding: 24, gap: 14, borderRadius: 32, alignItems: 'center', backgroundColor: withAlpha(colors.bgTertiary, 0.98), borderWidth: 1, borderColor: withAlpha(colors.white, 0.14) }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={show === 'bedtime' ? 'moon' : 'timer'} size={26} color={colors.accentLight} />
            </View>
            <T size={20} weight={600} align="center" accessibilityRole="header">
              {title}
            </T>
            <T size={14} color={colors.textSecondary} align="center">
              {body}
            </T>
            <Button label="OK" onPress={() => setShow(null)} style={{ alignSelf: 'stretch' }} />
            <Button label="Parent: unlock" variant="secondary" onPress={() => setPinOpen(true)} style={{ alignSelf: 'stretch' }} />
          </View>
        </View>
      </Modal>
      <PinModal
        visible={pinOpen}
        title="Enter parent PIN"
        subtitle="Opens kids mode for 10 minutes."
        onCancel={() => setPinOpen(false)}
        onSubmit={async (pin) => {
          const r = await checkPin(cfg, pin);
          if (r.ok) {
            setPinOpen(false);
            setShow(null);
            return null;
          }
          return r.error ?? 'That PIN is wrong.';
        }}
      />
    </>
  );
}
