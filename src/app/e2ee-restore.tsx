import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ErrorState, Glass, Icon, IconButton, IconTile, LinkText, ListRow, Loading, Overline, ProgressBar, Row, Screen, Sticker, T, Tap } from '../components';
import { confirmDialog } from '../lib/dialog';
import { PIN_LENGTH, restoreInfo, restoreWithPin, skipRestore } from '../lib/e2ee';
import { PinField, useE2EEBoot } from '../lib/e2ee/ui';
import { supabase } from '../lib/supabase';
import { colors, withAlpha } from '../theme/tokens';

const AMBER = colors.gold;

/** chat_backup_summary() (20261117120000): when the PIN backup was written and what it unlocks. */
type Summary = { exists: boolean; updated_at?: string; chats?: number; bytes?: number };

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

/** "Backup from 12 Nov, 1.2 MB. Unlocks 38 encrypted chats on this phone." */
function summaryLine(s: Summary | null): string {
  if (!s?.updated_at) return 'Enter your backup PIN to read your older encrypted messages on this phone.';
  const date = new Date(s.updated_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const size = s.bytes ? `, ${fmtBytes(s.bytes)}` : '';
  const chats = s.chats ? ` Unlocks ${s.chats} encrypted ${s.chats === 1 ? 'chat' : 'chats'} on this phone.` : ' Unlocks your encrypted chats on this phone.';
  return `Backup from ${date}${size}.${chats}`;
}

/** Amber glass card (MsgRestore). */
function AmberCard({ children }: { children: ReactNode }) {
  return (
    <View style={{ borderRadius: 30, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(AMBER, 0.4), padding: 20, gap: 14, alignItems: 'center' }}>
      <LinearGradient colors={[withAlpha(AMBER, 0.2), 'rgba(20,20,20,0.6)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {children}
    </View>
  );
}

function AmberIcon() {
  return (
    <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: AMBER, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="lock" size={28} color={colors.onLight} strokeWidth={2} />
    </View>
  );
}

type Info = { exists: boolean; attemptsLeft: number; lockedUntil: string | null };

const untilLabel = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.max(1, Math.round((d.getTime() - Date.now()) / 60_000));
  return mins < 90 ? `${mins} min` : d.toLocaleString([], { hour: 'numeric', minute: '2-digit', weekday: 'short' });
};

/**
 * Visual (MsgRestore): back · "Restore chats" · amber card ("Restore your chat history?", backup date / size /
 * chats, Restore now → PIN, Skip for now → back to the inbox, the offer stays) · PRIVACY list · footnote.
 * The design's "protected with your account" is our optional PIN backup, so the copy says PIN.
 *
 * Restore chat history on a new phone (`/e2ee-restore`, opened from the Messages inbox card or the "Restore your
 * chat history first?" prompt). The PIN unlocks the optional encrypted backup; 10 wrong tries lock it (1 h, then
 * longer). "Forgot PIN" / no backup → fresh keys for this phone (skipRestore), no PIN needed.
 */
export default function E2EERestore() {
  const boot = useE2EEBoot();
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState(false);
  const [fresh, setFresh] = useState(false);
  /** The offer card's "Restore now" was tapped (shows the PIN field). */
  const [entering, setEntering] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  const [attempt, setAttempt] = useState(0);
  const settled = !!boot.me && boot.status !== 'idle' && boot.status !== 'loading';

  useEffect(() => {
    if (!boot.me) return;
    let alive = true;
    void supabase.rpc('chat_backup_summary').then(({ data, error: e }) => {
      if (alive && !e && data && typeof data === 'object') setSummary(data as Summary);
    });
    return () => {
      alive = false;
    };
  }, [boot.me]);

  useEffect(() => {
    if (!settled) return;
    let alive = true;
    restoreInfo()
      .then((i) => {
        if (!alive) return;
        setLoadError(undefined);
        setInfo(i);
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : 'Could not reach the server'));
    return () => {
      alive = false;
    };
  }, [settled, attempt]);

  const load = () => {
    setLoadError(undefined);
    setAttempt((n) => n + 1);
  };

  // Pushed over the inbox / a chat: go back there (never replace into a second copy of the chat).
  const finish = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/messages');
  };

  const startFresh = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const s = await skipRestore();
      if (s === 'needs_reauth') router.replace({ pathname: '/e2ee-setup', params: { mode: 'reauth' } });
      else {
        setFresh(true);
        setDone(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn on encrypted chats');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setProgress(0);
    try {
      const r = await restoreWithPin(value, setProgress);
      if (r.status === 'ok') {
        setDone(true);
        return;
      }
      setPin('');
      if (r.status === 'wrong_pin') {
        setInfo((i) => (i ? { ...i, attemptsLeft: r.attemptsLeft } : i));
        setError(r.attemptsLeft === 1 ? 'Wrong PIN. 1 try left before a lockout.' : `Wrong PIN. ${r.attemptsLeft} tries left.`);
      } else if (r.status === 'locked') {
        setInfo((i) => (i ? { ...i, attemptsLeft: 0, lockedUntil: r.lockedUntil } : i));
      } else {
        setInfo({ exists: false, attemptsLeft: 0, lockedUntil: null });
      }
    } catch (e) {
      setPin('');
      setError(e instanceof Error ? e.message : 'Could not restore your keys');
    } finally {
      setBusy(false);
    }
  };

  const forgot = async () => {
    const ok = await confirmDialog(
      'Start with new keys?',
      'Older messages from your backup can’t be read on this phone, and your contacts will see that your security code changed. You can turn on a new backup later in Settings.',
      'Use new keys',
      true,
    );
    if (ok) void startFresh();
  };

  const header = (subtitle: string) => (
    <>
      <Row gap={8} style={{ minHeight: 44 }}>
        {busy ? <View style={{ height: 44 }} /> : <IconButton icon="back" label="Back" size={44} iconSize={20} glass href="back" />}
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={40} accessibilityRole="header">
          Restore chats
        </T>
        <T size={14} lineHeight={20} color={colors.textSecondary}>
          {subtitle}
        </T>
      </View>
    </>
  );

  const backdrop = { pattern: 'none' as const, mesh: 'coral' as const, orbs: true };

  if (!boot.me) {
    return (
      <Screen top={4} gap={14} backdrop={backdrop}>
        {header('Sign in to restore your encrypted chats.')}
      </Screen>
    );
  }

  // get_backup_params / begin_backup_restore only report locked_until while the lock is active.
  const locked = !!info?.lockedUntil;

  const privacy = (
    <>
      <View style={{ paddingHorizontal: 4 }}>
        <Overline color={colors.textSecondary}>Privacy</Overline>
      </View>
      <Glass radius={36} padding={0} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
        <ListRow title="End-to-end encrypted" subtitle="Previews unlock on your phone, not on our servers" icon="lock" right={<T size={13} color={colors.textSecondary}>On</T>} />
        <ListRow
          title="Encrypted backup"
          subtitle={`Protected with your ${PIN_LENGTH}-digit PIN`}
          icon="shield"
          divider
          right={<T size={13} color={colors.textSecondary}>{info?.exists === false ? 'Off' : 'On'}</T>}
        />
      </Glass>
      <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <T size={12} lineHeight={17} color={colors.textSecondary}>
          Only you and the people you message can read your encrypted chats. Not even Zoyra can.
        </T>
      </View>
    </>
  );

  return (
    <Screen top={4} gap={14} backdrop={backdrop} contentStyle={{ flexGrow: 1 }}>
      {done || (boot.status === 'ready' && !busy) ? (
        <>
          {header(fresh ? 'This phone is ready for encrypted chats.' : 'Your encrypted chats are on this phone.')}
          <View style={{ alignItems: 'center', gap: 12, paddingTop: 16 }}>
            <IconTile icon="check" size={72} iconSize={34} color={colors.success} />
            <T size={22} weight={700} align="center">
              {fresh ? 'Encrypted chats are on' : 'Your chats are back'}
            </T>
            <T size={14} lineHeight={20} color={colors.textSecondary} align="center">
              {fresh
                ? 'This phone has new encryption keys. Your contacts will see that your security code changed.'
                : 'Your encryption keys are on this phone, so your message history can be read here.'}
            </T>
          </View>
          <Button label="Done" onPress={finish} />
        </>
      ) : loadError ? (
        <>
          {header('We couldn’t check your backup.')}
          <ErrorState message={loadError} onRetry={load} />
        </>
      ) : boot.status === 'idle' || boot.status === 'loading' || !info ? (
        <>
          {header('Checking for a backup for this phone…')}
          <Loading label="Checking your backup" />
        </>
      ) : !info.exists ? (
        <>
          {header('There’s no chat backup for your account.')}
          <AmberCard>
            <AmberIcon />
            <T size={18} weight={700} align="center">
              Use encrypted chats here?
            </T>
            <T size={13} lineHeight={19} color={colors.peach} align="center">
              Continue to use encrypted chats on this phone with new keys.
            </T>
            {error ? (
              <T size={13} color={colors.error} accessibilityLiveRegion="polite" align="center">
                {error}
              </T>
            ) : null}
            <GoldButton label={busy ? 'Setting up…' : 'Continue'} onPress={busy ? undefined : () => void startFresh()} />
          </AmberCard>
          {privacy}
        </>
      ) : (
        <>
          {header('We found a backup for this new phone.')}
          <AmberCard>
            <AmberIcon />
            <T size={18} weight={700} align="center">
              Restore your chat history?
            </T>
            <T size={13} lineHeight={19} color={colors.peach} align="center">
              {summaryLine(summary)}
            </T>

            {locked && info.lockedUntil ? (
              <Glass padding={4} style={{ alignSelf: 'stretch' }}>
                <ListRow title="Too many wrong PINs" subtitle={`Try again in ${untilLabel(info.lockedUntil)}.`} icon="clock" right={<Sticker label="LOCKED" bg={colors.error} rotate={3} />} />
              </Glass>
            ) : busy ? (
              <View style={{ gap: 14, paddingTop: 4, alignSelf: 'stretch' }}>
                <T size={16} weight={600} align="center">
                  {progress < 1 ? 'Checking your PIN…' : 'Restoring your keys…'}
                </T>
                <ProgressBar value={Math.max(0.04, Math.min(1, progress))} />
              </View>
            ) : entering ? (
              <View style={{ gap: 10, alignSelf: 'stretch', alignItems: 'center' }}>
                <PinField
                  label={`Enter the ${PIN_LENGTH}-digit PIN you chose for your backup`}
                  value={pin}
                  error={error}
                  onChange={(v) => {
                    setPin(v);
                    setError(undefined);
                    if (v.length === PIN_LENGTH) void submit(v);
                  }}
                />
                {info.attemptsLeft < 10 ? (
                  <T size={13} color={info.attemptsLeft <= 3 ? colors.error : colors.textSecondary} align="center">
                    {info.attemptsLeft} {info.attemptsLeft === 1 ? 'try' : 'tries'} left
                  </T>
                ) : null}
              </View>
            ) : (
              <GoldButton label="Restore now" onPress={() => setEntering(true)} />
            )}

            {!busy ? (
              <Tap
                onPress={finish}
                accessibilityLabel="Skip for now"
                accessibilityHint="Goes back. You can restore later from Messages"
                style={{ alignSelf: 'stretch', height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.1) }}
              >
                <T size={15} weight={600}>
                  Skip for now
                </T>
              </Tap>
            ) : null}
            {!busy ? <LinkText label="Forgot PIN? Use new keys instead" color={colors.textSecondary} onPress={() => void forgot()} /> : null}
          </AmberCard>
          {privacy}
        </>
      )}
    </Screen>
  );
}

/** Gold → orange pill (MsgRestore "Restore now"). */
function GoldButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Tap onPress={onPress} disabled={!onPress} accessibilityLabel={label} style={{ alignSelf: 'stretch', height: 52, borderRadius: 26, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', opacity: onPress ? 1 : 0.6 }}>
      <LinearGradient colors={['#FFD36A', colors.orange]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <T size={15} weight={800} color="#1A1206">
        {label}
      </T>
    </Tap>
  );
}
