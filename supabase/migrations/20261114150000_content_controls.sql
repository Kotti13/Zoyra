-- Zoyra phase 11 (Agent ST1): content controls.
--
-- Hidden artists and songs: rows here are skipped by the client when it builds lists and queues
-- (src/lib/content-filter.ts). Ids are Audius catalogue ids (text), so there is no foreign key to a
-- local table. `name` / `image` are a display snapshot for the Content controls screen.
--
-- Only the owner can read or change their rows.

create table public.hidden_content (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('artist', 'track')),
  item_id text not null check (char_length(item_id) between 1 and 64),
  name text not null default '' check (char_length(name) <= 200),
  subtitle text not null default '' check (char_length(subtitle) <= 200),
  image text check (image is null or char_length(image) <= 1000),
  created_at timestamptz not null default now(),
  primary key (user_id, kind, item_id)
);

alter table public.hidden_content enable row level security;

create policy "own hidden content read" on public.hidden_content
  for select to authenticated using (user_id = auth.uid());
create policy "own hidden content insert" on public.hidden_content
  for insert to authenticated with check (user_id = auth.uid());
create policy "own hidden content update" on public.hidden_content
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own hidden content delete" on public.hidden_content
  for delete to authenticated using (user_id = auth.uid());

-- At most 2000 hidden items per person (keeps the client-side filter set small).
create or replace function public.hidden_content_limit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.hidden_content where user_id = new.user_id) >= 2000 then
    raise exception 'You can hide up to 2000 artists and songs' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke execute on function public.hidden_content_limit() from public, anon, authenticated;

create trigger hidden_content_limit before insert on public.hidden_content
  for each row execute function public.hidden_content_limit();
