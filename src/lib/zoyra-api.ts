/**
 * Zoyra backend (FastAPI on Render): song search, audio stream, mp3 download and lyrics.
 * Songs from here use ids prefixed with `yt_` so the rest of the app can tell them apart from Audius ids.
 *
 * Set EXPO_PUBLIC_ZOYRA_API_URL in .env. When unset, the app keeps using Audius only.
 */
import type { Artist, CatalogTrack } from './catalog';

const API = (process.env.EXPO_PUBLIC_ZOYRA_API_URL ?? '').replace(/\/+$/, '');
/** Must match API_KEY on the backend. Audio players load URLs directly, so media URLs carry it as ?key=. */
const KEY = process.env.EXPO_PUBLIC_ZOYRA_API_KEY ?? '';
const withKey = (url: string) => (KEY ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(KEY)}` : url);
const keyHeader: Record<string, string> = KEY ? { 'X-Zoyra-Key': KEY } : {};

/** Render's free plan sleeps when idle; the first request can take ~50 s to wake it. */
const TIMEOUT_MS = 60_000;

const TRACK_PREFIX = 'yt_';
const ARTIST_PREFIX = 'yta_';

export const zoyraEnabled = API.length > 0;

export const isZoyraId = (id: string | undefined | null): id is string => !!id && id.startsWith(TRACK_PREFIX);
export const isZoyraArtistId = (id: string | undefined | null): id is string => !!id && id.startsWith(ARTIST_PREFIX);

const videoId = (trackId: string) => trackId.slice(TRACK_PREFIX.length);
const artistName = (artistId: string) => artistId.slice(ARTIST_PREFIX.length);

type ApiSong = {
  id: string;
  title: string | null;
  artist: string | null;
  duration: number | null;
  thumbnail: string;
  views?: number | null;
};

export type ApiLyrics = {
  synced: boolean;
  lines: { time: number; text: string }[];
  plain: string;
  instrumental: boolean;
  track: string | null;
  artist: string | null;
};

const prefetched = new Set<string>();
const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 5 * 60 * 1000;

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const query = qs.toString();
  const url = `${API}${path}${query ? `?${query}` : ''}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...keyHeader }, signal: controller.signal });
    if (res.status === 404) throw new ZoyraNotFound();
    if (!res.ok) throw new Error(`Zoyra API request failed (${res.status})`);
    const data = (await res.json()) as T;
    cache.set(url, { at: Date.now(), data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export class ZoyraNotFound extends Error {
  constructor() {
    super('Not found');
  }
}

/** YouTube thumbnails come in fixed sizes under the same path. */
const thumbs = (id: string) => ({
  small: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  medium: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  large: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
});

function toTrack(s: ApiSong): CatalogTrack {
  const name = s.artist?.trim() || 'Unknown artist';
  return {
    id: TRACK_PREFIX + s.id,
    streamUrl: zoyra.streamUrl(TRACK_PREFIX + s.id),
    title: s.title ?? 'Untitled',
    artist: { id: ARTIST_PREFIX + name, name, handle: name, verified: false },
    duration: s.duration ?? 0,
    artwork: thumbs(s.id),
    plays: s.views ?? 0,
    likes: 0,
    url: `https://www.youtube.com/watch?v=${s.id}`,
  };
}

export const zoyra = {
  async searchTracks(query: string, limit = 25): Promise<CatalogTrack[]> {
    if (!query.trim()) return [];
    const res = await get<{ results: ApiSong[] }>('/api/search', { q: query.trim(), limit });
    return res.results.map(toTrack);
  },

  async track(trackId: string): Promise<CatalogTrack> {
    const s = await get<ApiSong>(`/api/song/${videoId(trackId)}`);
    return toTrack({ ...s, id: videoId(trackId) });
  },

  /** No artist pages on YouTube search; build a minimal artist from the name in the id. */
  artist(artistId: string): Artist {
    const name = artistName(artistId);
    return { id: artistId, name, handle: name, verified: false, followers: 0, image: {} };
  },

  /** "Artist tracks" = song search by the artist/channel name. */
  async artistTracks(artistId: string, limit = 20): Promise<CatalogTrack[]> {
    return zoyra.searchTracks(artistName(artistId), limit);
  },

  streamUrl(trackId: string) {
    return withKey(`${API}/api/stream/${videoId(trackId)}`);
  },

  /** mp3 converted on the server (slower to start than streaming, but a real .mp3 file). */
  downloadUrl(trackId: string) {
    return withKey(`${API}/api/download/${videoId(trackId)}`);
  },

  /**
   * Ask the backend to look up a song's stream now (fire-and-forget), so it starts instantly
   * when played later. First play of a new song otherwise waits ~6 s (YouTube lookup + delay).
   */
  prefetch(trackId: string) {
    if (!zoyraEnabled || !isZoyraId(trackId) || prefetched.has(trackId)) return;
    prefetched.add(trackId);
    setTimeout(() => prefetched.delete(trackId), 30 * 60 * 1000); // backend keeps URLs ~1 h
    fetch(`${API}/api/prefetch/${videoId(trackId)}`, { method: 'POST', headers: keyHeader }).catch(() => prefetched.delete(trackId));
  },

  /** YouTube video id, e.g. to open the existing YouTube video player for this song. */
  videoId,

  async lyrics(track: CatalogTrack): Promise<ApiLyrics | null> {
    try {
      return await get<ApiLyrics>(`/api/lyrics/${videoId(track.id)}`, {
        title: track.title,
        artist: track.artist.name,
        duration: track.duration ? Math.round(track.duration) : undefined,
      });
    } catch (e) {
      if (e instanceof ZoyraNotFound) return null;
      throw e;
    }
  },
};
