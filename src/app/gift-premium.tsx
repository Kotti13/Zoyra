import { useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';

import { Button, Glass, Icon, ListGroup, ListRow, Overline, Row, Screen, ScreenHeader, SongPicker, T, Tap, Toast, useAsync, useDebounced } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { ChatAvatar } from '../lib/chat-ui';
import { searchContacts, type DmContact } from '../lib/dm';
import { cleanCode, formatCode, giftError, listMyGifts, monthsLabel, redeemGift, sendGift, waitForNewGift, type Gift } from '../lib/gifts';
import { PAYMENTS_UNAVAILABLE, getGiftOffers, paymentsAvailable, purchaseGift, type GiftMonths, type GiftOffer } from '../lib/payments';
import { useAuth } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

type Note = { text: string; error?: boolean };
type When = 'now' | 'tonight' | 'tomorrow';

const MONTHS: GiftMonths[] = [1, 3, 12];

function deliverAt(w: When): Date | null {
  if (w === 'now') return null;
  const d = new Date();
  if (w === 'tonight') {
    d.setHours(21, 0, 0, 0);
    if (d.getTime() < Date.now() + 5 * 60_000) d.setTime(Date.now() + 3 * 3600_000);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
}
const whenLabel = (w: When) => {
  const d = deliverAt(w);
  return !d ? 'Right now' : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

const chip = (on: boolean) => ({
  minHeight: 44,
  paddingHorizontal: 16,
  borderRadius: 22,
  justifyContent: 'center' as const,
  borderWidth: on ? 2 : 1,
  borderColor: on ? colors.accentLight : colors.glassBorder,
  backgroundColor: on ? withAlpha(colors.accent, 0.22) : colors.bgTertiary,
});

/**
 * Gift Premium (`/gift-premium[?code=]`). Buy 1 / 3 / 12 months through the store gift products, pick a friend, a
 * delivery time, a note and a song; the gift code goes to them in a chat message (scheduled when not "Right now").
 * Redeem a code below (or open the link in the message). Gifts bought but not yet sent stay in "Your gifts".
 */
export default function GiftPremium() {
  const { user, profile, refresh } = useAuth();
  const me = user?.id;
  const params = useLocalSearchParams<{ code?: string }>();
  const available = paymentsAvailable();

  const [months, setMonths] = useState<GiftMonths>(3);
  const [to, setTo] = useState<DmContact | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const [when, setWhen] = useState<When>('now');
  const [track, setTrack] = useState<CatalogTrack | null>(null);
  const [pickSong, setPickSong] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'send' | 'redeem' | null>(null);
  const [msg, setMsg] = useState<Note | null>(null);
  const [code, setCode] = useState(typeof params.code === 'string' ? formatCode(cleanCode(params.code).slice(0, 12)) : '');
  const [offers, setOffers] = useState<GiftOffer[] | null>(null);
  const [offersError, setOffersError] = useState<string | null>(null);

  const contacts = useAsync(() => (me ? searchContacts(q) : Promise.resolve([] as DmContact[])), [q, me], 'app/gift-premium:71');
  const gifts = useAsync(() => (me ? listMyGifts(me) : Promise.resolve([] as Gift[])), [me], 'app/gift-premium:72');
  const people = useMemo(() => (contacts.data ?? []).filter((c) => c.access !== 'blocked' && c.id !== me).slice(0, 6), [contacts.data, me]);
  const unsent = (gifts.data ?? []).filter((g) => !g.sent_at && !g.redeemed_at);

  useEffect(() => {
    if (!me || !available) return;
    let alive = true;
    getGiftOffers(me)
      .then((o) => alive && setOffers(o))
      .catch((e: unknown) => alive && setOffersError(e instanceof Error ? e.message : 'Could not load gift prices'));
    return () => {
      alive = false;
    };
  }, [me, available]);

  const offer = offers?.find((o) => o.months === months);
  const spare = unsent.find((g) => g.months === months);
  const base = offers?.find((o) => o.months === 1);
  const saving = (m: GiftMonths) => {
    const o = offers?.find((x) => x.months === m);
    if (!o || !base || m === 1) return null;
    const pct = Math.round((1 - o.pkg.product.price / (base.pkg.product.price * m)) * 100);
    return pct >= 3 ? `Save ${pct}%` : null;
  };
  const fromName = profile?.display_name || 'A friend';

  const send = async () => {
    if (!me || !to || busy) return;
    setMsg(null);
    setBusy('send');
    try {
      let gift: Gift | undefined = spare;
      if (!gift) {
        if (!available) throw new Error(PAYMENTS_UNAVAILABLE);
        if (!offer) throw new Error(offersError ?? 'This gift isn’t on sale in this store yet.');
        const known = new Set((gifts.data ?? []).map((g) => g.id));
        if ((await purchaseGift(me, offer)) === 'cancelled') return;
        const fresh = await waitForNewGift(me, known);
        if (!fresh) {
          await gifts.reload();
          throw new Error('The store confirmed your gift. It will show under “Your gifts” in a moment: open it there to send.');
        }
        gift = fresh;
      }
      const r = await sendGift(me, { gift, to, fromName, note, track, deliverAt: deliverAt(when) });
      setMsg({ text: r === 'scheduled' ? `Gift scheduled for ${to.display_name}.` : `Gift sent to ${to.display_name}.` });
      setNote('');
      setTrack(null);
      setPickSong(false);
      await gifts.reload();
    } catch (e) {
      setMsg({ text: giftError(e, 'Could not send the gift'), error: true });
      await gifts.reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const redeem = async () => {
    if (busy || cleanCode(code).length !== 12) return;
    setMsg(null);
    setBusy('redeem');
    try {
      const r = await redeemGift(code);
      setCode('');
      await refresh().catch(() => undefined);
      setMsg({ text: `You have Premium for ${monthsLabel(r.months)}, until ${new Date(r.until).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}.` });
    } catch (e) {
      setMsg({ text: giftError(e, 'Could not redeem that code'), error: true });
    } finally {
      setBusy(null);
    }
  };

  const priceOf = (m: GiftMonths) => (spare && spare.months === m ? 'Ready' : offers?.find((o) => o.months === m)?.priceString ?? '—');
  const canSend = !!to && !busy && (!!spare || (available && !!offer));
  const label = busy === 'send' ? 'Working…' : spare ? 'Send gift' : offer ? `Send gift · ${offer.priceString}` : 'Send gift';

  if (!user) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral' }}>
        <ScreenHeader title="Gift Premium" />
        <T color={colors.textSecondary}>Sign in to give or redeem a gift.</T>
        <Button label="Sign in" href="/login" />
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={18} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Gift Premium" />
      <T size={14} color={colors.textSecondary} style={{ marginTop: -8 }}>
        Give someone ad-free music, offline listening and more.
      </T>

      {!available ? (
        <Glass padding={14}>
          <Row gap={10} align="flex-start">
            <Icon name="info" size={18} color={colors.textSecondary} />
            <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
              Buying a gift needs the store build with the gift products set up. You can still redeem a code below, and send gifts you already bought.
            </T>
          </Row>
        </Glass>
      ) : offersError ? (
        <T size={13} color={colors.error}>
          {offersError}
        </T>
      ) : null}

      <Glass padding={16} style={{ gap: 14 }}>
        <T size={17} weight={600}>
          {to ? `A gift for ${to.display_name.split(' ')[0]}` : 'Pick a plan'}
        </T>
        <View style={{ gap: 8 }}>
          {MONTHS.map((m) => {
            const on = m === months;
            const save = saving(m);
            return (
              <Tap key={m} onPress={() => setMonths(m)} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${monthsLabel(m)}, ${priceOf(m)}`} style={[chip(on), { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 60, borderRadius: 24 }]}>
                <View style={{ flex: 1 }}>
                  <T size={16} weight={600}>
                    {monthsLabel(m)}
                  </T>
                  <T size={12} color={colors.textSecondary}>
                    {save ?? 'One time payment'}
                  </T>
                </View>
                <T size={16} weight={700}>
                  {priceOf(m)}
                </T>
              </Tap>
            );
          })}
        </View>
      </Glass>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>SEND TO</Overline>
        {to ? (
          <Glass padding={12}>
            <Row gap={12}>
              <ChatAvatar person={to} size={40} radius={13} />
              <T size={16} weight={600} style={{ flex: 1 }} numberOfLines={1}>
                {to.display_name}
              </T>
              <Tap onPress={() => setTo(null)} accessibilityLabel="Choose someone else" style={{ minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'flex-end' }}>
                <T size={14} weight={600} color={colors.accentLight}>
                  Change
                </T>
              </Tap>
            </Row>
          </Glass>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.bgTertiary }}>
              <Icon name="search" size={18} color={colors.textSecondary} />
              <TextInput value={query} onChangeText={setQuery} placeholder="Search friends" placeholderTextColor={colors.textTertiary} accessibilityLabel="Search friends" autoCorrect={false} style={{ flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }} />
            </View>
            {contacts.loading && !contacts.data ? (
              <ActivityIndicator color={colors.accent} style={{ minHeight: 44 }} />
            ) : people.length ? (
              <Glass padding={4}>
                {people.map((c, i) => (
                  <ListRow key={c.id} title={c.display_name} subtitle={c.username ? `@${c.username}` : undefined} divider={i > 0} minHeight={60} leading={<ChatAvatar person={c} size={40} radius={13} />} onPress={() => setTo(c)} right={false} />
                ))}
              </Glass>
            ) : (
              <T size={13} color={colors.textSecondary}>
                {q ? `No one found for “${q}”.` : 'Follow people to gift them Premium.'}
              </T>
            )}
          </>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>DELIVER ON</Overline>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {(['now', 'tonight', 'tomorrow'] as When[]).map((w) => (
            <Tap key={w} onPress={() => setWhen(w)} accessibilityRole="radio" accessibilityState={{ selected: when === w }} style={chip(when === w)}>
              <T size={14} weight={600}>
                {w === 'now' ? 'Now' : w === 'tonight' ? 'Tonight' : 'Tomorrow'}
              </T>
            </Tap>
          ))}
        </View>
        <T size={13} color={colors.textSecondary}>
          {when === 'now' ? 'Arrives by message right away.' : `Arrives by message on ${whenLabel(when)}.`}
        </T>
      </View>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>PERSONAL TOUCH</Overline>
        <TextInput value={note} onChangeText={setNote} placeholder="Add a note (optional)" placeholderTextColor={colors.textTertiary} accessibilityLabel="Personal note" maxLength={240} multiline style={{ minHeight: 56, borderRadius: 20, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 15, paddingHorizontal: 16, paddingVertical: 14 }} />
        {track ? (
          <Glass padding={12}>
            <Row gap={12}>
              <Icon name="music" size={20} color={colors.accentLight} />
              <View style={{ flex: 1 }}>
                <T size={15} weight={600} numberOfLines={1}>
                  {track.title}
                </T>
                <T size={13} color={colors.textSecondary} numberOfLines={1}>
                  {track.artist.name}
                </T>
              </View>
              <Tap onPress={() => setTrack(null)} accessibilityLabel="Remove song" style={{ minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="close" size={18} color={colors.textSecondary} />
              </Tap>
            </Row>
          </Glass>
        ) : (
          <Tap onPress={() => setPickSong((v) => !v)} accessibilityRole="button" style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="plus" size={18} color={colors.accentLight} />
            <T size={15} weight={600} color={colors.accentLight}>
              Add a song
            </T>
          </Tap>
        )}
        {pickSong && !track ? (
          <SongPicker
            busyLabel="Added"
            maxHeight={320}
            onPick={(t) => {
              setTrack(t);
              setPickSong(false);
            }}
          />
        ) : null}
      </View>

      <Button label={label} icon="send" variant={canSend ? 'primary' : 'disabled'} onPress={() => void send()} />
      {!to ? (
        <T size={12} color={colors.textTertiary} align="center" style={{ marginTop: -8 }}>
          Choose who it’s for first.
        </T>
      ) : null}

      {unsent.length ? (
        <ListGroup title="BOUGHT, NOT SENT YET">
          {unsent.map((g, i) => (
            <ListRow key={g.id} title={`${monthsLabel(g.months)} of Premium`} subtitle="Choose a friend above, then tap Send gift" icon="send" divider={i > 0} onPress={() => setMonths(g.months)} right={false} />
          ))}
        </ListGroup>
      ) : null}

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>REDEEM A GIFT</Overline>
        <Row gap={8}>
          <TextInput value={code} onChangeText={(v) => setCode(formatCode(cleanCode(v).slice(0, 12)))} placeholder="XXXX-XXXX-XXXX" placeholderTextColor={colors.textTertiary} accessibilityLabel="Gift code" autoCapitalize="characters" autoCorrect={false} style={{ flex: 1, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.mono ?? fonts.regular, fontSize: 15, paddingHorizontal: 16, letterSpacing: 1 }} />
          <Button label={busy === 'redeem' ? 'Redeeming…' : 'Redeem'} variant={cleanCode(code).length === 12 && !busy ? 'primary' : 'disabled'} onPress={() => void redeem()} style={{ paddingHorizontal: 4 }} />
        </Row>
      </View>

      {(gifts.data ?? []).some((g) => g.sent_at || g.redeemed_at) ? (
        <ListGroup title="GIFTS YOU SENT">
          {(gifts.data ?? [])
            .filter((g) => g.sent_at || g.redeemed_at)
            .slice(0, 8)
            .map((g, i) => (
              <ListRow key={g.id} title={`${monthsLabel(g.months)} of Premium`} subtitle={g.redeemed_at ? `Redeemed ${new Date(g.redeemed_at).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'Sent, not redeemed yet'} icon={g.redeemed_at ? 'check' : 'send'} divider={i > 0} right={false} />
            ))}
        </ListGroup>
      ) : null}

      {msg ? <Toast icon={msg.error ? 'info' : 'check'} iconColor={msg.error ? colors.error : colors.success} message={msg.text} /> : null}
    </Screen>
  );
}
