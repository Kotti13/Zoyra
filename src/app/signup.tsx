import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Button, Glass, Icon, IconButton, LinkText, Row, Screen, ScreenHeader, T, TextField } from '../components';
import { useAuth, type OAuthProvider } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

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

/** 0–4 score: length, mixed case, digit, symbol. */
function strength(p: string) {
  if (!p) return 0;
  let s = p.length >= 8 ? 1 : 0;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return Math.max(1, s);
}
const strengthLabel = ['Enter a password', 'Weak password', 'Fair password', 'Strong password', 'Very strong password'];
const strengthColor = [colors.track, colors.error, colors.warning, colors.success, colors.success];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Errors = { name?: string; email?: string; password?: string; form?: string };

export default function Signup() {
  const { signUp, signInWithProvider, resendConfirmation } = useAuth();
  const [resending, setResending] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<OAuthProvider | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [note, setNote] = useState<string>();
  const score = strength(password);
  const canSubmit = agreed && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    const e = email.trim();
    const next: Errors = {};
    if (!name.trim()) next.name = 'Tell us what to call you';
    if (!EMAIL_RE.test(e)) next.email = 'Enter a valid email address';
    if (password.length < 8) next.password = 'Use at least 8 characters';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await signUp(e, password, name.trim());
      setSentTo(e);
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : 'Could not create your account' });
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!sentTo) return;
    setResending(true);
    setResendNote(null);
    try {
      await resendConfirmation(sentTo);
      setResendNote(`Sent again to ${sentTo}. It can take a minute to arrive.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not resend';
      setResendNote(/rate|seconds|security purposes/i.test(msg) ? 'Please wait a minute before asking for another email.' : msg);
    } finally {
      setResending(false);
    }
  };

  if (sentTo) {
    return (
      <Screen top={4} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={{ pattern: 'lines', mesh: 'amber' }}>
        <ScreenHeader />
        <View style={{ gap: 8 }}>
          <T variant="display" lineHeight={32} accessibilityRole="header">
            Check your email to confirm
          </T>
          <T size={16} lineHeight={23} color={colors.textSecondary}>
            {`We sent a confirmation link to ${sentTo}. Open it on this device, then log in.`}
          </T>
        </View>
        <Glass padding={16}>
          <Row align="flex-start">
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.amber, 0.16), alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="mail" size={20} color={colors.amber} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <T size={15} weight={600}>
                Did not get it?
              </T>
              <T size={14} lineHeight={20} color={colors.textSecondary}>
                Look in spam, or go back and check the address you typed.
              </T>
            </View>
          </Row>
        </Glass>
        {resendNote ? (
          <T size={13} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
            {resendNote}
          </T>
        ) : null}
        <View style={{ flex: 1 }} />
        <Button label={resending ? 'Sending…' : 'Resend email'} variant={resending ? 'disabled' : 'glass'} onPress={() => void resend()} />
        <Button label="Go to log in" onPress={() => router.replace('/login')} />
        <Row style={{ justifyContent: 'center' }}>
          <LinkText label="Use a different email" onPress={() => setSentTo(null)} />
        </Row>
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'amber' }}>
      <ScreenHeader />

      <View style={{ gap: 8 }}>
        <T variant="display" lineHeight={32} accessibilityRole="header">
          Create your account
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          Takes less than a minute.
        </T>
      </View>

      <TextField label="Display name" value={name} onChangeText={setName} placeholder="Your name" autoComplete="name" error={errors.name} />
      <TextField
        label="Email"
        icon="mail"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        error={errors.email}
      />
      <PasswordField label="Password" placeholder="Create a password" value={password} onChangeText={setPassword} />
      {errors.password ? (
        <T size={12} color={colors.error} style={{ marginTop: -10 }}>
          {errors.password}
        </T>
      ) : null}

      <View style={{ gap: 6, marginTop: -8 }}>
        <Row gap={4}>
          {[1, 2, 3, 4].map((i) => (
            <View key={i} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: i <= score ? strengthColor[score] : colors.track }} />
          ))}
        </Row>
        <T variant="caption" weight={400} color={colors.textSecondary}>
          {strengthLabel[score]}
        </T>
      </View>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: agreed }}
        onPress={() => setAgreed((a) => !a)}
        style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <View
          style={{
            width: 24,
            height: 24,
            borderRadius: 10,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: agreed ? colors.accent : 'transparent',
            borderWidth: agreed ? 0 : 1.5,
            borderColor: colors.handle,
          }}
        >
          {agreed ? <Icon name="check" size={16} color={colors.onAccent} /> : null}
        </View>
        <T size={14} lineHeight={20} color={colors.textSecondary} style={{ flex: 1 }}>
          I agree to the Terms and Privacy Policy
        </T>
      </Pressable>

      {errors.form ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {errors.form}
        </T>
      ) : null}

      <Button label={busy ? 'Creating account…' : 'Create account'} variant={canSubmit ? 'primary' : 'disabled'} onPress={submit} />

      <Row>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.hairline }} />
        <T variant="caption" weight={400} color={colors.textSecondary}>
          or continue with
        </T>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.hairline }} />
      </Row>

      <Row>
        {(['google', 'apple'] as const).map((p) => (
          <Button
            key={p}
            label={oauthBusy === p ? 'Opening…' : p === 'google' ? 'Google' : 'Apple'}
            icon={p === 'google' ? 'globe' : 'phone'}
            variant={oauthBusy ? 'disabled' : 'glass'}
            onPress={() => {
              if (oauthBusy) return;
              setNote(undefined);
              setOauthBusy(p);
              // On success the root auth gate routes to onboarding.
              signInWithProvider(p)
                .catch((e: unknown) => setNote(e instanceof Error ? e.message : 'Could not sign in'))
                .finally(() => setOauthBusy(null));
            }}
            style={{ flex: 1 }}
          />
        ))}
      </Row>
      {note ? (
        <T size={13} lineHeight={18} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}

      <Row gap={4} style={{ justifyContent: 'center' }}>
        <T size={14} color={colors.textSecondary}>
          Already have an account?
        </T>
        <LinkText label="Log in" href="/login" />
      </Row>
    </Screen>
  );
}
