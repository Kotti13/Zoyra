import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

/**
 * Locked chats (design: MsgChatLock). Device-only: a chat marked locked asks for Face ID / Touch ID /
 * the device passcode before it opens, can be hidden from the inbox list (reached through "Locked chats"),
 * and shows "New message" instead of the text in notifications built on this device (E2EE pushes).
 * Nothing is sent to the server, so locks do not follow the account to another phone.
 */
export type ChatLock = { hide: boolean; hideText: boolean };
type Store = Record<string, ChatLock>;

const KEY = (uid: string) => `zoyra.chat-locks.v1.${uid}`;
const cache = new Map<string, Store>();
const listeners = new Set<() => void>();

async function load(uid: string): Promise<Store> {
  const hit = cache.get(uid);
  if (hit) return hit;
  let s: Store = {};
  try {
    const raw = await AsyncStorage.getItem(KEY(uid));
    if (raw) s = JSON.parse(raw) as Store;
  } catch {
    s = {};
  }
  cache.set(uid, s);
  return s;
}

async function save(uid: string, s: Store) {
  cache.set(uid, s);
  listeners.forEach((l) => l());
  await AsyncStorage.setItem(KEY(uid), JSON.stringify(s));
}

export async function getChatLocks(uid: string): Promise<Store> {
  return load(uid);
}

export async function setChatLock(uid: string, cid: string, lock: ChatLock | null): Promise<void> {
  const s = { ...(await load(uid)) };
  if (lock) s[cid] = lock;
  else delete s[cid];
  await save(uid, s);
}

/** Live map of this account's locked chats. */
export function useChatLocks(uid: string | undefined): Store {
  const [s, setS] = useState<Store>(() => (uid ? cache.get(uid) ?? {} : {}));
  useEffect(() => {
    if (!uid) return;
    let on = true;
    const pull = () => void load(uid).then((v) => on && setS({ ...v }));
    pull();
    listeners.add(pull);
    return () => {
      on = false;
      listeners.delete(pull);
    };
  }, [uid]);
  return uid ? s : {};
}

/** True when the device can check the person (biometrics or passcode). */
export async function canAuthenticate(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await LocalAuthentication.hasHardwareAsync().then(async (h) => h && (await LocalAuthentication.isEnrolledAsync()));
  } catch {
    return false;
  }
}

/** Prompts Face ID / Touch ID / passcode. Resolves false when cancelled or not available. */
export async function authenticate(reason = 'Unlock this chat'): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, fallbackLabel: 'Use passcode' });
    return r.success;
  } catch {
    return false;
  }
}

/** Notification text for a chat: masked to "New message" when the chat hides its text. */
export async function maskedChatBody(uid: string | undefined, cid: string | undefined, body: string): Promise<string> {
  if (!uid || !cid) return body;
  const l = (await load(uid))[cid];
  return l?.hideText ? 'New message' : body;
}

/** Chats unlocked with Face ID in this app session; cleared when the app goes to the background. */
const unlocked = new Set<string>();
AppState.addEventListener('change', (st) => {
  if (st !== 'active') unlocked.clear();
});
export const markChatUnlocked = (cid: string) => unlocked.add(cid);
export const isChatUnlocked = (cid: string) => unlocked.has(cid);

/**
 * Gate for a chat screen, so notification taps and deep links cannot skip the lock.
 * 'checking' until the lock list is read, 'locked' until Face ID passes, then 'open'.
 */
export function useChatGate(uid: string | undefined, cid: string | undefined): { state: 'checking' | 'locked' | 'open'; unlock: () => Promise<void> } {
  const locks = useChatLocks(uid);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [, bump] = useState(0);
  const ready = !uid || loadedFor === uid;
  useEffect(() => {
    let on = true;
    if (uid) void load(uid).then(() => on && setLoadedFor(uid));
    return () => {
      on = false;
    };
  }, [uid]);
  const locked = !!cid && !!locks[cid] && !unlocked.has(cid);
  const unlock = async () => {
    if (!cid) return;
    if (await authenticate('Unlock this chat')) {
      unlocked.add(cid);
      bump((n) => n + 1);
    }
  };
  const lockedNow = locked;
  useEffect(() => {
    if (ready && lockedNow) void unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, lockedNow]);
  return { state: !ready ? 'checking' : lockedNow ? 'locked' : 'open', unlock };
}
