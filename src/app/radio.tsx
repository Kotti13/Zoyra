import { useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, ChipRow, Cover, EmptyState, Glass, Gradient, Icon, IconTile, ListRow, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Tap, TextField, Toast, useAsync, useDebounced } from '../components';
import { catalog, GENRES, MOOD_MAP } from '../lib/catalog';
import { artistStation, contextFor, genreStation, historySeeds, mixStation, moodStation, radioState, startStation, stopStation, useRadioTopUp, type Station } from '../lib/radio';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { art, colors, type ArtName } from '../theme/tokens';

const FILTERS = ['For you', 'Genres', 'Moods', 'Artists'] as const;
const ARTS: ArtName[] = ['red', 'orange', 'rose', 'amber', 'blue', 'green'];
const artAt = (i: number) => ARTS[i % ARTS.length];

function StationCard({ s, i, busy, on, onPress }: { s: Station; i: number; busy: boolean; on: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={`${on ? 'Playing' : 'Start'} ${s.title}. ${s.subtitle}`} accessibilityState={{ busy, selected: on }} style={{ width: 150 }}>
      <View style={{ gap: 8 }}>
        <Gradient colors={art[artAt(i)]} style={{ width: 150, height: 150, borderRadius: 26, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
          {s.image ? <Cover uri={s.image} id={s.seed} size={84} radius={42} /> : <Icon name={s.kind === 'mood' ? 'heart' : s.kind === 'mix' ? 'shuffle' : 'cast'} size={44} color={colors.white} strokeWidth={1.2} />}
          <View style={{ position: 'absolute', bottom: 10, right: 10, width: 36, height: 36, borderRadius: 18, backgroundColor: on ? colors.accent : colors.shade, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={busy ? 'clock' : on ? 'speaker' : 'play'} size={16} color={colors.white} />
          </View>
        </Gradient>
        <View style={{ gap: 2 }}>
          <T size={14} weight={600} numberOfLines={1}>
            {s.title}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {s.subtitle}
          </T>
        </View>
      </View>
    </Tap>
  );
}

function Shelf({ title, stations, busy, onAir, onStart }: { title: string; stations: Station[]; busy: string | null; onAir: string | null; onStart: (s: Station) => void }) {
  if (!stations.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <SectionHeader title={title} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
        {stations.map((s, i) => (
          <StationCard key={s.id} s={s} i={i} busy={busy === s.id} on={onAir === s.id} onPress={() => onStart(s)} />
        ))}
      </ScrollView>
    </View>
  );
}

export default function Radio() {
  // Keeps the station endless while this screen is open; the root layout can mount it app-wide.
  useRadioTopUp();
  const { user } = useAuth();
  const lib = useLibrary();
  const { playTracks, track, playing, toggle, context } = usePlayerPick('track', 'playing', 'context');
  const station = useSyncExternalStore(radioState.subscribe, radioState.current, radioState.current);
  const onAir = station && context === contextFor(station) ? station : null;
  const [filter, setFilter] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 350);

  const seeds = useAsync(async () => (user ? historySeeds(user.id) : null), [user?.id]);
  const found = useAsync(async () => (q.length >= 2 ? catalog.searchArtists(q, 8) : []), [q]);

  const start = async (s: Station) => {
    if (busy) return;
    setBusy(s.id);
    setNote(null);
    try {
      const r = await startStation(s, playTracks);
      setNote(r);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not start the station.' });
    } finally {
      setBusy(null);
    }
  };

  const fromHistory = (seeds.data?.artists ?? []).slice(0, 8).map(artistStation);
  const followed = lib.followedArtists.slice(0, 10).map((a) => artistStation({ id: a.id, name: a.name, image: a.image.small }));
  const artistStations = [...followed, ...fromHistory.filter((s) => !followed.some((f) => f.id === s.id))];
  const historyGenres = (seeds.data?.genres ?? []).slice(0, 6).map(genreStation);
  const genreStations = GENRES.map(genreStation);
  const moodStations = Object.keys(MOOD_MAP).map(moodStation);
  const cat = FILTERS[filter];

  return (
    <Screen onRefresh={() => Promise.all([seeds.refresh(), found.refresh()])} top={4} gap={20} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Radio
        </T>
        <T size={15} color={colors.textSecondary}>
          Endless stations from the Audius catalogue
        </T>
      </View>

      <ChipRow options={[...FILTERS]} initial={0} onChange={setFilter} />

      {/* On air */}
      {onAir ? (
        <Gradient colors={art.red} style={{ borderRadius: 32, padding: 20, gap: 10, overflow: 'hidden' }}>
          <Row>
            <View style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.shade, justifyContent: 'center' }}>
              <T variant="overline" color={colors.white}>
                ON AIR
              </T>
            </View>
          </Row>
          <T size={30} weight={300} tracking={-1} color={colors.white} numberOfLines={2}>
            {onAir.title}
          </T>
          {track ? (
            <Row gap={10}>
              <Cover artwork={track.artwork} id={track.id} size={44} radius={12} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={14} weight={600} color={colors.white} numberOfLines={1}>
                  {track.title}
                </T>
                <T size={13} color={colors.white} style={{ opacity: 0.8 }} numberOfLines={1}>
                  {track.artist.name}
                </T>
              </View>
            </Row>
          ) : null}
          <Row gap={10}>
            <Button label={playing ? 'Pause' : 'Play'} icon={playing ? 'pause' : 'play'} variant="light" height={44} onPress={toggle} style={{ flex: 1 }} />
            <Button label="Open player" variant="glass" height={44} href="/player" style={{ flex: 1 }} />
          </Row>
          <Tap onPress={stopStation} accessibilityLabel="Stop adding songs to this station">
            <T size={13} color={colors.white} style={{ opacity: 0.8, textDecorationLine: 'underline' }}>
              Stop the station after the queued songs
            </T>
          </Tap>
        </Gradient>
      ) : null}

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.accentLight} message={note.text} /> : null}

      {cat === 'For you' ? (
        <>
          {user ? (
            <Glass padding={4}>
              <ListRow
                icon="shuffle"
                title="Your Mix Radio"
                subtitle={seeds.loading ? 'Reading your listening…' : seeds.data?.artists.length ? `From ${seeds.data.artists.slice(0, 3).map((a) => a.name).join(', ')} and more` : 'Play a few songs so it can learn your taste'}
                onPress={() => void start(mixStation(user.id))}
                right={<Icon name={busy === `mix:${user.id}` ? 'clock' : 'play'} size={20} color={colors.accentLight} />}
              />
            </Glass>
          ) : null}
          {seeds.loading ? <Loading label="Finding stations for you" /> : null}
          <Shelf title="From your listening" stations={[...artistStations.slice(0, 6), ...historyGenres]} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} />
          <Shelf title="Moods" stations={moodStations} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} />
          <Shelf title="Genres" stations={genreStations.slice(0, 8)} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} />
        </>
      ) : null}

      {cat === 'Genres' ? (
        <Glass padding={4}>
          {genreStations.map((s, i) => (
            <ListRow key={s.id} divider={i > 0} icon="cast" title={s.title} subtitle={s.subtitle} onPress={() => void start(s)} right={<Icon name={busy === s.id ? 'clock' : onAir?.id === s.id ? 'speaker' : 'play'} size={20} color={colors.accentLight} />} />
          ))}
        </Glass>
      ) : null}

      {cat === 'Moods' ? (
        <Glass padding={4}>
          {moodStations.map((s, i) => (
            <ListRow key={s.id} divider={i > 0} icon="heart" title={s.title} subtitle={s.subtitle} onPress={() => void start(s)} right={<Icon name={busy === s.id ? 'clock' : onAir?.id === s.id ? 'speaker' : 'play'} size={20} color={colors.accentLight} />} />
          ))}
        </Glass>
      ) : null}

      {cat === 'Artists' ? (
        <>
          <TextField label="Start an artist station" icon="search" value={query} onChangeText={setQuery} placeholder="Search artists" returnKeyType="search" autoCapitalize="none" />
          {q.length >= 2 ? (
            found.loading ? (
              <Loading label="Searching artists" />
            ) : found.error ? (
              <Toast icon="info" iconColor={colors.error} message={found.error} action="Retry" onAction={found.reload} />
            ) : !found.data?.length ? (
              <EmptyState icon="search" title="No artists found" body="Try another name." />
            ) : (
              <Glass padding={4}>
                {found.data.map((a, i) => {
                  const s = artistStation({ id: a.id, name: a.name, image: a.image.small });
                  return <ListRow key={a.id} divider={i > 0} leading={<Cover uri={a.image.small ?? null} id={a.id} size={40} radius={20} />} title={a.name} subtitle="Artist and similar artists" onPress={() => void start(s)} right={<Icon name={busy === s.id ? 'clock' : 'play'} size={20} color={colors.accentLight} />} />;
                })}
              </Glass>
            )
          ) : artistStations.length ? (
            <Glass padding={4}>
              {artistStations.map((s, i) => (
                <ListRow key={s.id} divider={i > 0} leading={s.image ? <Cover uri={s.image} id={s.seed} size={40} radius={20} /> : <IconTile icon="user" size={40} />} title={s.title} subtitle={s.subtitle} onPress={() => void start(s)} right={<Icon name={busy === s.id ? 'clock' : onAir?.id === s.id ? 'speaker' : 'play'} size={20} color={colors.accentLight} />} />
              ))}
            </Glass>
          ) : (
            <EmptyState icon="users" title="No artist stations yet" body="Follow artists or search above to start a station." />
          )}
        </>
      ) : null}

      <T size={12} color={colors.textSecondary} align="center">
        Stations are endless mixes of Audius tracks, not live broadcasts.
      </T>
    </Screen>
  );
}
