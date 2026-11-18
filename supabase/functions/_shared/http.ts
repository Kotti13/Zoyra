// Shared helpers for every Zoyra edge function: CORS, JSON responses, auth, admin client.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export const error = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  json({ error: code, ...extra }, status);

/** 503 `{ error: 'not_configured', service }` — the app shows "needs <service> setup". */
export const notConfigured = (service: string): Response => error(503, 'not_configured', { service });

/** Returns a preflight response for OPTIONS, otherwise null. */
export const preflight = (req: Request): Response | null =>
  req.method === 'OPTIONS' ? new Response('ok', { headers: corsHeaders }) : null;

/** Read the JSON body; returns null when it is missing or invalid. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verify the caller's JWT. Returns the user, or a 401 Response. */
export async function requireUser(req: Request): Promise<User | Response> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return error(401, 'unauthorized');
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return notConfigured('supabase');
  const client = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const { data, error: err } = await client.auth.getUser(token);
  if (err || !data.user) return error(401, 'unauthorized');
  return data.user;
}

/** Service-role client (bypasses RLS). Null when the env is missing. */
export function adminClient(): SupabaseClient | null {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
