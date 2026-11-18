-- Zoyra: gift Premium, kids mode, nearby share.
--
-- GIFTS
--   gift_codes            one row per paid gift. Rows are created ONLY by the billing backend (revenuecat-webhook
--                         calls grant_gift with the service role when a store gift product is bought), so a gift can
--                         never be minted for free. The buyer then attaches recipient / note / song / delivery time
--                         (gift_set_details) and sends the code in a chat message. The recipient redeems it with
--                         redeem_gift(code): Premium for N months, tracked in profiles.gift_until.
--   profiles.gift_until   end of a gifted Premium period. sync_gift_plan() (called by the app at start-up) drops the
--                         plan back to 'free' once it passes. A plan written by the billing webhook (service role)
--                         clears gift_until, so a real subscription is never downgraded by an old gift.
--
-- KIDS MODE
--   user_settings.kids    jsonb: { on, pin_salt, pin_hash, limit_min, bed_on, bed_from, bed_to, msgs_off, social_off }.
--                         Enforced by the app (routes, explicit filter, listening limit, bedtime); the PIN is a
--                         parental lock, hashed on the device.
--
-- NEARBY SHARE
--   nearby_shares         short-lived (10 min) 6 character codes for a song / playlist, shown as a QR code and
--                         claimed by someone next to you. No radio or location data is used or stored.

-- ═════════════════════════════════════════════ helpers
-- Crypto-random code from an unambiguous alphabet (no 0/O/1/I/L).
create or replace function public.zoyra_random_code(n int) returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; -- 32 chars, so a random byte maps without bias
  hex text; out text := ''; i int;
begin
  for i in 1..n loop
    if (i - 1) % 16 = 0 then hex := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''); end if;
    out := out || substr(alphabet, (('x' || substr(hex, ((i - 1) % 16) * 2 + 1, 2))::bit(8)::int % 32) + 1, 1);
  end loop;
  return out;
end $$;
revoke execute on function public.zoyra_random_code(int) from public, anon, authenticated;

-- Per-user throttle for code guessing / creation. Raises hint 'rate_limited'.
create table if not exists public.code_attempts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  at timestamptz not null default now()
);
create index if not exists code_attempts_idx on public.code_attempts (user_id, kind, at desc);
alter table public.code_attempts enable row level security; -- no policies: only the functions below touch it

create or replace function public.code_throttle(p_kind text, p_max int, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.code_attempts where user_id = auth.uid() and at < now() - interval '1 day';
  select count(*) into n from public.code_attempts where user_id = auth.uid() and kind = p_kind and at > now() - p_window;
  if n >= p_max then raise exception 'Too many tries. Wait a little and try again.' using errcode = 'P0001', hint = 'rate_limited'; end if;
  insert into public.code_attempts (user_id, kind) values (auth.uid(), p_kind);
end $$;
revoke execute on function public.code_throttle(text, int, interval) from public, anon, authenticated;

-- ═════════════════════════════════════════════ gifts
alter table public.profiles add column if not exists gift_until timestamptz;

create or replace function public.profiles_gift_billing_guard() returns trigger
language plpgsql as $$
begin
  -- Plan written by the billing backend (no end-user JWT): a real subscription replaces any gifted period.
  if auth.uid() is null then new.gift_until := null; end if;
  return new;
end $$;
drop trigger if exists profiles_gift_billing_guard on public.profiles;
create trigger profiles_gift_billing_guard before update of plan on public.profiles
  for each row execute function public.profiles_gift_billing_guard();

create table if not exists public.gift_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  buyer_id uuid not null references public.profiles (id) on delete cascade,
  months int not null check (months in (1, 3, 12)),
  store_ref text unique,                       -- RevenueCat event id: makes webhook retries idempotent
  recipient_id uuid references public.profiles (id) on delete set null,
  note text check (note is null or char_length(note) <= 240),
  track jsonb,                                 -- {id, title, artist} the buyer attached
  deliver_at timestamptz,
  sent_at timestamptz,                         -- the code was put into a chat message
  redeemed_by uuid references public.profiles (id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists gift_codes_buyer_idx on public.gift_codes (buyer_id, created_at desc);
alter table public.gift_codes enable row level security;
drop policy if exists "gift buyer or redeemer reads" on public.gift_codes;
create policy "gift buyer or redeemer reads" on public.gift_codes for select to authenticated
  using (buyer_id = auth.uid() or redeemed_by = auth.uid());
revoke insert, update, delete on public.gift_codes from authenticated, anon;

-- Billing backend only (service role): a store gift purchase became a code.
create or replace function public.grant_gift(p_buyer uuid, p_months int, p_store_ref text) returns text
language plpgsql security definer set search_path = public as $$
declare c text; existing text;
begin
  if p_months not in (1, 3, 12) then raise exception 'bad_months'; end if;
  if p_store_ref is not null then
    select code into existing from public.gift_codes where store_ref = p_store_ref;
    if existing is not null then return existing; end if;
  end if;
  loop
    c := public.zoyra_random_code(12);
    begin
      insert into public.gift_codes (code, buyer_id, months, store_ref) values (c, p_buyer, p_months, p_store_ref);
      return c;
    exception when unique_violation then
      if p_store_ref is not null then
        select code into existing from public.gift_codes where store_ref = p_store_ref;
        if existing is not null then return existing; end if;
      end if;
    end;
  end loop;
end $$;
revoke execute on function public.grant_gift(uuid, int, text) from public, anon, authenticated;
grant execute on function public.grant_gift(uuid, int, text) to service_role;

-- Buyer attaches recipient / note / song / delivery time and marks it sent.
create or replace function public.gift_set_details(p_gift uuid, p_recipient uuid, p_note text, p_track jsonb, p_deliver_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare g public.gift_codes;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into g from public.gift_codes where id = p_gift and buyer_id = auth.uid() for update;
  if not found then raise exception 'Gift not found' using errcode = 'P0002'; end if;
  if g.redeemed_at is not null then raise exception 'This gift was already redeemed' using errcode = 'P0001', hint = 'redeemed'; end if;
  if p_recipient is not null and (p_recipient = auth.uid() or public.blocked_with(p_recipient)) then
    raise exception 'You can''t send a gift to this person' using errcode = 'P0001', hint = 'blocked';
  end if;
  update public.gift_codes set
    recipient_id = p_recipient,
    note = nullif(left(btrim(coalesce(p_note, '')), 240), ''),
    track = case when p_track is null then null else jsonb_build_object(
      'id', left(p_track ->> 'id', 120), 'title', left(coalesce(p_track ->> 'title', ''), 200), 'artist', left(coalesce(p_track ->> 'artist', ''), 200)) end,
    deliver_at = p_deliver_at,
    sent_at = now()
  where id = p_gift;
end $$;
revoke execute on function public.gift_set_details(uuid, uuid, text, jsonb, timestamptz) from public, anon;
grant execute on function public.gift_set_details(uuid, uuid, text, jsonb, timestamptz) to authenticated;

-- Redeem a code: Premium for the gift's months.
create or replace function public.redeem_gift(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.gift_codes; pr public.profiles; code text; base timestamptz; until_ts timestamptz;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  perform public.code_throttle('gift', 10, interval '1 hour');
  code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if char_length(code) <> 12 then raise exception 'That code isn''t valid' using errcode = 'P0001', hint = 'invalid'; end if;
  select * into g from public.gift_codes where gift_codes.code = redeem_gift.code for update;
  if not found then raise exception 'That code isn''t valid' using errcode = 'P0001', hint = 'invalid'; end if;
  if g.redeemed_at is not null then raise exception 'This gift was already redeemed' using errcode = 'P0001', hint = 'redeemed'; end if;
  if g.recipient_id is not null and g.recipient_id <> auth.uid() and g.buyer_id <> auth.uid() then
    raise exception 'This gift is meant for someone else' using errcode = 'P0001', hint = 'not_for_you';
  end if;
  if g.deliver_at is not null and g.deliver_at > now() and g.buyer_id <> auth.uid() then
    raise exception 'This gift unlocks on %', to_char(g.deliver_at at time zone 'UTC', 'DD Mon HH24:MI "UTC"') using errcode = 'P0001', hint = 'not_yet';
  end if;
  select * into pr from public.profiles where id = auth.uid() for update;
  if pr.plan <> 'free' and pr.gift_until is null then
    raise exception 'You already have a paid plan. Keep this code and redeem it when your plan ends.' using errcode = 'P0001', hint = 'already_subscribed';
  end if;
  base := greatest(now(), coalesce(pr.gift_until, now()));
  until_ts := base + make_interval(months => g.months);
  update public.profiles set plan = 'premium', gift_until = until_ts, updated_at = now() where id = auth.uid();
  update public.gift_codes set redeemed_by = auth.uid(), redeemed_at = now() where id = g.id;
  return jsonb_build_object('months', g.months, 'until', until_ts);
end $$;
revoke execute on function public.redeem_gift(text) from public, anon;
grant execute on function public.redeem_gift(text) to authenticated;

-- App start-up: a gifted period that ended goes back to free.
create or replace function public.sync_gift_plan() returns text
language plpgsql security definer set search_path = public as $$
declare p text;
begin
  if auth.uid() is null then return null; end if;
  update public.profiles set plan = 'free', gift_until = null, updated_at = now()
   where id = auth.uid() and gift_until is not null and gift_until <= now();
  select plan into p from public.profiles where id = auth.uid();
  return p;
end $$;
revoke execute on function public.sync_gift_plan() from public, anon;
grant execute on function public.sync_gift_plan() to authenticated;

-- ═════════════════════════════════════════════ kids mode
alter table public.user_settings add column if not exists kids jsonb;

-- ═════════════════════════════════════════════ nearby share
create table if not exists public.nearby_shares (
  code text primary key,
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('track', 'playlist')),
  item jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);
create index if not exists nearby_shares_owner_idx on public.nearby_shares (owner_id, created_at desc);
alter table public.nearby_shares enable row level security;
drop policy if exists "nearby owner reads" on public.nearby_shares;
create policy "nearby owner reads" on public.nearby_shares for select to authenticated using (owner_id = auth.uid());
revoke insert, update, delete on public.nearby_shares from authenticated, anon;

create or replace function public.create_nearby_share(p_kind text, p_item jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text; exp timestamptz := now() + interval '10 minutes';
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_kind not in ('track', 'playlist') then raise exception 'bad_kind'; end if;
  if coalesce(p_item ->> 'id', '') = '' or char_length(p_item ->> 'id') > 120 then raise exception 'bad_item'; end if;
  perform public.code_throttle('nearby_create', 20, interval '1 hour');
  delete from public.nearby_shares where owner_id = auth.uid() and (expires_at < now() or (item ->> 'id' = p_item ->> 'id' and kind = p_kind));
  loop
    c := public.zoyra_random_code(6);
    begin
      insert into public.nearby_shares (code, owner_id, kind, item, expires_at) values (
        c, auth.uid(), p_kind,
        jsonb_build_object('id', left(p_item ->> 'id', 120), 'title', left(coalesce(p_item ->> 'title', ''), 200),
                           'subtitle', left(coalesce(p_item ->> 'subtitle', ''), 200), 'art', left(coalesce(p_item ->> 'art', ''), 500)),
        exp);
      return jsonb_build_object('code', c, 'expires_at', exp);
    exception when unique_violation then null;
    end;
  end loop;
end $$;
revoke execute on function public.create_nearby_share(text, jsonb) from public, anon;
grant execute on function public.create_nearby_share(text, jsonb) to authenticated;

create or replace function public.claim_nearby_share(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.nearby_shares; code text; owner_name text;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  perform public.code_throttle('nearby_claim', 30, interval '10 minutes');
  code := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select * into s from public.nearby_shares where nearby_shares.code = claim_nearby_share.code and expires_at > now();
  if not found then raise exception 'That code has expired or isn''t valid' using errcode = 'P0001', hint = 'invalid'; end if;
  if public.blocked_with(s.owner_id) then raise exception 'That code isn''t available' using errcode = 'P0001', hint = 'invalid'; end if;
  select display_name into owner_name from public.profiles where id = s.owner_id;
  return jsonb_build_object('kind', s.kind, 'item', s.item, 'owner_id', s.owner_id, 'owner_name', owner_name, 'expires_at', s.expires_at);
end $$;
revoke execute on function public.claim_nearby_share(text) from public, anon;
grant execute on function public.claim_nearby_share(text) to authenticated;

create or replace function public.end_nearby_share(p_code text) returns void
language sql security definer set search_path = public as $$
  delete from public.nearby_shares where owner_id = auth.uid() and code = upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;
revoke execute on function public.end_nearby_share(text) from public, anon;
grant execute on function public.end_nearby_share(text) to authenticated;
