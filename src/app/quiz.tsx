import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { saveScore } from '../lib/games';

import { Button, EmptyState, ErrorState, Glass, Icon, Loading, ProgressBar, Row, Screen, ScreenHeader, Sticker, T, Tap, useAsync } from '../components';
import { catalog, type CatalogTrack } from '../lib/catalog';
import { usePlayerPick } from '../state/player';
import { colors, shadow, withAlpha } from '../theme/tokens';

const snippet = [19, 26, 30, 59, 39, 50, 20, 40, 56, 41, 61, 58, 33, 16, 52, 22, 16, 51, 56, 56, 61, 25, 19, 21, 62, 21, 23, 16, 18, 17, 32, 23];
const ROUNDS = 10;
const SECONDS = 15;

type Round = { answer: CatalogTrack; options: string[]; correct: number };

function shuffle<T>(l: T[]) {
  const a = [...l];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildRounds(pool: CatalogTrack[]): Round[] {
  const byTitle = new Map<string, CatalogTrack>();
  pool.forEach((t) => !byTitle.has(t.title.toLowerCase()) && byTitle.set(t.title.toLowerCase(), t));
  const unique = shuffle([...byTitle.values()]);
  if (unique.length < 4) return [];
  return unique.slice(0, Math.min(ROUNDS, unique.length)).map((answer) => {
    const wrong = shuffle(unique.filter((t) => t.id !== answer.id))
      .slice(0, 3)
      .map((t) => t.title);
    const options = shuffle([answer.title, ...wrong]);
    return { answer, options, correct: options.indexOf(answer.title) };
  });
}

/** Ring timer: accent fill around a dark centre. */
function Timer({ fraction, label }: { fraction: number; label: string }) {
  const size = 64;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`${label} left`}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.track} strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.accent} strokeWidth={stroke} fill="none" strokeDasharray={`${c * fraction} ${c}`} />
      </Svg>
      <View style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: colors.bgSecondary, alignItems: 'center', justifyContent: 'center' }}>
        <T mono weight={500} size={18}>
          {label}
        </T>
      </View>
    </View>
  );
}

export default function Quiz() {
  const { playTrack, toggle, track: current, playing } = usePlayerPick('track', 'playing');
  const pool = useAsync(() => catalog.trending({ limit: 50 }), []);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [n, setN] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [left, setLeft] = useState(SECONDS);
  const [started, setStarted] = useState(false);
  const [score, setScore] = useState({ points: 0, correct: 0, streak: 0, best: 0 });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const newGame = useCallback(() => {
    setRounds(buildRounds(pool.data ?? []));
    setN(0);
    setPicked(null);
    setTimedOut(false);
    setLeft(SECONDS);
    setStarted(false);
    setScore({ points: 0, correct: 0, streak: 0, best: 0 });
  }, [pool.data]);

  useEffect(() => {
    if (pool.data) newGame();
  }, [pool.data, newGame]);

  const round = rounds[n];
  const answered = picked !== null || timedOut;
  const finished = rounds.length > 0 && n >= rounds.length;
  // Save the finished game once (Games hub shows the "Song guess" best). Signed-out / offline saves fail quietly.
  const savedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!finished || savedFor.current === rounds.length + score.points) return;
    savedFor.current = rounds.length + score.points;
    saveScore({
      game: 'quiz',
      score: score.points,
      accuracy: rounds.length ? score.correct / rounds.length : 0,
      maxCombo: score.best,
      perfect: score.correct,
      good: 0,
      miss: rounds.length - score.correct,
    }).catch(() => undefined);
  }, [finished, rounds.length, score]);

  // Countdown while the snippet is live and unanswered.
  useEffect(() => {
    if (!started || answered) return;
    timer.current = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [started, answered, n]);

  useEffect(() => {
    if (started && !answered && left === 0) {
      setTimedOut(true);
      setScore((s) => ({ ...s, streak: 0 }));
    }
  }, [left, started, answered]);

  const playSnippet = () => {
    if (!round) return;
    if (current?.id === round.answer.id) {
      toggle();
    } else {
      playTrack(round.answer, 'Music quiz', { hideMetadata: true });
    }
    setStarted(true);
  };

  const pick = (i: number) => {
    if (!round || answered) return;
    setPicked(i);
    if (!started) setStarted(true);
    if (i === round.correct) {
      setScore((s) => {
        const streak = s.streak + 1;
        return { points: s.points + 100 + left * 10, correct: s.correct + 1, streak, best: Math.max(s.best, streak) };
      });
    } else setScore((s) => ({ ...s, streak: 0 }));
  };

  const next = () => {
    setN((x) => x + 1);
    setPicked(null);
    setTimedOut(false);
    setLeft(SECONDS);
    setStarted(false);
  };

  const played = useMemo(() => Math.round(((SECONDS - left) / SECONDS) * snippet.length), [left]);
  const stats = [
    { value: String(score.points), label: 'Points' },
    { value: `${score.correct}/${Math.min(n + (answered ? 1 : 0), rounds.length)}`, label: 'Correct' },
    { value: `x${score.streak}`, label: 'Streak' },
  ];

  if (pool.loading && !pool.data) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'rose' }}>
        <ScreenHeader title="Song guess" />
        <Loading label="Picking songs" />
      </Screen>
    );
  }
  if (pool.error || (pool.data && rounds.length === 0)) {
    return (
      <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'rose' }}>
        <ScreenHeader title="Song guess" />
        {pool.error ? <ErrorState message={pool.error} onRetry={pool.reload} /> : <EmptyState title="Not enough songs for a quiz" body="Try again in a moment." action="Retry" onAction={pool.reload} />}
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'rose' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Song guess" right={score.streak >= 2 ? <Sticker label={`${score.streak} in a row`} rotate={4} /> : undefined} />

      {finished ? (
        <Glass radius={26} padding={20}>
          <View style={{ gap: 14, alignItems: 'center', paddingVertical: 12 }}>
            <Icon name="trophy" size={40} color={colors.amber} />
            <T size={22} weight={700} align="center" accessibilityRole="header">
              {score.correct} of {rounds.length} correct
            </T>
            <T size={15} color={colors.textSecondary} align="center">
              {score.points} points · best streak x{score.best}
            </T>
            <Button label="Play again" icon="repeat" onPress={newGame} />
          </View>
        </Glass>
      ) : round ? (
        <>
          <Row gap={16}>
            <View style={{ flex: 1, gap: 8 }}>
              <T size={12} weight={600} tracking={0.5} color={colors.textSecondary}>
                QUESTION {n + 1} OF {rounds.length}
              </T>
              <ProgressBar value={(n + (answered ? 1 : 0)) / rounds.length} height={8} />
            </View>
            <Timer fraction={left / SECONDS} label={`0:${String(left).padStart(2, '0')}`} />
          </Row>

          <Glass radius={26} padding={20}>
            <View style={{ gap: 14, alignItems: 'center', paddingVertical: 12 }}>
              <T size={22} weight={700} align="center" lineHeight={28} accessibilityRole="header">
                {answered ? (timedOut && picked === null ? 'Time is up!' : picked === round.correct ? 'Correct!' : 'Not quite') : `Name this song in ${SECONDS} seconds`}
              </T>
              {answered ? (
                <T size={14} color={colors.textSecondary} align="center">
                  {round.answer.title} by {round.answer.artist.name}
                </T>
              ) : null}
              <Row gap={3} style={{ height: 64, alignSelf: 'stretch' }}>
                {snippet.map((h, i) => (
                  <View key={i} style={{ flex: 1, height: h, borderRadius: 2, backgroundColor: i < played ? colors.accent : colors.trackLight }} />
                ))}
              </Row>
              <Tap
                accessibilityLabel={current?.id === round.answer.id && playing ? 'Pause snippet' : 'Play snippet'}
                onPress={playSnippet}
                style={[{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }, shadow.sticker]}
              >
                <Icon name={current?.id === round.answer.id && playing ? 'pause' : 'play'} size={28} color={colors.onAccent} />
              </Tap>
            </View>
          </Glass>

          <View style={{ gap: 10 }}>
            {round.options.map((o, i) => {
              const on = picked === i;
              const right = answered && i === round.correct;
              const wrong = on && i !== round.correct;
              return (
                <Tap
                  key={`${n}-${i}`}
                  accessibilityState={{ selected: on, disabled: answered }}
                  onPress={() => pick(i)}
                  style={{
                    height: 56,
                    borderRadius: 36,
                    borderWidth: 2,
                    borderColor: right ? colors.success : wrong ? colors.error : colors.border,
                    backgroundColor: on ? withAlpha(colors.amber, 0.18) : colors.bgTertiary,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingHorizontal: 20,
                    gap: 8,
                  }}
                >
                  <T size={16} weight={600} numberOfLines={1} style={{ flex: 1 }}>
                    {o}
                  </T>
                  {right ? <Icon name="check" size={22} color={colors.success} /> : wrong ? <Icon name="close" size={22} color={colors.error} /> : null}
                </Tap>
              );
            })}
          </View>

          {answered ? <Button label={n + 1 >= rounds.length ? 'See results' : 'Next song'} onPress={next} /> : null}
        </>
      ) : null}

      <View style={{ flex: 1 }} />

      <Glass radius={26} padding={12}>
        <Row style={{ justifyContent: 'space-around' }}>
          {stats.map((s) => (
            <View key={s.label} style={{ gap: 2, alignItems: 'center' }}>
              <T size={22} weight={700}>
                {s.value}
              </T>
              <T size={12} color={colors.textSecondary}>
                {s.label}
              </T>
            </View>
          ))}
        </Row>
      </Glass>
    </Screen>
  );
}
