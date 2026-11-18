-- End-to-end encryption core for 1:1 and group messages. Client contract: src/lib/e2ee/ (README.md there
-- documents the crypto). Keep RPC names, argument names and shapes in sync with src/lib/e2ee/server.ts.
--
--   e2ee_accounts       (user_id, account_sign_pub)         one Ed25519 account key per user; signs devices
--   e2ee_devices        (device_id, user_id, enc_pub, sign_pub, account_sig, revoked_at)
--                       public keys only. Readable by every signed-in user (they are public; revoked rows stay
--                       readable so old messages can still be verified). Written only through the RPCs below.
--   e2ee_key_backups    PIN-protected key backup: XChaCha20-Poly1305 blob + scrypt params + salt + PIN
--                       verifier. NOT readable by clients at all: the blob is released only by
--                       begin_backup_restore(verifier) when the verifier matches, max 10 wrong tries, then
--                       a lockout (1 h, doubling each time, capped at 24 h).
--   messages            + e2ee_version, ciphertext, nonce, sender_device_id, signature.
--                       For e2ee rows body = '', track = null and meta has only {"e2ee": 1} (+ "edited_at"):
--                       enforced by check constraint messages_e2ee_shape. kind stays plaintext (UI type,
--                       server rules such as song-share limits keep working).
--   message_keys        (message_id, device_id, user_id, wrapped_key, eph_pub, nonce): the per-device envelope.
--                       A row is readable only by the device owner.
--
-- RPCs (security definer, signed-in users only):
--   e2ee_setup(...)                  first device: account key + device + backup, atomically. p_reset = true
--                                    replaces the account key ("Forgot PIN"): revokes every device, drops the
--                                    backup. Contacts then see "security code changed".
--   register_device(...)             add a device signed by the account key (max 10 active per user).
--   revoke_device(device_id)
--   get_conversation_devices(cid)    every active device of every member (caller must be a member).
--   get_backup_params()              kdf / params / salt / version / attempts_left / locked_until (no blob).
--   begin_backup_restore(verifier)   {status: ok | wrong_pin | locked | no_backup, ...}. Never raises on a wrong
--                                    PIN so the attempt counter is committed.
--   confirm_backup_restore()         client confirms the blob decrypted: clears counters (ok already does).
--   store_key_backup(...)            replace the blob (PIN change, new device keys). Needs the current verifier
--                                    (wrong one counts as a failed attempt) and the expected version.
--   send_e2ee_message(...)           inserts message + envelopes atomically with every existing send rule.
--   edit_e2ee_message(...)           sender re-encrypts their own e2ee text message (15 minutes, like edit_message).
--
-- Changed existing functions:
--   message_preview   renamed to message_preview_plain and wrapped: e2ee rows → 'Sent you a message'. So push,
--                     in-app notifications, inbox() and search previews never contain plaintext.
--   notify_user       same as 20261114170000_notif_grouping.sql, plus: when the payload's message is an e2ee
--                     message, the stored payload and the push `data` get {e2ee: true, message_id} so the
--                     phone can decrypt the preview locally. A later redefinition MUST keep this block.
--   poll_option_ok    e2ee polls (options are encrypted) accept options 0..3 (the poll_votes check).
--
-- Not covered: scheduled messages ("Send later") are delivered by the server and stay plaintext; server
-- system messages (call log, blend, song swap) stay plaintext and contain no user-typed text.

-- ═════════════════════════════════════════════ helpers
create or replace function public.e2ee_b64(v text, bytes int) returns boolean
language sql immutable set search_path = public as $$
  select v is not null and v ~ '^[A-Za-z0-9+/]+={0,2}$' and char_length(v) = 4 * ceil(bytes / 3.0)::int;
$$;

-- ═════════════════════════════════════════════ tables
create table if not exists public.e2ee_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  account_sign_pub text not null check (public.e2ee_b64(account_sign_pub, 32)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.e2ee_devices (
  device_id uuid primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  enc_pub text not null check (public.e2ee_b64(enc_pub, 32)),
  sign_pub text not null check (public.e2ee_b64(sign_pub, 32)),
  account_sig text not null check (public.e2ee_b64(account_sig, 64)),
  label text check (label is null or char_length(label) <= 64),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists e2ee_devices_user_active_idx on public.e2ee_devices (user_id) where revoked_at is null;

create table if not exists public.e2ee_key_backups (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  ciphertext text not null check (char_length(ciphertext) between 24 and 65536),
  nonce text not null check (public.e2ee_b64(nonce, 24)),
  kdf text not null default 'scrypt' check (kdf = 'scrypt'),
  kdf_params jsonb not null,
  salt text not null check (public.e2ee_b64(salt, 16)),
  verifier text not null check (public.e2ee_b64(verifier, 32)),
  version int not null default 1,
  failed_attempts int not null default 0,
  lockouts int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.messages
  add column if not exists e2ee_version smallint,
  add column if not exists ciphertext text,
  add column if not exists nonce text,
  add column if not exists sender_device_id uuid,
  add column if not exists signature text;

alter table public.messages drop constraint if exists messages_e2ee_shape;
alter table public.messages add constraint messages_e2ee_shape check (
  (e2ee_version is null and ciphertext is null and not (meta ? 'e2ee'))
  or (
    e2ee_version is not null
    and body = '' and track is null
    and (meta - 'edited_at') = '{"e2ee": 1}'::jsonb
    and ciphertext is not null and char_length(ciphertext) <= 32768
    and nonce is not null and sender_device_id is not null and signature is not null
  )
);

create table if not exists public.message_keys (
  message_id uuid not null references public.messages (id) on delete cascade,
  device_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  wrapped_key text not null check (public.e2ee_b64(wrapped_key, 48)),
  eph_pub text not null check (public.e2ee_b64(eph_pub, 32)),
  nonce text not null check (public.e2ee_b64(nonce, 24)),
  primary key (message_id, device_id)
);
create index if not exists message_keys_device_idx on public.message_keys (device_id);

-- ═════════════════════════════════════════════ RLS
alter table public.e2ee_accounts enable row level security;
alter table public.e2ee_devices enable row level security;
alter table public.e2ee_key_backups enable row level security;
alter table public.message_keys enable row level security;

drop policy if exists "read account keys" on public.e2ee_accounts;
create policy "read account keys" on public.e2ee_accounts for select to authenticated using (true);
drop policy if exists "read device keys" on public.e2ee_devices;
create policy "read device keys" on public.e2ee_devices for select to authenticated using (true);
drop policy if exists "own message keys" on public.message_keys;
create policy "own message keys" on public.message_keys for select to authenticated using (user_id = auth.uid());
-- e2ee_key_backups: no policies at all (RPC only). No insert / update / delete policies anywhere.

revoke insert, update, delete on public.e2ee_accounts, public.e2ee_devices, public.message_keys from anon, authenticated;
revoke all on public.e2ee_key_backups from anon, authenticated;

-- E2EE rows only through send_e2ee_message / edit_e2ee_message (they validate devices and envelopes).
create or replace function public.e2ee_message_guard() returns trigger
language plpgsql as $$
begin
  if (new.e2ee_version is not null or new.ciphertext is not null) and current_user in ('anon', 'authenticated') then
    raise exception 'Encrypted messages must be sent with send_e2ee_message' using errcode = '42501', hint = 'e2ee_rpc';
  end if;
  return new;
end $$;
revoke execute on function public.e2ee_message_guard() from public, anon, authenticated;
drop trigger if exists e2ee_message_guard on public.messages;
create trigger e2ee_message_guard before insert or update on public.messages
  for each row execute function public.e2ee_message_guard();

-- ═════════════════════════════════════════════ previews: never plaintext for e2ee rows
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'message_preview_plain' and pronamespace = 'public'::regnamespace) then
    alter function public.message_preview(text, text, jsonb, jsonb) rename to message_preview_plain;
  end if;
end $$;
revoke execute on function public.message_preview_plain(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.message_preview_plain(text, text, jsonb, jsonb) to authenticated;

create or replace function public.message_preview(p_kind text, p_body text, p_track jsonb, p_meta jsonb) returns text
language sql immutable set search_path = public as $$
  select case when coalesce(p_meta ? 'e2ee', false) then 'Sent you a message'
              else public.message_preview_plain(p_kind, p_body, p_track, p_meta) end;
$$;
revoke execute on function public.message_preview(text, text, jsonb, jsonb) from public, anon;
grant execute on function public.message_preview(text, text, jsonb, jsonb) to authenticated;

-- ═════════════════════════════════════════════ polls with encrypted options
create or replace function public.poll_option_ok(mid uuid, cid uuid, opt int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.messages m
    where m.id = mid and m.conversation_id = cid and m.kind = 'poll'
      and (
        (m.e2ee_version is not null and opt between 0 and 3)
        or (jsonb_typeof(m.meta -> 'options') = 'array' and opt >= 0 and opt < jsonb_array_length(m.meta -> 'options'))
      )
  ) and public.is_conversation_member(cid);
$$;
revoke execute on function public.poll_option_ok(uuid, uuid, int) from public, anon;
grant execute on function public.poll_option_ok(uuid, uuid, int) to authenticated;

-- ═════════════════════════════════════════════ notify_user: e2ee flag for local preview decryption
-- Same as 20261114170000_notif_grouping.sql, plus the `e2ee` block (marked below).
create or replace function public.notify_user(
  recipient uuid, p_kind text, p_title text, p_body text, p_payload jsonb, p_category text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  secret text;
  nid uuid;
  prev jsonb;
  cnt int := 1;
  conv text := case when p_kind = 'message' then nullif(p_payload ->> 'conversation_id', '') end;
  item jsonb;
  previews jsonb;
  e2ee jsonb := '{}'::jsonb;  -- e2ee
begin
  if recipient is null then return; end if;

  -- e2ee: flag notifications for encrypted messages so the phone decrypts the preview itself.
  begin
    if p_payload ? 'message_id' and exists (
      select 1 from public.messages m where m.id = (p_payload ->> 'message_id')::uuid and m.e2ee_version is not null
    ) then
      e2ee := jsonb_build_object('e2ee', true, 'message_id', p_payload ->> 'message_id');
      p_payload := p_payload || e2ee;
    end if;
  exception when invalid_text_representation then null;
  end;

  if conv is not null then
    item := jsonb_build_object(
      'message_id', p_payload -> 'message_id',
      'sender_id', p_payload -> 'sender_id',
      'actor_name', p_payload -> 'actor_name',
      'body', p_body,
      'at', now());

    perform pg_advisory_xact_lock(hashtextextended('notif:' || recipient::text || ':' || conv, 0));

    select n.id, n.payload into nid, prev
    from public.notifications n
    where n.user_id = recipient and n.kind = 'message' and n.read = false
      and n.payload ->> 'conversation_id' = conv
    order by n.created_at desc
    limit 1
    for update;

    if nid is not null then
      cnt := coalesce(case when jsonb_typeof(prev -> 'count') = 'number' then (prev ->> 'count')::int end, 1) + 1;
      previews := case
        when jsonb_typeof(prev -> 'previews') = 'array' then prev -> 'previews'
        else jsonb_build_array(jsonb_build_object(
          'message_id', prev -> 'message_id', 'sender_id', prev -> 'sender_id',
          'actor_name', prev -> 'actor_name', 'body', prev -> 'body', 'at', null))
      end || jsonb_build_array(item);
      select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into previews
      from jsonb_array_elements(previews) with ordinality as t(e, i)
      where i > jsonb_array_length(previews) - 5;

      update public.notifications
      set payload = (prev - 'e2ee') || coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
            'title', p_title, 'body', p_body, 'preview', p_body, 'count', cnt, 'previews', previews),
          created_at = now()
      where id = nid;
    end if;
  end if;

  if nid is null then
    insert into public.notifications (user_id, kind, payload)
    values (recipient, p_kind,
      coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('title', p_title, 'body', p_body)
        || case when conv is not null
             then jsonb_build_object('preview', p_body, 'count', 1, 'previews', jsonb_build_array(item))
             else '{}'::jsonb end)
    returning id into nid;
  end if;

  begin
    select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
    if coalesce(secret, '') = '' then return; end if;
    perform net.http_post(
      url := 'https://vmdkgkgyzflvqsvecava.supabase.co/functions/v1/push',
      body := jsonb_build_object(
        'user_id', recipient,
        'title', p_title,
        'body', p_body,
        'data', jsonb_build_object(
          'url', coalesce(p_payload ->> 'url', '/notifications'),
          'kind', p_kind,
          'notification_id', nid,
          'actor_name', p_payload ->> 'actor_name',
          'category', p_category)
          || case when conv is not null
               then jsonb_build_object('conversation_id', conv, 'count', cnt)
               else '{}'::jsonb end
          || e2ee  -- e2ee
      ),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
      timeout_milliseconds := 5000
    );
  exception when others then
    null;
  end;
end $$;
revoke execute on function public.notify_user(uuid, text, text, text, jsonb, text) from public, anon, authenticated;

-- ═════════════════════════════════════════════ devices / account
create or replace function public.e2ee_insert_device(p_user uuid, p_device_id uuid, p_enc_pub text, p_sign_pub text, p_account_sig text, p_label text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.e2ee_devices%rowtype;
begin
  select * into d from public.e2ee_devices where device_id = p_device_id;
  if found then
    if d.user_id = p_user and d.enc_pub = p_enc_pub and d.sign_pub = p_sign_pub and d.revoked_at is null then
      update public.e2ee_devices set account_sig = p_account_sig, label = coalesce(p_label, label) where device_id = p_device_id;
      return;  -- idempotent retry
    end if;
    raise exception 'Device id already in use' using errcode = '23505', hint = 'e2ee_device_exists';
  end if;
  if (select count(*) from public.e2ee_devices where user_id = p_user and revoked_at is null) >= 10 then
    raise exception 'Too many devices. Remove one in Settings first.' using errcode = '22023', hint = 'too_many_devices';
  end if;
  insert into public.e2ee_devices (device_id, user_id, enc_pub, sign_pub, account_sig, label)
  values (p_device_id, p_user, p_enc_pub, p_sign_pub, p_account_sig, nullif(btrim(coalesce(p_label, '')), ''));
end $$;
revoke execute on function public.e2ee_insert_device(uuid, uuid, text, text, text, text) from public, anon, authenticated;

create or replace function public.e2ee_check_backup_args(p_kdf_params jsonb) returns void
language plpgsql immutable set search_path = public as $$
begin
  if jsonb_typeof(p_kdf_params -> 'N') <> 'number' or jsonb_typeof(p_kdf_params -> 'r') <> 'number'
     or jsonb_typeof(p_kdf_params -> 'p') <> 'number'
     or (p_kdf_params ->> 'N')::numeric < 16384 or (p_kdf_params ->> 'r')::numeric < 8 or (p_kdf_params ->> 'p')::numeric < 1 then
    raise exception 'Key backup parameters are too weak' using errcode = '22023', hint = 'e2ee_kdf';
  end if;
end $$;

create or replace function public.e2ee_setup(
  p_account_sign_pub text, p_device_id uuid, p_enc_pub text, p_sign_pub text, p_account_sig text,
  p_backup_ciphertext text, p_backup_nonce text, p_kdf_params jsonb, p_salt text, p_verifier text,
  p_reset boolean default false, p_label text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform public.e2ee_check_backup_args(p_kdf_params);
  perform pg_advisory_xact_lock(hashtextextended('e2ee:' || me::text, 0));
  if exists (select 1 from public.e2ee_accounts where user_id = me) then
    if not coalesce(p_reset, false) then
      raise exception 'Encryption is already set up for this account' using errcode = '23505', hint = 'e2ee_exists';
    end if;
    update public.e2ee_devices set revoked_at = now() where user_id = me and revoked_at is null;
    update public.e2ee_accounts set account_sign_pub = p_account_sign_pub, updated_at = now() where user_id = me;
    delete from public.e2ee_key_backups where user_id = me;
  else
    insert into public.e2ee_accounts (user_id, account_sign_pub) values (me, p_account_sign_pub);
  end if;
  perform public.e2ee_insert_device(me, p_device_id, p_enc_pub, p_sign_pub, p_account_sig, p_label);
  insert into public.e2ee_key_backups (user_id, ciphertext, nonce, kdf, kdf_params, salt, verifier)
  values (me, p_backup_ciphertext, p_backup_nonce, 'scrypt', p_kdf_params, p_salt, p_verifier);
end $$;
revoke execute on function public.e2ee_setup(text, uuid, text, text, text, text, text, jsonb, text, text, boolean, text) from public, anon;
grant execute on function public.e2ee_setup(text, uuid, text, text, text, text, text, jsonb, text, text, boolean, text) to authenticated;

create or replace function public.register_device(p_device_id uuid, p_enc_pub text, p_sign_pub text, p_account_sig text, p_label text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not exists (select 1 from public.e2ee_accounts where user_id = me) then
    raise exception 'Set up encryption first' using errcode = '22023', hint = 'e2ee_no_account';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('e2ee:' || me::text, 0));
  perform public.e2ee_insert_device(me, p_device_id, p_enc_pub, p_sign_pub, p_account_sig, p_label);
end $$;
revoke execute on function public.register_device(uuid, text, text, text, text) from public, anon;
grant execute on function public.register_device(uuid, text, text, text, text) to authenticated;

create or replace function public.revoke_device(p_device_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update public.e2ee_devices set revoked_at = coalesce(revoked_at, now())
  where device_id = p_device_id and user_id = auth.uid();
  if not found then raise exception 'Device not found' using errcode = 'P0002'; end if;
end $$;
revoke execute on function public.revoke_device(uuid) from public, anon;
grant execute on function public.revoke_device(uuid) to authenticated;

create or replace function public.get_conversation_devices(p_cid uuid)
returns table (user_id uuid, device_id uuid, enc_pub text, sign_pub text, account_sig text, account_sign_pub text)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_conversation_member(p_cid) then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;
  return query
    select d.user_id, d.device_id, d.enc_pub, d.sign_pub, d.account_sig, a.account_sign_pub
    from public.conversation_members cm
    join public.e2ee_devices d on d.user_id = cm.user_id and d.revoked_at is null
    join public.e2ee_accounts a on a.user_id = cm.user_id
    where cm.conversation_id = p_cid
    order by d.user_id, d.created_at;
end $$;
revoke execute on function public.get_conversation_devices(uuid) from public, anon;
grant execute on function public.get_conversation_devices(uuid) to authenticated;

-- ═════════════════════════════════════════════ PIN backup with attempt limiting
create or replace function public.get_backup_params() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  b public.e2ee_key_backups%rowtype;
  locked boolean;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into b from public.e2ee_key_backups where user_id = auth.uid();
  if not found then return jsonb_build_object('exists', false); end if;
  locked := b.locked_until is not null and b.locked_until > now();
  return jsonb_build_object('exists', true, 'kdf', b.kdf, 'kdf_params', b.kdf_params, 'salt', b.salt, 'version', b.version,
    'attempts_left', case when locked then 0 when b.locked_until is not null then 10 else 10 - b.failed_attempts end,
    'locked_until', case when locked then b.locked_until end);
end $$;
revoke execute on function public.get_backup_params() from public, anon;
grant execute on function public.get_backup_params() to authenticated;

-- One verifier check for user `me`, row already locked. Returns null on success, else a status object.
create or replace function public.e2ee_check_verifier(me uuid, p_verifier text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  b public.e2ee_key_backups%rowtype;
  wait interval;
begin
  select * into b from public.e2ee_key_backups where user_id = me for update;
  if not found then return jsonb_build_object('status', 'no_backup'); end if;
  if b.locked_until is not null and b.locked_until > now() then
    return jsonb_build_object('status', 'locked', 'locked_until', b.locked_until, 'attempts_left', 0);
  end if;
  if b.locked_until is not null then  -- lock expired: fresh window
    b.failed_attempts := 0;
    b.locked_until := null;
  end if;
  if p_verifier is not null and b.verifier = p_verifier then
    update public.e2ee_key_backups set failed_attempts = 0, lockouts = 0, locked_until = null where user_id = me;
    return null;
  end if;
  b.failed_attempts := b.failed_attempts + 1;
  if b.failed_attempts >= 10 then
    wait := least(interval '24 hours', interval '1 hour' * power(2, least(b.lockouts, 5)));
    update public.e2ee_key_backups
    set failed_attempts = 0, lockouts = b.lockouts + 1, locked_until = now() + wait where user_id = me;
    return jsonb_build_object('status', 'locked', 'locked_until', now() + wait, 'attempts_left', 0);
  end if;
  update public.e2ee_key_backups set failed_attempts = b.failed_attempts, locked_until = null where user_id = me;
  return jsonb_build_object('status', 'wrong_pin', 'attempts_left', 10 - b.failed_attempts);
end $$;
revoke execute on function public.e2ee_check_verifier(uuid, text) from public, anon, authenticated;

create or replace function public.begin_backup_restore(p_verifier text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  res jsonb;
  b public.e2ee_key_backups%rowtype;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  res := public.e2ee_check_verifier(me, p_verifier);
  if res is not null then return res; end if;
  select * into b from public.e2ee_key_backups where user_id = me;
  return jsonb_build_object('status', 'ok', 'ciphertext', b.ciphertext, 'nonce', b.nonce, 'version', b.version,
    'attempts_left', 10);
end $$;
revoke execute on function public.begin_backup_restore(text) from public, anon;
grant execute on function public.begin_backup_restore(text) to authenticated;

create or replace function public.confirm_backup_restore() returns void
language sql security definer set search_path = public as $$
  update public.e2ee_key_backups set failed_attempts = 0, lockouts = 0, locked_until = null
  where user_id = auth.uid() and (locked_until is null or locked_until <= now());
$$;
revoke execute on function public.confirm_backup_restore() from public, anon;
grant execute on function public.confirm_backup_restore() to authenticated;

create or replace function public.store_key_backup(
  p_ciphertext text, p_nonce text, p_kdf_params jsonb, p_salt text, p_verifier text,
  p_current_verifier text, p_expected_version int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  res jsonb;
  v int;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform public.e2ee_check_backup_args(p_kdf_params);
  res := public.e2ee_check_verifier(me, p_current_verifier);
  if res is not null then return res; end if;
  select version into v from public.e2ee_key_backups where user_id = me;
  if p_expected_version is distinct from v then
    return jsonb_build_object('status', 'conflict', 'version', v);
  end if;
  update public.e2ee_key_backups
  set ciphertext = p_ciphertext, nonce = p_nonce, kdf_params = p_kdf_params, salt = p_salt, verifier = p_verifier,
      version = v + 1, updated_at = now()
  where user_id = me;
  return jsonb_build_object('status', 'ok', 'version', v + 1);
end $$;
revoke execute on function public.store_key_backup(text, text, jsonb, text, text, text, int) from public, anon;
grant execute on function public.store_key_backup(text, text, jsonb, text, text, text, int) to authenticated;

-- ═════════════════════════════════════════════ sending / editing
-- Validates the sender device and every envelope (active device of a current member).
create or replace function public.e2ee_check_envelopes(p_cid uuid, p_sender_device_id uuid, p_envelopes jsonb, p_ciphertext text, p_nonce text, p_signature text, p_version int)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  bad int;
begin
  if p_version is distinct from 1 then
    raise exception 'Unsupported encryption version' using errcode = '22023', hint = 'e2ee_version';
  end if;
  if not exists (select 1 from public.e2ee_devices where device_id = p_sender_device_id and user_id = auth.uid() and revoked_at is null) then
    raise exception 'This device isn''t registered for encryption' using errcode = '42501', hint = 'e2ee_device';
  end if;
  if p_ciphertext is null or char_length(p_ciphertext) > 32768 or not public.e2ee_b64(p_nonce, 24) or not public.e2ee_b64(p_signature, 64) then
    raise exception 'Malformed encrypted message' using errcode = '22023', hint = 'e2ee_format';
  end if;
  if jsonb_typeof(p_envelopes) is distinct from 'array' or jsonb_array_length(p_envelopes) = 0 or jsonb_array_length(p_envelopes) > 640 then
    raise exception 'Malformed encrypted message' using errcode = '22023', hint = 'e2ee_format';
  end if;
  select count(*) into bad
  from jsonb_array_elements(p_envelopes) e
  left join public.e2ee_devices d on d.device_id = (e ->> 'device_id')::uuid and d.revoked_at is null
  left join public.conversation_members cm on cm.conversation_id = p_cid and cm.user_id = d.user_id
  where d.device_id is null or cm.user_id is null;
  if bad > 0 then
    raise exception 'Someone''s devices changed. Try again.' using errcode = '22023', hint = 'e2ee_devices_changed';
  end if;
end $$;
revoke execute on function public.e2ee_check_envelopes(uuid, uuid, jsonb, text, text, text, int) from public, anon, authenticated;

create or replace function public.e2ee_insert_envelopes(p_mid uuid, p_envelopes jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.message_keys (message_id, device_id, user_id, wrapped_key, eph_pub, nonce)
  select p_mid, d.device_id, d.user_id, e ->> 'wrapped_key', e ->> 'eph_pub', e ->> 'nonce'
  from jsonb_array_elements(p_envelopes) e
  join public.e2ee_devices d on d.device_id = (e ->> 'device_id')::uuid;
$$;
revoke execute on function public.e2ee_insert_envelopes(uuid, jsonb) from public, anon, authenticated;

create or replace function public.send_e2ee_message(
  p_cid uuid, p_message_id uuid, p_ciphertext text, p_nonce text, p_sender_device_id uuid, p_signature text,
  p_kind text default 'text', p_reply_to uuid default null, p_envelopes jsonb default '[]'::jsonb, p_version int default 1
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if p_message_id is null then raise exception 'message id required' using errcode = '22023'; end if;
  if coalesce(p_kind, '') not in ('text', 'track', 'voice', 'poll', 'lyric', 'playlist', 'jam', 'live', 'photo', 'location') then
    raise exception 'This kind of message can''t be encrypted' using errcode = '22023', hint = 'e2ee_kind';
  end if;
  -- Same rules as the "send messages" insert policy (this function bypasses RLS).
  if not public.is_conversation_member(p_cid) then
    raise exception 'This conversation is no longer available.' using errcode = '42501';
  end if;
  if public.conversation_blocked(p_cid) then
    raise exception 'You can''t message this person' using errcode = '42501', hint = 'blocked';
  end if;
  if not public.dm_can_send(p_cid) then
    raise exception 'You can send up to 3 messages until they accept your request' using errcode = '42501', hint = 'request_pending';
  end if;
  perform public.e2ee_check_envelopes(p_cid, p_sender_device_id, p_envelopes, p_ciphertext, p_nonce, p_signature, p_version);

  -- Insert triggers still run: dm_message_guard (request limits, song shares, access), message_reply_guard,
  -- touch_conversation, on_message_notify (preview 'Sent you a message', e2ee flag via notify_user).
  insert into public.messages (id, conversation_id, sender_id, body, track, kind, reply_to, meta,
                               e2ee_version, ciphertext, nonce, sender_device_id, signature)
  values (p_message_id, p_cid, me, '', null, p_kind, p_reply_to, '{"e2ee": 1}'::jsonb,
          p_version, p_ciphertext, p_nonce, p_sender_device_id, p_signature);
  perform public.e2ee_insert_envelopes(p_message_id, p_envelopes);
  return p_message_id;
end $$;
revoke execute on function public.send_e2ee_message(uuid, uuid, text, text, uuid, text, text, uuid, jsonb, int) from public, anon;
grant execute on function public.send_e2ee_message(uuid, uuid, text, text, uuid, text, text, uuid, jsonb, int) to authenticated;

create or replace function public.edit_e2ee_message(
  p_message_id uuid, p_ciphertext text, p_nonce text, p_sender_device_id uuid, p_signature text,
  p_envelopes jsonb, p_version int default 1
) returns void
language plpgsql security definer set search_path = public as $$
declare
  m public.messages%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into m from public.messages where id = p_message_id for update;
  if not found or not public.is_conversation_member(m.conversation_id) then
    raise exception 'This message is no longer available.' using errcode = 'P0002';
  end if;
  if m.sender_id is distinct from auth.uid() then
    raise exception 'You can only edit your own messages.' using errcode = '42501';
  end if;
  if m.e2ee_version is null then
    raise exception 'Use edit_message for this message.' using errcode = '22023';
  end if;
  if m.kind is distinct from 'text' then
    raise exception 'Only text messages can be edited.' using errcode = '22023';
  end if;
  if m.created_at < now() - interval '15 minutes' then
    raise exception 'Messages can only be edited for 15 minutes after sending.' using errcode = '22023';
  end if;
  if public.conversation_blocked(m.conversation_id) then
    raise exception 'You can''t message this person.' using errcode = '42501';
  end if;
  perform public.e2ee_check_envelopes(m.conversation_id, p_sender_device_id, p_envelopes, p_ciphertext, p_nonce, p_signature, p_version);

  update public.messages
     set ciphertext = p_ciphertext, nonce = p_nonce, sender_device_id = p_sender_device_id, signature = p_signature,
         e2ee_version = p_version, edited_at = now(),
         meta = '{"e2ee": 1}'::jsonb || jsonb_build_object('edited_at', now())
   where id = p_message_id;
  delete from public.message_keys where message_id = p_message_id;
  perform public.e2ee_insert_envelopes(p_message_id, p_envelopes);
end $$;
revoke execute on function public.edit_e2ee_message(uuid, text, text, uuid, text, jsonb, int) from public, anon;
grant execute on function public.edit_e2ee_message(uuid, text, text, uuid, text, jsonb, int) to authenticated;
