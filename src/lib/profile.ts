import type { CatalogTrack } from './catalog';
import { CUSTOM_COLS, parseCustom, type ProfileCustom } from './profile-custom';
import { supabase } from './supabase';

/**
 * Data for the profile hub: Profile (Overview), ProfileActivity, ProfilePlaylists, ProfileTaste,
 * ProfileMore and PublicProfile. Everything comes from Supabase (play_history, follows, playlists,
 * achievements, liked_tracks, dedications). Nothing is invented.
 */

export type Person = { id: string; display_name: string; username: string | null; avatar_url: string | null; avatar_art?: string | null };
export type PublicPerson = Person & { bio: string; is_private: boolean; plan: string; created_at: string };

type PgError = { message: string } | null;
const fail = (e: PgError) => {
  if (e) throw new Error(e.message);
};

export { initialOf, profileLink } from './profile-custom';

/** Only real image URIs; anything else (preset avatar schemes etc.) falls back to the initial. */
export const isImageUri = (u: string | null | undefined): u is string => !!u && /^(https?:|file:|data:image\/)/.test(u);


/* ------------------------------------------------------------------ time helpers */

export function timeAgo(iso: string | Date, now = Date.now()) {
  const t = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.round(d / 7);
  return w < 5 ? `${w}w ago` : new Date(t).toLocaleDateString();
}

const localDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY = 86_400_000;

export const fmtMinutes = (m: number) => {
  const h = Math.floor(m / 60);
  return h ? `${h}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`;
};

/* ------------------------------------------------------------------ overview */

export type TopArtist = { id: string; name: string; image?: string; plays: number };

export type Overview = {
  followers: number;
  following: number;
  plays: number;
  streak: number;
  topArtists: TopArtist[];
  last: { track: CatalogTrack; played_at: string } | null;
};

type LightRow = { artist: { id?: string; name?: string; image?: string } | null };

export async function loadOverview(uid: string): Promise<Overview> {
  const since30 = new Date(Date.now() - 30 * DAY).toISOString();
  const [followers, following, total, streak, hist, last] = await Promise.all([
    supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', uid),
    supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', uid),
    supabase.from('play_history').select('id', { count: 'exact', head: true }).eq('user_id', uid),
    supabase.rpc('listening_streak', { uid }),
    supabase.from('play_history').select('artist:track->artist').eq('user_id', uid).gte('played_at', since30).limit(5000),
    supabase.from('play_history').select('played_at, track').eq('user_id', uid).order('played_at', { ascending: false }).limit(1),
  ]);
  fail(followers.error ?? following.error ?? total.error ?? streak.error ?? hist.error ?? last.error);

  const month = new Map<string, TopArtist>();
  for (const r of (hist.data ?? []) as unknown as Pick<LightRow, 'artist'>[]) {
    const a = r.artist;
    const key = a?.id ?? a?.name;
    if (!a || !key) continue;
    const cur = month.get(key);
    if (cur) cur.plays++;
    else month.set(key, { id: a.id ?? '', name: a.name ?? 'Unknown artist', image: a.image, plays: 1 });
  }
  const lastRow = (last.data?.[0] ?? null) as { played_at: string; track: CatalogTrack } | null;

  return {
    followers: followers.count ?? 0,
    following: following.count ?? 0,
    plays: total.count ?? 0,
    streak: Number(streak.data) || 0,
    topArtists: [...month.values()].sort((a, b) => b.plays - a.plays).slice(0, 10),
    last: lastRow?.track?.id ? lastRow : null,
  };
}

/* ------------------------------------------------------------------ activity feed */

export type ActivityKind = 'listening' | 'playlists' | 'social' | 'badges' | 'library';
export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  meta: string;
  at: number;
  cover?: { uri?: string | null; id: string };
  track?: CatalogTrack;
  playlistId?: string;
  personId?: string;
};

const KIND_LABEL: Record<ActivityKind, string> = { listening: 'Listening', playlists: 'Playlist', social: 'Social', badges: 'Badge', library: 'Library' };

const humanize = (key: string) => key.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

type ActivityRows = {
  plays: { played_at: string; track: CatalogTrack }[];
  created: { id: string; title: string; cover_url: string | null; created_at: string }[];
  added: { added_at: string; playlist: { id: string; title: string; cover_url: string | null } | null }[];
  follows: { created_at: string; following: Person | null }[];
  badges: { key: string; unlocked_at: string }[];
  likes: { created_at: string; track: CatalogTrack }[];
  dedications: { created_at: string; track: CatalogTrack; recipient: Pick<Person, 'id' | 'display_name'> | null }[];
};

/** Last 30 days of your own activity, newest first. Sources that fail are skipped unless all fail. */
export async function loadActivity(uid: string): Promise<ActivityItem[]> {
  const since = new Date(Date.now() - 30 * DAY).toISOString();
  const res = await Promise.all([
    supabase.from('play_history').select('played_at, track').eq('user_id', uid).gte('played_at', since).order('played_at', { ascending: false }).limit(1500),
    supabase.from('playlists').select('id, title, cover_url, created_at').eq('owner_id', uid).gte('created_at', since),
    supabase.from('playlist_tracks').select('added_at, playlist:playlists(id, title, cover_url)').eq('added_by', uid).gte('added_at', since).limit(1000),
    supabase.from('follows').select('created_at, following:profiles!follows_following_id_fkey(id, display_name, username, avatar_url)').eq('follower_id', uid).gte('created_at', since),
    supabase.from('achievements').select('key, unlocked_at').eq('user_id', uid).gte('unlocked_at', since),
    supabase.from('liked_tracks').select('created_at, track').eq('user_id', uid).gte('created_at', since).limit(500),
    supabase.from('dedications').select('created_at, track, recipient:profiles!dedications_recipient_id_fkey(id, display_name)').eq('sender_id', uid).gte('created_at', since),
  ]);
  const errors = res.map((r) => r.error).filter(Boolean);
  if (errors.length === res.length) fail(errors[0] ?? null);
  const pick = <K extends keyof ActivityRows>(i: number) => (res[i].error ? [] : (res[i].data ?? [])) as unknown as ActivityRows[K];
  const rows: ActivityRows = {
    plays: pick<'plays'>(0),
    created: pick<'created'>(1),
    added: pick<'added'>(2),
    follows: pick<'follows'>(3),
    badges: pick<'badges'>(4),
    likes: pick<'likes'>(5),
    dedications: pick<'dedications'>(6),
  };
  const items: ActivityItem[] = [];
  const now = Date.now();
  const meta = (kind: ActivityKind, at: number, extra?: string) => `${extra ?? KIND_LABEL[kind]} · ${timeAgo(new Date(at), now)}`;

  // Listening: per day, the 3 most played songs, then a roll-up of the rest.
  const byDay = new Map<number, Map<string, { track: CatalogTrack; count: number; last: number }>>();
  for (const p of rows.plays) {
    if (!p.track?.id) continue;
    const t = new Date(p.played_at).getTime();
    const day = localDay(new Date(t));
    const m = byDay.get(day) ?? new Map();
    byDay.set(day, m);
    const cur = m.get(p.track.id);
    if (cur) cur.count++;
    else m.set(p.track.id, { track: p.track, count: 1, last: t });
  }
  byDay.forEach((m, day) => {
    const list = [...m.values()].sort((a, b) => b.count - a.count || b.last - a.last);
    list.slice(0, 3).forEach((e) =>
      items.push({
        id: `play-${day}-${e.track.id}`,
        kind: 'listening',
        title: e.count >= 3 ? `Listened to ${e.track.title} on repeat` : `Listened to ${e.track.title}`,
        meta: meta('listening', e.last, `${e.count} ${e.count === 1 ? 'play' : 'plays'}`),
        at: e.last,
        cover: { uri: e.track.artwork?.small ?? e.track.artwork?.medium, id: e.track.id },
        track: e.track,
      }),
    );
    const rest = list.slice(3);
    if (rest.length) {
      const at = Math.max(...rest.map((e) => e.last));
      items.push({ id: `play-rest-${day}`, kind: 'listening', title: `Listened to ${rest.length} more ${rest.length === 1 ? 'song' : 'songs'}`, meta: meta('listening', at), at });
    }
  });

  for (const p of rows.created) {
    const at = new Date(p.created_at).getTime();
    items.push({ id: `pl-${p.id}`, kind: 'playlists', title: `Created ${p.title}`, meta: meta('playlists', at), at, cover: { uri: p.cover_url, id: p.id }, playlistId: p.id });
  }

  const adds = new Map<string, { title: string; cover: string | null; pid: string; count: number; at: number }>();
  for (const a of rows.added) {
    if (!a.playlist) continue;
    const t = new Date(a.added_at).getTime();
    const key = `${localDay(new Date(t))}-${a.playlist.id}`;
    const cur = adds.get(key);
    if (cur) {
      cur.count++;
      cur.at = Math.max(cur.at, t);
    } else adds.set(key, { title: a.playlist.title, cover: a.playlist.cover_url, pid: a.playlist.id, count: 1, at: t });
  }
  adds.forEach((a, key) =>
    items.push({
      id: `add-${key}`,
      kind: 'playlists',
      title: `Added ${a.count} ${a.count === 1 ? 'song' : 'songs'} to ${a.title}`,
      meta: meta('playlists', a.at),
      at: a.at,
      cover: { uri: a.cover, id: a.pid },
      playlistId: a.pid,
    }),
  );

  for (const f of rows.follows) {
    if (!f.following) continue;
    const at = new Date(f.created_at).getTime();
    items.push({ id: `follow-${f.following.id}`, kind: 'social', title: `Started following ${f.following.display_name}`, meta: meta('social', at), at, personId: f.following.id });
  }

  for (const d of rows.dedications) {
    const at = new Date(d.created_at).getTime();
    const to = d.recipient?.display_name ?? 'a friend';
    items.push({
      id: `ded-${d.created_at}`,
      kind: 'social',
      title: `Dedicated ${d.track?.title ?? 'a song'} to ${to}`,
      meta: meta('social', at, 'Share'),
      at,
      cover: d.track?.id ? { uri: d.track.artwork?.small, id: d.track.id } : undefined,
      personId: d.recipient?.id,
    });
  }

  for (const b of rows.badges) {
    const at = new Date(b.unlocked_at).getTime();
    items.push({ id: `badge-${b.key}`, kind: 'badges', title: `Earned the ${humanize(b.key)} badge`, meta: meta('badges', at), at });
  }

  const likesByDay = new Map<number, { tracks: CatalogTrack[]; at: number }>();
  for (const l of rows.likes) {
    const t = new Date(l.created_at).getTime();
    const day = localDay(new Date(t));
    const cur = likesByDay.get(day) ?? { tracks: [], at: t };
    cur.tracks.push(l.track);
    cur.at = Math.max(cur.at, t);
    likesByDay.set(day, cur);
  }
  likesByDay.forEach((l, day) => {
    const one = l.tracks.length === 1 ? l.tracks[0] : undefined;
    items.push({
      id: `like-${day}`,
      kind: 'library',
      title: one ? `Liked ${one.title}` : `Liked ${l.tracks.length} songs`,
      meta: meta('library', l.at),
      at: l.at,
      cover: one?.id ? { uri: one.artwork?.small, id: one.id } : undefined,
      track: one,
    });
  });

  return items.sort((a, b) => b.at - a.at);
}

/** "Today", "Yesterday", "Earlier this week", "Earlier". */
export function activityBucket(at: number, now = new Date()) {
  const today = localDay(now);
  const day = localDay(new Date(at));
  if (day === today) return 'Today';
  if (day === today - DAY || Math.round((today - day) / DAY) === 1) return 'Yesterday';
  if (today - day < 7 * DAY) return 'Earlier this week';
  return 'Earlier';
}

/* ------------------------------------------------------------------ taste */

export type Taste = {
  plays: number;
  genres: { name: string; share: number }[];
  topTracks: { track: CatalogTrack; plays: number }[];
  artists: number;
  genreCount: number;
  streak: number;
  week: number[];
  weekMinutes: number;
};

type InsightsRpc = { minutes: number; by_day: { day: string; minutes: number }[] };

/** Minutes for each of the last 7 days (oldest first, today last). */
function lastSevenDays(byDay: InsightsRpc['by_day']) {
  const map = new Map(byDay.map((d) => [d.day.slice(0, 10), Number(d.minutes) || 0]));
  const now = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (6 - i)));
    return map.get(d.toISOString().slice(0, 10)) ?? 0;
  });
}

export async function loadTaste(uid: string): Promise<Taste> {
  const since = new Date(Date.now() - 90 * DAY).toISOString();
  const [hist, streak, week] = await Promise.all([
    supabase.from('play_history').select('track').eq('user_id', uid).gte('played_at', since).order('played_at', { ascending: false }).limit(3000),
    supabase.rpc('listening_streak', { uid }),
    supabase.rpc('listening_insights', { days: 7 }),
  ]);
  fail(hist.error ?? streak.error ?? week.error);
  const tracks = ((hist.data ?? []) as { track: CatalogTrack }[]).map((r) => r.track).filter((t) => !!t?.id);
  const genres = new Map<string, number>();
  const artists = new Set<string>();
  const counts = new Map<string, { track: CatalogTrack; plays: number }>();
  for (const t of tracks) {
    if (t.genre) genres.set(t.genre, (genres.get(t.genre) ?? 0) + 1);
    if (t.artist?.id || t.artist?.name) artists.add(t.artist.id || t.artist.name);
    const c = counts.get(t.id);
    if (c) c.plays++;
    else counts.set(t.id, { track: t, plays: 1 });
  }
  const total = tracks.length || 1;
  const w = (week.data as InsightsRpc | null) ?? { minutes: 0, by_day: [] };
  return {
    plays: tracks.length,
    genres: [...genres.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, n]) => ({ name, share: n / total })),
    topTracks: [...counts.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
    artists: artists.size,
    genreCount: genres.size,
    streak: Number(streak.data) || 0,
    week: lastSevenDays(w.by_day ?? []),
    weekMinutes: Number(w.minutes) || 0,
  };
}

/* ------------------------------------------------------------------ public profile */

export type PlaylistCard = { id: string; title: string; cover_url: string | null; track_count: number };

export type PublicProfileData = {
  person: PublicPerson;
  custom: ProfileCustom;
  followers: number;
  following: number;
  playlistCount: number;
  iFollow: boolean;
  followsMe: boolean;
  blockedWith: boolean;
  /** Private profiles hide playlists, listening and taste from people who don't follow them. */
  visible: boolean;
  playlists: PlaylistCard[];
  mutual: Person[];
  mutualCount: number;
  /** Their latest play, only when their privacy settings let you see it (RLS). */
  latest: { track: CatalogTrack; played_at: string; live: boolean } | null;
  match: { value: number; sharedGenres: string[]; sharedArtists: string[] } | null;
};

const PERSON = 'id, display_name, username, avatar_url';

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((v, k) => {
    na += v * v;
    dot += v * (b.get(k) ?? 0);
  });
  b.forEach((v) => (nb += v * v));
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function tally(tracks: CatalogTrack[], key: (t: CatalogTrack) => string | undefined) {
  const m = new Map<string, number>();
  tracks.forEach((t) => {
    const k = key(t);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  });
  return m;
}

export async function loadPublicProfile(id: string, me: string): Promise<PublicProfileData | null> {
  const base = `${PERSON}, bio, is_private, plan, created_at`;
  let p = await supabase.from('profiles').select(`${base}, ${CUSTOM_COLS}`).eq('id', id).maybeSingle();
  // Customisation columns arrive with migration 20261113210000_profile_custom; work without them.
  if (p.error && /column|schema cache/i.test(p.error.message)) p = await supabase.from('profiles').select(base).eq('id', id).maybeSingle();
  fail(p.error);
  if (!p.data) return null;
  const person = p.data as unknown as PublicPerson;
  const custom = parseCustom(p.data);

  const [followers, following, iFollow, followsMe, blocked, myFollowing] = await Promise.all([
    supabase.from('follows').select('follower_id', { count: 'exact', head: true }).eq('following_id', id),
    supabase.from('follows').select('following_id', { count: 'exact', head: true }).eq('follower_id', id),
    supabase.from('follows').select('following_id').eq('follower_id', me).eq('following_id', id).maybeSingle(),
    supabase.from('follows').select('following_id').eq('follower_id', id).eq('following_id', me).maybeSingle(),
    supabase.rpc('blocked_with', { other: id }),
    supabase.from('follows').select('following_id').eq('follower_id', me).limit(1000),
  ]);
  fail(followers.error ?? following.error ?? iFollow.error ?? followsMe.error ?? myFollowing.error);
  // blocked_with may be missing on an older server; treat as not blocked.
  const blockedWith = !blocked.error && blocked.data === true;
  const amFollowing = !!iFollow.data;
  const visible = !blockedWith && (!person.is_private || amFollowing);

  // Mutual: people you follow who also follow them.
  const mine = ((myFollowing.data ?? []) as { following_id: string }[]).map((r) => r.following_id).filter((x) => x !== id);
  let mutual: Person[] = [];
  let mutualCount = 0;
  if (mine.length && !blockedWith) {
    const m = await supabase.from('follows').select(`follower:profiles!follows_follower_id_fkey(${PERSON})`, { count: 'exact' }).eq('following_id', id).in('follower_id', mine).limit(6);
    if (!m.error) {
      mutual = ((m.data ?? []) as unknown as { follower: Person | null }[]).map((r) => r.follower).filter((x): x is Person => !!x);
      const arts = await loadAvatarArts(mutual.map((x) => x.id));
      mutual = mutual.map((x) => ({ ...x, avatar_art: arts.get(x.id) ?? null }));
      mutualCount = m.count ?? mutual.length;
    }
  }

  let playlists: PlaylistCard[] = [];
  let playlistCount = 0;
  let latest: PublicProfileData['latest'] = null;
  let match: PublicProfileData['match'] = null;
  if (visible) {
    const since = new Date(Date.now() - 90 * DAY).toISOString();
    const [pl, last, theirs, ours] = await Promise.all([
      supabase.from('playlists').select('id, title, cover_url, playlist_tracks(count)', { count: 'exact' }).eq('owner_id', id).eq('visibility', 'public').order('updated_at', { ascending: false }).limit(12),
      supabase.from('play_history').select('played_at, track').eq('user_id', id).order('played_at', { ascending: false }).limit(1),
      supabase.from('play_history').select('track').eq('user_id', id).gte('played_at', since).limit(1000),
      supabase.from('play_history').select('track').eq('user_id', me).gte('played_at', since).limit(1000),
    ]);
    fail(pl.error);
    type PlRow = { id: string; title: string; cover_url: string | null; playlist_tracks: { count: number }[] | null };
    playlists = ((pl.data ?? []) as unknown as PlRow[]).map((r) => ({ id: r.id, title: r.title, cover_url: r.cover_url, track_count: r.playlist_tracks?.[0]?.count ?? 0 }));
    playlistCount = pl.count ?? playlists.length;
    const l = (last.data?.[0] ?? null) as { played_at: string; track: CatalogTrack } | null;
    latest = !last.error && l?.track?.id ? { ...l, live: Date.now() - new Date(l.played_at).getTime() < 10 * 60_000 } : null;
    const a = ((ours.data ?? []) as { track: CatalogTrack }[]).map((r) => r.track).filter(Boolean);
    const b = ((theirs.data ?? []) as { track: CatalogTrack }[]).map((r) => r.track).filter(Boolean);
    if (!theirs.error && !ours.error && a.length && b.length) {
      const aa = tally(a, (t) => t.artist?.id);
      const ab = tally(b, (t) => t.artist?.id);
      const ga = tally(a, (t) => t.genre);
      const gb = tally(b, (t) => t.genre);
      const names = new Map(b.map((t) => [t.artist?.id, t.artist?.name]));
      match = {
        value: 0.5 * cosine(aa, ab) + 0.5 * cosine(ga, gb),
        sharedGenres: [...ga.keys()].filter((g) => gb.has(g)).sort((x, y) => (gb.get(y) ?? 0) + (ga.get(y) ?? 0) - (gb.get(x) ?? 0) - (ga.get(x) ?? 0)).slice(0, 2),
        sharedArtists: [...aa.keys()].filter((k) => ab.has(k)).map((k) => names.get(k) ?? '').filter(Boolean).slice(0, 2),
      };
    }
  }

  return {
    person,
    custom,
    followers: followers.count ?? 0,
    following: following.count ?? 0,
    playlistCount,
    iFollow: amFollowing,
    followsMe: !!followsMe.data,
    blockedWith,
    visible,
    playlists,
    mutual,
    mutualCount,
    latest,
    match,
  };
}

/** Another user's public playlists (for ProfilePlaylists with ?id=). Respects is_private for non-followers. */
export async function loadPublicPlaylists(id: string, me: string): Promise<{ person: Person; playlists: PlaylistCard[]; hidden: boolean }> {
  const [p, f] = await Promise.all([
    supabase.from('profiles').select(`${PERSON}, is_private`).eq('id', id).maybeSingle(),
    supabase.from('follows').select('following_id').eq('follower_id', me).eq('following_id', id).maybeSingle(),
  ]);
  fail(p.error ?? f.error);
  if (!p.data) throw new Error('This profile no longer exists');
  const person = p.data as Person & { is_private: boolean };
  if (person.is_private && !f.data) return { person, playlists: [], hidden: true };
  const pl = await supabase.from('playlists').select('id, title, cover_url, playlist_tracks(count)').eq('owner_id', id).eq('visibility', 'public').order('updated_at', { ascending: false });
  fail(pl.error);
  type PlRow = { id: string; title: string; cover_url: string | null; playlist_tracks: { count: number }[] | null };
  return {
    person,
    hidden: false,
    playlists: ((pl.data ?? []) as unknown as PlRow[]).map((r) => ({ id: r.id, title: r.title, cover_url: r.cover_url, track_count: r.playlist_tracks?.[0]?.count ?? 0 })),
  };
}

/**
 * Preset avatar gradients (`avatar_art`) for a set of people, keyed by id. Returns an empty map
 * when the customisation migration isn't applied yet, so callers just fall back to stable gradients.
 */
export async function loadAvatarArts(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return out;
  const { data, error } = await supabase.from('profiles').select('id, avatar_art').in('id', unique.slice(0, 500));
  if (error) return out;
  for (const r of (data ?? []) as { id: string; avatar_art: string | null }[]) if (r.avatar_art) out.set(r.id, r.avatar_art);
  return out;
}

/* ------------------------------------------------------------------ change events */

/** A profile-level change made on another screen or sheet (block/unblock, follow) that open profiles should reflect. */
export type ProfileChange = { id: string; blocked?: boolean };
const changeListeners = new Set<(c: ProfileChange) => void>();

/** Tell open profile screens that something about person `id` changed. */
export function emitProfileChange(c: ProfileChange) {
  changeListeners.forEach((l) => l(c));
}

/** Subscribe to profile changes; returns the unsubscribe function (use as an effect cleanup). */
export function onProfileChange(listener: (c: ProfileChange) => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
