import { View } from 'react-native';

import { Cover, ErrorState, Glass, Gradient, Icon, IconTile, Loading, Row, Screen, ScreenHeader, Sticker, T, Tap, useAsync } from '../components';
import { personalBests, topScores, type GameKey, type GameScore } from '../lib/games';
import { useAuth } from '../state/auth';
import { art, colors, withAlpha } from '../theme/tokens';
import type { IconName } from '../components/icons';

function GameCard({ icon, tint, title, subtitle, href, pill }: { icon: IconName; tint: readonly [string, string]; title: string; subtitle: string; href: '/beat-game' | '/quiz' | '/leaderboard'; pill?: string }) {
  return (
    <Tap href={href} accessibilityLabel={`${title}. ${subtitle}${pill ? `, best ${pill}` : ''}`}>
      <Glass padding={12}>
        <Row gap={14}>
          <Gradient colors={[tint[0], tint[1]]} style={{ width: 68, height: 68, borderRadius: 28, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} size={28} color={colors.white} />
          </Gradient>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={16} weight={600} numberOfLines={1}>
              {title}
            </T>
            <T size={12} color={colors.textSecondary} numberOfLines={2}>
              {subtitle}
            </T>
          </View>
          {pill ? (
            <View style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: withAlpha(colors.gold, 0.16), justifyContent: 'center' }}>
              <T size={12} weight={700} color={colors.gold}>
                {pill}
              </T>
            </View>
          ) : null}
        </Row>
      </Glass>
    </Tap>
  );
}

const fmt = (n: number) => n.toLocaleString('en-US');

export default function Games() {
  const { user } = useAuth();
  const bests = useAsync(async (): Promise<Partial<Record<GameKey, GameScore>>> => (user ? personalBests(user.id) : {}), [user?.id], 'app/games:42');
  const top = useAsync(async () => (user ? topScores('beat', 10) : []), [user?.id], 'app/games:43');
  const beatBest = bests.data?.beat;

  return (
    <Screen onRefresh={() => Promise.all([bests.refresh(), top.refresh()])} top={4} gap={16}>
      <ScreenHeader title="" />
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={38} accessibilityRole="header">
          Games
        </T>
        <T size={14} color={colors.textSecondary}>
          Play, win and beat your best score
        </T>
      </View>

      {/* Featured: Beat Rush */}
      <Tap href="/beat-game" accessibilityLabel={`Play Beat Rush${beatBest ? `, your best is ${fmt(beatBest.score)}` : ''}`}>
        <Gradient colors={['#3A0B10', '#050505']} angle={180} style={{ borderRadius: 32, height: 190, padding: 18, justifyContent: 'flex-end', overflow: 'hidden' }}>
          <View style={{ position: 'absolute', right: -40, top: 12, width: 230, height: 230, borderRadius: 115, borderWidth: 1, borderColor: withAlpha(colors.white, 0.18) }} />
          <View style={{ position: 'absolute', right: 24, top: 26, width: 110, height: 110, borderRadius: 55, backgroundColor: withAlpha(colors.rose, 0.4) }} />
          <View style={{ position: 'absolute', right: 52, top: 52, width: 54, height: 54, borderRadius: 27, backgroundColor: withAlpha(colors.white, 0.22) }} />
          <View style={{ position: 'absolute', right: 18, top: 18 }}>
            <Icon name="bolt" size={40} color={colors.white} strokeWidth={1.4} />
          </View>
          <T size={11} weight={700} tracking={0.8} color={colors.accentLight}>
            FEATURED
          </T>
          <T size={30} weight={300} tracking={-1} color={colors.white}>
            Beat <T size={30} weight={800} tracking={-1} color={colors.white}>Rush</T>
          </T>
          <T size={13} color={colors.peach} style={{ marginTop: 4 }}>
            {!user ? 'Tap in rhythm to trending songs' : bests.loading && !bests.data ? 'Loading your best…' : beatBest ? `Your best ${fmt(beatBest.score)} · ${Math.round((beatBest.accuracy ?? 0) * 100)}% accuracy` : 'No score yet. Set your first one.'}
          </T>
        </Gradient>
      </Tap>

      <T size={19} weight={500} tracking={-0.2} accessibilityRole="header" style={{ paddingHorizontal: 16, marginTop: 4 }}>
        All games
      </T>
      <View style={{ gap: 12 }}>
        <GameCard icon="bolt" tint={art.rose} title="Beat Rush" subtitle="Tap in rhythm" href="/beat-game" pill={beatBest ? fmt(beatBest.score) : undefined} />
        <GameCard icon="music" tint={art.blue} title="Song guess" subtitle="Hear a clip, name the song" href="/quiz" pill={bests.data?.quiz ? fmt(bests.data.quiz.score) : undefined} />
        <GameCard icon="trophy" tint={art.orange} title="Weekly leaderboard" subtitle="Listening XP with the people you follow" href="/leaderboard" />
      </View>

      <T size={19} weight={500} tracking={-0.2} accessibilityRole="header" style={{ paddingHorizontal: 16, marginTop: 4 }}>
        Beat Rush top scores
      </T>
      {!user ? (
        <T size={14} color={colors.textSecondary}>
          Sign in to save scores and see the top players.
        </T>
      ) : top.loading && !top.data ? (
        <Loading label="Loading top scores" height={200} />
      ) : top.error ? (
        <ErrorState message={top.error} onRetry={top.reload} />
      ) : !top.data?.length ? (
        <Glass padding={16}>
          <Row gap={12}>
            <IconTile icon="trophy" color={colors.gold} />
            <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
              No scores yet. Play Beat Rush to set the first one.
            </T>
          </Row>
        </Glass>
      ) : (
        <Glass radius={36} style={{ paddingHorizontal: 16, paddingVertical: 4 }}>
          {top.data.map((s, i) => {
            const me = s.user_id === user.id;
            return (
              <Row key={s.id} gap={12} style={[{ paddingVertical: 10 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                <T size={15} weight={700} color={i === 0 ? colors.gold : colors.textSecondary} style={{ width: 22 }}>
                  {i + 1}
                </T>
                <Cover uri={s.avatar_url} id={s.user_id} size={36} radius={12} style={{ alignItems: 'center', justifyContent: 'center' }}>
                  {s.avatar_url ? null : (
                    <T size={13} weight={600} color={colors.white}>
                      {(s.display_name || '?').charAt(0).toUpperCase()}
                    </T>
                  )}
                </Cover>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={15} weight={me ? 700 : 500} numberOfLines={1}>
                    {me ? 'You' : s.display_name}
                  </T>
                  {s.track?.title ? (
                    <T size={12} color={colors.textSecondary} numberOfLines={1}>
                      {s.track.title}
                    </T>
                  ) : null}
                </View>
                {me ? <Sticker label="YOU" rotate={3} /> : null}
                <T size={14} color={colors.peach}>
                  {fmt(s.score)}
                </T>
              </Row>
            );
          })}
        </Glass>
      )}
      {bests.error ? (
        <T size={12} color={colors.textSecondary} align="center">
          {bests.error}
        </T>
      ) : null}
      <T size={12} color={colors.textSecondary} align="center" lineHeight={16}>
        Scores are counted on your phone. Beat Rush follows each song’s BPM from Audius, so timing is approximate.
      </T>
    </Screen>
  );
}
