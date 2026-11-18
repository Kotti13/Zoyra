import { useState } from 'react';
import { View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, Icon, Loading, Row, Screen, ScreenHeader, Segmented, Sticker, T, useAsync } from '../components';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Entry = { user_id: string; display_name: string; avatar_url: string | null; xp: number };

const PODIUM_STYLE: Record<number, { size: number; height: number; color: string }> = {
  1: { size: 64, height: 100, color: colors.amber },
  2: { size: 52, height: 70, color: colors.accentLight },
  3: { size: 52, height: 52, color: colors.peach },
};

function Face({ e, size }: { e: Entry; size: number }) {
  return (
    <Cover uri={e.avatar_url} id={e.user_id} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {e.avatar_url ? null : (
        <T size={Math.round(size * 0.33)} weight={600} color={colors.white}>
          {(e.display_name || '?').charAt(0).toUpperCase()}
        </T>
      )}
    </Cover>
  );
}

export default function Leaderboard() {
  const { user, profile } = useAuth();
  const [period, setPeriod] = useState(0);

  const q = useAsync(async (): Promise<Entry[]> => {
    if (!user) return [];
    if (period === 0) {
      const { data, error } = await supabase.rpc('weekly_leaderboard');
      if (error) throw new Error(error.message);
      return ((data ?? []) as Entry[]).map((e) => ({ ...e, xp: Number(e.xp) || 0 }));
    }
    // Month / all time: only your own history is readable for totals, so this ranks just you.
    let req = supabase.from('play_history').select('seconds_listened').eq('user_id', user.id).limit(50000);
    if (period === 1) {
      const now = new Date();
      req = req.gte('played_at', new Date(now.getFullYear(), now.getMonth(), 1).toISOString());
    }
    const { data, error } = await req;
    if (error) throw new Error(error.message);
    const secs = ((data ?? []) as { seconds_listened: number }[]).reduce((n, r) => n + (r.seconds_listened || 0), 0);
    return [{ user_id: user.id, display_name: profile?.display_name ?? 'You', avatar_url: profile?.avatar_url ?? null, xp: Math.floor(secs / 60) }];
  }, [user?.id, period]);

  const list = q.data ?? [];
  const ranked = list.map((e, i) => ({ ...e, rank: i + 1 }));
  const podium = [ranked[1], ranked[0], ranked[2]].filter((e): e is (typeof ranked)[number] => !!e);
  const rest = ranked.slice(3);

  return (
    <Screen onRefresh={q.refresh} top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'amberRose' }}>
      <ScreenHeader title="Leaderboard" />

      <Segmented options={['Week', 'Month', 'All time']} onChange={setPeriod} />

      {!user ? (
        <EmptyState icon="users" title="Sign in to compete with friends" action="Sign in" href="/login" />
      ) : q.loading && !q.data ? (
        <Loading label="Loading leaderboard" height={240} />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : (
        <>
          {/* Podium */}
          <Row gap={10} align="flex-end" style={{ paddingTop: 20 }}>
            {podium.map((p) => {
              const st = PODIUM_STYLE[p.rank];
              return (
                <View key={p.user_id} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                  <View>
                    <Face e={p} size={st.size} />
                    {p.rank === 1 ? (
                      <View style={{ position: 'absolute', top: -18, left: '50%', marginLeft: -12 }}>
                        <Icon name="trophy" size={24} color={colors.amber} filled />
                      </View>
                    ) : null}
                  </View>
                  <T size={14} weight={600} numberOfLines={1}>
                    {p.user_id === user.id ? 'You' : p.display_name}
                  </T>
                  <T mono size={12} color={colors.textSecondary}>
                    {p.xp.toLocaleString()} XP
                  </T>
                  <View
                    accessibilityLabel={`Rank ${p.rank}`}
                    style={{ width: '100%', height: st.height, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: st.color, alignItems: 'center', paddingTop: 8 }}
                  >
                    <T size={22} weight={700} color={colors.onAccent}>
                      {p.rank}
                    </T>
                  </View>
                </View>
              );
            })}
          </Row>

          {/* Ranks 4+ */}
          {rest.length > 0 ? (
            <Glass padding={4}>
              {rest.map((r, i) => (
                <Row key={r.user_id} gap={12} style={[{ minHeight: 64 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                  <Face e={r} size={44} />
                  <T mono size={16} color={colors.textSecondary} align="center" style={{ width: 24 }}>
                    {r.rank}
                  </T>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={16} weight={500} numberOfLines={1}>
                      {r.user_id === user.id ? 'You' : r.display_name}
                    </T>
                    <T size={14} color={colors.textSecondary}>
                      {r.xp.toLocaleString()} XP
                    </T>
                  </View>
                  {r.user_id === user.id ? <Sticker label="YOU" rotate={3} style={{ alignSelf: 'center', marginRight: 8 }} /> : null}
                </Row>
              ))}
            </Glass>
          ) : null}

          {period === 0 && list.length <= 1 ? (
            <EmptyState icon="users" title="Bring your friends" body="Follow people to see how your listening stacks up this week." action="Find friends" href="/friends" />
          ) : null}

          <T size={12} color={colors.textSecondary} align="center">
            {period === 0
              ? '1 XP per minute listened · resets every Monday'
              : 'Monthly and all-time boards only show your own XP for now — friends’ totals stay private.'}
          </T>
        </>
      )}
    </Screen>
  );
}
