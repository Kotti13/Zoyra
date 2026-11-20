/**
 * Synced lyrics from LRCLIB (https://lrclib.net), a free community database. No key needed.
 */
import { lyricsAi, type AiResult, type LyricsAiMode } from './ai';
import type { CatalogTrack } from './catalog';
import { activeLine, cleanTitle, closestByDuration, durationMatches, primaryArtist } from './lyrics-sync';
import { isZoyraId, zoyra } from './zoyra-api';

/** One sung word (or CJK character) with its start/end in seconds. */
export type LyricWord = { time: number; end: number; text: string };
/**
 * A synced line. `words` is set only when the LRC carried enhanced word tags (`<mm:ss.xx>word`);
 * use `timedLines()` to get words for every line (estimated when the source had none).
 */
export type LyricLine = { time: number; text: string; words?: LyricWord[] };
/** A line with an end time and per-word timing, ready for word-by-word highlighting. */
export type TimedLine = LyricLine & {
  end: number;
  words: LyricWord[];
  wordTiming: 'exact' | 'estimated';
};
export type Lyrics = {
  synced: LyricLine[];
  plain: string[];
  instrumental: boolean;
  /** 'original' = lyrics of the song this track remixes/covers (timing may differ, so usually plain only). */
  source: 'exact' | 'original';
  /** True when the synced lyrics carried real word-level timing (enhanced LRC). */
  wordSynced?: boolean;
  matchedTitle?: string;
  matchedArtist?: string;
  /** Song length (s) the synced timing was made for, when the source says (LRCLIB). */
  timedDuration?: number;
  /**
   * True when timed lyrics were found but for a different version of the song (length differs),
   * so they are shown plain instead of wrongly synced.
   */
  timingMismatch?: boolean;
};

type LrclibResponse = {
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
};

const toSeconds = (min: string, sec: string, frac?: string) => Number(min) * 60 + Number(sec) + (frac ? Number(frac) / 10 ** frac.length : 0);

/** Word tags of enhanced LRC: `<mm:ss.xx>`. */
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/**
 * Parse the text part of a line that may contain enhanced word tags, e.g.
 * `<00:12.10>Hello <00:12.60>world<00:13.40>`. Returns the clean text and, when tags were present,
 * the timed words (a trailing tag closes the last word).
 */
function parseWordTags(raw: string): { text: string; words?: LyricWord[] } {
  WORD_TAG.lastIndex = 0;
  if (!WORD_TAG.test(raw)) return { text: raw.trim() };
  WORD_TAG.lastIndex = 0;
  const marks: { time: number; at: number; after: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = WORD_TAG.exec(raw)))
    marks.push({
      time: toSeconds(m[1], m[2], m[3]),
      at: m.index,
      after: WORD_TAG.lastIndex,
    });
  const words: LyricWord[] = [];
  marks.forEach((mk, i) => {
    const next = marks[i + 1];
    const text = raw.slice(mk.after, next ? next.at : undefined);
    if (!text.trim()) return; // closing tag or a tag on whitespace
    words.push({ time: mk.time, end: next ? next.time : mk.time, text });
  });
  const text = raw.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim();
  return words.length ? { text, words } : { text };
}

/**
 * Parse LRC text: `[mm:ss.xx] line`, several timestamps per line allowed. Enhanced LRC word tags
 * (`<mm:ss.xx>word`) are removed from `text` and returned as `words`.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  const stamp = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    const times: number[] = [];
    let m: RegExpExecArray | null;
    let last = 0;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw))) {
      times.push(toSeconds(m[1], m[2], m[3]));
      last = stamp.lastIndex;
    }
    if (!times.length) continue;
    const { text, words } = parseWordTags(raw.slice(last));
    times.forEach((time) => {
      if (!words) return out.push({ time, text });
      // A repeated line ([00:10][01:10]) reuses its word offsets relative to the first stamp.
      const shift = time - times[0];
      out.push({
        time,
        text,
        words: words.map((w) => ({
          time: w.time + shift,
          end: w.end + shift,
          text: w.text,
        })),
      });
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------------ word timing */

/** Scripts written without spaces between words: highlight them character by character. */
const NO_SPACE_SCRIPT = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u0e00-\u0e7f]/;

/** Split a line into display tokens (words keep their trailing space). */
export function splitWords(text: string): string[] {
  const tokens = text.match(/\S+\s*/g) ?? [];
  if (tokens.length === 1 && NO_SPACE_SCRIPT.test(text)) return Array.from(text.trim());
  return tokens;
}

/** Rough singing pace used to estimate how long a line takes (seconds per character, min/max span). */
const SEC_PER_CHAR = 0.075;
/** Characters in scripts without spaces (CJK, Thai) each carry roughly a syllable. */
const SEC_PER_SYLLABLE = 0.22;
const MIN_SPAN = 0.8;
/** Lines with no next line end at most this long after they start. */
const LAST_LINE_MAX = 8;

/**
 * Every synced line with an end time and per-word timing. Real word tags are used when present;
 * otherwise the line's sung span (estimated from its length, never past the next line) is split
 * evenly across its words, weighted by word length.
 */
export function timedLines(lines: LyricLine[], trackDuration = 0): TimedLine[] {
  return lines.map((l, i) => {
    const nextTime = lines[i + 1]?.time;
    const end = nextTime ?? (trackDuration > l.time ? Math.min(trackDuration, l.time + LAST_LINE_MAX) : l.time + LAST_LINE_MAX);
    if (l.words?.length) {
      const words = l.words.map((w, j) => ({
        ...w,
        end: w.end > w.time ? w.end : (l.words?.[j + 1]?.time ?? end),
      }));
      return { ...l, end, words, wordTiming: 'exact' as const };
    }
    const tokens = splitWords(l.text);
    const chars = tokens.reduce((n, t) => n + t.trim().length + 1, 0);
    const span = Math.max(0, Math.min(end - l.time, Math.max(MIN_SPAN, chars * (NO_SPACE_SCRIPT.test(l.text) ? SEC_PER_SYLLABLE / 2 : SEC_PER_CHAR))));
    let at = l.time;
    const words = tokens.map((text) => {
      const d = chars ? (span * (text.trim().length + 1)) / chars : 0;
      const w = { time: at, end: at + d, text };
      at += d;
      return w;
    });
    return { ...l, end, words, wordTiming: 'estimated' as const };
  });
}

/** Index of the line active at `position` seconds (-1 before the first line). */
export { activeLine };

const cache = new Map<string, Lyrics | null>();

/** Strip "(feat. x)", "[Remix]" etc. that rarely match LRCLIB titles. */
const clean = (s: string) =>
  s
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function lrclibGet(title: string, artist: string, duration: number): Promise<LrclibResponse | null> {
  const qs = new URLSearchParams({
    track_name: title,
    artist_name: artist,
    duration: String(Math.round(duration)),
  });
  const res = await fetch(`https://lrclib.net/api/get?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Lyrics request failed (${res.status})`);
  return (await res.json()) as LrclibResponse;
}

async function lrclibSearch(title: string, artist: string): Promise<LrclibResponse[]> {
  const qs = new URLSearchParams({ track_name: title, artist_name: artist });
  const res = await fetch(`https://lrclib.net/api/search?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return [];
  return (await res.json()) as LrclibResponse[];
}

/**
 * Many catalogue uploads are remixes/flips titled "Original Artist - Song (Someone Remix)".
 * Returns candidate { title, artist } pairs for the underlying song.
 */
function originalCandidates(track: CatalogTrack): { title: string; artist: string }[] {
  const out: { title: string; artist: string }[] = [];
  const dash = track.title.split(/\s+[-–—]\s+/);
  if (dash.length >= 2) {
    const artist = dash[0].split(/\s+(?:x|X|&|feat\.?|ft\.?)\s+|,\s*/)[0].trim();
    out.push({ title: clean(dash.slice(1).join(' - ')), artist });
  }
  const cleaned = clean(track.title);
  if (cleaned && cleaned !== track.title) out.push({ title: cleaned, artist: track.artist.name });
  return out.filter((c) => c.title && c.artist);
}

const toLyrics = (r: LrclibResponse, source: Lyrics['source'], allowSynced: boolean): Lyrics => {
  const parsed = r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
  const synced = allowSynced ? parsed : [];
  return {
    synced,
    plain: (r.plainLyrics ?? parsed.map((l) => l.text).join('\n')).toString().split(/\r?\n/),
    instrumental: Boolean(r.instrumental),
    source,
    wordSynced: synced.some((l) => l.words?.length),
    matchedTitle: r.trackName,
    matchedArtist: r.artistName,
    timedDuration: r.duration && r.duration > 0 ? r.duration : undefined,
  };
};

/** Search candidates for this track: the cleaned (video-noise-free) title first, then remix originals. */
function searchCandidates(track: CatalogTrack): { title: string; artist: string; original: boolean }[] {
  const artist = track.artist.name;
  const cleaned = cleanTitle(track.title, artist);
  const list = [
    { title: cleaned, artist, original: false },
    { title: cleaned, artist: primaryArtist(artist), original: false },
    ...originalCandidates(track).map((c) => ({ ...c, original: true })),
  ];
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.title.toLowerCase()}|${c.artist.toLowerCase()}`;
    if (!c.title || !c.artist || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const MAX_SEARCHES = 3;

/**
 * Fetch lyrics for a track. Resolves `null` when nothing is found.
 *
 * Synced lyrics are only kept when their timing was made for this audio: LRCLIB's exact `get`
 * (matches length ±2 s) or a search hit whose length is within ±2 s. Otherwise the words are
 * returned plain with `timingMismatch` so the UI never shows wrongly-timed sync.
 *
 * `opts.duration`: the real loaded audio length from the player (better than catalogue metadata).
 */
export async function fetchLyrics(track: CatalogTrack, opts?: { duration?: number }): Promise<Lyrics | null> {
  const duration = opts?.duration && opts.duration > 0 ? opts.duration : track.duration;
  const key = `${track.id}|${Math.round(duration || 0)}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let lyrics: Lyrics | null = null;

  // 0) Zoyra (YouTube) songs: the backend cleans noisy video titles before matching on LRCLIB.
  let zoyraLate: Awaited<ReturnType<typeof zoyra.lyrics>> = null;
  if (isZoyraId(track.id)) {
    const z = await zoyra.lyrics({ ...track, duration }).catch(() => null);
    // Backend timing is only trusted when its recording is as long as this audio (±2 s). A YouTube cut with
    // a different length would drift, so then fall through to LRCLIB search for a closer version.
    const timingOk = !!z && (!z.synced || !duration || !z.duration || durationMatches(z.duration, duration));
    if (z && !timingOk) zoyraLate = z;
    if (z && timingOk) {
      const synced = z.synced ? z.lines.map((l) => ({ time: l.time, text: l.text })) : [];
      lyrics = {
        synced,
        plain: (z.plain || synced.map((l) => l.text).join('\n')).split(/\r?\n/),
        instrumental: z.instrumental,
        source: 'exact',
        wordSynced: false,
        timedDuration: z.duration && z.duration > 0 ? z.duration : undefined,
        matchedTitle: z.track ?? undefined,
        matchedArtist: z.artist ?? undefined,
      };
    }
  }

  // 1) Exact match (title + artist + duration) → synced lyrics line up with this audio.
  if (!lyrics && duration > 0) {
    const cleaned = cleanTitle(track.title, track.artist.name);
    const exact =
      (await lrclibGet(track.title, track.artist.name, duration)) ??
      (cleaned !== track.title ? await lrclibGet(cleaned, track.artist.name, duration).catch(() => null) : null);
    if (exact) lyrics = toLyrics(exact, 'exact', durationMatches(exact.duration, duration) || !exact.duration);
  }

  // 2) Search (cleaned title, then the original song behind a remix): the closest length wins and is
  //    synced only when within ±2 s; otherwise the words are kept plain.
  if (!lyrics) {
    let fallback: Lyrics | null = null;
    for (const c of searchCandidates(track).slice(0, MAX_SEARCHES)) {
      const hits = (await lrclibSearch(c.title, c.artist).catch(() => [] as LrclibResponse[])).filter((h) => h.syncedLyrics || h.plainLyrics);
      if (!hits.length) continue;
      const timed = closestByDuration(hits.filter((h) => h.syncedLyrics), duration);
      if (timed && durationMatches(timed.duration, duration)) {
        lyrics = toLyrics(timed, 'exact', true);
        break;
      }
      if (!fallback) {
        const best = closestByDuration(hits, duration) ?? hits[0];
        fallback = { ...toLyrics(best, c.original ? 'original' : 'exact', false), timingMismatch: !c.original && !!best.syncedLyrics };
      }
    }
    lyrics = lyrics ?? fallback;
  }

  // Backend lyrics rejected for timing and nothing better found: keep the words, drop the fake sync.
  if (!lyrics && zoyraLate) {
    lyrics = {
      synced: [],
      plain: (zoyraLate.plain || zoyraLate.lines.map((l) => l.text).join('\n')).split(/\r?\n/),
      instrumental: zoyraLate.instrumental,
      source: 'exact',
      wordSynced: false,
      timingMismatch: zoyraLate.synced,
      matchedTitle: zoyraLate.track ?? undefined,
      matchedArtist: zoyraLate.artist ?? undefined,
    };
  }

  const usable = lyrics && (lyrics.instrumental || lyrics.synced.length || lyrics.plain.some((l) => l.trim())) ? lyrics : null;
  cache.set(key, usable);
  return usable;
}

/**
 * Lyrics as they should be shown against audio that is `audioDuration` seconds long: synced timing
 * made for a different length is dropped (shown plain with `timingMismatch`) instead of drifting.
 */
export function matchToAudio(l: Lyrics, audioDuration: number): Lyrics {
  if (!l.synced.length || !l.timedDuration || !(audioDuration > 0) || durationMatches(l.timedDuration, audioDuration)) return l;
  return { ...l, synced: [], wordSynced: false, timingMismatch: true };
}

/* ------------------------------------------------------------------ translate / romanize */

export type LyricsView = 'original' | LyricsAiMode;

/** The source lines a transform works on: synced line texts when synced, otherwise the plain lines. */
export const sourceLines = (l: Lyrics): string[] => (l.synced.length ? l.synced.map((x) => x.text) : l.plain);

const MAX_AI_LINES = 300;
const aiCache = new Map<string, string[]>();

/**
 * Translated (into `target`) or romanized lines with the same count and order as the source,
 * so `result[i]` replaces line `i` and synced timing still works. Cached per track+mode+target
 * in memory here and server-side in `lyrics_cache`.
 */
export async function transformLyrics(trackId: string, lyrics: Lyrics, mode: LyricsAiMode, target = 'English'): Promise<AiResult<string[]>> {
  const src = sourceLines(lyrics);
  if (src.length > MAX_AI_LINES)
    return {
      ok: false,
      reason: 'error',
      message: 'These lyrics are too long to translate.',
    };
  const key = `${trackId}|${mode}|${mode === 'translate' ? target : ''}|${src.length}`;
  const hit = aiCache.get(key);
  if (hit) return { ok: true, data: hit };
  const res = await lyricsAi(src, mode, { target, trackId });
  if (!res.ok) return res;
  if (res.data.lines.length !== src.length)
    return {
      ok: false,
      reason: 'error',
      message: 'The lyrics came back misaligned. Try again.',
    };
  aiCache.set(key, res.data.lines);
  return { ok: true, data: res.data.lines };
}
