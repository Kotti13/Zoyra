/**
 * 1:1 voice / video calls (Agora RTC). Thin wrappers over the RPCs in
 * supabase/migrations/20261115170000_calls.sql and the `agora-token` edge function
 * (supabase/functions/agora-token) — keep names and shapes in sync.
 *
 * Flow: caller startCall(cid, kind) → row 'ringing' + push to the callee ('call' notification,
 * url '/call?id=<id>'). Callee sees it via useIncomingCall() / the push, then answerCall(id, true|false).
 * Both sides fetchCallToken(id) and join Agora channel `channel` with `uid` (1 = caller, 2 = callee).
 * Either side endCall(id). Unanswered calls become 'missed' after 60 s (server cron).
 */
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

/** Feature flag for the call buttons / screens. */
export const CALLS_ENABLED = true;

/** Server-side ring timeout (seconds) before a call becomes 'missed'. */
export const CALL_RING_TIMEOUT_S = 60;

/** Agora uid of each side (fixed per call). */
export const CALLER_UID = 1;
export const CALLEE_UID = 2;

export type CallKind = 'audio' | 'video';
export type CallStatus = 'ringing' | 'accepted' | 'declined' | 'missed' | 'ended' | 'busy' | 'cancelled';

export type Call = {
  id: string;
  conversation_id: string;
  caller_id: string;
  callee_id: string;
  kind: CallKind;
  status: CallStatus;
  /** Agora channel name. */
  channel: string;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
};

export type CallToken = {
  app_id: string;
  channel: string;
  token: string;
  /** 1 = caller, 2 = callee. */
  uid: number;
  /** Unix seconds; the token and its privileges last 1 hour. */
  expires_at: number;
  /**
   * Per-call media encryption secret (AES-128-GCM2), the same for both sides; null / missing when the
   * server doesn't issue one yet. Issued by the server, so it's "Encrypted", not end-to-end encrypted.
   */
  encryption?: { mode: 'aes_128_gcm2'; key: string; salt: string } | null;
};

/** `meta` of a `kind: 'call'` chat message (posted by the server when a call finishes). */
export type CallMessageMeta = {
  call_id: string;
  kind: CallKind;
  status: CallStatus;
  /** Seconds between answer and hang-up; null when never answered. */
  duration_s: number | null;
};

export const isLiveCall = (c: Pick<Call, 'status'> | null | undefined): boolean =>
  c?.status === 'ringing' || c?.status === 'accepted';

/* ================================================================== errors */

export type CallErrorCode =
  | 'not_signed_in'
  | 'not_member'
  | 'not_direct'
  | 'blocked'
  | 'request'
  | 'bad_kind'
  | 'rate_limited'
  | 'not_found'
  | 'not_participant'
  | 'call_not_active'
  | 'call_not_accepted'
  | 'not_configured'
  | 'unknown';

/** Error thrown by every function here; `message` is ready to show to the user. */
export class CallError extends Error {
  constructor(
    public readonly code: CallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CallError';
  }
}

const FRIENDLY: Record<CallErrorCode, string> = {
  not_signed_in: 'Sign in to make calls.',
  not_member: "You're not part of this chat.",
  not_direct: 'Calls work in 1:1 chats only.',
  blocked: "You can't call this person.",
  request: 'You can call once they accept your chat request.',
  bad_kind: 'Unknown call type.',
  rate_limited: 'Too many calls. Wait a few minutes and try again.',
  not_found: 'This call is no longer available.',
  not_participant: 'This call is no longer available.',
  call_not_active: 'This call has ended.',
  call_not_accepted: 'Answer the call to join.',
  not_configured: "Calls aren't set up on the server yet.",
  unknown: 'Something went wrong with the call. Try again.',
};

const HINTS = new Set<string>(['not_signed_in', 'not_member', 'not_direct', 'blocked', 'request', 'bad_kind', 'rate_limited', 'not_found']);

type PgError = { message?: string; code?: string; hint?: string };

/** Maps an RPC error (hints raised in 20261115170000_calls.sql) to a CallError. */
export function toCallError(e: unknown): CallError {
  if (e instanceof CallError) return e;
  const err = (e ?? {}) as PgError;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (err.hint && HINTS.has(err.hint)) return new CallError(err.hint as CallErrorCode, FRIENDLY[err.hint as CallErrorCode]);
  if (/not signed in/i.test(msg)) return new CallError('not_signed_in', FRIENDLY.not_signed_in);
  if (/could not find the function|does not exist/i.test(msg)) return new CallError('not_configured', 'Calls need the latest server update.');
  return new CallError('unknown', msg || FRIENDLY.unknown);
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toCallError(error);
  return data as T;
}

/* ================================================================== RPCs */

/**
 * Rings the other member of a 1:1 chat. Resolves with status 'ringing', or 'busy' when they're
 * already ringing / in a call (they get a missed-call notification). Throws CallError.
 */
export function startCall(cid: string, kind: CallKind): Promise<Call> {
  return rpc<Call>('start_call', { cid, kind });
}

/**
 * Callee only. Resolves with 'accepted' / 'declined', or 'missed' when it rang for more than 60 s.
 * If the call already left 'ringing' (caller hung up), the current row comes back unchanged — check `status`.
 */
export function answerCall(id: string, accept: boolean): Promise<Call> {
  return rpc<Call>('answer_call', { call_id: id, accept });
}

/**
 * Either side hangs up: ringing → 'cancelled' (caller) / 'declined' (callee), accepted → 'ended'.
 * Safe to call twice (a finished call comes back unchanged).
 */
export function endCall(id: string): Promise<Call> {
  return rpc<Call>('end_call', { call_id: id });
}

/** The call, if I'm the caller or callee (RLS); null otherwise. */
export async function getCall(id: string): Promise<Call | null> {
  const { data, error } = await supabase.from('calls').select('*').eq('id', id).maybeSingle();
  if (error) throw toCallError(error);
  return (data as Call | null) ?? null;
}

/* ================================================================== Agora token */

type FnErrorBody = { error?: string; message?: string };

/** Agora RTC token for a ringing/accepted call I'm part of. Throws CallError ('not_configured' when secrets are missing). */
export async function fetchCallToken(callId: string): Promise<CallToken> {
  const { data, error } = await supabase.functions.invoke<CallToken>('agora-token', { body: { call_id: callId } });
  if (error) {
    let status = 0;
    let body: FnErrorBody = {};
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      status = error.context.status;
      try {
        const parsed: unknown = await error.context.clone().json();
        if (parsed && typeof parsed === 'object') body = parsed as FnErrorBody;
      } catch {
        // not JSON
      }
    }
    const code = body.error ?? '';
    if (code === 'calls_not_configured' || code === 'not_configured' || status === 503) {
      throw new CallError('not_configured', FRIENDLY.not_configured);
    }
    if (code === 'call_not_found') throw new CallError('not_found', FRIENDLY.not_found);
    if (code === 'not_participant') throw new CallError('not_participant', FRIENDLY.not_participant);
    if (code === 'call_not_active') throw new CallError('call_not_active', FRIENDLY.call_not_active);
    // The callee only gets a token after answering (agora-token); call-session retries on 'accepted'.
    if (code === 'call_not_accepted') throw new CallError('call_not_accepted', FRIENDLY.call_not_accepted);
    if (code === 'blocked') throw new CallError('blocked', FRIENDLY.blocked);
    if (status === 404) throw new CallError('not_configured', 'Calls need the latest server update.');
    if (status === 401) throw new CallError('not_signed_in', FRIENDLY.not_signed_in);
    throw new CallError('unknown', body.message ?? FRIENDLY.unknown);
  }
  if (!data || typeof data.token !== 'string') throw new CallError('unknown', FRIENDLY.unknown);
  return data;
}

/* ================================================================== hooks */

const channelSuffix = () => Math.random().toString(36).slice(2);

/**
 * The call currently ringing me (newest), or null. Initial fetch of ringing calls younger than 60 s,
 * then realtime on `calls` filtered by callee_id; refetches when the app returns to the foreground.
 * Clears itself when the call leaves 'ringing' or the ring timeout passes.
 */
export function useIncomingCall(userId: string | null | undefined): Call | null {
  const [call, setCall] = useState<Call | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((c: Call | null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setCall(c);
    if (!c) return;
    // Server time vs device clock may differ: ring at least 5 s, at most the full timeout from now.
    const left = new Date(c.created_at).getTime() + CALL_RING_TIMEOUT_S * 1000 - Date.now();
    const ms = Math.min(CALL_RING_TIMEOUT_S * 1000, Math.max(5000, Number.isFinite(left) ? left : 0));
    timer.current = setTimeout(() => setCall((cur) => (cur?.id === c.id ? null : cur)), ms);
  }, []);

  const load = useCallback(async () => {
    if (!userId) return show(null);
    const since = new Date(Date.now() - CALL_RING_TIMEOUT_S * 1000).toISOString();
    const { data, error } = await supabase
      .from('calls')
      .select('*')
      .eq('callee_id', userId)
      .eq('status', 'ringing')
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error) show((data as Call | null) ?? null);
  }, [userId, show]);

  useEffect(() => {
    void Promise.resolve().then(load);
    if (!userId) return;
    const ch = supabase
      .channel(`calls-incoming:${userId}:${channelSuffix()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls', filter: `callee_id=eq.${userId}` }, (payload) => {
        const row = payload.new as Partial<Call> | undefined;
        if (!row?.id) return;
        if (row.status === 'ringing') show(row as Call);
        else setCall((cur) => (cur?.id === row.id ? null : cur));
      })
      .subscribe();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void load();
    });
    return () => {
      sub.remove();
      void supabase.removeChannel(ch);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [userId, load, show]);

  return call;
}

/** Live view of one call (for the call screen: wait for 'accepted', leave on a final status). */
export function useCall(callId: string | null | undefined): { call: Call | null; loading: boolean; reload: () => Promise<void> } {
  const [call, setCall] = useState<Call | null>(null);
  const [loading, setLoading] = useState(!!callId);

  const reload = useCallback(async () => {
    if (!callId) {
      setCall(null);
      setLoading(false);
      return;
    }
    try {
      setCall(await getCall(callId));
    } catch {
      // keep the last known state
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    void Promise.resolve().then(reload);
    if (!callId) return;
    const ch = supabase
      .channel(`call:${callId}:${channelSuffix()}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => {
        const row = payload.new as Partial<Call> | undefined;
        if (row?.id === callId) setCall(row as Call);
      })
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, [callId, reload]);

  return { call, loading, reload };
}

/* ================================================================== listening together (call_tracks) */

/** A song shared during a call (supabase/migrations/20261115210000_calls_extras.sql). */
export type CallTrack = { id: string; call_id: string; track: CatalogTrack; shared_by: string; created_at: string };

const isTrack = (t: unknown): t is CatalogTrack => !!t && typeof t === 'object' && typeof (t as CatalogTrack).id === 'string' && typeof (t as CatalogTrack).title === 'string';

/** Songs shared in this call, oldest first ([] when the table isn't deployed yet). */
export async function loadCallTracks(callId: string): Promise<CallTrack[]> {
  const { data, error } = await supabase.from('call_tracks').select('id, call_id, track, shared_by, created_at').eq('call_id', callId).order('created_at', { ascending: true }).limit(200);
  if (error) return [];
  return ((data ?? []) as CallTrack[]).filter((r) => isTrack(r.track));
}

/** Records a shared song for both participants (while the call rings / is live). Throws CallError. */
export async function addCallTrack(callId: string, me: string, track: CatalogTrack): Promise<CallTrack> {
  // Only the fields the call UI needs (keeps the row small; local files never leave the device).
  const slim: CatalogTrack = {
    id: track.id,
    title: track.title,
    artist: { id: track.artist.id, name: track.artist.name, handle: track.artist.handle, verified: track.artist.verified, image: track.artist.image },
    duration: track.duration,
    artwork: track.artwork,
    plays: track.plays,
    likes: track.likes,
    ...(track.streamUrl ? { streamUrl: track.streamUrl } : {}),
    ...(track.genre ? { genre: track.genre } : {}),
    ...(track.url ? { url: track.url } : {}),
    ...(track.explicit ? { explicit: true } : {}),
  };
  const { data, error } = await supabase.from('call_tracks').insert({ call_id: callId, track: slim, shared_by: me }).select('id, call_id, track, shared_by, created_at').single();
  if (error) {
    if (/relation .* does not exist|could not find the table/i.test(error.message)) throw new CallError('not_configured', 'Listening together needs the latest server update.');
    if (error.code === '42501') throw new CallError('call_not_active', 'You can share songs while the call is on.');
    throw toCallError(error);
  }
  return data as CallTrack;
}

/** Distinct songs from a call's shares, in first-shared order. */
export function uniqueCallTracks(rows: CallTrack[]): CatalogTrack[] {
  const seen = new Set<string>();
  const out: CatalogTrack[] = [];
  for (const r of rows) {
    if (seen.has(r.track.id)) continue;
    seen.add(r.track.id);
    out.push(r.track);
  }
  return out;
}

/* ================================================================== call quality */

/** My stars for a call (0 when not rated). */
export async function loadCallRating(callId: string, me: string): Promise<number> {
  const { data, error } = await supabase.from('call_ratings').select('stars').eq('call_id', callId).eq('user_id', me).maybeSingle();
  if (error || !data) return 0;
  return Number((data as { stars: number }).stars) || 0;
}

/** Saves (or changes) my rating of an answered call. Throws CallError. */
export async function rateCall(callId: string, me: string, stars: number): Promise<void> {
  const n = Math.max(1, Math.min(5, Math.round(stars)));
  const { error } = await supabase.from('call_ratings').upsert({ call_id: callId, user_id: me, stars: n, updated_at: new Date().toISOString() }, { onConflict: 'call_id,user_id' });
  if (error) {
    if (/relation .* does not exist|could not find the table/i.test(error.message)) throw new CallError('not_configured', 'Ratings need the latest server update.');
    throw toCallError(error);
  }
}
