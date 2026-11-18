-- Fix "playlist can't be saved".
--
-- createPlaylist inserts and immediately reads the row back (insert … returning / .select().single()).
-- The SELECT policy only used public.can_view_playlist(id), a STABLE SECURITY DEFINER function that
-- looks the playlist up by id. Inside the INSERT statement its snapshot can't see the brand-new row, so
-- it returned false and PostgREST failed the request with "new row violates row-level security policy".
-- Owners now pass on the row's own owner_id column (visible for the new row), and the update policy
-- gets a matching WITH CHECK so editing your own playlist never trips the same problem. A blocked
-- chat's Blend stays hidden (playlist_blend_blocked reads conversations, not playlists, so it also
-- works for the new row).

drop policy if exists "view playlists" on public.playlists;
create policy "view playlists" on public.playlists for select to authenticated
  using ((owner_id = auth.uid() and not public.playlist_blend_blocked(id)) or public.can_view_playlist(id));

drop policy if exists "edit playlists" on public.playlists;
create policy "edit playlists" on public.playlists for update to authenticated
  using ((owner_id = auth.uid() and not public.playlist_blend_blocked(id)) or public.can_edit_playlist(id))
  with check ((owner_id = auth.uid() and not public.playlist_blend_blocked(id)) or public.can_edit_playlist(id));
