/**
 * Games: Beat Rush (rhythm tap game) helpers and the `game_scores` table
 * (migration 20261114161000_games_community.sql).
 *
 * Beat markers come from the BPM Audius reports for a track. Audius gives no beat offset (where the
 * first beat falls), so markers start on a fixed grid from 0:00 and sync is approximate.
 * Scores are computed on the device; the server only sanity-checks them.
 */
import { catalog, type CatalogTrack } from './catalog';
import { filterHidden } from './content-filter';
import { supabase } from './supabase';
import { fetchBpms } from './workout';

export type GameKey = 'beat' | 'quiz';

export const GAME_LABEL: Record<GameKey, string> = { beat: 'Beat Rush', quiz: 'Song guess' };

/* ------------------------------------------------------------------ Beat Rush tuning */

export const LANES = 4;
/** Seconds a note takes to fall from the top of the lane to the hit line. */
export const LEAD = 1.6;
/** Timing windows (seconds, either side of the beat). */
export const PERFECT_WINDOW = 0.07;
export const GOOD_WINDOW = 0.15;
/** Round length cap, so a game is ~90 seconds even on long tracks. */
export const ROUND_SECONDS = 90;
/** First note after this many seconds (time to get ready). */
const FIRST_NOTE = 3;

export type Judgement = 'perfect' | 'good' | 'miss';
export type Note = { id: number; time: number; lane: number };

export const POINTS: Record<Judgement, number> = { perfect: 300, good: 100, miss: 0 };

/** Score multiplier from the current combo: x1, then +1 every 10 hits, up to x4. */
export const multiplierFor = (combo: number) => Math.min(4, 1 + Math.floor(combo / 10));

/** Small deterministic PRNG so the same track always gives the same chart. */
function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Notes on the BPM grid. Fast songs (over ~130 BPM) put a note every other beat so it stays playable;
 * a few beats are skipped at random for rhythm variety. Lanes avoid repeating more than twice.
 */
export function buildChart(trackId: string, bpm: number, duration: number): Note[] {
  const rand = seeded(trackId);
  const beat = 60 / bpm;
  const step = bpm > 130 ? beat * 2 : beat;
  const end = Math.min(duration - 1, ROUND_SECONDS);
  const notes: Note[] = [];
  let last = -1;
  let repeats = 0;
  for (let t = FIRST_NOTE, n = 0; t <= end; t += step, n++) {
    if (n > 3 && rand() < 0.15) continue;
    let lane = Math.floor(rand() * LANES);
    if (lane === last && ++repeats >= 2) {
      lane = (lane + 1 + Math.floor(rand() * (LANES - 1))) % LANES;
      repeats = 0;
    } else if (lane !== last) repeats = 0;
    last = lane;
    notes.push({ id: notes.length, time: Math.round(t * 1000) / 1000, lane });
  }
  return notes;
}

export const roundLength = (duration: number) => Math.min(duration - 1, ROUND_SECONDS);

/** How a tap at `delta` seconds from a note is judged (null = too far to count as that note). */
export function judge(delta: number): Judgement | null {
  const d = Math.abs(delta);
  if (d <= PERFECT_WINDOW) return 'perfect';
  if (d <= GOOD_WINDOW) return 'good';
  return null;
}

/** Accuracy 0..1: perfect = 1, good = 0.5, miss = 0. */
export const accuracyOf = (c: { perfect: number; good: number; miss: number }) => {
  const total = c.perfect + c.good + c.miss;
  return total ? (c.perfect + c.good * 0.5) / total : 0;
};

/* ------------------------------------------------------------------ track picks */

export type BeatTrack = { track: CatalogTrack; bpm: number };

/** Trending Audius tracks that report a usable BPM (60-200), hidden songs and artists removed. */
export async function loadBeatTracks(genre?: string): Promise<BeatTrack[]> {
  const pool = filterHidden(await catalog.trending({ genre, limit: 60 })).filter((t) => t.duration >= 45);
  const bpms = await fetchBpms(pool.map((t) => t.id));
  const out: BeatTrack[] = [];
  for (const t of pool) {
    const b = bpms.get(t.id);
    if (b && b >= 60 && b <= 200) out.push({ track: t, bpm: Math.round(b * 10) / 10 });
  }
  return out;
}

/* ------------------------------------------------------------------ scores */

export type GameScore = {
  id: string;
  user_id: string;
  game: GameKey;
  score: number;
  accuracy: number | null;
  max_combo: number;
  perfect: number;
  good: number;
  miss: number;
  track_id: string | null;
  track: { title?: string; artist?: string } | null;
  created_at: string;
};

export type ScoreWithPlayer = GameScore & { display_name: string; avatar_url: string | null };

function friendly(e: { message: string }, fallback: string) {
  if (/game_scores/.test(e.message) && /does not exist|schema cache/i.test(e.message)) return 'Game scores aren’t set up on the server yet.';
  return e.message || fallback;
}

export async function saveScore(s: {
  game: GameKey;
  score: number;
  accuracy: number;
  maxCombo: number;
  perfect: number;
  good: number;
  miss: number;
  track?: CatalogTrack;
}): Promise<void> {
  const { error } = await supabase.from('game_scores').insert({
    game: s.game,
    score: Math.max(0, Math.round(s.score)),
    accuracy: Math.max(0, Math.min(1, s.accuracy)),
    max_combo: s.maxCombo,
    perfect: s.perfect,
    good: s.good,
    miss: s.miss,
    track_id: s.track?.id ?? null,
    track: s.track ? { title: s.track.title, artist: s.track.artist.name } : null,
  });
  if (error) throw new Error(friendly(error, 'Could not save your score'));
}

/** Your best score per game (games you haven't played are missing). */
export async function personalBests(userId: string): Promise<Partial<Record<GameKey, GameScore>>> {
  const { data, error } = await supabase.from('game_scores').select('*').eq('user_id', userId).order('score', { ascending: false }).limit(200);
  if (error) throw new Error(friendly(error, 'Could not load your scores'));
  const out: Partial<Record<GameKey, GameScore>> = {};
  for (const r of (data ?? []) as GameScore[]) if (!out[r.game]) out[r.game] = r;
  return out;
}

export async function playedToday(userId: string, game: GameKey): Promise<number> {
  const d = new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const { count, error } = await supabase.from('game_scores').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('game', game).gte('created_at', start);
  if (error) throw new Error(friendly(error, 'Could not load your games'));
  return count ?? 0;
}

/** Top scores for a game, best per player. */
export async function topScores(game: GameKey, limit = 10): Promise<ScoreWithPlayer[]> {
  const { data, error } = await supabase
    .from('game_scores')
    .select('*, profiles(display_name, avatar_url)')
    .eq('game', game)
    .order('score', { ascending: false })
    .limit(200);
  if (error) throw new Error(friendly(error, 'Could not load top scores'));
  type Row = GameScore & { profiles: { display_name: string; avatar_url: string | null } | null };
  const seen = new Set<string>();
  const out: ScoreWithPlayer[] = [];
  for (const r of (data ?? []) as unknown as Row[]) {
    if (seen.has(r.user_id)) continue;
    seen.add(r.user_id);
    const { profiles, ...rest } = r;
    out.push({ ...rest, display_name: profiles?.display_name ?? 'Listener', avatar_url: profiles?.avatar_url ?? null });
    if (out.length >= limit) break;
  }
  return out;
}
