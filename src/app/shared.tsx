import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { Button, ErrorState, Loading, Screen, ScreenHeader, T, useAsync } from '../components';
import { supabase } from '../lib/supabase';
import { colors, withAlpha } from '../theme/tokens';

type Row = { kind: string; payload: Record<string, unknown>; owner_name: string | null; owner_username: string | null };

const TITLES: Record<string, string> = { w: 'Shared run', m: 'Taste match', i: 'Listening stats', d: 'Taste DNA', b: 'Badges' };

/** Opens a stats share link (`/s/<token>` → `/shared?token=`) inside the app: shows what was shared and where to go next. */
export default function Shared() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const q = useAsync<Row | null>(async () => {
    if (!token) return null;
    const { data, error } = await supabase.rpc('share_snapshot_card', { tok: token });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    return row ?? null;
  }, [token]);

  const r = q.data;
  const p = r?.payload ?? {};
  const who = r?.owner_name ?? 'A Zoyra listener';
  const lines: string[] = [];
  if (r?.kind === 'w') {
    lines.push(`${((Number(p.dist) || 0) / 1000).toFixed(2)} km in ${Math.floor((Number(p.dur) || 0) / 60)} min`);
    if (Array.isArray(p.songs)) lines.push(...(p.songs as string[]));
  } else if (r?.kind === 'm') {
    lines.push(`${Number(p.pct) || 0}% match between ${String(p.me ?? '')} and ${String(p.you ?? '')}`);
    if (Array.isArray(p.artists)) lines.push(...(p.artists as string[]));
  } else if (r?.kind === 'i') {
    lines.push(`${Number(p.min) || 0} min · ${Number(p.plays) || 0} plays this ${String(p.per ?? 'week')}`);
    if (Array.isArray(p.artists)) lines.push(...(p.artists as string[]));
  } else if (r?.kind === 'd') {
    /* genres below */
  } else if (r?.kind === 'b') {
    lines.push(`${Number(p.got) || 0} of ${Number(p.total) || 0} unlocked`);
    if (Array.isArray(p.names)) lines.push(...(p.names as string[]));
  }
  if (Array.isArray(p.genres)) lines.push(...(p.genres as { n: string; p: number }[]).map((g) => `${g.n} ${g.p}%`));

  return (
    <Screen backdrop={{ mesh: 'coral', pattern: 'none' }}>
      <ScreenHeader title={r ? TITLES[r.kind] ?? 'Shared' : 'Shared'} />
      {q.loading ? (
        <Loading label="Opening shared link" />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !r ? (
        <ErrorState message="This shared link was removed or is wrong." />
      ) : (
        <View style={{ gap: 12 }}>
          <T variant="section">{who}</T>
          {lines.map((l, i) => (
            <View key={`${i}-${l}`} style={{ padding: 14, borderRadius: 18, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.1) }}>
              <T size={15}>{l}</T>
            </View>
          ))}
          {r.owner_username ? <Button label={`View ${who}’s profile`} variant="secondary" onPress={() => router.push({ pathname: '/public-profile', params: { username: r.owner_username! } })} /> : null}
          <Button label="Go to Home" onPress={() => router.replace('/')} />
        </View>
      )}
    </Screen>
  );
}
