/**
 * First-run permissions step (src/app/permissions.tsx): which OS permissions Zoyra asks for up front, their
 * current status, and the per-device "already seen" flag the AuthGate (src/app/_layout.tsx) checks.
 *
 * Location (Run mode) and photo saving are asked just-in-time where they are used, not here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';
import { Camera } from 'expo-camera';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { IosAuthorizationStatus } from 'expo-notifications';
import { useSyncExternalStore } from 'react';
import { Linking, PermissionsAndroid, Platform } from 'react-native';

import type { IconName } from '../components';
import * as localMusic from './local-music';
import { canUseFullScreenCalls, nativeCallsAvailable, openFullScreenCallSettings } from './native-call';

/* ================================================================== seen flag (per device) */

export const PERMISSIONS_SEEN_KEY = 'zoyra.permissions.seen.v1';

/** null while loading from storage. Web never shows the step. */
let seen: boolean | null = Platform.OS === 'web' ? true : null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

if (seen === null) {
  AsyncStorage.getItem(PERMISSIONS_SEEN_KEY)
    .then((v) => {
      if (seen === null) seen = v === '1';
    })
    .catch(() => {
      if (seen === null) seen = false;
    })
    .finally(emit);
}

/** Has this device already been shown the permissions step? (null while loading.) */
export function usePermissionsSeen(): boolean | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => seen,
  );
}

/** True when the step still has to be shown (false while loading, so callers fall back to Home). */
export const permissionsPending = () => seen === false;

/**
 * Persists the flag. `notify: false` only writes storage (used when the screen opens, so a killed app never shows
 * it twice) without letting the AuthGate move on (it would replay a pending deep link over the screen).
 */
export function markPermissionsSeen(notify = true): void {
  AsyncStorage.setItem(PERMISSIONS_SEEN_KEY, '1').catch(() => undefined);
  if (notify && seen !== true) {
    seen = true;
    emit();
  }
}

/* ================================================================== permissions */

export type PermKey = 'notifications' | 'microphone' | 'camera' | 'music' | 'fullscreen' | 'bluetooth';

/** granted · undetermined/denied (can ask) · blocked (only Settings can change it) · unavailable (hide the row). */
export type PermStatus = 'granted' | 'undetermined' | 'denied' | 'blocked' | 'unavailable';

export type PermDef = { key: PermKey; title: string; why: string; icon: IconName; /** Opens a system settings page instead of a dialog. */ settingsOnly?: boolean };

export const PERMISSIONS: PermDef[] = [
  { key: 'notifications', title: 'Notifications', why: 'Messages, calls and new releases', icon: 'bell' },
  { key: 'microphone', title: 'Microphone', why: 'Voice notes, calls, karaoke and song recognition', icon: 'mic' },
  { key: 'camera', title: 'Camera', why: 'Video calls, QR codes and mood scan', icon: 'camera' },
  { key: 'music', title: 'Music and audio files', why: 'Play songs saved on your phone', icon: 'music' },
  { key: 'fullscreen', title: 'Full-screen call alerts', why: 'Ring over the lock screen for incoming calls', icon: 'call', settingsOnly: true },
  { key: 'bluetooth', title: 'Nearby devices', why: 'Use Bluetooth headsets and car audio on calls', icon: 'headphones' },
];

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';
const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const androidApi = Platform.OS === 'android' ? Number(Platform.Version) : 0;

type Resp = { granted: boolean; canAskAgain: boolean; status: string };

function fromResponse(r: Resp): PermStatus {
  if (r.granted) return 'granted';
  if (!r.canAskAgain) return 'blocked';
  return r.status === 'undetermined' ? 'undetermined' : 'denied';
}

function fromNotifications(r: Notifications.NotificationPermissionsStatus): PermStatus {
  // iOS: trust ios.status (provisional counts as allowed).
  if (r.ios?.status === IosAuthorizationStatus.PROVISIONAL) return 'granted';
  return fromResponse(r);
}

function fromLocal(s: localMusic.PermissionState): PermStatus {
  if (s.status === 'granted' || s.status === 'limited') return 'granted';
  if (!s.canAskAgain && s.status === 'denied') return 'blocked';
  return s.status === 'undetermined' ? 'undetermined' : 'denied';
}

/** Android has no "undetermined" read for BLUETOOTH_CONNECT; remember a "never ask again" answer this session. */
let bluetoothBlocked = false;

/** Whether the row applies to this platform / build at all (sync part; full-screen also needs the async check). */
export function permissionApplies(key: PermKey): boolean {
  if (!isNative) return false;
  switch (key) {
    // Remote push isn't available in Expo Go on Android (SDK 53+).
    case 'notifications':
      return !(isExpoGo && Platform.OS === 'android');
    case 'microphone':
    case 'camera':
      return true;
    case 'music':
      return Platform.OS === 'android' && !localMusic.expoGoLimited && localMusic.getAvailability().scan;
    case 'fullscreen':
      return androidApi >= 34 && nativeCallsAvailable();
    case 'bluetooth':
      // Requested at runtime by src/lib/call-session.ts for call audio routing (Android 12+).
      return androidApi >= 31 && !isExpoGo;
  }
}

export async function getPermissionStatus(key: PermKey): Promise<PermStatus> {
  if (!permissionApplies(key)) return 'unavailable';
  try {
    switch (key) {
      case 'notifications':
        return fromNotifications(await Notifications.getPermissionsAsync());
      case 'microphone':
        return fromResponse(await getRecordingPermissionsAsync());
      case 'camera':
        return fromResponse(await Camera.getCameraPermissionsAsync());
      case 'music':
        return fromLocal(await localMusic.getPermission());
      case 'fullscreen':
        return (await canUseFullScreenCalls()) ? 'granted' : 'blocked';
      case 'bluetooth':
        if (await PermissionsAndroid.check('android.permission.BLUETOOTH_CONNECT')) return 'granted';
        return bluetoothBlocked ? 'blocked' : 'undetermined';
    }
  } catch {
    return 'unavailable';
  }
}

/** Shows the OS dialog (or opens the settings page for full-screen alerts) and returns the new status. */
export async function requestPermission(key: PermKey): Promise<PermStatus> {
  if (!permissionApplies(key)) return 'unavailable';
  try {
    switch (key) {
      case 'notifications':
        return fromNotifications(await Notifications.requestPermissionsAsync());
      case 'microphone':
        return fromResponse(await requestRecordingPermissionsAsync());
      case 'camera':
        return fromResponse(await Camera.requestCameraPermissionsAsync());
      case 'music':
        return fromLocal(await localMusic.requestPermission());
      case 'fullscreen':
        openFullScreenCallSettings();
        return 'blocked'; // re-checked when the app comes back to the foreground
      case 'bluetooth': {
        const r = await PermissionsAndroid.request('android.permission.BLUETOOTH_CONNECT');
        if (r === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
        if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
          bluetoothBlocked = true;
          return 'blocked';
        }
        return 'denied';
      }
    }
  } catch {
    return 'denied';
  }
}

/** "Open Settings" for a blocked permission. */
export function openPermissionSettings(key: PermKey): void {
  if (key === 'fullscreen') openFullScreenCallSettings();
  else void Linking.openSettings().catch(() => undefined);
}
