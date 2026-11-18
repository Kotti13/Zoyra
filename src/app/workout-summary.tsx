import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Polyline } from 'react-native-svg';

import { Button, ErrorState, Glass, IconButton, Loading, Row, Screen, ScreenHeader, SectionHeader, T, TrackItem, useAsync } from '../components';
import { confirmDialog } from '../lib/dialog';
import {
  avgPace,
  deleteWorkout,
  fetchBpms,
  formatClock,
  formatKm,
  formatPace,
  getWorkout,
  listWorkouts,
  type LatLng,
  type Workout,
  type WorkoutSummaryRow,
} from '../lib/workout';
import { shareSnapshot } from '../lib/share-snapshots';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors, radius, withAlpha } from '../theme/tokens';

const longDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });

/** Run summary from the `workouts` row: totals, GPS route snapshot, last runs, the songs that played, save as playlist, share. */
export default function WorkoutSummary() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { user, profile } = useAuth();
  const me = { id: user?.id, username: profile?.username };
  const w = useAsync(() => (id ? getWorkout(id) : Promise.reject(new Error('This run could not be found.'))), [id]);
  const recent = useAsync(() => (user ? listWorkouts(user.id, 7) : Promise.resolve([] as WorkoutSummaryRow[])), [user?.id]);

  return (
    <Screen backdrop={{ mesh: 'coral', pattern: 'none' }}>
      <ScreenHeader title="Run summary" right={w.data ? <IconButton icon="share" label="Share run" onPress={() => void shareRun(w.data!, me)} /> : undefined} />
      {w.loading ? (
        <Loading label="Loading your run" />
      ) : w.error || !w.data ? (
        <ErrorState message={w.error ?? 'This run could not be found.'} onRetry={w.reload} />
      ) : (
        <Body w={w.data} recent={recent.data ?? []} />
      )}
    </Screen>
  );
}

async function shareRun(w: Workout, me: { id?: string; username?: string | null }) {
  const pace = formatPace(avgPace(w.duration_seconds, w.distance_m));
  const parts = [`${formatKm(w.distance_m)} km`, formatClock(w.duration_seconds)];
  if (pace !== '--') parts.push(`${pace} /km`);
  if (w.steps) parts.push(`${w.steps.toLocaleString()} steps`);
  const songs = w.tracks.slice(0, 3).map((t) => `${t.title} by ${t.artist.name}`);
  const msg = `My run with Zoyra: ${parts.join(' · ')}${songs.length ? `\nSoundtrack: ${songs.join(', ')}` : ''}`;
  await shareSnapshot({
    kind: 'w',
    payload: { dist: Math.round(w.distance_m), dur: Math.round(w.duration_seconds), steps: w.steps, wk: w.kind, tempo: w.tempo_label, on: w.started_at.slice(0, 10), songs: w.tracks.slice(0, 5).map((t) => `${t.title} by ${t.artist.name}`) },
    title: 'My run on Zoyra',
    message: msg,
    me,
  }).catch(() => undefined);
}

function Body({ w, recent }: { w: Workout; recent: WorkoutSummaryRow[] }) {
  const { user: authUser, profile: myProfile } = useAuth();
  const me = { id: authUser?.id, username: myProfile?.username };
  const { createPlaylist, addToPlaylist } = useLibrary();
  const [busy, setBusy] = useState<'playlist' | 'delete' | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const bpms = useAsync(() => fetchBpms(w.tracks.map((t) => t.id)), [w.id]);
  const pace = formatPace(avgPace(w.duration_seconds, w.distance_m));

  const saveAsPlaylist = async () => {
    if (!w.tracks.length) return;
    setBusy('playlist');
    setNote(null);
    try {
      const day = new Date(w.started_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const pl = await createPlaylist({
        title: `Run · ${day}${w.tempo_label ? ` · ${w.tempo_label}` : ''}`.slice(0, 100),
        description: `${formatKm(w.distance_m)} km in ${formatClock(w.duration_seconds)} with Zoyra Run mode`,
        visibility: 'private',
      });
      await addToPlaylist(pl.id, w.tracks);
      router.push({ pathname: '/playlist', params: { id: pl.id } });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not create the playlist.', error: true });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog('Delete this run?', 'It will be removed from your run history.', 'Delete'))) return;
    setBusy('delete');
    setNote(null);
    try {
      await deleteWorkout(w.id);
      router.back();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not delete the run.', error: true });
      setBusy(null);
    }
  };

  return (
    <>
      <View style={{ gap: 6 }}>
        <T variant="headlineLight" accessibilityRole="header">
          Run complete
        </T>
        <T size={14} color={colors.textSecondary}>
          {longDate(w.started_at)}
          {w.playlist_title ? ` · ${w.playlist_title}` : ''}
        </T>
      </View>

      <View style={{ gap: 2 }} accessible accessibilityLabel={`${formatKm(w.distance_m)} kilometres`}>
        <Row gap={6} align="flex-end">
          <T variant="displayLight" size={64}>
            {formatKm(w.distance_m)}
          </T>
          <T size={20} color={colors.textSecondary} style={{ marginBottom: 12 }}>
            km
          </T>
        </Row>
      </View>

      <Glass padding={16}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 16 }}>
          <Stat label="Time" value={formatClock(w.duration_seconds)} />
          <Stat label="Avg pace" value={pace === '--' ? '--' : `${pace} /km`} />
          <Stat label="Steps" value={w.steps !== null ? w.steps.toLocaleString() : '--'} />
          <Stat label="Avg cadence" value={w.avg_cadence ? `${w.avg_cadence} spm` : '--'} />
          {w.target_bpm ? <Stat label="Target tempo" value={`${w.target_bpm} BPM`} /> : null}
        </View>
      </Glass>

      <View style={{ gap: 10 }}>
        <SectionHeader title="Route" />
        <RouteSnapshot route={w.route} />
      </View>

      {recent.length > 1 ? (
        <View style={{ gap: 10 }}>
          <SectionHeader title="Last runs" />
          <LastRuns runs={recent} current={w.id} />
        </View>
      ) : null}

      <View style={{ gap: 10 }}>
        <SectionHeader title="Soundtrack that carried you" />
        {!w.tracks.length ? (
          <T size={14} color={colors.textSecondary}>
            No catalogue songs played during this run.
          </T>
        ) : (
          <View>
            {w.tracks.map((t, i) => {
              const b = bpms.data?.get(t.id);
              return (
                <TrackItem key={t.id} track={t} list={w.tracks} index={i} subtitle={b ? `${t.artist.name} · ${Math.round(b)} BPM` : undefined} />
              );
            })}
          </View>
        )}
      </View>

      {note ? (
        <T size={14} color={note.error ? colors.error : colors.success}>
          {note.text}
        </T>
      ) : null}

      <View style={{ gap: 12 }}>
        {w.tracks.length ? (
          <Button label={busy === 'playlist' ? 'Saving…' : 'Save as playlist'} icon="plus" onPress={() => void saveAsPlaylist()} variant={busy ? 'disabled' : 'primary'} />
        ) : null}
        <Button label="Share run" icon="share" variant="glass" onPress={() => void shareRun(w, me)} />
        <Button label={busy === 'delete' ? 'Deleting…' : 'Delete run'} variant={busy ? 'disabled' : 'destructive'} onPress={remove} />
      </View>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ width: '50%', gap: 2 }} accessible accessibilityLabel={`${label}: ${value === '--' ? 'not recorded' : value}`}>
      <T size={20} weight={600}>
        {value}
      </T>
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
}

/** GPS route drawn as an SVG polyline, fitted to the card (equirectangular projection, fine at run scale). */
function RouteSnapshot({ route }: { route: LatLng[] }) {
  const [width, setWidth] = useState(0);
  const height = 200;
  const pad = 16;
  const pts = useMemo(() => {
    if (route.length < 2 || !width) return null;
    const lat0 = route.reduce((s, p) => s + p[0], 0) / route.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xy = route.map(([lat, lng]) => [lng * k, -lat] as const);
    const xs = xy.map((p) => p[0]);
    const ys = xy.map((p) => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const spanX = Math.max(...xs) - minX || 1e-9;
    const spanY = Math.max(...ys) - minY || 1e-9;
    const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
    const offX = (width - spanX * scale) / 2;
    const offY = (height - spanY * scale) / 2;
    return xy.map(([x, y]) => [offX + (x - minX) * scale, offY + (y - minY) * scale] as const);
  }, [route, width]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  if (route.length < 2) {
    return (
      <Glass padding={16} radius={radius.md}>
        <T size={14} color={colors.textSecondary}>
          No route was recorded for this run (location was off, or the GPS signal wasn&apos;t good enough).
        </T>
      </Glass>
    );
  }
  return (
    <Glass radius={radius.md}>
      <View style={{ height }} onLayout={onLayout} accessible accessibilityLabel={`Route map with ${route.length} GPS points`}>
        {pts ? (
          <Svg width={width} height={height}>
            <Polyline points={pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} fill="none" stroke={withAlpha(colors.accent, 0.35)} strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" />
            <Polyline points={pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')} fill="none" stroke={colors.accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
            <Circle cx={pts[0][0]} cy={pts[0][1]} r={6} fill={colors.success} stroke={colors.white} strokeWidth={2} />
            <Circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={6} fill={colors.accent} stroke={colors.white} strokeWidth={2} />
          </Svg>
        ) : null}
      </View>
    </Glass>
  );
}

/** Distance of the last (up to) 7 runs, oldest left; this run highlighted. */
function LastRuns({ runs, current }: { runs: WorkoutSummaryRow[]; current: string }) {
  const list = [...runs].slice(0, 7).reverse();
  const max = Math.max(...list.map((r) => r.distance_m), 1);
  return (
    <Glass padding={16}>
      <Row align="flex-end" gap={8} style={{ height: 120 }}>
        {list.map((r) => {
          const on = r.id === current;
          const h = Math.max(4, (r.distance_m / max) * 88);
          return (
            <View key={r.id} style={{ flex: 1, alignItems: 'center', gap: 6 }} accessible accessibilityLabel={`${new Date(r.started_at).toLocaleDateString()}: ${formatKm(r.distance_m)} km`}>
              <T size={10} color={on ? colors.text : colors.textSecondary}>
                {formatKm(r.distance_m)}
              </T>
              <View style={{ width: '70%', height: h, borderRadius: 6, backgroundColor: on ? colors.accent : withAlpha(colors.white, 0.14) }} />
            </View>
          );
        })}
      </Row>
    </Glass>
  );
}
