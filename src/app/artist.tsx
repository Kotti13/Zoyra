import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, MiniPlayer, Overline, Row, Screen, SectionHeader, T, Tap, useAsync, ToggleBurst } from '../components';
import { AppleTrackRow } from '../components/apple-parts';
import { EventCard } from '../components/EventCard';
import { catalog, formatCount, type CatalogTrack } from '../lib/catalog';
import { artistShareUrl, shareContent } from '../lib/share-links';
import { useContentFilter } from '../lib/content-filter';
import { ServiceNotConfiguredError, TICKETMASTER_SETUP_MESSAGE, fetchConcerts } from '../lib/concerts';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { art, colors, withAlpha } from '../theme/tokens';

const styles = StyleSheet.create({
  pill: { flex: 1, height: 48, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});

const shuffle = (a: CatalogTrack[]) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

export default function Artist() {
  const insets = useSafeAreaInsets();
  const { id: rawId } = useLocalSearchParams<{ id?: string }>();
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const lib = useLibrary();
  const player = usePlayerPick('track', 'playing', 'context');
  const top = 4;

  const artist = useAsync(async () => (id ? catalog.artist(id) : null), [id], 'app/artist:36');
  const popular = useAsync(async () => (id ? catalog.artistTracks(id, 20, 'plays') : []), [id], 'app/artist:37');
  const albums = useAsync(async () => (id ? catalog.artistCollections(id, 20) : []), [id], 'app/artist:38');
  const related = useAsync(async () => (id ? catalog.relatedArtists(id, 10).catch(() => []) : []), [id], 'app/artist:39');

  const content = useContentFilter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [hiding, setHiding] = useState(false);
  const [hideNote, setHideNote] = useState<{ text: string; error?: boolean } | null>(null);

  const a = artist.data;
  const allTracks = popular.data ?? [];
  const tracks = content.filter(allTracks);
  const artistHidden = !!a && content.hiddenArtists.has(a.id);

  const toggleHideArtist = async () => {
    if (!a || hiding) return;
    setHiding(true);
    setHideNote(null);
    try {
      if (artistHidden) {
        await content.unhide('artist', a.id);
        setHideNote({ text: `${a.name} is visible again.` });
      } else {
        await content.hideArtist({ id: a.id, name: a.name, image: a.image.medium ?? a.image.small ?? null });
        setHideNote({ text: `${a.name} is hidden from lists, search, radio and autoplay.` });
      }
      setMenuOpen(false);
    } catch (e) {
      setHideNote({ text: e instanceof Error ? e.message : 'Could not update hidden artists', error: true });
    } finally {
      setHiding(false);
    }
  };
  const following = !!a && lib.isFollowingArtist(a.id);
  const ctx = `artist:${id}`;
  const radioCtx = `artist-radio:${id}`;
  const playingHere = player.context === ctx && player.playing;
  const radioOn = player.context === radioCtx;
  // Original hero: the banner (cover) fills it, else the artist's picture. Last resort: the cover of their top song,
  // so the hero is never empty when an artist has neither.
  const heroImg = a?.cover ?? a?.image.large ?? a?.image.medium ?? tracks[0]?.artwork.large ?? tracks[0]?.artwork.medium;

  const onPlay = () => {
    if (player.context === ctx && player.track) return player.toggle();
    if (tracks.length) player.playTracks(tracks, 0, ctx);
  };

  return (
    <Screen onRefresh={() => Promise.all([artist.refresh(), popular.refresh(), albums.refresh(), related.refresh()])} backdrop={{ pattern: 'dots', mesh: 'coral' }} top={top} gap={20} bottom={16} footer={<MiniPlayer />}>
      {/* Hero */}
      <View style={{ marginTop: -(insets.top + top), marginHorizontal: -16, height: 340 + insets.top }}>
        <LinearGradient colors={[art.coral[0], art.coral[1]]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        {heroImg ? <Image source={{ uri: heroImg }} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} cachePolicy="memory-disk" accessibilityIgnoresInvertColors /> : null}
        <LinearGradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0), colors.bg]} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16, gap: 6 }}>
          {a?.verified ? <Overline color={colors.peach}>VERIFIED ARTIST</Overline> : null}
          <T size={44} weight={800} tracking={-1} lineHeight={50} accessibilityRole="header" numberOfLines={2}>
            {a?.name ?? (artist.loading ? ' ' : 'Artist')}
          </T>
          {a ? (
            <T mono size={13}>
              {formatCount(a.followers)} followers{a.location ? ` · ${a.location}` : ''}
            </T>
          ) : null}
        </View>
        <View style={{ position: 'absolute', left: 8, top: insets.top + top }}>
          <IconButton icon="back" label="Back" href="back" bg={colors.scrim} color={colors.white} />
        </View>
        {a ? (
          <View style={{ position: 'absolute', right: 8, top: insets.top + top, alignItems: 'flex-end', gap: 6 }}>
            <IconButton icon="more" label="Artist options" bg={colors.scrim} color={colors.white} onPress={() => setMenuOpen((o) => !o)} />
            {menuOpen ? (
              <Glass padding={4} strong style={{ minWidth: 200 }}>
                <Tap
                  accessibilityLabel={artistHidden ? `Unhide ${a.name}` : `Hide ${a.name}`}
                  onPress={() => void toggleHideArtist()}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 12 }}
                >
                  {hiding ? <ActivityIndicator size="small" color={colors.accentLight} /> : <Icon name={artistHidden ? 'eye' : 'close'} size={20} color={colors.accentLight} />}
                  <T size={15} weight={500}>
                    {artistHidden ? 'Unhide artist' : 'Hide artist'}
                  </T>
                </Tap>
                <Tap
                  accessibilityLabel={`Share ${a.name}`}
                  onPress={() => {
                    setMenuOpen(false);
                    shareContent({ url: artistShareUrl(a.id), title: a.name, message: `${a.name} on Zoyra` }).catch(() => setHideNote({ text: 'Could not open the share sheet.', error: true }));
                  }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 12 }}
                >
                  <Icon name="share" size={20} color={colors.accentLight} />
                  <T size={15} weight={500}>
                    Share artist
                  </T>
                </Tap>
                <Tap
                  accessibilityLabel={`Support ${a.name}`}
                  href={{ pathname: '/merch', params: { artistId: a.id } }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 12 }}
                >
                  <Icon name="heart" size={20} color={colors.accentLight} />
                  <T size={15} weight={500}>
                    Support the artist
                  </T>
                </Tap>
                <Tap
                  accessibilityLabel={`${a.name} fan club`}
                  href={{ pathname: '/community', params: { artist: a.id, name: a.name } }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 12 }}
                >
                  <Icon name="users" size={20} color={colors.accentLight} />
                  <T size={15} weight={500}>
                    Fan club
                  </T>
                </Tap>
              </Glass>
            ) : null}
          </View>
        ) : null}
      </View>
      {hideNote ? (
        <T size={13} color={hideNote.error ? colors.error : colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {hideNote.text}
        </T>
      ) : null}

      {!id ? (
        <EmptyState icon="users" title="Artist not found" body="Open an artist from search or a song." action="Search" href="/search" />
      ) : artist.loading && !a ? (
        <Loading label="Loading artist" />
      ) : artist.error ? (
        <ErrorState message={artist.error} onRetry={artist.reload} />
      ) : a ? (
        <>
          {/* Actions */}
          <Row gap={12}>
            <Tap onPress={onPlay} accessibilityLabel={playingHere ? 'Pause' : 'Play'} style={[styles.pill, { backgroundColor: colors.accent }]}>
              <Icon name={playingHere ? 'pause' : 'play'} size={18} color={colors.onAccent} filled />
              <T size={16} weight={700} color={colors.onAccent}>
                {playingHere ? 'Pause' : 'Play'}
              </T>
            </Tap>
            <Tap
              onPress={() => void lib.toggleFollowArtist(a)}
              accessibilityState={{ selected: following }}
              style={[styles.pill, following ? { backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder } : { borderWidth: 1, borderColor: colors.accentLight }]}
            >
              <ToggleBurst active={following} size={48}>
                <T size={16} weight={700} color={following ? colors.text : colors.accentLight}>
                  {following ? 'Following' : 'Follow'}
                </T>
              </ToggleBurst>
            </Tap>
            <IconButton icon="bolt" label="Artist radio" color={radioOn ? colors.amber : colors.text} onPress={() => tracks.length && player.playTracks(shuffle(tracks), 0, radioCtx)} />
          </Row>

          {a.bio ? (
            <T size={14} color={colors.textSecondary} lineHeight={20} numberOfLines={4}>
              {a.bio}
            </T>
          ) : null}

          {/* Popular */}
          <SectionHeader title="Top songs" action={tracks.length > 5 ? (showAll ? 'Show less' : 'Show more') : undefined} onAction={() => setShowAll((v) => !v)} />
          <View style={{ marginTop: -8 }}>
            {popular.loading && !popular.data ? (
              <Loading />
            ) : popular.error ? (
              <ErrorState message={popular.error} onRetry={popular.reload} />
            ) : artistHidden ? (
              <View style={{ gap: 12 }}>
                <EmptyState icon="music" title="You hid this artist" body="Their songs stay out of your lists, search, radio and autoplay." />
                <Button label={hiding ? 'Unhiding…' : 'Unhide artist'} variant="glass" onPress={() => void toggleHideArtist()} />
              </View>
            ) : tracks.length === 0 ? (
              <EmptyState
                title={allTracks.length ? 'Songs filtered' : 'No songs yet'}
                body={allTracks.length ? 'Your hidden songs and kid-safe filter cover every popular song here.' : 'This artist has no streamable songs right now.'}
              />
            ) : (
              (showAll ? tracks.slice(0, 20) : tracks.slice(0, 5)).map((t, i, arr) => (
                <AppleTrackRow key={t.id} track={t} list={tracks} index={i} context={ctx} withArt subtitle={`${formatCount(t.plays)} plays`} last={i === arr.length - 1} />
              ))
            )}
          </View>

          {/* Discography */}
          {albums.data && albums.data.length > 0 ? (
            <>
              <SectionHeader title="Albums" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -16, marginTop: -8 }} contentContainerStyle={{ gap: 12, paddingRight: 16 }}>
                {albums.data.map((d) => (
                  <Tap key={d.id} href={{ pathname: '/album', params: { id: d.id } }} style={{ width: 144, gap: 6 }}>
                    <Cover artwork={d.artwork} id={d.id} size={144} radius={10} />
                    <T size={13} weight={600} numberOfLines={1}>
                      {d.title}
                    </T>
                    <T size={12} color={colors.textSecondary}>
                      {d.releaseDate ? new Date(d.releaseDate).getFullYear() : `${d.trackCount} songs`}
                    </T>
                  </Tap>
                ))}
              </ScrollView>
            </>
          ) : null}

          {/* Related */}
          {related.data && related.data.length > 0 ? (
            <>
              <SectionHeader title="Similar artists" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -16, marginTop: -8 }} contentContainerStyle={{ gap: 12, paddingRight: 16 }}>
                {related.data.map((r) => (
                  <Tap key={r.id} href={{ pathname: '/artist', params: { id: r.id } }} style={{ width: 128, gap: 6 }}>
                    <Cover artwork={r.image} id={r.id} size={128} radius={10} />
                    <T size={13} weight={600} numberOfLines={1}>
                      {r.name}
                    </T>
                  </Tap>
                ))}
              </ScrollView>
            </>
          ) : null}

          {/* On tour */}
          <SectionHeader title="On tour" />
          <OnTour artistName={a.name} />
        </>
      ) : null}
    </Screen>
  );
}

/** Upcoming shows for this artist from the `concerts` edge function (Ticketmaster keyword search). */
function OnTour({ artistName }: { artistName: string }) {
  const shows = useAsync(async () => {
    try {
      const events = await fetchConcerts({ keyword: artistName });
      const key = artistName.toLowerCase();
      // Keyword search is fuzzy; prefer events billed to this artist.
      const mine = events.filter((e) => e.artist?.toLowerCase() === key || e.name.toLowerCase().includes(key));
      return { events: (mine.length ? mine : events).slice(0, 3), notConfigured: false };
    } catch (e) {
      if (e instanceof ServiceNotConfiguredError) return { events: [], notConfigured: true };
      throw e;
    }
  }, [artistName], 'app/artist:269');

  const message = (title: string, body: string, badge: string) => (
    <Glass padding={16} style={{ marginTop: -8 }}>
      <Row gap={12}>
        <View style={{ width: 52, height: 56, borderRadius: 28, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
          <Overline>{badge}</Overline>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={16} weight={600}>
            {title}
          </T>
          <T size={14} color={colors.textSecondary}>
            {body}
          </T>
        </View>
      </Row>
    </Glass>
  );

  if (shows.loading) return <Loading label="Looking for tour dates" height={80} />;
  if (shows.error) return message('Tour dates unavailable', shows.error, 'OFF');
  if (shows.data?.notConfigured) return message('Tour dates need setup', TICKETMASTER_SETUP_MESSAGE, 'SETUP');
  const events = shows.data?.events ?? [];
  if (!events.length) return message('No upcoming shows', `${artistName} has no listed concerts right now.`, 'NONE');
  return (
    <View style={{ gap: 10, marginTop: -8 }}>
      {events.map((e) => (
        <EventCard key={e.id} e={e} onTickets={() => e.url && void WebBrowser.openBrowserAsync(e.url).catch(() => {})} />
      ))}
    </View>
  );
}
