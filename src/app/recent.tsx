import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { ChipRow, EmptyState, ErrorState, IconButton, Loading, MiniPlayer, Screen, ScreenHeader, T, Toast, TrackItem, useAsync } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Play = { id: number; track: CatalogTrack; played_at: string };

const RANGES = ['Today', '7 days', '30 days', 'All time'];

function sinceFor(range: number): string | null {
  const now = new Date();
  if (range === 0) return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  if (range === 1) return new Date(Date.now() - 7 * 864e5).toISOString();
  if (range === 2) return new Date(Date.now() - 30 * 864e5).toISOString();
  return null;
}

function dayLabel(d: Date) {
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 864e5);
  if (diff === 0) return 'TODAY';
  if (diff === 1) return 'YESTERDAY';
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }).toUpperCase();
}

export default function Recent() {
  const { user } = useAuth();
  const [range, setRange] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const history = useAsync(async () => {
    if (!user) return [] as Play[];
    let q = supabase.from('play_history').select('id, track, played_at').eq('user_id', user.id).order('played_at', { ascending: false }).limit(500);
    const since = sinceFor(range);
    if (since) q = q.gte('played_at', since);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []) as Play[];
  }, [user?.id, range]);

  // New plays (from this or another device) show up live.
  useEffect(() => {
    if (!user) return;
    const ch = supabase
      .channel(`recent:${user.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'play_history', filter: `user_id=eq.${user.id}` }, () => history.reload())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const groups = useMemo(() => {
    const out: { label: string; plays: Play[]; tracks: CatalogTrack[] }[] = [];
    for (const p of history.data ?? []) {
      const label = dayLabel(new Date(p.played_at));
      let g = out[out.length - 1];
      if (!g || g.label !== label) out.push((g = { label, plays: [], tracks: [] }));
      g.plays.push(p);
      g.tracks.push(p.track);
    }
    return out;
  }, [history.data]);

  const clear = async () => {
    setConfirm(false);
    if (!user) return;
    const { error } = await supabase.from('play_history').delete().eq('user_id', user.id);
    setMsg(error ? error.message : 'Listening history cleared');
    history.reload();
  };

  return (
    <Screen onRefresh={history.refresh} backdrop={{ pattern: 'dots', mesh: 'rose' }} top={4} gap={20} bottom={16} footer={<MiniPlayer />}>
      <ScreenHeader title="Recently played" right={<IconButton icon="trash" label="Clear history" onPress={() => (setMsg(null), setConfirm(true))} />} />

      {confirm ? <Toast icon="trash" iconColor={colors.like} message="Clear your whole listening history? This also resets insights." action="Clear" onAction={() => void clear()} /> : null}
      {msg && !confirm ? <Toast message={msg} /> : null}

      <ChipRow options={RANGES} onChange={setRange} />

      {!user ? (
        <EmptyState icon="clock" title="Sign in to see your history" action="Sign in" href="/login" />
      ) : history.loading && !history.data ? (
        <Loading label="Loading history" />
      ) : history.error ? (
        <ErrorState message={history.error} onRetry={history.reload} />
      ) : groups.length === 0 ? (
        <EmptyState icon="clock" title="No listening history" body={range === 0 ? 'Nothing played today yet.' : 'Songs you play will show up here.'} action="Find music" href="/search" />
      ) : (
        groups.map((g) => (
          <View key={g.label}>
            <T size={12} weight={600} tracking={0.5} color={colors.textSecondary} style={{ marginBottom: 4 }} accessibilityRole="header">
              {g.label}
            </T>
            {g.plays.map((p) => (
              <TrackItem
                key={p.id}
                track={p.track}
                list={g.tracks}
                context="recent"
                showDuration={false}
                right={
                  <T mono size={12} color={colors.textSecondary}>
                    {new Date(p.played_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </T>
                }
              />
            ))}
          </View>
        ))
      )}
    </Screen>
  );
}
