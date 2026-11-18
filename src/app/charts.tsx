import { useState } from 'react';
import { View } from 'react-native';

import { ChipRow, Cover, EmptyState, ErrorState, IconButton, Loading, MiniPlayer, MoreButton, Row, Screen, ScreenHeader, Segmented, T, Tap, useAsync } from '../components';
import { GENRES, catalog, formatCount, type TimeRange } from '../lib/catalog';
import { useContentFilter } from '../lib/content-filter';
import { setSheetTrack } from '../state/selection';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const ranges: { label: string; value: TimeRange }[] = [
  { label: 'This week', value: 'week' },
  { label: 'This month', value: 'month' },
  { label: 'All time', value: 'allTime' },
];

const podiumStyle: Record<number, { height: number; color: string }> = {
  1: { height: 100, color: colors.amber },
  2: { height: 70, color: colors.accentLight },
  3: { height: 52, color: colors.peach },
};

export default function Charts() {
  const { playTracks, track: current } = usePlayerPick('track');
  const [scope, setScope] = useState(0); // 0 Global, 1 Genre
  const [genre, setGenre] = useState<string>(GENRES[0]);
  const [range, setRange] = useState<TimeRange>('week');
  const g = scope === 1 ? genre : undefined;

  const chart = useAsync(() => catalog.trending({ genre: g, time: range, limit: 30 }), [g, range]);
  const { filter: hideFilter } = useContentFilter();
  const list = hideFilter(chart.data ?? []);
  const context = `Top charts${g ? ` · ${g}` : ''}`;
  const play = (i: number) => playTracks(list, i, context);

  // Podium order: 2, 1, 3
  const podium = [1, 0, 2].map((i) => ({ rank: i + 1, i, t: list[i] })).filter((p) => !!p.t);

  return (
    <Screen onRefresh={chart.refresh} top={4} bottom={12} gap={16} backdrop={{ pattern: 'dots', mesh: 'amberRose' }} footer={<MiniPlayer />}>
      <ScreenHeader
        title="Top charts"
        right={list[0] ? <IconButton icon="share" label="Share the number one track" href="/share-sheet" onPress={() => setSheetTrack(list[0])} /> : undefined}
      />

      <Segmented options={['Global', 'Genre']} initial={0} onChange={setScope} />
      {scope === 1 ? <ChipRow options={[...GENRES]} onChange={(i) => setGenre(GENRES[i])} /> : null}
      <ChipRow options={ranges.map((r) => r.label)} onChange={(i) => setRange(ranges[i].value)} />

      {chart.loading && !chart.data ? (
        <Loading label="Loading chart" />
      ) : chart.error ? (
        <ErrorState message={chart.error} onRetry={chart.reload} />
      ) : !list.length ? (
        <EmptyState title="No chart for this selection" body="Try another genre or time range." />
      ) : (
        <>
          {/* Podium */}
          <Row gap={10} align="flex-end">
            {podium.map((p) => (
              <Tap key={p.t.id} onPress={() => play(p.i)} accessibilityLabel={`Number ${p.rank}, ${p.t.title} by ${p.t.artist.name}`} style={{ flex: 1, alignItems: 'center', gap: 6, minWidth: 0 }}>
                <Cover artwork={p.t.artwork} id={p.t.id} radius={32} style={{ width: '100%', height: undefined, aspectRatio: 1 }} />
                <T size={13} weight={600} align="center" numberOfLines={1} color={current?.id === p.t.id ? colors.accentLight : colors.text}>
                  {p.t.title}
                </T>
                <View style={{ width: '100%', height: podiumStyle[p.rank].height, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: podiumStyle[p.rank].color, alignItems: 'center', paddingTop: 8 }}>
                  <T size={22} weight={700} color={colors.onAccent}>
                    {p.rank}
                  </T>
                </View>
              </Tap>
            ))}
          </Row>

          {/* Ranked list */}
          <View>
            {list.slice(3).map((s, k) => {
              const i = k + 3;
              const active = current?.id === s.id;
              return (
                <Tap key={s.id} onPress={() => play(i)} accessibilityLabel={`Number ${i + 1}, ${s.title} by ${s.artist.name}`} style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <T mono weight={500} size={15} align="center" style={{ width: 24 }}>
                    {i + 1}
                  </T>
                  <Cover artwork={s.artwork} id={s.id} size={48} radius={26} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={16} weight={600} numberOfLines={1} color={active ? colors.accentLight : colors.text}>
                      {s.title}
                    </T>
                    <T size={14} color={colors.textSecondary} numberOfLines={1}>
                      {s.artist.name} · {formatCount(s.plays)} plays
                    </T>
                  </View>
                  <MoreButton track={s} />
                </Tap>
              );
            })}
          </View>
        </>
      )}
    </Screen>
  );
}
