// voip-push: wakes the callee's devices so an incoming call rings natively (CallKit / full-screen call notification).
// Called by the `call_voip_notify` trigger on public.calls (supabase/migrations/20261115220000_voip_calls.sql).
// NO user JWT (verify_jwt = false): the trigger sends `x-webhook-secret` (= PUSH_WEBHOOK_SECRET / Vault secret).
//
// POST { type: 'call' | 'call_cancel', call_id, user_id (callee), caller_id, caller_name, kind, conversation_id,
//        created_at, reason? }  → { ios: { sent, removed } | 'voip_not_configured', android: { sent } }
//   iOS      APNs VoIP push (HTTP/2, apns-push-type voip, topic <bundle>.voip, JWT ES256 from the .p8 key) to every
//            voip_tokens row with platform 'ios'. The app reports it to CallKit natively (plugins/zoyra-calls/ios/ZoyraVoip.m).
//            Cancel pushes are sent for cancelled / missed / accepted (answered elsewhere); never for declined
//            (that is almost always this very device, and iOS needs a reported call for every VoIP push).
//   Android  high-priority DATA-ONLY Expo push (no title/body → headless; runs the app's background notification task,
//            src/lib/native-call.ts) to the Expo tokens in voip_tokens with platform 'android'.
//   503 { error: 'voip_not_configured' } when APNs secrets are missing AND there is no Android device to reach.
//
// POST { action: 'decline', call_id, token }  (no secret: from the iOS app when the user declines on the CallKit
//   screen while JS isn't running). `token` = HMAC-SHA256(HMAC-SHA256(webhook secret, "decline-key"), "decline:<call_id>:<callee_id>") hex, sent
//   in the call push (opaque to the app). → { status } · 401 for an unknown call or a bad token alike.
//
// Secrets: APNS_KEY_P8 (contents of AuthKey_XXXX.p8), APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (com.zoyra.app),
//          APNS_ENV ('production' | 'sandbox', default production; a BadDeviceToken is retried once on the other host),
//          optional EXPO_ACCESS_TOKEN (same as the push function).
import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, safeEqual } from '../_shared/http.ts';
import { webhookSecret } from '../_shared/webhook.ts';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const RING_S = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IOS_CANCEL_REASONS = new Set(['cancelled', 'missed', 'accepted']);

type Admin = NonNullable<ReturnType<typeof adminClient>>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ------------------------------------------------------------------ decline token */

const enc = new TextEncoder();
async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

/**
 * Per-call decline token. The key is derived from the webhook secret (HMAC(secret, "decline-key")) so the
 * value sent to devices is never a direct MAC under the secret that also authenticates the DB trigger.
 */
async function declineToken(secret: string, callId: string, callee: string): Promise<string> {
  const key = await hmac(enc.encode(secret), 'decline-key');
  return hex(await hmac(key, `decline:${callId}:${callee}`));
}

/* ------------------------------------------------------------------ APNs */

type Apns = { keyId: string; teamId: string; bundleId: string; p8: string; env: 'production' | 'sandbox' };

function apnsConfig(): Apns | null {
  const p8 = Deno.env.get('APNS_KEY_P8') ?? '';
  const keyId = Deno.env.get('APNS_KEY_ID') ?? '';
  const teamId = Deno.env.get('APNS_TEAM_ID') ?? '';
  const bundleId = Deno.env.get('APNS_BUNDLE_ID') ?? '';
  if (!p8 || !keyId || !teamId || !bundleId) return null;
  return { p8, keyId, teamId, bundleId, env: Deno.env.get('APNS_ENV') === 'sandbox' ? 'sandbox' : 'production' };
}

let jwtCache: { token: string; at: number } | null = null;

/** Provider token (JWT ES256), reused for 50 minutes (APNs accepts 20–60 min old tokens). */
async function apnsJwt(cfg: Apns): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache && now - jwtCache.at < 50 * 60) return jwtCache.token;
  const pem = cfg.p8.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const head = b64url(enc.encode(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })));
  const claims = b64url(enc.encode(JSON.stringify({ iss: cfg.teamId, iat: now })));
  // WebCrypto ECDSA returns the raw r||s signature JWS ES256 expects.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  const token = `${head}.${claims}.${b64url(sig)}`;
  jwtCache = { token, at: now };
  return token;
}

const apnsHost = (env: Apns['env']) => (env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');

type ApnsResult = 'ok' | 'dead' | 'error';

async function sendApns(cfg: Apns, token: string, payload: unknown, expiration: number): Promise<ApnsResult> {
  const jwt = await apnsJwt(cfg);
  const attempt = async (env: Apns['env']) => {
    // Deno's fetch negotiates HTTP/2 with APNs over TLS (ALPN), which APNs requires.
    const res = await fetch(`${apnsHost(env)}/3/device/${token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': `${cfg.bundleId}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': String(expiration),
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    let reason = '';
    if (!res.ok) {
      try {
        reason = String(((await res.json()) as { reason?: string }).reason ?? '');
      } catch {
        // no body
      }
    } else {
      await res.body?.cancel();
    }
    return { status: res.status, reason };
  };
  let r = await attempt(cfg.env);
  // A development build's token only works on the sandbox host (and vice versa): try the other one once.
  if (r.status === 400 && r.reason === 'BadDeviceToken') r = await attempt(cfg.env === 'sandbox' ? 'production' : 'sandbox');
  if (r.status === 200) return 'ok';
  if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'DeviceTokenNotForTopic') return 'dead';
  if (r.status === 403 && (r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken')) jwtCache = null;
  console.warn(`voip-push: APNs ${r.status} ${r.reason}`);
  return 'error';
}

/* ------------------------------------------------------------------ handlers */

async function handleDecline(admin: Admin, body: Record<string, unknown>): Promise<Response> {
  const callId = str(body.call_id).toLowerCase();
  const token = str(body.token);
  if (!UUID_RE.test(callId) || !token) return error(400, 'invalid_body');
  const secret = await webhookSecret();
  if (!secret) return notConfigured('voip-push');
  const { data: call } = await admin.from('calls').select('id, callee_id, status').eq('id', callId).maybeSingle();
  // Unknown call and bad token look the same (no call-id probing).
  const expected = await declineToken(secret, callId, String(call?.callee_id ?? 'none'));
  if (!call || !safeEqual(token, expected)) return error(401, 'unauthorized');
  const { data, error: rpcErr } = await admin.rpc('voip_decline_call', { p_call_id: callId, p_callee: call.callee_id });
  if (rpcErr) return error(502, 'decline_failed', { message: rpcErr.message });
  return json({ status: (data as { status?: string } | null)?.status ?? call.status });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const admin = adminClient();
  if (!admin) return notConfigured('supabase');
  const body = await readJson(req);
  if (!body) return error(400, 'invalid_body');

  if (body.action === 'decline') {
    try {
      return await handleDecline(admin, body);
    } catch (e) {
      return error(502, 'decline_failed', { message: errMessage(e) });
    }
  }

  const secret = await webhookSecret();
  if (!secret) return notConfigured('voip-push');
  if (!safeEqual(req.headers.get('x-webhook-secret') ?? '', secret)) return error(401, 'unauthorized');

  const type = body.type === 'call_cancel' ? 'call_cancel' : body.type === 'call' ? 'call' : '';
  const callId = str(body.call_id).toLowerCase();
  const userId = str(body.user_id);
  if (!type || !UUID_RE.test(callId) || !userId) return error(400, 'invalid_body', { message: 'type, call_id and user_id are required' });
  const reason = str(body.reason);
  const kind = body.kind === 'video' ? 'video' : 'audio';
  const callerName = str(body.caller_name).slice(0, 120) || 'Zoyra';
  const createdMs = Date.parse(str(body.created_at)) || Date.now();
  const expiresAt = Math.floor(createdMs / 1000) + RING_S;

  try {
    // Same switches as the push function: master `push` and the `calls` category.
    const { data: settings } = await admin.from('user_settings').select('notifications').eq('user_id', userId).maybeSingle();
    const prefs = (settings?.notifications ?? {}) as Record<string, unknown>;
    if (type === 'call' && (prefs.push === false || prefs.calls === false)) return json({ skipped: 'disabled' });

    const { data: rows, error: tokErr } = await admin.from('voip_tokens').select('token, platform, push_token').eq('user_id', userId);
    if (tokErr) throw tokErr;
    const ios = (rows ?? []).filter((r) => r.platform === 'ios').map((r) => String(r.token));
    const android = (rows ?? []).filter((r) => r.platform === 'android').map((r) => String(r.push_token || r.token)).filter((t) => t.startsWith('ExponentPushToken') || t.startsWith('ExpoPushToken'));

    const shared = {
      type,
      call_id: callId,
      caller_id: str(body.caller_id),
      caller_name: callerName,
      kind,
      conversation_id: str(body.conversation_id),
      expires_at: expiresAt,
      ...(type === 'call_cancel' ? { reason: reason || 'cancelled' } : {}),
    };

    /* ---------- iOS */
    const cfg = apnsConfig();
    let iosResult: { sent: number; removed: number } | 'voip_not_configured' | 'skipped' = { sent: 0, removed: 0 };
    if (ios.length && !cfg) iosResult = 'voip_not_configured';
    else if (ios.length && type === 'call_cancel' && !IOS_CANCEL_REASONS.has(reason)) iosResult = 'skipped';
    else if (ios.length && cfg) {
      const extra = type === 'call'
        ? { decline_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/voip-push`, decline_token: await declineToken(secret, callId, userId) }
        : {};
      const payload = { aps: {}, zoyra: { ...shared, ...extra } };
      // Calls expire with the ring; a cancel is useless later too (0 = deliver now or never).
      const expiration = type === 'call' ? expiresAt : 0;
      const results = await Promise.all(ios.map((t) => sendApns(cfg, t, payload, expiration).catch(() => 'error' as const)));
      const dead = ios.filter((_t, i) => results[i] === 'dead');
      if (dead.length) await admin.from('voip_tokens').delete().in('token', dead);
      iosResult = { sent: results.filter((r) => r === 'ok').length, removed: dead.length };
    }

    /* ---------- Android: data-only, high priority (https://docs.expo.dev/push-notifications/sending-notifications/) */
    let androidSent = 0;
    if (android.length) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      const expoToken = Deno.env.get('EXPO_ACCESS_TOKEN');
      if (expoToken) headers.Authorization = `Bearer ${expoToken}`;
      // No title / body / `title` / `message` inside data: expo-notifications must not present it itself.
      const messages = android.map((to) => ({
        to,
        data: { zoyra_call: '1', ...shared, expires_at: String(expiresAt) },
        priority: 'high',
        ttl: type === 'call' ? RING_S : 30,
      }));
      const res = await fetch(EXPO_URL, { method: 'POST', headers, body: JSON.stringify(messages) });
      if (res.ok) {
        const out = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
        const dead: string[] = [];
        (out.data ?? []).forEach((t, i) => {
          if (t.status === 'ok') androidSent++;
          else if (t.details?.error === 'DeviceNotRegistered') dead.push(android[i]);
        });
        if (dead.length) await admin.from('voip_tokens').delete().in('push_token', dead);
      } else {
        console.warn(`voip-push: Expo push ${res.status}`);
      }
    }

    if (iosResult === 'voip_not_configured' && !android.length) return error(503, 'voip_not_configured');
    return json({ ios: iosResult, android: { sent: androidSent } });
  } catch (e) {
    return error(502, 'voip_push_failed', { message: errMessage(e) });
  }
});
