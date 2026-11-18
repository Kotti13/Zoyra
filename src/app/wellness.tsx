import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';

import { Button, Chip, ChipRow, ErrorState, Glass, Icon, ListRow, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Toast, Toggle, TrackItem, useAsync, useReduceMotion, EmptyState } from '../components';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { usePlayerPick, type SleepTimer } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

type SessionKey = 'sleep' | 'focus' | 'meditate' | 'nature';
type Session = { key: SessionKey; label: string; title: string; body: string; queries: { q: string; genre?: string }[]; minutes: number };

/** Each session is built from live Audius searches. */
const SESSIONS: Session[] = [
  { key: 'sleep', label: 'Sleep', title: 'Drift off', body: 'Soft ambient music that fades out when the timer ends.', queries: [{ q: 'sleep', genre: 'Ambient' }, { q: 'ambient sleep' }, { q: 'sleep music' }], minutes: 30 },
  { key: 'focus', label: 'Focus', title: 'Deep focus', body: 'Lo-fi and calm beats for work or study.', queries: [{ q: 'lofi study' }, { q: 'focus', genre: 'Lo-Fi' }, { q: 'lofi beats' }], minutes: 45 },
  { key: 'meditate', label: 'Meditate', title: 'Meditation', body: 'Slow, spacious music for a quiet mind.', queries: [{ q: 'meditation' }, { q: 'calm', genre: 'Ambient' }, { q: 'healing' }], minutes: 15 },
  { key: 'nature', label: 'Nature', title: 'Rain and nature', body: 'Rain, ocean and field recordings.', queries: [{ q: 'rain sounds' }, { q: 'rain', genre: 'Ambient' }, { q: 'ocean waves' }, { q: 'nature sounds' }], minutes: 30 },
];

const TABS = ['Sleep', 'Focus', 'Meditate', 'Nature', 'Breathe'] as const;
const DURATIONS = [15, 30, 45, 60, 90];
const BREATH_MINUTES = [1, 3, 5];
const IN_MS = 4000;
const OUT_MS = 6000;

async function loadSession(s: Session): Promise<CatalogTrack[]> {
  const lists = await Promise.all(s.queries.map((x) => catalog.searchTracks(x.q, { genre: x.genre, limit: 25 }).catch(() => [] as CatalogTrack[])));
  const seen = new Set<string>();
  // Long, calm pieces first; drop very short clips.
  return lists
    .flat()
    .filter((t) => t.duration >= 90 && (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .slice(0, 40);
}

/** Seconds left on the sleep timer, ticking each second. */
function useRemaining(sleep: SleepTimer) {
  const [now, setNow] = useState(() => Date.now());
  const timed = !!sleep && 'endsAt' in sleep;
  useEffect(() => {
    if (!timed) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timed]);
  return sleep && 'endsAt' in sleep ? Math.max(0, (sleep.endsAt - now) / 1000) : null;
}

/* ------------------------------------------------------------------ breathing */

function Breathing() {
  const reduce = useReduceMotion();
  const [minutes, setMinutes] = useState(1);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const [now, setNow] = useState(() => Date.now());
  const [scale] = useState(() => new Animated.Value(0.6));

  useEffect(() => {
    if (!endsAt) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const step = (p: 'in' | 'out') => {
      if (!alive) return;
      if (Date.now() >= endsAt) {
        setEndsAt(null);
        setPhase('in');
        return;
      }
      setPhase(p);
      const ms = p === 'in' ? IN_MS : OUT_MS;
      if (!reduce) Animated.timing(scale, { toValue: p === 'in' ? 1 : 0.6, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }).start();
      timer = setTimeout(() => step(p === 'in' ? 'out' : 'in'), ms);
    };
    timer = setTimeout(() => step('in'), 0);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(tick);
      scale.stopAnimation();
      Animated.timing(scale, { toValue: 0.6, duration: 300, useNativeDriver: true }).start();
    };
  }, [endsAt, reduce, scale]);

  const left = endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : null;
  const running = endsAt !== null;

  return (
    <Glass padding={22} radius={32}>
      <View style={{ alignItems: 'center', gap: 14 }}>
        <View style={{ width: 170, height: 170, alignItems: 'center', justifyContent: 'center' }} accessibilityLiveRegion="polite" accessibilityLabel={running ? (phase === 'in' ? 'Breathe in' : 'Breathe out') : 'Breathing exercise'}>
          <Animated.View
            style={{
              position: 'absolute',
              width: 170,
              height: 170,
              borderRadius: 85,
              backgroundColor: withAlpha(colors.accent, 0.35),
              borderWidth: 1.5,
              borderColor: withAlpha(colors.white, 0.3),
              transform: [{ scale }],
            }}
          />
          <T size={17} weight={600}>
            {running ? (phase === 'in' ? 'Breathe in' : 'Breathe out') : 'Ready'}
          </T>
          {left !== null ? (
            <T mono size={12} color={colors.textSecondary}>
              {formatDuration(left)}
            </T>
          ) : null}
        </View>
        <T size={13} color={colors.textSecondary}>
          4 seconds in · 6 seconds out
        </T>
        {!running ? (
          <Row gap={8}>
            {BREATH_MINUTES.map((m) => (
              <Chip key={m} label={`${m} min`} active={m === minutes} onPress={() => setMinutes(m)} />
            ))}
          </Row>
        ) : null}
        <Button
          label={running ? 'Stop' : `Start ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`}
          icon={running ? 'close' : 'play'}
          variant={running ? 'glass' : 'primary'}
          onPress={() => {
            setNow(Date.now());
            setEndsAt(running ? null : Date.now() + minutes * 60_000);
          }}
          style={{ alignSelf: 'stretch' }}
        />
      </View>
    </Glass>
  );
}

/* ------------------------------------------------------------------ sessions */

function SessionView({ s }: { s: Session }) {
  const { playTracks, setSleepTimer, setSleepFade, sleep, context } = usePlayerPick('context', 'sleep');
  const res = useAsync(() => loadSession(s), [s.key]);
  const [minutes, setMinutes] = useState(s.minutes);
  const [fade, setFade] = useState(true);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const remaining = useRemaining(sleep);
  const ctx = `wellness:${s.key}`;
  const tracks = res.data ?? [];

  const start = () => {
    if (!tracks.length) return;
    const r = playTracks(tracks, 0, ctx);
    if (!r.played) return setNote({ ok: false, text: r.reason ?? 'Could not start the session.' });
    setSleepTimer(minutes, { fadeOut: fade });
    setNote({ ok: true, text: `${s.title} started. Music stops in ${minutes} minutes.` });
  };

  return (
    <>
      <Glass padding={18} radius={32}>
        <View style={{ gap: 12 }}>
          <View style={{ gap: 4 }}>
            <T size={24} weight={300} tracking={-0.6}>
              {s.title}
            </T>
            <T size={14} color={colors.textSecondary}>
              {s.body}
            </T>
          </View>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            {DURATIONS.map((m) => (
              <Chip key={m} label={`${m} min`} active={m === minutes} onPress={() => setMinutes(m)} />
            ))}
          </Row>
          <Button label={res.loading ? 'Finding music…' : `Start ${minutes}-minute session`} icon="play" variant={res.loading || !tracks.length ? 'disabled' : 'primary'} onPress={res.loading ? undefined : start} />
        </View>
      </Glass>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.accentLight} message={note.text} /> : null}

      <SectionHeader title="Sleep timer" />
      <Glass padding={4}>
        <ListRow
          icon="moon"
          title="Fade out at the end"
          subtitle="Lower the volume over the last 30 seconds"
          right={
            <Toggle
              label="Fade out at the end"
              value={sleep ? sleep.fadeOut !== false : fade}
              onChange={(v) => {
                setFade(v);
                if (sleep) setSleepFade(v);
              }}
            />
          }
        />
        <ListRow
          divider
          icon="clock"
          title="Sleep timer"
          subtitle={remaining !== null ? `Stops in ${formatDuration(remaining)}${context === ctx ? ` · ${s.title}` : ''}` : sleep && 'endOfTrack' in sleep ? 'Stops after this song' : 'Off'}
          href="/sleep-sheet"
        />
        {sleep ? <ListRow divider icon="close" title="Cancel the timer" subtitle="Keep the music playing" onPress={() => setSleepTimer(null)} right={false} /> : null}
      </Glass>

      <SectionHeader title="In this session" />
      {res.loading ? (
        <Loading label="Finding calm music" />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !tracks.length ? (
        <EmptyState icon="music" title="Nothing found right now" body="The catalogue search came back empty. Try again in a moment." />
      ) : (
        <View>
          {tracks.slice(0, 12).map((t) => (
            <TrackItem key={t.id} track={t} list={tracks} context={ctx} />
          ))}
        </View>
      )}
    </>
  );
}

export default function Wellness() {
  const [tab, setTab] = useState(0);
  const key = TABS[tab];
  const session = SESSIONS.find((s) => s.label === key);

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Wind down
        </T>
        <T size={15} color={colors.textSecondary}>
          Sleep, focus, meditation and breathing
        </T>
      </View>
      <ChipRow options={[...TABS]} initial={0} onChange={setTab} />
      {session ? <SessionView key={session.key} s={session} /> : <Breathing />}
      {!session ? (
        <Row gap={10} style={{ paddingHorizontal: 4 }}>
          <Icon name="info" size={16} color={colors.textSecondary} />
          <T size={12} color={colors.textSecondary} style={{ flex: 1 }}>
            A simple paced-breathing guide. It isn’t medical advice.
          </T>
        </Row>
      ) : null}
    </Screen>
  );
}
