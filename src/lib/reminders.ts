import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export type ReminderPreset = { key: string; label: string; at: Date };

const pad = (n: number) => String(n).padStart(2, '0');

/** "10:41 PM" style clock text for a reminder time. */
export function clockLabel(d: Date): string {
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Quick choices from the design: in 1 hour, tonight (9 PM, or +3h when past), tomorrow morning (8 AM). */
export function reminderPresets(now = new Date()): ReminderPreset[] {
  const hour = new Date(now.getTime() + 3600_000);
  const tonight = new Date(now);
  tonight.setHours(21, 0, 0, 0);
  const evening = tonight.getTime() - now.getTime() > 15 * 60_000 ? tonight : new Date(now.getTime() + 3 * 3600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return [
    { key: 'hour', label: 'In 1 hour', at: hour },
    { key: 'tonight', label: tonight.getTime() - now.getTime() > 15 * 60_000 ? 'Tonight' : 'In 3 hours', at: evening },
    { key: 'morning', label: 'Tomorrow morning', at: tomorrow },
  ];
}

/** reminder id for a message (one reminder per message; setting again replaces it). */
const idFor = (mid: string) => `msg-reminder-${mid}`;

/**
 * Schedules a local notification that reopens the chat. Runs on this device only: nothing about the message
 * leaves it (important for end-to-end encrypted chats). Returns false when notifications are not allowed.
 */
export async function scheduleMessageReminder(opts: { mid: string; cid: string; preview: string; name?: string; at: Date; group?: boolean }): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (opts.at.getTime() <= Date.now() + 5000) throw new Error('Pick a time in the future');
  let perm = await Notifications.getPermissionsAsync();
  if (!perm.granted) perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return false;
  const route = opts.group ? '/group-chat' : '/chat-pro';
  await Notifications.scheduleNotificationAsync({
    identifier: idFor(opts.mid),
    content: {
      title: opts.name ? `Reminder · ${opts.name}` : 'Message reminder',
      body: opts.preview.slice(0, 140),
      data: { kind: 'reminder', conversation_id: opts.cid, url: `${route}?id=${encodeURIComponent(opts.cid)}` },
      sound: 'default',
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: opts.at, ...(Platform.OS === 'android' ? { channelId: 'default' } : {}) },
  });
  return true;
}

export async function cancelMessageReminder(mid: string): Promise<void> {
  if (Platform.OS === 'web') return;
  await Notifications.cancelScheduledNotificationAsync(idFor(mid)).catch(() => undefined);
}

/** When this message's reminder fires, or null. */
export async function getMessageReminder(mid: string): Promise<Date | null> {
  if (Platform.OS === 'web') return null;
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    const hit = all.find((n) => n.identifier === idFor(mid));
    const t = hit?.trigger as { value?: number; date?: number | string } | null | undefined;
    const raw = t?.value ?? t?.date;
    return raw ? new Date(raw) : hit ? new Date(Date.now()) : null;
  } catch {
    return null;
  }
}
