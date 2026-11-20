/**
 * Music catalogue layer.
 *
 * The app only talks to this module, never to a provider directly, so the source can be swapped
 * (Audius today; a licensed B2B catalogue or Apple Music later) without touching screens.
 *
 * Audius: open, artist-uploaded catalogue with a free public API and legal full-track streaming.
 * https://docs.audius.org/developers/api
 */

import { isZoyraArtistId, isZoyraId, zoyra, zoyraEnabled } from './zoyra-api';

const BASE = 'https://api.audius.co/v1';
const APP = 'zoyra';

/* ------------------------------------------------------------------ normalized types */

export type Artwork = { small?: string; medium?: string; large?: string };

export type Artist = {
  id: string;
  name: string;
  handle: string;
  verified: boolean;
  followers: number;
  trackCount?: number;
  bio?: string;
  location?: string;
  image: Artwork;
  cover?: string;
};

export type CatalogTrack = {
  id: string;
  /** Direct public stream URL for non-Audius items (e.g. LibriVox audiobook chapters). */
  streamUrl?: string;
  title: string;
  artist: Pick<Artist, 'id' | 'name' | 'handle' | 'verified'> & { image?: string };
  duration: number; // seconds
  genre?: string;
  mood?: string;
  artwork: Artwork;
  plays: number;
  likes: number;
  releaseDate?: string;
  tags?: string[];
  /** Public web page for the track (used for share links). */
  url?: string;
  /** Artist-set parental warning (`parental_warning_type === 'explicit'`); rarely set on Audius. */
  explicit?: boolean;
};

export type Collection = {
  id: string;
  title: string;
  description: string;
  isAlbum: boolean;
  artist: Pick<Artist, 'id' | 'name' | 'handle'>;
  artwork: Artwork;
  trackCount: number;
  plays: number;
  releaseDate?: string;
};

export const GENRES = [
  'Electronic',
  'Hip-Hop/Rap',
  'Pop',
  'Lo-Fi',
  'R&B/Soul',
  'Alternative',
  'Ambient',
  'House',
  'Rock',
  'Jazz',
  'Classical',
  'World',
  'Acoustic',
  'Latin',
  'Techno',
  'Folk',
] as const;

export const MOODS = ['Peaceful', 'Romantic', 'Sentimental', 'Tender', 'Easygoing', 'Yearning', 'Sophisticated', 'Sensual', 'Cool', 'Gritty', 'Melancholy', 'Serious', 'Brooding', 'Fiery', 'Defiant', 'Aggressive', 'Rowdy', 'Excited', 'Energizing', 'Empowering', 'Stirring', 'Upbeat', 'Other'] as const;

/** UI mood chips → catalogue moods. */
export const MOOD_MAP: Record<string, string[]> = {
  Chill: ['Peaceful', 'Easygoing', 'Cool'],
  Focus: ['Peaceful', 'Sophisticated', 'Serious'],
  Workout: ['Energizing', 'Aggressive', 'Empowering'],
  Sleep: ['Peaceful', 'Tender'],
  Happy: ['Upbeat', 'Excited'],
  Party: ['Rowdy', 'Excited', 'Energizing'],
  Sad: ['Melancholy', 'Sentimental', 'Yearning'],
  Romantic: ['Romantic', 'Sensual', 'Tender'],
};

/* ------------------------------------------------------------------ raw API shapes (subset) */

type RawImg = Partial<Record<'150x150' | '480x480' | '1000x1000', string>> | null | undefined;
type RawUser = {
  id: string;
  name: string;
  handle: string;
  is_verified: boolean;
  follower_count: number;
  track_count?: number;
  bio?: string | null;
  location?: string | null;
  profile_picture?: RawImg;
  cover_photo?: Partial<Record<'640x' | '2000x', string>> | null;
};
type RawTrack = {
  id: string;
  title: string;
  user: RawUser;
  duration: number;
  genre?: string | null;
  mood?: string | null;
  artwork?: RawImg;
  play_count?: number;
  favorite_count?: number;
  release_date?: string | null;
  tags?: string | null;
  is_streamable?: boolean;
  is_stream_gated?: boolean;
  is_delete?: boolean;
  permalink?: string;
  parental_warning_type?: string | null;
};
type RawPlaylist = {
  id: string;
  playlist_name: string;
  description?: string | null;
  is_album: boolean;
  user: RawUser;
  artwork?: RawImg;
  track_count?: number;
  total_play_count?: number;
  release_date?: string | null;
};

/* ------------------------------------------------------------------ mapping */

const img = (a: RawImg): Artwork => ({ small: a?.['150x150'], medium: a?.['480x480'], large: a?.['1000x1000'] });

export const toArtist = (u: RawUser): Artist => ({
  id: u.id,
  name: u.name,
  handle: u.handle,
  verified: u.is_verified,
  followers: u.follower_count,
  trackCount: u.track_count,
  bio: u.bio ?? undefined,
  location: u.location ?? undefined,
  image: img(u.profile_picture),
  cover: u.cover_photo?.['2000x'] ?? u.cover_photo?.['640x'],
});

const toTrack = (t: RawTrack): CatalogTrack => ({
  id: t.id,
  title: t.title.trim(),
  artist: { id: t.user.id, name: t.user.name, handle: t.user.handle, verified: t.user.is_verified, image: t.user.profile_picture?.['150x150'] },
  duration: t.duration,
  genre: t.genre ?? undefined,
  mood: t.mood ?? undefined,
  explicit: t.parental_warning_type === 'explicit',
  artwork: img(t.artwork),
  plays: t.play_count ?? 0,
  likes: t.favorite_count ?? 0,
  releaseDate: t.release_date ?? undefined,
  tags: t.tags ? t.tags.split(',').filter(Boolean) : undefined,
  url: t.permalink ? `https://audius.co${t.permalink}` : undefined,
});

const toCollection = (p: RawPlaylist): Collection => ({
  id: p.id,
  title: p.playlist_name,
  description: p.description ?? '',
  isAlbum: p.is_album,
  artist: { id: p.user.id, name: p.user.name, handle: p.user.handle },
  artwork: img(p.artwork),
  trackCount: p.track_count ?? 0,
  plays: p.total_play_count ?? 0,
  releaseDate: p.release_date ?? undefined,
});

/** Only tracks anyone can stream for free (skip deleted / pay-gated ones). */
const playable = (t: RawTrack) => t.is_streamable !== false && !t.is_stream_gated && !t.is_delete;

/* ------------------------------------------------------------------ fetch with small in-memory cache */

const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 5 * 60 * 1000;

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams({ app_name: APP });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const url = `${BASE}${path}?${qs.toString()}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Catalogue request failed (${res.status})`);
  const json = (await res.json()) as { data: T };
  cache.set(url, { at: Date.now(), data: json.data });
  return json.data;
}

/* ------------------------------------------------------------------ public API */

export type TimeRange = 'week' | 'month' | 'year' | 'allTime';

export const catalog = {
  async trending(opts: { genre?: string; time?: TimeRange; limit?: number } = {}) {
    // Plain "popular now" comes from the Zoyra backend; genre-specific charts stay on Audius.
    if (zoyraEnabled && !opts.genre) {
      try {
        const songs = await zoyra.popular('popular', opts.limit ?? 30);
        if (songs.length) return songs;
      } catch (e) {
        console.warn('Zoyra popular failed, using Audius', e);
      }
    }
    const raw = await get<RawTrack[]>('/tracks/trending', { genre: opts.genre, time: opts.time ?? 'week', limit: opts.limit ?? 30 });
    return raw.filter(playable).map(toTrack);
  },
  async underground(limit = 20) {
    const raw = await get<RawTrack[]>('/tracks/trending/underground', { limit });
    return raw.filter(playable).map(toTrack);
  },
  async searchTracks(query: string, opts: { genre?: string; mood?: string; limit?: number } = {}) {
    if (!query.trim()) return [];
    // Song search goes to the Zoyra backend; genre/mood filters (and podcasts) stay on Audius,
    // and Audius is also the fallback when the backend is down or asleep.
    if (zoyraEnabled && !opts.genre && !opts.mood) {
      try {
        const songs = await zoyra.searchTracks(query, opts.limit ?? 25);
        if (songs.length) return songs;
      } catch (e) {
        console.warn('Zoyra search failed, using Audius', e);
      }
    }
    const raw = await get<RawTrack[]>('/tracks/search', { query, genre: opts.genre, mood: opts.mood, limit: opts.limit ?? 25 });
    return raw.filter(playable).map(toTrack);
  },
  async searchArtists(query: string, limit = 15) {
    if (!query.trim()) return [];
    const raw = await get<RawUser[]>('/users/search', { query, limit });
    return raw.map(toArtist);
  },
  async searchCollections(query: string, limit = 15) {
    if (!query.trim()) return [];
    const raw = await get<RawPlaylist[]>('/playlists/search', { query, limit });
    return raw.map(toCollection);
  },
  async track(id: string) {
    if (isZoyraId(id)) return zoyra.track(id);
    return toTrack(await get<RawTrack>(`/tracks/${id}`));
  },
  async artist(id: string) {
    if (isZoyraArtistId(id)) return zoyra.artist(id);
    return toArtist(await get<RawUser>(`/users/${id}`));
  },
  async artistTracks(id: string, limit = 20, sort: 'plays' | 'date' = 'plays') {
    if (isZoyraArtistId(id)) return zoyra.artistTracks(id, limit);
    const raw = await get<RawTrack[]>(`/users/${id}/tracks`, { limit, sort: sort === 'plays' ? 'plays' : 'date' });
    return raw.filter(playable).map(toTrack);
  },
  async artistCollections(id: string, limit = 20) {
    if (isZoyraArtistId(id)) return [] as Collection[];
    const raw = await get<RawPlaylist[]>(`/users/${id}/albums`, { limit }).catch(() => [] as RawPlaylist[]);
    return raw.map(toCollection);
  },
  async relatedArtists(id: string, limit = 10) {
    if (isZoyraArtistId(id)) return [] as Artist[];
    const raw = await get<RawUser[]>(`/users/${id}/related`, { limit });
    return raw.map(toArtist);
  },
  async trendingCollections(limit = 20) {
    const raw = await get<RawPlaylist[]>('/playlists/trending', { limit });
    return raw.map(toCollection);
  },
  async collection(id: string) {
    const raw = await get<RawPlaylist[]>(`/playlists/${id}`);
    return toCollection(raw[0]);
  },
  async collectionTracks(id: string) {
    const raw = await get<RawTrack[]>(`/playlists/${id}/tracks`);
    return raw.filter(playable).map(toTrack);
  },
  /** Mood mixes: catalogue search filtered by mood. */
  async byMood(uiMood: string, limit = 25) {
    const moods = MOOD_MAP[uiMood] ?? [uiMood];
    const lists = await Promise.all(moods.map((m) => get<RawTrack[]>('/tracks/trending', { limit: 50 }).then((r) => r.filter((t) => t.mood === m))));
    const seen = new Set<string>();
    return lists
      .flat()
      .filter(playable)
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .slice(0, limit)
      .map(toTrack);
  },
  /** Direct audio URL (302 → signed CDN stream). */
  streamUrl(trackId: string) {
    if (isZoyraId(trackId)) return zoyra.streamUrl(trackId);
    return `${BASE}/tracks/${trackId}/stream?app_name=${APP}`;
  },
  /** URL to save for offline play. Zoyra songs download as a server-converted mp3. */
  downloadUrl(trackId: string) {
    return isZoyraId(trackId) ? zoyra.downloadUrl(trackId) : catalog.streamUrl(trackId);
  },
  shareUrl(track: CatalogTrack) {
    return track.url ?? `https://audius.co/${track.artist.handle}`;
  },
};

export const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const formatCount = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n);
