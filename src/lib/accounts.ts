/**
 * Multi-account support: every account signed in on this device is remembered with its Supabase tokens,
 * so the Account switcher can swap sessions with `supabase.auth.setSession`.
 *
 * SECURITY NOTE: expo-secure-store isn't installed, so tokens are kept in AsyncStorage (unencrypted app
 * storage). That is the same place the Supabase client already keeps the active session
 * (src/lib/supabase.ts), so this adds no new exposure class, but it is not Keychain/Keystore protected.
 * Install expo-secure-store and swap `store` below to harden it.
 *
 * Supabase rotates refresh tokens, so the active account's saved tokens are refreshed on every auth
 * event (see `startAccountSync`). Never call signOut on an account you want to keep: it revokes its token.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';

import { supabase } from './supabase';

const KEY = 'zoyra.accounts.v1';
const store = AsyncStorage;

export type SavedAccount = {
  id: string;
  email: string | null;
  display_name: string;
  username: string | null;
  avatar_url: string | null;
  avatar_art: string | null;
  avatar_frame: string | null;
  plan: string | null;
  access_token: string;
  refresh_token: string;
  saved_at: string;
};

type ProfileLike = {
  display_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
  plan?: string | null;
} & Record<string, unknown>;

let cache: SavedAccount[] | null = null;
const listeners = new Set<(a: SavedAccount[]) => void>();

async function read(): Promise<SavedAccount[]> {
  if (cache) return cache;
  try {
    const raw = await store.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(parsed) ? (parsed as SavedAccount[]).filter((a) => a && typeof a.id === 'string' && typeof a.refresh_token === 'string') : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function write(next: SavedAccount[]) {
  cache = next;
  await store.setItem(KEY, JSON.stringify(next));
  for (const l of listeners) l(next);
}

export async function listAccounts(): Promise<SavedAccount[]> {
  return read();
}

/** Save (or update) the account behind `session`, optionally with fresh profile details. */
export async function rememberSession(session: Session, profile?: ProfileLike | null): Promise<void> {
  const list = await read();
  const prev = list.find((a) => a.id === session.user.id);
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const entry: SavedAccount = {
    id: session.user.id,
    email: session.user.email ?? prev?.email ?? null,
    display_name: profile?.display_name || prev?.display_name || session.user.email || 'Zoyra account',
    username: profile ? profile.username ?? null : prev?.username ?? null,
    avatar_url: profile ? profile.avatar_url ?? null : prev?.avatar_url ?? null,
    avatar_art: profile ? str(profile.avatar_art) : prev?.avatar_art ?? null,
    avatar_frame: profile ? str(profile.avatar_frame) : prev?.avatar_frame ?? null,
    plan: profile ? profile.plan ?? null : prev?.plan ?? null,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    saved_at: new Date().toISOString(),
  };
  await write([entry, ...list.filter((a) => a.id !== entry.id)]);
}

export async function forgetAccount(id: string): Promise<void> {
  const list = await read();
  await write(list.filter((a) => a.id !== id));
}

/** Store the current session, then switch to a saved account. Throws (and forgets it) if its sign-in expired. */
export async function switchToAccount(id: string): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) {
    if (data.session.user.id === id) return;
    await rememberSession(data.session);
  }
  const target = (await read()).find((a) => a.id === id);
  if (!target) throw new Error('That account is no longer saved on this device.');
  const { data: next, error } = await supabase.auth.setSession({ access_token: target.access_token, refresh_token: target.refresh_token });
  if (error || !next.session) {
    await forgetAccount(id);
    throw new Error(`${target.display_name} was signed out. Add the account again to switch to it.`);
  }
  await rememberSession(next.session);
}

/* ------------------------------------------------------------------ adding an account */

let addingUntil = 0;

/**
 * Mark that the user is adding another account, so the auth gate lets a signed-in user open /login.
 * Cleared automatically when a different account signs in, or after 10 minutes.
 */
export async function beginAddAccount(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (data.session) await rememberSession(data.session);
  addingUntil = Date.now() + 10 * 60_000;
}

export const isAddingAccount = () => Date.now() < addingUntil;
export const cancelAddAccount = () => {
  addingUntil = 0;
};

/* ------------------------------------------------------------------ sync */

let syncing = false;

/**
 * Keep the saved tokens of the active account current (refresh-token rotation) and save newly signed-in
 * accounts. Safe to call many times; mount once near the root via `useAccountSync()`.
 */
export function startAccountSync() {
  if (syncing) return;
  syncing = true;
  let lastUser: string | null = null;
  supabase.auth.onAuthStateChange((event, session) => {
    if (!session) {
      lastUser = null;
      return;
    }
    if (lastUser && lastUser !== session.user.id) addingUntil = 0;
    lastUser = session.user.id;
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED') {
      // Supabase advises against awaiting other auth calls inside this callback.
      setTimeout(() => {
        void (async () => {
          const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
          await rememberSession(session, (data as ProfileLike | null) ?? undefined);
        })().catch(() => {});
      }, 0);
    }
  });
}

export function useAccountSync() {
  useEffect(() => startAccountSync(), []);
}

/** Saved accounts, live. */
export function useSavedAccounts(): { accounts: SavedAccount[] | null; reload: () => void } {
  const [accounts, setAccounts] = useState<SavedAccount[] | null>(cache);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    void read().then((a) => alive && setAccounts(a));
    listeners.add(setAccounts);
    return () => {
      alive = false;
      listeners.delete(setAccounts);
    };
  }, [nonce]);
  return { accounts, reload: () => setNonce((n) => n + 1) };
}
