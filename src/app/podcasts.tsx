import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import {
  ChipRow,
  Cover,
  EmptyState,
  ErrorState,
  Glass,
  IconButton,
  Loading,
  MiniPlayer,
  Overline,
  ProgressBar,
  Row,
  Screen,
  ScreenHeader,
  SectionHeader,
  T,
  Tap,
  Toast,
  useAsync,
} from '../components';
import { EpisodeDownload } from '../components/EpisodeDownload';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors, shadow } from '../theme/tokens';

const categories = ['For you', 'Music', 'Interviews', 'Culture', 'Comedy'];
const CONTEXT = 'Podcasts';

type Show = { id: string; name: string; image?: string; track: CatalogTrack };

function dedupe(lists: CatalogTrack[][]) {
  const seen = new Set<string>();
  return lists.flat().filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

async function loadEpisodes(category: string) {
  if (category === 'For you') {
    const [trending, search] = await Promise.all([
      catalog.trending({ genre: 'Podcasts', limit: 30 }),
      catalog.searchTracks('podcast', { limit: 25 }).catch(() => [] as CatalogTrack[]),
    ]);
    return dedupe([trending, search]);
  }
  const [genre, search] = await Promise.all([
    catalog.searchTracks(category, { genre: 'Podcasts', limit: 25 }).catch(() => [] as CatalogTrack[]),
    catalog.searchTracks(`${category} podcast`, { limit: 25 }),
  ]);
  return dedupe([genre, search]);
}

function ContinueCard({ episodes }: { episodes: CatalogTrack[] }) {
  const { track, context, playing, toggle, playTracks } = usePlayerPick('track', 'playing', 'context');
  const { progress } = usePlaybackProgress();
  const resuming = !!track && context === CONTEXT;
  const item = resuming ? track : episodes[0];
  if (!item) return null;
  return (
    <Glass radius={26} padding={16}>
      <Row>
        <Cover artwork={item.artwork} id={item.id} size={72} radius={32} />
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <Overline>{resuming ? 'CONTINUE LISTENING' : 'START LISTENING'}</Overline>
          <T size={16} weight={600} numberOfLines={1}>
            {item.title}
          </T>
          <ProgressBar value={resuming ? progress : 0} />
        </View>
        <IconButton
          icon={resuming && playing ? 'pause' : 'play'}
          label={resuming && playing ? 'Pause' : 'Play'}
          size={48}
          bg={colors.accent}
          color={colors.onAccent}
          onPress={() => (resuming ? toggle() : playTracks(episodes, 0, CONTEXT))}
          style={shadow.sticker}
        />
      </Row>
    </Glass>
  );
}

export default function Podcasts() {
  const [category, setCategory] = useState(0);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { playTracks } = usePlayerPick();
  const { data, loading, error, reload, refresh } = useAsync(() => loadEpisodes(categories[category]), [category], 'app/podcasts:90');
  const episodes = useMemo(() => data ?? [], [data]);

  const shows = useMemo(() => {
    const map = new Map<string, Show>();
    for (const t of episodes) if (!map.has(t.artist.id)) map.set(t.artist.id, { id: t.artist.id, name: t.artist.name, image: t.artist.image, track: t });
    return [...map.values()].slice(0, 12);
  }, [episodes]);

  return (
    <Screen onRefresh={refresh} top={4} bottom={12} gap={18} backdrop={{ pattern: 'lines', mesh: 'peach' }} footer={<MiniPlayer />}>
      <ScreenHeader title="Podcasts" right={<IconButton icon="search" label="Search podcasts" href="/search" />} />

      {episodes.length ? <ContinueCard episodes={episodes} /> : null}

      <ChipRow options={categories} initial={category} onChange={setCategory} />

      {loading ? (
        <Loading label="Finding shows" />
      ) : error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !episodes.length ? (
        <EmptyState icon="search" title="No shows here yet" body="Try another category." />
      ) : (
        <>
          <View style={{ gap: 12 }}>
            <SectionHeader title="Popular shows" />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingBottom: 4 }}>
              {shows.map((s) => (
                <Tap key={s.id} accessibilityLabel={s.name} onPress={() => router.push({ pathname: '/podcast-show', params: { id: s.id } })} style={{ width: 132, gap: 8 }}>
                  <Cover uri={s.image} artwork={s.image ? undefined : s.track.artwork} id={s.id} size={132} radius={36} sticker />
                  <T size={14} weight={600} lineHeight={18} numberOfLines={2}>
                    {s.name}
                  </T>
                </Tap>
              ))}
            </ScrollView>
          </View>

          <View style={{ gap: 12 }}>
            <SectionHeader title="New episodes" />
            <Glass radius={26} padding={4}>
              {episodes.slice(0, 20).map((e, i) => (
                <Tap
                  key={e.id}
                  accessibilityLabel={`Play ${e.title} by ${e.artist.name}`}
                  onPress={() => playTracks(episodes, i, CONTEXT)}
                  style={[{ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
                >
                  <Cover artwork={e.artwork} id={e.id} size={56} radius={18} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={16} weight={500} numberOfLines={1}>
                      {e.title}
                    </T>
                    <T size={14} color={colors.textSecondary} numberOfLines={1}>
                      {e.artist.name} · {formatDuration(e.duration)}
                    </T>
                  </View>
                  <EpisodeDownload episode={e} onResult={setNote} />
                </Tap>
              ))}
            </Glass>
            {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}
          </View>
        </>
      )}
    </Screen>
  );
}
