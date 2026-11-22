import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';

import { ServiceNotConfiguredError } from './concerts';
import { getPlayPref, playPrefsReady } from './play-prefs';
import { supabase } from './supabase';
import { FLASH, flash } from './flash';
import { shareContent } from './share-links';

/**
 * Music videos via the `youtube` edge function (YouTube Data API v3 on the server; the key never
 * ships in the app). Playback is only through YouTube's official embedded player, with the video
 * visible — no stream extraction, audio-only, background play or downloads (YouTube API Services Terms).
 *
 * Quota (10,000 units/day): search-type actions cost ~101 units, the rest 1–3. Responses are cached
 * on the server (public.youtube_cache) and here (memory + AsyncStorage with a TTL).
 */

/* ================================================================== types */

export type YouTubeVideo = {
  id: string;
  title: string;
  channel: string;
  channelId: string | null;
  thumbnail: string | null;
  publishedAt: string | null;
  live: boolean;
  views: number | null;
  likes: number | null;
  comments: number | null;
  durationSec: number | null;
};

export type YouTubeDetails = YouTubeVideo & {
  description: string;
  tags: string[];
  /** The owner hid the comment count (usually means comments are off). */
  commentsHidden: boolean;
  embeddable: boolean;
};

export type YouTubeChannel = { id: string; title: string; thumbnail: string | null; subscribers: number | null };

export type YouTubeComment = {
  id: string;
  author: string;
  authorAvatar: string | null;
  text: string;
  likes: number;
  publishedAt: string | null;
  replies: number;
};

export type YouTubePage = { videos: YouTubeVideo[]; nextPageToken?: string };
export type CommentPage = { comments: YouTubeComment[]; nextPageToken?: string };
export type DetailsResult = { videos: YouTubeDetails[]; channel: YouTubeChannel | null };

export const YOUTUBE_SETUP_MESSAGE = 'Music videos need YouTube setup.';

/** A YouTube API error with a stable code (quota_exceeded, comments_disabled, not_found, …). */
export class YouTubeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeError';
  }
}

/* ================================================================== edge function */

type Body = Record<string, unknown> & { action: string };

async function invoke<T>(body: Body): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>('youtube', { body });
  if (error) {
    const ctx: unknown = (error as { context?: unknown }).context;
    const res = typeof Response !== 'undefined' && ctx instanceof Response ? ctx : null;
    const info = (res ? await res.clone().json().catch(() => null) : null) as { error?: string; service?: string; message?: string } | null;
    if (res?.status === 503 || info?.error === 'not_configured') throw new ServiceNotConfiguredError(info?.service ?? 'YouTube');
    if (res?.status === 404 && !info?.error) throw new Error('The YouTube service is not deployed yet.');
    if (info?.error === 'quota_exceeded') throw new YouTubeError('quota_exceeded', 'YouTube’s daily limit for Zoyra has been reached. Try again tomorrow.');
    if (info?.error === 'comments_disabled') throw new YouTubeError('comments_disabled', 'Comments are turned off for this video.');
    if (info?.error === 'not_found') throw new YouTubeError('not_found', info.message ?? 'That video is no longer available.');
    if (info?.error === 'bad_request' && info.message?.startsWith('Unknown action'))
      throw new YouTubeError('outdated', 'The YouTube service needs the latest server update.');
    throw new YouTubeError(info?.error ?? 'youtube_failed', info?.message ?? 'Could not load videos');
  }
  if (!data) throw new Error('Could not load videos');
  return data;
}

/* ================================================================== client cache */

const CACHE_PREFIX = 'yt-cache:v1:';
const memory = new Map<string, { exp: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

async function cachedInvoke<T>(body: Body, ttlSec: number, persist = true): Promise<T> {
  const key = JSON.stringify(body);
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && hit.exp > now) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const p = (async () => {
    if (persist) {
      try {
        const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
        const stored = raw ? (JSON.parse(raw) as { exp: number; value: T }) : null;
        if (stored && stored.exp > Date.now()) {
          memory.set(key, stored);
          return stored.value;
        }
      } catch {
        // Storage unavailable: fall through to the network.
      }
    }
    const value = await invoke<T>(body);
    const entry = { exp: Date.now() + ttlSec * 1000, value };
    memory.set(key, entry);
    if (memory.size > 200) memory.delete(memory.keys().next().value as string);
    if (persist) AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry)).catch(() => undefined);
    return value;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

const cleanVideos = (p: YouTubePage): YouTubePage => ({ videos: (p.videos ?? []).filter((v) => v && v.id && v.title), nextPageToken: p.nextPageToken });

/** Device region ("en-IN" → "IN") for charts and searches; falls back to India. */
export function deviceRegion(): string {
  const tag = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
  const part = tag.split(/[-_]/).find((p, i) => i > 0 && /^[A-Za-z]{2}$/.test(p));
  return part?.toUpperCase() ?? 'IN';
}

/* ================================================================== API */

/** Most popular music videos in the region (1 unit). */
export const fetchChart = (pageToken?: string) => cachedInvoke<YouTubePage>({ action: 'chart', region: deviceRegion(), pageToken }, 3600).then(cleanVideos);

/** Search music videos (≈101 units; never call per keystroke — debounce ≥ 500 ms, ≥ 2 characters). */
export function searchVideos(q: string, opts: { pageToken?: string; duration?: 'short' | 'medium' | 'long' } = {}) {
  const query = q.trim();
  if (query.length < 2) return Promise.resolve<YouTubePage>({ videos: [] });
  return cachedInvoke<YouTubePage>({ action: 'search', q: query.toLowerCase(), region: deviceRegion(), ...opts }, 6 * 3600).then(cleanVideos);
}

/** Embeddable music shorts (≤ 3 minutes). */
export const fetchShorts = (q?: string, pageToken?: string) => cachedInvoke<YouTubePage>({ action: 'shorts', q, region: deviceRegion(), pageToken }, 3 * 3600).then(cleanVideos);

/** Music streams live right now. */
export const fetchLive = (pageToken?: string) => cachedInvoke<YouTubePage>({ action: 'live', region: deviceRegion(), pageToken }, 900).then(cleanVideos);

/** Up next: a search on the title and channel (YouTube deprecated relatedToVideoId). */
export function fetchRelated(v: Pick<YouTubeVideo, 'id' | 'title' | 'channel'>) {
  const words = v.title
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(/\b(official|music|video|lyrics?|audio|hd|4k|mv)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join(' ');
  const q = `${v.channel} ${words}`.trim() || v.title;
  return cachedInvoke<YouTubePage>({ action: 'related', q: q.toLowerCase(), videoId: v.id, region: deviceRegion() }, 12 * 3600).then(cleanVideos);
}

/** Real views, likes, comment count, duration and description (1 unit; +1 for the channel). */
export const fetchDetails = (ids: string[]) => cachedInvoke<DetailsResult>({ action: 'details', ids: [...ids].sort() }, 600, false);

export async function fetchVideo(id: string): Promise<{ video: YouTubeDetails; channel: YouTubeChannel | null }> {
  const r = await fetchDetails([id]);
  const video = r.videos.find((v) => v.id === id);
  if (!video) throw new YouTubeError('not_found', 'That video is no longer available.');
  return { video, channel: r.channel };
}

/** Read-only YouTube comments (1 unit per page). */
export const fetchComments = (videoId: string, order: 'relevance' | 'time', pageToken?: string) =>
  cachedInvoke<CommentPage>({ action: 'comments', videoId, order, pageToken }, order === 'time' ? 120 : 900, false);

/** Recent uploads from channels (≤ 10). `shortsOnly` keeps videos of 3 minutes or less. */
export const fetchUploads = (channelIds: string[], shortsOnly = false) =>
  channelIds.length
    ? cachedInvoke<YouTubePage>({ action: 'uploads', channelIds: [...channelIds].sort().slice(0, 10), shortsOnly }, 3 * 3600).then(cleanVideos)
    : Promise.resolve<YouTubePage>({ videos: [] });

/** Friendly sentence for any error thrown above. */
export function youtubeErrorMessage(e: unknown, fallback = 'Could not load videos'): string {
  if (e instanceof ServiceNotConfiguredError) return YOUTUBE_SETUP_MESSAGE;
  return e instanceof Error ? e.message : fallback;
}

/* ================================================================== links, share, report */

export const youtubeUrl = (id: string, t?: number) => `https://www.youtube.com/watch?v=${id}${t && t > 0 ? `&t=${Math.floor(t)}s` : ''}`;
export const channelUrl = (channelId: string) => `https://www.youtube.com/channel/${channelId}`;

/** Opens the video in the YouTube app or website ("Watch on YouTube"). Resolves false if nothing could open it. */
export const openOnYouTube = (id: string, t?: number) =>
  Linking.openURL(youtubeUrl(id, t)).then(
    () => true,
    () => false,
  );

export async function shareVideo(v: Pick<YouTubeVideo, 'id' | 'title' | 'channel'>): Promise<void> {
  const url = youtubeUrl(v.id);
  await shareContent({ url, title: v.title });
}

export const REPORT_EMAIL = 'support@zoyra.app';

/** mailto: link for reporting a video (it is hosted by YouTube; Zoyra forwards or hides it). */
export const reportVideoUrl = (v: Pick<YouTubeVideo, 'id' | 'title'>) =>
  `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`Report video ${v.id}`)}&body=${encodeURIComponent(
    `Video: ${v.title}\n${youtubeUrl(v.id)}\n\nWhat is wrong with this video?\n`,
  )}`;

/* ================================================================== formatting */

export function compactCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1000) return String(n);
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, s] of units) {
    if (n >= v) {
      const x = n / v;
      return `${x >= 100 ? Math.round(x) : Number(x.toFixed(1))}${s}`;
    }
  }
  return String(n);
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '';
  if (diff < 60) return 'just now';
  const steps: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [s, label] of steps) {
    if (diff >= s) {
      const n = Math.floor(diff / s);
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '';
}

/** "2.3M views · 3 days ago" from whatever is known. */
export const videoMeta = (v: Pick<YouTubeVideo, 'views' | 'publishedAt' | 'live'>) =>
  [v.live ? 'Live now' : null, v.views !== null ? `${compactCount(v.views)} views` : null, v.live ? null : timeAgo(v.publishedAt) || null].filter(Boolean).join(' · ');

/* ================================================================== timestamps in comments */

const STAMP = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g;

export type TextPart = { text: string; seconds?: number };

/** Splits text into plain parts and "1:23" / "1:02:03" timestamp parts (with seconds). */
export function splitTimestamps(text: string, maxSec?: number | null): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(STAMP)) {
    const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (maxSec && sec > maxSec) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: m[0], seconds: sec });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export const hasTimestamp = (text: string, maxSec?: number | null) => splitTimestamps(text, maxSec).some((p) => p.seconds !== undefined);

/* ================================================================== shared player state (sheets ↔ player) */

/**
 * The comments and options sheets open over the player screen (transparent modals), so they talk to
 * the mounted IFrame player through this tiny store: seek requests, playback rate and captions.
 */
type PlayerBusState = {
  /** Video the open player is showing. */
  videoId: string | null;
  rate: number;
  rates: number[];
  captions: boolean;
  /** Last seek request; `n` makes repeated seeks to the same second distinct. */
  seek: { videoId: string; seconds: number; n: number } | null;
  /** Position to resume at when coming back from the full-screen view. */
  resume: { videoId: string; seconds: number } | null;
};

const DEFAULT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let bus: PlayerBusState = { videoId: null, rate: 1, rates: DEFAULT_RATES, captions: getPlayPref('video.captions'), seek: null, resume: null };
const listeners = new Set<() => void>();
// Captions default (Settings › Video), once device prefs have loaded; the options sheet still changes them per session.
void playPrefsReady.then(() => {
  if (!bus.videoId) videoBus.set({ captions: getPlayPref('video.captions') });
});

export const videoBus = {
  get: () => bus,
  set(patch: Partial<PlayerBusState>) {
    bus = { ...bus, ...patch };
    listeners.forEach((l) => l());
  },
  seek(videoId: string, seconds: number) {
    videoBus.set({ seek: { videoId, seconds, n: (bus.seek?.n ?? 0) + 1 } });
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useVideoBus(): PlayerBusState {
  const [state, setState] = useState(bus);
  useEffect(() => videoBus.subscribe(() => setState(bus)), []);
  return state;
}

/* ================================================================== Zoyra tables */

/** Card snapshot kept with saved videos (so My list renders without API calls). */
const snapshot = (v: YouTubeVideo) => ({
  id: v.id,
  title: v.title,
  channel: v.channel,
  channelId: v.channelId,
  thumbnail: v.thumbnail,
  publishedAt: v.publishedAt,
  durationSec: v.durationSec,
});

const asVideo = (raw: unknown, id: string): YouTubeVideo => {
  const r = (raw ?? {}) as Partial<YouTubeVideo>;
  return {
    id,
    title: typeof r.title === 'string' ? r.title : 'YouTube video',
    channel: typeof r.channel === 'string' ? r.channel : '',
    channelId: typeof r.channelId === 'string' ? r.channelId : null,
    thumbnail: typeof r.thumbnail === 'string' ? r.thumbnail : null,
    publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : null,
    live: false,
    views: null,
    likes: null,
    comments: null,
    durationSec: typeof r.durationSec === 'number' ? r.durationSec : null,
  };
};

const tableError = (e: { message: string } | null) => {
  if (!e) return;
  if (/relation .* does not exist|could not find the table/i.test(e.message)) throw new Error('Saving videos needs the latest server update.');
  throw new Error(e.message);
};

export async function listSavedVideos(me: string): Promise<YouTubeVideo[]> {
  const { data, error } = await supabase.from('saved_videos').select('video_id, video').eq('user_id', me).order('created_at', { ascending: false }).limit(100);
  tableError(error);
  return ((data ?? []) as { video_id: string; video: unknown }[]).map((r) => asVideo(r.video, r.video_id));
}

export async function isVideoSaved(me: string, id: string): Promise<boolean> {
  const { data, error } = await supabase.from('saved_videos').select('video_id').eq('user_id', me).eq('video_id', id).maybeSingle();
  tableError(error);
  return !!data;
}

export async function setVideoSaved(me: string, v: YouTubeVideo, saved: boolean): Promise<void> {
  const { error } = saved
    ? await supabase.from('saved_videos').upsert({ user_id: me, video_id: v.id, video: snapshot(v) }, { onConflict: 'user_id,video_id', ignoreDuplicates: true })
    : await supabase.from('saved_videos').delete().eq('user_id', me).eq('video_id', v.id);
  tableError(error);
  flash(saved ? FLASH.saved : FLASH.unsaved);
}

export type FollowedChannel = { id: string; title: string; thumbnail: string | null };

export async function listFollowedChannels(me: string): Promise<FollowedChannel[]> {
  const { data, error } = await supabase.from('followed_channels').select('channel_id, channel').eq('user_id', me).order('created_at', { ascending: false }).limit(50);
  tableError(error);
  return ((data ?? []) as { channel_id: string; channel: { title?: unknown; thumbnail?: unknown } | null }[]).map((r) => ({
    id: r.channel_id,
    title: typeof r.channel?.title === 'string' ? r.channel.title : 'YouTube channel',
    thumbnail: typeof r.channel?.thumbnail === 'string' ? r.channel.thumbnail : null,
  }));
}

export async function isChannelFollowed(me: string, channelId: string): Promise<boolean> {
  const { data, error } = await supabase.from('followed_channels').select('channel_id').eq('user_id', me).eq('channel_id', channelId).maybeSingle();
  tableError(error);
  return !!data;
}

export async function setChannelFollowed(me: string, ch: FollowedChannel, follow: boolean): Promise<void> {
  const { error } = follow
    ? await supabase
        .from('followed_channels')
        .upsert({ user_id: me, channel_id: ch.id, channel: { title: ch.title, thumbnail: ch.thumbnail } }, { onConflict: 'user_id,channel_id', ignoreDuplicates: true })
    : await supabase.from('followed_channels').delete().eq('user_id', me).eq('channel_id', ch.id);
  tableError(error);
  flash(follow ? `${FLASH.followed} ${ch.title}` : FLASH.unfollowed);
}

/* ---------------------------------------------------------------- Zoyra comments */

export const ZOYRA_COMMENT_MAX = 500;

export type ZoyraComment = {
  id: string;
  video_id: string;
  user_id: string;
  body: string;
  created_at: string;
  author: { id: string; display_name: string; avatar_url: string | null; username: string | null } | null;
};

export async function listZoyraComments(videoId: string): Promise<ZoyraComment[]> {
  const { data, error } = await supabase
    .from('video_comments')
    .select('id, video_id, user_id, body, created_at, author:profiles!video_comments_user_id_fkey(id, display_name, avatar_url, username)')
    .eq('video_id', videoId)
    .order('created_at', { ascending: false })
    .limit(100);
  tableError(error);
  type Row = Omit<ZoyraComment, 'author'> & { author: ZoyraComment['author'] | NonNullable<ZoyraComment['author']>[] };
  return ((data ?? []) as unknown as Row[]).map((r) => ({ ...r, author: Array.isArray(r.author) ? (r.author[0] ?? null) : r.author }));
}

export async function postZoyraComment(videoId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new Error('Write something first.');
  if (text.length > ZOYRA_COMMENT_MAX) throw new Error(`Comments can be up to ${ZOYRA_COMMENT_MAX} characters.`);
  const { error } = await supabase.from('video_comments').insert({ video_id: videoId, body: text });
  tableError(error);
}

export async function deleteZoyraComment(id: string): Promise<void> {
  const { error } = await supabase.from('video_comments').delete().eq('id', id);
  tableError(error);
}
