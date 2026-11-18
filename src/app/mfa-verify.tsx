import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorState, LinkText, Loading, Screen, T, TextField } from '../components';
import { verifiedTotpFactor, verifyTotp } from '../lib/mfa';
import { supabase } from '../lib/supabase';
import { prepareSignOut, setAfterSignOutRoute } from '../state/auth';
import { colors } from '../theme/tokens';

/** Second login step for accounts with two-factor on: enter the code from the authenticator app. */
export default function MfaVerify() {
  const [factor, setFactor] = useState<{ id: string } | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    verifiedTotpFactor()
      .then((f) => {
        if (!alive) return;
        setFactor(f);
        if (!f) router.replace('/'); // Nothing to verify.
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : 'Could not load your sign-in steps'));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const submit = async () => {
    if (busy || !factor) return;
    if (code.length !== 6) return setError('Enter the 6-digit code from your app');
    setBusy(true);
    setError(undefined);
    try {
      await verifyTotp(factor.id, code);
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not verify that code');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const switchAccount = async () => {
    // The AuthGate resets the stack after the sign-out and opens /login (not Welcome).
    setAfterSignOutRoute('/login');
    await prepareSignOut();
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  };

  return (
    <Screen top={20} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <View style={{ gap: 8 }}>
        <T variant="hero" lineHeight={37} accessibilityRole="header">
          Enter your code
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Two-factor is on for this account. Open your authenticator app and enter the 6-digit code for Zoyra.
        </T>
      </View>

      {loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            setLoadError(undefined);
            setAttempt((n) => n + 1);
          }}
        />
      ) : factor === undefined ? (
        <Loading />
      ) : (
        <>
          <TextField
            label="6-digit code"
            icon="lock"
            value={code}
            onChangeText={(v) => {
              setCode(v.replace(/\D/g, '').slice(0, 6));
              setError(undefined);
            }}
            placeholder="123456"
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
            autoFocus
            onSubmitEditing={() => void submit()}
            error={error}
          />
          <Button label={busy ? 'Verifying…' : 'Verify'} variant={busy || code.length !== 6 ? 'disabled' : 'primary'} onPress={() => void submit()} />
        </>
      )}

      <View style={{ flex: 1 }} />

      <T size={13} lineHeight={18} color={colors.textSecondary} align="center">
        Lost your authenticator app? Contact Zoyra support to recover your account.
      </T>
      <View style={{ alignItems: 'center' }}>
        <LinkText label="Use a different account" onPress={() => void switchAccount()} />
      </View>
    </Screen>
  );
}
