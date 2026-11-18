import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';

import { ChipRow, Cover, EmptyState, ErrorState, Glass, IconButton, Loading, MiniPlayer, Screen, ScreenHeader, T, Tap, useAsync } from '../components';
import { catalog, type Artwork, type CatalogTrack, type Collection } from '../lib/catalog';
import { useContentFilter } from '../lib/content-filter';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors, shadow } from '../theme/tokens';

const tabs = ['All', 'Albums', 'Singles', 'Following'] as const;
type Tab = (typeof tabs)[number];

type Release = { key: string; title: string; meta: string; date: number; artwork: Artwork; artistId: string; track?: CatalogTrack; album?: Collection; following: boolean };

const DAY = 86_400_000;
const parse = (d?: string) => (d ? Date.parse(d) || 0 : 0);
const fmt = (ms: number) => (ms ? new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : 'Date unknown');

function GroupLabel({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  return (
    <T size={12} weight={600} tracking={0.5} color={colors.textSecondary} accessibilityRole="header" style={style}>
      {children}
    </T>
  );
}

function ReleaseCard({ r, onPlay }: { r: Release; onPlay: () => void }) {
  const open = () => (r.album ? router.push({ pathname: '/album', params: { id: r.album.id } }) : router.push({ pathname: '/artist', params: { id: r.artistId } }));
  return (
    <Tap onPress={open} accessibilityLabel={`${r.title}, ${r.meta}`}>
      <Glass radius={36} padding={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Cover artwork={r.artwork} id={r.key} size={84} radius={32} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <T size={17} weight={700} numberOfLines={1}>
            {r.title}
          </T>
          <T size={14} color={colors.textSecondary} numberOfLines={1}>
            {r.meta}
          </T>
          <T mono size={12} color={colors.textSecondary}>
            {fmt(r.date)}
          </T>
        </View>
        <IconButton icon="play" label={`Play ${r.title}`} size={48} bg={colors.accent} color={colors.onAccent} onPress={onPlay} style={shadow.sticker} />
      </Glass>
    </Tap>
  );
}

export default function NewReleases() {
  const { followedArtists } = useLibrary();
  const { playTracks } = usePlayerPick();
  const [initialTab] = useState(followedArtists.length ? 3 : 0);
  const [tab, setTab] = useState<Tab>(tabs[initialTab]);
  const followKey = followedArtists.map((a) => a.id).join(',');

  const data = useAsync(async () => {
    const ids = followedArtists.slice(0, 20).map((a) => a.id);
    const [followedTracks, albums, recent] = await Promise.all([
      Promise.all(ids.map((id) => catalog.artistTracks(id, 5, 'date').catch(() => [] as CatalogTrack[]))).then((l) => l.flat()),
      Promise.all(ids.map((id) => catalog.artistCollections(id, 5))).then((l) => l.flat().filter((c) => c.isAlbum)),
      catalog.trending({ time: 'week', limit: 40 }),
    ]);
    return { followedTracks, albums, recent, ids: new Set(ids) };
  }, [followKey]);

  const { filter: hideFilter, hiddenArtists } = useContentFilter();
  // Fixed "now" for this visit: grouping and the 60-day window stay stable across re-renders.
  const [now] = useState(() => Date.now());
  const releases = useMemo(() => {
    const d = data.data;
    if (!d) return [] as Release[];
    const seen = new Set<string>();
    const out: Release[] = [];
    const addTrack = (t: CatalogTrack, following: boolean) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      out.push({ key: t.id, title: t.title, meta: `${t.artist.name} · Single`, date: parse(t.releaseDate), artwork: t.artwork, artistId: t.artist.id, track: t, following });
    };
    if (tab !== 'Albums') {
      hideFilter(d.followedTracks).forEach((t) => addTrack(t, true));
      if (tab !== 'Following') {
        const cutoff = now - 60 * DAY;
        hideFilter(d.recent).filter((t) => parse(t.releaseDate) > cutoff).forEach((t) => addTrack(t, d.ids.has(t.artist.id)));
      }
    }
    if (tab === 'All' || tab === 'Albums' || tab === 'Following') {
      d.albums.forEach((a) => {
        if (seen.has(a.id) || hiddenArtists.has(a.artist.id)) return;
        seen.add(a.id);
        out.push({ key: a.id, title: a.title, meta: `${a.artist.name} · Album`, date: parse(a.releaseDate), artwork: a.artwork, artistId: a.artist.id, album: a, following: true });
      });
    }
    return out.sort((a, b) => b.date - a.date);
  }, [data.data, tab, hideFilter, hiddenArtists, now]);

  const play = async (r: Release) => {
    if (r.track) {
      const singles = releases.filter((x) => x.track).map((x) => x.track as CatalogTrack);
      playTracks(singles, Math.max(0, singles.findIndex((t) => t.id === r.track?.id)), 'New releases');
    } else if (r.album) {
      const t = await catalog.collectionTracks(r.album.id).catch(() => [] as CatalogTrack[]);
      if (t.length) playTracks(t, 0, r.album.title);
    }
  };

  const groups: { label: string; items: Release[] }[] = [
    { label: 'THIS WEEK', items: releases.filter((r) => now - r.date < 7 * DAY) },
    { label: 'LAST WEEK', items: releases.filter((r) => now - r.date >= 7 * DAY && now - r.date < 14 * DAY) },
    { label: 'EARLIER', items: releases.filter((r) => now - r.date >= 14 * DAY) },
  ].filter((g) => g.items.length);

  return (
    <Screen onRefresh={data.refresh} top={4} bottom={12} gap={14} backdrop={{ pattern: 'grid', mesh: 'rose' }} footer={<MiniPlayer />}>
      <ScreenHeader title="New releases" right={<IconButton icon="bell" label="Notification settings" href="/notif-settings" />} />

      <ChipRow options={[...tabs]} initial={initialTab} onChange={(i) => setTab(tabs[i])} />

      {data.loading && !data.data ? (
        <Loading label="Finding new music" />
      ) : data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !groups.length ? (
        tab === 'Following' || tab === 'Albums' ? (
          <EmptyState
            icon="users"
            title={followedArtists.length ? 'Nothing new yet' : 'Follow artists to see their releases'}
            body={followedArtists.length ? 'Artists you follow have not released anything recently.' : 'Their newest tracks and albums show up here.'}
            action={followedArtists.length ? undefined : 'Find artists'}
            href={followedArtists.length ? undefined : '/artists'}
          />
        ) : (
          <EmptyState title="No new releases right now" />
        )
      ) : (
        groups.map((g, gi) => (
          <View key={g.label} style={{ gap: 14 }}>
            <GroupLabel style={gi ? { marginTop: 4 } : undefined}>{g.label}</GroupLabel>
            {g.items.slice(0, 30).map((r) => (
              <ReleaseCard key={r.key} r={r} onPlay={() => void play(r)} />
            ))}
          </View>
        ))
      )}
    </Screen>
  );
}
