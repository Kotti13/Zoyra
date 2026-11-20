import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';

import { Button, Cover, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, useAsync } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { showDialog } from '../lib/dialog';
import {
  buildTempoMix,
  effectiveBpm,
  formatClock,
  formatKm,
  formatPace,
  orderByTempo,
  playlistTracks,
  saveWorkout,
  tempoByKey,
  useRunTracker,
  type RunSnapshot,
  type SensorState,
  type TempoQueue,
} from '../lib/workout';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import type { IconName } from '../components/icons';
import { colors, radius, withAlpha } from '../theme/tokens';

const CONTEXT = 'Run mode';

/** Live run: clock, GPS distance / pace, pedometer steps / cadence, tempo-matched music, pause / resume / end. */
export default function RunSession() {
  useKeepAwake('run-session');
  const params = useLocalSearchParams<{ tempo?: string; source?: string; playlist?: string; title?: string }>();
  const preset = tempoByKey(params.tempo);
  const source = params.source === 'liked' || params.source === 'playlist' ? params.source : 'mix';
  const { user } = useAuth();
  const { liked } = useLibrary();
  const player = usePlayerPick('track', 'playing', 'shuffle', 'context');
  const tracker = useRunTracker();

  // Build the queue once per source (liked songs are read when it loads, not on every library change).
  const queue = useAsync<TempoQueue>(async () => {
    if (source === 'liked') return orderByTempo(liked, preset.bpm);
    if (source === 'playlist' && params.playlist) return orderByTempo(await playlistTracks(params.playlist), preset.bpm);
    return buildTempoMix(preset.bpm);
  }, [source, params.playlist, preset.bpm, source === 'liked' && liked.length > 0]);

  const [startedQueue, setStartedQueue] = useState<TempoQueue | null>(null);
  const [playNote, setPlayNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState<RunSnapshot | null>(null);
  const played = useRef<CatalogTrack[]>([]);

  const active = tracker.status === 'running' || tracker.status === 'paused';

  // Songs that played while the run was active (for the summary).
  useEffect(() => {
    const t = player.track;
    if (!t || !active || player.context !== CONTEXT) return;
    if (!played.current.some((p) => p.id === t.id)) played.current.push(t);
  }, [player.track, player.context, active]);

  // Leaving mid-run would stop the sensors and lose the run: ask first.
  const { finish } = tracker;
  const allowLeave = usePreventRemove(active, ({ repeat }) => {
    void showDialog({
      title: 'Leave this run?',
      message: 'Your run is still going. End it with the End button to save it.',
      tone: 'danger',
      actions: [
        { label: 'Keep running', style: 'cancel' },
        { label: 'Discard run', style: 'destructive' },
      ],
    }).then((choice) => {
      if (choice !== 'Discard run') return;
      finish();
      repeat();
    });
  });

  const begin = () => {
    const q = queue.data;
    if (!q) return;
    if (q.tracks.length) {
      const res = player.playTracks(q.tracks, 0, CONTEXT);
      setPlayNote(res.reason ?? null);
    } else setPlayNote('No songs to play for this source. The run is still tracked.');
    setStartedQueue(q);
    void tracker.start();
  };

  const save = useCallback(
    async (snap: RunSnapshot) => {
      if (!user) {
        setSaveError('Sign in to save your run.');
        return;
      }
      setSaving(true);
      setSaveError(null);
      try {
        const id = await saveWorkout(user.id, {
          kind: preset.key === 'walk' ? 'walk' : 'run',
          started_at: snap.startedAt.toISOString(),
          ended_at: snap.endedAt.toISOString(),
          duration_seconds: Math.round(snap.elapsed),
          distance_m: Math.round(snap.meters),
          steps: tracker.pedometer === 'on' ? snap.steps : null,
          avg_cadence: snap.avgCadence,
          target_bpm: preset.bpm,
          tempo_label: preset.bpm ? `${preset.label} · ${preset.bpm}` : preset.label,
          playlist_id: source === 'playlist' ? params.playlist ?? null : null,
          playlist_title: source === 'playlist' ? params.title ?? null : source === 'liked' ? 'Liked songs' : 'Tempo mix',
          route: snap.route,
          tracks: played.current,
        });
        allowLeave();
        router.replace({ pathname: '/workout-summary', params: { id } });
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : 'Could not save your run.');
      } finally {
        setSaving(false);
      }
    },
    [user, preset, source, params.playlist, params.title, tracker.pedometer, allowLeave],
  );

  const end = () => {
    void showDialog({
      title: 'End run?',
      actions: [
        { label: 'Save run', style: 'primary' },
        { label: 'Discard', style: 'destructive' },
        { label: 'Keep running', style: 'cancel' },
      ],
    }).then((choice) => {
      if (choice === 'Discard') {
        tracker.finish();
        allowLeave();
        router.back();
      } else if (choice === 'Save run') {
        const snap = tracker.finish();
        setPending(snap);
        void save(snap);
      }
    });
  };

  /* ---------------------------------------------------------------- before start */

  if (tracker.status === 'idle') {
    return (
      <Screen backdrop={{ mesh: 'coral', pattern: 'dots', glows: [{ x: 0.74, y: 0.1, color: '#FDCB6E', opacity: 0.3 }, { x: 0.16, y: 0.4, color: '#FF6B81', opacity: 0.2 }] }}>
        <ScreenHeader title="Run session" />
        <View style={{ gap: 6 }}>
          <T variant="headlineLight" accessibilityRole="header">
            {preset.bpm ? `Smart tempo · ${preset.bpm} BPM` : 'Free run'}
          </T>
          <T size={14} color={colors.textSecondary} lineHeight={20}>
            {preset.hint}. Time, GPS distance and pace, and steps are measured on this phone while this screen is open. There is no heart-rate tracking.
          </T>
        </View>
        {queue.loading ? (
          <Loading label={preset.bpm ? 'Finding songs at your tempo' : 'Getting your music'} />
        ) : queue.error ? (
          <ErrorState message={queue.error} onRetry={queue.reload} />
        ) : queue.data ? (
          <QueuePreview q={queue.data} target={preset.bpm} />
        ) : null}
        <Button label="Start" icon="play" height={56} onPress={begin} variant={queue.data ? 'primary' : 'disabled'} />
      </Screen>
    );
  }

  /* ---------------------------------------------------------------- running / paused / saving */

  const s = tracker.stats;
  const q = startedQueue;
  const nowBpm = player.track && q ? q.bpms.get(player.track.id) : null;
  const nowEffective = nowBpm && preset.bpm ? Math.round(effectiveBpm(nowBpm, preset.bpm)) : null;
  const finished = tracker.status === 'finished';

  return (
    <Screen backdrop={{ mesh: 'coral', pattern: 'dots', glows: [{ x: 0.74, y: 0.1, color: '#FDCB6E', opacity: 0.3 }, { x: 0.16, y: 0.4, color: '#FF6B81', opacity: 0.2 }] }} gap={20}>
      <ScreenHeader title={tracker.status === 'paused' ? 'Paused' : finished ? 'Run ended' : 'Running'} back={finished ? 'back' : false} />

      <T size={14} weight={300}>
        Today
      </T>
      <Glass padding={16} radius={32}>
        <View style={{ gap: 4 }}>
          <T size={22} weight={500} align="center">
            Running
          </T>
          <View style={{ alignItems: 'center', paddingVertical: 8 }}>
            <T variant="displayLight" size={56} accessibilityLabel={`Duration ${formatClock(s.elapsed)}`} style={{ fontVariant: ['tabular-nums'] }}>
              {formatClock(s.elapsed)}
            </T>
            <T size={13}>Duration</T>
          </View>
          <Metric icon="pin" label="Distance" value={tracker.gps === 'on' ? formatKm(s.meters) : '--'} unit="km" />
          <Metric icon="bolt" label="Pace" value={tracker.gps === 'on' ? formatPace(s.pace) : '--'} unit="/km" />
          <Metric icon="chart" label="Steps" value={tracker.pedometer === 'on' ? String(s.steps) : '--'} />
          <Metric icon="heart" label="Cadence" value={tracker.pedometer === 'on' && s.cadence !== null ? String(s.cadence) : '--'} unit="spm" />
        </View>
      </Glass>

      <SensorNote gps={tracker.gps} pedometer={tracker.pedometer} />

      {preset.bpm ? (
        <Glass padding={14} radius={32}>
          <Row>
            <Icon name="bolt" size={20} color={colors.accentLight} />
            <View style={{ flex: 1, gap: 2 }}>
              <T variant="bodyStrong">Smart tempo · {preset.bpm} BPM</T>
              <T size={13} color={colors.textSecondary}>
                {q?.matchedBy === 'energy'
                  ? 'Few songs list a BPM near this tempo, so the rest were picked by energy.'
                  : s.cadence !== null && tracker.pedometer === 'on'
                    ? `Your cadence ${s.cadence} spm${Math.abs(s.cadence - preset.bpm) <= 5 ? ', right on the beat' : s.cadence < preset.bpm ? ', a little under the beat' : ', a little over the beat'}`
                    : 'Songs are ordered by how close their BPM is to your tempo.'}
              </T>
            </View>
          </Row>
        </Glass>
      ) : null}

      {/* Music */}
      <Glass padding={14}>
        {player.track ? (
          <View style={{ gap: 12 }}>
            <Row>
              <Cover artwork={player.track.artwork} id={player.track.id} size={56} radius={radius.sm} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant="bodyStrong" numberOfLines={1}>
                  {player.track.title}
                </T>
                <T variant="small" color={colors.textSecondary} numberOfLines={1}>
                  {player.track.artist.name}
                  {nowBpm ? ` · ${Math.round(nowBpm)} BPM${nowEffective && nowEffective !== Math.round(nowBpm) ? ` (${nowEffective} feel)` : ''}` : ''}
                </T>
              </View>
            </Row>
            <Row style={{ justifyContent: 'center' }} gap={24}>
              <IconButton icon="prev" label="Previous song" onPress={player.previous} />
              <IconButton icon={player.playing ? 'pause' : 'play'} label={player.playing ? 'Pause music' : 'Play music'} onPress={player.toggle} size={56} bg={colors.accent} color={colors.white} />
              <IconButton icon="next" label="Next song" onPress={player.next} />
            </Row>
            {player.shuffle && player.context === CONTEXT ? (
              <Row gap={8}>
                <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
                  Shuffle is on, so songs won&apos;t play closest-tempo first.
                </T>
                <Button label="Turn off" variant="glass" height={36} onPress={() => player.setShuffle(false)} />
              </Row>
            ) : null}
          </View>
        ) : (
          <T size={14} color={colors.textSecondary}>
            {playNote ?? 'No music playing.'}
          </T>
        )}
      </Glass>
      {playNote && player.track ? (
        <T size={13} color={colors.textSecondary}>
          {playNote}
        </T>
      ) : null}

      {saveError ? (
        <Glass padding={14} radius={32}>
          <View style={{ gap: 10 }}>
            <T size={14} color={colors.error}>
              Couldn&apos;t save your run: {saveError}
            </T>
            <Row gap={8}>
              <Button label="Try again" height={44} style={{ flex: 1 }} onPress={() => pending && void save(pending)} />
              <Button label="Discard" variant="destructive" height={44} style={{ flex: 1 }} onPress={() => router.back()} />
            </Row>
          </View>
        </Glass>
      ) : null}

      {finished ? (
        saving ? <Loading label="Saving your run" height={60} /> : null
      ) : (
        <Row gap={12}>
          {tracker.status === 'paused' ? (
            <Button label="Resume" icon="play" height={56} style={{ flex: 1 }} onPress={tracker.resume} />
          ) : (
            <Button label="Pause" icon="pause" variant="glass" height={56} style={{ flex: 1 }} onPress={tracker.pause} />
          )}
          <Button label="End" variant="destructive" height={56} style={{ flex: 1 }} onPress={end} />
        </Row>
      )}
    </Screen>
  );
}

function Metric({ icon, label, value, unit }: { icon: IconName; label: string; value: string; unit?: string }) {
  return (
    <Row
      gap={12}
      style={{ paddingVertical: 12, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: colors.divider }}
      accessible
      accessibilityLabel={`${label}: ${value === '--' ? 'not available' : `${value}${unit ? ` ${unit}` : ''}`}`}
    >
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: withAlpha(colors.white, 0.12), alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={18} />
      </View>
      <T size={14} style={{ flex: 1 }}>
        {label}
      </T>
      <T size={18} weight={300} style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </T>
      <T size={11} color={colors.textSecondary} style={{ width: 32 }}>
        {value !== '--' ? unit : ''}
      </T>
    </Row>
  );
}

function SensorNote({ gps, pedometer }: { gps: SensorState; pedometer: SensorState }) {
  const notes: string[] = [];
  if (gps === 'denied') notes.push('Location is off for Zoyra, so distance, pace and route aren’t measured.');
  if (gps === 'unavailable') notes.push('Location services are unavailable, so distance and pace aren’t measured.');
  if (pedometer === 'denied') notes.push('Motion access is off, so steps and cadence aren’t counted.');
  if (pedometer === 'unavailable') notes.push('This device has no step counter, so steps and cadence aren’t shown.');
  if (!notes.length) return null;
  const canFix = gps === 'denied' || pedometer === 'denied';
  return (
    <Glass padding={12} radius={radius.md}>
      <View style={{ gap: 8 }}>
        {notes.map((n) => (
          <T key={n} size={13} color={colors.textSecondary} lineHeight={18}>
            {n}
          </T>
        ))}
        {canFix ? <Button label="Open Settings" variant="glass" height={40} onPress={() => void Linking.openSettings()} /> : null}
      </View>
    </Glass>
  );
}

function QueuePreview({ q, target }: { q: TempoQueue; target: number | null }) {
  if (!q.tracks.length) {
    return (
      <T size={14} color={colors.textSecondary}>
        No playable songs found for this choice. You can still start: the run is tracked without music.
      </T>
    );
  }
  const note =
    q.matchedBy === 'bpm'
      ? `${q.matched} ${q.matched === 1 ? 'song is' : 'songs are'} within 7 BPM of your tempo (half- or double-time included).`
      : q.matchedBy === 'energy'
        ? `Only ${q.matched} ${q.matched === 1 ? 'song lists' : 'songs list'} a BPM near your tempo, so the rest were picked by energy (mood and genre), not BPM.`
        : 'Playing in order.';
  return (
    <View style={{ gap: 10 }}>
      <T size={13} color={colors.textSecondary} lineHeight={18}>
        {note}
      </T>
      <Glass padding={8}>
        {q.tracks.slice(0, 5).map((t, i) => {
          const b = q.bpms.get(t.id);
          return (
            <Row key={t.id} style={[{ minHeight: 56, paddingHorizontal: 6 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <Cover artwork={t.artwork} id={t.id} size={40} radius={radius.xs} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={15} weight={500} numberOfLines={1}>
                  {t.title}
                </T>
                <T size={13} color={colors.textSecondary} numberOfLines={1}>
                  {t.artist.name}
                </T>
              </View>
              <T mono size={12} color={b ? colors.accentLight : colors.textTertiary}>
                {b ? `${Math.round(b)} BPM${target && Math.round(effectiveBpm(b, target)) > Math.round(b) ? ' · half-time' : target && Math.round(effectiveBpm(b, target)) < Math.round(b) ? ' · double-time' : ''}` : 'no BPM'}
              </T>
            </Row>
          );
        })}
      </Glass>
      {q.tracks.length > 5 ? (
        <T size={13} color={colors.textSecondary}>
          + {q.tracks.length - 5} more
        </T>
      ) : null}
    </View>
  );
}
