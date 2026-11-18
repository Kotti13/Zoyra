import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, ChipRow, Cover, EmptyState, ErrorState, Glass, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, Toast, useAsync } from '../components';
import { catalog, formatCount, type CatalogTrack, type Collection } from '../lib/catalog';
import { Poster, PosterBadge } from '../lib/poster';
import { formatReleaseDate, isRecent, loadPremieres } from '../lib/premieres';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const filters = ['All', 'Albums', 'Singles'] as const;

const openAlbum = (c: Collection) => router.push({ pathname: '/album', params: { id: c.id } });
const openTrack = (t: CatalogTrack) => router.push({ pathname: '/track-detail', params: { id: t.id } });

function ReleaseRow({ title, meta, date, artwork, id, onOpen, onPlay, busy }: { title: string; meta: string; date?: string; artwork: CatalogTrack['artwork']; id: string; onOpen: () => void; onPlay: () => void; busy?: boolean }) {
  return (
    <Tap onPress={onOpen} accessibilityLabel={`${title}, ${meta}${date ? `, released ${date}` : ''}`}>
      <Glass radius={30} padding={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Cover artwork={artwork} id={id} size={72} radius={24} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <T size={16} weight={700} numberOfLines={1}>
            {title}
          </T>
          <T size={13} color={colors.textSecondary} numberOfLines={1}>
            {meta}
          </T>
          {date ? (
            <T mono size={12} color={colors.accentLight}>
              {date}
            </T>
          ) : null}
        </View>
        <IconButton icon={busy ? 'clock' : 'play'} label={`Play ${title}`} size={44} bg={colors.accent} color={colors.onAccent} onPress={onPlay} />
      </Glass>
    </Tap>
  );
}

export default function Premieres() {
  const { playTracks } = usePlayerPick();
  const [filter, setFilter] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const data = useAsync(() => loadPremieres(30), []);

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
    <Screen onRefresh={data.refresh} top={4} gap={20} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Major premieres
        </T>
        <T size={14} color={colors.textSecondary}>
          The biggest new releases trending on Audius this week.
        </T>
      </View>

      <ChipRow options={[...filters]} onChange={setFilter} />

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
              <Poster artwork={hero.artwork} id={hero.id} height={380} radius={34}>
                <View style={{ flex: 1, justifyContent: 'space-between', padding: 6 }}>
                  <PosterBadge label={isRecent(hero.releaseDate, 7) ? 'NEW THIS WEEK' : 'TRENDING ALBUM'} />
                  <View style={{ gap: 6 }}>
                    <T variant="displayLight" size={40} lineHeight={42} numberOfLines={2}>
                      {hero.title}
                    </T>
                    <T size={14} color={colors.peach}>
                      {hero.artist.name} · Album{hero.trackCount ? ` · ${hero.trackCount} tracks` : ''}
                      {formatReleaseDate(hero.releaseDate) ? ` · ${formatReleaseDate(hero.releaseDate)}` : ''}
                    </T>
                    <Row gap={10} style={{ marginTop: 6 }}>
                      <Button label={busy === hero.id ? 'Loading…' : 'Play'} icon="play" height={44} onPress={() => void playAlbum(hero)} />
                      <Button label="Live hub" variant="glass" icon="cast" height={44} href="/live-hub" />
                    </Row>
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
