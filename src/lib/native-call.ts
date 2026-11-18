/**
 * Native incoming calls: the phone's own ringing UI, also when the screen is locked or the app was killed.
 *
 * iOS      CallKit through react-native-callkeep. A VoIP push (supabase/functions/voip-push, APNs PushKit) is
 *          reported to CallKit natively (plugins/zoyra-calls/ios/ZoyraVoip.m) with our ringtone, the caller's
 *          name and "Zoyra audio" / "Zoyra video" as the handle. This module registers the VoIP token
 *          (react-native-voip-push-notification → register_voip_token) and turns CallKit's Answer / Decline into
 *          answer_call RPCs + the /call screen.
 * Android  A high-priority data-only push runs `ZOYRA_CALL_TASK` (expo-notifications background task) even when
 *          the app was killed: it posts our full-screen CallStyle notification (NativeModules.ZoyraCall,
 *          plugins/zoyra-calls/android) that opens /call over the lock screen, plus a self-managed
 *          ConnectionService call (react-native-callkeep) so Telecom / Bluetooth / car know about it.
 *          Decline on the notification runs the `ZoyraCallAction` headless task.
 *
 * This file is imported by the app entry (index.js) so both background tasks are defined at module scope.
 * Everything here is best effort: in Expo Go / web / an old build the native pieces are missing and the
 * app falls back to the in-app ring screen + the normal push.
 */
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { AppRegistry, AppState, NativeModules, Platform } from 'react-native';

import { answerCall, endCall, getCall, isLiveCall, type Call, type CallKind } from './calls';
import { supabase } from './supabase';

/* ================================================================== native modules (optional) */

type CallKeepModule = typeof import('react-native-callkeep').default;
type VoipModule = typeof import('react-native-voip-push-notification').default;
type TaskManagerModule = typeof import('expo-task-manager');

type ZoyraCallNative = {
  showIncoming(callId: string, callerName: string, video: boolean): void;
  dismiss(callId: string): void;
  dismissAll(): void;
  canUseFullScreenIntent(): Promise<boolean>;
  openFullScreenIntentSettings(): void;
  setShowWhenLocked(on: boolean): void;
  getRingerMode(): Promise<'normal' | 'vibrate' | 'silent'>;
  isLocked(): Promise<boolean>;
  /** Added with the auto-answer hardening; missing on older builds. */
  consumeAnswer?(callId: string): Promise<boolean>;
};

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

function load<T>(get: () => T): T | null {
  try {
    return get() ?? null;
  } catch {
    return null;
  }
}

let callKeepCache: CallKeepModule | null | undefined;
function callKeep(): CallKeepModule | null {
  if (callKeepCache !== undefined) return callKeepCache;
  // The JS wrapper loads fine without its native module; only use it when the native side is in the build.
  const native = NativeModules.RNCallKeep as unknown;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  callKeepCache = isNative && native ? load(() => (require('react-native-callkeep') as { default: CallKeepModule }).default) : null;
  return callKeepCache;
}

let voipCache: VoipModule | null | undefined;
function voip(): VoipModule | null {
  if (voipCache !== undefined) return voipCache;
  const native = NativeModules.RNVoipPushNotificationManager as unknown;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  voipCache = Platform.OS === 'ios' && native ? load(() => (require('react-native-voip-push-notification') as { default: VoipModule }).default) : null;
  return voipCache;
}

function taskManager(): TaskManagerModule | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return isNative ? load(() => require('expo-task-manager') as TaskManagerModule) : null;
}

/** NativeModules.ZoyraCall (Android only; null on iOS / Expo Go / older builds). */
function zoyraCall(): ZoyraCallNative | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.ZoyraCall as ZoyraCallNative | undefined) ?? null;
}

/* ================================================================== auto-answer token */

/**
 * `/call?answer=1` only auto-answers when the app itself asked for it: the native Answer handler (CallKit /
 * Telecom), the in-app incoming banner, or our Android notification's Answer button (verified natively with a
 * per-notification nonce). A crafted `zoyra://call?id=…&answer=1` link just opens the ringing screen.
 */
const ANSWER_GRANT_TTL_MS = 60_000;
const answerGrants = new Map<string, number>();

/** Allows one auto-answer of `callId` by the /call screen (call right before navigating there). */
export function grantAutoAnswer(callId: string): void {
  answerGrants.set(norm(callId), Date.now());
}

/** One-shot: may /call auto-answer `callId`? Checks the in-memory grant, then the Android notification proof. */
export async function consumeAutoAnswer(callId: string): Promise<boolean> {
  const id = norm(callId);
  const at = answerGrants.get(id);
  answerGrants.delete(id);
  if (at !== undefined && Date.now() - at < ANSWER_GRANT_TTL_MS) return true;
  const zc = zoyraCall();
  if (!zc?.consumeAnswer) return false;
  try {
    return (await zc.consumeAnswer(id)) === true;
  } catch {
    return false;
  }
}

/** True when this build rings natively (CallKit / full-screen call notification). */
export function nativeCallsAvailable(): boolean {
  return Platform.OS === 'ios' ? !!callKeep() && !!voip() : Platform.OS === 'android' ? !!zoyraCall() : false;
}

/* ================================================================== tones (in-app) */

type Player = ReturnType<typeof import('expo-audio').createAudioPlayer>;
type AudioModule = typeof import('expo-audio');

const RING = require('../../assets/sounds/zoyra_ring.wav') as number;
const RINGBACK = require('../../assets/sounds/zoyra_ringback.wav') as number;
/** The app's normal audio mode (src/state/player.tsx); restored after a tone. */
const APP_AUDIO_MODE = { playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' } as const;

let tone: { player: Player; kind: 'ring' | 'ringback' } | null = null;
let toneSeq = 0;

function audio(): AudioModule | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return load(() => require('expo-audio') as AudioModule);
}

/**
 * Loops a call tone. 'ring' (incoming) respects the ringer: silent switch on iOS, ringer mode on Android
 * (vibration is the caller's job and always runs). 'ringback' plays for the caller while "Calling…".
 * `source` overrides the ring sound (e.g. the Forever gold ringtone, `ringtoneFor(callerId)` in src/lib/forever.ts).
 */
export async function startTone(kind: 'ring' | 'ringback', source?: number): Promise<void> {
  if (tone?.kind === kind) return;
  stopTone();
  const seq = ++toneSeq;
  const a = audio();
  if (!a) return;
  try {
    if (kind === 'ring') {
      if (Platform.OS === 'android') {
        const mode = await zoyraCall()?.getRingerMode().catch(() => 'normal' as const);
        if (mode && mode !== 'normal') return;
      }
      // iOS: not playing in silent mode = the ring follows the ring / silent switch.
      await a.setAudioModeAsync({ playsInSilentMode: false, shouldPlayInBackground: false, interruptionMode: 'doNotMix' }).catch(() => undefined);
    }
    if (seq !== toneSeq) return;
    const player = a.createAudioPlayer(kind === 'ring' ? (source ?? RING) : RINGBACK);
    player.loop = true;
    player.volume = kind === 'ring' ? 1 : 0.55;
    player.play();
    tone = { player, kind };
  } catch {
    // no tone, vibration still runs
  }
}

/** Stops any call tone (answer / decline / cancel / timeout / screen unmount). Safe to call any time. */
export function stopTone(): void {
  toneSeq++;
  const cur = tone;
  tone = null;
  if (!cur) return;
  try {
    cur.player.pause();
    cur.player.remove();
  } catch {
    // already released
  }
  if (cur.kind === 'ring') void audio()?.setAudioModeAsync(APP_AUDIO_MODE).catch(() => undefined);
}

/* ================================================================== lock screen (Android) */

/** Keeps the call screen visible over the lock screen (Android) while a call rings or is live. */
export function setCallShowWhenLocked(on: boolean): void {
  try {
    zoyraCall()?.setShowWhenLocked(on);
  } catch {
    // older build
  }
}

/** Android 14+: whether the user allows full-screen call alerts (otherwise calls show as a heads-up banner). */
export async function canUseFullScreenCalls(): Promise<boolean> {
  const z = zoyraCall();
  if (!z) return true;
  return z.canUseFullScreenIntent().catch(() => true);
}

export function openFullScreenCallSettings(): void {
  zoyraCall()?.openFullScreenIntentSettings();
}

/* ================================================================== app wiring (JS side) */

type Handlers = {
  /** Native Answer (CallKit / Telecom / notification): accept on the server and open /call joined. */
  onAnswer: (callId: string) => void;
  /** Native Decline / hang up. */
  onEnd: (callId: string) => void;
};

let handlers: Handlers | null = null;
const queued: { kind: 'answer' | 'end'; callId: string }[] = [];
/** Calls the system UI is showing (CallKit reported / Telecom displayed / our notification). */
const nativeShown = new Set<string>();
/** Calls we ended natively ourselves (don't treat their `endCall` event as the user's decline). */
const endedByApp = new Set<string>();
const shownListeners = new Set<() => void>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const norm = (id: string) => id.toLowerCase();

function markShown(callId: string) {
  nativeShown.add(norm(callId));
  shownListeners.forEach((l) => l());
}

/** The phone's own call UI is ringing for this call (so the app shouldn't ring / show its banner too). */
export function isShownNatively(callId: string): boolean {
  return nativeShown.has(norm(callId));
}

export function subscribeNativeShown(listener: () => void): () => void {
  shownListeners.add(listener);
  return () => shownListeners.delete(listener);
}

function dispatch(kind: 'answer' | 'end', rawId: string) {
  if (!UUID_RE.test(rawId)) return;
  const callId = norm(rawId);
  if (kind === 'end' && endedByApp.has(callId)) {
    endedByApp.delete(callId);
    return;
  }
  if (handlers) {
    if (kind === 'answer') handlers.onAnswer(callId);
    else handlers.onEnd(callId);
  } else {
    queued.push({ kind, callId });
  }
}

/** CallHost registers what Answer / Decline do; queued native actions (cold start) run now. */
export function setNativeCallHandlers(h: Handlers | null): void {
  handlers = h;
  if (!h) return;
  while (queued.length) {
    const q = queued.shift();
    if (q) dispatch(q.kind, q.callId);
  }
}

const androidSetupOptions = {
  ios: { appName: 'Zoyra', supportsVideo: true, maximumCallGroups: '1', maximumCallsPerCallGroup: '1', ringtoneSound: 'zoyra_ring.wav', includesCallsInRecents: false },
  android: {
    alertTitle: 'Allow Zoyra calls',
    alertDescription: 'Zoyra needs this to ring for voice and video calls.',
    cancelButton: 'Not now',
    okButton: 'Allow',
    additionalPermissions: [] as string[],
    selfManaged: true,
    // A headless task's React instance stops after the task: keep the ringing call.
    endCallsWhenReactNativeStops: false,
  },
};

let ckSetup: Promise<boolean> | null = null;
/** react-native-callkeep setup (iOS: ignored, CallKit is set up natively; Android: self-managed phone account). */
function ensureCallKeep(): Promise<boolean> {
  const ck = callKeep();
  if (!ck) return Promise.resolve(false);
  ckSetup ??= ck
    .setup(androidSetupOptions)
    .then(() => {
      if (Platform.OS === 'android') ck.setAvailable(true);
      return true;
    })
    .catch(() => false);
  return ckSetup;
}

let listenersOn = false;
function listenCallKeep() {
  const ck = callKeep();
  if (!ck || listenersOn) return;
  listenersOn = true;
  ck.addEventListener('answerCall', ({ callUUID }) => {
    zoyraCall()?.dismiss(norm(callUUID));
    dispatch('answer', callUUID);
  });
  ck.addEventListener('endCall', ({ callUUID }) => {
    zoyraCall()?.dismiss(norm(callUUID));
    dispatch('end', callUUID);
  });
  ck.addEventListener('didDisplayIncomingCall', ({ callUUID, error }) => {
    if (!error) markShown(callUUID);
  });
  // Android self-managed: Telecom asks us to show our own incoming UI.
  ck.addEventListener('showIncomingCallUi', ({ callUUID, name, handle }) => {
    zoyraCall()?.showIncoming(norm(callUUID), name, /video/i.test(handle));
    markShown(callUUID);
  });
  ck.addEventListener('didLoadWithEvents', (events) => {
    for (const e of events ?? []) {
      const data = e.data as { callUUID?: string; error?: string } | undefined;
      if (!data?.callUUID) continue;
      if (e.name === 'RNCallKeepPerformAnswerCallAction') dispatch('answer', data.callUUID);
      else if (e.name === 'RNCallKeepPerformEndCallAction') dispatch('end', data.callUUID);
      else if (e.name === 'RNCallKeepDidDisplayIncomingCall' && !data.error) markShown(data.callUUID);
    }
  });
}

function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined;
  const id = extra?.eas?.projectId;
  return typeof id === 'string' && id ? id : null;
}

/** This device's Expo push token when notifications are already allowed (never prompts). */
async function expoPushToken(): Promise<string | null> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    const projectId = easProjectId();
    if (!perm.granted || !projectId) return null;
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null;
  }
}

let registeredFor: string | null = null;

/**
 * Signed in: wire native calling for `userId` (idempotent). Registers the device in voip_tokens, sets up
 * CallKeep listeners and the background call task. Never throws.
 */
export async function setupNativeCalls(userId: string | null | undefined): Promise<void> {
  if (!isNative || !userId) return;
  listenCallKeep();
  if (registeredFor === userId) return;
  registeredFor = userId;
  try {
    void ensureCallKeep();
    if (Platform.OS === 'ios') {
      const v = voip();
      if (!v) return;
      const save = (token: string) => {
        if (!token) return;
        void expoPushToken().then((push) => supabase.rpc('register_voip_token', { p_token: token, p_platform: 'ios', p_push_token: push }));
      };
      v.addEventListener('register', save);
      v.addEventListener('didLoadWithEvents', (events) => {
        for (const e of events ?? []) if (e.name === 'RNVoipPushRemoteNotificationsRegisteredEvent' && typeof e.data === 'string') save(e.data);
      });
      // Never call v.registerVoipToken(): PushKit is registered natively (ZoyraVoip), not by the AppDelegate.
    } else if (zoyraCall()) {
      await registerCallTask();
      const push = await expoPushToken();
      if (push) await supabase.rpc('register_voip_token', { p_token: push, p_platform: 'android', p_push_token: push });
    }
  } catch {
    registeredFor = null;
  }
}

/** Sign-out: this device stops ringing for the previous account. */
export async function teardownNativeCalls(): Promise<void> {
  registeredFor = null;
  try {
    const push = await expoPushToken();
    if (push) await supabase.from('voip_tokens').delete().eq('push_token', push);
  } catch {
    // offline: the server re-assigns the token on the next sign-in
  }
}

/** Ends the system call UI for a call that stopped ringing / ended elsewhere (no decline sent). */
export function dismissNativeCall(callId: string, reason: 'remote' | 'answeredElsewhere' | 'unanswered' = 'remote'): void {
  const id = norm(callId);
  zoyraCall()?.dismiss(id);
  const ck = callKeep();
  if (!ck || !nativeShown.has(id)) return;
  nativeShown.delete(id);
  endedByApp.add(id);
  try {
    ck.reportEndCallWithUUID(id, reason === 'answeredElsewhere' ? 4 : reason === 'unanswered' ? 3 : 2);
  } catch {
    // not known natively
  }
}

/** The call was answered in the app: tell Telecom (Android) it is active. */
export function nativeCallActive(callId: string): void {
  const id = norm(callId);
  zoyraCall()?.dismiss(id);
  const ck = callKeep();
  if (!ck || !nativeShown.has(id)) return;
  try {
    if (Platform.OS === 'android') ck.setCurrentCallActive(id);
  } catch {
    // ignore
  }
}

/** The answered call ended: close it in CallKit / Telecom without a second end event. */
export function nativeCallEnded(callId: string): void {
  dismissNativeCall(callId, 'remote');
}

/**
 * Keeps the native UI in step with a call row seen in the app (realtime): leaving 'ringing' anywhere
 * else dismisses the native ring.
 */
export function syncNativeCall(call: Pick<Call, 'id' | 'status'> | null): void {
  if (!call) return;
  if (call.status === 'ringing') return;
  if (call.status === 'accepted') nativeCallActive(call.id);
  else dismissNativeCall(call.id, call.status === 'missed' ? 'unanswered' : 'remote');
}

/* ================================================================== decline extras */

/** "Remind me": local notification in 1 hour, "Call <name> back", opening the chat. */
export async function scheduleCallBackReminder(name: string, conversationId: string): Promise<boolean> {
  if (!isNative) return false;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return false;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Call ${name} back`,
        body: 'You asked Zoyra to remind you about this call.',
        data: { kind: 'call_reminder', conversation_id: conversationId, url: `/chat-pro?id=${encodeURIComponent(conversationId)}` },
        sound: 'default',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 60 * 60, ...(Platform.OS === 'android' ? { channelId: 'default' } : {}) },
    });
    return true;
  } catch {
    return false;
  }
}

/* ================================================================== background (module scope) */

export const ZOYRA_CALL_TASK = 'ZOYRA_CALL_TASK';

type CallPush = { type: 'call' | 'call_cancel'; call_id: string; caller_name: string; kind: CallKind; reason?: string; expires_at?: number };

function parseCallPush(raw: unknown): CallPush | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  let data: Record<string, unknown> = (outer.data && typeof outer.data === 'object' ? outer.data : outer) as Record<string, unknown>;
  if (typeof data.dataString === 'string') {
    try {
      const parsed: unknown = JSON.parse(data.dataString);
      if (parsed && typeof parsed === 'object') data = { ...data, ...(parsed as Record<string, unknown>) };
    } catch {
      // not JSON
    }
  }
  if (data.zoyra_call !== '1' && data.zoyra_call !== 1 && data.zoyra_call !== true) return null;
  const callId = typeof data.call_id === 'string' ? data.call_id.toLowerCase() : '';
  if (!UUID_RE.test(callId)) return null;
  return {
    type: data.type === 'call_cancel' ? 'call_cancel' : 'call',
    call_id: callId,
    caller_name: typeof data.caller_name === 'string' && data.caller_name ? data.caller_name : 'Zoyra',
    kind: data.kind === 'video' ? 'video' : 'audio',
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    expires_at: Number(data.expires_at) || undefined,
  };
}

/** Android: a call push arrived (foreground, background or killed). */
async function handleCallPush(p: CallPush): Promise<void> {
  const z = zoyraCall();
  if (!z) return;
  if (p.type === 'call_cancel') {
    dismissNativeCall(p.call_id, p.reason === 'accepted' ? 'answeredElsewhere' : p.reason === 'missed' ? 'unanswered' : 'remote');
    return;
  }
  if (p.expires_at && Date.now() / 1000 > p.expires_at) return;
  // App open and unlocked: the in-app banner / ring screen handles it (CallHost, realtime).
  if (AppState.currentState === 'active' && !(await z.isLocked().catch(() => false))) return;
  z.showIncoming(p.call_id, p.caller_name, p.kind === 'video');
  markShown(p.call_id);
  // Telecom (self-managed ConnectionService): Bluetooth / car / other calling apps see the call.
  const ck = callKeep();
  if (ck && (await ensureCallKeep())) {
    try {
      ck.displayIncomingCall(p.call_id, p.kind === 'video' ? 'Zoyra video' : 'Zoyra audio', p.caller_name, 'generic', p.kind === 'video');
    } catch {
      // the notification still rings
    }
  }
}

let taskRegistered = false;
/**
 * Android: registers the background notification task (calls + data-only E2EE message pushes). Also
 * called by push registration, so message previews decrypt even on builds without native calls.
 */
export async function ensureBackgroundNotificationTask(): Promise<void> {
  if (!tm) return;
  await registerCallTask();
}
async function registerCallTask(): Promise<void> {
  if (taskRegistered || Platform.OS !== 'android') return;
  try {
    await Notifications.registerTaskAsync(ZOYRA_CALL_TASK);
    taskRegistered = true;
  } catch {
    // expo-task-manager missing in this build
  }
}

const tm = taskManager();
if (tm && Platform.OS === 'android') {
  try {
    tm.defineTask<Notifications.NotificationTaskPayload>(ZOYRA_CALL_TASK, async ({ data }) => {
      if (!data || 'actionIdentifier' in data) return;
      const push = parseCallPush(data);
      if (push) {
        await handleCallPush(push);
        return;
      }
      // E2EE chat messages arrive data-only on Android: decrypt + present locally (src/lib/e2ee-notify.ts).
      // Lazy require keeps the call path (and app entry) free of the chat / crypto modules.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { handleE2EEMessagePush } = require('./e2ee-notify') as typeof import('./e2ee-notify');
        await handleE2EEMessagePush(data);
      } catch {
        // not a message push / module unavailable
      }
    });
  } catch {
    // defined twice (fast refresh)
  }
}

/** Headless task from the Android notification's Decline button (ZoyraCallActionReceiver). */
if (Platform.OS === 'android') {
  try {
    AppRegistry.registerHeadlessTask('ZoyraCallAction', () => async (input: { action?: string; callId?: string }) => {
      const callId = typeof input?.callId === 'string' ? norm(input.callId) : '';
      if (!UUID_RE.test(callId) || input.action !== 'decline') return;
      zoyraCall()?.dismiss(callId);
      const ck = callKeep();
      if (ck) {
        endedByApp.add(callId);
        try {
          ck.rejectCall(callId);
        } catch {
          // no Telecom call
        }
      }
      try {
        const c = await getCall(callId);
        if (c && isLiveCall(c)) await (c.status === 'ringing' ? answerCall(callId, false) : endCall(callId));
      } catch {
        // offline / signed out: the call times out as missed
      }
    });
  } catch {
    // registered twice
  }
}
