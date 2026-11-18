import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Glass, Icon, LinkText, Row, Screen, ScreenHeader, T, TextField } from '../components';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const toLogin = () => router.replace('/login');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Forgot() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (busy) return;
    const e = email.trim();
    if (!EMAIL_RE.test(e)) return setError('Enter a valid email address');
    setError(undefined);
    setBusy(true);
    try {
      await resetPassword(e);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen top={4} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={{ pattern: 'grid', mesh: 'rose' }}>
      <ScreenHeader />

      <View style={{ gap: 8 }}>
        <T variant="display" lineHeight={32} accessibilityRole="header">
          Reset your password
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Enter your email and we will send you a link to choose a new one.
        </T>
      </View>

      <TextField
        label="Email"
        icon="mail"
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          setError(undefined);
          setSent(false);
        }}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoFocus
        error={error}
      />

      <Button label={busy ? 'Sending…' : sent ? 'Send again' : 'Send reset link'} variant={busy ? 'disabled' : 'primary'} onPress={submit} />

      {sent ? (
      <Glass padding={16}>
        <Row align="flex-start">
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.amber, 0.16), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="mail" size={20} color={colors.amber} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <T size={15} weight={600}>
              Check your inbox
            </T>
            <T size={14} lineHeight={20} color={colors.textSecondary}>
              {`If an account exists for ${email.trim()}, a reset link is on its way. If you do not see it, look in spam.`}
            </T>
          </View>
        </Row>
      </Glass>
      ) : null}

      <View style={{ flex: 1 }} />

      <Row style={{ justifyContent: 'center' }}>
        <LinkText label="Back to log in" onPress={toLogin} />
      </Row>
    </Screen>
  );
}
