/**
 * Zoyra Radio: endless stations built from the Audius catalogue (no third-party radio streams).
 *
 * A station is a seed (genre, mood, artist or the listener's own history). Starting one plays a
 * first batch through the player with the context `radio:<stationId>`; `useRadioTopUp()` watches
 * the player and appends the next batch when the queue nears its end, so the station never stops.
 */
import { useEffect } from 'react';

import { usePlayer, usePlayerPick } from '../state/player';
import { catalog, MOOD_MAP, type Artwork, type CatalogTrack, type TimeRange } from './catalog';
import { filterHidden } from './content-filter';
import { supabase } from './supabase';

export type StationKind = 'genre' | 'mood' | 'artist' | 'mix';

export type Station = {
  /** Stable id, e.g. `genre:Lo-Fi`, `mood:Chill`, `artist:<audiusId>`, `mix:<userId>`. */
  id: string;
  kind: StationKind;
  title: string;
  subtitle: string;
  /** Genre name, UI mood key, Audius artist id, or user id (mix). */
  seed: string;
  artwork?: Artwork;
  image?: string;
};

export const RADIO_CONTEXT_PREFIX = 'radio:';
/** Tracks per batch. */
const BATCH = 15;
/** Top up when this many (or fewer) songs are left after the current one. */
const LOW_WATER = 3;
/** Recently played ids we avoid repeating; older ones may come back (endless stations). */
const MEMORY = 120;

export const contextFor = (s: Station) => `${RADIO_CONTEXT_PREFIX}${s.id}`;
export const isRadioContext = (ctx: string | null | undefined) => !!ctx && ctx.startsWith(RADIO_CONTEXT_PREFIX);

export const genreStation = (genre: string): Station => ({ id: `genre:${genre}`, kind: 'genre', title: `${genre} Radio`, subtitle: `Endless ${genre}`, seed: genre });
export const moodStation = (mood: string): Station => ({ id: `mood:${mood}`, kind: 'mood', title: `${mood} Radio`, subtitle: `Songs that feel ${mood.toLowerCase()}`, seed: mood });
export const artistStation = (a: { id: string; name: string; image?: string }): Station => ({
  id: `artist:${a.id}`,
  kind: 'artist',
  title: `${a.name} Radio`,
  subtitle: `${a.name} and similar artists`,
  seed: a.id,
  image: a.image,
});
export const mixStation = (userId: string): Station => ({ id: `mix:${userId}`, kind: 'mix', title: 'Your Mix Radio', subtitle: 'Built from what you play', seed: userId });

/* ------------------------------------------------------------------ helpers */

const shuffle = <T>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** Random order that avoids the same artist twice in a row where possible. */
function spread(tracks: CatalogTrack[]): CatalogTrack[] {
  const pool = shuffle(tracks);
  const out: CatalogTrack[] = [];
  while (pool.length) {
    const last = out[out.length - 1];
    const i = pool.findIndex((t) => !last || t.artist.id !== last.artist.id);
    out.push(pool.splice(i === -1 ? 0 : i, 1)[0]);
  }
  return out;
}

const safe = (p: Promise<CatalogTrack[]>) => p.catch(() => [] as CatalogTrack[]);
const TIMES: TimeRange[] = ['week', 'month', 'year', 'allTime'];

type HistoryRow = { track: CatalogTrack | null };

/** Top artists and genres in the listener's recent play history. */
export async function historySeeds(userId: string): Promise<{ artists: { id: string; name: string; image?: string }[]; genres: string[]; ids: Set<string> }> {
  const { data, error } = await supabase.from('play_history').select('track').eq('user_id', userId).order('played_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as HistoryRow[];
  const artistCount = new Map<string, { id: string; name: string; image?: string; n: number }>();
  const genreCount = new Map<string, number>();
  const ids = new Set<string>();
  for (const r of rows) {
    const t = r.track;
    if (!t?.id || !t.artist?.id || t.id.startsWith('local:')) continue;
    ids.add(t.id);
    const a = artistCount.get(t.artist.id) ?? { id: t.artist.id, name: t.artist.name, image: t.artist.image, n: 0 };
    a.n += 1;
    artistCount.set(t.artist.id, a);
    if (t.genre) genreCount.set(t.genre, (genreCount.get(t.genre) ?? 0) + 1);
  }
  const artists = [...artistCount.values()].sort((a, b) => b.n - a.n).map(({ id, name, image }) => ({ id, name, image }));
  const genres = [...genreCount.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
  return { artists, genres, ids };
}

/** Raw candidates for one batch of a station. `page` rotates the sources so later batches differ. */
async function candidates(s: Station, page: number): Promise<CatalogTrack[]> {
  switch (s.kind) {
    case 'genre': {
      const time = TIMES[page % TIMES.length];
      const [trend, found] = await Promise.all([safe(catalog.trending({ genre: s.seed, time, limit: 50 })), page > 0 ? safe(catalog.searchTracks(s.seed, { genre: s.seed, limit: 40 })) : Promise.resolve([])]);
      return [...trend, ...found];
    }
    case 'mood': {
      const moods = MOOD_MAP[s.seed] ?? [s.seed];
      const mood = moods[page % moods.length];
      const [byMood, found] = await Promise.all([safe(catalog.byMood(s.seed, 40)), safe(catalog.searchTracks(s.seed.toLowerCase(), { mood, limit: 40 }))]);
      return [...byMood, ...found];
    }
    case 'artist': {
      const related = await catalog.relatedArtists(s.seed, 12).catch(() => []);
      const picks = shuffle(related).slice(0, 4);
      const lists = await Promise.all([
        // The seed artist on the first batch and every third one after.
        page % 3 === 0 ? safe(catalog.artistTracks(s.seed, 20, page % 2 === 0 ? 'plays' : 'date')) : Promise.resolve([]),
        ...picks.map((a) => safe(catalog.artistTracks(a.id, 8))),
      ]);
      return lists.flat();
    }
    case 'mix': {
      const seeds = await historySeeds(s.seed);
      if (!seeds.artists.length && !seeds.genres.length) throw new Error('Play a few songs first, then Your Mix can learn what you like.');
      const artists = shuffle(seeds.artists.slice(0, 8)).slice(0, 3);
      const genres = shuffle(seeds.genres.slice(0, 4)).slice(0, 2);
      const relatedLists = await Promise.all(artists.map((a) => catalog.relatedArtists(a.id, 6).catch(() => [])));
      const relatedPicks = shuffle(relatedLists.flat()).slice(0, 4);
      const lists = await Promise.all([
        ...artists.map((a) => safe(catalog.artistTracks(a.id, 6))),
        ...relatedPicks.map((a) => safe(catalog.artistTracks(a.id, 6))),
        ...genres.map((g) => safe(catalog.trending({ genre: g, time: TIMES[page % TIMES.length], limit: 30 }))),
      ]);
      return lists.flat();
    }
  }
}

/* ------------------------------------------------------------------ live station state (module) */

type Live = { station: Station; page: number; seen: string[]; busy: boolean };
let live: Live | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const radioState = {
  current: (): Station | null => live?.station ?? null,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/** Next batch for a station, skipping recently played and hidden songs. */
export async function nextBatch(s: Station, page: number, avoid: Iterable<string>): Promise<CatalogTrack[]> {
  const skip = new Set(avoid);
  const seen = new Set<string>();
  const raw = await candidates(s, page);
  const fresh = filterHidden(raw).filter((t) => (skip.has(t.id) || seen.has(t.id) ? false : (seen.add(t.id), true)));
  if (fresh.length) return spread(fresh).slice(0, BATCH);
  // Everything was played recently: let older songs come back rather than stopping.
  const again = filterHidden(raw).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  return spread(again).slice(0, BATCH);
}

type PlayFn = ReturnType<typeof usePlayer>['playTracks'];

/** Starts a station: loads its first batch and plays it. Returns a message when nothing could play. */
export async function startStation(s: Station, playTracks: PlayFn): Promise<{ ok: boolean; text: string }> {
  const batch = await nextBatch(s, 0, []);
  if (!batch.length) return { ok: false, text: `No playable songs found for ${s.title} right now.` };
  const res = playTracks(batch, 0, contextFor(s));
  if (!res.played) return { ok: false, text: res.reason ?? 'Could not start the station.' };
  live = { station: s, page: 1, seen: batch.map((t) => t.id), busy: false };
  emit();
  return { ok: true, text: `${s.title} is on` };
}

/** Stops topping up (the songs already queued keep playing). */
export function stopStation() {
  live = null;
  emit();
}

/**
 * Keeps the running station endless. Mount once inside `<PlayerProvider>` (e.g. in the root
 * layout); mounting it more than once is harmless. It does nothing unless a station is playing.
 */
export function useRadioTopUp() {
  const { context, queue, index, addToQueue } = usePlayerPick('queue', 'index', 'context');
  useEffect(() => {
    const st = live;
    if (!st) return;
    // The listener started something else: the station is over.
    if (context !== contextFor(st.station)) {
      stopStation();
      return;
    }
    const left = queue.length - 1 - index;
    if (left > LOW_WATER || st.busy) return;
    st.busy = true;
    const inQueue = queue.map((t) => t.id);
    void nextBatch(st.station, st.page, [...st.seen, ...inQueue])
      .then((batch) => {
        if (live !== st) return;
        batch.forEach((t) => addToQueue(t));
        st.page += 1;
        st.seen = [...st.seen, ...batch.map((t) => t.id)].slice(-MEMORY);
      })
      .catch(() => {
        // Network hiccup: try again on the next track change.
      })
      .finally(() => {
        st.busy = false;
      });
  }, [context, queue, index, addToQueue]);
}
