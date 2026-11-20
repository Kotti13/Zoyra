import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Art, Cover, EmptyState, ErrorState, Icon, IconButton, Loading, MiniPlayer, Screen, SectionHeader, T, Tap, TrackItem, artFor, useAsync } from '../components';
import { catalog, formatCount, type CatalogTrack, type Collection } from '../lib/catalog';
import { useContentFilter } from '../lib/content-filter';
import { colors, layout, withAlpha } from '../theme/tokens';

const tabs = ['Popular', 'New', 'Playlists', 'Artists'] as const;
type Tab = (typeof tabs)[number];

const time = (t: CatalogTrack) => (t.releaseDate ? Date.parse(t.releaseDate) || 0 : 0);

export default function Genre() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ name?: string }>();
  const name = (typeof params.name === 'string' && params.name) || 'Electronic';
  const [tab, setTab] = useState<Tab>('Popular');
  const top = 4;
  const tileSize = (width - layout.gutter * 2 - 12) / 2;

  const tracks = useAsync(() => catalog.trending({ genre: name, limit: 30 }), [name], 'app/genre:25');
  const collections = useAsync(() => catalog.searchCollections(name, 12), [name], 'app/genre:26');

  const { filter: hideFilter } = useContentFilter();
  const visible = useMemo(() => hideFilter(tracks.data ?? []), [tracks.data, hideFilter]);
  const list = useMemo(() => (tab === 'New' ? [...visible].sort((a, b) => time(b) - time(a)) : visible), [visible, tab]);

  const artists = useMemo(() => {
    const seen = new Map<string, { id: string; name: string; image?: string; plays: number }>();
    for (const t of visible) {
      const a = seen.get(t.artist.id);
      if (a) a.plays += t.plays;
      else seen.set(t.artist.id, { id: t.artist.id, name: t.artist.name, image: t.artist.image, plays: t.plays });
    }
    return [...seen.values()];
  }, [visible]);

  const openCollection = (c: Collection) =>
    c.isAlbum ? router.push({ pathname: '/album', params: { id: c.id } }) : router.push({ pathname: '/playlist', params: { catalog: c.id } });

  const showPlaylists = tab === 'Popular' || tab === 'Playlists';
  const showTracks = tab === 'Popular' || tab === 'New';
  const shownCollections = (collections.data ?? []).slice(0, tab === 'Playlists' ? 12 : 4);
  const heroArt = tracks.data?.[0]?.artwork;

  return (
    <Screen onRefresh={() => Promise.all([tracks.refresh(), collections.refresh()])} backdrop={{ pattern: 'grid', mesh: 'amber' }} top={top} gap={20} bottom={16} footer={<MiniPlayer />}>
      {/* Hero */}
      <View style={{ marginTop: -(insets.top + top), marginHorizontal: -16 }}>
        <Art art={artFor(name)} width={width} height={200} radius={0} style={{ justifyContent: 'flex-end', padding: 16, overflow: 'hidden' }}>
          {heroArt ? (
            <Cover artwork={heroArt} id={name} width={width} height={200} radius={0} style={{ position: 'absolute', left: 0, top: 0, opacity: 0.35 }} />
          ) : null}
          <T size={40} weight={300} tracking={-1} lineHeight={46} accessibilityRole="header" numberOfLines={1}>
            {name}
          </T>
        </Art>
        <View style={{ position: 'absolute', left: 8, top: insets.top + top }}>
          <IconButton icon="back" label="Back" href="back" bg={colors.scrim} color={colors.white} />
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {tabs.map((t) => {
          const on = t === tab;
          return (
            <Tap key={t} onPress={() => setTab(t)} accessibilityState={{ selected: on }} style={{ height: 44, justifyContent: 'center' }}>
              <View
                style={[
                  { height: 32, paddingHorizontal: 16, borderRadius: 28, justifyContent: 'center' },
                  on ? { backgroundColor: colors.accent } : { backgroundColor: withAlpha(colors.white, 0.08), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) },
                ]}
              >
                <T size={14} weight={500} color={on ? colors.onAccent : colors.text}>
                  {t}
                </T>
              </View>
            </Tap>
          );
        })}
      </ScrollView>

      {showPlaylists ? (
        <>
          <SectionHeader title="Popular playlists" />
          {collections.loading && !collections.data ? (
            <Loading />
          ) : collections.error ? (
            <ErrorState message={collections.error} onRetry={collections.reload} />
          ) : !shownCollections.length ? (
            <EmptyState title={`No ${name} playlists yet`} />
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
              {shownCollections.map((p) => (
                <Tap key={p.id} accessibilityLabel={p.title} onPress={() => openCollection(p)} style={{ width: tileSize, gap: 8 }}>
                  <Cover artwork={p.artwork} id={p.id} size={tileSize} radius={26} />
                  <T size={14} weight={600} numberOfLines={1}>
                    {p.title}
                  </T>
                </Tap>
              ))}
            </View>
          )}
        </>
      ) : null}

      {showTracks ? (
        <>
          <SectionHeader title={tab === 'New' ? 'Newest tracks' : 'Top tracks'} />
          <View style={{ marginTop: -8 }}>
            {tracks.loading && !tracks.data ? (
              <Loading />
            ) : tracks.error ? (
              <ErrorState message={tracks.error} onRetry={tracks.reload} />
            ) : !list.length ? (
              <EmptyState title={`No ${name} tracks right now`} />
            ) : (
              list.slice(0, tab === 'New' ? 30 : 10).map((t, i) => <TrackItem key={t.id} track={t} list={list} index={i} showIndex context={name} />)
            )}
          </View>
        </>
      ) : null}

      {tab === 'Artists' ? (
        <>
          <SectionHeader title={`${name} artists`} />
          <View style={{ marginTop: -8 }}>
            {tracks.loading && !tracks.data ? (
              <Loading />
            ) : tracks.error ? (
              <ErrorState message={tracks.error} onRetry={tracks.reload} />
            ) : !artists.length ? (
              <EmptyState icon="users" title="No artists found" />
            ) : (
              artists.map((a) => (
                <Tap
                  key={a.id}
                  accessibilityLabel={`Artist ${a.name}`}
                  onPress={() => router.push({ pathname: '/artist', params: { id: a.id } })}
                  style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                >
                  <Cover uri={a.image} id={a.id} size={48} radius={24} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T variant="bodyStrong" numberOfLines={1}>
                      {a.name}
                    </T>
                    <T variant="small" color={colors.textSecondary}>
                      {formatCount(a.plays)} plays on trending tracks
                    </T>
                  </View>
                  <Icon name="chevronRight" size={20} color={colors.textSecondary} />
                </Tap>
              ))
            )}
          </View>
        </>
      ) : null}
    </Screen>
  );
}
