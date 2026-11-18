/**
 * XP, levels, badges and perks — all computed from real data:
 * play_history, the listening_streak RPC, playlists, follows, liked songs, followed artists,
 * user_settings.audio_quality and the achievements table.
 *
 * Perks are only things this app actually grants: cosmetic profile items that the Customize screen
 * unlocks by level (banners and avatar frames). Nothing here promises rewards the app can't give.
 * Level gates are checked in the client; the server doesn't enforce them (cosmetic only).
 */
import { useAsync, type AsyncState, type IconName } from '../components';
import { supabase } from './supabase';

/* ------------------------------------------------------------------ stats */

export type LevelStats = {
  minutes: number;
  plays: number;
  /** Distinct days with at least one play. */
  listeningDays: number;
  /** Days with a play where the day before also had one (each keeps a streak going). */
  streakDays: number;
  currentStreak: number;
  bestStreak: number;
  /** Plays between midnight and 4 am. */
  nightPlays: number;
  /** Plays between 10 pm and 4 am. */
  latePlays: number;
  genres: number;
  topArtistPlays: number;
  playlists: number;
  following: number;
  followers: number;
  liked: number;
  followedArtists: number;
  lossless: boolean;
  achievements: { key: string; unlocked_at: string }[];
};

type HistRow = { played_at: string; seconds_listened: number | null; genre: string | null; artist: string | null };

const dayStart = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const cache = new Map<string, { at: number; stats: LevelStats }>();
const CACHE_MS = 60_000;

/** Load everything the XP and badge rules need. Cached for a minute so the profile screens share one fetch. */
export async function loadLevelStats(userId: string, opts: { fresh?: boolean } = {}): Promise<LevelStats> {
  const hit = cache.get(userId);
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_MS) return hit.stats;

  const count = (table: string, col: string) => supabase.from(table).select(col, { count: 'exact', head: true }).eq(col, userId);
  const [streak, hist, playlists, following, followers, liked, artists, settings, ach] = await Promise.all([
    supabase.rpc('listening_streak', { uid: userId }),
    supabase
      .from('play_history')
      .select('played_at, seconds_listened, genre:track->>genre, artist:track->artist->>name')
      .eq('user_id', userId)
      .order('played_at', { ascending: false })
      .limit(10000),
    count('playlists', 'owner_id'),
    count('follows', 'follower_id'),
    supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', userId),
    count('liked_tracks', 'user_id'),
    count('followed_artists', 'user_id'),
    supabase.from('user_settings').select('audio_quality').eq('user_id', userId).maybeSingle(),
    supabase.from('achievements').select('key, unlocked_at').eq('user_id', userId),
  ]);
  for (const r of [streak, hist, playlists, following, followers, liked, artists]) {
    if (r.error) throw new Error(r.error.message);
  }

  const rows = (hist.data ?? []) as unknown as HistRow[];
  let seconds = 0;
  let nightPlays = 0;
  let latePlays = 0;
  const genres = new Set<string>();
  const byArtist = new Map<string, number>();
  const days = new Set<number>();
  for (const r of rows) {
    const h = new Date(r.played_at).getHours();
    seconds += r.seconds_listened ?? 0;
    if (h < 4) nightPlays++;
    if (h < 4 || h >= 22) latePlays++;
    if (r.genre) genres.add(r.genre);
    if (r.artist) byArtist.set(r.artist, (byArtist.get(r.artist) ?? 0) + 1);
    days.add(dayStart(r.played_at));
  }

  const sorted = [...days].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let streakDays = 0;
  for (let i = 0; i < sorted.length; i++) {
    const consecutive = i > 0 && Math.round((sorted[i] - sorted[i - 1]) / 864e5) === 1;
    run = consecutive ? run + 1 : 1;
    if (consecutive) streakDays++;
    best = Math.max(best, run);
  }
  const current = Number(streak.data) || 0;

  const stats: LevelStats = {
    minutes: Math.round(seconds / 60),
    plays: rows.length,
    listeningDays: days.size,
    streakDays,
    currentStreak: current,
    bestStreak: Math.max(best, current),
    nightPlays,
    latePlays,
    genres: genres.size,
    topArtistPlays: Math.max(0, ...byArtist.values()),
    playlists: playlists.count ?? 0,
    following: following.count ?? 0,
    followers: followers.count ?? 0,
    liked: liked.count ?? 0,
    followedArtists: artists.count ?? 0,
    lossless: (settings.data as { audio_quality?: string } | null)?.audio_quality === 'lossless',
    // The achievements table may be empty or missing rows; it only ever adds to what's computed here.
    achievements: ach.error ? [] : ((ach.data ?? []) as { key: string; unlocked_at: string }[]),
  };
  cache.set(userId, { at: Date.now(), stats });
  return stats;
}

/* ------------------------------------------------------------------ badges */

export type BadgeCategory = 'listening' | 'streak' | 'social' | 'library';

export type Badge = {
  key: string;
  label: string;
  /** How to earn it, shown under locked badges. */
  hint: string;
  icon: IconName;
  category: BadgeCategory;
  value: number;
  goal: number;
  unlocked: boolean;
};

type BadgeRule = Omit<Badge, 'value' | 'unlocked'> & { value: (s: LevelStats) => number };

const BADGE_RULES: BadgeRule[] = [
  { key: 'night_owl', label: 'Night Owl', hint: '10 plays after midnight', icon: 'moon', category: 'listening', goal: 10, value: (s) => s.nightPlays },
  { key: 'songs_1000', label: '1000 songs', hint: 'Play 1,000 songs', icon: 'play', category: 'listening', goal: 1000, value: (s) => s.plays },
  { key: 'streak_7', label: '7 day streak', hint: 'Listen 7 days in a row', icon: 'flame', category: 'streak', goal: 7, value: (s) => s.bestStreak },
  { key: 'streak_30', label: '30 day streak', hint: 'Listen 30 days in a row', icon: 'flame', category: 'streak', goal: 30, value: (s) => s.bestStreak },
  { key: 'top_fan', label: 'Top fan', hint: '50 plays of one artist', icon: 'star', category: 'listening', goal: 50, value: (s) => s.topArtistPlays },
  { key: 'playlist_pro', label: 'Playlist pro', hint: 'Make 5 playlists', icon: 'music', category: 'library', goal: 5, value: (s) => s.playlists },
  { key: 'explorer', label: 'Explorer', hint: 'Play 5 genres', icon: 'globe', category: 'listening', goal: 5, value: (s) => s.genres },
  { key: 'social_star', label: 'Social star', hint: '100 followers', icon: 'users', category: 'social', goal: 100, value: (s) => s.followers },
  { key: 'connector', label: 'Connector', hint: 'Follow 10 people', icon: 'user', category: 'social', goal: 10, value: (s) => s.following },
  { key: 'audiophile', label: 'Audiophile', hint: 'Use Lossless', icon: 'speaker', category: 'listening', goal: 1, value: (s) => (s.lossless ? 1 : 0) },
  { key: 'night_shift', label: 'Night shift', hint: '50 late plays', icon: 'clock', category: 'listening', goal: 50, value: (s) => s.latePlays },
  { key: 'collector', label: 'Collector', hint: 'Like 100 songs', icon: 'heart', category: 'library', goal: 100, value: (s) => s.liked },
  { key: 'artist_scout', label: 'Artist scout', hint: 'Follow 10 artists', icon: 'bolt', category: 'library', goal: 10, value: (s) => s.followedArtists },
];

const humanize = (key: string) => {
  const t = key.replace(/[_-]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Achievement';
};

export function badgesFor(s: LevelStats): Badge[] {
  const computed = BADGE_RULES.map(({ value, ...b }) => {
    const v = value(s);
    return { ...b, value: v, unlocked: v >= b.goal };
  });
  const known = new Set(computed.map((b) => b.key));
  // Anything recorded server-side in `achievements` that isn't a computed badge is shown as earned.
  const extra: Badge[] = s.achievements
    .filter((a) => !known.has(a.key))
    .map((a) => ({ key: a.key, label: humanize(a.key), hint: 'Special achievement', icon: 'trophy', category: 'listening', goal: 1, value: 1, unlocked: true }));
  for (const b of computed) if (!b.unlocked && s.achievements.some((a) => a.key === b.key)) b.unlocked = true;
  return [...computed, ...extra];
}

/* ------------------------------------------------------------------ XP */

export type XpRule = { key: string; label: string; detail: string; icon: IconName; xp: number; times: number; earned: number };

/** How XP is earned. `times` is how often you've done it so far. */
export function xpRules(s: LevelStats, badges: Badge[] = badgesFor(s)): XpRule[] {
  const rules: Omit<XpRule, 'earned'>[] = [
    { key: 'listen', label: 'Listen for 30 minutes', detail: 'Every 30 minutes you play', icon: 'clock', xp: 20, times: Math.floor(s.minutes / 30) },
    { key: 'streak', label: 'Keep a daily streak', detail: 'Each day you listen two days running', icon: 'flame', xp: 30, times: s.streakDays },
    { key: 'playlist', label: 'Create a playlist', detail: 'Each playlist you make', icon: 'music', xp: 15, times: s.playlists },
    { key: 'follow', label: 'Follow a friend', detail: 'Up to 50 people', icon: 'users', xp: 10, times: Math.min(s.following, 50) },
    { key: 'badge', label: 'Unlock a badge', detail: 'Each badge you earn', icon: 'trophy', xp: 50, times: badges.filter((b) => b.unlocked).length },
  ];
  return rules.map((r) => ({ ...r, earned: r.xp * r.times }));
}

export const totalXp = (rules: XpRule[]) => rules.reduce((n, r) => n + r.earned, 0);

/** XP needed to go from `level` to `level + 1`. */
const stepFor = (level: number) => 100 + 25 * (level - 1);

/** Total XP needed to reach `level`. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) total += stepFor(l);
  return total;
}

const TITLES: { from: number; title: string }[] = [
  { from: 1, title: 'Fresh Ears' },
  { from: 3, title: 'Crate Digger' },
  { from: 6, title: 'Playlist Pilot' },
  { from: 10, title: 'Groove Master' },
  { from: 15, title: 'Sound Surfer' },
  { from: 16, title: 'Beat Keeper' },
  { from: 18, title: 'Vibe Architect' },
  { from: 20, title: 'Zoyra Legend' },
];

export function titleFor(level: number): string {
  let t = TITLES[0].title;
  for (const x of TITLES) if (level >= x.from) t = x.title;
  return t;
}

export type LevelInfo = {
  xp: number;
  level: number;
  title: string;
  /** XP at the start of this level. */
  floor: number;
  /** XP needed for the next level. */
  next: number;
  nextTitle: string;
  /** 0..1 progress to the next level. */
  progress: number;
};

export function levelFor(xp: number): LevelInfo {
  let level = 1;
  while (xp >= xpForLevel(level + 1)) level++;
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  return { xp, level, title: titleFor(level), floor, next, nextTitle: titleFor(level + 1), progress: (xp - floor) / (next - floor) };
}

/* ------------------------------------------------------------------ perks */

/** Real, app-granted perks: cosmetic profile items unlocked in Customize. */
export type Perk = { level: number; label: string; detail: string; banners?: string[]; frames?: string[] };

export const PERKS: Perk[] = [
  { level: 1, label: 'Gradient avatars', detail: 'Six gradient avatars, two banners and the glow frame', banners: ['coral', 'violet'], frames: ['glow', 'none'] },
  { level: 3, label: 'Full banner pack', detail: 'All six profile banners', banners: ['rose', 'amber', 'blue', 'green'] },
  { level: 5, label: 'Sunset frame', detail: 'Amber to rose avatar frame', frames: ['sunset'] },
  { level: 10, label: 'Mint frame', detail: 'Green to blue avatar frame', frames: ['mint'] },
  { level: 15, label: 'Rainbow frame', detail: 'Every colour of the palette', frames: ['rainbow'] },
  { level: 20, label: 'Legend gold ring', detail: 'A gold avatar ring for Zoyra Legends', frames: ['gold'] },
];

export const bannerUnlockLevel = (key: string) => PERKS.find((p) => p.banners?.includes(key))?.level ?? 1;
export const frameUnlockLevel = (key: string) => PERKS.find((p) => p.frames?.includes(key))?.level ?? 1;

/* ------------------------------------------------------------------ hook */

export type Progress = { stats: LevelStats; badges: Badge[]; rules: XpRule[]; level: LevelInfo };

export function computeProgress(stats: LevelStats): Progress {
  const badges = badgesFor(stats);
  const rules = xpRules(stats, badges);
  return { stats, badges, rules, level: levelFor(totalXp(rules)) };
}

/** XP, level and badges for a user (null while signed out). */
export function useProgress(userId: string | undefined): AsyncState<Progress | null> {
  return useAsync(async () => (userId ? computeProgress(await loadLevelStats(userId)) : null), [userId]);
}
