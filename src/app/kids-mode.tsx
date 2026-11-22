import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { PinModal } from '../components/KidsGuard';
import { Button, Glass, Icon, ListGroup, ListRow, Overline, Row, Screen, ScreenHeader, T, Tap, Toast, Toggle, useAsync, IconBadge } from '../components';
import { checkPin, clockLabel, limitLabel, lockParent, makePin, readUsageSeconds, useKids } from '../lib/kids';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const LIMITS = [0, 30, 60, 120, 180];
const BED_FROM = [20 * 60, 20 * 60 + 30, 21 * 60, 22 * 60];
const BED_TO = [6 * 60, 6 * 60 + 30, 7 * 60, 8 * 60];

type Setup = { step: 'new' | 'confirm'; first?: string; enable: boolean } | null;
type Note = { text: string; error?: boolean };

const chip = (on: boolean) => ({
  minHeight: 44,
  paddingHorizontal: 14,
  borderRadius: 22,
  justifyContent: 'center' as const,
  borderWidth: on ? 2 : 1,
  borderColor: on ? colors.accentLight : colors.glassBorder,
  backgroundColor: on ? withAlpha(colors.accent, 0.22) : colors.bgTertiary,
});

/**
 * Kids mode (`/kids-mode`): a restricted space for younger listeners. While on: explicit songs hidden, messages /
 * notes / comments / live rooms closed, a daily listening limit and bedtime, and settings behind a parent PIN.
 * Enforcement lives in components/KidsGuard.tsx and lib/content-filter.ts. Needs `user_settings.kids`
 * (migration 20261118130000).
 */
export default function KidsMode() {
  const { user } = useAuth();
  const { cfg, ready, on, hasPin, unlocked, save } = useKids();
  const [setup, setSetup] = useState<Setup>(null);
  const [gate, setGate] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const used = useAsync(() => (user ? readUsageSeconds(user.id) : Promise.resolve(0)), [user?.id, unlocked], 'app/kids-mode:41');

  const run = async (fn: () => Promise<void>, ok?: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ text: ok });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not save. Kids mode needs the latest server update.', error: true });
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Kids mode" />
        <T color={colors.textSecondary}>Sign in to set up kids mode.</T>
        <Button label="Sign in" href="/login" />
      </Screen>
    );
  }
  if (!ready) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Kids mode" />
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }

  // Kids mode is on: settings stay behind the parent PIN.
  if (on && !unlocked) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Kids mode" />
        <Glass padding={20} style={{ alignItems: 'center', gap: 12 }}>
          <Icon name="lock" size={28} color={colors.accentLight} />
          <T size={17} weight={600} align="center">
            Kids mode is on
          </T>
          <T size={14} color={colors.textSecondary} align="center">
            Ask a parent to enter the PIN to change settings or switch it off.
          </T>
          <Button label="Enter parent PIN" onPress={() => setGate(true)} style={{ alignSelf: 'stretch' }} />
        </Glass>
        <PinModal
          visible={gate}
          title="Enter parent PIN"
          subtitle="Opens kids mode settings for 10 minutes."
          onCancel={() => setGate(false)}
          onSubmit={async (pin) => {
            const r = await checkPin(cfg, pin);
            if (r.ok) {
              setGate(false);
              return null;
            }
            return r.error ?? 'That PIN is wrong.';
          }}
        />
      </Screen>
    );
  }

  const toggle = (v: boolean) => {
    if (v && !hasPin) return setSetup({ step: 'new', enable: true });
    void run(async () => {
      await save({ on: v });
      if (v) {
        lockParent();
        router.replace('/');
      }
    }, v ? undefined : 'Kids mode is off');
  };

  const submitSetup = async (pin: string): Promise<string | null> => {
    if (!setup) return null;
    if (setup.step === 'new') {
      setSetup({ ...setup, step: 'confirm', first: pin });
      return null;
    }
    if (pin !== setup.first) {
      setSetup({ ...setup, step: 'new', first: undefined });
      return 'The PINs didn’t match. Start again.';
    }
    const enable = setup.enable;
    try {
      const hashed = await makePin(pin);
      await save({ ...hashed, ...(enable ? { on: true } : {}) });
      setSetup(null);
      if (enable) {
        lockParent();
        router.replace('/');
      } else setNote({ text: 'PIN changed' });
      return null;
    } catch (e) {
      setSetup(null);
      setNote({ text: e instanceof Error ? e.message : 'Could not save the PIN', error: true });
      return null;
    }
  };

  const usedMin = Math.floor((used.data ?? 0) / 60);

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Kids mode" />
      <T size={14} color={colors.textSecondary} style={{ marginTop: -8 }}>
        A safe, simple space for younger listeners.
      </T>

      <Glass padding={14}>
        <Row gap={12}>
          <IconBadge icon="shield" size={44} />
          <View style={{ flex: 1 }}>
            <T size={16} weight={600}>
              Kids mode
            </T>
            <T size={13} color={colors.textSecondary}>
              Only family friendly music and stories
            </T>
          </View>
          <Toggle value={on} onChange={toggle} label="Kids mode" />
        </Row>
      </Glass>

      <ListGroup title="CONTENT">
        <ListRow title="Explicit songs" subtitle="Always hidden" icon="ban" right={<T size={14} color={colors.textSecondary}>Hidden</T>} />
        <ListRow title="Messages and notes" subtitle="Switched off" icon="chat" divider right={<T size={14} color={colors.textSecondary}>Off</T>} />
        <ListRow title="Comments and live rooms" subtitle="Switched off" icon="broadcast" divider right={<T size={14} color={colors.textSecondary}>Off</T>} />
      </ListGroup>
      <T size={12} color={colors.textTertiary} style={{ marginTop: -8 }}>
        Explicit filtering can only catch songs the artist marked as explicit, so some may still play.
      </T>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>LIMITS</Overline>
        <Glass padding={14} style={{ gap: 12 }}>
          <View style={{ gap: 2 }}>
            <T size={16} weight={500}>
              Daily listening limit
            </T>
            <T size={13} color={colors.textSecondary}>
              {`Stop playing after the limit. Today: ${usedMin} min.`}
            </T>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {LIMITS.map((m) => (
              <Tap key={m} onPress={() => void run(() => save({ limit_min: m }))} accessibilityRole="radio" accessibilityState={{ selected: cfg.limit_min === m }} accessibilityLabel={`Daily limit ${limitLabel(m)}`} style={chip(cfg.limit_min === m)}>
                <T size={14} weight={600}>
                  {limitLabel(m)}
                </T>
              </Tap>
            ))}
          </View>
        </Glass>
        <Glass padding={14} style={{ gap: 12 }}>
          <Row gap={12}>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={16} weight={500}>
                Bedtime
              </T>
              <T size={13} color={colors.textSecondary}>
                {cfg.bed_on ? `Quiet from ${clockLabel(cfg.bed_from)} to ${clockLabel(cfg.bed_to)}` : 'Off'}
              </T>
            </View>
            <Toggle value={cfg.bed_on} onChange={(v) => void run(() => save({ bed_on: v }))} label="Bedtime" />
          </Row>
          {cfg.bed_on ? (
            <>
              <T size={12} color={colors.textSecondary}>
                Starts
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {BED_FROM.map((m) => (
                  <Tap key={m} onPress={() => void run(() => save({ bed_from: m }))} accessibilityRole="radio" accessibilityState={{ selected: cfg.bed_from === m }} style={chip(cfg.bed_from === m)}>
                    <T size={14} weight={600}>
                      {clockLabel(m)}
                    </T>
                  </Tap>
                ))}
              </View>
              <T size={12} color={colors.textSecondary}>
                Ends
              </T>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {BED_TO.map((m) => (
                  <Tap key={m} onPress={() => void run(() => save({ bed_to: m }))} accessibilityRole="radio" accessibilityState={{ selected: cfg.bed_to === m }} style={chip(cfg.bed_to === m)}>
                    <T size={14} weight={600}>
                      {clockLabel(m)}
                    </T>
                  </Tap>
                ))}
              </View>
            </>
          ) : null}
        </Glass>
      </View>

      <ListGroup title="EXIT">
        <ListRow title="Exit with PIN" subtitle={`Ask for a 4 digit PIN`} icon="lock" onPress={() => setSetup({ step: 'new', enable: false })} right={<T size={14} color={colors.accentLight}>{hasPin ? 'Change' : 'Set'}</T>} />
      </ListGroup>

      <PinModal
        key={setup ? `${setup.step}:${setup.enable}` : 'closed'}
        visible={!!setup}
        title={setup?.step === 'confirm' ? 'Confirm the PIN' : hasPin && !setup?.enable ? 'Choose a new PIN' : 'Choose a parent PIN'}
        subtitle={setup?.step === 'confirm' ? 'Enter the same 4 digits again.' : 'A parent needs it to change settings or turn kids mode off.'}
        onCancel={() => setSetup(null)}
        onSubmit={submitSetup}
      />
      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.error : colors.success} message={note.text} /> : null}
    </Screen>
  );
}
