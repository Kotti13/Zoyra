/**
 * Group voice / video calls (Agora RTC). Backend: supabase/migrations/20261117130000_group_calls.sql and the
 * `agora-token` edge function (POST { group_call_id }). A group call is a room: anyone in the group can start
 * it, and members join or rejoin at any time while it is live (up to 8 people).
 *
 * The room and its people come from realtime (`group_calls`, `group_call_participants`); this file also owns
 * the single live group-call session on this device (engine, mute / speaker / camera, remote video and
 * who is speaking). Leaving the call screen leaves the call. A 1:1 call in progress blocks joining (one
 * engine at a time).
 */
import { Camera } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import { loadAgora, type Agora } from './agora';
import { getCallSession } from './call-session';
import type { CallKind, CallToken } from './calls';
import { supabase } from './supabase';

/** People in one room (matches join_group_call). */
export const GROUP_CALL_MAX = 8;
const HEARTBEAT_MS = 30_000;
const SPEAKING_VOLUME = 25;
const KEEP_AWAKE_TAG = 'zoyra-group-call';

export type GroupCall = {
  id: string;
  conversation_id: string;
  started_by: string;
  kind: CallKind;
  status: 'live' | 'ended';
  channel: string;
  created_at: string;
  ended_at: string | null;
};

export type GroupCallParticipant = {
  call_id: string;
  user_id: string;
  agora_uid: number;
  joined_at: string;
  left_at: string | null;
  last_seen: string;
};

/* ================================================================== errors */

export type GroupCallErrorCode = 'not_signed_in' | 'not_member' | 'not_group' | 'bad_kind' | 'rate_limited' | 'not_found' | 'call_ended' | 'room_full' | 'busy_other_call' | 'not_configured' | 'unknown';

const FRIENDLY: Record<GroupCallErrorCode, string> = {
  not_signed_in: 'Sign in to make calls.',
  not_member: 'Only the person who started the call or a group admin can do that.',
  not_group: 'Group calls work in group chats only.',
  bad_kind: 'Unknown call type.',
  rate_limited: 'Too many calls. Wait a few minutes and try again.',
  not_found: 'This call is no longer available.',
  call_ended: 'This call has ended.',
  room_full: `This call is full (${GROUP_CALL_MAX} people).`,
  busy_other_call: 'Finish your current call first.',
  not_configured: 'Group calls need the latest server update.',
  unknown: 'Something went wrong with the call. Try again.',
};

export class GroupCallError extends Error {
  constructor(
    public readonly code: GroupCallErrorCode,
    message?: string,
  ) {
    super(message ?? FRIENDLY[code]);
    this.name = 'GroupCallError';
  }
}

type PgError = { message?: string; hint?: string };

export function toGroupCallError(e: unknown): GroupCallError {
  if (e instanceof GroupCallError) return e;
  const err = (e ?? {}) as PgError;
  const msg = typeof err.message === 'string' ? err.message : '';
  if (err.hint && err.hint in FRIENDLY) return new GroupCallError(err.hint as GroupCallErrorCode);
  if (/not signed in/i.test(msg)) return new GroupCallError('not_signed_in');
  if (/could not find the function|does not exist|schema cache/i.test(msg)) return new GroupCallError('not_configured');
  return new GroupCallError('unknown', msg || undefined);
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toGroupCallError(error);
  return data as T;
}

/* ================================================================== RPCs */

/** Starts a room for the group (or returns the live one) and joins me to it. */
export const startGroupCall = (cid: string, kind: CallKind) => rpc<GroupCall>('start_group_call', { cid, kind });
export const joinGroupCall = (id: string) => rpc<GroupCallParticipant>('join_group_call', { call_id: id });
export const leaveGroupCall = (id: string) => rpc<GroupCall>('leave_group_call', { call_id: id });
export const touchGroupCall = (id: string) => rpc<GroupCall>('touch_group_call', { call_id: id });
/** Starter or group admin: ends the room for everyone. */
export const endGroupCall = (id: string) => rpc<GroupCall>('end_group_call', { call_id: id });

export async function getGroupCall(id: string): Promise<GroupCall | null> {
  const { data, error } = await supabase.from('group_calls').select('*').eq('id', id).maybeSingle();
  if (error) throw toGroupCallError(error);
  return (data as GroupCall | null) ?? null;
}

async function loadActive(id: string): Promise<GroupCallParticipant[]> {
  const { data, error } = await supabase.from('group_call_participants').select('*').eq('call_id', id).is('left_at', null);
  if (error) return [];
  return (data ?? []) as GroupCallParticipant[];
}

/** People whose heartbeat is fresh (the server sweeps stale ones when anyone pings). */
const fresh = (p: GroupCallParticipant) => Date.now() - new Date(p.last_seen).getTime() < 120_000;

/* ================================================================== token */

type FnErrorBody = { error?: string; message?: string };

export async function fetchGroupCallToken(groupCallId: string): Promise<CallToken> {
  const { data, error } = await supabase.functions.invoke<CallToken>('agora-token', { body: { group_call_id: groupCallId } });
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
    if (code === 'calls_not_configured' || status === 503) throw new GroupCallError('not_configured', "Calls aren't set up on the server yet.");
    if (code === 'call_not_found' || code === 'not_participant') throw new GroupCallError('not_found');
    if (code === 'call_not_active') throw new GroupCallError('call_ended');
    if (status === 404) throw new GroupCallError('not_configured');
    if (status === 401) throw new GroupCallError('not_signed_in');
    throw new GroupCallError('unknown', body.message);
  }
  if (!data || typeof data.token !== 'string') throw new GroupCallError('unknown');
  return data;
}

/* ================================================================== hooks */

const suffix = () => Math.random().toString(36).slice(2);

/** The live room of a group (or null), realtime. Drives the "Join call" banner in the chat. */
export function useLiveGroupCall(cid: string | null | undefined): { call: GroupCall | null; people: number } {
  const [call, setCall] = useState<GroupCall | null>(null);
  const [people, setPeople] = useState(0);

  const load = useCallback(async () => {
    if (!cid) return;
    const { data, error } = await supabase.from('group_calls').select('*').eq('conversation_id', cid).eq('status', 'live').maybeSingle();
    if (error) return;
    const c = (data as GroupCall | null) ?? null;
    setCall(c);
    setPeople(c ? (await loadActive(c.id)).filter(fresh).length : 0);
  }, [cid]);

  useEffect(() => {
    if (!cid) return;
    void Promise.resolve().then(load);
    const ch = supabase
      .channel(`group-call-live:${cid}:${suffix()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_calls', filter: `conversation_id=eq.${cid}` }, (payload) => {
        const row = payload.new as Partial<GroupCall> | undefined;
        if (!row?.id) return void load();
        if (row.status === 'live') void load();
        else setCall((cur) => (cur?.id === row.id ? null : cur));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_call_participants' }, () => void load())
      .subscribe();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && void load());
    return () => {
      sub.remove();
      void supabase.removeChannel(ch);
    };
  }, [cid, load]);

  return { call: cid ? call : null, people: cid && call ? people : 0 };
}

/** One room + its current participants, realtime (call screen). */
export function useGroupCallRoom(callId: string | null | undefined): { call: GroupCall | null; people: GroupCallParticipant[]; loading: boolean; error: string | null } {
  const [call, setCall] = useState<GroupCall | null>(null);
  const [people, setPeople] = useState<GroupCallParticipant[]>([]);
  const [loading, setLoading] = useState(!!callId);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!callId) return;
    try {
      const c = await getGroupCall(callId);
      setCall(c);
      setError(c ? null : FRIENDLY.not_found);
      setPeople(await loadActive(callId));
    } catch (e) {
      setError(toGroupCallError(e).message);
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    if (!callId) return;
    void Promise.resolve().then(load);
    const ch = supabase
      .channel(`group-call:${callId}:${suffix()}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'group_calls', filter: `id=eq.${callId}` }, (payload) => {
        const row = payload.new as Partial<GroupCall> | undefined;
        if (row?.id === callId) setCall(row as GroupCall);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'group_call_participants', filter: `call_id=eq.${callId}` }, () => void load())
      .subscribe();
    return () => void supabase.removeChannel(ch);
  }, [callId, load]);

  return { call: callId ? call : null, people: people.filter(fresh), loading: callId ? loading : false, error: callId ? error : null };
}

/* ================================================================== session (Agora engine) */

type Engine = ReturnType<Agora['createAgoraRtcEngine']>;
type Handler = Parameters<Engine['registerEventHandler']>[0];

export type RemoteState = { video: boolean; speaking: boolean; muted: boolean };

export type GroupCallSession = {
  callId: string;
  conversationId: string;
  kind: CallKind;
  phase: 'idle' | 'preparing' | 'joining' | 'joined';
  error: string | null;
  /** react-native-agora isn't in this build (Expo Go, web, older development build). */
  unsupported: boolean;
  /** Set when the room ended or I was removed: the screen leaves. */
  over: boolean;
  video: boolean;
  frontCamera: boolean;
  muted: boolean;
  speaker: boolean;
  myUid: number;
  mySpeaking: boolean;
  /** Remote people by Agora uid. */
  remote: Record<number, RemoteState>;
  connectedAt: number | null;
  encrypted: boolean;
};

let session: GroupCallSession | null = null;
let engine: Engine | null = null;
let handler: Handler | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let keptAwake = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function patch(id: string, p: Partial<GroupCallSession>) {
  if (!session || session.callId !== id) return;
  session = { ...session, ...p };
  emit();
}
function patchRemote(id: string, uid: number, p: Partial<RemoteState>) {
  if (!session || session.callId !== id) return;
  const cur = session.remote[uid] ?? { video: false, speaking: false, muted: false };
  session = { ...session, remote: { ...session.remote, [uid]: { ...cur, ...p } } };
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => session;
export const getGroupCallSession = () => session;
export function useGroupCallSession(): GroupCallSession | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const groupCallsSupported = () => loadAgora() !== null;

async function permissions(video: boolean): Promise<{ mic: boolean; cam: boolean }> {
  const ask = async (get: () => Promise<{ granted: boolean; canAskAgain: boolean }>, req: () => Promise<{ granted: boolean }>) => {
    try {
      const cur = await get();
      if (cur.granted || !cur.canAskAgain) return cur.granted;
      return (await req()).granted;
    } catch {
      return false;
    }
  };
  const mic = await ask(Camera.getMicrophonePermissionsAsync, Camera.requestMicrophonePermissionsAsync);
  const cam = video ? await ask(Camera.getCameraPermissionsAsync, Camera.requestCameraPermissionsAsync) : false;
  if (Platform.OS === 'android' && Number(Platform.Version) >= 31) {
    await PermissionsAndroid.request('android.permission.BLUETOOTH_CONNECT').catch(() => undefined);
  }
  return { mic, cam };
}

function decodeBase64(b64: string): number[] {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    buf = (buf << 6) | abc.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return out;
}

function makeHandler(id: string): Handler {
  return {
    onJoinChannelSuccess: () => patch(id, { phase: 'joined', error: null, connectedAt: session?.connectedAt ?? Date.now() }),
    onUserJoined: (_c, uid) => patchRemote(id, uid, {}),
    onUserOffline: (_c, uid) => {
      if (!session || session.callId !== id) return;
      const next = { ...session.remote };
      delete next[uid];
      session = { ...session, remote: next };
      emit();
    },
    onRemoteVideoStateChanged: (_c, uid, state) => {
      // 0 stopped · 1 starting · 2 decoding · 3 frozen · 4 failed
      if (state === 2) patchRemote(id, uid, { video: true });
      else if (state === 0 || state === 4) patchRemote(id, uid, { video: false });
    },
    onUserMuteVideo: (_c, uid, muted) => patchRemote(id, uid, { video: !muted }),
    onUserMuteAudio: (_c, uid, muted) => patchRemote(id, uid, { muted }),
    onAudioVolumeIndication: (_c, speakers) => {
      if (!session || session.callId !== id) return;
      const next = { ...session.remote };
      let mine = false;
      let changed = false;
      const loud = new Set<number>();
      for (const s of speakers) {
        const on = (s.volume ?? 0) > SPEAKING_VOLUME;
        if (s.uid === 0 || s.uid === session.myUid) mine = on;
        else if (on) loud.add(s.uid ?? -1);
      }
      for (const uid of Object.keys(next).map(Number)) {
        const on = loud.has(uid);
        if (next[uid].speaking !== on) {
          next[uid] = { ...next[uid], speaking: on };
          changed = true;
        }
      }
      if (changed || mine !== session.mySpeaking) {
        session = { ...session, remote: next, mySpeaking: mine };
        emit();
      }
    },
    onConnectionStateChanged: (_c, state) => {
      if (state === 5) patch(id, { error: "Couldn't connect the call. Check your connection." });
    },
    onTokenPrivilegeWillExpire: () => {
      void fetchGroupCallToken(id)
        .then((t) => engine?.renewToken(t.token))
        .catch(() => undefined);
    },
  };
}

function stopLocal() {
  const e = engine;
  engine = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (e) {
    try {
      e.leaveChannel();
      e.stopPreview();
      if (handler) e.unregisterEventHandler(handler);
      e.release();
    } catch {
      // already released
    }
  }
  handler = null;
  if (keptAwake) {
    keptAwake = false;
    deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
  }
}

/**
 * Joins the room on this device: permissions → server join (assigns my Agora uid) → token → engine → channel.
 * Idempotent per call id. Errors land in `session.error` (the screen shows them).
 */
export async function joinGroupCallSession(call: GroupCall): Promise<void> {
  if (session?.callId === call.id) return;
  if (session) await leaveGroupCallSession();
  const agora = loadAgora();
  const video = call.kind === 'video';
  session = {
    callId: call.id,
    conversationId: call.conversation_id,
    kind: call.kind,
    phase: 'preparing',
    error: null,
    unsupported: !agora,
    over: false,
    video,
    frontCamera: true,
    muted: false,
    speaker: video,
    myUid: 0,
    mySpeaking: false,
    remote: {},
    connectedAt: null,
    encrypted: false,
  };
  emit();
  const id = call.id;
  if (!agora) return void patch(id, { phase: 'idle' });
  if (getCallSession()) return void patch(id, { phase: 'idle', error: FRIENDLY.busy_other_call });
  const failed = (msg: string) => {
    if (session?.callId !== id) return;
    stopLocal();
    patch(id, { phase: 'idle', error: msg });
  };
  try {
    const perm = await permissions(video);
    if (session?.callId !== id) return;
    if (!perm.mic) return failed('Allow microphone access in Settings to join calls.');
    const part = await joinGroupCall(id);
    if (session?.callId !== id) return;
    const t = await fetchGroupCallToken(id);
    if (session?.callId !== id) return;
    const e = agora.createAgoraRtcEngine();
    e.initialize({
      appId: t.app_id,
      channelProfile: agora.ChannelProfileType.ChannelProfileLiveBroadcasting,
      audioScenario: agora.AudioScenarioType.AudioScenarioChatroom,
    });
    const h = makeHandler(id);
    e.registerEventHandler(h);
    let encrypted = false;
    if (t.encryption?.key && t.encryption.salt) {
      const salt = decodeBase64(t.encryption.salt);
      const r = e.enableEncryption(true, { encryptionMode: agora.EncryptionMode.Aes128Gcm2, encryptionKey: t.encryption.key, encryptionKdfSalt: salt });
      if (r < 0 || salt.length !== 32) {
        e.unregisterEventHandler(h);
        e.release();
        throw new GroupCallError('unknown', "Couldn't secure the call. Try again.");
      }
      encrypted = true;
    }
    e.enableAudio();
    e.enableAudioVolumeIndication(300, 3, true);
    e.setDefaultAudioRouteToSpeakerphone(session.speaker);
    const cam = video && perm.cam;
    if (cam) {
      e.enableVideo();
      e.startPreview();
    }
    engine = e;
    handler = h;
    e.joinChannel(t.token, t.channel, t.uid || part.agora_uid, {
      channelProfile: agora.ChannelProfileType.ChannelProfileLiveBroadcasting,
      clientRoleType: agora.ClientRoleType.ClientRoleBroadcaster,
      publishMicrophoneTrack: true,
      publishCameraTrack: cam,
      autoSubscribeAudio: true,
      autoSubscribeVideo: true,
    });
    patch(id, { phase: 'joining', video: cam, myUid: t.uid || part.agora_uid, encrypted });
    heartbeat = setInterval(() => {
      void touchGroupCall(id)
        .then((g) => {
          if (g.status !== 'live') patch(id, { over: true });
        })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    if (!keptAwake) {
      keptAwake = true;
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    }
  } catch (err) {
    failed(toGroupCallError(err).message);
  }
}

/** Leaves the room (server + engine). Safe to call twice. */
export async function leaveGroupCallSession(): Promise<void> {
  const s = session;
  if (!s) return;
  stopLocal();
  session = null;
  emit();
  await leaveGroupCall(s.callId).catch(() => undefined);
}

/** The room ended (realtime said so): drop the engine; the screen shows the ended state. */
export function markGroupCallOver(id: string) {
  if (!session || session.callId !== id) return;
  stopLocal();
  patch(id, { over: true, phase: 'idle' });
}

export function toggleGroupMute(): void {
  const s = session;
  if (!s || !engine) return;
  const muted = !s.muted;
  engine.muteLocalAudioStream(muted);
  patch(s.callId, { muted });
}

export function toggleGroupSpeaker(): void {
  const s = session;
  if (!s || !engine) return;
  const speaker = !s.speaker;
  engine.setEnableSpeakerphone(speaker);
  patch(s.callId, { speaker });
}

/** Turns my camera on / off (asks for permission the first time). */
export async function toggleGroupCamera(): Promise<void> {
  const s = session;
  const agora = loadAgora();
  if (!s || !engine || !agora) return;
  if (s.video) {
    engine.muteLocalVideoStream(true);
    engine.stopPreview();
    engine.updateChannelMediaOptions({ publishCameraTrack: false });
    return void patch(s.callId, { video: false });
  }
  const perm = await permissions(true);
  if (!perm.cam) return void patch(s.callId, { error: 'Allow camera access in Settings to turn your video on.' });
  if (session?.callId !== s.callId || !engine) return;
  engine.enableVideo();
  engine.muteLocalVideoStream(false);
  engine.startPreview();
  engine.updateChannelMediaOptions({ publishCameraTrack: true });
  patch(s.callId, { video: true, error: null });
}

export function flipGroupCamera(): void {
  const s = session;
  if (!s || !engine || !s.video) return;
  engine.switchCamera();
  patch(s.callId, { frontCamera: !s.frontCamera });
}
