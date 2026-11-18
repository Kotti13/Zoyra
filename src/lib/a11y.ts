import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

import type { Weight } from '../theme/tokens';
import { getPref, setPref, subscribePref, usePref } from './prefs';

/**
 * In-app accessibility preferences (device-only, stored through `prefs.ts`).
 *
 * The hooks below are what the UI kit reads. Non-React code (press feedback, animation helpers)
 * can use the `...Now()` getters, which read the same synchronous cache.
 */
export const A11Y_KEYS = {
  /** Percent, 90–130. 100 = the design size. */
  textScale: 'textScale',
  boldText: 'boldText',
  /** App-level Reduce Motion, ORed with the system setting. Shared with Display and theme. */
  reduceMotion: 'reduceMotion',
  reduceLyricMotion: 'reduceLyricMotion',
  highContrast: 'highContrast',
  colorBlindSafe: 'colorBlindSafe',
  screenReaderHints: 'screenReaderHints',
} as const;

export const TEXT_SCALE_MIN = 90;
export const TEXT_SCALE_MAX = 130;
export const TEXT_SCALE_STEP = 10;

const clampScale = (n: unknown) => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 100;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Math.round(v)));
};

/* ------------------------------------------------------------------ synchronous getters */

/** Text scale as a multiplier (0.9–1.3). */
export const textScaleNow = () => clampScale(getPref<number>(A11Y_KEYS.textScale, 100)) / 100;
export const boldTextNow = () => getPref(A11Y_KEYS.boldText, false);
export const appReduceMotionNow = () => getPref(A11Y_KEYS.reduceMotion, false);
export const reduceLyricMotionNow = () => getPref(A11Y_KEYS.reduceLyricMotion, false);
export const highContrastNow = () => getPref(A11Y_KEYS.highContrast, false);
export const colorBlindSafeNow = () => getPref(A11Y_KEYS.colorBlindSafe, false);
export const screenReaderHintsNow = () => getPref(A11Y_KEYS.screenReaderHints, true);

export function setTextScale(percent: number) {
  setPref(A11Y_KEYS.textScale, clampScale(percent));
}

/* ------------------------------------------------------------------ hooks */

/** Text scale multiplier (0.9–1.3) plus a setter that takes a percent. */
export function useTextScale(): readonly [number, (percent: number) => void] {
  const [raw] = usePref<number>(A11Y_KEYS.textScale, 100);
  return [clampScale(raw) / 100, setTextScale] as const;
}

export function useBoldText() {
  return usePref(A11Y_KEYS.boldText, false);
}

/** The in-app Reduce Motion override only (use `useEffectiveReduceMotion` to include the system setting). */
export function useAppReduceMotion() {
  return usePref(A11Y_KEYS.reduceMotion, false);
}

export function useReduceLyricMotion() {
  return usePref(A11Y_KEYS.reduceLyricMotion, false);
}

export function useHighContrast() {
  return usePref(A11Y_KEYS.highContrast, false);
}

export function useColorBlindSafe() {
  return usePref(A11Y_KEYS.colorBlindSafe, false);
}

export function useScreenReaderHints() {
  return usePref(A11Y_KEYS.screenReaderHints, true);
}

/** System Reduce Motion (OS setting), live. */
export function useSystemReduceMotion() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setOn(v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

/** System setting OR the in-app override. */
export function useEffectiveReduceMotion() {
  const system = useSystemReduceMotion();
  const [app] = useAppReduceMotion();
  return system || app;
}

/* ------------------------------------------------------------------ helpers for the UI kit */

/** Scales a font size by the user's text scale. */
export const scaledSize = (size: number, scale = textScaleNow()) => Math.round(size * scale * 10) / 10;

/** Bold text: bumps a weight one step (max 800). */
export const boldenWeight = (w: Weight, bold = boldTextNow()): Weight => (bold ? (Math.min(800, w + 200) as Weight) : w);

/**
 * Colour-blind-friendly status colours. Red/green success and error cues become blue/orange
 * (distinguishable for protanopia and deuteranopia). Pass the theme's normal values.
 */
export function statusColors<C extends { success: string; error: string }>(normal: C, safe: boolean, palette: { blue: string; orange: string }) {
  return safe ? { ...normal, success: palette.blue, error: palette.orange } : normal;
}

/* ------------------------------------------------------------------ text: one subscription per <T> */

export type TextA11y = { scale: number; bold: boolean; contrast: boolean };
let textSnap: TextA11y = { scale: textScaleNow(), bold: boldTextNow(), contrast: highContrastNow() };
const readText = (): TextA11y => {
  const scale = textScaleNow();
  const bold = boldTextNow();
  const contrast = highContrastNow();
  if (scale !== textSnap.scale || bold !== textSnap.bold || contrast !== textSnap.contrast) textSnap = { scale, bold, contrast };
  return textSnap;
};
const subscribeText = (l: () => void) => {
  const a = subscribePref(A11Y_KEYS.textScale, l);
  const b = subscribePref(A11Y_KEYS.boldText, l);
  const c = subscribePref(A11Y_KEYS.highContrast, l);
  return () => {
    a();
    b();
    c();
  };
};

/** Text scale + bold + high contrast in a single store subscription (cheap enough for every `<T>`). */
export function useTextA11y(): TextA11y {
  return useSyncExternalStore(subscribeText, readText, readText);
}
