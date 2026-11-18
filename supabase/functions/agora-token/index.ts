// agora-token: Agora RTC token for one 1:1 call (voice/video) or one group call room. Client contracts:
//   src/lib/calls.ts (POST { call_id }) · src/lib/group-calls.ts (POST { group_call_id } → same response shape;
//   uid = the person's group_call_participants.agora_uid, so they must have joined through join_group_call /
//   start_group_call first; errors: 404 call_not_found · 403 not_participant · 409 call_not_active · 403 blocked).
// Auth: user JWT (verify_jwt = true in config.toml, and verified again here with requireUser).
// POST { call_id } → 200 { app_id, channel, token, uid, expires_at, encryption }
//   uid        1 for the caller, 2 for the callee (fixed per call, so each side knows the other's uid)
//   expires_at unix seconds (token + privileges last 10 minutes; the client renews on
//              onTokenPrivilegeWillExpire → src/lib/call-session.ts, so an ended call loses media within 10 min)
//   encryption { mode: 'aes_128_gcm2', key, salt } — per-call media encryption secret, generated here on
//              first request and stored in public.call_secrets (service role only), so both sides get the
//              same pair. key = 64 hex chars (32 random bytes), salt = base64 of 32 random bytes.
//              null when the call_secrets table is missing (migration 20261115210000 not applied yet).
//              The server knows the key: this is media encryption, not end-to-end encryption.
// Errors: 400 invalid_body · 401 unauthorized · 403 not_participant · 404 call_not_found
//         409 call_not_active (status is not ringing/accepted) · 409 call_not_accepted (callee asks while the
//         call is still ringing: only the caller may pre-join) · 403 blocked (a block exists between the
//         two people) · 503 calls_not_configured
//         (AGORA_APP_ID / AGORA_APP_CERTIFICATE missing) · 502 token_failed
//
// Token: AccessToken2 ("007…") via Agora's official npm builder (RtcTokenBuilder.buildTokenWithUid,
// role PUBLISHER). It is CommonJS and uses node:crypto / node:zlib / Buffer, which Deno's npm compat
// provides; import the default export (named exports aren't detected for this module).
import agora from 'npm:agora-token@2.0.7';

import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const { RtcTokenBuilder, RtcRole } = agora;

const TOKEN_TTL_S = 600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Encryption = { mode: 'aes_128_gcm2'; key: string; salt: string };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** The call's encryption key + salt (created once, race-safe: insert-if-missing, then read). */
async function callEncryption(admin: NonNullable<ReturnType<typeof adminClient>>, callId: string, table = 'call_secrets'): Promise<Encryption | null> {
  const ins = await admin
    .from(table)
    .upsert({ call_id: callId, encryption_key: hex(randomBytes(32)), encryption_salt: b64(randomBytes(32)) }, { onConflict: 'call_id', ignoreDuplicates: true });
  if (ins.error) {
    // Table not there yet (older database): calls still work, just without media encryption.
    if (ins.error.code === '42P01' || ins.error.code === 'PGRST205' || /could not find the table|does not exist/i.test(ins.error.message ?? '')) return null;
    throw ins.error;
  }
  const { data, error: err } = await admin.from(table).select('encryption_key, encryption_salt').eq('call_id', callId).maybeSingle();
  if (err) throw err;
  if (!data) return null;
  return { mode: 'aes_128_gcm2', key: data.encryption_key as string, salt: data.encryption_salt as string };
}

/** Stable Agora uid for each side of a call. */
const CALLER_UID = 1;
const CALLEE_UID = 2;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const appId = Deno.env.get('AGORA_APP_ID')?.trim() ?? '';
  const certificate = Deno.env.get('AGORA_APP_CERTIFICATE')?.trim() ?? '';
  if (!appId || !certificate) return error(503, 'calls_not_configured', { service: 'agora' });

  const body = await readJson(req);
  const groupId = typeof body?.group_call_id === 'string' ? body.group_call_id.trim() : '';
  const callId = typeof body?.call_id === 'string' ? body.call_id.trim() : '';
  if (groupId ? !UUID_RE.test(groupId) : !UUID_RE.test(callId)) return error(400, 'invalid_body', { message: 'call_id is required' });

  const admin = adminClient();
  if (!admin) return notConfigured('supabase');

  if (groupId) {
    try {
      const { data: g, error: gErr } = await admin.from('group_calls').select('id, conversation_id, status, channel').eq('id', groupId).maybeSingle();
      if (gErr) throw gErr;
      if (!g) return error(404, 'call_not_found');
      // Must be an active group member AND have joined the room through the RPC (that assigns the uid).
      const { data: member, error: mErr } = await admin
        .from('conversation_members')
        .select('user_id')
        .eq('conversation_id', g.conversation_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (mErr) throw mErr;
      if (!member) return error(403, 'not_participant');
      if (g.status !== 'live') return error(409, 'call_not_active', { status: g.status });
      const { data: part, error: pErr } = await admin
        .from('group_call_participants')
        .select('agora_uid, left_at')
        .eq('call_id', g.id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!part || part.left_at) return error(403, 'not_participant');
      const gToken: string = RtcTokenBuilder.buildTokenWithUid(appId, certificate, g.channel, part.agora_uid as number, RtcRole.PUBLISHER, TOKEN_TTL_S, TOKEN_TTL_S);
      const gExpires = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
      const gEnc = await callEncryption(admin, g.id, 'group_call_secrets');
      return json({ app_id: appId, channel: g.channel, token: gToken, uid: part.agora_uid, expires_at: gExpires, encryption: gEnc });
    } catch (e) {
      return error(502, 'token_failed', { message: errMessage(e) });
    }
  }

  try {
    const { data: call, error: err } = await admin
      .from('calls')
      .select('id, caller_id, callee_id, status, channel')
      .eq('id', callId)
      .maybeSingle();
    if (err) throw err;
    if (!call) return error(404, 'call_not_found');

    const uid = call.caller_id === user.id ? CALLER_UID : call.callee_id === user.id ? CALLEE_UID : 0;
    if (!uid) return error(403, 'not_participant');
    if (call.status !== 'ringing' && call.status !== 'accepted') {
      return error(409, 'call_not_active', { status: call.status });
    }
    // The callee joins the channel only after answering (answer_call → 'accepted').
    if (uid === CALLEE_UID && call.status !== 'accepted') {
      return error(409, 'call_not_accepted', { status: call.status });
    }
    const { data: blocks, error: blockErr } = await admin
      .from('blocks')
      .select('blocker_id')
      .or(`and(blocker_id.eq.${call.caller_id},blocked_id.eq.${call.callee_id}),and(blocker_id.eq.${call.callee_id},blocked_id.eq.${call.caller_id})`)
      .limit(1);
    if (blockErr) throw blockErr;
    if (blocks && blocks.length) return error(403, 'blocked');

    const token: string = RtcTokenBuilder.buildTokenWithUid(
      appId,
      certificate,
      call.channel,
      uid,
      RtcRole.PUBLISHER,
      TOKEN_TTL_S,
      TOKEN_TTL_S,
    );
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
    const encryption = await callEncryption(admin, call.id);
    return json({ app_id: appId, channel: call.channel, token, uid, expires_at: expiresAt, encryption });
  } catch (e) {
    return error(502, 'token_failed', { message: errMessage(e) });
  }
});
