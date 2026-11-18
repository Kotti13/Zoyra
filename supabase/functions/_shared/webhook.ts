import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * Secret for the `x-webhook-secret` header that the database sends to push / new-releases.
 * Uses the PUSH_WEBHOOK_SECRET env secret when set, otherwise reads the Vault secret through the
 * service-role-only `push_webhook_secret()` RPC (created by migration 20261114175000_push_secret.sql).
 */
let cached: string | null = null;

export async function webhookSecret(): Promise<string | null> {
  const env = Deno.env.get('PUSH_WEBHOOK_SECRET');
  if (env) return env;
  if (cached) return cached;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('push_webhook_secret');
  if (error || typeof data !== 'string' || !data) return null;
  cached = data;
  return cached;
}
