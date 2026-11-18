import { router } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import type { Artist, CatalogTrack } from '../lib/catalog';
import { supabase } from '../lib/supabase';
import { useAuth } from './auth';
import { FLASH, flash } from '../lib/flash';

export type UserPlaylist = {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  cover_url: string | null;
  visibility: 'public' | 'private' | 'collaborative';
  is_ai: boolean;
  ai_prompt: string | null;
  created_at: string;
  updated_at: string;
  track_count?: number;
};

type LibraryState = {
  liked: CatalogTrack[];
  isLiked: (trackId: string) => boolean;
  toggleLike: (track: CatalogTrack) => Promise<void>;
  playlists: UserPlaylist[];
  createPlaylist: (input: { title: string; description?: string; visibility?: UserPlaylist['visibility']; is_ai?: boolean; ai_prompt?: string }) => Promise<UserPlaylist>;
  deletePlaylist: (id: string) => Promise<void>;
  /** Rename / edit description / visibility / cover of a playlist you own (or collaborate on, for name & description). */
  updatePlaylist: (id: string, patch: Partial<Pick<UserPlaylist, 'title' | 'description' | 'visibility' | 'cover_url'>>) => Promise<void>;
  addToPlaylist: (playlistId: string, tracks: CatalogTrack[]) => Promise<void>;
  removeFromPlaylist: (rowId: string) => Promise<void>;
  followedArtists: Artist[];
  isFollowingArtist: (artistId: string) => boolean;
  toggleFollowArtist: (artist: Artist) => Promise<void>;
  reload: () => Promise<void>;
};

const Ctx = createContext<LibraryState | null>(null);

/** User library backed by Supabase, kept live with Realtime (changes from other devices show up instantly). */
export function LibraryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [liked, setLiked] = useState<CatalogTrack[]>([]);
  const [playlists, setPlaylists] = useState<UserPlaylist[]>([]);
  const [followedArtists, setFollowed] = useState<Artist[]>([]);

  const reload = useCallback(async () => {
    if (!user) {
      setLiked([]);
      setPlaylists([]);
      setFollowed([]);
      return;
    }
    const [l, p, f] = await Promise.all([
      supabase.from('liked_tracks').select('track').eq('user_id', user.id).order('created_at', { ascending: false }),
      // Only playlists I own or collaborate on (RLS also lets me *read* other people's public playlists).
      supabase
        .from('playlist_collaborators')
        .select('playlist_id')
        .eq('user_id', user.id)
        .then(({ data }) => {
          const collab = (data ?? []).map((r) => r.playlist_id as string);
          const filter = collab.length ? `owner_id.eq.${user.id},id.in.(${collab.join(',')})` : `owner_id.eq.${user.id}`;
          return supabase.from('playlists').select('*, playlist_tracks(count)').or(filter).order('updated_at', { ascending: false });
        }),
      supabase.from('followed_artists').select('artist').eq('user_id', user.id).order('created_at', { ascending: false }),
    ]);
    setLiked((l.data ?? []).map((r) => r.track as CatalogTrack));
    setPlaylists(
      (p.data ?? []).map((r) => {
        const { playlist_tracks, ...rest } = r as UserPlaylist & { playlist_tracks: { count: number }[] };
        return { ...rest, track_count: playlist_tracks?.[0]?.count ?? 0 };
      }),
    );
    setFollowed((f.data ?? []).map((r) => r.artist as Artist));
  }, [user]);

  useEffect(() => {
    void reload();
    if (!user) return;
    const ch = supabase
      .channel(`library:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'liked_tracks', filter: `user_id=eq.${user.id}` }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlists', filter: `owner_id=eq.${user.id}` }, () => void reload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playlist_tracks' }, () => void reload())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [user, reload]);

  const likedIds = useMemo(() => new Set(liked.map((t) => t.id)), [liked]);
  const followedIds = useMemo(() => new Set(followedArtists.map((a) => a.id)), [followedArtists]);

  const value = useMemo<LibraryState>(
    () => ({
      liked,
      isLiked: (id) => likedIds.has(id),
      toggleLike: async (track) => {
        if (track.id.startsWith('local:')) return; // device files never go to the server
        if (!user) {
          flash('Sign in to like songs');
          router.push('/login');
          return;
        } // device files never go to the server
        if (likedIds.has(track.id)) {
          setLiked((l) => l.filter((t) => t.id !== track.id));
          await supabase.from('liked_tracks').delete().eq('user_id', user.id).eq('track_id', track.id);
          flash(FLASH.unliked);
        } else {
          setLiked((l) => [track, ...l]);
          await supabase.from('liked_tracks').insert({ user_id: user.id, track_id: track.id, track });
          flash(FLASH.liked);
        }
      },
      playlists,
      createPlaylist: async (input) => {
        if (!user) throw new Error('Sign in to create playlists');
        const { data, error } = await supabase
          .from('playlists')
          .insert({ owner_id: user.id, title: input.title, description: input.description ?? '', visibility: input.visibility ?? 'public', is_ai: input.is_ai ?? false, ai_prompt: input.ai_prompt ?? null })
          .select()
          .single();
        if (error) throw new Error(error.message);
        await reload();
        return data as UserPlaylist;
      },
      updatePlaylist: async (id, patch) => {
        if (!user) throw new Error('Sign in to edit playlists');
        const clean: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (patch.title !== undefined) {
          const t = patch.title.trim();
          if (!t) throw new Error('Give your playlist a name');
          clean.title = t.slice(0, 100);
        }
        if (patch.description !== undefined) clean.description = patch.description.trim().slice(0, 300);
        if (patch.visibility !== undefined) clean.visibility = patch.visibility;
        if (patch.cover_url !== undefined) clean.cover_url = patch.cover_url;
        const { error } = await supabase.from('playlists').update(clean).eq('id', id);
        if (error) throw new Error(error.message);
        await reload();
      },
      deletePlaylist: async (id) => {
        await supabase.from('playlists').delete().eq('id', id);
        await reload();
      },
      addToPlaylist: async (playlistId, input) => {
        const tracks = input.filter((t) => !t.id.startsWith('local:')); // device files never go to the server
        if (!user || !tracks.length) return;
        const base = Date.now() / 1000;
        const { error } = await supabase
          .from('playlist_tracks')
          .insert(tracks.map((t, i) => ({ playlist_id: playlistId, track_id: t.id, track: t, position: base + i, added_by: user.id })));
        if (error) throw new Error(error.message);
        await supabase.from('playlists').update({ updated_at: new Date().toISOString() }).eq('id', playlistId);
      },
      removeFromPlaylist: async (rowId) => {
        await supabase.from('playlist_tracks').delete().eq('id', rowId);
      },
      followedArtists,
      isFollowingArtist: (id) => followedIds.has(id),
      toggleFollowArtist: async (artist) => {
        if (!user) {
          flash('Sign in to follow artists');
          router.push('/login');
          return;
        }
        if (followedIds.has(artist.id)) {
          setFollowed((f) => f.filter((a) => a.id !== artist.id));
          await supabase.from('followed_artists').delete().eq('user_id', user.id).eq('artist_id', artist.id);
          flash(FLASH.unfollowed);
        } else {
          setFollowed((f) => [artist, ...f]);
          await supabase.from('followed_artists').insert({ user_id: user.id, artist_id: artist.id, artist });
          flash(`${FLASH.followed} ${artist.name}`);
        }
      },
      reload,
    }),
    [liked, likedIds, playlists, followedArtists, followedIds, user, reload],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLibrary() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLibrary must be used inside <LibraryProvider>');
  return v;
}
