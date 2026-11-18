// revenuecat-webhook: keeps profiles.plan in sync with RevenueCat entitlements.
// NO user JWT: verifies the Authorization header against REVENUECAT_WEBHOOK_AUTH.
// app_user_id is the Supabase user id (the app calls Purchases.logIn(user.id)).
import { adminClient, error, errMessage, json, notConfigured, preflight, readJson, safeEqual } from '../_shared/http.ts';

type Plan = 'free' | 'premium' | 'family' | 'student';

type RcEvent = {
  id?: string;
  transaction_id?: string;
  type?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  transferred_to?: string[];
  entitlement_ids?: string[] | null;
  entitlement_id?: string | null;
  product_id?: string;
  new_product_id?: string;
  expiration_at_ms?: number | null;
  cancel_reason?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE']);
const REVOKE = new Set(['CANCELLATION', 'EXPIRATION']);

/** Highest plan wins when several entitlements are active. */
const RANK: Plan[] = ['family', 'premium', 'student'];

function planFrom(ids: string[], productId: string): Plan {
  const set = new Set(ids.map((i) => i.toLowerCase()));
  for (const p of RANK) if (set.has(p)) return p;
  const pid = productId.toLowerCase();
  for (const p of RANK) if (pid.includes(p)) return p;
  return 'premium'; // a paid event with an unknown entitlement still unlocks premium
}

function userIdOf(e: RcEvent): string | null {
  const candidates = [e.app_user_id, e.original_app_user_id, ...(e.aliases ?? [])];
  return candidates.find((c): c is string => typeof c === 'string' && UUID.test(c)) ?? null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return error(405, 'method_not_allowed');

  const expected = Deno.env.get('REVENUECAT_WEBHOOK_AUTH');
  if (!expected) return notConfigured('revenuecat');
  const got = req.headers.get('Authorization') ?? '';
  // RevenueCat sends the configured value verbatim; accept it with or without a "Bearer " prefix.
  if (!safeEqual(got, expected) && !safeEqual(got.replace(/^Bearer\s+/i, ''), expected.replace(/^Bearer\s+/i, ''))) {
    return error(401, 'unauthorized');
  }

  const admin = adminClient();
  if (!admin) return notConfigured('supabase');

  const body = await readJson(req);
  const event = (body?.event ?? null) as RcEvent | null;
  if (!event?.type) return error(400, 'invalid_body', { message: 'missing event' });
  if (event.type === 'TEST') return json({ ok: true, ignored: 'test' });

  // Gift products (consumable / non-renewing, product id contains "gift", e.g. zoyra_gift_3m): the buyer gets a
  // redeemable code, NOT a plan. Months come from the product id (1m / 3m / 12m, or "1_month" …).
  const productId = (event.new_product_id ?? event.product_id ?? '').toLowerCase();
  if (/gift/.test(productId) && (event.type === 'NON_RENEWING_PURCHASE' || event.type === 'INITIAL_PURCHASE')) {
    const m = /(?:^|[^0-9])(12|3|1)[\s_-]*(?:m\b|mo|month)/.exec(productId) ?? /(?:^|[^0-9])(12|3|1)(?:[^0-9]|$)/.exec(productId);
    const months = m ? Number(m[1]) : 0;
    const buyer = userIdOf(event);
    if (!buyer || ![1, 3, 12].includes(months)) return json({ ok: true, ignored: 'gift_unrecognised' });
    const { data, error: gErr } = await admin.rpc('grant_gift', { p_buyer: buyer, p_months: months, p_store_ref: event.id ?? event.transaction_id ?? null });
    if (gErr) return error(500, 'gift_failed', { message: gErr.message });
    return json({ ok: true, gift: true, user_id: buyer, months, created: !!data });
  }

  let plan: Plan | null = null;
  if (GRANT.has(event.type)) {
    const ids = event.entitlement_ids ?? (event.entitlement_id ? [event.entitlement_id] : []);
    plan = planFrom(ids, event.new_product_id ?? event.product_id ?? '');
  } else if (REVOKE.has(event.type)) {
    // CANCELLATION = auto-renew turned off; access lasts until expiry. Downgrade now only when
    // it is a refund (CUSTOMER_SUPPORT) or the period already ended. EXPIRATION always downgrades.
    const expired = !event.expiration_at_ms || event.expiration_at_ms <= Date.now();
    if (event.type === 'EXPIRATION' || event.cancel_reason === 'CUSTOMER_SUPPORT' || expired) plan = 'free';
  }
  if (!plan) return json({ ok: true, ignored: event.type });

  const userId = userIdOf(event);
  if (!userId) return json({ ok: true, ignored: 'no_supabase_user' });

  try {
    const { error: upErr } = await admin
      .from('profiles')
      .update({ plan, updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (upErr) throw upErr;
    return json({ ok: true, user_id: userId, plan });
  } catch (e) {
    // 500 makes RevenueCat retry later.
    return error(500, 'update_failed', { message: errMessage(e) });
  }
});
