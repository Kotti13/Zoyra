-- Zoyra phase 12: entertainment.
--
-- "My tickets": Zoyra doesn't sell tickets. Listeners mark Ticketmaster events they're interested in;
-- the purchase link opens on Ticketmaster. `event` is the ConcertEvent JSON returned by the
-- `concerts` edge function (name, date, venue, city, url, prices) so the list renders offline of the
-- API and after the listing expires.

create table public.event_interests (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  event_id text not null check (char_length(event_id) between 1 and 200),
  event jsonb not null check (jsonb_typeof(event) = 'object' and pg_column_size(event) <= 8192),
  event_date timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);

create index event_interests_user_date_idx on public.event_interests (user_id, event_date);

alter table public.event_interests enable row level security;

create policy "own interests readable" on public.event_interests for select to authenticated
  using (user_id = auth.uid());
create policy "insert own interests" on public.event_interests for insert to authenticated
  with check (user_id = auth.uid());
create policy "delete own interests" on public.event_interests for delete to authenticated
  using (user_id = auth.uid());

revoke all on public.event_interests from anon;
