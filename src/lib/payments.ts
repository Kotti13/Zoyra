import { Linking, NativeModules, Platform } from 'react-native';
import Purchases, { PACKAGE_TYPE, type CustomerInfo, type PurchasesOffering, type PurchasesOfferings, type PurchasesPackage } from 'react-native-purchases';

import { supabase } from './supabase';

/**
 * In-app subscriptions through RevenueCat. The app only buys / restores; `profiles.plan` is written by the
 * `revenuecat-webhook` edge function, so after a purchase we poll the profile row.
 *
 * Offering convention (RevenueCat dashboard): offerings with identifiers `premium`, `family`, `student`, each
 * with a Monthly and an Annual package. Fallback: packages in the current offering whose identifier or product
 * id contains the plan name; any plain monthly/annual package in the current offering counts as Premium.
 */

export const PAYMENTS_UNAVAILABLE = 'Payments need the app build + RevenueCat setup';

export type PaidPlan = 'premium' | 'family' | 'student';
export type Period = 'monthly' | 'annual';
export type PlanOffer = { plan: PaidPlan; period: Period; priceString: string; pkg: PurchasesPackage };

export class PaymentsUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail ? `${PAYMENTS_UNAVAILABLE} (${detail})` : PAYMENTS_UNAVAILABLE);
    this.name = 'PaymentsUnavailableError';
  }
}

const apiKey = (): string =>
  (Platform.OS === 'ios' ? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY : Platform.OS === 'android' ? process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY : '') ?? '';

/** True only in a native build that links RNPurchases and has a key for this platform (false in Expo Go / web). */
export function paymentsAvailable(): boolean {
  try {
    return (Platform.OS === 'ios' || Platform.OS === 'android') && !!NativeModules.RNPurchases && apiKey().length > 0;
  } catch {
    return false;
  }
}

let configuredUser: string | null = null;

async function ensure(userId: string): Promise<void> {
  if (!paymentsAvailable()) throw new PaymentsUnavailableError();
  try {
    if (!configuredUser) {
      Purchases.configure({ apiKey: apiKey(), appUserID: userId });
      configuredUser = userId;
    } else if (configuredUser !== userId) {
      await Purchases.logIn(userId);
      configuredUser = userId;
    }
  } catch (e) {
    throw new PaymentsUnavailableError(e instanceof Error ? e.message : undefined);
  }
}

const PLANS: PaidPlan[] = ['premium', 'family', 'student'];

const periodOf = (p: PurchasesPackage): Period | null =>
  p.packageType === PACKAGE_TYPE.MONTHLY ? 'monthly' : p.packageType === PACKAGE_TYPE.ANNUAL ? 'annual' : /annual|year/i.test(p.identifier + p.product.identifier) ? 'annual' : /month/i.test(p.identifier + p.product.identifier) ? 'monthly' : null;

function offersFrom(offerings: PurchasesOfferings): PlanOffer[] {
  const out: PlanOffer[] = [];
  const have = (plan: PaidPlan, period: Period) => out.some((o) => o.plan === plan && o.period === period);
  const add = (plan: PaidPlan, pkg: PurchasesPackage) => {
    const period = periodOf(pkg);
    if (period && !have(plan, period)) out.push({ plan, period, priceString: pkg.product.priceString, pkg });
  };
  // 1. Dedicated offerings per plan.
  for (const plan of PLANS) {
    const off: PurchasesOffering | undefined = offerings.all[plan];
    off?.availablePackages.forEach((p) => add(plan, p));
  }
  // 2. Plan name inside the package / product id of the current offering.
  const current = offerings.current?.availablePackages ?? [];
  for (const p of current) {
    const id = `${p.identifier} ${p.product.identifier}`.toLowerCase();
    if (id.includes('gift')) continue; // gift products are sold from the Gift Premium screen, never as a plan
    const plan = PLANS.find((x) => id.includes(x));
    if (plan) add(plan, p);
  }
  // 3. Anything else in the current offering is Premium.
  for (const p of current) {
    const id = `${p.identifier} ${p.product.identifier}`.toLowerCase();
    if (id.includes('gift')) continue;
    if (!PLANS.some((x) => x !== 'premium' && id.includes(x))) add('premium', p);
  }
  return out;
}

export async function getPlanOffers(userId: string): Promise<PlanOffer[]> {
  await ensure(userId);
  try {
    return offersFrom(await Purchases.getOfferings());
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Could not load prices from the store');
  }
}

const isCancel = (e: unknown) => !!e && typeof e === 'object' && (e as { userCancelled?: boolean | null }).userCancelled === true;

/** Buys the package. Resolves 'cancelled' if the user backed out of the store sheet. */
export async function purchase(userId: string, pkg: PurchasesPackage): Promise<'purchased' | 'cancelled'> {
  await ensure(userId);
  try {
    await Purchases.purchasePackage(pkg);
    return 'purchased';
  } catch (e) {
    if (isCancel(e)) return 'cancelled';
    throw new Error(e instanceof Error ? e.message : 'Purchase failed');
  }
}

export async function restore(userId: string): Promise<CustomerInfo> {
  await ensure(userId);
  try {
    return await Purchases.restorePurchases();
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Could not restore purchases');
  }
}

export async function getCustomerInfo(userId: string, fresh = false): Promise<CustomerInfo> {
  await ensure(userId);
  try {
    // Pull to refresh: drop RevenueCat's cached copy so a renewal / cancellation made elsewhere shows up.
    if (fresh) await Purchases.invalidateCustomerInfoCache().catch(() => undefined);
    return await Purchases.getCustomerInfo();
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Could not load your subscription');
  }
}

const STORE_SUBSCRIPTIONS_URL = Platform.OS === 'ios' ? 'https://apps.apple.com/account/subscriptions' : 'https://play.google.com/store/account/subscriptions';

/** Store subscription management: the native sheet when available, otherwise the store's web page. */
export async function manageSubscription(userId: string | null): Promise<void> {
  if (userId && paymentsAvailable()) {
    try {
      await ensure(userId);
      if (Platform.OS === 'ios') {
        await Purchases.showManageSubscriptions();
        return;
      }
      const info = await Purchases.getCustomerInfo();
      if (info.managementURL) {
        await Linking.openURL(info.managementURL);
        return;
      }
    } catch {
      // Fall through to the store URL.
    }
  }
  await Linking.openURL(STORE_SUBSCRIPTIONS_URL);
}

/**
 * The webhook writes `profiles.plan`; poll it for up to `timeoutMs`.
 * Resolves the plan once `accept(plan)` is true, or null on timeout.
 */
export async function waitForPlan(userId: string, accept: (plan: string) => boolean, timeoutMs = 10_000): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { data } = await supabase.from('profiles').select('plan').eq('id', userId).single();
    const plan = (data as { plan?: string } | null)?.plan;
    if (plan && accept(plan)) return plan;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/* ------------------------------------------------------------------ gifts */

export type GiftMonths = 1 | 3 | 12;
export type GiftOffer = { months: GiftMonths; priceString: string; pkg: PurchasesPackage };

/** "gift_3m" / "gift-12-months" / "1month" → 3 / 12 / 1, or null. */
const giftMonths = (id: string): GiftMonths | null => {
  const m = /(?:^|[^0-9])(12|3|1)[\s_-]*(?:m\b|mo|month)/i.exec(id) ?? /(?:^|[^0-9])(12|3|1)(?:[^0-9]|$)/.exec(id);
  return m ? (Number(m[1]) as GiftMonths) : null;
};

/**
 * Gift products from RevenueCat: any package whose identifier or store product id contains "gift" and 1 / 3 / 12
 * months (e.g. `zoyra_gift_1m`, `zoyra_gift_3m`, `zoyra_gift_12m`), best in an offering called `gift`. They must be
 * consumable / non-renewing products; the webhook turns each purchase into a redeemable code.
 */
export async function getGiftOffers(userId: string): Promise<GiftOffer[]> {
  await ensure(userId);
  try {
    const offerings = await Purchases.getOfferings();
    const pkgs = [...(offerings.all.gift?.availablePackages ?? []), ...Object.values(offerings.all).flatMap((o) => o.availablePackages)];
    const out: GiftOffer[] = [];
    for (const p of pkgs) {
      const id = `${p.identifier} ${p.product.identifier}`;
      if (!/gift/i.test(id)) continue;
      const months = giftMonths(id);
      if (months && !out.some((o) => o.months === months)) out.push({ months, priceString: p.product.priceString, pkg: p });
    }
    return out.sort((a, b) => a.months - b.months);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Could not load gift prices from the store');
  }
}

export async function purchaseGift(userId: string, offer: GiftOffer): Promise<'purchased' | 'cancelled'> {
  return purchase(userId, offer.pkg);
}
