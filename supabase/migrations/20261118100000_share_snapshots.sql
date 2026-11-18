-- Share snapshots: public web pages for items people share from the app (run summary, taste match,
-- listening insights, taste DNA, badges).
--
-- Privacy model: nothing is readable by id. When someone taps Share, the app calls create_share_snapshot,
-- which stores a SMALL, sanitised copy of exactly what was shown (whitelisted keys, truncated text) under a
-- random unguessable token owned by the sharer. The public page /s/<token> reads it through
-- share_snapshot_card(token) (anon-callable). Owners can delete their snapshots. A private profile's name and
-- avatar are never returned.
--
--   create_share_snapshot(kind, payload) -> token       authenticated; kinds w m i d b; rate limit 30/hour
--   share_snapshot_card(tok)             -> row         anon + authenticated; null when missing
--   delete_share_snapshot(tok)                           owner only

create table if not exists public.share_snapshots (
  token text primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('w', 'm', 'i', 'd', 'b')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists share_snapshots_owner_idx on public.share_snapshots (owner_id, created_at desc);

alter table public.share_snapshots enable row level security;
drop policy if exists share_snapshots_owner_read on public.share_snapshots;
create policy share_snapshots_owner_read on public.share_snapshots for select using (owner_id = auth.uid());
-- No insert/update/delete policies: writes go through the security-definer functions below.

-- text array from payload[key] (strings only), each cut to `len`, at most `n` items
create or replace function public._share_txts(p jsonb, k text, n int, len int) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(left(v, len)), '[]'::jsonb)
  from (select trim(value #>> '{}') as v from jsonb_array_elements(case when jsonb_typeof(p -> k) = 'array' then p -> k else '[]'::jsonb end) limit n) s
  where v <> '';
$$;

-- [{n: text, p: int}] pairs (genre shares), at most `n`
create or replace function public._share_pairs(p jsonb, k text, n int) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('n', left(e ->> 'n', 40), 'p', least(100, greatest(0, coalesce((e ->> 'p')::numeric, 0)))::int)), '[]'::jsonb)
  from (select value as e from jsonb_array_elements(case when jsonb_typeof(p -> k) = 'array' then p -> k else '[]'::jsonb end) limit n) s
  where coalesce(e ->> 'n', '') <> '' and (e ->> 'p') ~ '^[0-9]+(\.[0-9]+)?$';
$$;

create or replace function public._share_num(p jsonb, k text, lo numeric, hi numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when (p ->> k) ~ '^-?[0-9]+(\.[0-9]+)?$' then least(hi, greatest(lo, (p ->> k)::numeric)) else 0 end;
$$;

create or replace function public.create_share_snapshot(p_kind text, p_payload jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  clean jsonb;
  tok text;
begin
  if uid is null then raise exception 'not_authenticated'; end if;
  if p_kind not in ('w', 'm', 'i', 'd', 'b') then raise exception 'bad_kind'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or length(p_payload::text) > 8000 then raise exception 'bad_payload'; end if;
  if (select count(*) from share_snapshots where owner_id = uid and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate_limited';
  end if;

  clean := case p_kind
    when 'w' then jsonb_build_object(
      'dist', _share_num(p_payload, 'dist', 0, 1000000)::int,
      'dur', _share_num(p_payload, 'dur', 0, 360000)::int,
      'steps', _share_num(p_payload, 'steps', 0, 1000000)::int,
      'wk', case when p_payload ->> 'wk' = 'walk' then 'walk' else 'run' end,
      'tempo', left(coalesce(p_payload ->> 'tempo', ''), 40),
      'on', case when (p_payload ->> 'on') ~ '^\d{4}-\d{2}-\d{2}' then left(p_payload ->> 'on', 10) else null end,
      'songs', _share_txts(p_payload, 'songs', 5, 90))
    when 'm' then jsonb_build_object(
      'me', left(coalesce(p_payload ->> 'me', ''), 30),
      'you', left(coalesce(p_payload ->> 'you', ''), 30),
      'pct', _share_num(p_payload, 'pct', 0, 100)::int,
      'artists', _share_txts(p_payload, 'artists', 4, 50),
      'genres', _share_pairs(p_payload, 'genres', 3))
    when 'i' then jsonb_build_object(
      'per', case when p_payload ->> 'per' in ('week', 'month', 'year') then p_payload ->> 'per' else 'week' end,
      'min', _share_num(p_payload, 'min', 0, 10000000)::int,
      'plays', _share_num(p_payload, 'plays', 0, 10000000)::int,
      'delta', left(coalesce(p_payload ->> 'delta', ''), 40),
      'artists', _share_txts(p_payload, 'artists', 5, 50),
      'genres', _share_pairs(p_payload, 'genres', 4))
    when 'd' then jsonb_build_object('genres', _share_pairs(p_payload, 'genres', 6))
    else jsonb_build_object(
      'got', _share_num(p_payload, 'got', 0, 500)::int,
      'total', _share_num(p_payload, 'total', 0, 500)::int,
      'names', _share_txts(p_payload, 'names', 12, 40))
  end;

  tok := substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 14);
  insert into share_snapshots (token, owner_id, kind, payload) values (tok, uid, p_kind, clean);
  return tok;
end $$;

create or replace function public.delete_share_snapshot(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from share_snapshots where token = p_token and owner_id = auth.uid();
$$;

create or replace function public.share_snapshot_card(tok text)
returns table (kind text, payload jsonb, owner_name text, owner_username text, owner_avatar text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.kind, s.payload,
    case when pr.is_private then null else pr.display_name end,
    case when pr.is_private then null else pr.username end,
    case when pr.is_private or pr.avatar_url !~ '^https://' then null else pr.avatar_url end,
    s.created_at
  from share_snapshots s
  join profiles pr on pr.id = s.owner_id
  where s.token = case when tok ~ '^[a-f0-9]{14}$' then tok end;
$$;

revoke all on function public.create_share_snapshot(text, jsonb) from public;
revoke all on function public.delete_share_snapshot(text) from public;
revoke all on function public.share_snapshot_card(text) from public;
revoke all on function public._share_txts(jsonb, text, int, int) from public;
revoke all on function public._share_pairs(jsonb, text, int) from public;
revoke all on function public._share_num(jsonb, text, numeric, numeric) from public;
grant execute on function public.create_share_snapshot(text, jsonb) to authenticated;
grant execute on function public.delete_share_snapshot(text) to authenticated;
grant execute on function public.share_snapshot_card(text) to anon, authenticated;
