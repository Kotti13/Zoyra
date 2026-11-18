import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';

import { Button, Icon, IconButton, LinkText, Row, Screen, ScreenHeader, Segmented, Sticker, T, Tap, Toast } from '../components';
import { PAYMENTS_UNAVAILABLE, getPlanOffers, manageSubscription, paymentsAvailable, purchase, restore, waitForPlan, type PaidPlan, type Period, type PlanOffer } from '../lib/payments';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type Plan = { name: string; features: { label: string; included: boolean }[]; badge?: string };

const plans: Plan[] = [
  {
    name: 'Premium',
    badge: 'BEST VALUE',
    features: [
      { label: 'Ad-free listening', included: true },
      { label: 'Offline downloads', included: true },
      { label: 'Lossless audio', included: true },
      { label: 'AI DJ and AI playlists', included: true },
    ],
  },
  {
    name: 'Family',
    features: [
      { label: 'Up to 6 accounts', included: true },
      { label: 'Block explicit content', included: true },
      { label: 'Everything in Premium', included: true },
    ],
  },
  {
    name: 'Student',
    features: [
      { label: 'Verify with student ID', included: true },
      { label: 'Everything in Premium', included: true },
    ],
  },
  {
    name: 'Free',
    features: [
      { label: 'Shuffle play with ads', included: true },
      { label: 'Offline downloads', included: false },
      { label: 'Lossless audio', included: false },
    ],
  },
];

const label = (plan: string) => plan.charAt(0).toUpperCase() + plan.slice(1);

type Note = { text: string; error?: boolean };

export default function Plans() {
  const { user, profile, refresh } = useAuth();
  const params = useLocalSearchParams<{ plan?: string }>();
  // The plan column is set only by the billing backend (RevenueCat webhook); the client just reads it.
  const current = label(profile?.plan ?? 'free');
  const wanted = typeof params.plan === 'string' ? label(params.plan.toLowerCase()) : null;
  const [selected, setSelected] = useState(wanted && plans.some((p) => p.name === wanted) ? wanted : current === 'Free' ? 'Premium' : current);
  const [period, setPeriod] = useState<Period>('annual');
  const [note, setNote] = useState<Note | null>(null);
  const [offers, setOffers] = useState<PlanOffer[] | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'buy' | 'restore' | 'manage' | 'confirm' | null>(null);
  const available = paymentsAvailable();
  const isCurrent = selected === current;
  const paid = current !== 'Free';

  useEffect(() => {
    if (!user || !available) return;
    let alive = true;
    getPlanOffers(user.id)
      .then((o) => alive && setOffers(o))
      .catch((e: unknown) => alive && setOffersError(e instanceof Error ? e.message : 'Could not load prices'));
    return () => {
      alive = false;
    };
  }, [user, available]);

  /* Pull to refresh: re-read the plan (store webhooks land on the profile) and the store prices. */
  const pullRefresh = () =>
    Promise.all([
      refresh().catch(() => undefined),
      user && available
        ? getPlanOffers(user.id)
            .then((o) => {
              setOffers(o);
              setOffersError(null);
            })
            .catch((e: unknown) => setOffersError(e instanceof Error ? e.message : 'Could not load prices'))
        : undefined,
    ]);

  const offerFor = (name: string): PlanOffer | undefined => {
    const plan = name.toLowerCase() as PaidPlan;
    return offers?.find((o) => o.plan === plan && o.period === period) ?? offers?.find((o) => o.plan === plan);
  };
  const priceLabel = (name: string) => {
    if (name === 'Free') return 'No cost';
    const o = offerFor(name);
    if (!o) return '—';
    return `${o.priceString}/${o.period === 'annual' ? 'yr' : 'mo'}`;
  };

  /** After a store purchase/restore, wait (≤10 s) for the webhook to update profiles.plan. */
  const confirm = async (accept: (plan: string) => boolean, done: string) => {
    if (!user) return;
    setBusy('confirm');
    const plan = await waitForPlan(user.id, accept).catch(() => null);
    await refresh().catch(() => {});
    setNote(
      plan
        ? { text: done }
        : { text: 'The store confirmed your purchase. Your plan will update in a moment. Reopen this screen if it does not.' },
    );
  };

  const buy = async () => {
    if (!user || busy) return;
    setNote(null);
    if (!available) return setNote({ text: PAYMENTS_UNAVAILABLE, error: true });
    const o = offerFor(selected);
    if (!o) return setNote({ text: offersError ?? `${selected} is not on sale in this store yet.`, error: true });
    setBusy('buy');
    try {
      const r = await purchase(user.id, o.pkg);
      if (r === 'cancelled') return;
      const target = o.plan;
      await confirm((p) => p === target, `You are now on ${selected}. Enjoy!`);
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Purchase failed', error: true });
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async () => {
    if (!user || busy) return;
    setNote(null);
    if (!available) return setNote({ text: PAYMENTS_UNAVAILABLE, error: true });
    setBusy('restore');
    try {
      const info = await restore(user.id);
      if (Object.keys(info.entitlements.active).length === 0) {
        setNote({ text: 'No active subscription found for this store account.' });
      } else {
        await confirm((p) => p !== 'free', 'Purchases restored.');
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not restore purchases', error: true });
    } finally {
      setBusy(null);
    }
  };

  const manage = async () => {
    if (busy) return;
    setBusy('manage');
    try {
      await manageSubscription(user?.id ?? null);
    } catch {
      setNote({ text: 'Could not open subscription settings. Manage it from your app store account.', error: true });
    } finally {
      setBusy(null);
    }
  };

  const ctaLabel =
    busy === 'buy' ? 'Opening store…' : busy === 'confirm' ? 'Confirming…' : current === 'Free' ? `Get ${selected}` : `Switch to ${selected}`;

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'dots', mesh: 'amberRose' }} onRefresh={user ? pullRefresh : undefined}>
      <ScreenHeader title="Go Premium" right={<IconButton icon="close" label="Close" href="back" />} />

      <View style={{ gap: 8 }}>
        <T size={26} weight={700} tracking={-0.5} lineHeight={30} accessibilityRole="header">
          Music without limits
        </T>
        <T size={16} color={colors.textSecondary} lineHeight={23}>
          {current === 'Free' ? 'Pick a plan. Cancel any time from your app store.' : `You are on ${current}.`}
        </T>
      </View>

      {!available ? <Toast icon="info" iconColor={colors.accentLight} message={PAYMENTS_UNAVAILABLE} /> : null}
      {available && offersError ? <Toast icon="info" iconColor={colors.error} message={offersError} /> : null}

      <Segmented options={['Monthly', 'Yearly']} initial={1} onChange={(i) => setPeriod(i === 0 ? 'monthly' : 'annual')} />

      {plans.map((p) => {
        const on = p.name === selected;
        const isMine = p.name === current;
        return (
          <Tap
            key={p.name}
            onPress={() => {
              setSelected(p.name);
              setNote(null);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${p.name} plan`}
            style={{
              borderRadius: 32,
              padding: 20,
              gap: 12,
              borderWidth: on ? 2 : 1,
              borderColor: on ? colors.accentLight : colors.glassBorder,
              backgroundColor: on ? withAlpha(colors.accent, 0.16) : colors.glass,
            }}
          >
            {p.badge ? (
              <View style={{ position: 'absolute', top: -12, right: 20 }}>
                <Sticker label={p.badge} rotate={3} />
              </View>
            ) : null}
            <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <T size={20} weight={700}>
                {p.name}
              </T>
              {isMine ? (
                <T size={14} weight={700} color={colors.accentLight}>
                  CURRENT PLAN
                </T>
              ) : available && !offers && !offersError && p.name !== 'Free' ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <T size={18} weight={700}>
                  {priceLabel(p.name)}
                </T>
              )}
            </Row>
            {p.features.map((f) => (
              <Row key={f.label} gap={10} style={{ minHeight: 28 }}>
                <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: f.included ? colors.success : colors.track, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={f.included ? 'check' : 'close'} size={f.included ? 14 : 12} color={f.included ? colors.onAccent : colors.textSecondary} />
                </View>
                <T size={14} color={f.included ? colors.text : colors.textSecondary}>
                  {f.label}
                </T>
              </Row>
            ))}
          </Tap>
        );
      })}

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.error : colors.success} message={note.text} /> : null}

      {isCurrent ? (
        <Button label="Your current plan" variant="disabled" />
      ) : selected === 'Free' ? (
        // Downgrading = cancelling the store subscription; the webhook moves the plan back to Free when it lapses.
        <Button label={busy === 'manage' ? 'Opening…' : 'Cancel in your app store'} variant={busy ? 'disabled' : 'secondary'} onPress={() => void manage()} />
      ) : (
        <Button label={ctaLabel} variant={busy ? 'disabled' : 'primary'} onPress={() => void buy()} />
      )}

      <Row style={{ justifyContent: 'center' }} gap={20}>
        <LinkText label={busy === 'restore' ? 'Restoring…' : 'Restore purchases'} onPress={() => void doRestore()} />
        {paid ? <LinkText label="Manage subscription" onPress={() => void manage()} /> : null}
      </Row>
      <Row style={{ justifyContent: 'center' }} gap={20}>
        <LinkText label="Gift Premium" icon="star" href="/gift-premium" />
        <LinkText label="Redeem a gift" href="/gift-premium" />
      </Row>
      <T size={12} color={colors.textSecondary} align="center" lineHeight={17}>
        Billed through your {Platform.OS === 'ios' ? 'Apple ID' : 'Google Play account'}. Renews automatically until cancelled.
      </T>
    </Screen>
  );
}
