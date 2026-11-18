import { View } from 'react-native';

import { Art, EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, LinkText, Loading, ProgressBar, Row, Screen, ScreenHeader, Sticker, T, useAsync } from '../components';
import { useProgress } from '../lib/levels';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, shadow, type ArtName } from '../theme/tokens';

const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const BADGE_ART: ArtName[] = ['coral', 'amber', 'blue', 'rose', 'green', 'coral', 'amber', 'blue', 'rose'];

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Which days of this week (Monday first) had a play. */
async function loadWeekDays(uid: string): Promise<boolean[]> {
  const now = new Date();
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const { data, error } = await supabase.from('play_history').select('played_at').eq('user_id', uid).gte('played_at', monday.toISOString()).limit(5000);
  if (error) throw new Error(error.message);
  const days = new Set(((data ?? []) as { played_at: string }[]).map((r) => dayKey(new Date(r.played_at))));
  return WEEK_LABELS.map((_, i) => days.has(dayKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i))));
}

export default function Achievements() {
  const { user } = useAuth();
  const q = useProgress(user?.id);
  const week = useAsync(() => (user ? loadWeekDays(user.id) : Promise.resolve(WEEK_LABELS.map(() => false))), [user?.id]);

  const pr = q.data;
  const s = pr ? { streak: pr.stats.currentStreak, best: Math.max(pr.stats.bestStreak, pr.stats.currentStreak), weekDays: week.data ?? WEEK_LABELS.map(() => false) } : null;
  const badges = pr?.badges ?? [];
  const earnedCount = badges.filter((b) => b.unlocked).length;
  const lvl = pr?.level;
  const xpInLevel = lvl ? lvl.xp - lvl.floor : 0;
  const xpSpan = lvl ? lvl.next - lvl.floor : 1;

  return (
    <Screen onRefresh={() => Promise.all([q.refresh(), week.refresh()])} top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <ScreenHeader title="Achievements" right={<IconButton icon="trophy" label="Leaderboard" href="/leaderboard" />} />

      {!user ? (
        <EmptyState icon="users" title="Sign in to track achievements" action="Sign in" href="/login" />
      ) : q.loading && !s ? (
        <Loading label="Counting your wins" height={240} />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : s ? (
        <>
          {/* Streak */}
          <Glass padding={16}>
            <View style={{ gap: 14 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <View>
                  <T size={36} weight={700} tracking={-1}>
                    {s.streak} {s.streak === 1 ? 'day' : 'days'}
                  </T>
                  <T size={14} color={colors.textSecondary}>
                    Listening streak
                  </T>
                </View>
                <Sticker label={`Best: ${s.best}`} rotate={4} style={{ alignSelf: 'center' }} />
              </Row>
              <Row gap={6}>
                {WEEK_LABELS.map((day, i) => {
                  const done = s.weekDays[i];
                  return (
                    <View key={i} style={{ flex: 1, alignItems: 'center', gap: 6 }} accessibilityLabel={`${day}: ${done ? 'listened' : 'not yet'}`}>
                      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: done ? colors.amber : colors.track, alignItems: 'center', justifyContent: 'center' }}>
                        {done ? <Icon name="flame" size={18} color={colors.onAccent} /> : null}
                      </View>
                      <T mono size={11} color={colors.textSecondary}>
                        {day}
                      </T>
                    </View>
                  );
                })}
              </Row>
            </View>
          </Glass>

          {/* Level — 1 XP per minute listened */}
          <Glass padding={16}>
            <View style={{ gap: 10 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={16} weight={600}>
                  {lvl ? `Level ${lvl.level} · ${lvl.title}` : 'Level'}
                </T>
                <T mono size={13}>
                  {xpInLevel} / {xpSpan} XP
                </T>
              </Row>
              <View
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: xpSpan, now: xpInLevel }}
                style={{ height: 12, borderRadius: 10, backgroundColor: colors.track, overflow: 'hidden' }}
              >
                <Gradient colors={[colors.accent, colors.amber]} angle={90} style={{ width: `${Math.max(2, (xpInLevel / xpSpan) * 100)}%`, height: 12 }} />
              </View>
              <LinkText label="How XP and perks work" size={12} href="/level-perks" />
            </View>
          </Glass>

          {/* Badges */}
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="section" accessibilityRole="header">
              Badges
            </T>
            <T mono size={12} color={colors.textSecondary}>
              {earnedCount} of {badges.length}
            </T>
          </Row>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, columnGap: 8 }}>
            {badges.map((b, i) => {
              const earned = b.unlocked;
              const art = BADGE_ART[i % BADGE_ART.length];
              return (
                <View
                  key={b.key}
                  accessibilityLabel={`${b.label}${earned ? '' : `, locked, ${Math.min(b.value, b.goal)} of ${b.goal}`}`}
                  style={{ width: '31%', flexGrow: 1, alignItems: 'center', gap: 8 }}
                >
                  <View style={{ opacity: earned ? 1 : 0.45, alignItems: 'center', gap: 8 }}>
                    {earned ? (
                      <Art art={art} size={72} radius={36} sticker style={{ alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name={b.icon} size={30} color={colors.white} />
                      </Art>
                    ) : (
                      <View style={[{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.track, alignItems: 'center', justifyContent: 'center' }, shadow.sticker]}>
                        <Icon name={b.icon} size={30} color={colors.white} />
                      </View>
                    )}
                    <T size={12} align="center" lineHeight={16}>
                      {b.label}
                    </T>
                  </View>
                  {earned ? null : (
                    <View style={{ width: 64, gap: 2 }}>
                      <ProgressBar value={Math.min(1, b.value / b.goal)} height={4} />
                      <T mono size={10} color={colors.textSecondary} align="center">
                        {Math.min(b.value, b.goal)}/{b.goal}
                      </T>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </>
      ) : null}
    </Screen>
  );
}
