import { View } from 'react-native';

import { EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, ListRow, Loading, Screen, ScreenHeader, SectionHeader, T, Tap } from '../components';
import { PERKS, titleFor, useProgress } from '../lib/levels';
import { FramedAvatar, useProfileCustom } from '../lib/profile-custom';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const fmt = (n: number) => n.toLocaleString('en-US');

export default function LevelPerks() {
  const { user, profile } = useAuth();
  const { custom } = useProfileCustom();
  const q = useProgress(user?.id);
  const p = q.data;

  return (
    <Screen onRefresh={q.refresh} top={4} gap={16} backdrop={{ pattern: 'dots' }}>
      <ScreenHeader title="Levels and perks" right={<IconButton icon="info" label="Help" href="/help" />} />

      {!user ? (
        <EmptyState icon="users" title="Sign in to earn XP" action="Sign in" href="/login" />
      ) : q.loading && !p ? (
        <Loading label="Adding up your XP" height={240} />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : p ? (
        <>
          {/* Current level */}
          <Glass padding={20}>
            <View style={{ alignItems: 'center', gap: 14 }}>
              <FramedAvatar uri={profile?.avatar_url} id={user.id} name={profile?.display_name} preset={custom.avatar_art} frame={custom.avatar_frame} size={88} level={p.level.level} />
              <View style={{ alignItems: 'center', gap: 2 }}>
                <T size={20} weight={700}>
                  {p.level.title}
                </T>
                <T size={13} color={colors.textSecondary}>
                  {fmt(p.level.next - p.level.xp)} XP to level {p.level.level + 1}
                  {p.level.nextTitle !== p.level.title ? `, ${p.level.nextTitle}` : ''}
                </T>
              </View>
              <View style={{ alignSelf: 'stretch', gap: 8 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T size={12} color={colors.textSecondary}>
                    {fmt(p.level.xp)} XP
                  </T>
                  <T size={12} color={colors.textSecondary}>
                    {fmt(p.level.next)} XP
                  </T>
                </View>
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel={`Level ${p.level.level} progress`}
                  accessibilityValue={{ min: p.level.floor, max: p.level.next, now: p.level.xp }}
                  style={{ height: 10, borderRadius: 5, backgroundColor: colors.track, overflow: 'hidden' }}
                >
                  <Gradient colors={[colors.accent, colors.amber]} angle={90} style={{ width: `${Math.max(2, p.level.progress * 100)}%`, height: 10, borderRadius: 5 }} />
                </View>
              </View>
            </View>
          </Glass>

          {/* How XP is earned, with what you've earned so far */}
          <SectionHeader title="Earn XP" />
          <Glass padding={4}>
            {p.rules.map((r, i) => (
              <ListRow
                key={r.key}
                divider={i > 0}
                minHeight={60}
                icon={r.icon}
                title={r.label}
                subtitle={`+${r.xp} XP · ${r.detail}`}
                right={
                  <T mono size={12} color={colors.textSecondary} accessibilityLabel={`${r.earned} XP earned`}>
                    {fmt(r.earned)}
                  </T>
                }
              />
            ))}
          </Glass>

          {/* Rewards ladder: only perks the app really grants (Customize profile items). */}
          <SectionHeader title="Rewards ladder" />
          <View style={{ gap: 10 }}>
            {PERKS.map((perk) => {
              const got = p.level.level >= perk.level;
              const here = got && !PERKS.some((x) => x.level > perk.level && x.level <= p.level.level);
              return (
                <Tap key={perk.level} href="/customize-profile" accessibilityLabel={`Level ${perk.level}, ${perk.label}, ${got ? 'unlocked' : 'locked'}`}>
                  <Glass radius={32} style={[{ paddingVertical: 14, paddingHorizontal: 16 }, here ? { borderColor: colors.accent } : null]}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: got ? colors.accent : colors.track, alignItems: 'center', justifyContent: 'center' }}>
                        <T weight={700} color={got ? colors.onAccent : colors.textSecondary}>
                          {perk.level}
                        </T>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T size={15} weight={700}>
                          {perk.label}
                        </T>
                        <T size={13} color={colors.textSecondary}>
                          {here ? `You are here · ${perk.detail}` : `${titleFor(perk.level)} · ${perk.detail}`}
                        </T>
                      </View>
                      <Icon name={got ? 'check' : 'lock'} size={20} color={got ? colors.accent : colors.textSecondary} />
                    </View>
                  </Glass>
                </Tap>
              );
            })}
          </View>
          <T size={12} color={colors.textSecondary} align="center" lineHeight={16}>
            Perks are profile looks you can use in Customize. XP comes from your real listening, playlists, follows and badges.
          </T>
        </>
      ) : null}
    </Screen>
  );
}
