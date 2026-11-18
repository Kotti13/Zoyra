import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import type { IconName } from '../components';
import { colors } from '../theme/tokens';
import { ensureForeverChannel } from './forever';
import { markConversationRead as markReadOnServer, sendChatMessage, toggleReaction } from './chat';
import { muteConversationFor } from './dm';
import { getE2EEStatus } from './e2ee';
import { friendlySocialError } from './social';
import { supabase } from './supabase';

/* ================================================================== push registration */

export type PushFailure = 'eas_project_missing' | 'permission_denied' | 'not_device' | 'unsupported' | 'expo_go' | 'error';
export type PushResult = { ok: true; token: string } | { ok: false; reason: PushFailure; message?: string };

export const ANDROID_CHANNEL_ID = 'default';

/**
 * Show banners/sounds for notifications that arrive while the app is open. Message alerts follow the
 * user's "Pop up banner" and "Sound" settings (cached, see `setAlertPrefsCache`). Safe to call more than once.
 */
let handlerSet = false;
export function configureNotificationHandler() {
  if (handlerSet || Platform.OS === 'web') return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const data = n.request.content.data ?? {};
      const message = data.kind === 'message' || data.kind === 'message_request';
      if (!message) return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true };
      const prefs = await Promise.race([loadAlertPrefs(), new Promise<Record<string, unknown>>((r) => setTimeout(() => r({}), 1500))]);
      return {
        shouldShowBanner: alertPref(prefs, 'banner'),
        shouldShowList: true,
        shouldPlaySound: alertChoice(prefs, 'sound') !== 'none',
        shouldSetBadge: true,
      };
    },
  });
  void registerNotificationCategories();
}

/* ================================================================== categories (quick actions) */

/** Category id the push function sets (`categoryId`) on chat messages. No `:` or `-` allowed in it. */
export const CHAT_CATEGORY = 'chat_message';
/** Local "Reply sent" confirmation (Undo / Open chat). */
export const REPLY_SENT_CATEGORY = 'reply_sent';
export const REPLY_ACTION = 'reply';
export const MARK_READ_ACTION = 'mark_read';
export const MUTE_HOUR_ACTION = 'mute_1h';
export const LIKE_ACTION = 'like';
export const UNDO_REPLY_ACTION = 'undo_reply';
export const OPEN_CHAT_ACTION = 'open_chat';

/** One-tap replies offered on message notifications when "Quick reply chips" is on. */
export const QUICK_REPLIES = [
  { id: 'quick_thumbs', title: '👍', text: '👍' },
  { id: 'quick_love', title: 'Love it', text: 'Love it' },
  { id: 'quick_omw', title: 'On my way', text: 'On my way' },
] as const;

/**
 * Message alert switches, stored in `user_settings.notifications` next to the per-category toggles.
 * `on` is the default when the key is unset. supabase/functions/push/index.ts reads the same keys.
 */
export const MESSAGE_ALERT_PREFS = {
  sender: { key: 'msg_sender', on: true },
  preview: { key: 'msg_preview', on: true },
  rich: { key: 'msg_rich', on: true },
  group: { key: 'msg_group', on: true },
  reply: { key: 'msg_reply', on: true },
  quick: { key: 'msg_quick', on: true },
  markRead: { key: 'msg_mark_read', on: true },
  banner: { key: 'msg_banner', on: true },
} as const;
export type MessageAlertPref = keyof typeof MESSAGE_ALERT_PREFS;

/**
 * Message alert pickers (same storage). `msg_sound` was a boolean before: true reads as 'chime',
 * false as 'none'. The push function maps them the same way.
 */
export const MESSAGE_ALERT_CHOICES = {
  sound: {
    key: 'msg_sound',
    default: 'chime',
    options: [
      { value: 'chime', label: 'Chime', subtitle: 'Zoyra chime' },
      { value: 'default', label: 'Phone', subtitle: 'Phone default sound' },
      { value: 'none', label: 'Off', subtitle: 'Silent' },
    ],
  },
  vibration: {
    key: 'msg_vibration',
    default: 'short',
    options: [
      { value: 'short', label: 'Short', subtitle: 'Short pulse' },
      { value: 'long', label: 'Long', subtitle: 'Long pulse' },
      { value: 'none', label: 'Off', subtitle: 'No vibration' },
    ],
  },
} as const;
export type MessageAlertChoice = keyof typeof MESSAGE_ALERT_CHOICES;
export type MessageSound = 'chime' | 'default' | 'none';
export type MessageVibration = 'short' | 'long' | 'none';

/** Bundled custom sound (assets/sounds/zoyra_chime.wav, listed in the expo-notifications plugin `sounds`). */
export const CHIME_SOUND = 'zoyra_chime.wav';

export function alertPref(n: Record<string, unknown> | null | undefined, p: MessageAlertPref): boolean {
  const v = n?.[MESSAGE_ALERT_PREFS[p].key];
  return typeof v === 'boolean' ? v : MESSAGE_ALERT_PREFS[p].on;
}

export function alertChoice(n: Record<string, unknown> | null | undefined, c: 'sound'): MessageSound;
export function alertChoice(n: Record<string, unknown> | null | undefined, c: 'vibration'): MessageVibration;
export function alertChoice(n: Record<string, unknown> | null | undefined, c: MessageAlertChoice): string {
  const def = MESSAGE_ALERT_CHOICES[c];
  const v = n?.[def.key];
  if (c === 'sound' && typeof v === 'boolean') return v ? 'chime' : 'none';
  return typeof v === 'string' && def.options.some((o) => o.value === v) ? v : def.default;
}

/**
 * Android channel for one sound / vibration / banner mix (channels fix these at creation, so every mix
 * gets its own; all are created up front so a push never targets a missing channel). Must stay in sync
 * with `messageChannelId` in supabase/functions/push/index.ts.
 */
export function messageChannelId(sound: MessageSound, vibration: MessageVibration, banner: boolean): string {
  return `msg_${sound}_${vibration}_${banner ? 'h' : 'q'}`;
}
/** Quiet hours: silent, no heads-up (push function sends every non-call alert here while quiet). */
export const QUIET_CHANNEL_ID = 'quiet';
/** Quiet confirmations posted by the app itself ("Reply sent"). */
const STATUS_CHANNEL_ID = 'status';

/* Cached copy of user_settings.notifications for the foreground handler (no hook context there). */
let alertPrefs: { at: number; n: Record<string, unknown> } | null = null;
export function setAlertPrefsCache(n: Record<string, unknown> | null | undefined) {
  alertPrefs = { at: Date.now(), n: n ?? {} };
}
async function loadAlertPrefs(): Promise<Record<string, unknown>> {
  if (alertPrefs && Date.now() - alertPrefs.at < 5 * 60_000) return alertPrefs.n;
  try {
    const { data: s } = await supabase.auth.getSession();
    const uid = s.session?.user.id;
    if (!uid) return {};
    const { data } = await supabase.from('user_settings').select('notifications').eq('user_id', uid).maybeSingle();
    const n = (data?.notifications ?? {}) as Record<string, unknown>;
    setAlertPrefsCache(n);
    return n;
  } catch {
    return alertPrefs?.n ?? {};
  }
}

/**
 * The notification category for a combination of message actions (null = no buttons). Must stay in sync
 * with `chatCategoryId` in supabase/functions/push/index.ts. Reply + Mark as read keeps the original id.
 * Every chat category also carries "Mute 1h" and "Like".
 */
export function chatCategoryId(reply: boolean, quick: boolean, markRead: boolean): string | null {
  if (!reply && !quick && !markRead) return null;
  if (reply && !quick && markRead) return CHAT_CATEGORY;
  return `chat${reply ? '_r' : ''}${quick ? '_q' : ''}${markRead ? '_m' : ''}`;
}

type CategoryAction = Notifications.NotificationAction;
const background = { opensAppToForeground: false, isDestructive: false, isAuthenticationRequired: false };

/** Order follows the Push expanded design: Reply (text), quick replies, Mark read, Mute 1h, Like. Android shows the first 3. */
function chatActions(reply: boolean, quick: boolean, markRead: boolean): CategoryAction[] {
  const actions: CategoryAction[] = [];
  if (reply) {
    actions.push({
      identifier: REPLY_ACTION,
      buttonTitle: 'Reply',
      textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
      options: background,
    });
  }
  if (quick) for (const q of QUICK_REPLIES) actions.push({ identifier: q.id, buttonTitle: q.title, options: background });
  if (markRead) actions.push({ identifier: MARK_READ_ACTION, buttonTitle: 'Mark read', options: background });
  actions.push({ identifier: MUTE_HOUR_ACTION, buttonTitle: 'Mute 1h', options: background });
  actions.push({ identifier: LIKE_ACTION, buttonTitle: 'Like', options: background });
  return actions;
}

/**
 * Registers every chat message category (each mix of inline "Reply", quick replies and "Mark read",
 * plus "Mute 1h" and "Like"), all handled without bringing the app to the foreground, and the local
 * "Reply sent" category (Undo / Open chat). The push function picks a chat category per user from their
 * message alert settings. Never throws (no-op on web / where the module is missing).
 */
let categoriesSet = false;
export async function registerNotificationCategories(): Promise<void> {
  if (categoriesSet || Platform.OS === 'web') return;
  categoriesSet = true;
  try {
    const flags = [true, false];
    for (const reply of flags) {
      for (const quick of flags) {
        for (const markRead of flags) {
          const id = chatCategoryId(reply, quick, markRead);
          if (id) await Notifications.setNotificationCategoryAsync(id, chatActions(reply, quick, markRead));
        }
      }
    }
    await Notifications.setNotificationCategoryAsync(REPLY_SENT_CATEGORY, [
      { identifier: UNDO_REPLY_ACTION, buttonTitle: 'Undo', options: { ...background, isDestructive: true } },
      { identifier: OPEN_CHAT_ACTION, buttonTitle: 'Open chat', options: { ...background, opensAppToForeground: true } },
    ]);
  } catch {
    categoriesSet = false; // Expo Go / unsupported: try again next launch
  }
}

const VIBRATION: Record<MessageVibration, number[] | null> = { short: [0, 120], long: [0, 400, 200, 400], none: null };
const SOUNDS: MessageSound[] = ['chime', 'default', 'none'];
const VIBRATIONS: MessageVibration[] = ['short', 'long', 'none'];

/**
 * The Android channels: `default` (every other Zoyra notification), one per message alert mix
 * (sound × vibration × pop-up banner, grouped under "Message alerts"), `quiet` (quiet hours) and
 * `status` (confirmations). Channel settings are fixed once created, hence one per mix.
 */
let channelsSet = false;
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android' || channelsSet) return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'Zoyra',
    importance: AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 120, 200],
    lightColor: colors.accent,
  });
  try {
    await Notifications.setNotificationChannelGroupAsync('messages', { name: 'Message alerts' });
  } catch {
    // groups are optional
  }
  // Gold call channel for Forever friends (sound: zoyra_gold_ring).
  await ensureForeverChannel().catch(() => undefined);
  const soundName: Record<MessageSound, string> = { chime: 'Zoyra chime', default: 'Phone sound', none: 'Silent' };
  const vibName: Record<MessageVibration, string> = { short: 'short pulse', long: 'long pulse', none: 'no vibration' };
  for (const sound of SOUNDS) {
    for (const vibration of VIBRATIONS) {
      for (const banner of [true, false]) {
        await Notifications.setNotificationChannelAsync(messageChannelId(sound, vibration, banner), {
          name: `Messages · ${soundName[sound]} · ${vibName[vibration]}${banner ? '' : ' · no pop-up'}`,
          groupId: 'messages',
          importance: banner ? AndroidImportance.HIGH : AndroidImportance.DEFAULT,
          sound: sound === 'chime' ? CHIME_SOUND : sound === 'default' ? 'default' : null,
          enableVibrate: vibration !== 'none',
          vibrationPattern: VIBRATION[vibration],
          lightColor: colors.accent,
        });
      }
    }
  }
  await Notifications.setNotificationChannelAsync(QUIET_CHANNEL_ID, { name: 'Quiet hours', importance: AndroidImportance.LOW, sound: null, enableVibrate: false });
  await Notifications.setNotificationChannelAsync(STATUS_CHANNEL_ID, { name: 'Sent confirmations', importance: AndroidImportance.LOW, sound: null, enableVibrate: false });
  channelsSet = true;
}

/** The device's IANA time zone, saved so quiet hours apply in local time on the server. Never throws. */
export async function saveNotificationTimeZone(): Promise<void> {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) await supabase.rpc('set_notification_tz', { tz });
  } catch {
    // older server / offline: quiet hours fall back to off for push delivery
  }
}

function easProjectId(): string | null {
  const extra: unknown = Constants.expoConfig?.extra;
  if (!extra || typeof extra !== 'object') return null;
  const eas: unknown = (extra as Record<string, unknown>).eas;
  if (!eas || typeof eas !== 'object') return null;
  const id: unknown = (eas as Record<string, unknown>).projectId;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Ask for notification permission, fetch the Expo push token and store it in `push_tokens`.
 * With `prompt: false` it never shows the OS dialog (use on launch to refresh an already-granted token).
 */
export async function registerForPush(userId: string, opts: { prompt?: boolean } = {}): Promise<PushResult> {
  const prompt = opts.prompt ?? true;
  if (Platform.OS === 'web') return { ok: false, reason: 'unsupported' };
  // Remote push was removed from Expo Go (SDK 53+); a development build is required.
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return { ok: false, reason: 'expo_go' };
  if (!Device.isDevice) return { ok: false, reason: 'not_device' };

  try {
    configureNotificationHandler();
    await ensureAndroidChannel();

    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && prompt && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'permission_denied' };

    const projectId = easProjectId();
    if (!projectId) return { ok: false, reason: 'eas_project_missing' };

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    // RPC (security definer) so a device token previously saved under another account is reassigned to this user.
    // p_device_id (E2EE device of this install) lets the push function address this phone's message envelope.
    const e2ee = getE2EEStatus();
    const deviceId = e2ee.status === 'ready' && e2ee.userId === userId ? e2ee.deviceId : null;
    let { error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS, ...(deviceId ? { p_device_id: deviceId } : {}) });
    if (error && deviceId && /p_device_id|function|schema cache/i.test(error.message)) {
      ({ error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS })); // server not migrated yet
    }
    if (error) return { ok: false, reason: 'error', message: error.message };
    if (Platform.OS === 'android') void import('./native-call').then((m) => m.ensureBackgroundNotificationTask()).catch(() => undefined);
    void saveNotificationTimeZone();
    return { ok: true, token };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : 'Could not register for push' };
  }
}

/** Current permission without prompting (for settings UI). */
export async function pushPermissionStatus(): Promise<'granted' | 'denied' | 'undetermined' | 'unsupported'> {
  if (Platform.OS === 'web') return 'unsupported';
  try {
    const p = await Notifications.getPermissionsAsync();
    if (p.granted) return 'granted';
    return p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unsupported';
  }
}

/** Remove this device's token (e.g. on sign-out or when the user turns push off). */
export async function unregisterPush(token: string) {
  await supabase.from('push_tokens').delete().eq('token', token);
}

/**
 * Sign-out (call BEFORE supabase.auth.signOut: RLS needs the session): this phone stops getting the account's
 * pushes and calls. Deletes its push_tokens row and voip_tokens rows (keyed by the Expo token). Never throws.
 */
export async function unregisterThisDevice(): Promise<void> {
  if (Platform.OS === 'web' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient || !Device.isDevice) return;
  try {
    const perm = await Notifications.getPermissionsAsync();
    const projectId = easProjectId();
    if (!perm.granted || !projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await Promise.all([unregisterPush(token), supabase.from('voip_tokens').delete().eq('push_token', token)]);
  } catch {
    // offline: register_push_token reassigns the token on the next sign-in
  }
}

export function describePushResult(r: PushResult): string {
  if (r.ok) return 'Enabled on this device';
  switch (r.reason) {
    case 'permission_denied':
      return 'Permission denied — allow notifications for Zoyra in system settings';
    case 'eas_project_missing':
      return 'Needs EAS project id (run `eas init` to link the app)';
    case 'not_device':
      return 'Push needs a physical device';
    case 'expo_go':
      return 'Push needs a development build (not available in Expo Go)';
    case 'unsupported':
      return 'Push is not available on this platform';
    default:
      return r.message ?? 'Could not enable push';
  }
}

/* ================================================================== routing */

export type NotificationRow = { id: string; user_id: string; kind: string; payload: Record<string, unknown>; read: boolean; created_at: string };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Accepts `/chat?id=1`, `zoyra://chat?id=1` or `zoyra:///chat?id=1` and returns an in-app path. */
export function toAppPath(url: string): string | null {
  const s = url.trim();
  if (!s) return null;
  if (s.startsWith('/')) return s;
  const m = /^zoyra:\/\/\/?(.*)$/i.exec(s);
  return m ? `/${m[1] ?? ''}` : null;
}

/** Rows and pushes sent before the chat redesign point at the old `/chat` screen; open the new one instead. */
function upgradeLegacyPath(path: string): string {
  return /^\/chat(?=[?#]|$)/.test(path) ? path.replace(/^\/chat/, '/chat-pro') : path;
}

/** Where a notification row (or push data payload) should take the user. */
export function notificationHref(kind: string, payload: Record<string, unknown>): string | null {
  // Chat messages (single or grouped) always open the conversation itself in the new chat screen.
  const chat = str(payload.conversation_id);
  if (kind === 'message' && chat) return `/chat-pro?id=${encodeURIComponent(chat)}`;
  const url = str(payload.url);
  if (url) {
    const p = toAppPath(url);
    if (p) return upgradeLegacyPath(p);
  }
  // Kinds with their own screen first (rows written before `url` was added still route).
  if (kind === 'live') {
    const session = str(payload.session_id);
    if (session) return `/live-room?id=${encodeURIComponent(session)}`;
  }
  if (kind === 'new_release') {
    const track = str(payload.track_id);
    if (track) return `/track-detail?id=${encodeURIComponent(track)}`;
    const artist = str(payload.artist_id);
    if (artist) return `/artist?id=${encodeURIComponent(artist)}`;
  }
  if (kind === 'room_join') {
    const room = str(payload.room_id);
    if (room) return `${str(payload.room_kind) === 'party' ? '/party' : '/group-listening'}?id=${encodeURIComponent(room)}`;
  }
  if (kind === 'downloads_ready') return '/downloads';
  const conversation = str(payload.conversation_id);
  if (conversation) return `/chat-pro?id=${encodeURIComponent(conversation)}`;
  const playlist = str(payload.playlist_id);
  if (playlist) return kind.includes('collab') || kind.includes('invite') ? `/invite?playlist=${encodeURIComponent(playlist)}` : `/playlist?id=${encodeURIComponent(playlist)}`;
  const room = str(payload.room_id);
  if (room) return `${str(payload.room_kind) === 'party' ? '/party' : '/group-listening'}?id=${encodeURIComponent(room)}`;
  const person = str(payload.follower_id) ?? str(payload.sender_id) ?? str(payload.actor_id) ?? str(payload.user_id);
  if (kind === 'follow' && person) return `/taste-compare?user=${encodeURIComponent(person)}`;
  if (kind === 'dedication') return person ? `/taste-compare?user=${encodeURIComponent(person)}` : '/messages';
  if (kind === 'message') return '/messages';
  if (kind === 'message_request') return '/message-requests';
  return null;
}

/* ================================================================== presentation */

/** App section a notification belongs to (the label above its title, like the system shade). */
export type NotificationSection = 'Zoyra' | 'Zoyra Live' | 'Zoyra Social' | 'Downloads';

export type NotificationLook = {
  icon: IconName;
  section: NotificationSection;
  /** Icon tile fill. */
  color: string;
  /** Icon colour on that fill. */
  iconColor: string;
  title: string;
  body?: string;
};

/** Icon, section label, colour and copy for one notification row. */
export function describeNotification(kind: string, payload: Record<string, unknown> | null | undefined): NotificationLook {
  const p = payload ?? {};
  const who = str(p.actor_name) ?? str(p.sender_name) ?? str(p.from_name) ?? str(p.display_name) ?? 'Someone';
  const track = p.track && typeof p.track === 'object' ? str((p.track as Record<string, unknown>).title) : undefined;
  const title = str(p.title);
  const body = str(p.body) ?? str(p.preview) ?? str(p.message);
  const social = { section: 'Zoyra Social' as const, color: colors.orange, iconColor: colors.onAccent };
  switch (kind) {
    case 'live':
      return { icon: 'bolt', section: 'Zoyra Live', color: colors.accent, iconColor: colors.onAccent, title: title ?? `${who} is live`, body };
    case 'new_release':
      return {
        icon: 'music',
        section: 'Zoyra',
        color: colors.accentDark,
        iconColor: colors.onAccent,
        title: title ?? `New release from ${str(p.artist_name) ?? 'an artist you follow'}`,
        body: body ?? str(p.track_title),
      };
    case 'room_join':
      return { icon: 'users', ...social, title: title ?? `${who} joined your jam`, body: body ?? str(p.room_name) };
    case 'downloads_ready':
      return { icon: 'download', section: 'Downloads', color: colors.surface3, iconColor: colors.text, title: title ?? 'Downloads ready offline', body };
    case 'message_request':
      return { icon: 'mail', ...social, title: title ?? `${who} wants to message you`, body: body ?? 'Tap to accept or decline' };
    case 'message':
      return { icon: 'mail', ...social, title: title ?? `${who} sent you a message`, body: body ?? (track ? `Shared ${track}` : undefined) };
    case 'call': {
      const video = str(p.kind) === 'video';
      return { icon: video ? 'video' : 'call', ...social, color: colors.success, title: title ?? who, body: body ?? (video ? 'Incoming video call' : 'Incoming voice call') };
    }
    case 'e2ee_reset':
      return { icon: 'shield', section: 'Zoyra', color: colors.error, iconColor: colors.onAccent, title: title ?? 'Your encryption keys were reset', body };
    case 'call_missed': {
      const video = str(p.kind) === 'video';
      return { icon: video ? 'video' : 'call', ...social, color: colors.error, title: title ?? who, body: body ?? (video ? 'Missed video call' : 'Missed voice call') };
    }
    case 'dedication':
      return { icon: 'heart', ...social, title: title ?? `${who} dedicated a song to you`, body: body ?? track };
    case 'follow':
      return { icon: 'user', ...social, title: title ?? `${who} started following you`, body };
    case 'family_join':
      return { icon: 'users', ...social, title: title ?? `${who} joined your family plan`, body };
    // Forever friends (supabase/migrations/20261117100000_forever_friends.sql). Rows carry `url` for routing.
    case 'forever_request':
      return { icon: 'star', ...social, color: colors.gold, iconColor: colors.black, title: title ?? who, body: body ?? 'Wants you as their Forever' };
    case 'forever_accepted':
      return { icon: 'star', ...social, color: colors.gold, iconColor: colors.black, title: title ?? who, body: body ?? 'You are Forever now' };
    case 'forever_removal':
    case 'forever_removal_cancelled':
    case 'forever_ended':
      return { icon: 'star', ...social, color: colors.surface3, iconColor: colors.gold, title: title ?? who, body };
    case 'forever_milestone':
    case 'forever_streak':
      return { icon: kind === 'forever_streak' ? 'flame' : 'trophy', ...social, color: colors.gold, iconColor: colors.black, title: title ?? 'Forever', body };
    case 'collab_invite':
    case 'collaborator':
    case 'playlist_invite':
      return { icon: 'queue', ...social, title: title ?? `${who} added you to a playlist`, body: body ?? str(p.playlist_title) };
    default:
      return { icon: 'bell', section: 'Zoyra', color: colors.surface3, iconColor: colors.text, title: title ?? 'Notification', body };
  }
}

/* ================================================================== local notifications */

/**
 * Shows a notification from the device itself (no server), e.g. "3 songs ready offline".
 * Never prompts and never throws: it is a no-op on web, without permission, or where the native
 * module isn't available. Returns whether the OS accepted it.
 */
export async function showLocalNotification(content: {
  title: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Stacks related notifications: Android group key / iOS thread identifier (expo-notifications `threadIdentifier`). */
  group?: string;
  /** Replaces an earlier notification with the same identifier. */
  identifier?: string;
  /** Category with action buttons (e.g. REPLY_SENT_CATEGORY). */
  categoryId?: string;
  /** Quiet: no sound, low-importance Android channel (confirmations). */
  quiet?: boolean;
}): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return false;
    configureNotificationHandler();
    await ensureAndroidChannel();
    await Notifications.scheduleNotificationAsync({
      ...(content.identifier ? { identifier: content.identifier } : {}),
      content: {
        title: content.title,
        body: content.body ?? null,
        data: content.data ?? {},
        ...(content.quiet ? {} : { sound: 'default' }),
        ...(content.group ? { threadIdentifier: content.group } : {}),
        ...(content.categoryId ? { categoryIdentifier: content.categoryId } : {}),
      },
      trigger: Platform.OS === 'android' ? { channelId: content.quiet ? STATUS_CHANNEL_ID : ANDROID_CHANNEL_ID } : null,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Posts a chat message notification built on the device (Android E2EE pushes arrive data-only and are
 * decrypted here): same channel, category (Reply / quick replies / Mark read…) and per-chat grouping the
 * server push would use. `identifier` = the group key replaces the chat's previous notification. Never throws.
 */
export async function presentChatNotification(n: { identifier: string; title: string; body: string; data: Record<string, unknown>; channelId?: string; categoryId?: string; group?: string }): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return;
    configureNotificationHandler();
    await ensureAndroidChannel();
    await registerNotificationCategories();
    await Notifications.scheduleNotificationAsync({
      identifier: n.identifier,
      content: {
        title: n.title,
        body: n.body,
        data: n.data,
        ...(n.group ? { threadIdentifier: n.group } : {}),
        ...(n.categoryId ? { categoryIdentifier: n.categoryId } : {}),
      },
      trigger: Platform.OS === 'android' ? { channelId: n.channelId ?? ANDROID_CHANNEL_ID } : null,
    });
  } catch {
    // module unavailable
  }
}

export function openPath(path: string) {
  router.push(path as Href);
}

/**
 * Notification taps can arrive before the root <Stack> is mounted (cold start: AuthGate renders nothing
 * until the session is restored). Navigating then has no navigator and shows "Unmatched Route", so the
 * path is held here and opened once the app reports the navigator is ready.
 */
let navReady = false;
let queuedPath: string | null = null;

function openWhenReady(path: string) {
  if (navReady) openPath(path);
  else queuedPath = path;
}

function setNavReady(ready: boolean) {
  navReady = ready;
  if (!ready || !queuedPath) return;
  const path = queuedPath;
  queuedPath = null;
  // Next frame: let the navigator finish mounting and AuthGate's own redirects run first.
  requestAnimationFrame(() => openPath(path));
}

/** Marks a conversation's inbox rows (and the conversation itself) read for the signed-in user. */
async function markConversationRead(conversationId: string | undefined, notificationId: string | undefined) {
  try {
    if (notificationId) await supabase.from('notifications').update({ read: true }).eq('id', notificationId);
    if (!conversationId) return;
    const { data } = await supabase.auth.getSession();
    const me = data.session?.user.id;
    if (!me) return;
    await Promise.all([
      supabase
        .from('notifications')
        .update({ read: true })
        .eq('user_id', me)
        .eq('read', false)
        .in('kind', ['message', 'message_request'])
        .eq('payload->>conversation_id', conversationId),
      markReadOnServer(conversationId, me),
    ]);
  } catch {
    // offline: the row stays unread and clears when the chat is opened
  }
}

async function dismissQuietly(identifier: string) {
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch {
    // already gone / unsupported
  }
}

function clearLastResponse() {
  try {
    Notifications.clearLastNotificationResponse();
  } catch {
    // not available on this platform
  }
}

/** Responses already handled in this JS session (the cold-start response can also reach the listener). */
const handledResponses = new Set<string>();
const responseKey = (res: Notifications.NotificationResponse) =>
  `${res.notification.request.identifier}|${res.actionIdentifier}|${res.userText ?? ''}`;

async function myId(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id;
}

/** The message a "Like" targets: the one the push named, else the newest message from someone else. */
async function latestIncoming(conversationId: string, me: string, hinted: string | undefined): Promise<string | null> {
  if (hinted) return hinted;
  const { data } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .neq('sender_id', me)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function failed(identifier: string, conversation: string, title: string, e: unknown, fallback: string) {
  await dismissQuietly(identifier);
  await showLocalNotification({
    title,
    body: e instanceof Error && e.message ? e.message : friendlySocialError(e, fallback),
    data: { kind: 'message_failed', conversation_id: conversation, url: `/chat-pro?id=${encodeURIComponent(conversation)}` },
  });
}

/**
 * Handles the notification actions without opening the app: on chat alerts "Reply" (inline text),
 * quick replies, "Mark read", "Mute 1h" (mutes the chat until an hour from now) and "Like" (❤️ on the
 * latest message); on the local "Reply sent" confirmation "Undo" (unsends the reply) and "Open chat".
 * After a reply the alert is replaced by "Reply sent to <name>" (Push sent design). Runs whenever the
 * JS runtime is alive (foreground or background). Never throws.
 */
export async function handleNotificationAction(res: Notifications.NotificationResponse): Promise<void> {
  const identifier = res.notification.request.identifier;
  const content = res.notification.request.content;
  const data = content.data ?? {};
  const conversation = str(data.conversation_id);
  const notifId = str(data.notification_id);
  const action = res.actionIdentifier;

  if (action === OPEN_CHAT_ACTION) {
    await dismissQuietly(identifier);
    if (conversation) openWhenReady(`/chat-pro?id=${encodeURIComponent(conversation)}`);
    return;
  }

  if (action === UNDO_REPLY_ACTION) {
    const mid = str(data.message_id);
    await dismissQuietly(identifier);
    if (!mid || !conversation) return;
    const { error } = await supabase.rpc('unsend_message', { mid });
    if (error) await failed(identifier, conversation, "Couldn't undo reply", new Error(error.message), 'Reply not unsent');
    else await showLocalNotification({ title: 'Reply unsent', data: { kind: 'reply_unsent', conversation_id: conversation }, group: `conv:${conversation}`, quiet: true, identifier: `reply_sent_${conversation}` });
    return;
  }

  if (action === MARK_READ_ACTION) {
    await markConversationRead(conversation, notifId);
    await dismissQuietly(identifier);
    return;
  }

  if (action === MUTE_HOUR_ACTION) {
    if (!conversation) return dismissQuietly(identifier);
    try {
      await muteConversationFor(conversation, 60);
      await markConversationRead(conversation, notifId);
      await dismissQuietly(identifier);
    } catch (e) {
      await failed(identifier, conversation, "Couldn't mute chat", e, 'Chat not muted');
    }
    return;
  }

  if (action === LIKE_ACTION) {
    const me = await myId();
    if (!conversation || !me) return dismissQuietly(identifier);
    try {
      const mid = await latestIncoming(conversation, me, str(data.message_id));
      if (!mid) throw new Error('Nothing to like yet');
      await toggleReaction(conversation, mid, me, '❤️', true);
      await markConversationRead(conversation, notifId);
      await dismissQuietly(identifier);
    } catch (e) {
      await failed(identifier, conversation, "Couldn't like message", e, 'Like not sent');
    }
    return;
  }

  const quick = QUICK_REPLIES.find((q) => q.id === action);
  if (action !== REPLY_ACTION && !quick) return;
  const text = quick ? quick.text : res.userText?.trim();
  if (!conversation || !text) {
    await dismissQuietly(identifier);
    return;
  }
  let sent: { id: string } | null = null;
  try {
    sent = await sendChatMessage(conversation, text);
  } catch (e) {
    // Blocked / RLS / offline: tell the user, and let a tap open the conversation.
    await failed(identifier, conversation, "Couldn't send reply", e, 'Message not sent');
    return;
  }
  await markConversationRead(conversation, notifId);
  // Replaces the alert (also stops the "sending" spinner Android shows on an inline reply).
  await dismissQuietly(identifier);
  const name = str(data.actor_name) ?? (content.title && content.title !== 'Zoyra' ? content.title : undefined);
  await showLocalNotification({
    identifier: `reply_sent_${conversation}`,
    title: name ? `Reply sent to ${name.split(' ')[0]}` : 'Reply sent',
    body: text,
    group: `conv:${conversation}`,
    categoryId: REPLY_SENT_CATEGORY,
    quiet: true,
    data: { kind: 'reply_sent', conversation_id: conversation, message_id: sent.id, url: `/chat-pro?id=${encodeURIComponent(conversation)}` },
  });
}

/**
 * Mount once inside the router (root layout); pass `ready` = true once the root <Stack> is rendered. Routes notification taps — including the tap that
 * cold-started the app — to `data.url`, marks the matching inbox row read when `data.notification_id` is set,
 * and handles the chat quick actions (Reply / Mark as read).
 */
export function useNotificationRouting(ready: boolean) {
  // Opens a tap that arrived before the navigator existed (cold start) once it is mounted.
  useEffect(() => {
    setNavReady(ready);
    return () => setNavReady(false);
  }, [ready]);

  useEffect(() => {
    // Expo Go on Android (SDK 53+) and web don't ship the notification-response APIs; calling them throws
    // UnavailabilityError at launch. Everything below is optional, so bail out quietly when unsupported.
    if (Platform.OS === 'web') return;
    try {
      configureNotificationHandler();
    } catch {
      return;
    }

    const respond = (res: Notifications.NotificationResponse | null) => {
      if (!res) return;
      const key = responseKey(res);
      if (handledResponses.has(key)) return;
      handledResponses.add(key);
      clearLastResponse();

      if (res.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        void handleNotificationAction(res).catch(() => undefined);
        return;
      }
      const data = res.notification.request.content.data ?? {};
      const notifId = str(data.notification_id);
      if (notifId) void supabase.from('notifications').update({ read: true }).eq('id', notifId).then(undefined, () => undefined);
      const path = notificationHref(str(data.kind) ?? '', data);
      if (path) openWhenReady(path);
    };

    // Response that cold-started the app (a tap, or on Android a quick action still pending in this process).
    Notifications.getLastNotificationResponseAsync()
      .then(respond)
      .catch(() => undefined);

    // Taps and quick actions while the app is running (foreground or background).
    let sub: { remove: () => void } | null = null;
    try {
      sub = Notifications.addNotificationResponseReceivedListener(respond);
    } catch {
      sub = null;
    }
    return () => sub?.remove();
  }, []);
}

/* ================================================================== unread counts */

/** Live count of unread rows in `notifications` (optionally only some kinds). */
export function useUnreadNotifications(userId: string | undefined, kinds?: string[]) {
  const [count, setCount] = useState(0);
  const kindKey = kinds?.join(',') ?? '';

  const load = useCallback(async () => {
    if (!userId) {
      setCount(0);
      return;
    }
    let q = supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('read', false);
    if (kindKey) q = q.in('kind', kindKey.split(','));
    const { count: c, error } = await q;
    if (!error) setCount(c ?? 0);
  }, [userId, kindKey]);

  useEffect(() => {
    // Deferred a tick so the effect body itself never sets state synchronously.
    void Promise.resolve().then(load);
    if (!userId) return;
    const ch = supabase
      .channel(`notif-count:${userId}:${kindKey}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, () => void load())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch).then(undefined, () => undefined);
    };
  }, [userId, kindKey, load]);

  return { count, reload: load };
}
