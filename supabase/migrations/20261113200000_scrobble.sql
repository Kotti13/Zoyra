-- Zoyra phase 5: scrobbling accounts (Last.fm + ListenBrainz).
--
-- One row per (user, service). `secret` is the Last.fm session key or the ListenBrainz user token.
-- It never appears in profiles or any public view; only the owner (and the service role) can read it.
--  * ListenBrainz: the app validates the token with ListenBrainz, then upserts its own row.
--  * Last.fm: rows are written only by the `lastfm` edge function (service role) after auth.getSession.
--    The session key is useless without the shared secret, which lives only in the function.
create table public.scrobble_accounts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  service text not null check (service in ('lastfm', 'listenbrainz')),
  username text not null check (char_length(username) between 1 and 100),
  secret text not null check (char_length(secret) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, service)
);

alter table public.scrobble_accounts enable row level security;

create policy "own scrobble accounts readable" on public.scrobble_accounts for select to authenticated
  using (user_id = auth.uid());
create policy "own listenbrainz insert" on public.scrobble_accounts for insert to authenticated
  with check (user_id = auth.uid() and service = 'listenbrainz');
create policy "own listenbrainz update" on public.scrobble_accounts for update to authenticated
  using (user_id = auth.uid() and service = 'listenbrainz')
  with check (user_id = auth.uid() and service = 'listenbrainz');
create policy "own scrobble accounts delete" on public.scrobble_accounts for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.scrobble_accounts from anon;
