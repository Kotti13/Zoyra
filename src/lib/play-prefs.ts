import type { CatalogTrack } from './catalog';
import { getPref, prefsReady, setPref, usePref } from './prefs';

/**
 * Typed keys and defaults for the playback, lyrics and video device prefs (Settings › Playback /
 * Lyrics / Video). Storage, hydration and change notifications are `src/lib/prefs.ts`.
 */

export type LyricsHighlightPref = 'fill' | 'wave' | 'static';
/** Index into the lyrics text sizes (normal, large, largest). */
export type LyricsSizePref = 0 | 1 | 2;

/** What "Resume where I left off" restores on the next app start. */
export type LastSession = {
  queue: CatalogTrack[];
  index: number;
  position: number;
  context: string | null;
  savedAt: number;
};

export const PLAY_PREF_DEFAULTS = {
  'playback.autoplaySimilar': true as boolean,
  'playback.resume': true as boolean,
  /** Playback speed (0.5–2), kept between app starts. */
  'playback.rate': 1 as number,
  'playback.lastSession': null as LastSession | null,
  'lyrics.size': 0 as LyricsSizePref,
  'lyrics.highlight': 'fill' as LyricsHighlightPref,
  'lyrics.autoOpen': false as boolean,
  'lyrics.target': 'English' as string,
  'lyrics.romanizeDefault': false as boolean,
  /** Audio output latency to wait for before highlighting lyrics (Bluetooth headphones), in ms. */
  'lyrics.outputDelayMs': 0 as number,
  /** Per-song lyric sync correction from the Sync control, seconds by track id (positive = earlier). */
  'lyrics.offsets': {} as Record<string, number>,
  'video.autoplayNext': true as boolean,
  'video.captions': false as boolean,
  /** ISO 639-1 code; '' = the device language. */
  'video.captionLang': '' as string,
  'video.autoplayShorts': true as boolean,
  'video.wifiOnlyPreviews': false as boolean,
};

export type PlayPrefKey = keyof typeof PLAY_PREF_DEFAULTS;
export type PlayPrefValue<K extends PlayPrefKey> = (typeof PLAY_PREF_DEFAULTS)[K];

/** Resolves once stored prefs are loaded (the player waits for it before restoring a session). */
export const playPrefsReady: Promise<void> = prefsReady();

export function getPlayPref<K extends PlayPrefKey>(key: K): PlayPrefValue<K> {
  return getPref<PlayPrefValue<K>>(key, PLAY_PREF_DEFAULTS[key]);
}

export function setPlayPref<K extends PlayPrefKey>(key: K, value: PlayPrefValue<K>) {
  setPref(key, value);
}

/** `[value, set]` for one preference; re-renders when it changes anywhere in the app. */
export function usePlayPref<K extends PlayPrefKey>(key: K): readonly [PlayPrefValue<K>, (v: PlayPrefValue<K>) => void] {
  const [value, set] = usePref<PlayPrefValue<K>>(key, PLAY_PREF_DEFAULTS[key]);
  return [value, set] as const;
}

/** Lyrics text sizes, shared by the lyrics screen and Settings › Lyrics. */
export const LYRICS_SIZES = [
  { label: 'Normal', scale: 1 },
  { label: 'Large', scale: 1.15 },
  { label: 'Largest', scale: 1.3 },
] as const;

/** Caption languages offered in Settings › Video (YouTube `cc_lang_pref` codes). */
export const CAPTION_LANGS = [
  { code: '', label: 'Device language' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
] as const;

/** Language the captions should use: the chosen one, else the device language. */
export function captionLang(): string {
  const chosen = getPlayPref('video.captionLang');
  if (chosen) return chosen;
  return (Intl.DateTimeFormat().resolvedOptions().locale ?? 'en').split(/[-_]/)[0] || 'en';
}
