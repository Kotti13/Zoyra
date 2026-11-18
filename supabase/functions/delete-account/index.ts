// delete-account: removes the caller's storage objects, then the auth user (profile rows cascade).
// POST {} → { ok: true }
import { adminClient, error, errMessage, json, notConfigured, preflight, requireUser } from '../_shared/http.ts';

const BUCKETS = ['avatars', 'covers'] as const;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const user = await requireUser(req);
  if (user instanceof Response) return user;

  const admin = adminClient();
  if (!admin) return notConfigured('supabase');

  try {
    for (const bucket of BUCKETS) {
      // Page through <uid>/ (flat folder; nested folders are walked one level down).
      const prefixes = [user.id];
      while (prefixes.length) {
        const prefix = prefixes.pop() as string;
        for (;;) {
          const { data, error: listErr } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
          if (listErr) throw listErr;
          if (!data || data.length === 0) break;
          const files = data.filter((o) => o.id !== null).map((o) => `${prefix}/${o.name}`);
          for (const folder of data.filter((o) => o.id === null)) prefixes.push(`${prefix}/${folder.name}`);
          if (files.length === 0) break;
          const { error: rmErr } = await admin.storage.from(bucket).remove(files);
          if (rmErr) throw rmErr;
          if (data.length < 1000) break;
        }
      }
    }

    const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
    if (delErr) throw delErr;
    return json({ ok: true });
  } catch (e) {
    return error(500, 'delete_failed', { message: errMessage(e) });
  }
});
