import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Glass, Icon, LinkText, Row, Screen, ScreenHeader, T, Tap, TextField } from '../components';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const LENGTH = 6;
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'] as const;

/** Supabase's phone-provider errors are terse; make the common ones readable. */
function friendly(err: unknown, fallback: string) {
  const m = err instanceof Error ? err.message : '';
  if (/provider|sms|phone.*(disabled|not enabled)|unsupported/i.test(m)) return `Phone sign-in is not available yet (${m}). Use email for now.`;
  if (/expired|invalid/i.test(m)) return 'That code is invalid or expired. Check it or resend a new one.';
  return m || fallback;
}

/** +91 98•••• 4210 style mask. */
function mask(phone: string) {
  const d = phone.replace(/\s/g, '');
  if (d.length < 8) return d;
  return `${d.slice(0, d.length - 8)}${d.slice(-8, -6)}•••• ${d.slice(-4)}`;
}

export default function Otp() {
  const { sendPhoneOtp, verifyPhoneOtp } = useAuth();
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const send = async (to: string) => {
    if (busy) return;
    const p = to.replace(/[\s()-]/g, '');
    if (!/^\+\d{8,15}$/.test(p)) return setError('Enter your number with country code, like +91 98765 43210');
    setError(undefined);
    setBusy(true);
    try {
      await sendPhoneOtp(p);
      setSentTo(p);
      setCode('');
      setSeconds(30);
    } catch (err) {
      setError(friendly(err, 'Could not send the code'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (busy || !sentTo || code.length < LENGTH) return;
    setError(undefined);
    setBusy(true);
    try {
      await verifyPhoneOtp(sentTo, code);
      // The root auth gate routes to onboarding or Home once the session lands.
    } catch (err) {
      setError(friendly(err, 'Could not verify the code'));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (seconds <= 0) return;
    const id = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [seconds]);

  const press = (k: (typeof keys)[number]) => {
    if (k === 'del') setCode((c) => c.slice(0, -1));
    else if (k) setCode((c) => (c.length < LENGTH ? c + k : c));
    setError(undefined);
  };

  if (!sentTo) {
    return (
      <Screen top={4} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={{ pattern: 'dots', mesh: 'peach' }}>
        <ScreenHeader />
        <View style={{ gap: 8 }}>
          <T variant="display" lineHeight={32} accessibilityRole="header">
            Log in with your phone
          </T>
          <T size={16} lineHeight={23} color={colors.textSecondary}>
            We will text you a 6-digit code.
          </T>
        </View>
        <TextField
          label="Phone number"
          icon="phone"
          value={phone}
          onChangeText={(v) => {
            setPhone(v);
            setError(undefined);
          }}
          placeholder="+91 98765 43210"
          keyboardType="phone-pad"
          autoComplete="tel"
          autoFocus
          error={error}
        />
        <Button label={busy ? 'Sending…' : 'Send code'} variant={busy ? 'disabled' : 'primary'} onPress={() => void send(phone)} />
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={{ pattern: 'dots', mesh: 'peach' }}>
      <ScreenHeader />

      <View style={{ gap: 8 }}>
        <T variant="display" lineHeight={32} accessibilityRole="header">
          Verify your number
        </T>
        <T size={16} lineHeight={23} color={colors.textSecondary}>
          {`We sent a 6-digit code to ${mask(sentTo)}.`}
        </T>
      </View>

      {/* Code boxes */}
      <Row gap={8} accessible accessibilityLabel={`Verification code, ${code.length} of ${LENGTH} digits entered`}>
        {Array.from({ length: LENGTH }, (_, i) => {
          const on = i <= code.length; // filled digits + the active box
          return (
            <View
              key={i}
              style={{
                flex: 1,
                height: 56,
                borderRadius: 28,
                backgroundColor: colors.bgTertiary,
                borderWidth: 1,
                borderColor: on ? colors.accent : colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <T mono weight={500} size={24}>
                {code[i] ?? ''}
              </T>
            </View>
          );
        })}
      </Row>

      <Row gap={8} style={{ justifyContent: 'center', minHeight: 44 }}>
        {seconds > 0 ? (
          <>
            <T size={14} color={colors.textSecondary}>
              Resend code in
            </T>
            <T mono size={14}>
              {`0:${String(seconds).padStart(2, '0')}`}
            </T>
          </>
        ) : (
          <LinkText label="Resend code" onPress={() => void send(sentTo)} />
        )}
      </Row>

      {error ? (
        <T size={13} lineHeight={18} color={colors.error} align="center" accessibilityLiveRegion="polite" style={{ marginTop: -12 }}>
          {error}
        </T>
      ) : null}

      <Button label={busy ? 'Verifying…' : 'Verify'} variant={code.length === LENGTH && !busy ? 'primary' : 'disabled'} onPress={() => void verify()} />

      <View style={{ flex: 1 }} />

      {/* Keypad */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {keys.map((k, i) =>
          k === '' ? (
            <View key={i} style={{ width: '31%', flexGrow: 1 }} />
          ) : k === 'del' ? (
            <Tap key={i} accessibilityLabel="Delete" onPress={() => press(k)} style={{ width: '31%', flexGrow: 1, height: 52, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="back" size={24} />
            </Tap>
          ) : (
            <Tap key={i} accessibilityLabel={k} onPress={() => press(k)} style={{ width: '31%', flexGrow: 1, height: 52 }}>
              <Glass radius={22} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <T size={22} weight={500}>
                  {k}
                </T>
              </Glass>
            </Tap>
          ),
        )}
      </View>
    </Screen>
  );
}
