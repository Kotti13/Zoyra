import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

/**
 * On this day: the song you played most on today's date in earlier years (`on_this_day` rpc, your own
 * play_history, local calendar day). The daily nudge is a local notification on this device.
 */
export type Memory = { year: number; yearsAgo: number; track: CatalogTrack; plays: number };

export async function loadMemories(now = new Date()): Promise<Memory[]> {
  const { data, error } = await supabase.rpc('on_this_day', { p_month: now.getMonth() + 1, p_day: now.getDate(), p_tz_min: now.getTimezoneOffset() });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { year: number; track: CatalogTrack; plays: number }[])
    .filter((r) => r.track?.id)
    .map((r) => ({ year: r.year, yearsAgo: now.getFullYear() - r.year, track: r.track, plays: r.plays }));
}

export const yearsAgoLabel = (n: number) => (n === 1 ? '1 YEAR AGO' : `${n} YEARS AGO`);
export const monthDayLabel = (d = new Date()) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
export const playsLabel = (n: number) => (n === 1 ? 'Played once that day' : `Played ${n} times that day`);

const KEY = 'zoyra.memories.daily';
const ID = 'daily-memory';

export async function getDailyMemory(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY)) === '1';
  } catch {
    return false;
  }
}

/** Turns the 9 AM daily reminder on or off. Returns false when notifications are not allowed. */
export async function setDailyMemory(on: boolean): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (!on) {
    await Notifications.cancelScheduledNotificationAsync(ID).catch(() => undefined);
    await AsyncStorage.setItem(KEY, '0').catch(() => undefined);
    return true;
  }
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return false;
  await Notifications.cancelScheduledNotificationAsync(ID).catch(() => undefined);
  await Notifications.scheduleNotificationAsync({
    identifier: ID,
    content: { title: 'On this day', body: 'Songs from this day in past years are waiting for you.', data: { kind: 'memory', url: '/memories' } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour: 9, minute: 0, ...(Platform.OS === 'android' ? { channelId: 'default' } : {}) },
  });
  await AsyncStorage.setItem(KEY, '1').catch(() => undefined);
  return true;
}
