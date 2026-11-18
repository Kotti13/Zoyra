/**
 * Optional native helpers for the chat (expo-haptics, expo-screen-capture). Both are loaded lazily and guarded:
 * a development build made before they were added has no native module, and a static import would crash the
 * whole chat screen there. Without them: Android falls back to a short vibration, screenshots go undetected.
 */
import { Platform, Vibration } from 'react-native';

type HapticsModule = typeof import('expo-haptics');
type CaptureModule = typeof import('expo-screen-capture');

let haptics: HapticsModule | null | undefined;
let capture: CaptureModule | null | undefined;

function loadHaptics(): HapticsModule | null {
  if (haptics !== undefined) return haptics;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    haptics = require('expo-haptics') as HapticsModule;
  } catch {
    haptics = null;
  }
  return haptics;
}

function loadCapture(): CaptureModule | null {
  if (capture !== undefined) return capture;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    capture = require('expo-screen-capture') as CaptureModule;
  } catch {
    capture = null;
  }
  return capture;
}

/** Light "tick" (swipe-to-reply threshold, reaction). */
export function tick(): void {
  if (Platform.OS === 'web') return;
  const h = loadHaptics();
  if (h) {
    void h.selectionAsync().catch(() => undefined);
    return;
  }
  if (Platform.OS === 'android') Vibration.vibrate(12);
}

/** Calls `onShot` when the user takes a screenshot. Returns an unsubscribe function (no-op when unsupported). */
export function onScreenshot(onShot: () => void): () => void {
  if (Platform.OS === 'web') return () => {};
  const c = loadCapture();
  if (!c) return () => {};
  try {
    const sub = c.addScreenshotListener(onShot);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}

/** Blocks screenshots / recording while a view-once photo is on screen (Android; iOS 13+ best effort). */
export async function preventCapture(key: string): Promise<void> {
  const c = loadCapture();
  if (!c) return;
  await c.preventScreenCaptureAsync(key).catch(() => undefined);
}

export async function allowCapture(key: string): Promise<void> {
  const c = loadCapture();
  if (!c) return;
  await c.allowScreenCaptureAsync(key).catch(() => undefined);
}
