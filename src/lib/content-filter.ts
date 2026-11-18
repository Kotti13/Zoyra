import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useAuth } from '../state/auth';
import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';

/**
 * Content controls: hidden artists / songs (table `hidden_content`, migration
 * 20261114150000_content_controls.sql) and the kid-safe explicit filter.
 *
 * One app-wide store per signed-in user, so lists, the player and the Content controls screen all
 * see the same set. Synchronous helpers (`isTrackHidden`, `filterHidden`) work outside React.
 */

export type HiddenKind = 'artist' | 'track';
export type HiddenItem = { kind: HiddenKind; id: string; name: string; subtitle: string; image: string | null; hiddenAt: string };

type Row = { kind: HiddenKind; item_id: string; name: string; subtitle: string; image: string | null; created_at: string };

type Snapshot = {
  userId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  items: HiddenItem[];
  artists: ReadonlySet<string>;
  tracks: ReadonlySet<string>;
};

const EMPTY_SET: ReadonlySet<string> = new Set();
let snap: Snapshot = { userId: null, status: 'idle', error: null, items: [], artists: EMPTY_SET, tracks: EMPTY_SET };
const listeners = new Set<() => void>();

function commit(next: Partial<Snapshot>) {
  const items = next.items ?? snap.items;
  snap = {
    ...snap,
    ...next,
    items,
    artists: next.items ? new Set(items.filter((i) => i.kind === 'artist').map((i) => i.id)) : snap.artists,
    tracks: next.items ? new Set(items.filter((i) => i.kind === 'track').map((i) => i.id)) : snap.tracks,
  };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getSnapshot = () => snap;

const toItem = (r: Row): HiddenItem => ({ kind: r.kind, id: r.item_id, name: r.name, subtitle: r.subtitle, image: r.image, hiddenAt: r.created_at });

function friendly(e: unknown, fallback: string) {
  const msg = e && typeof e === 'object' && 'message' in e && typeof e.message === 'string' ? e.message : '';
  if (/hidden_content/.test(msg) && /does not exist|schema cache/i.test(msg)) return 'Hiding isn’t set up on the server yet.';
  return msg || fallback;
}

/** Loads (or reloads) the hidden list for `userId`. `null` clears it (signed out). */
export async function loadHidden(userId: string | null): Promise<void> {
  if (!userId) {
    commit({ userId: null, status: 'idle', error: null, items: [] });
    return;
  }
  if (snap.userId !== userId) commit({ userId, status: 'loading', error: null, items: [] });
  else commit({ status: 'loading', error: null });
  const { data, error } = await supabase
    .from('hidden_content')
    .select('kind, item_id, name, subtitle, image, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (snap.userId !== userId) return; // signed out / switched meanwhile
  if (error) {
    commit({ status: 'error', error: friendly(error, 'Could not load hidden items') });
    return;
  }
  commit({ status: 'ready', items: ((data ?? []) as Row[]).map(toItem) });
}

/* ------------------------------------------------------------------ synchronous checks */

export const isArtistHidden = (artistId: string | undefined) => !!artistId && snap.artists.has(artistId);
export const isSongHidden = (trackId: string | undefined) => !!trackId && snap.tracks.has(trackId);

/** True when the user hid this song or its artist. */
export const isTrackHidden = (t: Pick<CatalogTrack, 'id' | 'artist'>) => snap.tracks.has(t.id) || snap.artists.has(t.artist.id);

/**
 * Explicit check. Audius exposes no reliable rating (`parental_warning_type` is null on nearly every
 * track), so this uses an `explicit` flag when the catalogue mapper provides one, otherwise the
 * artist's own title / tags ("explicit", "nsfw").
 */
export function looksExplicit(t: CatalogTrack): boolean {
  const flagged = (t as CatalogTrack & { explicit?: boolean }).explicit;
  if (flagged === true) return true;
  if (/\b(explicit|nsfw)\b/i.test(t.title)) return true;
  return (t.tags ?? []).some((tag) => /^(explicit|nsfw)$/i.test(tag.trim()));
}

/** Drops hidden songs / artists, and explicit-looking songs when `hideExplicit` is on. */
export function filterHidden<T extends CatalogTrack>(tracks: readonly T[], hideExplicit = false): T[] {
  if (!snap.artists.size && !snap.tracks.size && !hideExplicit) return tracks as T[];
  return tracks.filter((t) => !isTrackHidden(t) && !(hideExplicit && looksExplicit(t)));
}

/* ------------------------------------------------------------------ writes (optimistic) */

async function add(item: Omit<HiddenItem, 'hiddenAt'>) {
  const userId = snap.userId;
  if (!userId) throw new Error('Sign in to hide songs and artists');
  const before = snap.items;
  if (before.some((i) => i.kind === item.kind && i.id === item.id)) return;
  commit({ items: [{ ...item, hiddenAt: new Date().toISOString() }, ...before] });
  const { error } = await supabase
    .from('hidden_content')
    .upsert({ user_id: userId, kind: item.kind, item_id: item.id, name: item.name.slice(0, 200), subtitle: item.subtitle.slice(0, 200), image: item.image }, { onConflict: 'user_id,kind,item_id' });
  if (error) {
    if (snap.userId === userId) commit({ items: before });
    throw new Error(friendly(error, 'Could not hide that'));
  }
}

export function hideArtist(a: { id: string; name: string; image?: string | null }) {
  return add({ kind: 'artist', id: a.id, name: a.name, subtitle: 'Artist', image: a.image ?? null });
}

export function hideSong(t: CatalogTrack) {
  return add({ kind: 'track', id: t.id, name: t.title, subtitle: t.artist.name, image: t.artwork.small ?? t.artwork.medium ?? null });
}

export async function unhide(kind: HiddenKind, id: string) {
  const userId = snap.userId;
  if (!userId) return;
  const before = snap.items;
  commit({ items: before.filter((i) => !(i.kind === kind && i.id === id)) });
  const { error } = await supabase.from('hidden_content').delete().eq('user_id', userId).eq('kind', kind).eq('item_id', id);
  if (error) {
    if (snap.userId === userId) commit({ items: before });
    throw new Error(friendly(error, 'Could not unhide that'));
  }
}

/* ------------------------------------------------------------------ hook */

/**
 * Live hidden list + kid-safe flag for the signed-in user. Loads on first use per user.
 * `kidSafe` is `user_settings.privacy.hide_explicit` (the same switch as Family plan → Kid-safe mode).
 */
export function useContentFilter() {
  const { user, settings, updateSettings } = useAuth();
  const userId = user?.id ?? null;
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (snap.userId !== userId || snap.status === 'idle') void loadHidden(userId);
  }, [userId]);

  const kidSafe = (settings?.privacy?.hide_explicit ?? false) || settings?.kids?.on === true;
  const setKidSafe = useCallback(
    async (on: boolean) => {
      if (!settings) throw new Error('Settings are still loading');
      await updateSettings({ privacy: { ...settings.privacy, hide_explicit: on } });
    },
    [settings, updateSettings],
  );

  const current = s.userId === userId;
  // New function identities whenever the store changes, so lists memoised on them re-filter.
  const filter = useCallback(
    <T extends CatalogTrack>(tracks: readonly T[]): T[] => tracks.filter((t) => !s.tracks.has(t.id) && !s.artists.has(t.artist.id) && !(kidSafe && looksExplicit(t))),
    [kidSafe, s],
  );
  const isHidden = useCallback((t: Pick<CatalogTrack, 'id' | 'artist'>) => s.tracks.has(t.id) || s.artists.has(t.artist.id), [s]);

  return useMemo(
    () => ({
      items: current ? s.items : [],
      hiddenArtists: current ? s.artists : EMPTY_SET,
      hiddenTracks: current ? s.tracks : EMPTY_SET,
      loading: !!userId && (!current || s.status === 'loading' || s.status === 'idle'),
      error: current ? s.error : null,
      reload: () => loadHidden(userId),
      kidSafe,
      setKidSafe,
      isHidden,
      filter,
      hideArtist,
      hideSong,
      unhide,
    }),
    // `s` changes whenever the store does, so consumers re-filter with fresh sets
    [s, current, userId, kidSafe, setKidSafe, filter, isHidden],
  );
}
