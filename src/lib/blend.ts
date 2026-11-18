import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

/**
 * Blend: one playlist from your listening and a friend's. Reads both people's `play_history` for the last
 * 90 days. A friend's rows come back only when the server allows it (you follow them, their Listening
 * activity setting is on, nobody blocked anybody), so a private friend simply yields an empty side.
 * The picker lists mutual follows only.
 */
export type BlendPerson = { id: string; display_name: string; avatar_url: string | null };
export type BlendSource = 'me' | 'both' | 'them';
export type BlendTrack = { track: CatalogTrack; source: BlendSource };
export type BlendResult = { other: BlendPerson; match: number; tracks: BlendTrack[]; myPlays: number; theirPlays: number; sharedArtists: number };

type Row = { track: CatalogTrack };

/** People who follow you and you follow back. */
export async function listMutualFriends(me: string): Promise<BlendPerson[]> {
  const [a, b] = await Promise.all([
    supabase.from('follows').select('following_id').eq('follower_id', me).limit(500),
    supabase.from('follows').select('follower_id').eq('following_id', me).limit(500),
  ]);
  if (a.error) throw new Error(a.error.message);
  if (b.error) throw new Error(b.error.message);
  const followers = new Set(((b.data ?? []) as { follower_id: string }[]).map((r) => r.follower_id));
  const ids = ((a.data ?? []) as { following_id: string }[]).map((r) => r.following_id).filter((id) => followers.has(id)).slice(0, 60);
  if (!ids.length) return [];
  const p = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', ids);
  if (p.error) throw new Error(p.error.message);
  return ((p.data ?? []) as BlendPerson[]).sort((x, y) => x.display_name.localeCompare(y.display_name));
}

function counts(rows: Row[], key: (t: CatalogTrack) => string | undefined) {
  const m = new Map<string, number>();
  rows.forEach((r) => {
    const k = r.track ? key(r.track) : undefined;
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  });
  return m;
}

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

/** Pure: builds the Blend from both histories. */
export function buildBlend(other: BlendPerson, mine: Row[], theirs: Row[], limit = 30): BlendResult {
  const ta = counts(mine, (t) => t.id);
  const tb = counts(theirs, (t) => t.id);
  const aa = counts(mine, (t) => t.artist?.id);
  const ab = counts(theirs, (t) => t.artist?.id);
  const ga = counts(mine, (t) => t.genre);
  const gb = counts(theirs, (t) => t.genre);
  const match = mine.length && theirs.length ? 0.5 * cosine(aa, ab) + 0.5 * cosine(ga, gb) : 0;
  const sharedArtists = [...aa.keys()].filter((k) => ab.has(k)).length;

  const info = new Map<string, CatalogTrack>();
  [...mine, ...theirs].forEach((r) => r.track?.id && !info.has(r.track.id) && info.set(r.track.id, r.track));
  const rank = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);

  const both = [...ta.keys()].filter((id) => tb.has(id)).sort((x, y) => (tb.get(y) ?? 0) + (ta.get(y) ?? 0) - ((tb.get(x) ?? 0) + (ta.get(x) ?? 0)));
  const onlyMine = rank(ta).filter((id) => !tb.has(id));
  const onlyTheirs = rank(tb).filter((id) => !ta.has(id));

  const out: BlendTrack[] = [];
  const push = (id: string | undefined, source: BlendSource) => {
    const track = id ? info.get(id) : undefined;
    if (track && out.length < limit) out.push({ track, source });
  };
  both.forEach((id) => push(id, 'both'));
  for (let i = 0; out.length < limit && (i < onlyMine.length || i < onlyTheirs.length); i++) {
    push(onlyMine[i], 'me');
    push(onlyTheirs[i], 'them');
  }
  return { other, match, tracks: out, myPlays: mine.length, theirPlays: theirs.length, sharedArtists };
}

export async function loadBlend(me: string, other: BlendPerson): Promise<BlendResult> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const q = (uid: string) => supabase.from('play_history').select('track').eq('user_id', uid).gte('played_at', since).order('played_at', { ascending: false }).limit(1000);
  const [mine, theirs] = await Promise.all([q(me), q(other.id)]);
  if (mine.error) throw new Error(mine.error.message);
  if (theirs.error) throw new Error(theirs.error.message);
  return buildBlend(other, (mine.data ?? []) as Row[], (theirs.data ?? []) as Row[]);
}
