// youtube: YouTube Data API v3 proxy for the official embedded player (music videos only).
//
// POST { action?, ... } (user JWT required; 503 not_configured without YOUTUBE_API_KEY)
//   chart    (default) { region?, pageToken? }            videos.list chart=mostPopular, Music      1 unit
//   search   { q, region?, pageToken?, duration? }        search.list + videos.list (stats)       101 units
//   shorts   { q?, region?, pageToken? }                  search.list videoDuration=short + stats 101 units
//   live     { q?, region?, pageToken? }                  search.list eventType=live + stats      101 units
//   related  { q, videoId?, region? }                     search.list on title/channel + stats    101 units
//                                                         (relatedToVideoId is deprecated)
//   details  { ids: string[] (≤ 50) }                     videos.list (+ channels.list for 1 id)  1–2 units
//   comments { videoId, order?: relevance|time, pageToken? } commentThreads.list                  1 unit
//   uploads  { channelIds: string[] (≤ 10), shortsOnly? } channels.list + playlistItems.list + videos.list
//
// → videos: { videos: Video[], nextPageToken? }   details: { videos: VideoDetails[], channel? }
//   comments: { comments: Comment[], nextPageToken?, total? }
// Errors: 429 quota_exceeded, 403 comments_disabled, 404 not_found, 400 bad_request, 502 youtube_failed.
//
// Shared responses (charts, searches, comments) are cached in public.youtube_cache (service role only)
// so one user's request saves quota for everyone; the app also caches on the device.
//
// Playback happens only in YouTube's own IFrame player in the app (no stream extraction,
// no audio-only, no background play), per the YouTube API Services Terms.
import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, requireUser } from '../_shared/http.ts';

const API = 'https://www.googleapis.com/youtube/v3';
const MUSIC_CATEGORY = '10';

type Thumbs = Partial<Record<'default' | 'medium' | 'high' | 'standard' | 'maxres', { url: string }>>;
type Snippet = {
  title?: string;
  description?: string;
  channelId?: string;
  channelTitle?: string;
  publishedAt?: string;
  thumbnails?: Thumbs;
  liveBroadcastContent?: string;
  tags?: string[];
  resourceId?: { videoId?: string };
};
type Stats = { viewCount?: string; likeCount?: string; commentCount?: string; subscriberCount?: string; hiddenSubscriberCount?: boolean };
type VideoItem = {
  id?: string | { videoId?: string };
  snippet?: Snippet;
  statistics?: Stats;
  contentDetails?: { duration?: string; relatedPlaylists?: { uploads?: string }; videoId?: string };
  status?: { embeddable?: boolean; privacyStatus?: string };
};
type ApiError = { code?: number; message?: string; errors?: { reason?: string }[] };
type ListResponse<T> = { items?: T[]; nextPageToken?: string; pageInfo?: { totalResults?: number }; error?: ApiError };

type CommentSnippet = {
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  authorChannelUrl?: string;
  textDisplay?: string;
  textOriginal?: string;
  likeCount?: number;
  publishedAt?: string;
};
type CommentThread = { id?: string; snippet?: { totalReplyCount?: number; topLevelComment?: { id?: string; snippet?: CommentSnippet } } };

const str = (v: unknown, max = 100): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const ID = /^[A-Za-z0-9_-]{6,20}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{20,24}$/;
const num = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

// The API returns titles HTML-escaped ("&amp;", "&#39;").
const unescape = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** ISO 8601 duration ("PT1H2M3S") → seconds; null for live streams ("P0D") or unknown. */
const isoSeconds = (d: string | undefined): number | null => {
  const m = d ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d) : null;
  if (!m) return null;
  const s = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return s > 0 ? s : null;
};

const thumb = (t: Thumbs | undefined) => t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
const videoIdOf = (it: VideoItem) => (typeof it.id === 'string' ? it.id : it.id?.videoId);

const toVideo = (it: VideoItem) => {
  const id = videoIdOf(it);
  const s = it.snippet;
  if (!id || !s?.title) return null;
  return {
    id,
    title: unescape(s.title),
    channel: s.channelTitle ? unescape(s.channelTitle) : '',
    channelId: s.channelId ?? null,
    thumbnail: thumb(s.thumbnails),
    publishedAt: s.publishedAt ?? null,
    live: s.liveBroadcastContent === 'live',
    views: num(it.statistics?.viewCount),
    likes: num(it.statistics?.likeCount),
    comments: num(it.statistics?.commentCount),
    durationSec: isoSeconds(it.contentDetails?.duration),
  };
};
type Video = NonNullable<ReturnType<typeof toVideo>>;

const toDetails = (it: VideoItem) => {
  const v = toVideo(it);
  if (!v) return null;
  return {
    ...v,
    description: it.snippet?.description ?? '',
    tags: (it.snippet?.tags ?? []).slice(0, 12),
    commentsHidden: it.statistics !== undefined && it.statistics.commentCount === undefined,
    embeddable: it.status?.embeddable !== false,
  };
};

/* ------------------------------------------------------------------ YouTube errors */

class YouTubeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function mapError(status: number, e: ApiError | undefined): YouTubeError {
  const reason = e?.errors?.[0]?.reason ?? '';
  const message = e?.message ?? `YouTube request failed (${status})`;
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded' || reason === 'rateLimitExceeded')
    return new YouTubeError(429, 'quota_exceeded', 'YouTube’s daily limit for Zoyra has been reached. Try again tomorrow.');
  if (reason === 'commentsDisabled') return new YouTubeError(403, 'comments_disabled', 'Comments are turned off for this video.');
  if (reason === 'videoNotFound' || reason === 'channelNotFound' || reason === 'playlistNotFound' || status === 404)
    return new YouTubeError(404, 'not_found', 'That video is no longer available.');
  if (reason === 'keyInvalid' || reason === 'accessNotConfigured') return new YouTubeError(503, 'not_configured', message);
  if (status === 400) return new YouTubeError(400, 'bad_request', message);
  return new YouTubeError(502, 'youtube_failed', message);
}

/* ------------------------------------------------------------------ cache (public.youtube_cache) */

const db = adminClient();
const memory = new Map<string, { at: number; ttl: number; body: unknown }>();

async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memory.get(key);
  if (hit && now - hit.at < hit.ttl * 1000) return hit.body as T;
  if (db) {
    const { data } = await db.from('youtube_cache').select('body, expires_at').eq('key', key).maybeSingle();
    if (data && new Date(data.expires_at as string).getTime() > now) {
      memory.set(key, { at: now, ttl: Math.min(ttlSec, 300), body: data.body });
      return data.body as T;
    }
  }
  const body = await load();
  memory.set(key, { at: now, ttl: ttlSec, body });
  if (memory.size > 500) memory.delete(memory.keys().next().value as string);
  if (db) {
    await db
      .from('youtube_cache')
      .upsert({ key, body, expires_at: new Date(now + ttlSec * 1000).toISOString() })
      .then(
        () => undefined,
        () => undefined,
      );
  }
  return body;
}

/* ------------------------------------------------------------------ API calls */

async function call<T>(apiKey: string, path: string, params: Record<string, string | undefined>): Promise<ListResponse<T>> {
  const qs = new URLSearchParams({ key: apiKey });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  const res = await fetch(`${API}/${path}?${qs.toString()}`);
  const data = (await res.json().catch(() => ({}))) as ListResponse<T>;
  if (!res.ok || data.error) throw mapError(res.status, data.error);
  return data;
}

/** videos.list for up to 50 ids, embeddable only, in the given order. */
async function videosById(apiKey: string, ids: string[]): Promise<VideoItem[]> {
  if (!ids.length) return [];
  const data = await call<VideoItem>(apiKey, 'videos', { part: 'snippet,statistics,contentDetails,status', id: ids.slice(0, 50).join(','), maxResults: '50' });
  const byId = new Map((data.items ?? []).map((it) => [videoIdOf(it), it]));
  return ids.flatMap((id) => {
    const it = byId.get(id);
    return it && it.status?.embeddable !== false ? [it] : [];
  });
}

/** search.list (100 units) then videos.list (1 unit) so every result has real counts and duration. */
async function searchVideos(
  apiKey: string,
  p: { q?: string; region: string; pageToken?: string; duration?: string; eventType?: string; channelId?: string; max?: number },
) {
  const data = await call<VideoItem>(apiKey, 'search', {
    part: 'snippet',
    type: 'video',
    maxResults: String(p.max ?? 20),
    regionCode: p.region,
    videoCategoryId: MUSIC_CATEGORY,
    videoEmbeddable: 'true', // only videos the owner allows in third-party players
    videoSyndicated: 'true', // only videos playable outside youtube.com
    safeSearch: 'moderate',
    q: p.q,
    pageToken: p.pageToken,
    videoDuration: p.duration,
    eventType: p.eventType,
    channelId: p.channelId,
  });
  const ids = (data.items ?? [])
    .filter((it) => p.eventType === 'live' || it.snippet?.liveBroadcastContent !== 'upcoming')
    .map(videoIdOf)
    .filter((id): id is string => !!id);
  const full = await videosById(apiKey, ids);
  return { videos: full.map(toVideo).filter((v): v is Video => v !== null), ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
}

const SHORT_MAX_SEC = 180;

/* ------------------------------------------------------------------ handler */

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const apiKey = Deno.env.get('YOUTUBE_API_KEY');
  if (!apiKey) return notConfigured('youtube');

  const body = (await readJson(req)) ?? {};
  const q = str(body.q);
  const region = /^[A-Za-z]{2}$/.test(String(body.region ?? '')) ? String(body.region).toUpperCase() : 'IN';
  const pageToken = str(body.pageToken, 200);
  // Old clients send { q } without an action.
  const action = str(body.action, 20) ?? (q ? 'search' : 'chart');
  const page = pageToken ?? '';

  try {
    switch (action) {
      case 'chart': {
        const out = await cached(`chart:${region}:${page}`, 3600, async () => {
          const data = await call<VideoItem>(apiKey, 'videos', {
            part: 'snippet,statistics,contentDetails,status',
            chart: 'mostPopular',
            videoCategoryId: MUSIC_CATEGORY,
            regionCode: region,
            maxResults: '25',
            pageToken,
          });
          const videos = (data.items ?? [])
            .filter((it) => it.status?.embeddable !== false)
            .map(toVideo)
            .filter((v): v is Video => v !== null);
          return { videos, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
        });
        return json(out);
      }

      case 'search': {
        if (!q || q.length < 2) return error(400, 'bad_request', { message: 'Type at least 2 characters.' });
        const duration = ['short', 'medium', 'long'].includes(String(body.duration)) ? String(body.duration) : undefined;
        const out = await cached(`search:${region}:${duration ?? ''}:${q.toLowerCase()}:${page}`, 6 * 3600, () =>
          searchVideos(apiKey, { q, region, pageToken, duration }),
        );
        return json(out);
      }

      case 'shorts': {
        const query = q ?? 'music #shorts';
        const out = await cached(`shorts:${region}:${query.toLowerCase()}:${page}`, 3 * 3600, async () => {
          const r = await searchVideos(apiKey, { q: query, region, pageToken, duration: 'short', max: 25 });
          return { ...r, videos: r.videos.filter((v) => v.durationSec !== null && v.durationSec <= SHORT_MAX_SEC) };
        });
        return json(out);
      }

      case 'live': {
        const query = q ?? 'music live';
        const out = await cached(`live:${region}:${query.toLowerCase()}:${page}`, 900, () => searchVideos(apiKey, { q: query, region, pageToken, eventType: 'live' }));
        return json(out);
      }

      case 'related': {
        if (!q) return error(400, 'bad_request', { message: 'related needs q (title or channel).' });
        const videoId = str(body.videoId, 20);
        const out = await cached(`related:${region}:${q.toLowerCase()}`, 12 * 3600, () => searchVideos(apiKey, { q, region, max: 15 }));
        return json({ videos: out.videos.filter((v) => v.id !== videoId) });
      }

      case 'details': {
        const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 50);
        if (!ids.length) return error(400, 'bad_request', { message: 'details needs ids.' });
        const out = await cached(`details:${ids.join(',')}`, 600, async () => {
          const data = await call<VideoItem>(apiKey, 'videos', { part: 'snippet,statistics,contentDetails,status', id: ids.join(','), maxResults: '50' });
          const videos = (data.items ?? []).map(toDetails).filter((v) => v !== null);
          let channel: { id: string; title: string; thumbnail: string | null; subscribers: number | null } | null = null;
          const cid = ids.length === 1 ? videos[0]?.channelId : null;
          if (cid) {
            const ch = await call<VideoItem>(apiKey, 'channels', { part: 'snippet,statistics', id: cid });
            const it = ch.items?.[0];
            if (it?.snippet?.title)
              channel = {
                id: cid,
                title: unescape(it.snippet.title),
                thumbnail: thumb(it.snippet.thumbnails),
                subscribers: it.statistics?.hiddenSubscriberCount ? null : num(it.statistics?.subscriberCount),
              };
          }
          return { videos, channel };
        });
        if (ids.length === 1 && !out.videos.length) return error(404, 'not_found', { message: 'That video is no longer available.' });
        return json(out);
      }

      case 'comments': {
        const videoId = str(body.videoId, 20);
        if (!videoId || !ID.test(videoId)) return error(400, 'bad_request', { message: 'comments needs videoId.' });
        const order = body.order === 'time' ? 'time' : 'relevance';
        const out = await cached(`comments:${videoId}:${order}:${page}`, order === 'time' ? 300 : 1800, async () => {
          const data = await call<CommentThread>(apiKey, 'commentThreads', {
            part: 'snippet',
            videoId,
            order,
            maxResults: '25',
            textFormat: 'plainText',
            pageToken,
          });
          const comments = (data.items ?? []).flatMap((t) => {
            const c = t.snippet?.topLevelComment;
            const s = c?.snippet;
            const text = s?.textOriginal ?? s?.textDisplay;
            if (!c?.id || !s || !text) return [];
            return [
              {
                id: c.id,
                author: s.authorDisplayName ?? '',
                authorAvatar: s.authorProfileImageUrl ?? null,
                text: text.slice(0, 2000),
                likes: s.likeCount ?? 0,
                publishedAt: s.publishedAt ?? null,
                replies: t.snippet?.totalReplyCount ?? 0,
              },
            ];
          });
          return { comments, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
        });
        return json(out);
      }

      case 'uploads': {
        const channelIds = (Array.isArray(body.channelIds) ? body.channelIds : [])
          .filter((x): x is string => typeof x === 'string' && CHANNEL_ID.test(x))
          .slice(0, 10);
        if (!channelIds.length) return json({ videos: [] });
        const shortsOnly = body.shortsOnly === true;
        const out = await cached(`uploads:${shortsOnly ? 's' : 'a'}:${[...channelIds].sort().join(',')}`, 3 * 3600, async () => {
          const ch = await call<VideoItem>(apiKey, 'channels', { part: 'contentDetails', id: channelIds.join(','), maxResults: '50' });
          const playlists = (ch.items ?? []).map((it) => it.contentDetails?.relatedPlaylists?.uploads).filter((p): p is string => !!p);
          const lists = await Promise.all(
            playlists.map((playlistId) =>
              call<VideoItem>(apiKey, 'playlistItems', { part: 'contentDetails', playlistId, maxResults: '15' }).catch(() => ({ items: [] }) as ListResponse<VideoItem>),
            ),
          );
          const ids = lists.flatMap((l) => (l.items ?? []).map((it) => it.contentDetails?.videoId)).filter((id): id is string => !!id && ID.test(id));
          const chunks: string[][] = [];
          for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
          const full = (await Promise.all(chunks.map((c) => videosById(apiKey, c)))).flat();
          const videos = full
            .map(toVideo)
            .filter((v): v is Video => v !== null && !v.live)
            .filter((v) => !shortsOnly || (v.durationSec !== null && v.durationSec <= SHORT_MAX_SEC))
            .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
          return { videos };
        });
        return json(out);
      }

      default:
        return error(400, 'bad_request', { message: `Unknown action "${action}".` });
    }
  } catch (e) {
    if (e instanceof YouTubeError) return error(e.status, e.code, { message: e.message, ...(e.code === 'not_configured' ? { service: 'youtube' } : {}) });
    return error(502, 'youtube_failed', { message: errMessage(e) });
  }
});
