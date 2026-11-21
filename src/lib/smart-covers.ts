import type { Artwork, CatalogTrack } from './catalog';
import { supabase } from './supabase';

const DAY = 864e5;

/**
 * One cover per smart playlist on the Library tab: the artwork of the first song that list actually opens with
 * (same rules as the playlist screen), so the picture matches what is inside. A missing entry = nothing to show yet.
 */
export async function loadSmartCovers(uid: string, liked: CatalogTrack[]): Promise<Partial<Record<'week' | 'rediscover' | 'short', Artwork>>> {
  const since7 = new Date(Date.now() - 7 * DAY).toISOString();
  const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
  const [week, old, recent] = await Promise.all([
    supabase.from('liked_tracks').select('track').eq('user_id', uid).gte('created_at', since7).order('created_at', { ascending: false }).limit(1),
    supabase.from('play_history').select('track_id, track').eq('user_id', uid).lt('played_at', cutoff).order('played_at', { ascending: false }).limit(80),
    supabase.from('play_history').select('track_id').eq('user_id', uid).gte('played_at', cutoff).limit(1000),
  ]);

  const out: Partial<Record<'week' | 'rediscover' | 'short', Artwork>> = {};
  const w = ((week.data ?? []) as { track: CatalogTrack }[])[0]?.track;
  if (w?.artwork) out.week = w.artwork;

  const recentIds = new Set(((recent.data ?? []) as { track_id: string }[]).map((x) => x.track_id));
  const r = ((old.data ?? []) as { track_id: string; track: CatalogTrack }[]).find((x) => !recentIds.has(x.track_id));
  if (r?.track.artwork) out.rediscover = r.track.artwork;

  const short = liked.find((t) => t.duration > 0 && t.duration < 180);
  if (short?.artwork) out.short = short.artwork;
  return out;
}
