import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';

import { Button, ChipRow, Cover, EmptyState, ErrorState, Glass, IconButton, Loading, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, T, Tap, useAsync } from '../components';
import { formatDuration } from '../lib/catalog';
import {
  accuracyOf,
  buildChart,
  GOOD_WINDOW,
  judge,
  LANES,
  LEAD,
  loadBeatTracks,
  multiplierFor,
  personalBests,
  POINTS,
  roundLength,
  saveScore,
  type BeatTrack,
  type Judgement,
  type Note,
} from '../lib/games';
import { useAuth } from '../state/auth';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const GENRES = ['All', 'Electronic', 'Hip-Hop/Rap', 'Pop', 'House', 'Techno', 'Latin'];
const LANE_COLORS = [colors.red, colors.orange, colors.accentLight, colors.gold];
const NOTE_H = 34;
/** Height of the tap pads area under the hit line. */
const PAD_ZONE = 90;

type Stats = { score: number; combo: number; maxCombo: number; perfect: number; good: number; miss: number };
const EMPTY: Stats = { score: 0, combo: 0, maxCombo: 0, perfect: 0, good: 0, miss: 0 };

function reducer(s: Stats, a: { type: 'hit'; j: Exclude<Judgement, 'miss'> } | { type: 'miss' }): Stats {
  if (a.type === 'miss') return { ...s, combo: 0, miss: s.miss + 1 };
  const combo = s.combo + 1;
  return {
    ...s,
    score: s.score + POINTS[a.j] * multiplierFor(s.combo),
    combo,
    maxCombo: Math.max(s.maxCombo, combo),
    perfect: s.perfect + (a.j === 'perfect' ? 1 : 0),
    good: s.good + (a.j === 'good' ? 1 : 0),
  };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/* ------------------------------------------------------------------ screen */

type Phase = { kind: 'pick' } | { kind: 'play'; pick: BeatTrack; run: number } | { kind: 'done'; pick: BeatTrack; stats: Stats; run: number };

export default function BeatGame() {
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [run, setRun] = useState(0);

  const start = (pick: BeatTrack) => {
    setRun((r) => r + 1);
    setPhase({ kind: 'play', pick, run: run + 1 });
  };

  if (phase.kind === 'play') {
    return <Game key={phase.run} pick={phase.pick} onQuit={() => setPhase({ kind: 'pick' })} onDone={(stats) => setPhase({ kind: 'done', pick: phase.pick, stats, run: phase.run })} />;
  }
  if (phase.kind === 'done') {
    return <Results key={phase.run} pick={phase.pick} stats={phase.stats} onAgain={() => start(phase.pick)} onPick={() => setPhase({ kind: 'pick' })} />;
  }
  return <Picker onStart={start} />;
}

/* ------------------------------------------------------------------ pick a song */

function Picker({ onStart }: { onStart: (p: BeatTrack) => void }) {
  const [genre, setGenre] = useState(0);
  const list = useAsync(() => loadBeatTracks(genre === 0 ? undefined : GENRES[genre]), [genre]);

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Beat Rush
        </T>
        <T size={15} color={colors.textSecondary} lineHeight={21}>
          Notes fall to the beat. Tap the matching pad as each one hits the line.
        </T>
      </View>

      <ChipRow options={GENRES} onChange={setGenre} />

      <SectionHeader title="Pick a song" />
      {list.loading && !list.data ? (
        <Loading label="Finding songs with a known tempo" height={320} />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !list.data?.length ? (
        <EmptyState icon="music" title="No songs with a known tempo" body="Audius doesn’t list a BPM for these songs. Try another genre." action="Try again" onAction={list.reload} />
      ) : (
        <Glass padding={4}>
          {list.data.slice(0, 25).map((p, i) => (
            <Tap key={p.track.id} onPress={() => onStart(p)} accessibilityLabel={`Play ${p.track.title} by ${p.track.artist.name}, ${Math.round(p.bpm)} BPM`}>
              <Row gap={12} style={[{ minHeight: 64, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                <Cover artwork={p.track.artwork} id={p.track.id} size={44} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={15} weight={500} numberOfLines={1}>
                    {p.track.title}
                  </T>
                  <T size={13} color={colors.textSecondary} numberOfLines={1}>
                    {p.track.artist.name}
                  </T>
                </View>
                <T mono size={12} color={colors.gold}>
                  {Math.round(p.bpm)} BPM
                </T>
              </Row>
            </Tap>
          ))}
        </Glass>
      )}

      <T size={12} color={colors.textSecondary} align="center" lineHeight={16}>
        Beats are placed from each song’s BPM as reported by Audius. Audius doesn’t say where the first beat lands, so the sync is approximate. Rounds last up to 90 seconds.
      </T>
    </Screen>
  );
}

/* ------------------------------------------------------------------ the game */

function FallingNote({ note, clock, hitY, color }: { note: Note; clock: Animated.Value; hitY: number; color: string }) {
  const translateY = useMemo(
    () => clock.interpolate({ inputRange: [note.time - LEAD, note.time], outputRange: [-NOTE_H, hitY - NOTE_H / 2], extrapolate: 'extend' }),
    [clock, note.time, hitY],
  );
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 0,
        left: `${(note.lane / LANES) * 100 + 2}%`,
        width: `${100 / LANES - 4}%`,
        height: NOTE_H,
        borderRadius: NOTE_H / 2,
        backgroundColor: color,
        shadowColor: color,
        shadowOpacity: 0.8,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 0 },
        transform: [{ translateY }],
      }}
    />
  );
}

function Game({ pick, onQuit, onDone }: { pick: BeatTrack; onQuit: () => void; onDone: (s: Stats) => void }) {
  const { playTrack, playing, pause, play, track: current, rate } = usePlayerPick('track', 'playing', 'rate');
  const { position } = usePlaybackProgress();
  const notes = useMemo(() => buildChart(pick.track.id, pick.bpm, pick.track.duration), [pick]);
  const end = roundLength(pick.track.duration);

  const [clock] = useState(() => new Animated.Value(0));
  const [flash] = useState(() => new Animated.Value(0));
  const [pads] = useState(() => Array.from({ length: LANES }, () => new Animated.Value(0)));
  const anchor = useRef({ pos: 0, at: 0, rate: 1, running: false });
  const judged = useRef(new Set<number>());
  const missCursor = useRef(0);
  const begun = useRef(false);

  const [stats, dispatch] = useReducer(reducer, EMPTY);
  const [now, setNow] = useState(0);
  const [hits, setHits] = useState<ReadonlySet<number>>(() => new Set());
  const [label, setLabel] = useState<{ text: string; color: string } | null>(null);
  const [boardH, setBoardH] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);

  const isOurs = current?.id === pick.track.id;

  // Start the song once (playTrack's identity changes with player state).
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    const r = playTrack(pick.track, 'Beat Rush');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!r.played) setStartError(r.reason ?? 'This song can’t be played right now.');
  }, [playTrack, pick]);

  /** Current song position, smoothed between player status updates. */
  const gameNow = useCallback(() => {
    const a = anchor.current;
    return a.running ? a.pos + ((performance.now() - a.at) / 1000) * a.rate : a.pos;
  }, []);

  // Keep the native falling-note clock in step with the real playback position.
  useEffect(() => {
    if (!isOurs || finished) return;
    const a = anchor.current;
    if (!playing) {
      if (a.running) {
        a.pos = gameNow();
        a.running = false;
        clock.stopAnimation();
        clock.setValue(a.pos);
      }
      return;
    }
    if (position <= 0 && !a.running) return;
    // A replay of the same song can briefly report the old position before it restarts from 0:00.
    if (!begun.current && position > 2) return;
    if (!begun.current) {
      begun.current = true;
      setStarted(true);
    }
    const drift = a.running ? Math.abs(gameNow() - position) : Infinity;
    if (drift > 0.12 || a.rate !== rate) {
      a.pos = position;
      a.at = performance.now();
      a.rate = rate || 1;
      a.running = true;
      clock.stopAnimation();
      clock.setValue(position);
      const target = end + LEAD;
      Animated.timing(clock, { toValue: target, duration: Math.max(1, ((target - position) / a.rate) * 1000), easing: Easing.linear, useNativeDriver: true }).start();
    }
  }, [position, playing, rate, isOurs, finished, clock, end, gameNow]);

  // Game loop (JS side): misses, the visible window, and the end of the round.
  useEffect(() => {
    if (!started || finished) return;
    const id = setInterval(() => {
      const t = gameNow();
      setNow(t);
      while (missCursor.current < notes.length && notes[missCursor.current].time < t - GOOD_WINDOW) {
        const n = notes[missCursor.current++];
        if (!judged.current.has(n.id)) {
          judged.current.add(n.id);
          dispatch({ type: 'miss' });
        }
      }
      if (t >= end) setFinished(true);
    }, 50);
    return () => clearInterval(id);
  }, [started, finished, notes, end, gameNow]);

  // The song stopped being ours (skipped, or ended) after the game started: end the round there.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (started && !isOurs) setFinished(true);
  }, [started, isOurs]);

  useEffect(() => {
    if (!finished) return;
    clock.stopAnimation();
    pause();
    onDone(stats);
    // Only when the round finishes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const showJudgement = (text: string, color: string) => {
    setLabel({ text, color });
    flash.stopAnimation();
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 520, delay: 120, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  };

  const tap = (lane: number) => {
    pads[lane].setValue(1);
    Animated.timing(pads[lane], { toValue: 0, duration: 220, useNativeDriver: true }).start();
    if (!started || !playing) return;
    const t = gameNow();
    let best: Note | null = null;
    for (let i = missCursor.current; i < notes.length; i++) {
      const n = notes[i];
      if (n.time > t + GOOD_WINDOW) break;
      if (n.lane !== lane || judged.current.has(n.id)) continue;
      if (!best || Math.abs(n.time - t) < Math.abs(best.time - t)) best = n;
    }
    if (!best) return;
    const j = judge(best.time - t);
    if (!j || j === 'miss') return;
    judged.current.add(best.id);
    const id = best.id;
    setHits((h) => new Set(h).add(id));
    dispatch({ type: 'hit', j });
    showJudgement(j === 'perfect' ? 'PERFECT' : 'GOOD', j === 'perfect' ? colors.gold : colors.accentLight);
  };

  // A miss resets the combo: flash it.
  const prevMiss = useRef(0);
  useEffect(() => {
    if (stats.miss > prevMiss.current) {
      prevMiss.current = stats.miss;
      setLabel({ text: 'MISS', color: colors.textSecondary });
      flash.stopAnimation();
      flash.setValue(1);
      Animated.timing(flash, { toValue: 0, duration: 420, useNativeDriver: true }).start();
    }
  }, [stats.miss, flash]);

  const hitY = Math.max(0, boardH - PAD_ZONE);
  const visible = notes.filter((n) => !hits.has(n.id) && n.time > now - 0.4 && n.time < now + LEAD + 0.2);
  const mult = multiplierFor(stats.combo);

  if (startError) {
    return (
      <Screen top={4} backdrop={{ pattern: 'none' }}>
        <ScreenHeader title="Beat Rush" back={false} />
        <ErrorState message={startError} />
        <Button label="Pick another song" variant="glass" onPress={onQuit} />
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={12} scroll={false} stagger={false} backdrop={{ pattern: 'none' }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Resume'} bg={withAlpha(colors.white, 0.1)} onPress={() => (playing ? pause() : play())} />
        <View style={{ alignItems: 'center' }} accessibilityLabel={`Score ${stats.score}`}>
          <T size={11} color={colors.textSecondary} tracking={1}>
            SCORE
          </T>
          <T size={44} weight={200} tracking={-1.5} lineHeight={48}>
            {fmt(stats.score)}
          </T>
        </View>
        <View
          accessibilityLabel={`Combo ${stats.combo}, multiplier ${mult}`}
          style={{ height: 38, minWidth: 54, paddingHorizontal: 14, borderRadius: 19, backgroundColor: withAlpha(colors.gold, 0.16), alignItems: 'center', justifyContent: 'center' }}
        >
          <T weight={700} color={colors.gold}>
            x{mult}
          </T>
        </View>
      </Row>

      <View
        onLayout={(e) => setBoardH(e.nativeEvent.layout.height)}
        style={{ flex: 1, borderRadius: 32, overflow: 'hidden', backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder }}
      >
        {[1, 2, 3].map((i) => (
          <View key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(i / LANES) * 100}%`, width: 1, backgroundColor: withAlpha(colors.white, 0.08) }} />
        ))}

        {boardH > 0 ? visible.map((n) => <FallingNote key={n.id} note={n} clock={clock} hitY={hitY} color={LANE_COLORS[n.lane]} />) : null}

        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: hitY - 1.5, height: 3, backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.9, shadowRadius: 12, shadowOffset: { width: 0, height: 0 } }} />

        {label ? (
          <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: hitY - 56, alignItems: 'center', opacity: flash, transform: [{ scale: flash.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.08] }) }] }}>
            <T size={22} weight={800} tracking={1} color={label.color} accessibilityLiveRegion="polite">
              {label.text}
            </T>
          </Animated.View>
        ) : null}

        {stats.combo >= 5 ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 14, left: 0, right: 0, alignItems: 'center' }}>
            <T size={13} weight={600} color={colors.textSecondary}>
              {stats.combo} combo
            </T>
          </View>
        ) : null}

        {!started ? (
          <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: PAD_ZONE, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <T size={22} weight={300}>
              Get ready…
            </T>
            <T size={13} color={colors.textSecondary}>
              Starting the song
            </T>
          </View>
        ) : !playing && !finished ? (
          <View style={{ position: 'absolute', top: 0, bottom: PAD_ZONE, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: withAlpha(colors.bg, 0.6) }}>
            <T size={26} weight={300}>
              Paused
            </T>
            <Button label="Resume" icon="play" onPress={play} />
            <Button
              label="Quit round"
              variant="glass"
              onPress={() => {
                clock.stopAnimation();
                onQuit();
              }}
            />
          </View>
        ) : null}

        <View style={{ position: 'absolute', left: 10, right: 10, bottom: 12, flexDirection: 'row', gap: 10 }}>
          {pads.map((v, lane) => (
            <Pressable
              key={lane}
              onPressIn={() => tap(lane)}
              accessibilityRole="button"
              accessibilityLabel={`Lane ${lane + 1}`}
              style={{ flex: 1, height: 64, borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(colors.white, 0.2), backgroundColor: withAlpha(LANE_COLORS[lane], 0.2) }}
            >
              <Animated.View style={{ flex: 1, backgroundColor: LANE_COLORS[lane], opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }) }} />
            </Pressable>
          ))}
        </View>
      </View>

      <Row gap={12}>
        <T size={12} color={colors.textSecondary} numberOfLines={1} style={{ maxWidth: '45%' }}>
          {pick.track.title}
        </T>
        <View style={{ flex: 1 }}>
          <ProgressBar value={Math.min(1, now / end)} height={4} />
        </View>
        <T mono size={12} color={colors.textSecondary}>
          {formatDuration(Math.max(0, end - now))}
        </T>
      </Row>
      <T size={11} color={colors.textTertiary} align="center">
        {Math.round(pick.bpm)} BPM from Audius · sync is approximate
      </T>
    </Screen>
  );
}

/* ------------------------------------------------------------------ results */

function Results({ pick, stats, onAgain, onPick }: { pick: BeatTrack; stats: Stats; onAgain: () => void; onPick: () => void }) {
  const { user } = useAuth();
  const accuracy = accuracyOf(stats);
  const judgedAny = stats.perfect + stats.good + stats.miss > 0;
  const save = useAsync(async () => {
    if (!user || !judgedAny) return null;
    const prev = await personalBests(user.id);
    await saveScore({ game: 'beat', score: stats.score, accuracy, maxCombo: stats.maxCombo, perfect: stats.perfect, good: stats.good, miss: stats.miss, track: pick.track });
    return { prevBest: prev.beat?.score ?? null };
  }, [user?.id]);
  const newBest = !!save.data && (save.data.prevBest === null || stats.score > save.data.prevBest);

  const tiles = [
    { label: 'Accuracy', value: `${Math.round(accuracy * 100)}%` },
    { label: 'Max combo', value: String(stats.maxCombo) },
    { label: 'Perfect', value: String(stats.perfect) },
    { label: 'Good', value: String(stats.good) },
    { label: 'Miss', value: String(stats.miss) },
  ];

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="Round complete" />
      <View style={{ alignItems: 'center', gap: 4 }}>
        <T size={11} color={colors.textSecondary} tracking={1}>
          SCORE
        </T>
        <T size={64} weight={200} tracking={-2}>
          {fmt(stats.score)}
        </T>
        <T size={13} color={colors.textSecondary} numberOfLines={1}>
          {pick.track.title} · {pick.track.artist.name}
        </T>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {tiles.map((t) => (
          <Glass key={t.label} padding={14} style={{ flexGrow: 1, flexBasis: '30%' }}>
            <T size={22} weight={300}>
              {t.value}
            </T>
            <T size={12} color={colors.textSecondary}>
              {t.label}
            </T>
          </Glass>
        ))}
      </View>

      {!user ? (
        <T size={13} color={colors.textSecondary} align="center">
          Sign in to save your scores.
        </T>
      ) : !judgedAny ? (
        <T size={13} color={colors.textSecondary} align="center">
          No notes were played, so nothing was saved.
        </T>
      ) : save.loading ? (
        <T size={13} color={colors.textSecondary} align="center">
          Saving your score…
        </T>
      ) : save.error ? (
        <ErrorState message={save.error} onRetry={save.reload} />
      ) : (
        <T size={14} weight={600} color={newBest ? colors.gold : colors.textSecondary} align="center">
          {newBest ? 'New personal best!' : `Saved · your best is ${fmt(save.data?.prevBest ?? 0)}`}
        </T>
      )}

      <Button label="Play again" icon="repeat" onPress={onAgain} />
      <Button label="Pick another song" variant="glass" onPress={onPick} />
      <Button label="Done" variant="secondary" href="back" />
    </Screen>
  );
}
