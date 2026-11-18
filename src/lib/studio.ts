/**
 * Create studio: sound tools, rights checks and the stem-separation client.
 *
 * What is real:
 * - "Slowed": a dedicated expo-audio player with pitch correction OFF and a lower playback rate
 *   (varispeed: tempo and pitch drop together, which is what "slowed" means).
 * - Vocal remover / Stem studio: the `stems` Edge Function sends audio to a third-party
 *   separation API (server secrets STEMS_API_URL / STEMS_API_KEY). Without them it answers 503
 *   `not_configured` and the screen says so.
 *
 * Legal guardrail: separation only runs on the user's own imported files (after they confirm
 * they hold the rights) or Audius tracks whose artist offered a free download or published them
 * under a Creative Commons licence that allows derivatives. The server re-checks Audius tracks;
 * the client check only drives the UI.
 *
 * Not available (needs a native DSP / audio-graph engine this build does not ship): reverb,
 * 8D spatial audio, mashups.
 */
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import type { IconName } from '../components';
import type { ArtName } from '../theme/tokens';
import { invokeFn, type AiResult } from './ai';
import type { CatalogTrack } from './catalog';
import { isLocalTrack, localMusic } from './local-music';

/* ------------------------------------------------------------------ tools */

export type ToolCategory = 'Remix' | 'Stems' | 'Vocals';
export type ToolId = 'slowed' | 'vocals' | 'spatial' | 'stems' | 'mashup';
export type ToolStatus = 'ready' | 'server' | 'unavailable';

export type StudioTool = {
  id: ToolId;
  title: string;
  blurb: string;
  icon: IconName;
  art: ArtName;
  categories: ToolCategory[];
  /** ready = works on device; server = needs the stems service; unavailable = not in this version. */
  status: ToolStatus;
  /** Shown on unavailable cards / tool screens: why, in plain words. */
  note?: string;
};

export const FILTERS = ['All', 'Remix', 'Stems', 'Vocals'] as const;
export type StudioFilter = (typeof FILTERS)[number];

export const TOOLS: StudioTool[] = [
  {
    id: 'slowed',
    title: 'Slowed + reverb',
    blurb: 'Play any track slower and lower, the classic slowed sound.',
    icon: 'moon',
    art: 'coral',
    categories: ['Remix'],
    status: 'ready',
    note: 'Slowed works now. Reverb needs an audio effects engine this version doesn’t have yet.',
  },
  {
    id: 'vocals',
    title: 'Vocal remover',
    blurb: 'Split a song into vocals and instrumental.',
    icon: 'mic',
    art: 'amber',
    categories: ['Vocals', 'Stems'],
    status: 'server',
  },
  {
    id: 'spatial',
    title: '8D spatial audio',
    blurb: 'Move the sound around your head.',
    icon: 'spatial',
    art: 'rose',
    categories: ['Remix'],
    status: 'unavailable',
    note: 'Not available in this version. Moving sound around your head needs a native audio engine that Zoyra doesn’t include yet.',
  },
  {
    id: 'stems',
    title: 'Stem studio',
    blurb: 'Isolate vocals, drums, bass and melody into layers.',
    icon: 'sliders',
    art: 'blue',
    categories: ['Stems', 'Vocals'],
    status: 'server',
  },
  {
    id: 'mashup',
    title: 'Mashup maker',
    blurb: 'Blend two songs at matching keys and tempos.',
    icon: 'shuffle',
    art: 'green',
    categories: ['Remix'],
    status: 'unavailable',
    note: 'Not available in this version. Key and tempo matching needs a native audio engine that Zoyra doesn’t include yet.',
  },
];

export const toolById = (id: string | undefined): StudioTool | undefined => TOOLS.find((t) => t.id === id);

export function filterTools(filter: StudioFilter, query: string): StudioTool[] {
  const q = query.trim().toLowerCase();
  return TOOLS.filter((t) => (filter === 'All' || t.categories.includes(filter)) && (!q || `${t.title} ${t.blurb}`.toLowerCase().includes(q)));
}

/* ------------------------------------------------------------------ slowed */

/** Slowed presets (playback rate, pitch drops with it). */
export const SLOW_RATES = [0.9, 0.85, 0.8, 0.75] as const;
export type SlowRate = (typeof SLOW_RATES)[number];

/** Semitones the pitch drops at a varispeed rate: 12·log2(rate). */
export const semitonesFor = (rate: number) => Math.round(12 * Math.log2(rate) * 10) / 10;

/* ------------------------------------------------------------------ rights */

export type Rights = { ok: true; basis: string } | { ok: false; reason: string };

type RawAudiusRights = {
  is_downloadable?: boolean;
  is_download_gated?: boolean;
  download_conditions?: unknown;
  is_streamable?: boolean;
  is_stream_gated?: boolean;
  stream_conditions?: unknown;
  is_delete?: boolean;
  license?: string | null;
};

const AUDIUS = 'https://api.audius.co/v1';
const APP = 'zoyra';

/** Creative Commons licence that allows derivatives (anything CC without "NoDerivs"/"ND"). */
export const ccAllowsRemix = (license: string | null | undefined): boolean => {
  if (!license) return false;
  const l = license.toLowerCase();
  if (!l.includes('cc') && !l.includes('attribution') && !l.includes('creative commons')) return false;
  return !/no ?deriv|\bnd\b|-nd\b/.test(l);
};

/** Same rule as the `stems` Edge Function (which is the one that enforces it). */
export function audiusRights(t: RawAudiusRights): Rights {
  if (t.is_delete) return { ok: false, reason: 'This track was removed by the artist.' };
  if (t.is_stream_gated || t.stream_conditions) return { ok: false, reason: 'This track is gated (premium or follow-to-unlock).' };
  if (t.is_downloadable && !t.is_download_gated && !t.download_conditions) return { ok: true, basis: 'The artist offers a free download' };
  if (ccAllowsRemix(t.license)) return { ok: true, basis: `Licensed ${t.license}` };
  if (t.is_downloadable) return { ok: false, reason: 'The download is gated by the artist, so it can’t be split.' };
  return { ok: false, reason: 'The artist hasn’t made this track downloadable or remixable.' };
}

async function audiusGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ ...params, app_name: APP });
  const res = await fetch(`${AUDIUS}${path}?${qs.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Catalogue request failed (${res.status})`);
  const body = (await res.json()) as { data: T };
  return body.data;
}

/** Can this track go to the stem separator? Local/imported files are the user's own. */
export async function checkRights(track: CatalogTrack): Promise<Rights> {
  if (isLocalTrack(track)) return { ok: true, basis: 'Your own file' };
  const raw = await audiusGet<RawAudiusRights>(`/tracks/${encodeURIComponent(track.id)}`);
  return audiusRights(raw);
}

export type EligibleTrack = { track: CatalogTrack; basis: string };

type RawTrack = RawAudiusRights & {
  id: string;
  title: string;
  duration: number;
  genre?: string | null;
  play_count?: number;
  favorite_count?: number;
  permalink?: string;
  artwork?: Partial<Record<'150x150' | '480x480' | '1000x1000', string>> | null;
  user: { id: string; name: string; handle: string; is_verified: boolean };
};

const toTrack = (t: RawTrack): CatalogTrack => ({
  id: t.id,
  title: t.title.trim(),
  artist: { id: t.user.id, name: t.user.name, handle: t.user.handle, verified: t.user.is_verified },
  duration: t.duration,
  genre: t.genre ?? undefined,
  artwork: { small: t.artwork?.['150x150'], medium: t.artwork?.['480x480'], large: t.artwork?.['1000x1000'] },
  plays: t.play_count ?? 0,
  likes: t.favorite_count ?? 0,
  url: t.permalink ? `https://audius.co${t.permalink}` : undefined,
});

/** Audius search limited to tracks the artist made downloadable, then filtered by the rights rule. */
export async function searchRemixable(query: string, limit = 20): Promise<EligibleTrack[]> {
  const q = query.trim();
  if (!q) return [];
  const raw = await audiusGet<RawTrack[]>('/tracks/search', { query: q, has_downloads: 'true', limit: String(limit) });
  const out: EligibleTrack[] = [];
  for (const t of raw) {
    const r = audiusRights(t);
    if (r.ok) out.push({ track: toTrack(t), basis: r.basis });
  }
  return out;
}

/* ------------------------------------------------------------------ stems service */

export type StemMode = 'vocals' | 'stems';
export type Stem = { name: string; url: string };
export type StemJob = { status: 'queued' | 'processing' | 'done' | 'failed'; jobId?: string; stems: Stem[]; error?: string };

/** Largest own file we upload (the request carries it as base64). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const mimeFor = (uri: string) => {
  const ext = /\.([a-z0-9]{1,5})(?:\?|$)/i.exec(uri)?.[1]?.toLowerCase();
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'aac':
      return 'audio/aac';
    default:
      return 'audio/mp4';
  }
};

export class StudioError extends Error {}

/**
 * Start separation. Audius tracks go by id (the server fetches and re-checks them); the user's
 * own files are read from disk and uploaded. `rightsConfirmed` must be true for own files.
 */
export async function startStems(track: CatalogTrack, mode: StemMode, rightsConfirmed: boolean): Promise<AiResult<StemJob>> {
  if (isLocalTrack(track)) {
    if (Platform.OS === 'web') return { ok: false, reason: 'error', message: 'Your own files can’t be uploaded from the web app.' };
    if (!rightsConfirmed) return { ok: false, reason: 'error', message: 'Confirm you own this recording or have the rights to edit it.' };
    const m: CatalogTrack & { localUri?: string } = track;
    const uri = localMusic.uriFor(track.id) ?? m.localUri;
    if (!uri) return { ok: false, reason: 'error', message: 'This file is no longer on your device.' };
    let file: File;
    try {
      file = new File(uri);
      if (!file.exists) return { ok: false, reason: 'error', message: 'This file is no longer on your device.' };
    } catch {
      return { ok: false, reason: 'error', message: 'Couldn’t open this file.' };
    }
    if (file.size > MAX_UPLOAD_BYTES) return { ok: false, reason: 'error', message: `This file is too big (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` };
    let audioBase64: string;
    try {
      audioBase64 = await file.base64();
    } catch {
      return { ok: false, reason: 'error', message: 'Couldn’t read this file.' };
    }
    return invokeFn<StemJob>('stems', { action: 'start', mode, source: { kind: 'upload', audioBase64, mimeType: mimeFor(uri), name: track.title, rightsConfirmed: true } }, 'stem separation');
  }
  return invokeFn<StemJob>('stems', { action: 'start', mode, source: { kind: 'audius', trackId: track.id } }, 'stem separation');
}

export const stemsStatus = (jobId: string) => invokeFn<StemJob>('stems', { action: 'status', jobId }, 'stem separation');

/** Friendly label for a provider stem name. */
export function stemLabel(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('vocal') || n === 'voice') return 'Vocals';
  if (n.includes('accomp') || n.includes('instrument') || n === 'no_vocals') return 'Instrumental';
  if (n.includes('drum')) return 'Drums';
  if (n.includes('bass')) return 'Bass';
  if (n.includes('piano') || n.includes('melody') || n === 'other') return n === 'other' ? 'Melody & other' : 'Melody';
  return name.charAt(0).toUpperCase() + name.slice(1);
}
