import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';

import { ChipRow, Cover, EmptyState, ErrorState, Icon, IconButton, Loading, Screen, ScreenHeader, T, Tap, useAsync } from '../components';
import { ProfileTabs, usePullRefresh } from '../features/profile-ui';
import { loadPublicPlaylists } from '../lib/profile';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors, layout } from '../theme/tokens';

type Card = { id: string; title: string; cover_url: string | null; track_count: number; visibility?: 'public' | 'private' | 'collaborative'; mine?: boolean };

const VIS_ICON = { public: 'globe', private: 'lock', collaborative: 'users' } as const;

function Grid({ items }: { items: Card[] }) {
  const { width } = useWindowDimensions();
  const size = Math.floor((Math.min(width, 520) - layout.gutter * 2 - 16) / 2);
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
      {items.map((p) => (
        <Tap
          key={p.id}
          accessibilityLabel={`${p.title}, ${p.track_count} songs`}
          onPress={() => router.push({ pathname: '/playlist', params: { id: p.id } })}
          style={{ width: size, gap: 8 }}
        >
          <Cover uri={p.cover_url} id={p.id} size={size} radius={32} />
          <View style={{ gap: 2 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {p.title}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {p.visibility ? <Icon name={VIS_ICON[p.visibility]} size={12} color={colors.textSecondary} /> : null}
              <T size={12} color={colors.textSecondary}>
                {`${p.track_count} ${p.track_count === 1 ? 'song' : 'songs'}`}
              </T>
            </View>
          </View>
        </Tap>
      ))}
    </View>
  );
}

/** Your playlists (owned + collaborations), or someone else's public ones with `?id=`. */
export default function ProfilePlaylists() {
  const { id: rawId } = useLocalSearchParams<{ id?: string }>();
  const { user, profile } = useAuth();
  const me = user?.id;
  const otherId = typeof rawId === 'string' && rawId && rawId !== me ? rawId : null;
  return otherId && me ? <TheirPlaylists id={otherId} me={me} /> : <MyPlaylists me={me} name={profile?.display_name ?? 'Playlists'} />;
}

function MyPlaylists({ me, name }: { me?: string; name: string }) {
  const { playlists, reload } = useLibrary();
  const [filter, setFilter] = useState(0);
  const pullControl = usePullRefresh(false, reload);
  const cards: Card[] = playlists.map((p) => ({
    id: p.id,
    title: p.title,
    cover_url: p.cover_url,
    track_count: p.track_count ?? 0,
    visibility: p.visibility,
    mine: p.owner_id === me,
  }));
  const groups = [
    { label: 'All', items: cards },
    { label: 'Public', items: cards.filter((c) => c.mine && c.visibility === 'public') },
    { label: 'Private', items: cards.filter((c) => c.mine && c.visibility === 'private') },
    { label: 'Collaborative', items: cards.filter((c) => c.visibility === 'collaborative' || !c.mine) },
  ];
  const shown = groups[filter].items;

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }} refreshControl={me ? pullControl : undefined}>
      <ScreenHeader title={name} right={<IconButton icon="plus" label="New playlist" bg={colors.accent} color={colors.onAccent} href="/create-playlist" />} />
      <ProfileTabs active="playlists" />
      <ChipRow options={groups.map((g) => `${g.label} ${g.items.length}`)} initial={filter} onChange={setFilter} />
      {shown.length ? (
        <Grid items={shown} />
      ) : (
        <EmptyState
          icon="music"
          title={filter === 0 ? 'No playlists yet' : `No ${groups[filter].label.toLowerCase()} playlists`}
          body={filter === 0 ? 'Make your first playlist and it lives here.' : 'Change a playlist’s visibility from its options.'}
          action={filter === 0 ? 'Create playlist' : undefined}
          href="/create-playlist"
        />
      )}
    </Screen>
  );
}

function TheirPlaylists({ id, me }: { id: string; me: string }) {
  const res = useAsync(() => loadPublicPlaylists(id, me), [id, me]);
  const d = res.data;
  const pullControl = usePullRefresh(res.loading, res.refresh);
  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }} refreshControl={pullControl}>
      <ScreenHeader title={d?.person.display_name ?? 'Playlists'} />
      {res.loading && !d ? (
        <Loading height={240} />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : d?.hidden ? (
        <EmptyState icon="users" title="This profile is private" body={`Follow ${d.person.display_name} to see their playlists.`} />
      ) : d && d.playlists.length ? (
        <Grid items={d.playlists} />
      ) : (
        <EmptyState icon="music" title="No public playlists" body="Nothing shared publicly yet." />
      )}
    </Screen>
  );
}
