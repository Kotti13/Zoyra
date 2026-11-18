-- Native incoming calls: devices that ring natively (iOS CallKit via VoIP push, Android full-screen call
-- notification via a data-only push) + the signalling that wakes them.
-- Client: src/lib/native-call.ts · edge function: supabase/functions/voip-push · native: plugins/withZoyraCalls.js
--
--   voip_tokens            one row per device that rings natively.
--                            ios:     token = APNs VoIP (PushKit) token (hex), push_token = that device's Expo token
--                            android: token = push_token = the device's Expo push token (it handles call data pushes)
--                          The owner can read / delete their rows; writes go through the RPCs below.
--   register_voip_token(p_token, p_platform, p_push_token)   upsert (re-assigns a token used by another account)
--   unregister_voip_token(p_token)                            sign-out / opt-out
--   call_voip_notify       trigger on public.calls:
--                            INSERT status 'ringing'          → voip-push { type: 'call', ... }
--                            UPDATE ringing → anything else   → voip-push { type: 'call_cancel', reason: <new status> }
--                          only when the callee has a voip_tokens row; same pg_net + Vault secret path as
--                          notify_user → push (20261114170000_notif_grouping.sql). The normal 'call' push is still
--                          sent by start_call; the push function skips it for devices listed here (fallback otherwise).
--   voip_decline_call(call_id, callee)   service role only: the iOS CallKit "Decline" when the app's JS isn't
--                          running (voip-push verifies a per-call HMAC token first). Same effect as answer_call(false).

-- ═════════════════════════════════════════════ voip_tokens
create table if not exists public.voip_tokens (
  token text primary key check (char_length(token) between 8 and 512),
  user_id uuid not null references public.profiles (id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  push_token text check (push_token is null or char_length(push_token) <= 512),
  updated_at timestamptz not null default now()
);
create index if not exists voip_tokens_user_idx on public.voip_tokens (user_id);
create index if not exists voip_tokens_push_token_idx on public.voip_tokens (push_token) where push_token is not null;

alter table public.voip_tokens enable row level security;
revoke all on public.voip_tokens from anon, authenticated;
grant select, delete on public.voip_tokens to authenticated;

drop policy if exists "own voip tokens read" on public.voip_tokens;
create policy "own voip tokens read" on public.voip_tokens for select to authenticated using (user_id = auth.uid());
drop policy if exists "own voip tokens delete" on public.voip_tokens;
create policy "own voip tokens delete" on public.voip_tokens for delete to authenticated using (user_id = auth.uid());

create or replace function public.register_voip_token(p_token text, p_platform text default 'ios', p_push_token text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501', hint = 'not_signed_in'; end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Unknown platform' using errcode = '22023', hint = 'bad_platform';
  end if;
  if p_token is null or char_length(p_token) not between 8 and 512 then
    raise exception 'Invalid token' using errcode = '22023', hint = 'bad_token';
  end if;
  -- One row per device: a new VoIP token for the same Expo push token replaces the old one.
  if p_push_token is not null then
    delete from public.voip_tokens where push_token = p_push_token and token <> p_token;
  end if;
  insert into public.voip_tokens (token, user_id, platform, push_token, updated_at)
  values (p_token, me, p_platform, nullif(left(coalesce(p_push_token, ''), 512), ''), now())
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform,
        push_token = coalesce(excluded.push_token, public.voip_tokens.push_token), updated_at = now();
end $$;
revoke execute on function public.register_voip_token(text, text, text) from public, anon;
grant execute on function public.register_voip_token(text, text, text) to authenticated;

create or replace function public.unregister_voip_token(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.voip_tokens where token = p_token and user_id = auth.uid();
$$;
revoke execute on function public.unregister_voip_token(text) from public, anon;
grant execute on function public.unregister_voip_token(text) to authenticated;

-- ═════════════════════════════════════════════ calls → voip-push
create or replace function public.call_voip_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  secret text;
  msg_type text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'ringing' then return new; end if;
    msg_type := 'call';
  elsif old.status = 'ringing' and new.status <> 'ringing' then
    msg_type := 'call_cancel';
  else
    return new;
  end if;

  if not exists (select 1 from public.voip_tokens t where t.user_id = new.callee_id) then return new; end if;

  begin
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
    if coalesce(secret, '') = '' then return new; end if;
    perform net.http_post(
      url := 'https://vmdkgkgyzflvqsvecava.supabase.co/functions/v1/voip-push',
      body := jsonb_build_object(
        'type', msg_type,
        'call_id', new.id,
        'user_id', new.callee_id,
        'caller_id', new.caller_id,
        'caller_name', public.display_name_of(new.caller_id),
        'kind', new.kind,
        'conversation_id', new.conversation_id,
        'created_at', new.created_at,
        'reason', case when msg_type = 'call_cancel' then new.status end
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Vault / pg_net unavailable: the normal push (notify_user) still rings the callee.
    null;
  end;
  return new;
end $$;
revoke execute on function public.call_voip_notify() from public, anon, authenticated;

drop trigger if exists call_voip_notify on public.calls;
create trigger call_voip_notify after insert or update of status on public.calls
  for each row execute function public.call_voip_notify();

-- ═════════════════════════════════════════════ native decline (service role)
create or replace function public.voip_decline_call(p_call_id uuid, p_callee uuid) returns public.calls
language plpgsql security definer set search_path = public as $$
declare
  c public.calls;
begin
  select * into c from public.calls x where x.id = p_call_id for update;
  if not found or c.callee_id <> p_callee then
    raise exception 'Call not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if c.status <> 'ringing' then return c; end if;
  if c.created_at < now() - interval '60 seconds' then
    return public.call_finish(c.id, 'missed', false);
  end if;
  return public.call_finish(c.id, 'declined', false);
end $$;
revoke execute on function public.voip_decline_call(uuid, uuid) from public, anon, authenticated;
grant execute on function public.voip_decline_call(uuid, uuid) to service_role;
