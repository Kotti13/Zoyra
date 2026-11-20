import { useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';

import { APPLE, AppleNavRow, AppleSeparator, AppleTitle, EmptyState, Icon, IconButton, Row, Screen, Shelf, ShelfCard, ShelfHeader, Sticker, T, Tap, go } from '../../components';
import type { NavTarget } from '../../components';
import type { Artwork } from '../../lib/catalog';
import { useAuth } from '../../state/auth';
import { useLibrary, type UserPlaylist } from '../../state/library';
import { colors, type ArtName } from '../../theme/tokens';

type Filter = 'All' | 'Playlists' | 'Albums' | 'Artists';

const smart: { key: string; title: string; art: ArtName }[] = [
  { key: 'week', title: 'Liked this week', art: 'coral' },
  { key: 'rediscover', title: 'Rediscover', art: 'amber' },
  { key: 'short', title: 'Under 3 min', art: 'green' },
];

type Item = { key: string; title: string; sub: string; id: string; artwork?: Artwork; uri?: string | null; round?: boolean; href: NavTarget; kind: 'playlist' | 'album' | 'artist'; sortAt: number };

/** Albums saved from the album screen are stored as playlist copies tagged "Album · <artist>". */
const isSavedAlbum = (p: UserPlaylist) => p.description.startsWith('Album · ');

function playlistSub(p: UserPlaylist) {
  if (isSavedAlbum(p)) return p.description;
  if (p.is_ai) return 'Playlist · AI generated';
  if (p.visibility === 'collaborative') return 'Playlist · Collaborative';
  const n = p.track_count ?? 0;
  return `Playlist · ${n} ${n === 1 ? 'song' : 'songs'}`;
}

export default function Library() {
  const { user } = useAuth();
  const { liked, playlists, followedArtists, reload } = useLibrary();
  const [filter, setFilter] = useState<Filter>('All');
  const [alpha, setAlpha] = useState(false);
  const { width: winW } = useWindowDimensions();
  const cardW = Math.floor((winW - APPLE.side * 2 - APPLE.gap) / 2);

  const items = useMemo(() => {
    const pls: Item[] = playlists.map((p, i) => ({
      key: `p-${p.id}`,
      id: p.id,
      title: p.title,
      sub: playlistSub(p) + (user && p.owner_id !== user.id ? ' · Shared with you' : ''),
      uri: p.cover_url,
      href: { pathname: '/playlist', params: { id: p.id } },
      kind: isSavedAlbum(p) ? 'album' : 'playlist',
      sortAt: Date.parse(p.updated_at) || -i,
    }));
    const arts: Item[] = followedArtists.map((a, i) => ({
      key: `a-${a.id}`,
      id: a.id,
      title: a.name,
      sub: 'Artist',
      artwork: a.image,
      round: true,
      href: { pathname: '/artist', params: { id: a.id } },
      kind: 'artist',
      // followed list is newest first; slot artists between playlists by order
      sortAt: -1e12 - i,
    }));
    let list = [...pls, ...arts];
    if (filter === 'Playlists') list = list.filter((x) => x.kind === 'playlist');
    else if (filter === 'Albums') list = list.filter((x) => x.kind === 'album');
    else if (filter === 'Artists') list = list.filter((x) => x.kind === 'artist');
    return alpha ? list.sort((a, b) => a.title.localeCompare(b.title)) : list.sort((a, b) => b.sortAt - a.sortAt);
  }, [playlists, followedArtists, filter, alpha, user]);

  const counts = useMemo(
    () => ({
      Playlists: playlists.filter((p) => !isSavedAlbum(p)).length,
      Albums: playlists.filter(isSavedAlbum).length,
      Artists: followedArtists.length,
    }),
    [playlists, followedArtists],
  );
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const likedSub = plural(liked.length, 'song', 'songs');

  return (
    <Screen tabbed gap={APPLE.section} backdrop={{ pattern: 'dots', mesh: 'rose' }} onRefresh={user ? reload : undefined}>
      <AppleTitle title={filter === 'All' ? 'Library' : filter} right={<IconButton icon="plus" label="Create" bg={colors.accent} color={colors.onAccent} href="/create-playlist" />} />

      {filter !== 'All' ? (
        <Tap onPress={() => setFilter('All')} accessibilityLabel="Back to Library" style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: -APPLE.section / 2 }}>
          <Icon name="back" size={18} color={colors.accentLight} />
          <T size={15} weight={500} color={colors.accentLight}>
            Library
          </T>
        </Tap>
      ) : null}

      {/* Category rows */}
      {filter === 'All' ? (
        <View>
          <AppleNavRow icon="library" title="Playlists" subtitle={plural(counts.Playlists, 'playlist', 'playlists')} onPress={() => setFilter('Playlists')} />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="users" title="Artists" subtitle={plural(counts.Artists, 'artist', 'artists')} onPress={() => setFilter('Artists')} />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="music" title="Albums" subtitle={plural(counts.Albums, 'album', 'albums')} onPress={() => setFilter('Albums')} />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="heart" title="Liked songs" subtitle={likedSub} href={{ pathname: '/playlist', params: { liked: '1' } }} />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="download" title="Downloaded" href="/downloads" />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="clock" title="Recently played" href="/recent" />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="phone" title="Local files" subtitle="Songs saved on this device" href="/local-music" />
          <AppleSeparator inset={46} />
          <AppleNavRow icon="arrowRight" title="Import playlists" subtitle="From Spotify, Apple Music or YouTube Music" href="/import" />
        </View>
      ) : null}

      {/* Smart playlists: computed from your likes and history */}
      {filter === 'All' ? (
        <View style={{ gap: 12 }}>
          <ShelfHeader title="Smart playlists" />
          <Shelf
            data={smart}
            keyExtractor={(x) => x.key}
            renderItem={({ item: x }) => (
              <ShelfCard title={x.title} id={x.key} art={x.art} onPress={() => go({ pathname: '/playlist', params: { smart: x.key } })}>
                <Sticker label="SMART" rotate={-6} style={{ position: 'absolute', left: 8, top: 8 }} />
              </ShelfCard>
            )}
          />
        </View>
      ) : null}

      {/* Recently added grid */}
      <View style={{ gap: 12 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={22} weight={700} tracking={-0.4} accessibilityRole="header">
            {alpha ? 'Alphabetical' : 'Recently added'}
          </T>
          <Tap onPress={() => setAlpha((v) => !v)} accessibilityLabel={`Sort: ${alpha ? 'Alphabetical' : 'Recently added'}`} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="sort" size={18} color={colors.accentLight} />
            <T size={14} weight={500} color={colors.accentLight}>
              Sort
            </T>
          </Tap>
        </Row>

        {items.length === 0 ? (
          filter === 'Artists' ? (
            <EmptyState icon="users" title="No artists yet" body="Follow artists you love and they will live here." action="Find artists" href="/search" />
          ) : filter === 'Albums' ? (
            <EmptyState icon="music" title="No saved albums" body="Tap the heart on an album to keep a copy in your library." />
          ) : filter === 'Playlists' ? (
            <EmptyState title="No playlists yet" body="Create one, or let AI build one from a prompt." action="Create playlist" href="/create-playlist" />
          ) : (
            <EmptyState title="Your library is empty" body="Create a playlist or follow an artist to get started." action="Create playlist" href="/create-playlist" />
          )
        ) : (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: APPLE.gap, rowGap: 20 }}>
            {items.map((it) => (
              <ShelfCard key={it.key} title={it.title} subtitle={it.sub} artwork={it.artwork} uri={it.uri} id={it.id} size={cardW} round={it.round} onPress={() => go(it.href)} />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}
