/**
 * Premieres + track detail helpers on top of the Audius catalogue.
 *
 * Premieres = the biggest recent releases: trending albums and trending tracks whose release date is recent.
 * Track detail = the extra Audius fields the shared `CatalogTrack` shape does not carry (reposts, comments,
 * description, BPM, key, licence, collaborators…). Everything here is real catalogue data; nothing is invented.
 */
import { catalog, type CatalogTrack, type Collection } from './catalog';
import { isZoyraId } from './zoyra-api';

const BASE = 'https://api.audius.co/v1';
const APP = 'zoyra';
const DAY = 86_400_000;

const parseDate = (d?: string) => (d ? Date.parse(d) || 0 : 0);

export const isRecent = (d: string | undefined, days: number) => {
  const t = parseDate(d);
  return t > 0 && Date.now() - t <= days * DAY && t <= Date.now() + DAY;
};

export const formatReleaseDate = (d?: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }) => {
  const t = parseDate(d);
  return t ? new Date(t).toLocaleDateString(undefined, opts) : undefined;
};

/* ------------------------------------------------------------------ premieres */

export type Premieres = {
  /** Trending albums released recently, newest first. */
  albums: Collection[];
  /** Trending tracks released recently, newest first. */
  tracks: CatalogTrack[];
};

/**
 * Recent big releases. Takes this week's trending albums and tracks, keeps the ones released in the last
 * `days` days and sorts newest first. Falls back to the plain trending order when nothing is that fresh.
 */
export async function loadPremieres(days = 30): Promise<Premieres> {
  const [cols, tracks] = await Promise.all([catalog.trendingCollections(50), catalog.trending({ time: 'week', limit: 50 })]);
  const albums = cols.filter((c) => c.isAlbum);
  const byNewest = <X extends { releaseDate?: string }>(a: X, b: X) => parseDate(b.releaseDate) - parseDate(a.releaseDate);
  const freshAlbums = albums.filter((c) => isRecent(c.releaseDate, days)).sort(byNewest);
  const freshTracks = tracks.filter((t) => isRecent(t.releaseDate, days)).sort(byNewest);
  return {
    albums: freshAlbums.length ? freshAlbums : albums.slice(0, 10),
    tracks: freshTracks.length ? freshTracks : tracks.slice(0, 20),
  };
}

/* ------------------------------------------------------------------ track detail */

type RawDetail = {
  description?: string | null;
  repost_count?: number;
  comment_count?: number;
  bpm?: number | null;
  musical_key?: string | null;
  isrc?: string | null;
  license?: string | null;
  copyright_line?: { text?: string } | string | null;
  producer_copyright_line?: { text?: string } | string | null;
  is_downloadable?: boolean;
  collaborators?: { id?: string; name?: string; handle?: string }[] | null;
  remix_of?: { tracks?: { parent_track_id?: string }[] | null } | null;
  created_at?: string | null;
};

export type TrackExtras = {
  description?: string;
  reposts: number;
  comments: number;
  bpm?: number;
  musicalKey?: string;
  isrc?: string;
  license?: string;
  copyright?: string;
  producerCopyright?: string;
  downloadable: boolean;
  collaborators: { id: string; name: string }[];
  remixOfId?: string;
};

const lineText = (v: RawDetail['copyright_line']) => (typeof v === 'string' ? v : v?.text) || undefined;

async function rawTrack(id: string): Promise<RawDetail> {
  const res = await fetch(`${BASE}/tracks/${encodeURIComponent(id)}?app_name=${APP}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Catalogue request failed (${res.status})`);
  const json = (await res.json()) as { data: RawDetail };
  return json.data;
}

export type TrackDetail = { track: CatalogTrack; extras: TrackExtras };

/** Full track detail: the normalized track plus Audius-only extras. */
export async function loadTrackDetail(id: string): Promise<TrackDetail> {
  // Extra details (bpm, key, license…) only exist on Audius; other sources (e.g. `yt_` ids) would 400 there.
  const [track, raw] = await Promise.all([catalog.track(id), isZoyraId(id) ? Promise.resolve({} as RawDetail) : rawTrack(id).catch(() => ({}) as RawDetail)]);
  const desc = raw.description?.trim();
  return {
    track,
    extras: {
      description: desc || undefined,
      reposts: raw.repost_count ?? 0,
      comments: raw.comment_count ?? 0,
      bpm: raw.bpm ? Math.round(raw.bpm) : undefined,
      musicalKey: raw.musical_key ?? undefined,
      isrc: raw.isrc ?? undefined,
      license: raw.license ?? undefined,
      copyright: lineText(raw.copyright_line),
      producerCopyright: lineText(raw.producer_copyright_line),
      downloadable: !!raw.is_downloadable,
      collaborators: (raw.collaborators ?? []).filter((c): c is { id: string; name: string } => !!c.id && !!c.name).map((c) => ({ id: c.id, name: c.name })),
      remixOfId: raw.remix_of?.tracks?.[0]?.parent_track_id ?? undefined,
    },
  };
}
