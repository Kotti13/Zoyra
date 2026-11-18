import { router } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Glass, Icon, Row, T, Tap } from '../../components';
import { useAuth } from '../../state/auth';
import { colors, radius, withAlpha } from '../../theme/tokens';
import { initE2EE, PIN_LENGTH, skipRestore, useE2EE, type E2EESnapshot } from './index';

/** Signed-in user + E2EE snapshot; runs initE2EE for that user when needed. Used by the e2ee-* screens. */
export function useE2EEBoot(): E2EESnapshot & { me: string | null } {
  const { user } = useAuth();
  const me = user?.id ?? null;
  const snap = useE2EE();
  useEffect(() => {
    if (me && (snap.userId !== me || snap.status === 'idle')) void initE2EE(me);
  }, [me, snap.userId, snap.status]);
  return { ...snap, me };
}

export const onlyDigits = (v: string) => v.replace(/\D/g, '').slice(0, PIN_LENGTH);

/** Six PIN boxes over a hidden number-pad input. Tapping the boxes focuses the input. */
export function PinField({ value, onChange, label, error, autoFocus = true, disabled }: { value: string; onChange: (v: string) => void; label: string; error?: string; autoFocus?: boolean; disabled?: boolean }) {
  const ref = useRef<ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    if (autoFocus && !disabled) {
      const t = setTimeout(() => ref.current?.focus(), 250);
      return () => clearTimeout(t);
    }
  }, [autoFocus, disabled, label]);
  const border = error ? colors.error : colors.glassBorder;
  return (
    <View style={{ gap: 10, alignItems: 'center' }}>
      <T size={14} color={colors.textSecondary} align="center">
        {label}
      </T>
      <Tap onPress={() => ref.current?.focus()} accessibilityRole="none" accessibilityLabel={`${label}, ${value.length} of ${PIN_LENGTH} digits entered`}>
        <Row gap={10}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => {
            const filled = i < value.length;
            const active = i === value.length && !disabled;
            return (
              <View
                key={i}
                style={{
                  width: 44,
                  height: 54,
                  borderRadius: radius.sm,
                  borderWidth: 1.5,
                  borderColor: active ? colors.accent : border,
                  backgroundColor: filled ? withAlpha(colors.accent, 0.16) : withAlpha(colors.white, 0.05),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {filled ? <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: colors.text }} /> : null}
              </View>
            );
          })}
        </Row>
      </Tap>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(v) => onChange(onlyDigits(v))}
        keyboardType="number-pad"
        maxLength={PIN_LENGTH}
        secureTextEntry
        editable={!disabled}
        autoComplete="off"
        textContentType="oneTimeCode"
        accessibilityLabel={label}
        style={{ position: 'absolute', opacity: 0, width: 1, height: 1 }}
      />
      {error ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}
    </View>
  );
}

/**
 * Messages inbox card, shown only while this phone has an undecided restore offer (new phone with a chat
 * backup, or keys reset on another phone) or needs a password confirm to make fresh keys. Non-blocking:
 * "Restore" → /e2ee-restore, "Skip" → fresh keys (skipRestore). Renders nothing otherwise.
 */
export function RestoreHistoryCard() {
  const snap = useE2EE();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (snap.status !== 'needs_restore' && snap.status !== 'needs_reauth') return null;
  const backup = snap.restoreReason === 'backup';
  const reauth = snap.status === 'needs_reauth';

  const skip = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const s = await skipRestore();
      if (s === 'needs_reauth') router.push({ pathname: '/e2ee-setup', params: { mode: 'reauth' } });
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Couldn’t turn on encrypted chats. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const title = reauth ? 'Confirm it’s you' : backup ? 'Restore your chat history?' : 'Use encrypted chats on this phone?';
  const body = reauth
    ? 'To turn on encrypted chats on this phone, confirm your password.'
    : backup
      ? 'Enter your backup PIN to read older messages on this phone. Skip to start fresh: older messages won’t be readable here.'
      : 'Your encryption keys were reset on another phone. Continue here to keep chatting; the other phone switches to new keys when it’s used.';

  return (
    <Glass padding={14} style={{ gap: 10 }}>
      <Row gap={10} align="flex-start">
        <Icon name="lock" size={18} color={colors.sky} />
        <View style={{ flex: 1, gap: 4 }}>
          <T size={15} weight={600}>
            {title}
          </T>
          <T size={13} lineHeight={18} color={colors.textSecondary}>
            {body}
          </T>
          {note ? (
            <T size={12} color={colors.error} accessibilityLiveRegion="polite">
              {note}
            </T>
          ) : null}
        </View>
      </Row>
      <Row gap={10}>
        {reauth ? (
          <Button label="Confirm" icon="lock" height={40} style={{ flex: 1 }} onPress={() => router.push({ pathname: '/e2ee-setup', params: { mode: 'reauth' } })} />
        ) : backup ? (
          <Button label="Restore" icon="lock" height={40} style={{ flex: 1 }} onPress={() => router.push('/e2ee-restore')} />
        ) : null}
        {!reauth ? <Button label={busy ? 'Setting up…' : backup ? 'Skip' : 'Use here'} variant={busy ? 'disabled' : backup ? 'secondary' : 'primary'} height={40} style={{ flex: 1 }} onPress={() => void skip()} /> : null}
      </Row>
    </Glass>
  );
}
