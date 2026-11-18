-- Shared secret between the database (pg_net → edge functions) and the push / new-releases functions.
-- Generated inside Vault so it never appears in code, logs or chat. Existing secrets are kept.
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'push_webhook_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'push_webhook_secret',
      'Database → push/new-releases edge functions (x-webhook-secret header)'
    );
  end if;
end $$;

-- Edge functions (service role only) read the secret through this; nobody else can call it.
create or replace function public.push_webhook_secret()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret' limit 1;
$$;

revoke all on function public.push_webhook_secret() from public, anon, authenticated;
grant execute on function public.push_webhook_secret() to service_role;
