import { useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Cover, EmptyState, Glass, Gradient, Icon, IconButton, IconTile, ListRow, Loading, Row, Screen, T, Tap, TextField, Toast, useAsync, useDebounced, IconBadge } from '../components';
import { catalog, GENRES, MOOD_MAP } from '../lib/catalog';
import { artistStation, contextFor, genreStation, historySeeds, mixStation, moodStation, radioState, startStation, stopStation, useRadioTopUp, type Station } from '../lib/radio';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { art, colors, withAlpha, type ArtName } from '../theme/tokens';

const FILTERS = ['For you', 'Genres', 'Moods', 'Artists'] as const;
const ARTS: ArtName[] = ['red', 'orange', 'rose', 'amber', 'blue', 'green'];
const artAt = (i: number) => ARTS[i % ARTS.length];

/** Board station row: frosted row, 64px rounded-square art, LIVE pill when on air, accent play circle. */
function LivePill() {
  return (
    <View style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: colors.live, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.white }} />
      <T size={11} weight={800} tracking={0.6} color={colors.white}>
        LIVE
      </T>
    </View>
  );
}

function StationRow({ s, i, busy, on, onPress }: { s: Station; i: number; busy: boolean; on: boolean; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={`${on ? 'Playing' : 'Start'} ${s.title}. ${s.subtitle}`} accessibilityState={{ busy, selected: on }} pressScale={0.98}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderRadius: 26, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        {s.image ? (
          <Cover uri={s.image} id={s.seed} size={64} radius={18} />
        ) : (
          <Gradient colors={art[artAt(i)]} style={{ width: 64, height: 64, borderRadius: 18, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={s.kind === 'mood' ? 'heart' : s.kind === 'mix' ? 'shuffle' : 'cast'} size={28} color={colors.white} strokeWidth={1.4} />
          </Gradient>
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={16} weight={600} numberOfLines={1}>
            {s.title}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {s.subtitle}
          </T>
        </View>
        {on ? <LivePill /> : null}
        <IconBadge icon={busy ? 'clock' : on ? 'speaker' : 'play'} size={44} />
      </View>
    </Tap>
  );
}

function StationList({ stations, busy, onAir, onStart }: { stations: Station[]; busy: string | null; onAir: string | null; onStart: (s: Station) => void }) {
  return (
    <View style={{ gap: 12 }}>
      {stations.map((s, i) => (
        <StationRow key={s.id} s={s} i={i} busy={busy === s.id} on={onAir === s.id} onPress={() => onStart(s)} />
      ))}
    </View>
  );
}

function Shelf({ title, stations, busy, onAir, onStart }: { title: string; stations: Station[]; busy: string | null; onAir: string | null; onStart: (s: Station) => void }) {
  if (!stations.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <T size={19} weight={500} tracking={-0.2} accessibilityRole="header">
        {title}
      </T>
      <StationList stations={stations} busy={busy} onAir={onAir} onStart={onStart} />
    </View>
  );
}

const BARS = [8, 25, 10, 27, 12, 29, 14, 31, 16, 33, 18, 35, 20, 37, 22, 39, 24, 9, 26, 11, 28, 13, 30, 15, 32, 17, 34, 19, 36, 21];

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

  const seeds = useAsync(async () => (user ? historySeeds(user.id) : null), [user?.id], 'app/radio:94');
  const found = useAsync(async () => (q.length >= 2 ? catalog.searchArtists(q, 8) : []), [q], 'app/radio:95');

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
    <Screen onRefresh={() => Promise.all([seeds.refresh(), found.refresh()])} top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="back" label="Back" href="back" bg={withAlpha(colors.white, 0.1)} />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={38} accessibilityRole="header">
          Radio
        </T>
        <T size={14} color={colors.textSecondary}>
          Endless stations from the Audius catalogue
        </T>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {FILTERS.map((label, i) => (
          <Tap key={label} onPress={() => setFilter(i)} accessibilityState={{ selected: filter === i }}>
            <View
              style={[
                { height: 38, paddingHorizontal: 16, borderRadius: 19, justifyContent: 'center' },
                filter === i ? { backgroundColor: colors.text } : { backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) },
              ]}
            >
              <T size={13} weight={600} color={filter === i ? colors.playerBg : colors.text}>
                {label}
              </T>
            </View>
          </Tap>
        ))}
      </ScrollView>

      {/* On air */}
      {onAir ? (
        <Gradient colors={[withAlpha(colors.accent, 0.3), withAlpha(colors.playerBg, 0.55)]} angle={135} style={{ borderRadius: 30, padding: 18, gap: 14, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(colors.white, 0.14) }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={12} weight={700} tracking={0.8} color={colors.accentLight}>
              ON AIR
            </T>
            <LivePill />
          </Row>
          <T size={26} weight={300} tracking={-0.5} lineHeight={30} numberOfLines={2}>
            {onAir.title}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 40 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {BARS.map((h, k) => (
              <View key={k} style={{ flex: 1, height: h, borderRadius: 2, backgroundColor: colors.accent, opacity: playing ? 0.8 : 0.4 }} />
            ))}
          </View>
          {track ? (
            <Row gap={10}>
              <Cover artwork={track.artwork} id={track.id} size={44} radius={14} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={13} color={colors.peach} numberOfLines={1}>
                  Now: {track.title} · {track.artist.name}
                </T>
              </View>
            </Row>
          ) : null}
          <Row gap={10}>
            <Button label={playing ? 'Pause' : 'Play'} icon={playing ? 'pause' : 'play'} height={44} onPress={toggle} style={{ flex: 1 }} />
            <Button label="Open player" variant="glass" height={44} href="/player" style={{ flex: 1 }} />
          </Row>
          <Tap onPress={stopStation} accessibilityLabel="Stop adding songs to this station">
            <T size={13} color={colors.peach} style={{ opacity: 0.8, textDecorationLine: 'underline' }}>
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
          <Shelf title="Moods" stations={moodStations.slice(0, 6)} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} />
          <Shelf title="Genres" stations={genreStations.slice(0, 6)} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} />
        </>
      ) : null}

      {cat === 'Genres' ? <StationList stations={genreStations} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} /> : null}

      {cat === 'Moods' ? <StationList stations={moodStations} busy={busy} onAir={onAir?.id ?? null} onStart={(s) => void start(s)} /> : null}

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
