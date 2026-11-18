/**
 * Devices and sessions.
 *
 * With migration 20261113211000_sessions.sql applied, every signed-in device is listed from
 * auth.sessions (via the `list_my_sessions` RPC) and can be signed out one by one (`revoke_my_session`).
 * Each app labels its own session (model, OS, app version) in `user_sessions` with a heartbeat.
 * Without the migration, only this device is shown, read from the access token.
 */
import type { Session } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { supabase } from './supabase';

export type DeviceSession = {
  id: string;
  createdAt: string | null;
  lastActiveAt: string | null;
  name: string;
  detail: string;
  platform: 'ios' | 'android' | 'web' | 'other' | null;
  current: boolean;
  /** "aal2" when signed in with two-step verification. */
  aal: string | null;
};

type JwtClaims = { session_id?: string; iat?: number; exp?: number; aal?: string; amr?: { method: string; timestamp: number }[] };

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = globalThis.atob(b64);
  try {
    return decodeURIComponent(
      Array.from(bin, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    );
  } catch {
    return bin;
  }
}

/** Claims of the access token (not verified; for display only). */
export function claims(session: Session | null): JwtClaims | null {
  const part = session?.access_token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(b64urlDecode(part)) as JwtClaims;
  } catch {
    return null;
  }
}

const PLATFORM = (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'other') as DeviceSession['platform'];
const OS_LABEL: Record<string, string> = { ios: 'iOS', android: 'Android', web: 'Web', other: 'Other' };

export const thisDeviceName = () => Device.modelName ?? Device.deviceName ?? (Platform.OS === 'web' ? 'Web browser' : 'This device');
const thisDeviceDetail = () => [Device.osName ?? OS_LABEL[PLATFORM ?? 'other'], Device.osVersion].filter(Boolean).join(' ');

/** Only this device, from the token (used when the sessions migration isn't applied). */
export function thisDeviceSession(session: Session | null): DeviceSession | null {
  if (!session) return null;
  const c = claims(session);
  const signedIn = c?.amr?.length ? Math.min(...c.amr.map((a) => a.timestamp)) : null;
  return {
    id: c?.session_id ?? 'current',
    createdAt: signedIn ? new Date(signedIn * 1000).toISOString() : (session.user.last_sign_in_at ?? null),
    lastActiveAt: c?.iat ? new Date(c.iat * 1000).toISOString() : null,
    name: thisDeviceName(),
    detail: thisDeviceDetail(),
    platform: PLATFORM,
    current: true,
    aal: c?.aal ?? null,
  };
}

/** Best-effort label from a raw User-Agent when a device never reported its own name. */
function fromUserAgent(ua: string | null): { name: string; platform: DeviceSession['platform'] } {
  if (!ua) return { name: 'Unknown device', platform: null };
  if (/iPad/i.test(ua)) return { name: 'iPad', platform: 'ios' };
  if (/iPhone|CFNetwork|Darwin/i.test(ua)) return { name: 'iPhone', platform: 'ios' };
  if (/Android|okhttp/i.test(ua)) return { name: 'Android device', platform: 'android' };
  if (/Macintosh/i.test(ua)) return { name: 'Mac browser', platform: 'web' };
  if (/Windows/i.test(ua)) return { name: 'Windows browser', platform: 'web' };
  if (/Linux/i.test(ua)) return { name: 'Linux browser', platform: 'web' };
  return { name: 'Unknown device', platform: 'other' };
}

type Row = {
  id: string;
  created_at: string | null;
  last_active_at: string | null;
  user_agent: string | null;
  aal: string | null;
  is_current: boolean;
  device_name: string | null;
  platform: DeviceSession['platform'];
  os_version: string | null;
  app_version: string | null;
};

export type SessionList = { supported: true; sessions: DeviceSession[] } | { supported: false; sessions: DeviceSession[] };

const missing = (code?: string, message?: string) => code === 'PGRST202' || code === '42883' || /could not find the function/i.test(message ?? '');

/** All of my live sessions, or `supported: false` + this device when the backend lacks the RPC. */
export async function listSessions(session: Session | null): Promise<SessionList> {
  const { data, error } = await supabase.rpc('list_my_sessions');
  if (error) {
    if (missing(error.code, error.message)) {
      const me = thisDeviceSession(session);
      return { supported: false, sessions: me ? [me] : [] };
    }
    throw new Error(error.message);
  }
  const rows = (data ?? []) as Row[];
  return {
    supported: true,
    sessions: rows.map((r) => {
      const guess = fromUserAgent(r.user_agent);
      const platform = r.platform ?? guess.platform;
      return {
        id: r.id,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        name: r.device_name ?? (r.is_current ? thisDeviceName() : guess.name),
        detail: [platform ? OS_LABEL[platform] : null, r.os_version, r.app_version ? `Zoyra ${r.app_version}` : null].filter(Boolean).join(' · '),
        platform,
        current: r.is_current,
        aal: r.aal,
      };
    }),
  };
}

/** Signs out one other device (its refresh token stops working right away). */
export async function revokeSession(id: string): Promise<void> {
  const { data, error } = await supabase.rpc('revoke_my_session', { p_session_id: id });
  if (error) throw new Error(error.message);
  if (data === false) throw new Error('That device was already signed out');
}

export async function signOutOthers(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: 'others' });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ heartbeat */

const BEAT_MS = 10 * 60_000;
let lastBeat: { id: string; at: number } | null = null;

/** Labels this session (model, OS, app version) and bumps last_seen_at. Silent no-op without the migration. */
export async function heartbeat(session: Session | null, force = false): Promise<void> {
  const id = claims(session)?.session_id;
  if (!session || !id) return;
  if (!force && lastBeat && lastBeat.id === id && Date.now() - lastBeat.at < BEAT_MS) return;
  lastBeat = { id, at: Date.now() };
  const { error } = await supabase.from('user_sessions').upsert(
    {
      session_id: id,
      user_id: session.user.id,
      device_name: thisDeviceName().slice(0, 100),
      platform: PLATFORM,
      os_version: (Device.osVersion ?? '').slice(0, 40) || null,
      app_version: (Constants.expoConfig?.version ?? '').slice(0, 40) || null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'session_id' },
  );
  if (error) lastBeat = null;
}

/** Mount once at the root (inside AuthProvider): heartbeat on sign-in and each time the app comes to the foreground. */
export function useSessionHeartbeat(session: Session | null) {
  useEffect(() => {
    if (!session) return;
    void heartbeat(session);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void heartbeat(session);
    });
    return () => sub.remove();
  }, [session]);
}
