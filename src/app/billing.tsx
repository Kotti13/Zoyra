import { useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import type { CustomerInfo, PurchasesEntitlementInfo } from 'react-native-purchases';

import { EmptyState, Glass, Gradient, Icon, LinkText, Loading, Row, Screen, ScreenHeader, SectionHeader, Sticker, T, Toast, useAsync } from '../components';
import { PAYMENTS_UNAVAILABLE, getCustomerInfo, manageSubscription, paymentsAvailable } from '../lib/payments';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const STORE_NAME: Record<string, string> = {
  APP_STORE: 'App Store',
  MAC_APP_STORE: 'Mac App Store',
  PLAY_STORE: 'Google Play',
  AMAZON: 'Amazon Appstore',
  STRIPE: 'Stripe',
  PROMOTIONAL: 'Promotional',
  RC_BILLING: 'Web billing',
  TEST_STORE: 'Test store',
};
const storeName = (s: string) => STORE_NAME[s] ?? (Platform.OS === 'ios' ? 'App Store' : 'Google Play');
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);

export default function Billing() {
  const { user, profile, refresh: refreshProfile } = useAuth();
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [managing, setManaging] = useState(false);
  const plan = profile?.plan ?? 'free';
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const paid = plan !== 'free';
  const available = paymentsAvailable();

  // Pull to refresh asks RevenueCat for a fresh copy (not its cache) and re-reads the plan from the profile.
  const fresh = useRef(false);
  const info = useAsync<CustomerInfo | null>(async () => {
    const skipCache = fresh.current;
    fresh.current = false;
    return user && available ? getCustomerInfo(user.id, skipCache) : null;
  }, [user?.id, available]);
  const pullRefresh = () => {
    fresh.current = true;
    return Promise.all([info.refresh(), refreshProfile().catch(() => undefined)]);
  };
  const active: PurchasesEntitlementInfo[] = info.data ? Object.values(info.data.entitlements.active) : [];
  const ent = active[0];

  const manage = async () => {
    if (managing) return;
    setManaging(true);
    setNote(null);
    try {
      await manageSubscription(user?.id ?? null);
    } catch {
      setNote({ text: 'Could not open subscription settings. Manage it from your app store account.', error: true });
    } finally {
      setManaging(false);
    }
  };

  const statusLine = ent
    ? ent.willRenew
      ? `Renews ${fmtDate(ent.expirationDate) ?? ''}`.trim()
      : ent.expirationDate
        ? `Cancelled · ends ${fmtDate(ent.expirationDate)}`
        : 'Lifetime access'
    : paid
      ? 'Managed by your app store account'
      : 'No subscription. Upgrade any time from Plans.';

  const purchases = info.data
    ? Object.entries(info.data.allPurchaseDates)
        .filter((e): e is [string, string] => !!e[1])
        .sort((a, b) => b[1].localeCompare(a[1]))
    : [];

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'coral' }} onRefresh={user ? pullRefresh : undefined}>
      <ScreenHeader title="Billing" />

      {/* Current plan */}
      <Gradient colors={[colors.accent, colors.like]} style={{ borderRadius: 32, padding: 20, gap: 6 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={24} weight={700} color={colors.onAccent}>
            {planName}
          </T>
          <Sticker label={ent && !ent.willRenew ? 'ENDING' : 'ACTIVE'} rotate={3} />
        </Row>
        <T size={14} color={colors.onAccent}>
          {statusLine}
        </T>
        {ent?.billingIssueDetectedAt ? (
          <T size={13} weight={600} color={colors.onAccent}>
            Payment problem detected. Update your payment method in the store.
          </T>
        ) : null}
      </Gradient>

      {!available ? <Toast icon="info" iconColor={colors.accentLight} message={PAYMENTS_UNAVAILABLE} /> : null}

      <SectionHeader title="Payment method" />
      <Glass padding={4}>
        <Row gap={12} style={{ minHeight: 68, paddingHorizontal: 8 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="lock" size={20} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={16} weight={500}>
              {ent ? storeName(ent.store) : Platform.OS === 'ios' ? 'App Store' : 'Google Play'}
            </T>
            <T size={14} color={colors.textSecondary}>
              Cards and billing are handled by the store
            </T>
          </View>
          <LinkText label={managing ? 'Opening…' : 'Change'} onPress={() => void manage()} />
        </Row>
      </Glass>

      {note ? <Toast icon="info" iconColor={note.error ? colors.error : colors.accentLight} message={note.text} /> : null}

      <SectionHeader title="Purchases" />
      <Glass padding={4}>
        {!available ? (
          <EmptyState icon="mail" title="No purchase history here" body="Receipts are in your app store account. They show here in the app build once RevenueCat is set up." />
        ) : info.loading ? (
          <Loading label="Loading purchases" />
        ) : info.error ? (
          <Toast icon="info" iconColor={colors.error} message={info.error} action="Retry" onAction={info.reload} />
        ) : purchases.length === 0 ? (
          <EmptyState icon="mail" title="No purchases yet" body="Receipts from your app store will appear here after your first purchase." />
        ) : (
          purchases.map(([product, date], i) => (
            <Row key={product} gap={12} style={{ minHeight: 56, paddingHorizontal: 12, borderTopWidth: i > 0 ? 1 : 0, borderTopColor: colors.hairline }}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={15} weight={500} numberOfLines={1}>
                  {product}
                </T>
                <T size={13} color={colors.textSecondary}>
                  {info.data?.activeSubscriptions.includes(product) ? 'Active' : 'Past purchase'}
                </T>
              </View>
              <T mono size={12} color={colors.textSecondary}>
                {fmtDate(date)}
              </T>
            </Row>
          ))
        )}
      </Glass>

      {paid || ent ? (
        <View style={{ alignItems: 'center' }}>
          <LinkText label={managing ? 'Opening…' : 'Manage or cancel subscription'} color={colors.error} onPress={() => void manage()} />
        </View>
      ) : (
        <View style={{ alignItems: 'center' }}>
          <LinkText label="See plans" href="/plans" />
        </View>
      )}
    </Screen>
  );
}
