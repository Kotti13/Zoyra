// lastfm: Last.fm scrobbling proxy. The API key and shared secret never leave this function.
// POST JSON { action, ... }:
//   { action: 'auth_url', cb }                → { url }   (open in the browser; Last.fm redirects to cb?token=…)
//   { action: 'session', token }              → { username }   (auth.getSession, stores the session key)
//   { action: 'now_playing', track }          → { ok: true }
//   { action: 'scrobble', tracks: [≤50] }     → { accepted, ignored }
//   { action: 'disconnect' }                  → { ok: true }
// track = { artist, track, album?, duration?, timestamp? (unix seconds, required for scrobble) }
// Errors: 503 not_configured (service 'lastfm'), 401 unauthorized, 409 not_connected,
//         401 lastfm_session_invalid (row deleted, reconnect), 400 invalid_body / invalid_token,
//         502 lastfm_failed { message, retryable }.
import { crypto } from 'jsr:@std/crypto@1';
import { encodeHex } from 'jsr:@std/encoding@1/hex';

import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const API = 'https://ws.audioscrobbler.com/2.0/';
const SERVICE = 'lastfm';

type LastfmError = { error: number; message?: string };
type Track = { artist: string; track: string; album?: string; duration?: number; timestamp?: number };

const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

function parseTrack(v: unknown): Track | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const artist = str(o.artist);
  const track = str(o.track);
  if (!artist || !track) return null;
  return { artist, track, album: str(o.album), duration: int(o.duration), timestamp: int(o.timestamp) };
}

/** api_sig: md5 of every param (except format/callback) sorted by name as name+value, then the secret. */
async function sign(params: Record<string, string>, secret: string): Promise<string> {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('');
  const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode(base + secret));
  return encodeHex(new Uint8Array(digest));
}

type CallResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: number; message: string; status: number };

async function call(params: Record<string, string>, secret: string): Promise<CallResult> {
  const signed = { ...params, api_sig: await sign(params, secret), format: 'json' };
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Zoyra/1.0' },
    body: new URLSearchParams(signed).toString(),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON (e.g. gateway error page)
  }
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  if (obj && typeof (obj as LastfmError).error === 'number') {
    const e = obj as LastfmError;
    return { ok: false, code: e.error, message: e.message ?? 'Last.fm error', status: res.status };
  }
  if (!res.ok || !obj) return { ok: false, code: 0, message: `Last.fm request failed (${res.status})`, status: res.status };
  return { ok: true, data: obj };
}

/** Maps a Last.fm error to our response. Error 9 = the user revoked access: forget the session. */
async function fail(r: Extract<CallResult, { ok: false }>, userId: string): Promise<Response> {
  if (r.code === 9) {
    await adminClient()?.from('scrobble_accounts').delete().eq('user_id', userId).eq('service', SERVICE);
    return error(401, 'lastfm_session_invalid', { message: 'Last.fm access was revoked. Connect again.' });
  }
  if (r.code === 10 || r.code === 26) return error(502, 'lastfm_failed', { message: 'Last.fm rejected the API key', retryable: false });
  // 11/16 = temporarily unavailable, 29 = rate limited, 0/5xx = network or gateway.
  const retryable = r.code === 0 || r.code === 11 || r.code === 16 || r.code === 29 || r.status >= 500;
  return error(502, 'lastfm_failed', { message: r.message, retryable });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiKey = Deno.env.get('LASTFM_API_KEY');
  const secret = Deno.env.get('LASTFM_SHARED_SECRET');
  if (!apiKey || !secret) return notConfigured(SERVICE);
  const admin = adminClient();
  if (!admin) return notConfigured('supabase');

  const body = await readJson(req);
  if (!body) return error(400, 'invalid_body', { message: 'Expected a JSON object' });
  const action = str(body.action, 40);

  try {
    if (action === 'auth_url') {
      const cb = str(body.cb, 300);
      // Only app deep links (dev builds use exp://); never an arbitrary web page.
      if (!cb || !/^(zoyra|exp|exps):\/\//i.test(cb)) return error(400, 'invalid_body', { message: 'cb must be an app link' });
      const url = `https://www.last.fm/api/auth/?${new URLSearchParams({ api_key: apiKey, cb }).toString()}`;
      return json({ url });
    }

    if (action === 'session') {
      const token = str(body.token, 100);
      if (!token) return error(400, 'invalid_body', { message: 'token is required' });
      const r = await call({ method: 'auth.getSession', api_key: apiKey, token }, secret);
      if (!r.ok) {
        // 4 = invalid token, 14 = not authorized yet, 15 = token expired
        if (r.code === 4 || r.code === 14 || r.code === 15) return error(400, 'invalid_token', { message: r.message });
        return fail(r, user.id);
      }
      const session = r.data.session as { name?: string; key?: string } | undefined;
      if (!session?.key || !session.name) return error(502, 'lastfm_failed', { message: 'Last.fm returned no session', retryable: false });
      const { error: dbErr } = await admin.from('scrobble_accounts').upsert(
        { user_id: user.id, service: SERVICE, username: session.name.slice(0, 100), secret: session.key, updated_at: new Date().toISOString() },
        { onConflict: 'user_id,service' },
      );
      if (dbErr) return error(500, 'db_failed', { message: dbErr.message });
      return json({ username: session.name });
    }

    if (action === 'disconnect') {
      await admin.from('scrobble_accounts').delete().eq('user_id', user.id).eq('service', SERVICE);
      return json({ ok: true });
    }

    if (action !== 'now_playing' && action !== 'scrobble') return error(400, 'invalid_body', { message: 'Unknown action' });

    const { data: account, error: accErr } = await admin
      .from('scrobble_accounts')
      .select('secret')
      .eq('user_id', user.id)
      .eq('service', SERVICE)
      .maybeSingle();
    if (accErr) return error(500, 'db_failed', { message: accErr.message });
    const sk = (account as { secret?: string } | null)?.secret;
    if (!sk) return error(409, 'not_connected', { message: 'Last.fm is not connected' });

    if (action === 'now_playing') {
      const t = parseTrack(body.track);
      if (!t) return error(400, 'invalid_body', { message: 'track needs artist and track' });
      const params: Record<string, string> = { method: 'track.updateNowPlaying', api_key: apiKey, sk, artist: t.artist, track: t.track };
      if (t.album) params.album = t.album;
      if (t.duration) params.duration = String(t.duration);
      const r = await call(params, secret);
      return r.ok ? json({ ok: true }) : fail(r, user.id);
    }

    // scrobble: batch of up to 50 (Last.fm's limit), array notation artist[i], track[i], ...
    const raw = Array.isArray(body.tracks) ? body.tracks.slice(0, 50) : [];
    const tracks = raw.map(parseTrack).filter((t): t is Track => !!t && !!t.timestamp);
    if (!tracks.length) return error(400, 'invalid_body', { message: 'tracks need artist, track and timestamp' });
    const params: Record<string, string> = { method: 'track.scrobble', api_key: apiKey, sk };
    tracks.forEach((t, i) => {
      params[`artist[${i}]`] = t.artist;
      params[`track[${i}]`] = t.track;
      params[`timestamp[${i}]`] = String(t.timestamp);
      if (t.album) params[`album[${i}]`] = t.album;
      if (t.duration) params[`duration[${i}]`] = String(t.duration);
    });
    const r = await call(params, secret);
    if (!r.ok) return fail(r, user.id);
    const attr = (r.data.scrobbles as { '@attr'?: { accepted?: number | string; ignored?: number | string } } | undefined)?.['@attr'];
    return json({ accepted: Number(attr?.accepted ?? 0), ignored: Number(attr?.ignored ?? 0) });
  } catch (e) {
    return error(502, 'lastfm_failed', { message: errMessage(e), retryable: true });
  }
});
