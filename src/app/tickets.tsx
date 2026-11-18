import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, ChipRow, EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, LinkText, Loading, Row, Screen, ScreenHeader, T, TextField, Toast, useAsync } from '../components';
import { ServiceNotConfiguredError, TICKETMASTER_SETUP_MESSAGE, eventDate, fetchConcerts, priceRange, type ConcertEvent } from '../lib/concerts';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { art, colors, withAlpha } from '../theme/tokens';

/** Same saved city as the Concerts screen. */
const CITY_KEY = 'zoyra.concerts.city';
const CITIES = ['Chennai', 'Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'London', 'New York', 'Los Angeles', 'Toronto', 'Sydney', 'Berlin', 'Paris'];
const FILTERS = ['Upcoming', 'This week', 'This month', 'Interested'] as const;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY = 86_400_000;

type Load = { events: ConcertEvent[]; notConfigured: boolean };

const whenText = (e: ConcertEvent) => {
  const d = eventDate(e);
  if (Number.isNaN(d.getTime())) return 'Date to be announced';
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return /T\d{2}:\d{2}/.test(e.date) ? `${day} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : day;
};

/* ------------------------------------------------------------------ interests (event_interests) */

async function loadInterests(userId: string): Promise<ConcertEvent[]> {
  const { data, error } = await supabase.from('event_interests').select('event').eq('user_id', userId).order('event_date', { ascending: true, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { event: ConcertEvent }) => r.event).filter((e) => e && e.id && e.name);
}

async function setInterest(userId: string, e: ConcertEvent, on: boolean): Promise<void> {
  if (on) {
    const d = eventDate(e);
    const { error } = await supabase.from('event_interests').upsert({ user_id: userId, event_id: e.id, event: e, event_date: Number.isNaN(d.getTime()) ? null : d.toISOString() });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase.from('event_interests').delete().eq('user_id', userId).eq('event_id', e.id);
    if (error) throw new Error(error.message);
  }
}

/* ------------------------------------------------------------------ UI */

function Hero({ e, interested, onToggle, onTickets }: { e: ConcertEvent; interested: boolean; onToggle: () => void; onTickets: () => void }) {
  const price = priceRange(e);
  return (
    <Gradient colors={art.blue} style={{ height: 270, borderRadius: 32, overflow: 'hidden', justifyContent: 'flex-end' }}>
      {e.imageUrl ? <Image source={{ uri: e.imageUrl }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" transition={200} accessibilityIgnoresInvertColors /> : null}
      <Gradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.92)]} angle={180} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 200 }}>
        {null}
      </Gradient>
      <View style={{ position: 'absolute', top: 12, right: 12 }}>
        <IconButton icon="heart" filled={interested} label={interested ? 'Remove from interested' : 'Mark as interested'} color={interested ? colors.like : colors.white} bg={colors.shade} onPress={onToggle} />
      </View>
      <View style={{ padding: 18, gap: 6 }}>
        <T variant="overline" color={colors.accentLight}>
          NEXT UP
        </T>
        <T size={26} weight={300} tracking={-0.8} lineHeight={30} color={colors.white} numberOfLines={2}>
          {e.name}
        </T>
        <T size={13} color={colors.peach} numberOfLines={1}>
          {[whenText(e), e.venue, e.city].filter(Boolean).join(' · ')}
        </T>
        <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
          <T size={16} weight={600} color={colors.white}>
            {price ?? ''}
          </T>
          {e.url ? <Button label="Get tickets" height={42} onPress={onTickets} /> : null}
        </Row>
      </View>
    </Gradient>
  );
}

function EventRow({ e, now, interested, onToggle, onTickets }: { e: ConcertEvent; now: number; interested: boolean; onToggle: () => void; onTickets: () => void }) {
  const d = eventDate(e);
  const valid = !Number.isNaN(d.getTime());
  const past = valid && d.getTime() < now - DAY;
  const price = priceRange(e);
  return (
    <Glass radius={26} padding={14}>
      <Row gap={14}>
        <View style={{ width: 56, paddingVertical: 8, borderRadius: 18, backgroundColor: colors.accentTint, alignItems: 'center' }}>
          <T variant="overline" color={colors.accentLight}>
            {valid ? MONTHS[d.getMonth()] : 'TBA'}
          </T>
          <T size={24} weight={300}>
            {valid ? String(d.getDate()).padStart(2, '0') : '–'}
          </T>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={15} weight={600} numberOfLines={2}>
            {e.name}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={2}>
            {[past ? 'Past event' : null, e.venue, e.city, price].filter(Boolean).join(' · ')}
          </T>
          {e.url && !past ? <LinkText label="Tickets on Ticketmaster" size={13} onPress={onTickets} /> : null}
        </View>
        <IconButton icon="heart" filled={interested} label={interested ? `Remove ${e.name} from interested` : `Mark ${e.name} as interested`} color={interested ? colors.like : colors.textSecondary} onPress={onToggle} />
      </Row>
    </Glass>
  );
}

export default function Tickets() {
  const { user } = useAuth();
  const me = user?.id ?? null;
  const [city, setCity] = useState<string | null | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState(0);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [mine, setMine] = useState<ConcertEvent[]>([]);
  const [now] = useState(() => Date.now());
  const [mineState, setMineState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });

  useEffect(() => {
    AsyncStorage.getItem(CITY_KEY)
      .then((c) => {
        setCity(c);
        if (!c) setPicking(true);
      })
      .catch(() => {
        setCity(null);
        setPicking(true);
      });
  }, []);

  const reloadMine = useCallback(async () => {
    if (!me) return setMineState({ loading: false, error: null });
    setMineState({ loading: true, error: null });
    try {
      setMine(await loadInterests(me));
      setMineState({ loading: false, error: null });
    } catch (e) {
      setMineState({ loading: false, error: e instanceof Error ? e.message : 'Could not load your saved events.' });
    }
  }, [me]);

  useEffect(() => {
    let alive = true;
    if (!me) return;
    loadInterests(me)
      .then((list) => alive && (setMine(list), setMineState({ loading: false, error: null })))
      .catch((e: unknown) => alive && setMineState({ loading: false, error: e instanceof Error ? e.message : 'Could not load your saved events.' }));
    return () => {
      alive = false;
    };
  }, [me]);

  const chooseCity = (c: string) => {
    const v = c.trim();
    if (!v) return;
    setCity(v);
    setPicking(false);
    setDraft('');
    AsyncStorage.setItem(CITY_KEY, v).catch(() => {});
  };

  const res = useAsync<Load>(async () => {
    if (!city) return { events: [], notConfigured: false };
    try {
      return { events: await fetchConcerts({ city }), notConfigured: false };
    } catch (e) {
      if (e instanceof ServiceNotConfiguredError) return { events: [], notConfigured: true };
      throw e;
    }
  }, [city]);

  const mineIds = useMemo(() => new Set(mine.map((e) => e.id)), [mine]);
  const cat = FILTERS[filter];
  const events = useMemo(() => {
    const all = res.data?.events ?? [];
    if (cat === 'This week') return all.filter((e) => eventDate(e).getTime() - now < 7 * DAY);
    if (cat === 'This month') return all.filter((e) => eventDate(e).getTime() - now < 31 * DAY);
    return all;
  }, [res.data, cat, now]);

  const toggle = async (e: ConcertEvent) => {
    if (!me) return setNote({ ok: false, text: 'Sign in to save events.' });
    const on = !mineIds.has(e.id);
    // Optimistic; rolled back on failure.
    setMine((list) => (on ? [...list, e] : list.filter((x) => x.id !== e.id)));
    try {
      await setInterest(me, e, on);
      setNote({ ok: true, text: on ? 'Saved to Interested' : 'Removed from Interested' });
    } catch (err) {
      setMine((list) => (on ? list.filter((x) => x.id !== e.id) : [...list, e]));
      setNote({ ok: false, text: err instanceof Error ? err.message : 'Could not update.' });
    }
  };

  const openTickets = async (e: ConcertEvent) => {
    if (!e.url) return setNote({ ok: false, text: 'No ticket link for this event.' });
    try {
      await WebBrowser.openBrowserAsync(e.url);
    } catch {
      setNote({ ok: false, text: 'Could not open the ticket page.' });
    }
  };

  const hero = cat !== 'Interested' ? events.find((e) => e.imageUrl) ?? events[0] : undefined;
  const rest = hero ? events.filter((e) => e.id !== hero.id) : events;

  return (
    <Screen onRefresh={() => Promise.all([res.refresh(), me ? loadInterests(me).then((list) => setMine(list)).catch(() => undefined) : undefined])} top={4} gap={16} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Tickets
        </T>
        <Row gap={6}>
          <Icon name="pin" size={16} color={colors.accentLight} />
          <T size={15} color={colors.textSecondary} style={{ flex: 1 }} numberOfLines={1}>
            {city ? `Shows near ${city}` : 'Pick a city'}
          </T>
          <LinkText label={picking ? 'Done' : 'Change'} onPress={() => setPicking((p) => !p)} />
        </Row>
      </View>

      {picking ? (
        <Glass padding={14}>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CITIES.map((c) => (
                <Chip key={c} label={c} active={c === city} onPress={() => chooseCity(c)} />
              ))}
            </View>
            <TextField label="Other city" icon="search" value={draft} onChangeText={setDraft} placeholder="Type a city and press enter" returnKeyType="search" autoCapitalize="words" onSubmitEditing={() => chooseCity(draft)} />
          </View>
        </Glass>
      ) : null}

      <ChipRow options={[...FILTERS]} initial={0} onChange={setFilter} />

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.accentLight} message={note.text} /> : null}

      {cat === 'Interested' ? (
        !me ? (
          <EmptyState icon="heart" title="Sign in to save events" body="Events you mark as interested show up here." />
        ) : mineState.loading ? (
          <Loading label="Loading your saved events" />
        ) : mineState.error ? (
          <ErrorState message={mineState.error} onRetry={() => void reloadMine()} />
        ) : !mine.length ? (
          <EmptyState icon="heart" title="No saved events yet" body="Tap the heart on a show to keep it here." />
        ) : (
          mine.map((e) => <EventRow key={e.id} e={e} now={now} interested onToggle={() => void toggle(e)} onTickets={() => void openTickets(e)} />)
        )
      ) : res.data?.notConfigured ? (
        <Toast icon="info" iconColor={colors.accentLight} message={`${TICKETMASTER_SETUP_MESSAGE} Your saved events are still under Interested.`} />
      ) : !city ? (
        <EmptyState icon="search" title="Where are you?" body="Pick your city to see upcoming shows near you." />
      ) : res.loading ? (
        <Loading label={`Finding shows in ${city}`} />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !events.length ? (
        <EmptyState icon="search" title={res.data?.events.length ? 'Nothing in this range' : 'No upcoming shows'} body={res.data?.events.length ? 'Try another filter.' : `We couldn't find upcoming shows in ${city}. Try a nearby big city.`} />
      ) : (
        <>
          {hero ? <Hero e={hero} interested={mineIds.has(hero.id)} onToggle={() => void toggle(hero)} onTickets={() => void openTickets(hero)} /> : null}
          {rest.map((e) => (
            <EventRow key={e.id} e={e} now={now} interested={mineIds.has(e.id)} onToggle={() => void toggle(e)} onTickets={() => void openTickets(e)} />
          ))}
        </>
      )}

      <T size={12} color={colors.textSecondary} align="center">
        Zoyra doesn’t sell tickets. Listings come from Ticketmaster, and purchases happen on their site.
      </T>
    </Screen>
  );
}
