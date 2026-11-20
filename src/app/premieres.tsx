import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, IconButton, Loading, Screen, ScreenHeader, T, Tap, Toast, useAsync } from '../components';
import { catalog, formatCount, type CatalogTrack, type Collection } from '../lib/catalog';
import { Poster } from '../lib/poster';
import { formatReleaseDate, isRecent, loadPremieres } from '../lib/premieres';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const BLUE = '#2D7FF9';

const filters = ['All', 'Albums', 'Singles'] as const;

const openAlbum = (c: Collection) => router.push({ pathname: '/album', params: { id: c.id } });
const openTrack = (t: CatalogTrack) => router.push({ pathname: '/track-detail', params: { id: t.id } });

function ReleaseRow({ title, meta, date, artwork, id, onOpen, onPlay, busy }: { title: string; meta: string; date?: string; artwork: CatalogTrack['artwork']; id: string; onOpen: () => void; onPlay: () => void; busy?: boolean }) {
  return (
    <Glass radius={36} padding={12}>
      <Tap onPress={onOpen} accessibilityLabel={`${title}, ${meta}${date ? `, released ${date}` : ''}`} pressScale={0.98} style={{ flexDirection: 'row', gap: 14 }}>
        <Cover artwork={artwork} id={id} size={96} width={96} height={120} radius={22} />
        <View style={{ flex: 1, minWidth: 0, justifyContent: 'space-between', gap: 8 }}>
          <View style={{ gap: 4 }}>
            <T size={17} weight={600} numberOfLines={2}>
              {title}
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={2}>
              {meta}
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {date ? (
              <View style={{ height: 28, paddingHorizontal: 12, borderRadius: 22, backgroundColor: BLUE, justifyContent: 'center' }}>
                <T size={12} weight={700} color={colors.white}>
                  {date}
                </T>
              </View>
            ) : (
              <View />
            )}
            <IconButton icon={busy ? 'clock' : 'play'} label={`Play ${title}`} size={44} bg={colors.accent} color={colors.onAccent} onPress={onPlay} />
          </View>
        </View>
      </Tap>
    </Glass>
  );
}

export default function Premieres() {
  const { playTracks } = usePlayerPick();
  const [filter, setFilter] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const data = useAsync(() => loadPremieres(30), [], 'app/premieres:56');

  const playAlbum = async (c: Collection) => {
    if (busy) return;
    setBusy(c.id);
    setNote(null);
    try {
      const tracks = await catalog.collectionTracks(c.id);
      if (!tracks.length) return setNote(`${c.title} has no playable tracks right now.`);
      const res = playTracks(tracks, 0, c.title);
      if (!res.played) setNote(res.reason ?? 'Could not play this release.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not load this release');
    } finally {
      setBusy(null);
    }
  };

  const hero = data.data?.albums[0];
  const albums = data.data?.albums.slice(1) ?? [];
  const tracks = data.data?.tracks ?? [];
  const showAlbums = filter !== 2;
  const showSingles = filter !== 1;

  return (
    <Screen onRefresh={data.refresh} top={4} gap={18} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <ScreenHeader title="" right={<IconButton icon="bell" label="Release alerts" bg={withAlpha(colors.white, 0.1)} href="/notif-settings" />} />
      <T size={40} weight={300} tracking={-1.2} lineHeight={42} accessibilityRole="header">
        Major{' '}
        <T size={40} weight={800} tracking={-1.2} lineHeight={42} color={colors.rose}>
          premieres
        </T>
      </T>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {filters.map((label, i) => (
          <Tap key={label} onPress={() => setFilter(i)} accessibilityState={{ selected: filter === i }}>
            <View
              style={[
                { height: 40, paddingHorizontal: 18, borderRadius: 28, justifyContent: 'center' },
                filter === i ? { backgroundColor: colors.text } : { borderWidth: 1, borderColor: colors.chipOutline, backgroundColor: withAlpha(colors.white, 0.03) },
              ]}
            >
              <T size={14} weight={500} color={filter === i ? colors.onLight : colors.text}>
                {label}
              </T>
            </View>
          </Tap>
        ))}
      </ScrollView>

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      {data.loading && !data.data ? (
        <Loading height={360} label="Loading premieres" />
      ) : data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !hero && !tracks.length ? (
        <EmptyState title="No premieres right now" body="Check back soon for new releases." />
      ) : (
        <>
          {hero && showAlbums ? (
            <Tap onPress={() => openAlbum(hero)} accessibilityLabel={`${hero.title} by ${hero.artist.name}. Open album`}>
              <Poster artwork={hero.artwork} id={hero.id} height={250} radius={32}>
                <View style={{ flex: 1, justifyContent: 'space-between', padding: 2 }}>
                  <View style={{ alignSelf: 'flex-start', height: 28, paddingHorizontal: 12, borderRadius: 22, backgroundColor: BLUE, justifyContent: 'center' }}>
                    <T size={12} weight={700} color={colors.white}>
                      {isRecent(hero.releaseDate, 7) ? 'New this week' : 'Trending album'}
                    </T>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <T size={26} weight={800} tracking={-0.5} lineHeight={28} numberOfLines={2}>
                        {hero.title.toUpperCase()}
                      </T>
                      <T size={13} numberOfLines={1}>
                        {hero.artist.name} · Album{hero.trackCount ? ` · ${hero.trackCount} tracks` : ''}
                        {formatReleaseDate(hero.releaseDate) ? ` · ${formatReleaseDate(hero.releaseDate)}` : ''}
                      </T>
                    </View>
                    <IconButton icon={busy === hero.id ? 'clock' : 'play'} label={`Play ${hero.title}`} size={48} bg={colors.accent} color={colors.onAccent} onPress={() => void playAlbum(hero)} />
                  </View>
                </View>
              </Poster>
            </Tap>
          ) : null}

          {showAlbums && albums.length ? (
            <View style={{ gap: 12 }}>
              <T variant="section" accessibilityRole="header">
                New albums
              </T>
              {albums.slice(0, 8).map((c) => (
                <ReleaseRow
                  key={c.id}
                  id={c.id}
                  title={c.title}
                  meta={`${c.artist.name} · ${c.trackCount ? `${c.trackCount} tracks` : 'Album'}${c.plays ? ` · ${formatCount(c.plays)} plays` : ''}`}
                  date={formatReleaseDate(c.releaseDate)}
                  artwork={c.artwork}
                  busy={busy === c.id}
                  onOpen={() => openAlbum(c)}
                  onPlay={() => void playAlbum(c)}
                />
              ))}
            </View>
          ) : null}

          {showSingles && tracks.length ? (
            <View style={{ gap: 12 }}>
              <T variant="section" accessibilityRole="header">
                Fresh singles
              </T>
              {tracks.slice(0, 12).map((t, i) => (
                <ReleaseRow
                  key={t.id}
                  id={t.id}
                  title={t.title}
                  meta={`${t.artist.name}${t.genre ? ` · ${t.genre}` : ''} · ${formatCount(t.plays)} plays`}
                  date={formatReleaseDate(t.releaseDate)}
                  artwork={t.artwork}
                  onOpen={() => openTrack(t)}
                  onPlay={() => {
                    const res = playTracks(tracks, i, 'Premieres');
                    if (!res.played) setNote(res.reason ?? 'Could not play this song.');
                  }}
                />
              ))}
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}
