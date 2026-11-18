/**
 * Recent sign-in for sensitive E2EE actions (key reset / device revoke). The server requires a session
 * whose JWT was issued in the last 10 minutes (`iat`); older sessions must confirm the password first.
 */
import { supabase } from './supabase';

export const REAUTH_MAX_AGE_S = 10 * 60;

function jwtIat(token: string | undefined): number | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')) : '';
    const iat = (JSON.parse(json) as { iat?: unknown }).iat;
    return typeof iat === 'number' ? iat : null;
  } catch {
    return null;
  }
}

/** True when the current session is older than the limit (or can't be read). */
export async function needsRecentSignIn(maxAgeS = REAUTH_MAX_AGE_S): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  const iat = jwtIat(data.session?.access_token);
  if (iat === null) return true;
  return Date.now() / 1000 - iat > maxAgeS - 30; // 30 s margin for the request itself
}

/** 'password' when the account can confirm with email + password; otherwise the OAuth provider name. */
export async function signInMethod(): Promise<{ kind: 'password'; email: string } | { kind: 'oauth'; provider: string }> {
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  const providers = ((u?.app_metadata?.providers as string[] | undefined) ?? [u?.app_metadata?.provider as string | undefined]).filter(Boolean) as string[];
  if (u?.email && (providers.length === 0 || providers.includes('email'))) return { kind: 'password', email: u.email };
  return { kind: 'oauth', provider: providers[0] ?? 'your sign-in provider' };
}

/** Confirms the password and refreshes the session (new `iat`). Throws a friendly Error. */
export async function reauthWithPassword(password: string): Promise<void> {
  const m = await signInMethod();
  if (m.kind !== 'password') throw new Error(`You signed in with ${m.provider}. Sign out and sign in again, then try once more.`);
  const { error } = await supabase.auth.signInWithPassword({ email: m.email, password });
  if (error) throw new Error(/invalid login credentials/i.test(error.message) ? 'That password isn’t right.' : error.message);
}

/** Server refused because the sign-in is too old. */
export function isReauthError(e: unknown): boolean {
  const x = e as { hint?: string; message?: string; pgCode?: string } | null;
  // Server (20261115280000_security_hardening.sql) raises hint 'e2ee_reauth' / 'Sign in again to reset…'.
  return x?.hint === 'reauth_required' || x?.hint === 'e2ee_reauth' || /recent sign.?in|sign in again|reauth/i.test(x?.message ?? '');
}
