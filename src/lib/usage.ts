/**
 * Data usage, ESTIMATED from playback.
 *
 * The player reports audio seconds as they play. Each second is turned into bytes at the catalogue's
 * stream bitrate (Audius always serves a 320 kbps MP3; its stream endpoint has no quality parameter,
 * measured: ~7.47 MB for a 186 s track), and split by:
 * - source: streamed vs played from a download (downloads use no data);
 * - network: Wi-Fi / cellular / other, from NetInfo via the downloads store.
 *
 * It is an estimate: it ignores buffering ahead, seeks and container overhead. Totals are kept per
 * calendar month in AsyncStorage on this device only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { downloads } from './downloads';

export type MonthUsage = {
  /** Estimated bytes streamed on Wi-Fi / Ethernet. */
  wifi: number;
  /** Estimated bytes streamed on mobile data. */
  cellular: number;
  /** Estimated bytes streamed on an unknown network type (VPN, unknown, …). */
  other: number;
  /** Bytes' worth of audio played from downloads (no data used). */
  offline: number;
  /** Streamed bytes per week of the month: days 1–7, 8–14, 15–21, 22+. */
  weeks: [number, number, number, number];
};

export type UsageSnapshot = { ready: boolean; months: Record<string, MonthUsage> };

const KEY = 'zoyra.usage.v1';
/** Bitrate (kbit/s) of every catalogue stream. */
export const STREAM_KBPS = 320;

/**
 * Kept for screens that still show the quality setting. The catalogue ignores it (every stream is
 * STREAM_KBPS), so these are nominal labels only and are NOT used for the data estimate.
 */
export type Quality = 'low' | 'normal' | 'high' | 'lossless';
export const BITRATE_KBPS: Record<Quality, number> = { low: 96, normal: 160, high: 320, lossless: 1411 };
const MAX_MONTHS = 12;
const FLUSH_MS = 15_000;

const empty = (): MonthUsage => ({ wifi: 0, cellular: 0, other: 0, offline: 0, weeks: [0, 0, 0, 0] });

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

let state: UsageSnapshot = { ready: false, months: {} };
const listeners = new Set<() => void>();
let initPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastUiPush = 0;

function emit() {
  listeners.forEach((l) => l());
}

function persist() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const keys = Object.keys(state.months).sort().slice(-MAX_MONTHS);
  const months: Record<string, MonthUsage> = {};
  keys.forEach((k) => (months[k] = state.months[k]));
  AsyncStorage.setItem(KEY, JSON.stringify(months)).catch(() => undefined);
}

function schedule() {
  if (!flushTimer) flushTimer = setTimeout(persist, FLUSH_MS);
}

async function init() {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const months = raw ? (JSON.parse(raw) as Record<string, MonthUsage>) : {};
    // Merge anything recorded before the index finished loading.
    for (const [k, m] of Object.entries(state.months)) {
      const base = months[k] ?? empty();
      months[k] = {
        wifi: base.wifi + m.wifi,
        cellular: base.cellular + m.cellular,
        other: base.other + m.other,
        offline: base.offline + m.offline,
        weeks: [0, 1, 2, 3].map((i) => base.weeks[i] + m.weeks[i]) as MonthUsage['weeks'],
      };
    }
    state = { ready: true, months };
  } catch {
    state = { ...state, ready: true };
  }
  emit();
  AppState.addEventListener('change', (s) => {
    if (s !== 'active') persist();
  });
}

export const usage = {
  init(): Promise<void> {
    if (!initPromise) initPromise = init();
    return initPromise;
  },
  subscribe(listener: () => void) {
    void usage.init();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): UsageSnapshot {
    return state;
  },

  /** Adds `seconds` of played audio; `local` = played from a download or a device file (no data). */
  record(seconds: number, opts: { local: boolean }) {
    if (!(seconds > 0)) return;
    void usage.init();
    const conn = downloads.getSnapshot().connection;
    const network = conn === 'wifi' || conn === 'ethernet' ? 'wifi' : conn === 'cellular' ? 'cellular' : 'other';
    const bytes = (seconds * STREAM_KBPS * 1000) / 8;
    const now = new Date();
    const key = monthKey(now);
    const prev = state.months[key] ?? empty();
    const m: MonthUsage = { ...prev, weeks: [...prev.weeks] as MonthUsage['weeks'] };
    if (opts.local) m.offline += bytes;
    else {
      m[network] += bytes;
      m.weeks[Math.min(3, Math.floor((now.getDate() - 1) / 7))] += bytes;
    }
    state = { ...state, months: { ...state.months, [key]: m } };
    // Screens re-render at most every 5 s while music plays.
    if (Date.now() - lastUiPush > 5000) {
      lastUiPush = Date.now();
      emit();
    }
    schedule();
  },

  /** Clears the current month (or every month). */
  async reset(scope: 'month' | 'all' = 'month') {
    await usage.init();
    const months = { ...state.months };
    if (scope === 'all') Object.keys(months).forEach((k) => delete months[k]);
    else delete months[monthKey()];
    state = { ...state, months };
    emit();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    await AsyncStorage.setItem(KEY, JSON.stringify(months));
  },
};

export const streamedBytes = (m: MonthUsage) => m.wifi + m.cellular + m.other;
