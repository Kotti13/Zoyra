// Server-side data for share cards. Mirrors the app's catalogue (src/lib/catalog.ts → Audius public
// API; `yt_` ids → Zoyra backend / YouTube oEmbed) and reads Supabase ONLY through the two
// anon-callable RPCs in supabase/migrations/20261115290000_share_cards.sql, which return public
// fields only (public playlists; private profiles come back as { is_private: true } with no data).

const TIMEOUT_MS = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UpstreamError extends Error {}

const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);

export const formatDuration = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return n ? `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}` : '';
};

export const formatCount = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(v);
};

const plural = (n, one, many = `${one}s`) => `${formatCount(n)} ${Number(n) === 1 ? one : many}`;

async function getJson(fetchImpl, url, init = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method: init.method, body: init.body, headers: { Accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(init.timeout ?? TIMEOUT_MS) });
  } catch (e) {
    throw new UpstreamError(`fetch failed: ${url.split('?')[0]} (${e?.name ?? 'error'})`);
  }
  const nullOn = init.nullOn ?? [400, 401, 403, 404];
  if (nullOn.includes(res.status)) return null;
  if (!res.ok) throw new UpstreamError(`upstream ${res.status}: ${url.split('?')[0]}`);
  try {
    return await res.json();
  } catch {
    throw new UpstreamError(`bad json: ${url.split('?')[0]}`);
  }
}

/* ------------------------------------------------------------------ Audius */

const audiusUrl = (cfg, path) => `${cfg.audiusApi}${path}${path.includes('?') ? '&' : '?'}app_name=zoyra`;

function pickArt(a, sizes) {
  for (const [key, w] of sizes) {
    const u = https(a?.[key]);
    if (u) return { url: u, width: w, height: w };
  }
  return null;
}
const COVER_SIZES = [
  ['1000x1000', 1000],
  ['480x480', 480],
  ['150x150', 150],
];

async function audiusTrack(cfg, f, id) {
  const json = await getJson(f, audiusUrl(cfg, `/tracks/${encodeURIComponent(id)}`));
  const t = json?.data;
  if (!t || t.is_delete || !t.title) return null;
  return {
    title: String(t.title).trim(),
    artist: t.user?.name ?? 'Unknown artist',
    duration: t.duration,
    genre: t.genre || '',
    plays: t.play_count ?? 0,
    image: pickArt(t.artwork, COVER_SIZES) ?? pickArt(t.user?.profile_picture, COVER_SIZES),
  };
}

async function audiusCollection(cfg, f, id) {
  const json = await getJson(f, audiusUrl(cfg, `/playlists/${encodeURIComponent(id)}`));
  const p = Array.isArray(json?.data) ? json.data[0] : json?.data;
  if (!p || p.is_delete || !p.playlist_name) return null;
  return {
    title: String(p.playlist_name).trim(),
    owner: p.user?.name ?? 'Unknown artist',
    isAlbum: !!p.is_album,
    description: (p.description ?? '').trim(),
    trackCount: p.track_count ?? 0,
    image: pickArt(p.artwork, COVER_SIZES),
  };
}

async function audiusUser(cfg, f, id) {
  const json = await getJson(f, audiusUrl(cfg, `/users/${encodeURIComponent(id)}`));
  const u = json?.data;
  if (!u || !u.name) return null;
  return {
    name: String(u.name).trim(),
    handle: u.handle ?? '',
    bio: (u.bio ?? '').trim(),
    followers: u.follower_count ?? 0,
    tracks: u.track_count ?? 0,
    verified: !!u.is_verified,
    image: pickArt(u.profile_picture, COVER_SIZES),
  };
}

/* ------------------------------------------------------------------ Zoyra backend / YouTube (`yt_` ids) */

async function youtubeTrack(cfg, f, vid) {
  const image = { url: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, width: 480, height: 360 };
  if (cfg.zoyraApi) {
    // Render's free plan can be asleep: short timeout, then fall back to oEmbed.
    const s = await getJson(f, `${cfg.zoyraApi}/api/song/${vid}`, { timeout: 2500 }).catch(() => null);
    if (s?.title) return { title: s.title, artist: s.artist || 'Unknown artist', duration: s.duration, genre: '', plays: s.views ?? 0, image };
  }
  const o = await getJson(f, `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vid}`)}`);
  if (!o?.title) return null;
  return { title: o.title, artist: o.author_name || 'Unknown artist', duration: 0, genre: '', plays: 0, image };
}

/* ------------------------------------------------------------------ Supabase (public RPCs only) */

async function rpc(cfg, f, fn, args) {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new UpstreamError('Supabase is not configured (SUPABASE_URL / SUPABASE_ANON_KEY)');
  const headers = { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey };
  // Legacy anon keys are JWTs and go in Authorization too; new sb_publishable_ keys only in `apikey`.
  if (!cfg.supabaseAnonKey.startsWith('sb_')) headers.Authorization = `Bearer ${cfg.supabaseAnonKey}`;
  const rows = await getJson(f, `${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), nullOn: [] }); // 401/404 = bad key or migration not applied → error, not "not found"
  return Array.isArray(rows) ? rows[0] ?? null : rows;
}

/* ------------------------------------------------------------------ cards */

/**
 * @typedef {{ url: string, width?: number, height?: number, alt?: string }} Img
 * @typedef {{
 *   kind: string, ogType: string, label: string, title: string, subtitle: string, description: string,
 *   image: Img | null, meta: string[], extraMeta: [string, string][], noindex: boolean,
 *   appPath: string, cache: 'catalog' | 'user', status?: number
 * }} Card
 */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const YT_RE = /^yt_([A-Za-z0-9_-]{6,20})$/;

/** Validate + decode the id from the URL. Returns null for anything suspicious. */
export function cleanId(kind, raw) {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  let id;
  try {
    id = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (kind === 'ar' && id.startsWith('yta_')) {
    const name = id.slice(4);
    return name.length >= 1 && name.length <= 120 && !/[\u0000-\u001f<>]/.test(name) ? id : null;
  }
  if (kind === 's') return /^[a-f0-9]{14}$/.test(id) ? id : null;
  if (kind === 'u') return /^@?[A-Za-z0-9_.]{3,30}$/.test(id) || UUID.test(id) ? id.replace(/^@/, '') : null;
  return ID_RE.test(id) ? id : null;
}

function trackCard(kind, id, t) {
  const lyric = kind === 'l';
  const dur = formatDuration(t.duration);
  return {
    kind,
    ogType: 'music.song',
    label: lyric ? 'Lyrics' : 'Song',
    title: t.title,
    subtitle: t.artist,
    description: lyric
      ? `Lyric card from “${t.title}” by ${t.artist}. Sing along with synced lyrics on Zoyra.`
      : `${t.title} by ${t.artist}${dur ? ` · ${dur}` : ''}${t.genre ? ` · ${t.genre}` : ''}. Listen on Zoyra.`,
    image: t.image ? { ...t.image, alt: `Cover art for ${t.title} by ${t.artist}` } : null,
    meta: [t.artist, dur, t.genre].filter(Boolean),
    extraMeta: t.duration ? [['music:duration', String(Math.round(t.duration))]] : [],
    noindex: false,
    appPath: `${kind}/${encodeURIComponent(id)}`,
    cache: 'catalog',
  };
}

/** Build the card for a share URL. `null` → 404. Throws UpstreamError on outages. */
export async function loadCard(kind, rawId, cfg, fetchImpl = fetch) {
  const id = cleanId(kind, rawId);
  if (!id) return null;
  const f = fetchImpl;

  switch (kind) {
    case 't':
    case 'l': {
      const yt = YT_RE.exec(id);
      const t = yt ? await youtubeTrack(cfg, f, yt[1]) : await audiusTrack(cfg, f, id);
      return t ? trackCard(kind, id, t) : null;
    }

    case 'a':
    case 'p': {
      if (kind === 'p' && UUID.test(id)) {
        const p = await rpc(cfg, f, 'share_playlist_card', { pid: id });
        if (!p) return null; // private, collaborative or deleted: indistinguishable on purpose
        const preview = Array.isArray(p.preview) ? p.preview.filter((x) => x?.title) : [];
        const art = https(p.cover_url) ?? (Array.isArray(p.artwork) ? p.artwork.map(https).find(Boolean) : null);
        const by = p.owner_name || 'a Zoyra listener';
        const featuring = preview.length ? ` Featuring ${preview.map((x) => (x.artist ? `${x.title} — ${x.artist}` : x.title)).join(', ')}.` : '';
        const desc = (p.description || '').trim();
        return {
          kind,
          ogType: 'music.playlist',
          label: 'Playlist',
          title: p.title,
          subtitle: `by ${by}`,
          description: `${desc ? `${desc.slice(0, 140)} · ` : ''}Playlist by ${by} · ${plural(p.track_count, 'song')}.${featuring}`,
          image: art ? { url: art, alt: `Cover of the playlist ${p.title}` } : null,
          meta: [`by ${by}`, plural(p.track_count, 'song')],
          extraMeta: [['music:song_count', String(p.track_count ?? 0)]],
          noindex: true,
          appPath: `p/${encodeURIComponent(id)}`,
          cache: 'user',
        };
      }
      const c = await audiusCollection(cfg, f, id);
      if (!c) return null;
      const album = kind === 'a' || c.isAlbum;
      return {
        kind,
        ogType: album ? 'music.album' : 'music.playlist',
        label: album ? 'Album' : 'Playlist',
        title: c.title,
        subtitle: c.owner,
        description: `${album ? 'Album' : 'Playlist'} by ${c.owner} · ${plural(c.trackCount, 'song')}.${c.description ? ` ${c.description.slice(0, 160)}` : ''} Listen on Zoyra.`,
        image: c.image ? { ...c.image, alt: `Cover of ${c.title} by ${c.owner}` } : null,
        meta: [c.owner, plural(c.trackCount, 'song')],
        extraMeta: [['music:song_count', String(c.trackCount)]],
        noindex: false,
        appPath: `${kind}/${encodeURIComponent(id)}`,
        cache: 'catalog',
      };
    }

    case 'ar': {
      if (id.startsWith('yta_')) {
        const name = id.slice(4);
        return {
          kind,
          ogType: 'profile',
          label: 'Artist',
          title: name,
          subtitle: 'Artist',
          description: `Listen to ${name} on Zoyra.`,
          image: null,
          meta: ['Artist'],
          extraMeta: [],
          noindex: false,
          appPath: `ar/${encodeURIComponent(id)}`,
          cache: 'catalog',
        };
      }
      const u = await audiusUser(cfg, f, id);
      if (!u) return null;
      return {
        kind,
        ogType: 'profile',
        label: 'Artist',
        title: u.name,
        subtitle: `${plural(u.followers, 'follower')} · ${plural(u.tracks, 'track')}`,
        description: `${u.name} on Zoyra · ${plural(u.followers, 'follower')} · ${plural(u.tracks, 'track')}.${u.bio ? ` ${u.bio.slice(0, 160)}` : ''}`,
        image: u.image ? { ...u.image, alt: `Photo of ${u.name}` } : null,
        meta: [plural(u.followers, 'follower'), plural(u.tracks, 'track')],
        extraMeta: u.handle ? [['profile:username', u.handle]] : [],
        noindex: false,
        appPath: `ar/${encodeURIComponent(id)}`,
        cache: 'catalog',
      };
    }

    case 'u': {
      const p = await rpc(cfg, f, 'share_profile_card', { lookup: id });
      if (!p) return null;
      if (p.is_private) {
        // Minimal card: no name, avatar, bio or counts for private profiles.
        return {
          kind,
          ogType: 'profile',
          label: 'Profile',
          title: 'Private profile',
          subtitle: 'This account is private',
          description: 'This Zoyra profile is private. Open Zoyra to see it if you follow them.',
          image: null,
          meta: [],
          extraMeta: [],
          noindex: true,
          appPath: `u/${encodeURIComponent(id)}`,
          cache: 'user',
        };
      }
      const name = p.display_name || 'Zoyra listener';
      const handle = p.username ? `@${p.username}` : '';
      const counts = [plural(p.followers, 'follower'), plural(p.public_playlists, 'playlist')];
      return {
        kind,
        ogType: 'profile',
        label: 'Profile',
        title: handle ? `${name} (${handle})` : name,
        subtitle: handle || 'On Zoyra',
        description: `${p.bio ? `${p.bio.slice(0, 160)} · ` : ''}${counts.join(' · ')} on Zoyra.`,
        image: https(p.avatar_url) ? { url: p.avatar_url, alt: `Profile picture of ${name}` } : null,
        meta: counts,
        extraMeta: p.username ? [['profile:username', p.username]] : [],
        noindex: true,
        appPath: `u/${encodeURIComponent(p.username || p.id || id)}`,
        cache: 'user',
      };
    }

    case 's': {
      const r = await rpc(cfg, f, 'share_snapshot_card', { tok: id });
      if (!r?.payload) return null;
      return snapshotCard(id, r);
    }

    default:
      return null;
  }
}

/* ------------------------------------------------------------------ snapshot cards (runs, taste, insights, badges) */

const txt = (v, n = 90) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
const list = (v) => (Array.isArray(v) ? v.map((x) => txt(x, 90)).filter(Boolean) : []);
const pairs = (v) => (Array.isArray(v) ? v.filter((x) => x && txt(x.n)).map((x) => ({ n: txt(x.n, 40), p: Math.max(0, Math.min(100, Math.round(Number(x.p) || 0))) })) : []);
const join = (a) => a.join(', ');

const clock = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** Pure: turns a sanitised snapshot row into a card. Exported for tests. */
export function snapshotCard(token, r) {
  const p = r.payload ?? {};
  const who = txt(r.owner_name, 60);
  const by = who || 'A Zoyra listener';
  const base = { ogType: 'website', image: https(r.owner_avatar) ? { url: r.owner_avatar, alt: `Profile picture of ${who}` } : null, extraMeta: [], noindex: true, appPath: `s/${token}`, cache: 'user' };
  switch (r.kind) {
    case 'w': {
      const km = (Number(p.dist) || 0) / 1000;
      const kmText = `${km.toFixed(km >= 10 ? 1 : 2)} km`;
      const pace = km > 0.05 && p.dur ? `${clock(p.dur / km)} /km` : '';
      const walk = p.wk === 'walk';
      const songs = list(p.songs);
      const meta = [kmText, clock(p.dur), pace, p.steps ? `${formatCount(p.steps)} steps` : '', txt(p.tempo, 40)].filter(Boolean);
      return {
        ...base,
        kind: 's',
        label: walk ? 'Walk' : 'Run',
        title: `${kmText} ${walk ? 'walk' : 'run'} with Zoyra`,
        subtitle: `${by}${p.on ? ` · ${p.on}` : ''}`,
        description: `${by} ${walk ? 'walked' : 'ran'} ${kmText} in ${clock(p.dur)}${pace ? ` (${pace})` : ''}.${songs.length ? ` Soundtrack: ${join(songs.slice(0, 3))}.` : ''}`,
        meta,
        songs,
        songsTitle: 'Soundtrack',
      };
    }
    case 'm': {
      const pct = Math.max(0, Math.min(100, Math.round(Number(p.pct) || 0)));
      const a = txt(p.me, 30) || by;
      const b = txt(p.you, 30) || 'a friend';
      const artists = list(p.artists);
      const genres = pairs(p.genres);
      return {
        ...base,
        kind: 's',
        label: 'Taste match',
        title: `${pct}% taste match`,
        subtitle: `${a} + ${b}`,
        description: `${a} and ${b} are a ${pct}% taste match on Zoyra.${artists.length ? ` Shared artists: ${join(artists)}.` : ''}`,
        meta: genres.map((g) => `${g.n} ${g.p}%`),
        songs: artists,
        songsTitle: 'Shared artists',
        ring: pct,
      };
    }
    case 'i': {
      const per = ['week', 'month', 'year'].includes(p.per) ? p.per : 'week';
      const mins = Number(p.min) || 0;
      const time = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;
      const artists = list(p.artists);
      const genres = pairs(p.genres);
      return {
        ...base,
        kind: 's',
        label: `This ${per}`,
        title: `${time} of music`,
        subtitle: `${by} · ${formatCount(p.plays)} plays`,
        description: `This ${per} on Zoyra: ${time} across ${formatCount(p.plays)} plays${artists[0] ? `, mostly ${artists[0]}` : ''}.`,
        meta: [txt(p.delta, 40), ...genres.map((g) => `${g.n} ${g.p}%`)].filter(Boolean),
        songs: artists,
        songsTitle: 'Top artists',
      };
    }
    case 'd': {
      const genres = pairs(p.genres);
      const top = genres.slice(0, 3).map((g) => `${g.n} ${g.p}%`);
      return {
        ...base,
        kind: 's',
        label: 'Taste DNA',
        title: genres[0] ? `${genres[0].n} ${genres[0].p}%` : 'Taste DNA',
        subtitle: by,
        description: `${by}’s Zoyra taste DNA${top.length ? `: ${join(top)}` : ''}.`,
        meta: genres.slice(1).map((g) => `${g.n} ${g.p}%`),
        bars: genres,
      };
    }
    case 'b': {
      const got = Number(p.got) || 0;
      const total = Number(p.total) || 0;
      const names = list(p.names);
      return {
        ...base,
        kind: 's',
        label: 'Badges',
        title: `${got} of ${total} badges`,
        subtitle: by,
        description: got ? `${by} unlocked ${got} of ${total} badges on Zoyra: ${join(names)}.` : `${by} is collecting badges on Zoyra. ${total} to go!`,
        meta: [],
        songs: names,
        songsTitle: 'Unlocked',
      };
    }
    default:
      return null;
  }
}
