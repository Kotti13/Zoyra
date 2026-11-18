import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';

/**
 * Two-factor (Supabase MFA, TOTP) helpers.
 * A password / OAuth / OTP sign-in only reaches aal1. If the account has a verified TOTP factor the
 * session must be stepped up to aal2 on `/mfa-verify` before the app treats it as signed in.
 */

/** True when this session still owes a 2FA code (current aal1, account can reach aal2). */
export async function mfaRequired(): Promise<boolean> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.nextLevel === 'aal2' && data.currentLevel !== 'aal2';
}

/**
 * For the root AuthGate: `null` while checking, then whether the session needs `/mfa-verify` first.
 * Re-checks whenever the session (its access token) changes.
 */
export function useMfaRequired(session: Session | null): boolean | null {
  const token = session?.access_token ?? null;
  const [state, setState] = useState<{ token: string | null; required: boolean } | null>(null);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    mfaRequired()
      .then((required) => alive && setState({ token, required }))
      .catch(() => alive && setState({ token, required: false }));
    return () => {
      alive = false;
    };
  }, [token]);
  if (!token) return false;
  return state && state.token === token ? state.required : null;
}

/** The verified TOTP factor, if the account has one. */
export async function verifiedTotpFactor(): Promise<{ id: string; friendly_name?: string; created_at: string } | null> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(error.message);
  return data.totp[0] ?? null;
}

/** Challenge + verify a 6-digit code. On success the session is upgraded to aal2. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) throw new Error(friendlyMfaError(error));
}

export function friendlyMfaError(e: { message?: string; code?: string } | null | undefined): string {
  const msg = e?.message ?? '';
  const code = e?.code ?? '';
  if (code === 'mfa_verification_failed' || /invalid totp|verification failed/i.test(msg)) return 'That code is not right. Check your authenticator app and try again.';
  if (code === 'mfa_challenge_expired' || /expired/i.test(msg)) return 'That code expired. Enter the newest one from your app.';
  if (code.startsWith('mfa_totp_enroll_not_enabled') || code === 'mfa_totp_verify_not_enabled' || /mfa.*(disabled|not enabled)/i.test(msg))
    return 'Two-factor needs Supabase setup: turn on TOTP under Authentication → Multi-Factor in the dashboard.';
  if (code === 'too_many_enrolled_mfa_factors') return 'Too many authenticators are set up. Remove one first.';
  if (code === 'insufficient_aal') return 'Enter a code from your authenticator app first.';
  return msg || 'Two-factor request failed. Try again.';
}
