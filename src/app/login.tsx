import * as LocalAuthentication from 'expo-local-authentication';
import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, IconButton, LinkText, Row, Screen, T, TextField } from '../components';
import type { IconName } from '../components';
import { mfaRequired } from '../lib/mfa';
import { supabase } from '../lib/supabase';
import { useAuth, type OAuthProvider } from '../state/auth';
import { colors, fonts } from '../theme/tokens';

/** Password input with a show/hide eye button (TextField's icon is decorative only). */
function PasswordField({ label, placeholder, value, onChangeText }: { label: string; placeholder: string; value: string; onChangeText: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <T variant="caption" color={colors.textSecondary}>
        {label}
      </T>
      <Row
        gap={8}
        style={{ height: 48, borderRadius: 24, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: focused ? colors.accent : colors.border, paddingLeft: 14, paddingRight: 0 }}
      >
        <TextInput
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          secureTextEntry={!show}
          autoCapitalize="none"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ flex: 1, minWidth: 0, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
        <IconButton icon="eye" label={show ? 'Hide password' : 'Show password'} iconSize={20} color={colors.textSecondary} onPress={() => setShow((s) => !s)} />
      </Row>
    </View>
  );
}

function OrDivider() {
  return (
    <Row>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.hairline }} />
      <T variant="caption" weight={400} color={colors.textSecondary}>
        or continue with
      </T>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.hairline }} />
    </Row>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Unlock an existing saved session with the device's biometrics. Returns a message to show, or null on success. */
async function unlockWithBiometrics(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return 'Face ID unlocks a saved session. Log in with your email once on this device first.';
  const [hasHardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
  if (!hasHardware || !enrolled) return 'Biometric unlock is not set up on this device.';
  const res = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Zoyra' });
  if (!res.success) return res.error === 'user_cancel' || res.error === 'system_cancel' ? null : 'Could not verify it is you. Try again or use your password.';
  // Face ID unlocks the device session, not the account's second factor.
  router.replace((await mfaRequired()) ? '/mfa-verify' : '/');
  return null;
}

export default function Login() {
  const { signIn, signInWithProvider } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);

  const oauth = (p: OAuthProvider) => {
    if (oauthBusy) return;
    setNote(undefined);
    setError(undefined);
    setOauthBusy(p);
    // On success the root auth gate routes to onboarding or Home once the session lands.
    signInWithProvider(p)
      .catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Could not sign in'))
      .finally(() => setOauthBusy(null));
  };

  const submit = async () => {
    if (busy) return;
    setNote(undefined);
    setError(undefined);
    const e = email.trim();
    if (!EMAIL_RE.test(e)) return setEmailError('Enter a valid email address');
    setEmailError(undefined);
    if (!password) return setError('Enter your password');
    setBusy(true);
    try {
      await signIn(e, password);
      // Accounts with two-factor on only reach aal1 here: ask for the authenticator code first.
      if (await mfaRequired()) router.replace('/mfa-verify');
      // Otherwise the root auth gate routes to onboarding or Home once the session lands.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log in');
    } finally {
      setBusy(false);
    }
  };

  const socials: { label: string; icon: IconName; onPress: () => void }[][] = [
    [
      { label: oauthBusy === 'google' ? 'Opening…' : 'Google', icon: 'globe', onPress: () => oauth('google') },
      { label: oauthBusy === 'apple' ? 'Opening…' : 'Apple', icon: 'phone', onPress: () => oauth('apple') },
    ],
    [
      { label: 'Phone OTP', icon: 'phone', onPress: () => router.push('/otp') },
      {
        label: 'Face ID',
        icon: 'faceId',
        onPress: () => {
          setNote(undefined);
          unlockWithBiometrics()
            .then((m) => m && setNote(m))
            .catch(() => setNote('Biometric unlock is not available right now.'));
        },
      },
    ],
  ];

  return (
    <Screen top={20} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <View style={{ gap: 8 }}>
        <T variant="hero" weight={300} lineHeight={37} accessibilityRole="header">
          Welcome back
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Log in to pick up where you left off.
        </T>
      </View>

      <TextField
        label="Email"
        icon="mail"
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          setEmailError(undefined);
        }}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        error={emailError}
      />
      <PasswordField label="Password" placeholder="Enter your password" value={password} onChangeText={setPassword} />
      {error ? (
        <T size={13} color={colors.error} style={{ marginTop: -12 }} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      <Row style={{ justifyContent: 'flex-end', marginTop: -12 }}>
        <LinkText label="Forgot password?" href="/forgot" />
      </Row>

      <Button label={busy ? 'Logging in…' : 'Log in'} variant={busy ? 'disabled' : 'primary'} onPress={submit} />

      <OrDivider />

      {socials.map((row, i) => (
        <Row key={i}>
          {row.map((s) => (
            <Button key={s.label} label={s.label} icon={s.icon} variant="glass" onPress={s.onPress} style={{ flex: 1 }} />
          ))}
        </Row>
      ))}

      {note ? (
        <T size={13} lineHeight={18} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}

      <View style={{ flex: 1 }} />

      <Row gap={4} style={{ justifyContent: 'center' }}>
        <T size={14} color={colors.textSecondary}>
          New to Zoyra?
        </T>
        <LinkText label="Sign up" href="/signup" />
      </Row>
    </Screen>
  );
}
