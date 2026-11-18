import { memo, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Art, ChipRow, Cover, EmptyState, Glass, Icon, IconButton, Row, Screen, SectionHeader, Sticker, T, Tap } from '../../components';
import type { NavTarget } from '../../components';
import type { Artwork } from '../../lib/catalog';
import { useAuth } from '../../state/auth';
import { useLibrary, type UserPlaylist } from '../../state/library';
import { colors, type ArtName } from '../../theme/tokens';

const filters = ['All', 'Playlists', 'Albums', 'Artists', 'Downloaded'] as const;
type Filter = (typeof filters)[number];

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

/**
 * One library entry. Items are rebuilt whenever likes / playlists / filters change, so compare by the
 * fields that are drawn: unchanged rows skip re-rendering (and their Cover images) entirely.
 */
const LibraryRow = memo(
  function LibraryRow({ it }: { it: Item }) {
    return (
      <Tap href={it.href} style={{ minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Cover artwork={it.artwork} uri={it.uri} id={it.id} size={56} radius={it.round ? 36 : 26} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={16} weight={600} numberOfLines={1}>
            {it.title}
          </T>
          <T size={14} color={colors.textSecondary} numberOfLines={1}>
            {it.sub}
          </T>
        </View>
      </Tap>
    );
  },
  (a, b) =>
    a.it.key === b.it.key &&
    a.it.title === b.it.title &&
    a.it.sub === b.it.sub &&
    a.it.uri === b.it.uri &&
    a.it.artwork === b.it.artwork &&
    a.it.round === b.it.round,
);

export default function Library() {
  const { user } = useAuth();
  const { liked, playlists, followedArtists, reload } = useLibrary();
  const [filter, setFilter] = useState<Filter>('All');
  const [alpha, setAlpha] = useState(false);

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
    else if (filter === 'Downloaded') list = [];
    return alpha ? list.sort((a, b) => a.title.localeCompare(b.title)) : list.sort((a, b) => b.sortAt - a.sortAt);
  }, [playlists, followedArtists, filter, alpha, user]);

  const showLiked = filter === 'All' || filter === 'Playlists';
  const count = items.length + (showLiked ? 1 : 0);

  return (
    <Screen tabbed gap={20} backdrop={{ pattern: 'dots', mesh: 'rose' }} onRefresh={user ? reload : undefined}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="display" accessibilityRole="header">
          Your Library
        </T>
        <IconButton icon="plus" label="Create" bg={colors.accent} color={colors.onAccent} href="/create-playlist" />
      </Row>

      <ChipRow options={[...filters]} onChange={(i) => setFilter(filters[i])} />

      {/* Import banner */}
      <Tap href="/import">
        <Glass radius={36} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="download" size={20} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={15} weight={600}>
              Bring your playlists
            </T>
            <T size={13} color={colors.textSecondary}>
              Import from Spotify, Apple Music or YouTube Music
            </T>
          </View>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </Glass>
      </Tap>

      {/* Device music */}
      <Tap href="/local-music">
        <Glass radius={36} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 16 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="phone" size={20} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={15} weight={600}>
              Local files
            </T>
            <T size={13} color={colors.textSecondary}>
              Songs saved on this device
            </T>
          </View>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </Glass>
      </Tap>

      {/* Smart playlists — computed from your likes and history */}
      <SectionHeader title="Smart playlists" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingBottom: 6 }}>
        {smart.map((s) => (
          <Tap key={s.key} href={{ pathname: '/playlist', params: { smart: s.key } }} style={{ width: 132, gap: 8 }}>
            <Art art={s.art} size={132} radius={36} sticker>
              <Sticker label="SMART" rotate={-6} style={{ position: 'absolute', left: 8, top: 8 }} />
            </Art>
            <T size={14} weight={600}>
              {s.title}
            </T>
          </Tap>
        ))}
      </ScrollView>

      {/* Sort row */}
      <Row style={{ justifyContent: 'space-between' }}>
        <Tap onPress={() => setAlpha((v) => !v)} accessibilityLabel={`Sort: ${alpha ? 'Alphabetical' : 'Recently added'}`} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="sort" size={20} />
          <T size={14} weight={500}>
            {alpha ? 'Alphabetical' : 'Recently added'}
          </T>
        </Tap>
        <T mono size={12} color={colors.textSecondary}>
          {count} {count === 1 ? 'item' : 'items'}
        </T>
      </Row>

      {/* Liked songs */}
      {showLiked ? (
        <Tap href={{ pathname: '/playlist', params: { liked: '1' } }} style={{ minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Art art="sunrise" size={56} radius={36} style={{ alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="heart" size={24} color={colors.white} />
          </Art>
          <View style={{ gap: 2 }}>
            <T size={16} weight={600}>
              Liked Songs
            </T>
            <T size={14} color={colors.textSecondary}>
              Playlist · {liked.length} {liked.length === 1 ? 'song' : 'songs'}
            </T>
          </View>
        </Tap>
      ) : null}

      {items.length === 0 ? (
        filter === 'Downloaded' ? (
          <EmptyState icon="download" title="Offline downloads are coming" body="Saving songs to your device needs a licensed catalogue. Until then everything streams." action="See downloads" href="/downloads" />
        ) : filter === 'Artists' ? (
          <EmptyState icon="users" title="No artists yet" body="Follow artists you love and they will live here." action="Find artists" href="/search" />
        ) : filter === 'Albums' ? (
          <EmptyState icon="music" title="No saved albums" body="Tap the heart on an album to keep a copy in your library." />
        ) : filter === 'Playlists' ? (
          <EmptyState title="No playlists yet" body="Create one, or let AI build one from a prompt." action="Create playlist" href="/create-playlist" />
        ) : (
          <EmptyState title="Your library is empty" body="Create a playlist or follow an artist to get started." action="Create playlist" href="/create-playlist" />
        )
      ) : (
        <View style={{ marginTop: -8 }}>
          {items.map((it) => (
            <LibraryRow key={it.key} it={it} />
          ))}
        </View>
      )}
    </Screen>
  );
}
