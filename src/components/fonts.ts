import { Inter_200ExtraLight, Inter_300Light, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import { isLoaded, loadAsync } from 'expo-font';

import { fonts } from '../theme/tokens';

/**
 * Extra Inter weights used by the cinematic theme (light 200/300 display headlines, 800 poster titles).
 * The root layout loads 400–700; these load on first import so the UI kit works on its own.
 * Until a weight is ready, `resolveFont` falls back to the nearest always-loaded weight.
 */
const EXTRA = {
  [fonts.extraLight]: Inter_200ExtraLight,
  [fonts.light]: Inter_300Light,
  [fonts.extraBold]: Inter_800ExtraBold,
};

const FALLBACK: Record<string, string> = {
  [fonts.extraLight]: fonts.regular,
  [fonts.light]: fonts.regular,
  [fonts.extraBold]: fonts.bold,
};

let started = false;
export function loadExtraFonts(): Promise<void> {
  if (started) return Promise.resolve();
  started = true;
  return loadAsync(EXTRA).catch(() => {
    // Leave the fallbacks in place; allow a later retry.
    started = false;
  });
}

loadExtraFonts();

/** The requested family if it is loaded, otherwise its fallback. */
export function resolveFont(family: string): string {
  const fb = FALLBACK[family];
  if (!fb) return family;
  return isLoaded(family) ? family : fb;
}
