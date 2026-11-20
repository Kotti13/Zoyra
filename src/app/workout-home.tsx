import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { Art, Button, Chip, EmptyState, ErrorState, Glass, Icon, IconTile, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Tap, go, useAsync } from '../components';
import { formatClock, formatKm, formatPace, avgPace, listWorkouts, TEMPOS, weeklyStats, type WorkoutSummaryRow } from '../lib/workout';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors, withAlpha } from '../theme/tokens';

type Source = { kind: 'mix' } | { kind: 'liked' } | { kind: 'playlist'; id: string; title: string };

const sourceKey = (s: Source) => (s.kind === 'playlist' ? `pl:${s.id}` : s.kind);

const runDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

/** Run mode home: pick a tempo and the music, start a run, and see past runs (all from the `workouts` table). */
export default function WorkoutHome() {
  const { user, profile } = useAuth();
  const { liked, playlists } = useLibrary();
  const [tempo, setTempo] = useState('run');
  const [source, setSource] = useState<Source>({ kind: 'mix' });

  const runs = useAsync(() => (user ? listWorkouts(user.id, 60) : Promise.resolve([] as WorkoutSummaryRow[])), [user?.id], 'app/workout-home:23');
  const week = useMemo(() => weeklyStats(runs.data ?? []), [runs.data]);
  const monthRuns = useMemo(() => {
    const now = new Date();
    return (runs.data ?? []).filter((r) => {
      const d = new Date(r.started_at);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
  }, [runs.data]);

  const preset = TEMPOS.find((t) => t.key === tempo) ?? TEMPOS[2];
  const firstName = profile?.display_name?.split(' ')[0];
  const ownPlaylists = playlists.filter((p) => (p.track_count ?? 0) > 0).slice(0, 8);

  const start = () => {
    const params: Record<string, string> = { tempo, source: source.kind };
    if (source.kind === 'playlist') {
      params.playlist = source.id;
      params.title = source.title;
    }
    go({ pathname: '/run-session', params });
  };

  const sources: { s: Source; title: string; subtitle: string; icon: 'bolt' | 'heart' | 'music' }[] = [
    { s: { kind: 'mix' }, title: 'Tempo mix', subtitle: preset.bpm ? `Catalogue tracks near ${preset.bpm} BPM` : 'Energetic picks from the catalogue', icon: 'bolt' },
    ...(liked.length ? [{ s: { kind: 'liked' } as Source, title: 'Liked songs', subtitle: `${liked.length} songs${preset.bpm ? ', closest tempo first' : ''}`, icon: 'heart' as const }] : []),
    ...ownPlaylists.map((p) => ({
      s: { kind: 'playlist', id: p.id, title: p.title } as Source,
      title: p.title,
      subtitle: `${p.track_count} songs${preset.bpm ? ', closest tempo first' : ''}`,
      icon: 'music' as const,
    })),
  ];

  return (
    <Screen onRefresh={user ? runs.refresh : undefined}
      backdrop={{ mesh: 'coral', pattern: 'dots', glows: [{ x: 1, y: 0, color: '#00B894', opacity: 0.32 }, { x: 0, y: 0.45, color: colors.orange, opacity: 0.16 }] }}
      footer={
        <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
          <Button label="Start run" icon="play" onPress={start} height={54} />
        </View>
      }
    >
      <ScreenHeader title="Run mode" />

      <View style={{ gap: 4 }}>
        <T size={15} weight={300}>
          {firstName ? `Hi ${firstName},` : 'Hi,'}
        </T>
        <T size={34} weight={300} tracking={-1} accessibilityRole="header">
          Welcome!
        </T>
      </View>

      <T size={26} weight={300}>
        My sound
      </T>

      {/* Weekly stats: real totals from saved runs. */}
      <Glass padding={16} radius={36}>
        <View style={{ gap: 14 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={15} weight={600}>Weekly stats</T>
            {week.streak > 0 ? (
              <Row gap={6}>
                <Icon name="flame" size={16} color={colors.orange} />
                <T size={13} color={colors.textSecondary}>
                  {week.streak}-day streak
                </T>
              </Row>
            ) : null}
          </Row>
          {runs.loading && !runs.data ? (
            <Loading height={60} label="Loading your runs" />
          ) : (
            <Row style={{ justifyContent: 'space-between' }}>
              <Stat value={formatKm(week.meters)} unit="km" label="Distance" />
              <Stat value={String(week.runs)} label={week.runs === 1 ? 'Run' : 'Runs'} />
              <Stat value={formatClock(week.seconds)} label="Time" />
              <Stat value={formatPace(avgPace(week.seconds, week.meters))} label="Avg pace" />
            </Row>
          )}
          {monthRuns > 0 ? (
            <T size={13} color={colors.textSecondary}>
              {monthRuns} {monthRuns === 1 ? 'session' : 'sessions'} completed this month
            </T>
          ) : null}
        </View>
      </Glass>

      <View style={{ gap: 10 }}>
        <T size={15} weight={500}>Active session</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
          {TEMPOS.map((t) => (
            <Chip key={t.key} label={t.bpm ? `${t.label} · ${t.bpm}` : t.label} active={t.key === tempo} onPress={() => setTempo(t.key)} />
          ))}
        </View>
        <T size={13} color={colors.textSecondary} lineHeight={18}>
          {preset.hint}. Songs are matched on the BPM the catalogue reports (half- and double-time count too); songs without a BPM play after the matched ones.
        </T>
      </View>

      <View style={{ gap: 10 }}>
        <T size={15} weight={500}>Music</T>
        <Glass padding={4} radius={36}>
          {sources.map(({ s, title, subtitle, icon }, i) => {
            const on = sourceKey(s) === sourceKey(source);
            return (
              <Tap
                key={sourceKey(s)}
                onPress={() => setSource(s)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${title}. ${subtitle}`}
                style={[{ minHeight: 64, paddingHorizontal: 12, justifyContent: 'center' }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
              >
                <Row>
                  <IconTile icon={icon} size={40} color={on ? colors.accent : colors.textSecondary} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={16} weight={500} numberOfLines={1}>
                      {title}
                    </T>
                    <T variant="small" color={colors.textSecondary} numberOfLines={1}>
                      {subtitle}
                    </T>
                  </View>
                  {on ? <Icon name="checkBold" size={20} color={colors.accentLight} /> : null}
                </Row>
              </Tap>
            );
          })}
        </Glass>
      </View>

      <View style={{ gap: 10 }}>
        <SectionHeader title="Previous sessions" action={runs.data?.length ? 'View all' : undefined} href={runs.data?.length ? { pathname: '/workout-summary', params: { id: runs.data[0].id } } : undefined} />
        {runs.error ? (
          <ErrorState message={runs.error} onRetry={runs.reload} />
        ) : runs.loading && !runs.data ? null : !runs.data?.length ? (
          <EmptyState icon="clock" title="No runs yet" body="Your runs are saved here with distance, pace and the songs that played." />
        ) : (
          <View style={{ gap: 8 }}>
            {runs.data.slice(0, 20).map((r) => (
              <RunRow key={r.id} r={r} />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <View style={{ gap: 2 }} accessible accessibilityLabel={`${label}: ${value}${unit ? ` ${unit}` : ''}`}>
      <Row gap={3} align="flex-end">
        <T size={20} weight={600}>
          {value}
        </T>
        {unit ? (
          <T size={12} color={colors.textSecondary} style={{ marginBottom: 2 }}>
            {unit}
          </T>
        ) : null}
      </Row>
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
}

function RunRow({ r }: { r: WorkoutSummaryRow }) {
  const pace = formatPace(avgPace(r.duration_seconds, r.distance_m));
  const label = `${runDate(r.started_at)}: ${formatKm(r.distance_m)} kilometres in ${formatClock(r.duration_seconds)}`;
  return (
    <Tap href={{ pathname: '/workout-summary', params: { id: r.id } }} accessibilityLabel={label}>
      <Glass padding={10} radius={36}>
        <Row>
          <Art art="green" size={52} radius={26} style={{ alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="bolt" size={20} color={colors.white} />
          </Art>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="bodyStrong" numberOfLines={1}>
              {formatKm(r.distance_m)} km · {formatClock(r.duration_seconds)}
            </T>
            <T variant="small" color={colors.textSecondary} numberOfLines={1}>
              {runDate(r.started_at)}
              {pace !== '--' ? ` · ${pace} /km` : ''}
              {r.avg_cadence ? ` · ${r.avg_cadence} spm` : ''}
            </T>
          </View>
          {r.tempo_label ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: withAlpha(colors.accent, 0.16) }}>
              <T size={11} weight={600} color={colors.accentLight}>
                {r.tempo_label}
              </T>
            </View>
          ) : null}
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </Row>
      </Glass>
    </Tap>
  );
}
