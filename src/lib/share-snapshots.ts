import { profileShareUrl, shareContent, snapshotShareUrl } from './share-links';
import { supabase } from './supabase';

/**
 * Public share pages for stats (web: /s/<token>). Tapping Share stores a small, sanitised copy of what the
 * screen showed (server whitelists keys and trims text, see 20261118100000_share_snapshots.sql) under a random
 * token; the link shows it on the web without an account. Private accounts' names are never shown.
 */
export type SnapshotKind = 'w' | 'm' | 'i' | 'd' | 'b';
type Genre = { n: string; p: number };
export type SnapshotPayload = {
  w: { dist: number; dur: number; steps?: number | null; wk: 'run' | 'walk'; tempo?: string | null; on?: string; songs: string[] };
  m: { me: string; you: string; pct: number; artists: string[]; genres: Genre[] };
  i: { per: 'week' | 'month' | 'year'; min: number; plays: number; delta?: string | null; artists: string[]; genres: Genre[] };
  d: { genres: Genre[] };
  b: { got: number; total: number; names: string[] };
};

export async function createShareSnapshot<K extends SnapshotKind>(kind: K, payload: SnapshotPayload[K]): Promise<string> {
  const { data, error } = await supabase.rpc('create_share_snapshot', { p_kind: kind, p_payload: payload });
  if (error || typeof data !== 'string') throw new Error(error?.message ?? 'Could not create the share link');
  return snapshotShareUrl(data);
}

/**
 * Creates the snapshot link and opens the share sheet with it. If the backend is unreachable or not updated yet,
 * falls back to the sharer's profile link so sharing never fails.
 */
export async function shareSnapshot<K extends SnapshotKind>(opts: {
  kind: K;
  payload: SnapshotPayload[K];
  title: string;
  message: string;
  me: { id?: string; username?: string | null };
}): Promise<void> {
  let url: string;
  try {
    url = await createShareSnapshot(opts.kind, opts.payload);
  } catch {
    url = profileShareUrl({ id: opts.me.id ?? '', username: opts.me.username });
  }
  await shareContent({ url, title: opts.title, message: opts.message });
}
