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

/**
 * How long to wait for the backend. Short on purpose: when the tunnel/server is down, a long wait freezes every
 * search before the app can fall back to the other catalogue.
 */
const TIMEOUT_MS = 9_000;
/**
 * Circuit breaker: after a timeout or network failure the backend counts as down for a short while, so the next
 * searches go straight to the fallback instead of each waiting for the timeout again.
 */
const DOWN_FOR_MS = 30_000;
let downUntil = 0;
export const zoyraDown = () => Date.now() < downUntil;

const TRACK_PREFIX = 'yt_';
const ARTIST_PREFIX = 'yta_';

export const zoyraEnabled = API.length > 0;

// Open the TLS connection early; the first request otherwise pays ~1 s of handshake.
if (zoyraEnabled) setTimeout(() => fetch(`${API}/api/health`).catch(() => {}), 0);

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
  /** Length (s) of the LRCLIB recording the timestamps were made for. */
  duration?: number | null;
  track: string | null;
  artist: string | null;
};

const prefetched = new Set<string>();
const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 5 * 60 * 1000;
/** Same request already running (e.g. two screens, fast typing): share one network call. */
const inflight = new Map<string, Promise<unknown>>();

async function get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const query = qs.toString();
  const url = `${API}${path}${query ? `?${query}` : ''}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.data as T;
  const running = inflight.get(url);
  if (running) return running as Promise<T>;
  const p = fetchJson<T>(url).finally(() => inflight.delete(url));
  inflight.set(url, p);
  return p;
}

async function fetchJson<T>(url: string): Promise<T> {
  if (zoyraDown()) throw new Error('Music service is unreachable right now');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...keyHeader }, signal: controller.signal });
    if (res.status === 404) throw new ZoyraNotFound();
    if (!res.ok) throw new Error(`Zoyra API request failed (${res.status})`);
    const data = (await res.json()) as T;
    cache.set(url, { at: Date.now(), data });
    downUntil = 0;
    return data;
  } catch (e) {
    // Timeouts and network errors (not "not found" or a server answer) trip the breaker.
    if (!(e instanceof ZoyraNotFound) && !(e instanceof Error && e.message.startsWith('Zoyra API request failed'))) downUntil = Date.now() + DOWN_FOR_MS;
    throw e;
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
  // hq720 is true 16:9 (hqdefault has black bars top and bottom, which show on big covers).
  large: `https://i.ytimg.com/vi/${id}/hq720.jpg`,
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
    const tracks = res.results.map(toTrack);
    // Resolve the top hits on the server now, so tapping one starts in ~1 s instead of ~6 s.
    tracks.slice(0, 3).forEach((t, i) => setTimeout(() => zoyra.prefetch(t.id), i * 300));
    return tracks;
  },

  /**
   * "Popular now" / new releases from the backend's search (it has no charts endpoint): a few chart-style
   * queries run in parallel, long mixes and compilations are dropped, and the rest is ranked by views.
   * `kind: 'new'` favours fresh releases for the home banner.
   */
  async popular(kind: 'popular' | 'new' = 'popular', limit = 20): Promise<CatalogTrack[]> {
    const year = new Date().getFullYear();
    const queries =
      kind === 'new'
        ? [`latest english song ${year} official music video`, `new hindi song ${year} official video`, `new tamil song ${year} official video`]
        : [`most viewed song this week official video`, `latest english hit song ${year} official music video`, `new hindi songs ${year} official video`, `new tamil songs ${year} official video`];
    const lists = await Promise.all(queries.map((q) => get<{ results: ApiSong[] }>('/api/search', { q, limit: 15 }).then((r) => r.results).catch(() => [] as ApiSong[])));
    const bad = /\b(mix|jukebox|non ?stop|compilation|playlist|mashup|hours?|top \d+|best of|full album|live stream|reaction)\b/i;
    const seen = new Set<string>();
    const songs = lists
      .flat()
      .filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        const d = s.duration ?? 0;
        return d >= 90 && d <= 480 && !bad.test(s.title ?? '');
      });
    songs.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
    const tracks = songs.slice(0, limit).map(toTrack);
    tracks.slice(0, 3).forEach((t, i) => setTimeout(() => zoyra.prefetch(t.id), i * 300));
    return tracks;
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
    if (!zoyraEnabled || zoyraDown() || !isZoyraId(trackId) || prefetched.has(trackId)) return;
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
