import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { Art, ChipRow, Cover, EmptyState, ErrorState, Glass, Icon, Loading, Screen, ScreenHeader, SectionHeader, T, Tap, useAsync, type IconName } from '../components';
import { ProfileTabs, usePullRefresh } from '../features/profile-ui';
import { activityBucket, loadActivity, type ActivityItem, type ActivityKind } from '../lib/profile';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, type ArtName } from '../theme/tokens';

const FILTERS: { label: string; kinds: ActivityKind[] | null }[] = [
  { label: 'All', kinds: null },
  { label: 'Listening', kinds: ['listening'] },
  { label: 'Playlists', kinds: ['playlists'] },
  { label: 'Social', kinds: ['social'] },
  { label: 'Library', kinds: ['library'] },
  { label: 'Badges', kinds: ['badges'] },
];

const KIND_STYLE: Record<ActivityKind, { icon: IconName; art: ArtName }> = {
  listening: { icon: 'play', art: 'coral' },
  playlists: { icon: 'music', art: 'rose' },
  social: { icon: 'users', art: 'blue' },
  badges: { icon: 'trophy', art: 'amber' },
  library: { icon: 'heart', art: 'green' },
};

function Entry({ item, onPress }: { item: ActivityItem; onPress?: () => void }) {
  const k = KIND_STYLE[item.kind];
  const body = (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <Art art={k.art} size={40} radius={20} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={k.icon} size={18} color={colors.white} />
      </Art>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={15} weight={600} lineHeight={20}>
          {item.title}
        </T>
        <T size={13} color={colors.textSecondary}>
          {item.meta}
        </T>
      </View>
      {item.cover ? <Cover uri={item.cover.uri} id={item.cover.id} size={48} radius={22} /> : null}
    </View>
  );
  if (!onPress) return <View accessible accessibilityLabel={`${item.title}. ${item.meta}`}>{body}</View>;
  return (
    <Tap onPress={onPress} accessibilityLabel={`${item.title}. ${item.meta}`}>
      {body}
    </Tap>
  );
}

export default function ProfileActivity() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const { playTrack } = usePlayerPick();
  const [filter, setFilter] = useState(0);
  const feed = useAsync(() => (uid ? loadActivity(uid) : Promise.reject(new Error('Sign in to see your activity'))), [uid], 'app/profile-activity:60');

  const { reload } = feed;
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) first.current = false;
      else reload();
    }, [reload]),
  );

  const pullControl = usePullRefresh(feed.loading, feed.refresh);

  const sections = useMemo(() => {
    const kinds = FILTERS[filter].kinds;
    const list = (feed.data ?? []).filter((i) => !kinds || kinds.includes(i.kind));
    const out: { title: string; items: ActivityItem[] }[] = [];
    const now = new Date();
    for (const it of list) {
      const b = activityBucket(it.at, now);
      const last = out[out.length - 1];
      if (last?.title === b) last.items.push(it);
      else out.push({ title: b, items: [it] });
    }
    return out;
  }, [feed.data, filter]);

  const open = (it: ActivityItem) => {
    if (it.track) return () => playTrack(it.track as NonNullable<ActivityItem['track']>, 'Your activity');
    if (it.playlistId) return () => router.push({ pathname: '/playlist', params: { id: it.playlistId as string } });
    if (it.personId) return () => router.push({ pathname: '/public-profile', params: { id: it.personId as string } });
    return undefined;
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'coral' }} refreshControl={uid ? pullControl : undefined}>
      <ScreenHeader title={profile?.display_name ?? 'Activity'} />
      <ProfileTabs active="activity" />
      <ChipRow options={FILTERS.map((f) => f.label)} initial={filter} onChange={setFilter} />

      {!uid ? (
        <EmptyState icon="users" title="Sign in to see your activity" body="Your plays, playlists, likes and follows show up here." action="Sign in" href="/login" />
      ) : feed.loading && !feed.data ? (
        <Loading height={240} label="Gathering your activity" />
      ) : feed.error && !feed.data ? (
        <ErrorState message={feed.error} onRetry={feed.reload} />
      ) : sections.length ? (
        sections.map((sec) => (
          <View key={sec.title} style={{ gap: 12 }}>
            <SectionHeader title={sec.title} />
            <Glass padding={20} style={{ gap: 16 }}>
              {sec.items.map((it) => (
                <Entry key={it.id} item={it} onPress={open(it)} />
              ))}
            </Glass>
          </View>
        ))
      ) : (
        <EmptyState icon="clock" title="No activity yet" body="Your plays, playlists, likes and follows from the last 30 days show up here." />
      )}
    </Screen>
  );
}
