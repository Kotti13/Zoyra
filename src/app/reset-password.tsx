import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Screen, ScreenHeader, T, TextField, Toast } from '../components';
import { flash } from '../lib/flash';
import { supabase } from '../lib/supabase';
import { clearRecovery, useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

/** Opened by a password-reset email link (the link signs the user in for this purpose only). */
export default function ResetPassword() {
  const { session } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (password.length < 8) return setError('Use at least 8 characters.');
    if (password !== confirm) return setError('The passwords don’t match.');
    setBusy(true);
    try {
      const { error: e } = await supabase.auth.updateUser({ password });
      if (e) throw new Error(e.message);
      clearRecovery();
      flash('Password updated');
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update your password');
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <Screen top={4} gap={16}>
        <ScreenHeader title="Reset password" />
        <T color={colors.textSecondary} lineHeight={21}>
          This reset link has expired or was opened on another device. Request a new link and open it on this phone.
        </T>
        <Button label="Send a new link" onPress={() => router.replace('/forgot')} />
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={16}>
      <ScreenHeader title="Choose a new password" back={false} />
      <T color={colors.textSecondary} lineHeight={21}>
        Signed in as {session.user.email}. Set a new password to finish.
      </T>
      <View style={{ gap: 12 }}>
        <TextField label="New password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" />
        <TextField label="Confirm password" value={confirm} onChangeText={setConfirm} secureTextEntry autoComplete="new-password" />
      </View>
      {error ? <Toast icon="info" iconColor={colors.error} message={error} /> : null}
      <Button label={busy ? 'Saving…' : 'Save password'} variant={busy ? 'disabled' : 'primary'} onPress={() => void save()} />
    </Screen>
  );
}
