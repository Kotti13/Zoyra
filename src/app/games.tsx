import { View } from 'react-native';

import { Cover, ErrorState, Glass, Gradient, Icon, IconTile, ListRow, Loading, Row, Screen, ScreenHeader, SectionHeader, Sticker, T, Tap, useAsync } from '../components';
import { personalBests, topScores, type GameKey, type GameScore } from '../lib/games';
import { useAuth } from '../state/auth';
import { art, colors } from '../theme/tokens';

const fmt = (n: number) => n.toLocaleString('en-US');

export default function Games() {
  const { user } = useAuth();
  const bests = useAsync(async (): Promise<Partial<Record<GameKey, GameScore>>> => (user ? personalBests(user.id) : {}), [user?.id]);
  const top = useAsync(async () => (user ? topScores('beat', 10) : []), [user?.id]);
  const beatBest = bests.data?.beat;

  return (
    <Screen onRefresh={() => Promise.all([bests.refresh(), top.refresh()])} top={4} gap={20} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Games
        </T>
        <T size={15} color={colors.textSecondary}>
          Play along to real songs and beat your best
        </T>
      </View>

      {/* Featured: Beat Rush */}
      <Tap href="/beat-game" accessibilityLabel={`Play Beat Rush${beatBest ? `, your best is ${fmt(beatBest.score)}` : ''}`}>
        <Gradient colors={art.red} style={{ borderRadius: 32, padding: 22, minHeight: 200, justifyContent: 'flex-end', overflow: 'hidden' }}>
          <View style={{ position: 'absolute', top: 20, right: 20 }}>
            <Icon name="bolt" size={64} color={colors.white} strokeWidth={1.2} />
          </View>
          <T variant="overline" color={colors.white}>
            FEATURED
          </T>
          <T size={46} weight={300} tracking={-1.5} color={colors.white} lineHeight={50}>
            Beat{'\n'}Rush
          </T>
          <T size={13} color={colors.white} style={{ opacity: 0.85, marginTop: 4 }}>
            {!user ? 'Tap in rhythm to trending songs' : bests.loading && !bests.data ? 'Loading your best…' : beatBest ? `Your best ${fmt(beatBest.score)} · ${Math.round((beatBest.accuracy ?? 0) * 100)}% accuracy` : 'No score yet. Set your first one.'}
          </T>
        </Gradient>
      </Tap>

      <SectionHeader title="All games" />
      <Glass padding={4}>
        <ListRow
          icon="bolt"
          title="Beat Rush"
          subtitle={beatBest ? `Tap in rhythm · best ${fmt(beatBest.score)}` : 'Tap in rhythm'}
          href="/beat-game"
          minHeight={64}
        />
        <ListRow
          divider
          icon="music"
          title="Song guess"
          subtitle={bests.data?.quiz ? `Name the song · best ${fmt(bests.data.quiz.score)}` : 'Hear a clip, name the song'}
          href="/quiz"
          minHeight={64}
        />
        <ListRow divider icon="trophy" title="Weekly leaderboard" subtitle="Listening XP with the people you follow" href="/leaderboard" minHeight={64} />
      </Glass>

      <SectionHeader title="Beat Rush top scores" />
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
        <Glass padding={4}>
          {top.data.map((s, i) => {
            const me = s.user_id === user.id;
            return (
              <Row key={s.id} gap={12} style={[{ minHeight: 60, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                <T mono size={14} color={i === 0 ? colors.gold : colors.textSecondary} style={{ width: 20 }} align="center">
                  {i + 1}
                </T>
                <Cover uri={s.avatar_url} id={s.user_id} size={36} radius={18} style={{ alignItems: 'center', justifyContent: 'center' }}>
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
                <T mono size={14}>
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
