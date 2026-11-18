import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, ErrorState, Glass, LinkText, ListRow, Loading, Row, Screen, ScreenHeader, Sticker, T, TextField } from '../components';
import { confirmDialog } from '../lib/dialog';
import { friendlyMfaError, verifiedTotpFactor, verifyTotp } from '../lib/mfa';
import { supabase } from '../lib/supabase';
import { colors } from '../theme/tokens';

type Enrolment = { factorId: string; uri: string; secret: string };
type TotpFactor = { id: string; created_at: string };

const onlyDigits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

/** Groups the base32 secret in fours so it's easier to type into an authenticator app. */
const spaced = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

function confirmAsync(title: string, message: string, action: string): Promise<boolean> {
  return confirmDialog(title, message, action, true);
}

export default function TwoFactor() {
  /** undefined while loading, null when two-factor is off. */
  const [factor, setFactor] = useState<TotpFactor | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [enrol, setEnrol] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'start' | 'verify' | 'disable' | null>(null);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    let alive = true;
    verifiedTotpFactor()
      .then((f) => alive && setFactor(f))
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : 'Could not load two-factor status'));
    return () => {
      alive = false;
    };
  }, [attempt]);

  const reloadStatus = async () => {
    try {
      setFactor(await verifiedTotpFactor());
    } catch {
      setAttempt((n) => n + 1);
    }
  };

  const start = async () => {
    if (busy) return;
    setBusy('start');
    setError(undefined);
    setNote(undefined);
    try {
      // Drop half-finished setups first; an unverified factor would block a new enrolment.
      const { data: list, error: listErr } = await supabase.auth.mfa.listFactors();
      if (listErr) throw listErr;
      for (const f of list.all) {
        if (f.factor_type === 'totp' && f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error: e } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Zoyra ${new Date().toISOString().slice(0, 16)}`, issuer: 'Zoyra' });
      if (e) throw e;
      setEnrol({ factorId: data.id, uri: data.totp.uri, secret: data.totp.secret });
      setCode('');
    } catch (e) {
      setError(friendlyMfaError(e as { message?: string; code?: string }));
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    if (busy || !enrol) return;
    if (code.length !== 6) return setError('Enter the 6-digit code from your app');
    setBusy('verify');
    setError(undefined);
    try {
      await verifyTotp(enrol.factorId, code);
      setEnrol(null);
      setCode('');
      setNote('Two-factor is on. You will need a code from your app each time you log in.');
      await reloadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not verify that code');
    } finally {
      setBusy(null);
    }
  };

  const cancelEnrol = async () => {
    if (!enrol || busy) return;
    const id = enrol.factorId;
    setEnrol(null);
    setCode('');
    setError(undefined);
    await supabase.auth.mfa.unenroll({ factorId: id }).catch(() => {});
  };

  const disable = async () => {
    if (busy || !factor) return;
    if (code.length !== 6) return setError('Enter the 6-digit code from your app to turn two-factor off');
    if (!(await confirmAsync('Turn off two-factor?', 'Your account will be protected by your password only.', 'Turn off'))) return;
    setBusy('disable');
    setError(undefined);
    try {
      // Removing a verified factor needs an aal2 session: prove the code first.
      await verifyTotp(factor.id, code);
      const { error: e } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (e) throw new Error(friendlyMfaError(e));
      // Refresh so the session drops back to aal1 claims.
      await supabase.auth.refreshSession().catch(() => {});
      setDisabling(false);
      setCode('');
      setNote('Two-factor is off.');
      await reloadStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn off two-factor');
    } finally {
      setBusy(null);
    }
  };

  const copySecret = async () => {
    if (!enrol) return;
    try {
      await Clipboard.setStringAsync(enrol.secret);
      setNote('Secret copied. Paste it into your authenticator app.');
    } catch {
      setNote('Could not copy. Type the secret into your app instead.');
    }
  };

  const codeField = (
    <TextField
      label="6-digit code"
      icon="lock"
      value={code}
      onChangeText={(v) => {
        setCode(onlyDigits(v));
        setError(undefined);
      }}
      placeholder="123456"
      keyboardType="number-pad"
      autoComplete="one-time-code"
      textContentType="oneTimeCode"
      maxLength={6}
      error={error}
    />
  );

  const on = !!factor;

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'none', glows: [{ x: 0, y: 0, color: colors.sky, opacity: 0.32 }] }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Two-factor authentication" />

      {loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => {
            setLoadError(undefined);
            setAttempt((n) => n + 1);
          }}
        />
      ) : factor === undefined ? (
        <Loading label="Checking two-factor status" />
      ) : enrol ? (
        <>
          <T size={14} lineHeight={20} color={colors.textSecondary}>
            1. Scan this with an authenticator app (Google Authenticator, 1Password, Authy…).
          </T>
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 208, height: 208, padding: 12, borderRadius: 26, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="QR code for your authenticator app">
              <QRCode value={enrol.uri} size={184} color={colors.bg} backgroundColor={colors.white} ecl="M" />
            </View>
          </View>
          <Glass padding={14}>
            <Row gap={12}>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={13} color={colors.textSecondary}>
                  Or enter this secret
                </T>
                <T mono size={14} selectable>
                  {spaced(enrol.secret)}
                </T>
              </View>
              <LinkText label="Copy" onPress={() => void copySecret()} />
            </Row>
          </Glass>
          <T size={14} lineHeight={20} color={colors.textSecondary}>
            2. Enter the code the app shows.
          </T>
          {codeField}
          <Button label={busy === 'verify' ? 'Verifying…' : 'Turn on two-factor'} variant={busy || code.length !== 6 ? 'disabled' : 'primary'} onPress={() => void verify()} />
          <View style={{ alignItems: 'center' }}>
            <LinkText label="Cancel setup" onPress={() => void cancelEnrol()} />
          </View>
        </>
      ) : (
        <>
          <Glass padding={4}>
            <ListRow
              title="Authenticator app"
              subtitle={factor ? `Added ${new Date(factor.created_at).toLocaleDateString()}` : 'Not set up'}
              icon="shield"
              right={<Sticker label={on ? 'ON' : 'OFF'} bg={on ? colors.success : colors.handle} rotate={3} />}
            />
          </Glass>
          <T size={13} lineHeight={18} color={colors.textSecondary}>
            {on
              ? 'Each time you log in on a new device you will enter a 6-digit code from your authenticator app.'
              : 'Add a second step to logging in: a 6-digit code from an authenticator app on your phone.'}
          </T>

          {error && !disabling ? (
            <T size={13} color={colors.error} accessibilityLiveRegion="polite">
              {error}
            </T>
          ) : null}

          {on ? (
            disabling ? (
              <>
                {codeField}
                <Button label={busy === 'disable' ? 'Turning off…' : 'Turn off two-factor'} variant={busy || code.length !== 6 ? 'disabled' : 'destructive'} onPress={() => void disable()} />
                <View style={{ alignItems: 'center' }}>
                  <LinkText
                    label="Keep it on"
                    onPress={() => {
                      setDisabling(false);
                      setCode('');
                      setError(undefined);
                    }}
                  />
                </View>
              </>
            ) : (
              <Button label="Turn off two-factor" variant="destructive" onPress={() => setDisabling(true)} />
            )
          ) : (
            <Button label={busy === 'start' ? 'Starting…' : 'Set up authenticator app'} icon={busy === 'start' ? undefined : 'shield'} variant={busy ? 'disabled' : 'primary'} onPress={() => void start()} />
          )}
          {busy === 'start' ? <ActivityIndicator color={colors.accent} /> : null}
        </>
      )}

      {note ? (
        <T size={13} lineHeight={18} color={colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}
    </Screen>
  );
}
