// new-releases: hourly check for new tracks from artists people follow (Audius catalogue).
// NO user JWT: called by pg_cron through pg_net (public.run_new_releases_job) with the
// `x-webhook-secret` header, verified against PUSH_WEBHOOK_SECRET (same Vault secret as push).
//
// Each run takes the stalest followed artists (round robin), fetches their newest tracks
// (`/v1/users/{id}/tracks?sort=date`, same shape as src/lib/catalog.ts), and for every follower
// notifies tracks released after that user's last check (or after they followed the artist).
// Idempotent: public.notify_new_release keeps a (user, track) ledger, so overlapping or repeated
// runs never notify twice.
//
// POST { limit?: number } → { artists, notified, followers, errors }
import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, safeEqual } from '../_shared/http.ts';
import { webhookSecret } from '../_shared/webhook.ts';

const BASE = 'https://api.audius.co/v1';
const APP = 'zoyra';
/** Artists polled per run (hourly → ~600 artists a day). */
const ARTISTS_PER_RUN = 25;
/** Pause between Audius calls, to stay polite with the public API. */
const DELAY_MS = 300;
/** Newest tracks fetched per artist. */
const TRACKS_PER_ARTIST = 10;
/** At most this many release notifications per artist per user per run (newest first). */
const MAX_PER_USER_ARTIST = 3;
const FOLLOWER_PAGE = 1000;
const MAX_FOLLOWERS = 10_000;

type RawTrack = {
  id: string;
  title: string;
  user?: { id?: string; name?: string };
  release_date?: string | null;
  created_at?: string | null;
  artwork?: Partial<Record<'150x150' | '480x480' | '1000x1000', string>> | null;
  is_streamable?: boolean;
  is_stream_gated?: boolean;
  stream_conditions?: unknown;
  is_delete?: boolean;
  is_unlisted?: boolean;
};

type Release = { id: string; title: string; at: number; artwork: string | null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const playable = (t: RawTrack) => t.is_streamable !== false && !t.is_stream_gated && !t.stream_conditions && !t.is_delete && !t.is_unlisted;

const releasedAt = (t: RawTrack): number | null => {
  for (const v of [t.release_date, t.created_at]) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
};

async function newestTracks(artistId: string): Promise<Release[]> {
  const qs = new URLSearchParams({ app_name: APP, sort: 'date', limit: String(TRACKS_PER_ARTIST) });
  const res = await fetch(`${BASE}/users/${encodeURIComponent(artistId)}/tracks?${qs.toString()}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Audius ${res.status}`);
  const body = (await res.json()) as { data?: RawTrack[] };
  const now = Date.now();
  const out: Release[] = [];
  for (const t of Array.isArray(body.data) ? body.data : []) {
    if (!t?.id || !playable(t)) continue;
    const at = releasedAt(t);
    if (at === null || at > now) continue; // scheduled for the future: not out yet
    out.push({ id: t.id, title: t.title, at, artwork: t.artwork?.['480x480'] ?? t.artwork?.['150x150'] ?? null });
  }
  return out.sort((a, b) => b.at - a.at);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const secret = await webhookSecret();
  if (!secret) return notConfigured('new-releases');
  if (!safeEqual(req.headers.get('x-webhook-secret') ?? '', secret)) return error(401, 'unauthorized');

  const admin = adminClient();
  if (!admin) return notConfigured('supabase');

  const body = await readJson(req);
  const limit = typeof body?.limit === 'number' && body.limit > 0 ? Math.min(Math.floor(body.limit), 100) : ARTISTS_PER_RUN;

  try {
    const { data: due, error: dueErr } = await admin.rpc('new_release_due_artists', { p_limit: limit });
    if (dueErr) throw dueErr;
    const artists = (due ?? []) as { artist_id: string; artist_name: string | null }[];

    let notified = 0;
    let followers = 0;
    const errors: { artist_id: string; message: string }[] = [];

    for (let i = 0; i < artists.length; i++) {
      const { artist_id: artistId, artist_name: artistName } = artists[i];
      if (i > 0) await sleep(DELAY_MS);
      let lastError: string | null = null;
      try {
        const releases = await newestTracks(artistId);

        // Followers of this artist (with when they followed) and their last-seen state.
        const follows: { user_id: string; created_at: string }[] = [];
        for (let from = 0; from < MAX_FOLLOWERS; from += FOLLOWER_PAGE) {
          const { data, error: e } = await admin
            .from('followed_artists')
            .select('user_id, created_at')
            .eq('artist_id', artistId)
            .order('user_id')
            .range(from, from + FOLLOWER_PAGE - 1);
          if (e) throw e;
          follows.push(...((data ?? []) as { user_id: string; created_at: string }[]));
          if (!data || data.length < FOLLOWER_PAGE) break;
        }
        followers += follows.length;

        const { data: checks, error: checkErr } = await admin.from('new_release_checks').select('user_id, last_seen_at').eq('artist_id', artistId);
        if (checkErr) throw checkErr;
        const seen = new Map<string, number>(((checks ?? []) as { user_id: string; last_seen_at: string }[]).map((c) => [c.user_id, Date.parse(c.last_seen_at)]));

        const newest = releases[0]?.at ?? 0;
        const updates: { user_id: string; artist_id: string; last_seen_at: string; checked_at: string }[] = [];
        const nowIso = new Date().toISOString();

        for (const f of follows) {
          const baseline = seen.get(f.user_id) ?? Date.parse(f.created_at);
          const fresh = releases.filter((r) => r.at > baseline).slice(0, MAX_PER_USER_ARTIST);
          for (const r of fresh.reverse()) {
            const { data: ok, error: nErr } = await admin.rpc('notify_new_release', {
              p_user: f.user_id,
              p_artist_id: artistId,
              p_artist_name: artistName ?? '',
              p_track_id: r.id,
              p_track_title: r.title,
              p_artwork: r.artwork,
            });
            if (nErr) throw nErr;
            if (ok === true) notified++;
          }
          updates.push({ user_id: f.user_id, artist_id: artistId, last_seen_at: new Date(Math.max(baseline, newest)).toISOString(), checked_at: nowIso });
        }

        for (let j = 0; j < updates.length; j += 500) {
          const { error: upErr } = await admin.from('new_release_checks').upsert(updates.slice(j, j + 500), { onConflict: 'user_id,artist_id' });
          if (upErr) throw upErr;
        }
      } catch (e) {
        lastError = errMessage(e).slice(0, 300);
        errors.push({ artist_id: artistId, message: lastError });
      }
      // Advance the cursor even on failure so one broken artist can't stall the queue.
      await admin.from('new_release_artists').upsert({ artist_id: artistId, checked_at: new Date().toISOString(), last_error: lastError }, { onConflict: 'artist_id' });
    }

    return json({ artists: artists.length, followers, notified, errors });
  } catch (e) {
    return error(502, 'new_releases_failed', { message: errMessage(e) });
  }
});
