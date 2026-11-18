import { Platform } from 'react-native';

import { getPref, setPref, usePref } from './prefs';

/**
 * Emoji data + preferences for the emoji picker (src/components/EmojiPicker.tsx).
 *
 * Data: `emojibase-data` (MIT) English dataset, loaded lazily on first use (it is ~800 KB of JSON, so it is
 * never part of app start). Emoji newer than what the OS font can draw are filtered out (no tofu boxes).
 * Prefs: recently used (top 24) and the skin tone live in `prefs.ts` (AsyncStorage, device-only).
 */

export type SkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export type EmojiItem = {
  /** Default (yellow) glyph. */
  e: string;
  /** CLDR name, used as the accessibility label. */
  name: string;
  /** Single-tone variants for tones 1–5 (index 0 = tone 1), when the emoji supports skin tones. */
  skins?: string[];
  /** Lowercase "name tag tag…" used by search. */
  hay: string;
};

export type EmojiCategoryKey = 'recent' | 'people' | 'nature' | 'food' | 'activity' | 'travel' | 'objects' | 'symbols' | 'flags';

export type EmojiCategory = { key: EmojiCategoryKey; title: string; icon: string; items: EmojiItem[] };

/** Tab order. `groups` are emojibase group ids (2 = skin-tone/hair components, never shown). */
export const EMOJI_CATEGORIES: { key: EmojiCategoryKey; title: string; icon: string; groups: number[] }[] = [
  { key: 'recent', title: 'Recently used', icon: '🕘', groups: [] },
  { key: 'people', title: 'Smileys & People', icon: '😀', groups: [0, 1] },
  { key: 'nature', title: 'Animals & Nature', icon: '🐻', groups: [3] },
  { key: 'food', title: 'Food & Drink', icon: '🍔', groups: [4] },
  { key: 'activity', title: 'Activity', icon: '⚽', groups: [6] },
  { key: 'travel', title: 'Travel & Places', icon: '✈️', groups: [5] },
  { key: 'objects', title: 'Objects', icon: '💡', groups: [7] },
  { key: 'symbols', title: 'Symbols', icon: '🔣', groups: [8] },
  { key: 'flags', title: 'Flags', icon: '🏳️', groups: [9] },
];

export const SKIN_TONE_LABELS = ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'] as const;
/** Swatch glyphs for the tone selector. */
export const SKIN_TONE_SAMPLES = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'] as const;

type RawSkin = { emoji: string; tone?: number | number[]; version?: number };
type RawEmoji = { label: string; emoji: string; tags?: string[]; group?: number; order?: number; version?: number; skins?: RawSkin[] };

/** Newest Emoji version the system font draws (iOS / Android emoji font release history). */
export function maxEmojiVersion(): number {
  if (Platform.OS === 'android') {
    const api = Number(Platform.Version) || 0;
    return api >= 36 ? 16 : api >= 35 ? 15.1 : api >= 34 ? 15 : api >= 33 ? 14 : api >= 31 ? 13.1 : api >= 30 ? 13 : 12;
  }
  if (Platform.OS === 'ios') {
    const [maj = 0, min = 0] = String(Platform.Version).split('.').map(Number);
    const v = maj + min / 10;
    return v >= 18.4 ? 16 : v >= 17.4 ? 15.1 : v >= 16.4 ? 15 : v >= 15.4 ? 14 : 13.1;
  }
  return 15; // web: modern browsers / OS fonts
}

type EmojiData = { categories: EmojiCategory[]; all: EmojiItem[]; byGlyph: Map<string, EmojiItem> };
let data: EmojiData | null = null;

/** Builds (once) and returns the emoji dataset. Synchronous; call it off the open animation (see `prewarmEmoji`). */
export function getEmojiData(): EmojiData {
  if (data) return data;
  const raw = require('emojibase-data/en/data.json') as RawEmoji[];
  const maxV = maxEmojiVersion();
  const byGroup = new Map<number, EmojiItem[]>();
  const byGlyph = new Map<string, EmojiItem>();
  const sorted = raw.filter((r) => typeof r.group === 'number' && r.group !== 2 && (r.version ?? 0) <= maxV).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const r of sorted) {
    const tones = r.skins?.filter((s) => typeof s.tone === 'number' && (s.version ?? 0) <= maxV).sort((a, b) => (a.tone as number) - (b.tone as number));
    const item: EmojiItem = {
      e: r.emoji,
      name: r.label,
      skins: tones && tones.length === 5 ? tones.map((s) => s.emoji) : undefined,
      hay: `${r.label} ${(r.tags ?? []).join(' ')}`.toLowerCase(),
    };
    const g = r.group as number;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(item);
    byGlyph.set(item.e, item);
    item.skins?.forEach((s, i) => byGlyph.set(s, { e: s, name: `${item.name}, ${SKIN_TONE_LABELS[i + 1].toLowerCase()} skin tone`, hay: item.hay }));
  }
  const categories = EMOJI_CATEGORIES.filter((c) => c.key !== 'recent').map((c) => ({ key: c.key, title: c.title, icon: c.icon, items: c.groups.flatMap((g) => byGroup.get(g) ?? []) }));
  data = { categories, all: categories.flatMap((c) => c.items), byGlyph };
  return data;
}

/** Loads the dataset in the background a moment after a chat screen settles, so the first open has no wait. */
export function prewarmEmoji(delay = 1200): () => void {
  if (data) return () => undefined;
  const t = setTimeout(() => {
    try {
      getEmojiData();
    } catch {
      // the picker retries on open
    }
  }, delay);
  return () => clearTimeout(t);
}

/** Search by name / keywords: every word of the query must prefix-match a word of the emoji's name or tags. */
export function searchEmoji(query: string, limit = 240): EmojiItem[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: EmojiItem[] = [];
  for (const it of getEmojiData().all) {
    if (words.every((w) => it.hay.startsWith(w) || it.hay.includes(` ${w}`) || it.hay.includes(`-${w}`))) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Glyph for an item at the chosen skin tone (falls back to the default glyph). */
export const withTone = (it: EmojiItem, tone: SkinTone) => (tone && it.skins ? it.skins[tone - 1] : it.e);

/* ------------------------------------------------------------------ prefs: recents + skin tone */

const RECENT_KEY = 'emojiRecent';
const TONE_KEY = 'emojiSkinTone';
export const RECENT_MAX = 24;
const NO_RECENT: string[] = [];
/** Shown under "Recently used" until the person has picked anything (the old fixed reaction set). */
export const DEFAULT_RECENT = ['❤️', '🔥', '😂', '👏', '😮', '😢', '👍', '🎵', '💯', '🙏'];

export function recordRecentEmoji(e: string) {
  const cur = getPref<string[]>(RECENT_KEY, []);
  setPref(RECENT_KEY, [e, ...cur.filter((x) => x !== e)].slice(0, RECENT_MAX));
}

export function useRecentEmoji(): string[] {
  const [list] = usePref<string[]>(RECENT_KEY, NO_RECENT);
  return Array.isArray(list) && list.length ? list : DEFAULT_RECENT;
}

export function useSkinTone(): readonly [SkinTone, (t: SkinTone) => void] {
  const [t, set] = usePref<number>(TONE_KEY, 0);
  const tone = (Number.isInteger(t) && t >= 0 && t <= 5 ? t : 0) as SkinTone;
  return [tone, set as (t: SkinTone) => void] as const;
}

/* ------------------------------------------------------------------ text helpers */

const KEYCAP = /[0-9#*]️?⃣/gu;

/**
 * Same rule as the `message_reactions.emoji` check (migration 20261115300000): 1–16 code points, and
 * no ASCII once keycap sequences (1️⃣ #️⃣ *️⃣) are removed.
 */
export function isValidReactionEmoji(s: string): boolean {
  const n = [...s].length;
  if (n < 1 || n > 16) return false;
  return !/[\u0000-\u007F]/.test(s.replace(KEYCAP, ''));
}

/** One emoji "cluster": flag pair, keycap, or pictograph (+ VS16 / skin tone / tags) joined by ZWJ. */
const CLUSTER_SRC =
  '(?:[\\u{1F1E6}-\\u{1F1FF}]{2}|[0-9#*]\\uFE0F?\\u20E3|PICT(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*[\\u{E0020}-\\u{E007F}]*(?:\\u200D(?:PICT)(?:\\uFE0F|[\\u{1F3FB}-\\u{1F3FF}])*)*)';
const PICT_PROP = '\\p{Extended_Pictographic}';
const PICT_RANGES = '[\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\u2B00-\\u2BFF\\u2300-\\u23FF\\u2190-\\u21FF\\u3030\\u303D\\u3297\\u3299\\u00A9\\u00AE\\u203C\\u2049\\u2122\\u2139]';

function clusterRegex(): RegExp {
  try {
    return new RegExp(CLUSTER_SRC.replace(/PICT/g, PICT_PROP), 'gu');
  } catch {
    // engines without Unicode property escapes
    return new RegExp(CLUSTER_SRC.replace(/PICT/g, PICT_RANGES), 'gu');
  }
}
const CLUSTER = clusterRegex();

/**
 * Number of emoji when `text` is only 1–3 emoji (whitespace allowed between them), else 0.
 * Used to render "big emoji" messages without a bubble.
 */
export function bigEmojiCount(text: string | null | undefined): number {
  if (!text) return 0;
  const s = text.replace(/\s+/g, '');
  if (!s || s.length > 64) return 0;
  CLUSTER.lastIndex = 0;
  const found = s.match(CLUSTER);
  if (!found || found.length > 3 || found.join('') !== s) return 0;
  return found.length;
}
