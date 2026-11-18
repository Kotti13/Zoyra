/**
 * Android E2EE message notifications. The push function sends end-to-end encrypted chat messages as
 * DATA-ONLY pushes (no title/body) with the presentation the server would have used:
 *   { ...data (kind 'message', conversation_id, notification_id, actor_name, message_id, e2ee: true),
 *     zoyra_msg: '1', msg_title, msg_fallback (generic text), channel_id, category_id?, group?, count }
 * (`title` / `body` / `message` keys are avoided inside data so expo-notifications never presents it itself.)
 * The background notification task (native-call.ts, runs in foreground, background and killed states)
 * calls `handleE2EEMessagePush`, which decrypts the message on this phone and posts a local notification
 * with the real text on the same channel / category / grouping. If decryption fails the generic body is
 * shown. iOS uses the Notification Service Extension instead (plugins/zoyra-nse).
 */
import { maskedChatBody } from './chat-lock';
import { supabase } from './supabase';
import { Platform } from 'react-native';

import { decryptNotificationPreview } from './e2ee';
import { presentChatNotification } from './push';

const seen = new Set<string>();
/** Transport keys (push function + Expo's FCM wrapper) not copied into the local notification's data. */
const TRANSPORT = ['zoyra_msg', 'msg_title', 'msg_fallback', 'channel_id', 'category_id', 'group', 'dataString', 'body', 'title', 'message', 'experienceId', 'scopeKey', 'projectId'];

function flatten(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  let data = (outer.data && typeof outer.data === 'object' ? outer.data : outer) as Record<string, unknown>;
  for (const key of ['dataString', 'body']) {
    const v = data[key];
    if (typeof v === 'string' && v.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(v);
        if (parsed && typeof parsed === 'object') data = { ...data, ...(parsed as Record<string, unknown>) };
      } catch {
        // not JSON
      }
    }
  }
  return data;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Returns true when `raw` was an E2EE message push (handled). Never throws. */
export async function handleE2EEMessagePush(raw: unknown): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const d = flatten(raw);
  if (!d || (d.zoyra_msg !== '1' && d.zoyra_msg !== 1 && d.zoyra_msg !== true)) return false;
  const mid = str(d.message_id);
  const cid = str(d.conversation_id);
  if (!mid || !cid) return true;
  if (seen.has(mid)) return true;
  seen.add(mid);
  if (seen.size > 200) seen.delete(seen.values().next().value as string);

  let body = str(d.msg_fallback) ?? 'Sent you a message';
  try {
    const preview = await Promise.race([decryptNotificationPreview(d), new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    if (preview?.body) body = preview.body;
  } catch {
    // keep the generic text
  }
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!TRANSPORT.includes(k)) data[k] = v;
  const group = str(d.group);
  try {
    const { data: sess } = await supabase.auth.getSession();
    body = await maskedChatBody(sess.session?.user.id, str(d.conversation_id), body);
  } catch {
    // keep the text
  }
  await presentChatNotification({
    identifier: group ?? `msg_${mid}`,
    title: str(d.msg_title) ?? 'Zoyra',
    body: body.slice(0, 1000),
    data,
    channelId: str(d.channel_id),
    categoryId: str(d.category_id),
    group,
  });
  return true;
}
