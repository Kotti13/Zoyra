-- WhatsApp-style E2EE keys. Builds on 20261115250000_e2ee.sql and 20261115280000_security_hardening.sql.
--
--   e2ee_setup(...)        backup arguments are optional now (all five null = no row in e2ee_key_backups). The
--                          app creates account + device keys silently on first use; the PIN backup is an opt-in
--                          setting. Resets still need a recent sign-in (hint 'e2ee_reauth', 10 minutes since the
--                          last authentication; a new phone usually resets right after login) and still notify the
--                          account. The reset cooldown is 10 minutes instead of 24 h (anti-loop protection between
--                          two phones; hint 'e2ee_reset_cooldown'). Old devices are revoked, the old backup deleted.
--   store_key_backup(...)  also CREATES the backup when none exists and p_current_verifier is null ("Chat backup"
--                          turned on in Settings). Needs an e2ee_accounts row. Existing rows: unchanged behaviour
--                          (current verifier + expected version).
--   delete_key_backup(v)   turns the backup off. Needs the current verifier (counts towards the attempt limit) or
--                          a recent sign-in (hint 'e2ee_reauth'). Idempotent.

create or replace function public.e2ee_setup(
  p_account_sign_pub text, p_device_id uuid, p_enc_pub text, p_sign_pub text, p_account_sig text,
  p_backup_ciphertext text default null, p_backup_nonce text default null, p_kdf_params jsonb default null,
  p_salt text default null, p_verifier text default null,
  p_reset boolean default false, p_label text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  last_reset timestamptz;
  did_reset boolean := false;
  with_backup boolean;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  with_backup := p_backup_ciphertext is not null;
  if with_backup <> (p_backup_nonce is not null) or with_backup <> (p_kdf_params is not null)
     or with_backup <> (p_salt is not null) or with_backup <> (p_verifier is not null) then
    raise exception 'Pass all backup fields or none' using errcode = '22023', hint = 'e2ee_backup_args';
  end if;
  if with_backup then perform public.e2ee_check_backup_args(p_kdf_params); end if;
  perform pg_advisory_xact_lock(hashtextextended('e2ee:' || me::text, 0));
  if exists (select 1 from public.e2ee_accounts where user_id = me) then
    if not coalesce(p_reset, false) then
      raise exception 'Encryption is already set up for this account' using errcode = '23505', hint = 'e2ee_exists';
    end if;
    if not public.auth_is_recent(interval '10 minutes') then
      raise exception 'Sign in again to reset your encryption keys' using errcode = '42501', hint = 'e2ee_reauth';
    end if;
    select reset_at into last_reset from public.e2ee_accounts where user_id = me;
    if last_reset is not null and last_reset > now() - interval '10 minutes' then
      raise exception 'Encryption keys were reset a moment ago. Try again in a few minutes.' using errcode = '42501', hint = 'e2ee_reset_cooldown';
    end if;
    update public.e2ee_devices set revoked_at = now() where user_id = me and revoked_at is null;
    update public.e2ee_accounts set account_sign_pub = p_account_sign_pub, updated_at = now(), reset_at = now() where user_id = me;
    delete from public.e2ee_key_backups where user_id = me;
    did_reset := true;
  else
    insert into public.e2ee_accounts (user_id, account_sign_pub) values (me, p_account_sign_pub);
  end if;
  perform public.e2ee_insert_device(me, p_device_id, p_enc_pub, p_sign_pub, p_account_sig, p_label);
  if with_backup then
    insert into public.e2ee_key_backups (user_id, ciphertext, nonce, kdf, kdf_params, salt, verifier)
    values (me, p_backup_ciphertext, p_backup_nonce, 'scrypt', p_kdf_params, p_salt, p_verifier);
  end if;
  if did_reset then
    perform public.notify_user(me, 'e2ee_reset', 'Your encryption keys were reset',
      'Your encryption keys were reset on a new device'
        || coalesce(' (' || nullif(btrim(coalesce(p_label, '')), '') || ')', '')
        || '. If this wasn''t you, change your password now.',
      jsonb_build_object('device_id', p_device_id, 'label', p_label, 'url', '/settings'), null);
  end if;
end $$;
revoke execute on function public.e2ee_setup(text, uuid, text, text, text, text, text, jsonb, text, text, boolean, text) from public, anon;
grant execute on function public.e2ee_setup(text, uuid, text, text, text, text, text, jsonb, text, text, boolean, text) to authenticated;

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
  perform pg_advisory_xact_lock(hashtextextended('e2ee:' || me::text, 0));
  if p_current_verifier is null and not exists (select 1 from public.e2ee_key_backups where user_id = me) then
    -- Turning the backup on: no row yet.
    if not exists (select 1 from public.e2ee_accounts where user_id = me) then
      raise exception 'Set up encryption first' using errcode = '22023', hint = 'e2ee_no_account';
    end if;
    insert into public.e2ee_key_backups (user_id, ciphertext, nonce, kdf, kdf_params, salt, verifier)
    values (me, p_ciphertext, p_nonce, 'scrypt', p_kdf_params, p_salt, p_verifier);
    return jsonb_build_object('status', 'ok', 'version', 1);
  end if;
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

create or replace function public.delete_key_backup(p_verifier text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  res jsonb;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('e2ee:' || me::text, 0));
  if not exists (select 1 from public.e2ee_key_backups where user_id = me) then
    return jsonb_build_object('status', 'ok');
  end if;
  if p_verifier is not null then
    res := public.e2ee_check_verifier(me, p_verifier);
    -- A wrong PIN must still count: return (commit) instead of raising.
    if res is not null and not public.auth_is_recent(interval '10 minutes') then return res; end if;
  elsif not public.auth_is_recent(interval '10 minutes') then
    raise exception 'Sign in again to turn off chat backup' using errcode = '42501', hint = 'e2ee_reauth';
  end if;
  delete from public.e2ee_key_backups where user_id = me;
  return jsonb_build_object('status', 'ok');
end $$;
revoke execute on function public.delete_key_backup(text) from public, anon;
grant execute on function public.delete_key_backup(text) to authenticated;
