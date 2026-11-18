// push: sends an Expo push to every device of one user. Called by the database notify trigger.
// NO user JWT: verifies the `x-webhook-secret` header against PUSH_WEBHOOK_SECRET.
// POST { user_id, title, body, data?: { category?, kind?, conversation_id?, count?, ... } } → { sent, skipped?, removed }
//
// Chat messages are grouped per conversation (fields from the Expo push message request format,
// https://docs.expo.dev/push-notifications/sending-notifications/#message-request-format):
//   collapseId (Android + iOS) coalesces in transit; on iOS it also replaces the displayed notification
//   tag        (Android)       replaces the notification already displayed on the device
//   threadId   (iOS)           visually stacks notifications of one conversation
// so the shade shows one "Priya · 3 new messages · <latest>" notification per conversation.
// categoryId attaches one of the app's chat categories (Reply / quick replies / Mark read / Mute 1h / Like).
// channelId picks the Android channel for the user's sound / vibration / pop-up settings (or `quiet`).
// `data` is forwarded (+ message_id of the message shown), so the app's action handler can act on it.
//
// End-to-end encrypted messages (data.e2ee === true, the server only has ciphertext; see src/lib/e2ee/README.md
// "Notification previews"), when the user shows message text in alerts:
//   Android  DATA-ONLY high-priority push (no title / body, so expo-notifications doesn't present it). The app's
//            background task (src/lib/native-call.ts / push.ts) decrypts the message itself and presents a local
//            notification. data += { zoyra_msg: '1', msg_title, msg_fallback, channel_id, category_id?, group?, count }.
//            (`title` / `message` / `body` keys are avoided inside data on purpose.)
//   iOS      one push per token with mutableContent so the Notification Service Extension (plugins/zoyra-nse) can
//            replace the generic body. Tokens registered with an E2EE device id also get `zx`: the message
//            ciphertext + THIS device's envelope + the sender device's public keys (see ZX below). If the payload
//            would exceed the APNs 4 KB limit, `zx` is dropped and the generic text stays.
// Rich previews: never for encrypted rows; images only from this project's storage or the Audius CDN.
import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, safeEqual } from '../_shared/http.ts';
import { webhookSecret } from '../_shared/webhook.ts';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK = 100;

/**
 * Default per category when the user never touched the toggle.
 * Keys match src/app/notif-settings.tsx; trigger-only categories default to on.
 */
const DEFAULTS: Record<string, boolean> = {
  messages: true,
  dedications: true,
  new_followers: true,
  playlist_updates: true,
  new_releases: true,
  weekly_report: true,
  concerts: true,
  live_reminders: true,
  downloads: true,
  friend_activity: false,
  recommendations: false,
};

/** Message alert switches (keys + defaults match MESSAGE_ALERT_PREFS in src/lib/push.ts). */
const MSG_DEFAULTS: Record<string, boolean> = {
  msg_sender: true,
  msg_preview: true,
  msg_rich: true,
  msg_group: true,
  msg_reply: true,
  msg_quick: true,
  msg_mark_read: true,
  msg_banner: true,
};

type Sound = 'chime' | 'default' | 'none';
type Vibration = 'short' | 'long' | 'none';

/** MESSAGE_ALERT_CHOICES in src/lib/push.ts (msg_sound used to be a boolean: true = chime, false = none). */
function soundPref(prefs: Record<string, unknown>): Sound {
  const v = prefs.msg_sound;
  if (typeof v === 'boolean') return v ? 'chime' : 'none';
  return v === 'default' || v === 'none' || v === 'chime' ? v : 'chime';
}
function vibrationPref(prefs: Record<string, unknown>): Vibration {
  const v = prefs.msg_vibration;
  return v === 'long' || v === 'none' || v === 'short' ? v : 'short';
}

/** Bundled sound (assets/sounds/zoyra_chime.wav via the expo-notifications config plugin `sounds`). */
const CHIME_SOUND = 'zoyra_chime.wav';
/** Android channels created by the app (src/lib/push.ts ensureAndroidChannel). */
const QUIET_CHANNEL_ID = 'quiet';
function messageChannelId(sound: Sound, vibration: Vibration, banner: boolean): string {
  return `msg_${sound}_${vibration}_${banner ? 'h' : 'q'}`;
}

/** Category registered by the app for this mix of actions (keep in sync with chatCategoryId in src/lib/push.ts). */
function chatCategoryId(reply: boolean, quick: boolean, markRead: boolean): string | null {
  if (!reply && !quick && !markRead) return null;
  if (reply && !quick && markRead) return 'chat_message';
  return `chat${reply ? '_r' : ''}${quick ? '_q' : ''}${markRead ? '_m' : ''}`;
}

/** Quiet hours defaults (match src/app/notif-settings.tsx). */
const QUIET_FROM = '23:00';
const QUIET_UNTIL = '07:00';

function minutesOf(hhmm: unknown, fallback: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof hhmm === 'string' ? hhmm : fallback) ?? /^(\d{1,2}):(\d{2})$/.exec(fallback);
  return m ? (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60) : 0;
}

/** True when the user's quiet hours are on and it is currently inside them in their time zone (`tz`). */
function inQuietHours(prefs: Record<string, unknown>, now = new Date()): boolean {
  if (prefs.quiet_hours === false) return false;
  const tz = typeof prefs.tz === 'string' ? prefs.tz : '';
  if (!tz) return false; // unknown local time: never guess
  let local: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    local = (h % 24) * 60 + m;
  } catch {
    return false;
  }
  const from = minutesOf(prefs.quiet_from, QUIET_FROM);
  const until = minutesOf(prefs.quiet_until, QUIET_UNTIL);
  if (from === until) return false;
  return from < until ? local >= from && local < until : local >= from || local < until;
}

type Admin = NonNullable<ReturnType<typeof adminClient>>;
type Rich = { messageId?: string; secondLine?: string; image?: string };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Hosts rich-preview images may come from: this project's storage and the Audius CDN (catalog artwork). */
function allowedImage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    const own = Deno.env.get('SUPABASE_URL');
    const ownHost = own ? new URL(own).host : '';
    if (ownHost && u.host === ownHost && u.pathname.startsWith('/storage/v1/object/public/')) return url;
    if (u.hostname === 'audius.co' || u.hostname.endsWith('.audius.co')) return url;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Artwork of a stored track: a string, or CatalogTrack's `{ small, medium, large }`. */
function artworkOf(track: Record<string, unknown>): string | undefined {
  for (const k of ['artwork', 'cover', 'image', 'cover_url']) {
    const v = track[k];
    if (typeof v === 'string') return str(v);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const hit = str(o.medium) ?? str(o.large) ?? str(o.small);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * The message behind a chat alert (via its notification row), for rich previews: a shared song's title,
 * artist and cover, or a signed URL for a photo. Also returns the message id so the app's "Like"
 * action reacts to exactly this message. Never throws.
 */
async function richOf(admin: Admin, notificationId: string): Promise<Rich> {
  try {
    const { data: n } = await admin.from('notifications').select('payload').eq('id', notificationId).maybeSingle();
    const messageId = str((n?.payload as Record<string, unknown> | undefined)?.message_id);
    if (!messageId) return {};
    const { data: m } = await admin.from('messages').select('id, kind, track, meta, e2ee_version').eq('id', messageId).maybeSingle();
    if (!m) return { messageId };
    if (m.e2ee_version != null) return { messageId }; // encrypted: the server has nothing to preview
    const track = m.track && typeof m.track === 'object' ? (m.track as Record<string, unknown>) : null;
    const meta = m.meta && typeof m.meta === 'object' ? (m.meta as Record<string, unknown>) : {};
    if (track && (m.kind === 'track' || m.kind === 'swap' || m.kind === 'text')) {
      const artistRaw = track.artist;
      const artist = str(artistRaw) ?? (artistRaw && typeof artistRaw === 'object' ? str((artistRaw as Record<string, unknown>).name) : undefined);
      const title = str(track.title);
      return { messageId, secondLine: [title, artist].filter(Boolean).join(' · ') || undefined, image: allowedImage(artworkOf(track)) };
    }
    // Photos: no image in the push (a long-lived signed URL of a private chat photo would leave the app).
    if (m.kind === 'playlist') {
      return { messageId, image: allowedImage(str(meta.cover_url)) };
    }
    return { messageId };
  } catch {
    return {};
  }
}

/**
 * Chat messages: title = sender display name (`actor_name`), body = latest message text (or
 * "N new messages · latest"), grouped per conversation and tagged with a chat category (inline Reply /
 * quick replies / Mark read / Mute 1h / Like, registered by the app in src/lib/push.ts). The user's
 * message alert settings decide whether the sender and text are shown, rich song / photo previews,
 * whether messages stack per chat, which buttons appear, the sound, the vibration (Android channel) and
 * whether it pops up as a banner (Android channel importance / iOS passive interruption level).
 * Quiet hours (any kind except calls): delivered silently to the notification list.
 */
async function present(admin: Admin, data: Record<string, unknown>, title: string, text: string, prefs: Record<string, unknown>, breakthrough = false) {
  // Forever friends with "Always gets through" on skip quiet hours (see foreverInfo).
  const quiet = data.kind !== 'call' && !breakthrough && inQuietHours(prefs);
  const conversation = typeof data.conversation_id === 'string' ? data.conversation_id : '';
  const isMessage = data.kind === 'message_request' || (data.kind === 'message' && !!conversation);
  if (!isMessage) {
    return {
      title,
      body: text,
      data,
      extra: quiet ? { channelId: QUIET_CHANNEL_ID, interruptionLevel: 'passive' } : {},
      sound: quiet ? null : 'default',
      e2ee: null,
    };
  }
  const pref = (key: string) => (typeof prefs[key] === 'boolean' ? (prefs[key] as boolean) : (MSG_DEFAULTS[key] ?? true));
  const sound = soundPref(prefs);
  const vibration = vibrationPref(prefs);
  const banner = pref('msg_banner');
  const showSender = pref('msg_sender');
  const showText = pref('msg_preview');
  const sender = typeof data.actor_name === 'string' && data.actor_name.trim() ? data.actor_name.trim().slice(0, 200) : title;
  const alertExtra = {
    channelId: quiet ? QUIET_CHANNEL_ID : messageChannelId(sound, vibration, banner),
    ...(quiet || !banner ? { interruptionLevel: 'passive' } : {}),
  };
  const iosSound = quiet || sound === 'none' ? null : sound === 'chime' ? CHIME_SOUND : 'default';

  if (data.kind === 'message_request') {
    return { title: showSender ? sender : 'Zoyra', body: showText ? text : 'New message request', data, extra: alertExtra, sound: iosSound, e2ee: null };
  }

  const grouped = pref('msg_group');
  const count = grouped && typeof data.count === 'number' && Number.isFinite(data.count) ? Math.max(1, Math.floor(data.count)) : 1;
  const notificationId = str(data.notification_id);
  const encrypted = data.e2ee === true;
  const rich: Rich = encrypted ? { messageId: str(data.message_id) } : notificationId ? await richOf(admin, notificationId) : {};
  const useRich = showText && pref('msg_rich');
  // "Sent you a song: Glass Hours" → "Sent you a song" + "Glass Hours · Nova Lane" on the next line.
  const base = useRich && rich.secondLine ? text.replace(/:\s.*$/, '') : text;
  const latest = showText ? (useRich && rich.secondLine ? `${base}\n${rich.secondLine}` : base) : 'New message';
  // Design (PushBanner/PushLock): sender + the latest message only. Stacking (collapse/thread id) keeps one
  // notification per conversation, so the count isn't repeated in the text.
  const body = showText ? latest : count > 1 ? `${count} new messages` : 'New message';
  const key = `conv:${conversation}`;
  const categoryId = chatCategoryId(pref('msg_reply'), pref('msg_quick'), pref('msg_mark_read'));
  return {
    title: showSender ? sender : 'Zoyra',
    body: body.slice(0, 1000),
    data: rich.messageId ? { ...data, message_id: rich.messageId } : data,
    // https://docs.expo.dev/push-notifications/sending-notifications/#message-request-format
    extra: {
      ...alertExtra,
      ...(grouped ? { collapseId: key, tag: key, threadId: key } : {}),
      ...(categoryId ? { categoryId } : {}),
      // Android shows the image itself; iOS needs a Notification Service Extension (mutableContent).
      ...(useRich && rich.image ? { richContent: { image: rich.image }, mutableContent: true } : {}),
    },
    sound: iosSound,
    // Encrypted message whose text the user wants in alerts: the phone decrypts it (see header).
    e2ee:
      encrypted && showText
        ? { channelId: alertExtra.channelId, categoryId, group: grouped ? key : null, count }
        : null,
  };
}

/* ------------------------------------------------------------------ Forever friends */

/** Gold ringtone for calls from a Forever friend (assets/sounds/zoyra_gold_ring.wav, expo-notifications `sounds`). */
const GOLD_RING_SOUND = 'zoyra_gold_ring.wav';
/** Android channel with the gold ringtone, created by the app (ensureForeverChannel in src/lib/forever.ts). */
const FOREVER_CALL_CHANNEL_ID = 'forever_call';

type ForeverInfo = { forever: boolean; breakthrough: boolean; ringtone: string | null };
const NOT_FOREVER: ForeverInfo = { forever: false, breakthrough: false, ringtone: null };

/**
 * Message / call alerts from a Forever friend (supabase/migrations/20261117100000_forever_friends.sql):
 * `breakthrough` → quiet hours are skipped; calls use the gold ringtone when the recipient picked it.
 * The sender comes from the notification row (sender_id / caller_id). Never throws.
 */
async function foreverInfo(admin: Admin, userId: string, data: Record<string, unknown>): Promise<ForeverInfo> {
  if (data.kind !== 'message' && data.kind !== 'call') return NOT_FOREVER;
  const notificationId = str(data.notification_id);
  if (!notificationId) return NOT_FOREVER;
  try {
    const { data: n } = await admin.from('notifications').select('payload').eq('id', notificationId).maybeSingle();
    const payload = (n?.payload ?? {}) as Record<string, unknown>;
    const sender = str(payload.sender_id) ?? str(payload.caller_id);
    if (!sender) return NOT_FOREVER;
    const { data: info, error: err } = await admin.rpc('forever_push_info', { recipient: userId, sender });
    if (err || !info || typeof info !== 'object') return NOT_FOREVER;
    const o = info as Record<string, unknown>;
    return { forever: o.forever === true, breakthrough: o.breakthrough === true, ringtone: typeof o.ringtone === 'string' ? o.ringtone : null };
  } catch {
    return NOT_FOREVER;
  }
}

/* ------------------------------------------------------------------ E2EE previews */

type E2EEAlert = { channelId: string; categoryId: string | null; group: string | null; count: number };

/**
 * `zx` (iOS, per token): what the Notification Service Extension needs to decrypt the preview with this
 * device's key from the shared keychain. Short keys keep the APNs payload small. All values base64 / uuid.
 *   v  1                      d   recipient device id      w/e/n  envelope wrapped_key / eph_pub / nonce
 *   c  message ciphertext     cn  message nonce            s      message signature
 *   sd sender device id       sp  sender device sign_pub   sa     sender device account_sig   se  sender device enc_pub
 *   ap sender account_sign_pub su sender user id           m      message id      ci conversation id   k kind
 */
type ZX = Record<string, string | number>;
type CryptoBundle = { base: Omit<ZX, 'd' | 'w' | 'e' | 'n'>; envelopes: Map<string, { w: string; e: string; n: string }> };

/** Message + sender keys + envelopes for these devices (service role; envelopes are committed before pg_net fires). */
async function cryptoBundle(admin: Admin, messageId: string, recipientId: string, tokenDevices: string[]): Promise<CryptoBundle | null> {
  if (!tokenDevices.length) return null;
  try {
    // push_tokens.device_id may point at a device revoked since registration: only ACTIVE devices of the recipient.
    const { data: active } = await admin.from('e2ee_devices').select('device_id').eq('user_id', recipientId).is('revoked_at', null).in('device_id', tokenDevices);
    const deviceIds = ((active ?? []) as { device_id: string }[]).map((d) => String(d.device_id));
    if (!deviceIds.length) return null;
    const { data: m } = await admin
      .from('messages')
      .select('id, conversation_id, sender_id, kind, e2ee_version, ciphertext, nonce, signature, sender_device_id')
      .eq('id', messageId)
      .maybeSingle();
    if (!m || m.e2ee_version !== 1 || !m.ciphertext || !m.sender_device_id) return null;
    // Time capsules (key withheld until the open date) and view-once photos never get a decryptable preview.
    if (m.kind === 'capsule' || m.kind === 'whisper') return null;
    const [dev, acc, keys] = await Promise.all([
      admin.from('e2ee_devices').select('user_id, enc_pub, sign_pub, account_sig').eq('device_id', m.sender_device_id).maybeSingle(),
      admin.from('e2ee_accounts').select('account_sign_pub').eq('user_id', m.sender_id).maybeSingle(),
      admin.from('message_keys').select('device_id, wrapped_key, eph_pub, nonce').eq('message_id', messageId).in('device_id', deviceIds),
    ]);
    if (!dev.data || dev.data.user_id !== m.sender_id || !acc.data) return null;
    const envelopes = new Map<string, { w: string; e: string; n: string }>();
    for (const k of (keys.data ?? []) as { device_id: string; wrapped_key: string; eph_pub: string; nonce: string }[]) {
      envelopes.set(String(k.device_id), { w: k.wrapped_key, e: k.eph_pub, n: k.nonce });
    }
    return {
      base: {
        v: 1,
        m: String(m.id),
        ci: String(m.conversation_id),
        k: String(m.kind ?? 'text'),
        c: String(m.ciphertext),
        cn: String(m.nonce),
        s: String(m.signature),
        sd: String(m.sender_device_id),
        sp: String(dev.data.sign_pub),
        se: String(dev.data.enc_pub),
        sa: String(dev.data.account_sig),
        ap: String(acc.data.account_sign_pub),
        su: String(m.sender_id),
      },
      envelopes,
    };
  } catch {
    return null;
  }
}

/** APNs allows 4096 bytes; Expo adds its own keys, so the part we control stays under this. */
const IOS_PAYLOAD_BUDGET = 3500;
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

type TokenRow = { token: string; platform: string | null; device_id: string | null };

type ExpoTicket = { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } };

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const secret = await webhookSecret();
  if (!secret) return notConfigured('push');
  if (!safeEqual(req.headers.get('x-webhook-secret') ?? '', secret)) return error(401, 'unauthorized');

  const admin = adminClient();
  if (!admin) return notConfigured('supabase');

  const body = await readJson(req);
  const userId = typeof body?.user_id === 'string' ? body.user_id : '';
  const title = typeof body?.title === 'string' ? body.title.slice(0, 200) : '';
  const text = typeof body?.body === 'string' ? body.body.slice(0, 1000) : '';
  const data = body?.data && typeof body.data === 'object' && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : {};
  if (!userId || (!title && !text)) return error(400, 'invalid_body', { message: 'user_id and title/body are required' });

  try {
    // Respect user_settings.notifications: a master `push` switch plus one toggle per category.
    const { data: settings } = await admin.from('user_settings').select('notifications').eq('user_id', userId).maybeSingle();
    const prefs = (settings?.notifications ?? {}) as Record<string, unknown>;
    const category = typeof data.category === 'string' ? data.category : '';
    if (prefs.push === false) return json({ sent: 0, skipped: 'disabled', removed: 0 });
    if (category) {
      const v = prefs[category];
      const enabled = typeof v === 'boolean' ? v : (DEFAULTS[category] ?? true);
      if (!enabled) return json({ sent: 0, skipped: 'category_off', removed: 0 });
    }

    // device_id comes with migration 20261115270000; before it is deployed fall back to token + platform.
    let tokenRows: TokenRow[] = [];
    {
      const withDevice = await admin.from('push_tokens').select('token, platform, device_id').eq('user_id', userId);
      if (!withDevice.error) tokenRows = (withDevice.data ?? []) as TokenRow[];
      else {
        const plain = await admin.from('push_tokens').select('token, platform').eq('user_id', userId);
        if (plain.error) throw plain.error;
        tokenRows = ((plain.data ?? []) as { token: string; platform: string | null }[]).map((r) => ({ ...r, device_id: null }));
      }
    }
    const rowByToken = new Map(tokenRows.map((r) => [r.token, r]));
    let tokens = tokenRows.map((r) => r.token).filter(Boolean);
    // Incoming calls ring natively on devices in voip_tokens (voip-push function); skip the plain push there.
    // iOS devices only when APNs is configured, otherwise this push is their only ring.
    if (data.kind === 'call' && tokens.length) {
      const apnsReady = ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID'].every((k) => !!Deno.env.get(k));
      const { data: native } = await admin.from('voip_tokens').select('platform, push_token').eq('user_id', userId);
      const skip = new Set(
        (native ?? [])
          .filter((r: { platform: string; push_token: string | null }) => !!r.push_token && (r.platform === 'android' || apnsReady))
          .map((r: { push_token: string | null }) => String(r.push_token)),
      );
      tokens = tokens.filter((t: string) => !skip.has(t));
    }
    if (tokens.length === 0) return json({ sent: 0, skipped: 'no_tokens', removed: 0 });

    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const expoToken = Deno.env.get('EXPO_ACCESS_TOKEN');
    if (expoToken) headers.Authorization = `Bearer ${expoToken}`;

    const fv = await foreverInfo(admin, userId, data);
    const presented = await present(admin, fv.forever ? { ...data, forever: true } : data, title, text, prefs, fv.breakthrough);
    // Forever friend calling: gold ringtone (iOS sound + Android channel) unless the recipient chose the default.
    const shown =
      fv.forever && data.kind === 'call' && fv.ringtone === 'gold'
        ? { ...presented, sound: GOLD_RING_SOUND, extra: { ...presented.extra, channelId: FOREVER_CALL_CHANNEL_ID } }
        : presented;
    const alert = shown.e2ee as E2EEAlert | null;
    const messageId = str(data.message_id);
    const iosDevices = alert
      ? tokens.map((t) => rowByToken.get(t)).filter((r): r is TokenRow => !!r && r.platform === 'ios' && !!r.device_id).map((r) => String(r.device_id))
      : [];
    const bundle = alert && messageId ? await cryptoBundle(admin, messageId, userId, iosDevices) : null;

    const build = (to: string) => {
      const row = rowByToken.get(to);
      const normal = {
        to,
        title: shown.title,
        body: shown.body,
        data: shown.data,
        ...(shown.sound ? { sound: shown.sound } : {}),
        priority: 'high',
        ...shown.extra,
      };
      if (!alert) return normal;
      if (row?.platform === 'android') {
        // Data-only: the app decrypts and presents (same channel / category / grouping as `normal`).
        return {
          to,
          priority: 'high',
          data: {
            ...shown.data,
            zoyra_msg: '1',
            msg_title: shown.title,
            msg_fallback: shown.body,
            channel_id: alert.channelId,
            ...(alert.categoryId ? { category_id: alert.categoryId } : {}),
            ...(alert.group ? { group: alert.group } : {}),
            count: alert.count,
          },
        };
      }
      if (row?.platform === 'ios') {
        const env = row.device_id ? bundle?.envelopes.get(String(row.device_id)) : undefined;
        const withZx = bundle && env ? { ...normal, mutableContent: true, data: { ...shown.data, zx: { ...bundle.base, d: String(row.device_id), ...env } } } : null;
        // Size check over what ends up in the APNs payload (aps alert + data).
        if (withZx && bytes({ t: withZx.title, b: withZx.body, d: withZx.data, c: shown.extra }) <= IOS_PAYLOAD_BUDGET) return withZx;
        return { ...normal, mutableContent: true };
      }
      return normal;
    };

    let sent = 0;
    const dead: string[] = [];
    for (let i = 0; i < tokens.length; i += CHUNK) {
      const batch = tokens.slice(i, i + CHUNK);
      const messages = batch.map(build);
      const res = await fetch(EXPO_URL, { method: 'POST', headers, body: JSON.stringify(messages) });
      if (!res.ok) throw new Error(`Expo push failed (${res.status})`);
      const out = (await res.json()) as { data?: ExpoTicket[] };
      (out.data ?? []).forEach((ticket, idx) => {
        if (ticket.status === 'ok') sent++;
        else if (ticket.details?.error === 'DeviceNotRegistered') dead.push(batch[idx]);
      });
    }

    if (dead.length) await admin.from('push_tokens').delete().in('token', dead);
    return json({ sent, removed: dead.length });
  } catch (e) {
    return error(502, 'push_failed', { message: errMessage(e) });
  }
});
