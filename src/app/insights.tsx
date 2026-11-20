import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { EmptyState, ErrorState, Glass, IconButton, Loading, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, Segmented, T, useAsync } from '../components';
import { supabase } from '../lib/supabase';
import { shareSnapshot } from '../lib/share-snapshots';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type Insights = {
  minutes: number;
  plays: number;
  top_artists: { name: string | null; plays: number }[];
  top_genres: { genre: string | null; plays: number }[];
  by_day: { day: string; minutes: number }[];
};

const DAYS = [7, 30, 365] as const;
const PERIOD_NAME = ['week', 'month', 'year'];
const GENRE_COLORS = [colors.accent, colors.amber, colors.like, colors.peach, colors.accentLight];
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const fmtMinutes = (m: number) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  return h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`;
};

async function rpcInsights(days: number) {
  const { data, error } = await supabase.rpc('listening_insights', { days });
  if (error) throw new Error(error.message);
  return data as Insights;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Turn the per-day minutes into chart buckets for the chosen period. */
function buckets(byDay: Insights['by_day'], period: number): { labels: string[]; values: number[] } {
  const map = new Map(byDay.map((d) => [String(d.day).slice(0, 10), Number(d.minutes) || 0]));
  const today = new Date();
  if (period === 0) {
    const labels: string[] = [];
    const values: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 864e5);
      labels.push(WEEKDAY[d.getUTCDay()]);
      values.push(map.get(isoDay(d)) ?? 0);
    }
    return { labels, values };
  }
  if (period === 1) {
    const values = [0, 0, 0, 0, 0];
    for (let i = 0; i < 30; i++) {
      const d = new Date(today.getTime() - (29 - i) * 864e5);
      values[Math.floor(i / 6)] += map.get(isoDay(d)) ?? 0;
    }
    return { labels: ['W1', 'W2', 'W3', 'W4', 'W5'], values };
  }
  const labels: string[] = [];
  const values: number[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    labels.push(MONTH[m.getUTCMonth()]);
    const key = m.toISOString().slice(0, 7);
    let sum = 0;
    map.forEach((v, k) => {
      if (k.startsWith(key)) sum += v;
    });
    values.push(sum);
  }
  return { labels, values };
}

export default function Insights() {
  const { user, profile } = useAuth();
  const [period, setPeriod] = useState(0);
  const days = DAYS[period];

  const q = useAsync(async () => {
    if (!user) return null;
    const [cur, twice, hours] = await Promise.all([
      rpcInsights(days),
      rpcInsights(days * 2),
      supabase
        .from('play_history')
        .select('played_at, seconds_listened')
        .eq('user_id', user.id)
        .gte('played_at', new Date(Date.now() - days * 864e5).toISOString())
        .order('played_at', { ascending: false })
        .limit(5000),
    ]);
    if (hours.error) throw new Error(hours.error.message);
    // 7 weekdays × 12 two-hour blocks, weighted by seconds listened
    const heat = Array.from({ length: 84 }, () => 0);
    for (const h of (hours.data ?? []) as { played_at: string; seconds_listened: number }[]) {
      const d = new Date(h.played_at);
      heat[d.getDay() * 12 + Math.floor(d.getHours() / 2)] += Math.max(1, h.seconds_listened);
    }
    return { cur, prevMinutes: Math.max(0, (Number(twice.minutes) || 0) - (Number(cur.minutes) || 0)), heat };
  }, [user?.id, days], 'app/insights:80');

  const data = q.data;
  const chart = useMemo(() => (data ? buckets(data.cur.by_day ?? [], period) : null), [data, period]);
  const maxBar = chart ? Math.max(1, ...chart.values) : 1;
  const peak = chart ? chart.values.indexOf(Math.max(...chart.values)) : -1;
  const heatMax = data ? Math.max(1, ...data.heat) : 1;
  const minutes = Number(data?.cur.minutes) || 0;
  const plays = Number(data?.cur.plays) || 0;

  const delta = useMemo(() => {
    if (!data) return null;
    if (data.prevMinutes === 0) return minutes > 0 ? `New this ${PERIOD_NAME[period]}` : null;
    const pct = Math.round(((minutes - data.prevMinutes) / data.prevMinutes) * 100);
    return `${pct >= 0 ? '+' : ''}${pct}% vs last ${PERIOD_NAME[period]}`;
  }, [data, minutes, period]);

  const genres = useMemo(() => {
    const list = data?.cur.top_genres ?? [];
    const total = Math.max(1, plays);
    const named = list.map((g, i) => ({ name: g.genre || 'Unknown', pct: Math.round((Number(g.plays) / total) * 100), color: GENRE_COLORS[i % GENRE_COLORS.length] }));
    const rest = 100 - named.reduce((n, g) => n + g.pct, 0);
    return rest > 0 && named.length ? [...named, { name: 'Other', pct: rest, color: colors.textTertiary }] : named;
  }, [data, plays]);

  const share = () => {
    if (!data) return;
    const top = data.cur.top_artists?.[0]?.name;
    void shareSnapshot({
      kind: 'i',
      payload: { per: PERIOD_NAME[period] as 'week' | 'month' | 'year', min: Math.round(minutes), plays, delta: delta ?? null, artists: (data.cur.top_artists ?? []).slice(0, 5).map((a) => a.name ?? '').filter(Boolean), genres: genres.filter((g) => g.name !== 'Other').slice(0, 4).map((g) => ({ n: g.name, p: g.pct })) },
      title: 'My listening on Zoyra',
      me: { id: user?.id, username: profile?.username },
      message: `This ${PERIOD_NAME[period]} on Zoyra: ${fmtMinutes(minutes)} of music across ${plays} plays${top ? `, mostly ${top}` : ''}.` }).catch(() => undefined);
  };

  return (
    <Screen onRefresh={q.refresh}
      top={4}
      gap={16}
      backdrop={{
        pattern: 'grid',
        mesh: 'none',
        glows: [
          { x: 0, y: 0, color: colors.sky, opacity: 0.32 },
          { x: 1, y: 0.5, color: colors.accent, opacity: 0.25 },
        ],
      }}
    >
      <ScreenHeader title="Insights" right={<IconButton icon="share" label="Share" onPress={share} />} />

      <Segmented options={['Week', 'Month', 'Year']} onChange={setPeriod} />

      {!user ? (
        <EmptyState icon="clock" title="Sign in to see your insights" action="Sign in" href="/login" />
      ) : q.loading && !data ? (
        <Loading label="Crunching your listening" height={240} />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !data || plays === 0 ? (
        <EmptyState icon="clock" title="No listening yet" body={`Play some music and your ${PERIOD_NAME[period]} in numbers shows up here.`} action="Find music" href="/search" />
      ) : (
        <>
          <Glass padding={16}>
            <View style={{ gap: 16 }}>
              <Row gap={8} align="baseline">
                <T variant="hero">{fmtMinutes(minutes)}</T>
                {delta ? (
                  <T size={13} weight={600} color={delta.startsWith('-') ? colors.textSecondary : colors.success}>
                    {delta}
                  </T>
                ) : null}
              </Row>
              <Row gap={8} align="flex-end" style={{ height: 120 }}>
                {chart!.values.map((v, i) => (
                  <View
                    key={i}
                    accessibilityLabel={`${chart!.labels[i]}: ${Math.round(v)} minutes`}
                    style={{ flex: 1, height: Math.max(4, (v / maxBar) * 110), borderRadius: 10, backgroundColor: i === peak && v > 0 ? colors.accent : withAlpha(colors.accent, 0.28) }}
                  />
                ))}
              </Row>
              <Row gap={8}>
                {chart!.labels.map((l, i) => (
                  <T key={i} size={12} align="center" color={colors.textSecondary} style={{ flex: 1 }}>
                    {l}
                  </T>
                ))}
              </Row>
              <T mono size={12} color={colors.textSecondary}>
                {plays} {plays === 1 ? 'play' : 'plays'}
              </T>
            </View>
          </Glass>

          <SectionHeader title="When you listen" />
          <Glass padding={16}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
              {data.heat.map((v, c) => (
                <View
                  key={c}
                  accessibilityLabel={`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Math.floor(c / 12)]} ${(c % 12) * 2}:00`}
                  style={{ width: '7.4%', aspectRatio: 1, borderRadius: 4, backgroundColor: withAlpha(colors.accent, Number((0.08 + (v / heatMax) * 0.92).toFixed(2))) }}
                />
              ))}
            </View>
            <Row style={{ justifyContent: 'space-between', marginTop: 8 }}>
              <T mono size={12} color={colors.textSecondary}>
                12 AM
              </T>
              <T mono size={12} color={colors.textSecondary}>
                12 PM
              </T>
              <T mono size={12} color={colors.textSecondary}>
                11 PM
              </T>
            </Row>
          </Glass>

          {data.cur.top_artists?.length ? (
            <>
              <SectionHeader title="Top artists" />
              <Glass padding={16}>
                <View style={{ gap: 12 }}>
                  {data.cur.top_artists.map((a, i) => (
                    <Row key={`${a.name}-${i}`} gap={12}>
                      <T mono size={13} color={colors.textSecondary} style={{ width: 16 }}>
                        {i + 1}
                      </T>
                      <T size={14} weight={600} style={{ flex: 1 }} numberOfLines={1}>
                        {a.name ?? 'Unknown'}
                      </T>
                      <T mono size={12} color={colors.textSecondary}>
                        {a.plays} {Number(a.plays) === 1 ? 'play' : 'plays'}
                      </T>
                    </Row>
                  ))}
                </View>
              </Glass>
            </>
          ) : null}

          <SectionHeader title="Top genres" />
          <Glass padding={16}>
            <View style={{ gap: 12 }}>
              {genres.map((g) => (
                <Row key={g.name} gap={12}>
                  <T size={14} style={{ width: 72 }} numberOfLines={1}>
                    {g.name}
                  </T>
                  <ProgressBar value={g.pct / 100} height={8} color={g.color} style={{ flex: 1 }} />
                  <T mono size={12} color={colors.textSecondary}>
                    {g.pct}%
                  </T>
                </Row>
              ))}
            </View>
          </Glass>
        </>
      )}
    </Screen>
  );
}
