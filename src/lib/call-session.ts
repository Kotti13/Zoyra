/**
 * The one live call on this device: owns the Agora engine, joins / leaves the channel and exposes the
 * call's media state (mute, speaker, cameras, remote video / speaking) to the UI.
 *
 * It lives at module level (not in the call screen) so a call keeps going while the user minimizes the
 * call screen to the chat; `CallHost` (src/lib/call-ui.tsx) keeps it in sync with the `calls` row and
 * shows a "Return to call" pill. Backend contract: src/lib/calls.ts.
 *
 * Lifecycle: openCallSession(call) → prepare (permissions, token, engine, preview) → syncCall(row)
 * joins once the row is 'accepted' and tears down on any final status. hangUp() = leave + endCall.
 */
import { Camera } from 'expo-camera';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useSyncExternalStore } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import type * as AgoraTypes from 'react-native-agora';

import { loadAgora, type Agora } from './agora';
import { CALLEE_UID, CALLER_UID, CallError, endCall, fetchCallToken, isLiveCall, type Call, type CallKind, type CallToken } from './calls';

type Engine = ReturnType<Agora['createAgoraRtcEngine']>;
type Handler = Parameters<Engine['registerEventHandler']>[0];

export type CallPhase = 'idle' | 'preparing' | 'ready' | 'joining' | 'joined';

export type CallSession = {
  callId: string;
  kind: CallKind;
  conversationId: string;
  /** The other participant's user id. */
  peerId: string;
  /** Agora uid of the other side (fixed per call). */
  remoteUid: number;
  phase: CallPhase;
  /** User-facing error (permissions, token, connection). */
  error: string | null;
  /** react-native-agora isn't in this build (Expo Go, web, or an older development build). */
  unsupported: boolean;
  /** My camera is on (previewing / publishing). */
  video: boolean;
  frontCamera: boolean;
  muted: boolean;
  speaker: boolean;
  remoteJoined: boolean;
  remoteVideo: boolean;
  remoteSpeaking: boolean;
  /** Device time when the other person joined the channel (drives the in-call timer). */
  connectedAt: number | null;
  /** The call screen was minimized; the call continues in the background of the app. */
  minimized: boolean;
  /** Agora built-in media encryption (AES-128-GCM2, per-call key issued by the server) is on. */
  encrypted: boolean;
  /** Voice effect applied to my microphone (Effects sheet). */
  voiceEffect: VoiceEffect;
  /** Video beauty filter (smoothing / lightening) on my camera. */
  beauty: boolean;
  /** Background blur on my camera (Agora virtual background). */
  blur: boolean;
};

/** Voice effects offered in the Effects sheet: Agora voice beautifier + room acoustics presets. */
export type VoiceEffect = 'off' | 'clear' | 'deep' | 'mellow' | 'studio' | 'concert' | 'ktv' | 'ethereal';

export const VOICE_EFFECTS: { key: VoiceEffect; label: string; hint: string }[] = [
  { key: 'off', label: 'Off', hint: 'Your natural voice' },
  { key: 'clear', label: 'Clear', hint: 'Crisper, brighter voice' },
  { key: 'deep', label: 'Deep', hint: 'Lower, fuller voice' },
  { key: 'mellow', label: 'Mellow', hint: 'Warm and soft' },
  { key: 'studio', label: 'Studio', hint: 'Recording-booth sound' },
  { key: 'concert', label: 'Concert hall', hint: 'Big-room reverb' },
  { key: 'ktv', label: 'Karaoke', hint: 'KTV reverb for singing along' },
  { key: 'ethereal', label: 'Ethereal', hint: 'Dreamy, spacious echo' },
];

/** How a finished call ended on this device (for the ended screen). */
export type CallEnding = { byMe: boolean; connectedMs: number | null };

const KEEP_AWAKE_TAG = 'zoyra-call';
const SPEAKING_VOLUME = 25;

let session: CallSession | null = null;
let engine: Engine | null = null;
let handler: Handler | null = null;
let token: CallToken | null = null;
let wantJoin = false;
/** Retries of prepare() after agora-token said 'call_not_accepted' while Accept was pending. */
let notAcceptedRetries = 0;
let keptAwake = false;
const endings = new Map<string, CallEnding>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());
function patch(id: string, p: Partial<CallSession>) {
  if (!session || session.callId !== id) return;
  session = { ...session, ...p };
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => session;

export const getCallSession = () => session;
export const getCallEnding = (callId: string): CallEnding | null => endings.get(callId) ?? null;

/** The current call session (null when no call is active on this device). */
export function useCallSession(): CallSession | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether this build can place calls at all (false in Expo Go / web). */
export const callsSupported = () => loadAgora() !== null;

/* ================================================================== permissions */

async function permissions(video: boolean, prompt: boolean): Promise<{ mic: boolean; cam: boolean }> {
  const ask = async (get: () => Promise<{ granted: boolean; canAskAgain: boolean }>, req: () => Promise<{ granted: boolean }>) => {
    try {
      const cur = await get();
      if (cur.granted || !prompt || !cur.canAskAgain) return cur.granted;
      return (await req()).granted;
    } catch {
      return false;
    }
  };
  const mic = await ask(Camera.getMicrophonePermissionsAsync, Camera.requestMicrophonePermissionsAsync);
  const cam = video ? await ask(Camera.getCameraPermissionsAsync, Camera.requestCameraPermissionsAsync) : false;
  // Bluetooth headsets on Android 12+ (optional: the call works without it).
  if (prompt && Platform.OS === 'android' && Number(Platform.Version) >= 31) {
    await PermissionsAndroid.request('android.permission.BLUETOOTH_CONNECT').catch(() => undefined);
  }
  return { mic, cam };
}

/* ================================================================== engine */

function makeHandler(id: string, remoteUid: number): Handler {
  return {
    onJoinChannelSuccess: () => patch(id, { phase: 'joined', error: null }),
    onUserJoined: (_c, uid) => {
      if (uid !== remoteUid || !session) return;
      patch(id, { remoteJoined: true, connectedAt: session.connectedAt ?? Date.now() });
    },
    onUserOffline: (_c, uid) => {
      if (uid !== remoteUid) return;
      patch(id, { remoteJoined: false, remoteVideo: false, remoteSpeaking: false });
      // The other person left the channel (hung up, or their app was closed): end the call for both.
      // Deferred: Agora must not be released from inside its own callbacks.
      setTimeout(() => void hangUp(id, false), 0);
    },
    onRemoteVideoStateChanged: (_c, uid, state) => {
      if (uid !== remoteUid) return;
      // 0 stopped · 1 starting · 2 decoding · 3 frozen · 4 failed
      if (state === 2) patch(id, { remoteVideo: true });
      else if (state === 0 || state === 4) patch(id, { remoteVideo: false });
    },
    onUserMuteVideo: (_c, uid, muted) => {
      if (uid === remoteUid) patch(id, { remoteVideo: !muted });
    },
    onAudioVolumeIndication: (_c, speakers) => {
      const remote = speakers.find((s) => s.uid === remoteUid);
      if (!remote || !session) return;
      const speaking = (remote.volume ?? 0) > SPEAKING_VOLUME;
      if (speaking !== session.remoteSpeaking) patch(id, { remoteSpeaking: speaking });
    },
    onConnectionStateChanged: (_c, state) => {
      // 5 = failed (e.g. token rejected, network gone for too long).
      if (state === 5) patch(id, { error: "Couldn't connect the call. Check your connection." });
    },
    onTokenPrivilegeWillExpire: () => {
      void fetchCallToken(id)
        .then((t) => {
          token = t;
          engine?.renewToken(t.token);
        })
        .catch(() => undefined);
    },
  };
}

/* ================================================================== effects + encryption */

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

/** Applies a voice effect to the engine; returns false when the SDK rejected it. */
function applyVoiceEffect(e: Engine, agora: Agora, effect: VoiceEffect): boolean {
  const B = agora.VoiceBeautifierPreset;
  const A = agora.AudioEffectPreset;
  const beautifier: Partial<Record<VoiceEffect, AgoraTypes.VoiceBeautifierPreset>> = { clear: B.TimbreTransformationClear, deep: B.TimbreTransformationDeep, mellow: B.TimbreTransformationMellow };
  const room: Partial<Record<VoiceEffect, AgoraTypes.AudioEffectPreset>> = { studio: A.RoomAcousticsStudio, concert: A.RoomAcousticsVocalConcert, ktv: A.RoomAcousticsKtv, ethereal: A.RoomAcousticsEthereal };
  try {
    // The two preset families override each other: reset the one not in use.
    const r1 = e.setVoiceBeautifierPreset(beautifier[effect] ?? B.VoiceBeautifierOff);
    const r2 = e.setAudioEffectPreset(room[effect] ?? A.AudioEffectOff);
    return r1 >= 0 && r2 >= 0;
  } catch {
    return false;
  }
}

function applyBeauty(e: Engine, agora: Agora, on: boolean): boolean {
  try {
    // Android loads the beauty / virtual background filters as an extension (harmless elsewhere).
    if (on) e.enableExtension('agora_video_filters_clear_vision', 'clear_vision', true);
    const r = e.setBeautyEffectOptions(on, {
      lighteningContrastLevel: agora.LighteningContrastLevel.LighteningContrastNormal,
      lighteningLevel: 0.6,
      smoothnessLevel: 0.6,
      rednessLevel: 0.1,
      sharpnessLevel: 0.3,
    });
    return r >= 0;
  } catch {
    return false;
  }
}

function applyBlur(e: Engine, agora: Agora, on: boolean): boolean {
  try {
    if (on) {
      e.enableExtension('agora_video_filters_clear_vision', 'clear_vision', true);
      if (!e.isFeatureAvailableOnDevice(agora.FeatureType.VideoVirtualBackground)) return false;
    }
    const r = e.enableVirtualBackground(
      on,
      { background_source_type: agora.BackgroundSourceType.BackgroundBlur, blur_degree: agora.BackgroundBlurDegree.BlurDegreeHigh },
      { modelType: agora.SegModelType.SegModelAi },
    );
    return r >= 0;
  } catch {
    return false;
  }
}

async function prepare(id: string, prompt: boolean): Promise<void> {
  const agora = loadAgora();
  const s = session;
  if (!agora || !s || s.callId !== id || s.phase !== 'idle') return;
  patch(id, { phase: 'preparing', error: null });
  const perm = await permissions(s.video, prompt);
  if (session?.callId !== id) return;
  if (!perm.mic) {
    patch(id, { phase: 'idle', error: prompt ? 'Allow microphone access in Settings to make calls.' : null });
    // Accept was tapped while this silent attempt ran: retry, asking for permission this time.
    if (!prompt && wantJoin) void prepare(id, true);
    else wantJoin = false;
    return;
  }
  try {
    const t = await fetchCallToken(id);
    if (session?.callId !== id) return;
    token = t;
    const e = agora.createAgoraRtcEngine();
    e.initialize({
      appId: t.app_id,
      channelProfile: agora.ChannelProfileType.ChannelProfileLiveBroadcasting,
      audioScenario: agora.AudioScenarioType.AudioScenarioChatroom,
    });
    const h = makeHandler(id, session.remoteUid);
    e.registerEventHandler(h);
    // Media encryption with the per-call key from agora-token (both sides get the same key + salt).
    let encrypted = false;
    if (t.encryption?.key && t.encryption.salt) {
      const salt = decodeBase64(t.encryption.salt);
      const r = e.enableEncryption(true, {
        encryptionMode: agora.EncryptionMode.Aes128Gcm2,
        encryptionKey: t.encryption.key,
        encryptionKdfSalt: salt,
      });
      if (r < 0 || salt.length !== 32) {
        // Joining unencrypted would leave the other side unable to decode us: stop here instead.
        e.unregisterEventHandler(h);
        e.release();
        throw new CallError('unknown', "Couldn't secure the call. Try again.");
      }
      encrypted = true;
    }
    e.enableAudio();
    e.enableAudioVolumeIndication(300, 3, true);
    e.setDefaultAudioRouteToSpeakerphone(session.speaker);
    const video = session.video && perm.cam;
    if (video) {
      e.enableVideo();
      e.startPreview();
    }
    engine = e;
    handler = h;
    if (session.voiceEffect !== 'off') applyVoiceEffect(e, agora, session.voiceEffect);
    patch(id, { phase: 'ready', video, encrypted });
    if (wantJoin) join(id);
  } catch (e) {
    // Callee before answering: no token yet (agora-token issues it once the call is 'accepted').
    // Stay idle without an error; syncCall('accepted') → join() → prepare() fetches it then.
    if (e instanceof CallError && e.code === 'call_not_accepted') {
      if (session?.callId === id) patch(id, { phase: 'idle', error: null });
      // Accept was tapped while this fetch was in flight: try again shortly (answer_call has committed by then).
      if (wantJoin && notAcceptedRetries < 3) {
        notAcceptedRetries += 1;
        setTimeout(() => {
          if (session?.callId === id && session.phase === 'idle') void prepare(id, true);
        }, 800);
      }
      return;
    }
    wantJoin = false;
    const msg = e instanceof CallError ? (e.code === 'not_configured' ? "Calls aren't set up yet." : e.message) : "Couldn't start the call. Try again.";
    patch(id, { phase: 'idle', error: msg });
  }
}

function join(id: string) {
  const agora = loadAgora();
  const s = session;
  if (!agora || !s || s.callId !== id) return;
  if (s.phase === 'idle') {
    wantJoin = true;
    void prepare(id, true);
    return;
  }
  if (s.phase !== 'ready' || !engine || !token) {
    wantJoin = true;
    return;
  }
  wantJoin = false;
  engine.joinChannel(token.token, token.channel, token.uid, {
    channelProfile: agora.ChannelProfileType.ChannelProfileLiveBroadcasting,
    clientRoleType: agora.ClientRoleType.ClientRoleBroadcaster,
    publishMicrophoneTrack: true,
    publishCameraTrack: s.video,
    autoSubscribeAudio: true,
    autoSubscribeVideo: true,
  });
  patch(id, { phase: 'joining' });
  if (!keptAwake) {
    keptAwake = true;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
  }
}

function teardown(byMe: boolean) {
  const s = session;
  if (s) endings.set(s.callId, { byMe, connectedMs: s.connectedAt ? Date.now() - s.connectedAt : null });
  const e = engine;
  engine = null;
  token = null;
  wantJoin = false;
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
  session = null;
  emit();
}

/* ================================================================== public API */

/**
 * Starts tracking `call` on this device (idempotent per call id). `prompt` asks for mic / camera
 * permission now (the caller, or the callee after Accept); without it the engine is only prepared when
 * permission was already granted (so an incoming video call can show my preview).
 */
export function openCallSession(call: Call, me: string, opts: { prompt: boolean }): void {
  if (session?.callId === call.id) {
    if (opts.prompt && session.phase === 'idle') void prepare(call.id, true);
    return;
  }
  if (!isLiveCall(call)) return;
  if (session) teardown(true);
  notAcceptedRetries = 0;
  const agora = loadAgora();
  const iAmCaller = call.caller_id === me;
  session = {
    callId: call.id,
    kind: call.kind,
    conversationId: call.conversation_id,
    peerId: iAmCaller ? call.callee_id : call.caller_id,
    remoteUid: iAmCaller ? CALLEE_UID : CALLER_UID,
    phase: 'idle',
    error: null,
    unsupported: !agora,
    video: call.kind === 'video',
    frontCamera: true,
    muted: false,
    speaker: call.kind === 'video',
    remoteJoined: false,
    remoteVideo: false,
    remoteSpeaking: false,
    connectedAt: null,
    minimized: false,
    encrypted: false,
    voiceEffect: 'off',
    beauty: false,
    blur: false,
  };
  emit();
  if (agora) void prepare(call.id, opts.prompt);
}

/** Feed every fresh `calls` row here: joins on 'accepted', leaves on a final status. */
export function syncCall(call: Call | null): void {
  if (!call || !session || session.callId !== call.id) return;
  if (call.status === 'accepted') {
    if (session.phase !== 'joining' && session.phase !== 'joined') join(call.id);
  } else if (!isLiveCall(call)) {
    teardown(false);
  }
}

/** Hang up: leave the channel and end the call on the server (safe to call twice). */
export async function hangUp(callId: string, byMe = true): Promise<void> {
  if (session?.callId === callId) teardown(byMe);
  else if (byMe) endings.set(callId, { byMe: true, connectedMs: endings.get(callId)?.connectedMs ?? null });
  try {
    await endCall(callId);
  } catch {
    // the server times calls out on its own
  }
}

/** Drops the local session without touching the server (e.g. after declining). */
export function closeCallSession(callId: string, byMe = true): void {
  if (session?.callId === callId) teardown(byMe);
  else endings.set(callId, { byMe, connectedMs: null });
}

export function setMinimized(callId: string, minimized: boolean): void {
  patch(callId, { minimized });
}

export function toggleMute(): void {
  if (!session) return;
  const muted = !session.muted;
  engine?.muteLocalAudioStream(muted);
  patch(session.callId, { muted });
}

export function toggleSpeaker(): void {
  if (!session) return;
  const speaker = !session.speaker;
  if (session.phase === 'joined') engine?.setEnableSpeakerphone(speaker);
  else engine?.setDefaultAudioRouteToSpeakerphone(speaker);
  patch(session.callId, { speaker });
}

/** Camera on / off (also upgrades a voice call to video, or switches a video call to voice). */
export async function setCamera(on: boolean): Promise<void> {
  const s = session;
  if (!s) return;
  const e = engine;
  if (on) {
    const perm = await permissions(true, true);
    if (!perm.cam) {
      patch(s.callId, { error: 'Allow camera access in Settings to turn on video.' });
      return;
    }
    if (e) {
      e.enableVideo();
      e.enableLocalVideo(true);
      e.startPreview();
      e.muteLocalVideoStream(false);
      if (s.phase === 'joining' || s.phase === 'joined') e.updateChannelMediaOptions({ publishCameraTrack: true });
    }
    // Video calls default to the loudspeaker, like FaceTime / WhatsApp.
    if (!s.speaker) toggleSpeaker();
    patch(s.callId, { video: true, error: null });
  } else {
    if (e) {
      e.muteLocalVideoStream(true);
      e.enableLocalVideo(false);
      e.stopPreview();
      if (s.phase === 'joining' || s.phase === 'joined') e.updateChannelMediaOptions({ publishCameraTrack: false });
    }
    patch(s.callId, { video: false });
  }
}

export function flipCamera(): void {
  if (!session || !session.video) return;
  engine?.switchCamera();
  patch(session.callId, { frontCamera: !session.frontCamera });
}

/** Clears a shown error (e.g. after the user read it). */
export function clearCallError(): void {
  if (session) patch(session.callId, { error: null });
}

/* ================================================================== effects (Effects sheet) */

/** Sets my voice effect. Returns an error message, or null when applied. */
export function setVoiceEffect(effect: VoiceEffect): string | null {
  const s = session;
  const agora = loadAgora();
  if (!s) return null;
  if (engine && agora && !applyVoiceEffect(engine, agora, effect)) return "That effect isn't available on this device.";
  patch(s.callId, { voiceEffect: effect });
  return null;
}

/** Beauty filter on my camera. Returns an error message, or null when applied. */
export function setBeauty(on: boolean): string | null {
  const s = session;
  const agora = loadAgora();
  if (!s || !engine || !agora) return null;
  if (!applyBeauty(engine, agora, on)) return "Beauty filter isn't available on this device.";
  patch(s.callId, { beauty: on });
  return null;
}

/** Background blur on my camera. Returns an error message, or null when applied. */
export function setBackgroundBlur(on: boolean): string | null {
  const s = session;
  const agora = loadAgora();
  if (!s || !engine || !agora) return null;
  if (!applyBlur(engine, agora, on)) return "Background blur isn't available on this device.";
  patch(s.callId, { blur: on });
  return null;
}
