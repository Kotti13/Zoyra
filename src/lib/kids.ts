import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { useAuth } from '../state/auth';
import { KIDS_DEFAULTS, type KidsConfig } from './kids-types';

/**
 * Kids mode runtime. The settings live on the account (`user_settings.kids`); this file adds the parent PIN
 * (hashed on the device), the short "parent unlocked" window, the daily listening counter and the bedtime check.
 * Enforcement happens in `components/KidsGuard.tsx` (routes, player) and `lib/content-filter.ts` (explicit songs).
 */

export { KIDS_DEFAULTS };
export type { KidsConfig };

export const PIN_LENGTH = 4;
/** How long a correct PIN keeps kids mode open for the parent. */
export const PARENT_WINDOW_MS = 10 * 60_000;

/* ------------------------------------------------------------------ parent unlock window */

let unlockedUntil = 0;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
let timer: ReturnType<typeof setTimeout> | null = null;
function setUnlocked(until: number) {
  unlockedUntil = until;
  if (timer) clearTimeout(timer);
  if (until > Date.now()) {
    timer = setTimeout(() => setUnlocked(0), until - Date.now() + 50);
  }
  listeners.forEach((l) => l());
}
export const lockParent = () => setUnlocked(0);
export const parentUnlocked = () => unlockedUntil > Date.now();

/* ------------------------------------------------------------------ PIN */

const hashPin = (salt: string, pin: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);

export const validPin = (pin: string) => new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

export async function makePin(pin: string): Promise<{ pin_salt: string; pin_hash: string }> {
  if (!validPin(pin)) throw new Error(`The PIN must be ${PIN_LENGTH} digits`);
  const pin_salt = Crypto.randomUUID();
  return { pin_salt, pin_hash: await hashPin(pin_salt, pin) };
}

let wrong = 0;
let lockedUntil = 0;
/** Checks the PIN. Five wrong tries lock the keypad for a minute. */
export async function checkPin(cfg: KidsConfig, pin: string): Promise<{ ok: boolean; error?: string }> {
  if (Date.now() < lockedUntil) return { ok: false, error: `Too many tries. Wait ${Math.ceil((lockedUntil - Date.now()) / 1000)} s.` };
  if (!cfg.pin_salt || !cfg.pin_hash) return { ok: false, error: 'No PIN is set yet.' };
  const ok = validPin(pin) && (await hashPin(cfg.pin_salt, pin)) === cfg.pin_hash;
  if (ok) {
    wrong = 0;
    setUnlocked(Date.now() + PARENT_WINDOW_MS);
    return { ok: true };
  }
  wrong += 1;
  if (wrong >= 5) {
    wrong = 0;
    lockedUntil = Date.now() + 60_000;
    return { ok: false, error: 'Too many tries. Wait a minute.' };
  }
  return { ok: false, error: 'That PIN is wrong.' };
}

/* ------------------------------------------------------------------ hook */

export function useKids() {
  const { settings, updateSettings } = useAuth();
  const cfg: KidsConfig = useMemo(() => ({ ...KIDS_DEFAULTS, ...(settings?.kids ?? {}) }), [settings?.kids]);
  const unlocked = useSyncExternalStore(subscribe, () => unlockedUntil > Date.now(), () => false);
  const save = useCallback((patch: Partial<KidsConfig>) => updateSettings({ kids: { ...cfg, ...patch } }), [cfg, updateSettings]);
  return { cfg, ready: !!settings, on: cfg.on, hasPin: !!cfg.pin_hash, unlocked, save };
}

/* ------------------------------------------------------------------ bedtime + daily usage */

export const clockLabel = (min: number) => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

/** True inside the bedtime window (handles a window that crosses midnight). */
export function bedtimeActive(cfg: KidsConfig, now = new Date()): boolean {
  if (!cfg.bed_on) return false;
  const m = now.getHours() * 60 + now.getMinutes();
  return cfg.bed_from === cfg.bed_to ? false : cfg.bed_from < cfg.bed_to ? m >= cfg.bed_from && m < cfg.bed_to : m >= cfg.bed_from || m < cfg.bed_to;
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const usageKey = (uid: string) => `zoyra.kids.usage.${uid}`;

export async function readUsageSeconds(uid: string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(usageKey(uid));
    const v = raw ? (JSON.parse(raw) as { day: string; sec: number }) : null;
    return v && v.day === dayKey() ? v.sec : 0;
  } catch {
    return 0;
  }
}

export async function writeUsageSeconds(uid: string, sec: number): Promise<void> {
  try {
    await AsyncStorage.setItem(usageKey(uid), JSON.stringify({ day: dayKey(), sec }));
  } catch {
    // counter is best effort
  }
}

export const limitLabel = (min: number) => (min <= 0 ? 'Off' : min % 60 === 0 ? `${min / 60} h` : min > 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);

/** Routes a child can't open while kids mode is on (people, messages, live). */
const SOCIAL = new Set(['messages', 'new-message', 'new-group', 'group-chat', 'message-requests', 'follow-requests', 'dm-privacy', 'community', 'video-comments', 'live-hub', 'live-room', 'go-live', 'call', 'group-call', 'note-compose', 'note-viewers', 'friends', 'followers', 'invite', 'last-seen']);
/** Routes that change settings or money: parent PIN first. */
const PARENT = new Set(['settings', 'settings-hub', 'settings-search', 'content-controls', 'family', 'billing', 'plans', 'gift-premium', 'privacy', 'account-switcher', 'sessions', 'connected', 'permissions', 'push-settings', 'two-factor', 'e2ee-setup', 'e2ee-restore', 'edit-profile', 'kids-mode']);

export type KidsRouteVerdict = 'ok' | 'social' | 'parent';
export function kidsRouteVerdict(first: string): KidsRouteVerdict {
  if (!first) return 'ok';
  if (SOCIAL.has(first) || first.startsWith('chat') || first.startsWith('forever') || first.startsWith('msg') || first.startsWith('push-')) return 'social';
  if (PARENT.has(first)) return 'parent';
  return 'ok';
}
