import AsyncStorage from '@react-native-async-storage/async-storage';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Chip, ChipRow, EmptyState, Glass, Icon, LinkText, Loading, Row, Screen, ScreenHeader, T, TextField, Toast, useAsync } from '../components';
import { EventCard } from '../components/EventCard';
import { ServiceNotConfiguredError, TICKETMASTER_SETUP_MESSAGE, eventDate, fetchConcerts, type ConcertEvent } from '../lib/concerts';
import { useLibrary } from '../state/library';
import { colors } from '../theme/tokens';

const CITY_KEY = 'zoyra.concerts.city';
const CITIES = ['Chennai', 'Mumbai', 'Delhi', 'Bengaluru', 'Hyderabad', 'London', 'New York', 'Los Angeles', 'Toronto', 'Sydney', 'Berlin', 'Paris'];
const FILTERS = ['All', 'This week', 'This month', 'Followed artists'] as const;

type ConcertsLoad = { events: ConcertEvent[] | null; notConfigured: boolean };

export default function Concerts() {
  const lib = useLibrary();
  const [city, setCity] = useState<string | null | undefined>(undefined); // undefined = still reading storage
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState(0);
  const [note, setNote] = useState<string | null>(null);

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

  const chooseCity = (c: string) => {
    const v = c.trim();
    if (!v) return;
    setCity(v);
    setPicking(false);
    setDraft('');
    AsyncStorage.setItem(CITY_KEY, v).catch(() => {});
  };

  const res = useAsync<ConcertsLoad>(async () => {
    if (!city) return { events: null, notConfigured: false };
    try {
      return { events: await fetchConcerts({ city }), notConfigured: false };
    } catch (e) {
      if (e instanceof ServiceNotConfiguredError) return { events: null, notConfigured: true };
      throw e;
    }
  }, [city]);
  const notConfigured = !!res.data?.notConfigured;
  const followed = useMemo(() => new Set(lib.followedArtists.map((a) => a.name.toLowerCase())), [lib.followedArtists]);
  const isFollowed = (e: ConcertEvent) => !!e.artist && followed.has(e.artist.toLowerCase());

  const events = useMemo(() => {
    const all = res.data?.events ?? [];
    const now = Date.now();
    const day = 86_400_000;
    switch (FILTERS[filter]) {
      case 'This week':
        return all.filter((e) => eventDate(e).getTime() - now < 7 * day);
      case 'This month':
        return all.filter((e) => eventDate(e).getTime() - now < 31 * day);
      case 'Followed artists':
        return all.filter(isFollowed);
      default:
        return all;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data, filter, followed]);

  const openTickets = async (e: ConcertEvent) => {
    if (!e.url) return setNote('No ticket link for this event.');
    try {
      await WebBrowser.openBrowserAsync(e.url);
    } catch {
      setNote('Could not open the ticket page.');
    }
  };

  return (
    <Screen onRefresh={res.refresh} top={4} gap={14} backdrop={{ pattern: 'lines', mesh: 'gold' }}>
      <ScreenHeader title="Concerts" />

      {/* Location */}
      <Row gap={10} style={{ height: 48, paddingLeft: 16, paddingRight: 8, borderRadius: 32, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border }}>
        <Icon name="pin" size={20} color={colors.accentLight} />
        <T size={15} weight={500} style={{ flex: 1 }} numberOfLines={1}>
          {city ?? 'Pick a city'}
        </T>
        <LinkText label={picking ? 'Done' : 'Change'} onPress={() => setPicking((p) => !p)} />
      </Row>

      {picking ? (
        <Glass padding={14}>
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {CITIES.map((c) => (
                <Chip key={c} label={c} active={c === city} onPress={() => chooseCity(c)} />
              ))}
            </View>
            <TextField
              label="Other city"
              icon="search"
              value={draft}
              onChangeText={setDraft}
              placeholder="Type a city and press enter"
              returnKeyType="search"
              autoCapitalize="words"
              onSubmitEditing={() => chooseCity(draft)}
            />
          </View>
        </Glass>
      ) : null}

      {notConfigured ? (
        <Toast icon="info" iconColor={colors.accentLight} message={TICKETMASTER_SETUP_MESSAGE} />
      ) : (
        <>
          <ChipRow options={[...FILTERS]} initial={0} onChange={setFilter} />

          {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} /> : null}

          {!city ? (
            <EmptyState icon="search" title="Where are you?" body="Pick your city to see upcoming concerts near you." />
          ) : res.loading ? (
            <Loading label={`Finding concerts in ${city}`} />
          ) : res.error ? (
            <Toast icon="info" iconColor={colors.error} message={res.error} action="Retry" onAction={res.reload} />
          ) : events.length === 0 ? (
            <EmptyState
              icon="search"
              title={res.data?.events?.length ? 'Nothing matches this filter' : 'No upcoming concerts'}
              body={res.data?.events?.length ? 'Try another filter.' : `We couldn't find upcoming shows in ${city}. Try a nearby big city.`}
            />
          ) : (
            events.map((e) => <EventCard key={e.id} e={e} following={isFollowed(e)} onTickets={() => void openTickets(e)} />)
          )}
        </>
      )}
    </Screen>
  );
}
