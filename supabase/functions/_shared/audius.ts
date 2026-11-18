// Tiny Audius catalogue client used by ai-playlist.
const BASE = 'https://api.audius.co/v1';
const APP = 'zoyra';

export type AudiusTrack = {
  id: string;
  title: string;
  user: { id: string; name: string };
  genre?: string | null;
  mood?: string | null;
  is_streamable?: boolean;
  is_stream_gated?: boolean;
  stream_conditions?: unknown;
  is_delete?: boolean;
};

/** Freely streamable: not deleted, not stream-gated (no premium / NFT / follow gate). */
export const isPlayable = (t: AudiusTrack): boolean =>
  t.is_streamable !== false && !t.is_stream_gated && !t.stream_conditions && !t.is_delete;

async function get(path: string, params: Record<string, string>): Promise<AudiusTrack[]> {
  const qs = new URLSearchParams({ ...params, app_name: APP });
  try {
    const res = await fetch(`${BASE}${path}?${qs.toString()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: AudiusTrack[] };
    return Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
}

export const searchTracks = (query: string) => get('/tracks/search', { query });
export const trendingTracks = (genre: string) => get('/tracks/trending', { genre });
