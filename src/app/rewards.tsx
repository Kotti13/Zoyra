import { View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, Gradient, Icon, IconTile, ListRow, Loading, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, T, useAsync } from '../components';
import { playedToday } from '../lib/games';
import { PERKS, useProgress } from '../lib/levels';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const fmt = (n: number) => n.toLocaleString('en-US');

type Today = { minutes: number; listenedToday: boolean; listenedYesterday: boolean; beatGames: number | null };

async function loadToday(userId: string): Promise<Today> {
  const d = new Date();
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const yesterday = new Date(today.getTime() - 864e5);
  const { data, error } = await supabase
    .from('play_history')
    .select('played_at, seconds_listened')
    .eq('user_id', userId)
    .gte('played_at', yesterday.toISOString())
    .limit(5000);
  if (error) throw new Error(error.message);
  let seconds = 0;
  let listenedToday = false;
  let listenedYesterday = false;
  for (const r of (data ?? []) as { played_at: string; seconds_listened: number | null }[]) {
    if (new Date(r.played_at) >= today) {
      listenedToday = true;
      seconds += r.seconds_listened ?? 0;
    } else listenedYesterday = true;
  }
  // Game scores may not be set up yet; that only hides the Beat Rush line.
  const beatGames = await playedToday(userId, 'beat').catch(() => null);
  return { minutes: Math.floor(seconds / 60), listenedToday, listenedYesterday, beatGames };
}

export default function Rewards() {
  const { user } = useAuth();
  const q = useProgress(user?.id);
  const today = useAsync(async () => (user ? loadToday(user.id) : null), [user?.id], 'app/rewards:42');
  const p = q.data;
  const t = today.data;

  return (
    <Screen onRefresh={() => Promise.all([q.refresh(), today.refresh()])} top={4} gap={18} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Rewards
        </T>
        <T size={15} color={colors.textSecondary}>
          Earn XP by listening and playing
        </T>
      </View>

      {!user ? (
        <EmptyState icon="users" title="Sign in to earn XP" action="Sign in" href="/login" />
      ) : q.loading && !p ? (
        <Loading label="Adding up your XP" height={260} />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : p ? (
        <>
          {/* XP hero */}
          <Gradient colors={['rgba(255,176,32,0.28)', 'rgba(20,20,20,0.55)']} style={{ borderRadius: 32, padding: 22, gap: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' }}>
            <T variant="overline" color={colors.gold}>
              YOUR XP
            </T>
            <T size={60} weight={200} tracking={-2} color={colors.white} lineHeight={62} accessibilityLabel={`${p.level.xp} XP`}>
              {fmt(p.level.xp)}
            </T>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={15} weight={600} color={colors.white}>
                Level {p.level.level} · {p.level.title}
              </T>
              <T size={13} color={colors.white} style={{ opacity: 0.85 }}>
                {fmt(p.level.next - p.level.xp)} XP to level {p.level.level + 1}
              </T>
            </Row>
            <View accessibilityRole="progressbar" accessibilityLabel={`Level ${p.level.level} progress`} accessibilityValue={{ min: p.level.floor, max: p.level.next, now: p.level.xp }}>
              <ProgressBar value={p.level.progress} height={6} color={colors.gold} track="rgba(255,255,255,0.15)" />
            </View>
          </Gradient>

          {/* Today: real activity that counts toward XP */}
          <SectionHeader title="Daily missions" />
          {today.loading && !t ? (
            <Loading label="Loading today" height={180} />
          ) : today.error ? (
            <ErrorState message={today.error} onRetry={today.reload} />
          ) : t ? (
            <Glass padding={4}>
              <ListRow
                icon="clock"
                title="Listen for 30 minutes"
                subtitle={`${Math.min(t.minutes, 30)} of 30 min · +20 XP every 30 minutes`}
                minHeight={64}
                right={<Icon name={t.minutes >= 30 ? 'check' : 'clock'} size={20} color={t.minutes >= 30 ? colors.success : colors.textSecondary} />}
              />
              <ListRow
                divider
                icon="flame"
                title="Keep your streak"
                subtitle={
                  t.listenedToday
                    ? t.listenedYesterday
                      ? `Done · +30 XP · ${p.stats.currentStreak} day streak`
                      : 'Done · listen again tomorrow for +30 XP'
                    : t.listenedYesterday
                      ? 'Play any song today for +30 XP'
                      : 'Play a song today to start a streak'
                }
                minHeight={64}
                href={t.listenedToday ? undefined : '/'}
                right={<Icon name={t.listenedToday ? 'check' : 'chevronRight'} size={20} color={t.listenedToday ? colors.success : colors.textSecondary} />}
              />
              {t.beatGames !== null ? (
                <ListRow
                  divider
                  icon="bolt"
                  title="Play Beat Rush"
                  subtitle={t.beatGames ? `${t.beatGames} ${t.beatGames === 1 ? 'round' : 'rounds'} today · just for fun, no XP` : 'Not played today · just for fun, no XP'}
                  minHeight={64}
                  href="/beat-game"
                />
              ) : null}
            </Glass>
          ) : null}

          {/* How XP adds up */}
          <SectionHeader title="Where your XP comes from" action="Details" href="/level-perks" />
          <Glass padding={4}>
            {p.rules.map((r, i) => (
              <ListRow
                key={r.key}
                divider={i > 0}
                minHeight={58}
                icon={r.icon}
                title={r.label}
                subtitle={`+${r.xp} XP · done ${fmt(r.times)} ${r.times === 1 ? 'time' : 'times'}`}
                right={
                  <T mono size={12} color={colors.textSecondary}>
                    {fmt(r.earned)}
                  </T>
                }
              />
            ))}
          </Glass>

          {/* Perks: only what the app really grants (Customize profile looks), unlocked by level */}
          <SectionHeader title="Your perks" />
          <View style={{ gap: 10 }}>
            {PERKS.map((perk) => {
              const got = p.level.level >= perk.level;
              return (
                <Glass key={perk.level} padding={14}>
                  <Row gap={14}>
                    <IconTile icon={got ? 'star' : 'lock'} color={got ? colors.gold : colors.textSecondary} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T size={15} weight={600}>
                        {perk.label}
                      </T>
                      <T size={13} color={colors.textSecondary} numberOfLines={2}>
                        {perk.detail}
                      </T>
                    </View>
                    {got ? (
                      <Button label="Use" height={36} variant="light" href="/customize-profile" />
                    ) : (
                      <T mono size={12} color={colors.textSecondary} accessibilityLabel={`Unlocks at level ${perk.level}`}>
                        Lv {perk.level}
                      </T>
                    )}
                  </Row>
                </Glass>
              );
            })}
          </View>

          <ListRow
            icon="trophy"
            title="Badges"
            subtitle={`${p.badges.filter((b) => b.unlocked).length} of ${p.badges.length} earned · +50 XP each`}
            href="/badges"
            minHeight={64}
          />

          <T size={12} color={colors.textSecondary} align="center" lineHeight={16}>
            Perks unlock automatically when you reach their level. Zoyra has no points shop or prizes: XP only unlocks the profile looks above.
          </T>
        </>
      ) : null}
    </Screen>
  );
}
