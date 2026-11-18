import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorState, Glass, IconTile, LinkText, ListRow, Loading, ProgressBar, Screen, ScreenHeader, T, TextField } from '../components';
import { confirmDialog } from '../lib/dialog';
import { changePin, hasBackup, initE2EE, PIN_LENGTH, setupBackupPin, skipRestore, turnOffBackup } from '../lib/e2ee';
import { PinField, useE2EEBoot } from '../lib/e2ee/ui';
import { isReauthError, needsRecentSignIn, reauthWithPassword, signInMethod } from '../lib/reauth';
import { colors } from '../theme/tokens';

type Step = 'overview' | 'old' | 'pin' | 'confirm' | 'reauth' | 'working' | 'done';
/** What the password confirm is for. */
type ReauthFor = 'keys' | 'off';

/** Honest limit of a 6-digit PIN (shown on the intro and PIN steps). */
const PIN_LIMIT =
  'Your 6-digit PIN unlocks your message backup. Zoyra limits wrong guesses, but a short PIN is weaker than a password. Don’t reuse your phone PIN. If you forget it, you can reset your keys, but older encrypted messages can’t be recovered.';

const FACTS = [
  { icon: 'lock' as const, title: 'Your chats are already end-to-end encrypted', subtitle: 'Messages, voice notes and photos are locked on your phone before they leave it. Zoyra can’t read them. No PIN needed for that.' },
  { icon: 'shield' as const, title: 'Backup is optional', subtitle: 'Turn it on to bring your chat history to a new phone. Your keys are backed up encrypted with a 6-digit PIN.' },
  { icon: 'info' as const, title: 'Without a backup', subtitle: 'A new phone gets new keys and your contacts see that your security code changed. Older messages can’t be read there.' },
  { icon: 'eye' as const, title: 'What a PIN can’t do', subtitle: PIN_LIMIT },
];

const weakPin = (v: string) => /^(\d)\1+$/.test(v) || '0123456789'.includes(v) || '9876543210'.includes(v);

/**
 * Settings → Privacy → Chat backup (`/e2ee-setup`): the optional PIN backup of this phone's E2EE keys (turn on,
 * change PIN, turn off). Chats never need it: keys are created silently. `?mode=reauth` = confirm the password so
 * this phone can make fresh keys (only when the sign-in is older than 10 minutes), then go back.
 */
export default function E2EESetup() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const reauthMode = params.mode === 'reauth';
  const boot = useE2EEBoot();
  const [backup, setBackup] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [step, setStep] = useState<Step>(reauthMode ? 'reauth' : 'overview');
  const [changing, setChanging] = useState(false);
  const [oldPin, setOldPin] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState(0);
  const [doneText, setDoneText] = useState('');
  const [password, setPassword] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthNote, setReauthNote] = useState<string | null>(null);
  const [reauthFor, setReauthFor] = useState<ReauthFor>('keys');

  const ready = boot.status === 'ready';
  const loadBackup = useCallback(() => {
    setLoadError(undefined);
    hasBackup()
      .then(setBackup)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Could not reach the server'));
  }, []);
  useEffect(() => {
    if (ready && !reauthMode) void Promise.resolve().then(loadBackup);
  }, [ready, reauthMode, loadBackup]);

  // Never replace into another route here: this screen is pushed (from Settings or a chat), so going back
  // returns to exactly where the user was (no duplicate chat screen).
  const finish = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/privacy');
  };

  const resetEntry = () => {
    setOldPin('');
    setPin('');
    setAgain('');
    setError(undefined);
  };

  const askReauth = async (why: ReauthFor, note?: string) => {
    const m = await signInMethod().catch(() => null);
    setReauthFor(why);
    setReauthNote(m?.kind === 'oauth' ? `You signed in with ${m.provider}. Sign out and sign in again, then try within 10 minutes.` : (note ?? null));
    setStep('reauth');
  };

  /** Fresh keys for this phone after the password confirm (mode=reauth). */
  const makeKeys = async () => {
    setStep('working');
    try {
      const s = await skipRestore();
      if (s === 'needs_reauth') {
        await askReauth('keys', 'For your security, confirm your password again.');
        return;
      }
      setDoneText('Encrypted chats are on for this phone. Your contacts will see that your security code changed.');
      setStep('done');
    } catch (e) {
      setReauthNote(e instanceof Error ? e.message : 'Could not turn on encrypted chats');
      setStep('reauth');
    }
  };

  const save = async (confirmPin: string) => {
    if (confirmPin !== pin) {
      setAgain('');
      setError('PINs don’t match. Try again.');
      return;
    }
    setError(undefined);
    setStep('working');
    setProgress(0);
    try {
      if (changing) {
        const r = await changePin(oldPin, pin, setProgress);
        if (r.status !== 'ok') {
          resetEntry();
          setError(r.status === 'wrong_pin' ? `That current PIN isn’t right. ${r.attemptsLeft} tries left.` : r.status === 'locked' ? 'Too many wrong PINs. Try again later.' : 'Chat backup is off.');
          setStep(r.status === 'no_backup' ? 'overview' : 'old');
          if (r.status === 'no_backup') setBackup(false);
          return;
        }
        setDoneText('Your backup PIN was changed. Keep it somewhere safe.');
      } else {
        const r = await setupBackupPin(pin, setProgress);
        if (r === 'exists') {
          resetEntry();
          setBackup(true);
          setError('Chat backup is already on. Use Change PIN instead.');
          setStep('overview');
          return;
        }
        setDoneText('Chat backup is on. A new phone can restore your chat history with your PIN. Keep it somewhere safe.');
      }
      setBackup(true);
      setStep('done');
    } catch (e) {
      resetEntry();
      setError(e instanceof Error ? e.message : 'Could not save your backup');
      setStep(changing ? 'old' : 'pin');
    }
  };

  const off = async (recentSignIn = false) => {
    if (!recentSignIn) {
      const ok = await confirmDialog('Turn off chat backup?', 'Your encrypted backup is deleted. A new phone won’t be able to restore your chat history.', 'Turn off', true);
      if (!ok) return;
    }
    setStep('working');
    setProgress(1);
    try {
      await turnOffBackup({ recentSignIn });
      setBackup(false);
      setDoneText('Chat backup is off. Your chats on this phone stay end-to-end encrypted.');
      setStep('done');
    } catch (e) {
      if (isReauthError(e)) {
        await askReauth('off', 'Confirm your password to turn off chat backup.');
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not turn off chat backup');
      setStep('overview');
    }
  };

  const confirmPassword = async () => {
    if (!password || reauthBusy) return;
    setReauthBusy(true);
    setReauthNote(null);
    try {
      await reauthWithPassword(password);
      setPassword('');
      setReauthBusy(false);
      if (reauthFor === 'off') await off(true);
      else await makeKeys();
    } catch (e) {
      setReauthNote(e instanceof Error ? e.message : 'Could not confirm your password');
      setReauthBusy(false);
    }
  };

  // mode=reauth: try fresh keys right away when the sign-in is recent (the server decides); ask for the
  // password only when it's too old.
  useEffect(() => {
    if (!reauthMode || step !== 'reauth' || (boot.status !== 'needs_reauth' && boot.status !== 'needs_restore')) return;
    let alive = true;
    void needsRecentSignIn()
      .catch(() => true)
      .then((needs) => {
        if (!alive) return;
        if (!needs || boot.status === 'needs_restore') void makeKeys();
        else void askReauth('keys');
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reauthMode, boot.status]);

  const title = reauthMode ? 'Encrypted chats' : 'Chat backup';
  const backdrop = { pattern: 'lines' as const, mesh: 'none' as const, glows: [{ x: 0, y: 0, color: colors.sky, opacity: 0.32 }] };

  if (!boot.me) {
    return (
      <Screen top={4} gap={16}>
        <ScreenHeader title={title} />
        <T color={colors.textSecondary}>Sign in to manage encrypted chats.</T>
      </Screen>
    );
  }
  if (step !== 'done' && step !== 'working' && (boot.status === 'idle' || boot.status === 'loading')) {
    return (
      <Screen top={4} gap={16}>
        <ScreenHeader title={title} />
        <Loading label="Checking your encryption keys" />
      </Screen>
    );
  }
  if (reauthMode && ready && step !== 'done' && step !== 'working') {
    return (
      <Screen top={4} gap={16}>
        <ScreenHeader title={title} />
        <Glass padding={4}>
          <ListRow title="Encryption is on" subtitle="Your chats on this phone are end-to-end encrypted." icon="lock" />
        </Glass>
        <Button label="Done" onPress={finish} />
      </Screen>
    );
  }
  if (!reauthMode && !ready && step !== 'done') {
    // Backup needs this phone's keys: restore / skip first (the Messages inbox offers the same).
    return (
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title={title} />
        {boot.status === 'error' ? (
          <ErrorState message={boot.error ?? 'Encryption keys couldn’t load.'} onRetry={() => boot.me && void initE2EE(boot.me)} />
        ) : (
          <>
            <T size={15} lineHeight={22} color={colors.textSecondary}>
              {boot.status === 'needs_reauth'
                ? 'Confirm your password to turn on encrypted chats on this phone first.'
                : boot.restoreReason === 'backup'
                  ? 'You have a chat backup. Restore it on this phone first, or skip to start with new keys.'
                  : 'Turn on encrypted chats on this phone first.'}
            </T>
            {boot.status === 'needs_restore' && boot.restoreReason === 'backup' ? <Button label="Restore with PIN" icon="lock" onPress={() => router.replace('/e2ee-restore')} /> : null}
            <Button label={boot.status === 'needs_reauth' ? 'Confirm password' : 'Use new keys on this phone'} variant="secondary" onPress={() => router.replace({ pathname: '/e2ee-setup', params: { mode: 'reauth' } })} />
          </>
        )}
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={18} backdrop={backdrop} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title={title} back={step === 'working' ? false : 'back'} />

      {step === 'overview' ? (
        loadError ? (
          <ErrorState message={loadError} onRetry={loadBackup} />
        ) : backup === null ? (
          <Loading label="Checking your backup" />
        ) : backup ? (
          <>
            <Glass padding={4}>
              <ListRow title="Chat backup is on" subtitle="Your keys are backed up, encrypted with your PIN. A new phone can restore your chat history." icon="check" minHeight={84} />
            </Glass>
            {error ? (
              <T size={13} color={colors.error} accessibilityLiveRegion="polite">
                {error}
              </T>
            ) : null}
            <Button
              label="Change PIN"
              icon="lock"
              onPress={() => {
                resetEntry();
                setChanging(true);
                setStep('old');
              }}
            />
            <Button label="Turn off backup" variant="destructive" onPress={() => void off()} />
            <T size={13} lineHeight={19} color={colors.textSecondary}>
              {PIN_LIMIT}
            </T>
          </>
        ) : (
          <>
            <View style={{ alignItems: 'center', gap: 12, paddingTop: 8 }}>
              <IconTile icon="lock" size={72} iconSize={34} color={colors.sky} />
              <T size={22} weight={700} align="center">
                Back up your chats
              </T>
            </View>
            <Glass padding={4}>
              {FACTS.map((f, i) => (
                <ListRow key={f.title} title={f.title} subtitle={f.subtitle} icon={f.icon} divider={i < FACTS.length - 1} minHeight={84} />
              ))}
            </Glass>
            {error ? (
              <T size={13} color={colors.error} accessibilityLiveRegion="polite">
                {error}
              </T>
            ) : null}
            <Button
              label="Turn on backup"
              icon="lock"
              onPress={() => {
                resetEntry();
                setChanging(false);
                setStep('pin');
              }}
            />
          </>
        )
      ) : null}

      {step === 'old' ? (
        <PinField
          label="Enter your current PIN"
          value={oldPin}
          error={error}
          onChange={(v) => {
            setOldPin(v);
            setError(undefined);
            if (v.length === PIN_LENGTH) setStep('pin');
          }}
        />
      ) : null}

      {step === 'pin' ? (
        <>
          <T size={13} lineHeight={19} color={colors.textSecondary}>
            {PIN_LIMIT}
          </T>
          <PinField
            label={changing ? `Choose a new ${PIN_LENGTH}-digit PIN` : `Choose a ${PIN_LENGTH}-digit PIN`}
            value={pin}
            error={error}
            onChange={(v) => {
              setPin(v);
              setError(undefined);
              if (v.length === PIN_LENGTH) {
                if (weakPin(v)) {
                  setError('Pick a PIN that’s harder to guess.');
                  return;
                }
                setStep('confirm');
              }
            }}
          />
        </>
      ) : null}

      {step === 'confirm' ? (
        <>
          <PinField
            label="Enter the PIN again"
            value={again}
            error={error}
            onChange={(v) => {
              setAgain(v);
              setError(undefined);
              if (v.length === PIN_LENGTH) void save(v);
            }}
          />
          <View style={{ alignItems: 'center' }}>
            <LinkText
              label="Choose a different PIN"
              onPress={() => {
                setPin('');
                setAgain('');
                setError(undefined);
                setStep('pin');
              }}
            />
          </View>
        </>
      ) : null}

      {step === 'reauth' ? (
        <View style={{ gap: 14 }}>
          <T size={16} weight={600}>
            Confirm it’s you
          </T>
          <T size={14} lineHeight={20} color={colors.textSecondary}>
            {reauthFor === 'off'
              ? 'Turning off chat backup deletes it, so Zoyra asks for your password first.'
              : 'Turning on encrypted chats on this phone gives your account new keys and signs your other phones out of encrypted chats, so Zoyra asks for your password first.'}
          </T>
          <TextField label="Password" placeholder="Your Zoyra password" icon="lock" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" returnKeyType="done" onSubmitEditing={() => void confirmPassword()} autoFocus />
          {reauthNote ? (
            <T size={13} color={colors.error} accessibilityLiveRegion="polite">
              {reauthNote}
            </T>
          ) : null}
          <Button label={reauthBusy ? 'Checking…' : 'Confirm'} icon="lock" onPress={password && !reauthBusy ? () => void confirmPassword() : undefined} />
        </View>
      ) : null}

      {step === 'working' ? (
        <View style={{ gap: 14, paddingTop: 24 }}>
          <T size={16} weight={600} align="center">
            {reauthMode ? 'Setting up encrypted chats…' : progress < 1 ? 'Protecting your keys with your PIN…' : 'Saving your encrypted backup…'}
          </T>
          <ProgressBar value={Math.max(0.04, Math.min(1, progress))} />
          {reauthMode ? null : (
            <T size={13} color={colors.textSecondary} align="center">
              This takes a moment on purpose: it makes your PIN much harder to guess.
            </T>
          )}
        </View>
      ) : null}

      {step === 'done' ? (
        <>
          <View style={{ alignItems: 'center', gap: 12, paddingTop: 16 }}>
            <IconTile icon="check" size={72} iconSize={34} color={colors.success} />
            <T size={22} weight={700} align="center">
              {reauthMode ? 'Encryption is on' : 'All set'}
            </T>
            <T size={14} lineHeight={20} color={colors.textSecondary} align="center">
              {doneText}
            </T>
          </View>
          <Button label="Done" onPress={finish} />
        </>
      ) : null}
    </Screen>
  );
}
