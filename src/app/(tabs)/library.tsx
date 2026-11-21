import { useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';

import { APPLE, AppleTitle, Chip, Cover, EmptyState, Glass, Gradient, Icon, IconButton, Row, Screen, Shelf, ShelfCard, ShelfHeader, Sticker, T, Tap, go, useAsync } from '../../components';
import type { IconName, NavTarget } from '../../components';
import type { Artwork } from '../../lib/catalog';
import { usePref } from '../../lib/prefs';
import { loadSmartCovers } from '../../lib/smart-covers';
import { useAuth } from '../../state/auth';
import { useLibrary, type UserPlaylist } from '../../state/library';
import { colors, withAlpha, type ArtName } from '../../theme/tokens';

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

const FILTERS: Filter[] = ['All', 'Playlists', 'Albums', 'Artists'];

/** Glass quick-access tile: round icon, title, optional one-line hint. */
function QuickTile({ icon, title, sub, href, width }: { icon: IconName; title: string; sub?: string; href: NavTarget; width: number }) {
  return (
    <Tap href={href} accessibilityLabel={sub ? `${title}. ${sub}` : title} style={{ width }}>
      <Glass radius={18} padding={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56 }}>
        <View style={{ width: 34, height: 34, borderRadius: 11, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={18} color={colors.text} glow={false} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={14} weight={700} numberOfLines={1}>
            {title}
          </T>
          {sub ? (
            <T size={11} color={colors.textSecondary} numberOfLines={1}>
              {sub}
            </T>
          ) : null}
        </View>
      </Glass>
    </Tap>
  );
}

export default function Library() {
  const { user } = useAuth();
  const { liked, playlists, followedArtists, reload } = useLibrary();
  const [filter, setFilter] = useState<Filter>('All');
  const [alpha, setAlpha] = useState(false);
  // Grid (3 small covers across) or compact list; remembered on this device.
  const [view, setView] = usePref<'grid' | 'list'>('library.view', 'grid');
  const { width: winW } = useWindowDimensions();
  const inner = winW - APPLE.side * 2;
  const tileW = Math.floor((inner - 10) / 2); // quick tiles: 2 across
  const gridW = Math.floor((inner - 10 * 2) / 3); // collection grid: 3 across
  const uid = user?.id;
  const likedKey = liked.length;
  const covers = useAsync(() => (uid ? loadSmartCovers(uid, liked) : Promise.resolve({})), [uid, likedKey], 'app/(tabs)/library:smartcovers');

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
      <AppleTitle title="Library" right={<IconButton icon="plus" label="Create" bg={colors.accent} color={colors.onAccent} href="/create-playlist" />} />

      {/* Filters: one tap between everything, playlists, albums and artists */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -APPLE.side, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: APPLE.side }}>
        {FILTERS.map((f) => {
          const n = f === 'All' ? 0 : counts[f];
          return <Chip key={f} label={n ? `${f} · ${n}` : f} active={filter === f} onPress={() => setFilter(f)} />;
        })}
      </ScrollView>

      {filter === 'All' ? (
        <View style={{ gap: 10 }}>
          {/* Liked songs: the one you open most */}
          <Tap href={{ pathname: '/playlist', params: { liked: '1' } }} accessibilityLabel={`Liked songs. ${likedSub}`}>
            <View style={{ height: 68, borderRadius: 20, overflow: 'hidden', paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Gradient colors={[colors.accent, colors.accentDark]} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
              <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: withAlpha(colors.white, 0.2), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="heart" size={22} color={colors.white} filled />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={16} weight={800} tracking={-0.3} color={colors.white}>
                  Liked songs
                </T>
                <T size={13} color={withAlpha(colors.white, 0.85)}>
                  {likedSub}
                </T>
              </View>
              <Icon name="chevronRight" size={20} color={colors.white} glow={false} />
            </View>
          </Tap>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <QuickTile icon="download" title="Downloaded" sub="Play offline" href="/downloads" width={tileW} />
            <QuickTile icon="clock" title="Recently played" sub="Your history" href="/recent" width={tileW} />
            <QuickTile icon="phone" title="Local files" sub="Saved on this device" href="/local-music" width={tileW} />
            <QuickTile icon="arrowRight" title="Import" sub="Spotify, Apple, YouTube" href="/import" width={tileW} />
          </View>
        </View>
      ) : null}

      {/* Smart playlists: computed from your likes and history */}
      {filter === 'All' ? (
        <View style={{ gap: 12 }}>
          <ShelfHeader title="Smart playlists" />
          <Shelf
            data={smart}
            itemWidth={118}
            keyExtractor={(x) => x.key}
            renderItem={({ item: x }) => {
              // The cover of the first song in that list; the colored tile until one is known.
              const artwork = (covers.data as Partial<Record<string, Artwork>> | undefined)?.[x.key];
              return (
                <ShelfCard title={x.title} id={x.key} size={118} radius={14} artwork={artwork} art={artwork ? undefined : x.art} onPress={() => go({ pathname: '/playlist', params: { smart: x.key } })}>
                  <Sticker label="SMART" rotate={-6} style={{ position: 'absolute', left: 6, top: 6, height: 20, paddingHorizontal: 8 }} />
                </ShelfCard>
              );
            }}
          />
        </View>
      ) : null}

      {/* Recently added grid */}
      <View style={{ gap: 12 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <T size={22} weight={700} tracking={-0.4} accessibilityRole="header">
            {filter === 'All' ? (alpha ? 'Alphabetical' : 'Recently added') : filter}
          </T>
          <Row gap={2}>
            <Tap onPress={() => setAlpha((v) => !v)} accessibilityLabel={`Sort: ${alpha ? 'Alphabetical' : 'Recently added'}`} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6 }}>
              <Icon name="sort" size={18} color={colors.accentLight} />
              <T size={14} weight={500} color={colors.accentLight}>
                Sort
              </T>
            </Tap>
            <IconButton icon={view === 'grid' ? 'queue' : 'grid'} label={view === 'grid' ? 'Show as list' : 'Show as grid'} size={44} iconSize={20} color={colors.accentLight} onPress={() => setView(view === 'grid' ? 'list' : 'grid')} />
          </Row>
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
          view === 'list' ? (
            <View>
              {items.map((it, i) => (
                <Tap key={it.key} onPress={() => go(it.href)} accessibilityLabel={`${it.title}. ${it.sub}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, borderTopWidth: i ? 1 : 0, borderTopColor: colors.divider }}>
                  <Cover artwork={it.artwork} uri={it.uri} id={it.id} size={46} radius={it.round ? 23 : 8} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} weight={600} numberOfLines={1}>
                      {it.title}
                    </T>
                    <T size={12} color={colors.textSecondary} numberOfLines={1}>
                      {it.sub}
                    </T>
                  </View>
                  <Icon name="chevronRight" size={16} color={colors.textTertiary} glow={false} />
                </Tap>
              ))}
            </View>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 10, rowGap: 14 }}>
              {items.map((it) => (
                <ShelfCard key={it.key} title={it.title} subtitle={it.sub} artwork={it.artwork} uri={it.uri} id={it.id} size={gridW} radius={12} round={it.round} onPress={() => go(it.href)} />
              ))}
            </View>
          )
        )}
      </View>
    </Screen>
  );
}
