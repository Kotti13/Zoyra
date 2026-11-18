import type { Session, User } from '@supabase/supabase-js';
import { makeRedirectUri } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { supabase } from '../lib/supabase';

export type Profile = {
  id: string;
  username: string | null;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  is_private: boolean;
  plan: 'free' | 'premium' | 'family' | 'student';
  created_at: string;
};

export type Settings = {
  genres: string[];
  languages: string[];
  favorite_artists: { id: string; name: string; image?: string }[];
  audio_quality: 'low' | 'normal' | 'high' | 'lossless';
  crossfade_seconds: number;
  gapless: boolean;
  normalize: boolean;
  equalizer: { enabled: boolean; preset: string; bands: number[] };
  theme: string;
  accent: string;
  notifications: Record<string, boolean | string>;
  privacy: Record<string, boolean>;
  /** Message privacy (`user_settings.dm`); unset keys use DM_DEFAULTS in src/lib/dm.ts. */
  dm?: Partial<import('../lib/dm').DmSettings>;
  /** Kids mode (`user_settings.kids`); see src/lib/kids.ts. */
  kids?: import('../lib/kids-types').KidsConfig | null;
  onboarded: boolean;
};

type AuthState = {
  ready: boolean;
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  settings: Settings | null;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  sendPhoneOtp: (phone: string) => Promise<void>;
  verifyPhoneOtp: (phone: string, token: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  /** Re-send the sign-up confirmation email. */
  resendConfirmation: (email: string) => Promise<void>;
  /** Google / Apple via Supabase OAuth. Resolves false if the user closed the browser. */
  signInWithProvider: (provider: OAuthProvider) => Promise<boolean>;
  signOut: () => Promise<void>;
  updateProfile: (patch: Partial<Omit<Profile, 'id' | 'created_at'>>) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  refresh: () => Promise<void>;
};

export type OAuthProvider = 'google' | 'apple';

const Ctx = createContext<AuthState | null>(null);

const PROVIDER_NAME: Record<OAuthProvider, string> = { google: 'Google', apple: 'Apple' };

/** Thrown when the provider is switched off in Supabase Auth → Providers. */
export class ProviderDisabledError extends Error {
  constructor(provider: OAuthProvider) {
    super(`${PROVIDER_NAME[provider]} sign-in isn't enabled yet`);
    this.name = 'ProviderDisabledError';
  }
}

export const oauthRedirectUri = () => makeRedirectUri({ scheme: 'zoyra', path: 'auth-callback' });

/** Reads `external.<provider>` from the public Auth settings endpoint. Null when it can't tell. */
async function providerEnabled(provider: OAuthProvider): Promise<boolean | null> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_KEY;
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
    if (!res.ok) return null;
    const body = (await res.json()) as { external?: Record<string, boolean> };
    const v = body.external?.[provider];
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

/** Parameters from both the query string and the #fragment of a redirect URL. */
function redirectParams(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const [beforeHash, hash = ''] = url.split('#');
  const query = beforeHash.includes('?') ? beforeHash.slice(beforeHash.indexOf('?') + 1) : '';
  for (const part of [query, hash]) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const i = pair.indexOf('=');
      const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      const v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      out[k] = v;
    }
  }
  return out;
}

const inFlight = new Map<string, Promise<boolean>>();

/** Set when a password-reset (recovery) link signs the user in; the auth gate then opens /reset-password. */
/** Where the AuthGate goes after a sign-out ('/welcome' unless a screen asked for e.g. '/login'). */
let afterSignOut: string | null = null;
export const setAfterSignOutRoute = (path: string) => {
  afterSignOut = path;
};
export const takeAfterSignOutRoute = (): string => {
  const p = afterSignOut ?? '/welcome';
  afterSignOut = null;
  return p;
};

/**
 * Work that needs the session (end a call, unregister this phone's push / VoIP tokens) before signing out.
 * Lazy import: src/lib/sign-out pulls in chat / push modules. Never throws.
 */
export async function prepareSignOut(): Promise<void> {
  await import('../lib/sign-out').then((m) => m.beforeSignOut()).catch(() => undefined);
}

let recoveryPending = false;
export const isRecoveryPending = () => recoveryPending;
export const clearRecovery = () => {
  recoveryPending = false;
};

type EmailOtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email';
const OTP_TYPES: readonly EmailOtpType[] = ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email'];

/**
 * Finish an OAuth redirect: PKCE `?code=` → exchangeCodeForSession, implicit `#access_token` → setSession.
 * Returns false when the URL carries no auth data. Safe to call twice with the same URL (the in-app
 * browser result and the cold deep-link route can both see it).
 */
export function completeOAuthRedirect(url: string): Promise<boolean> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const run = (async () => {
    const p = redirectParams(url);
    if (p.error || p.error_description) {
      const msg = p.error_description || p.error;
      if (/provider is not enabled|unsupported provider/i.test(msg)) throw new Error("This sign-in method isn't enabled yet");
      throw new Error(msg);
    }
    if (p.type === 'recovery') recoveryPending = true;
    // Email links using a custom template ({{ .TokenHash }}) work on any device: verify the hash directly.
    if (p.token_hash && (OTP_TYPES as readonly string[]).includes(p.type ?? '')) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: p.token_hash, type: p.type as EmailOtpType });
      if (error) throw new Error(/expired|invalid/i.test(error.message) ? 'This link has expired or was already used. Request a new one.' : error.message);
      return true;
    }
    if (p.code) {
      const { error } = await supabase.auth.exchangeCodeForSession(p.code);
      if (error) {
        if (/code verifier|both auth code and code verifier/i.test(error.message)) {
          throw new Error('Open the link on the same phone where you signed up. Your email is confirmed: you can log in now.');
        }
        throw new Error(error.message);
      }
      return true;
    }
    if (p.access_token && p.refresh_token) {
      const { error } = await supabase.auth.setSession({ access_token: p.access_token, refresh_token: p.refresh_token });
      if (error) throw new Error(error.message);
      return true;
    }
    return false;
  })();
  inFlight.set(url, run);
  run.catch(() => inFlight.delete(url));
  return run;
}

async function signInWithProvider(provider: OAuthProvider): Promise<boolean> {
  if ((await providerEnabled(provider)) === false) throw new ProviderDisabledError(provider);
  const redirectTo = oauthRedirectUri();
  // NOTE: PKCE (a `?code=` redirect) needs `auth.flowType: 'pkce'` on the client in src/lib/supabase.ts;
  // signInWithOAuth has no per-call flow option. Until then Supabase redirects with #access_token, which
  // completeOAuthRedirect also handles.
  const { data, error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } });
  if (error) {
    if (/not enabled|unsupported provider/i.test(error.message)) throw new ProviderDisabledError(provider);
    throw new Error(error.message);
  }
  if (!data.url) throw new Error(`Could not start ${PROVIDER_NAME[provider]} sign-in`);
  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
  if (result.type !== 'success') return false;
  try {
    const done = await completeOAuthRedirect(result.url);
    if (!done) throw new Error(`${PROVIDER_NAME[provider]} sign-in did not return a session`);
    return true;
  } catch (e) {
    if (e instanceof Error && /isn't enabled yet/.test(e.message)) throw new ProviderDisabledError(provider);
    throw e;
  }
}

const fail = (e: { message: string } | null) => {
  if (e) throw new Error(e.message);
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);

  const load = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      setSettings(null);
      return;
    }
    const [p, st] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).single(),
      supabase.from('user_settings').select('*').eq('user_id', s.user.id).single(),
    ]);
    setProfile((p.data as Profile) ?? null);
    setSettings((st.data as Settings) ?? null);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await load(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      void load(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      session,
      user: session?.user ?? null,
      profile,
      settings,
      signUp: async (email, password, displayName) => {
        // Confirmation link returns into the app (zoyra://auth-callback; exp://…/--/auth-callback in Expo Go).
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: displayName }, emailRedirectTo: oauthRedirectUri() } });
        fail(error);
      },
      signIn: async (email, password) => fail((await supabase.auth.signInWithPassword({ email, password })).error),
      sendPhoneOtp: async (phone) => fail((await supabase.auth.signInWithOtp({ phone })).error),
      verifyPhoneOtp: async (phone, token) => fail((await supabase.auth.verifyOtp({ phone, token, type: 'sms' })).error),
      resetPassword: async (email) => fail((await supabase.auth.resetPasswordForEmail(email, { redirectTo: oauthRedirectUri() })).error),
      resendConfirmation: async (email) => fail((await supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: oauthRedirectUri() } })).error),
      signInWithProvider,
      signOut: async () => {
        await prepareSignOut();
        // 'local': only this phone. The default ('global') would also sign the user out on every other device.
        fail((await supabase.auth.signOut({ scope: 'local' })).error);
      },
      updateProfile: async (patch) => {
        if (!session) throw new Error('Sign in to update your profile');
        const { data, error } = await supabase
          .from('profiles')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('id', session.user.id)
          .select()
          .single();
        fail(error);
        setProfile(data as Profile);
      },
      updateSettings: async (patch) => {
        if (!session) throw new Error('Sign in to change settings');
        setSettings((s) => (s ? { ...s, ...patch } : s)); // optimistic
        const { error } = await supabase
          .from('user_settings')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('user_id', session.user.id);
        fail(error);
      },
      refresh: () => load(session),
    }),
    [ready, session, profile, settings, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
