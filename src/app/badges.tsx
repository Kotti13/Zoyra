import { useState } from 'react';
import { View } from 'react-native';

import { Art, ChipRow, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, ProgressBar, Row, Screen, ScreenHeader, T } from '../components';
import { useProgress, type Badge } from '../lib/levels';
import { PRESET_ARTS, artStops } from '../lib/profile-custom';
import { shareSnapshot } from '../lib/share-snapshots';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Filter = 'all' | 'unlocked' | 'locked' | 'streak' | 'social';

function BadgeTile({ b, index }: { b: Badge; index: number }) {
  const progress = Math.min(b.value, b.goal);
  return (
    <View
      accessible
      accessibilityLabel={`${b.label}, ${b.unlocked ? 'unlocked' : `locked, ${progress} of ${b.goal}. ${b.hint}`}`}
      style={{ width: '31%', flexGrow: 1, alignItems: 'center', gap: 8, opacity: b.unlocked ? 1 : 0.55 }}
    >
      {b.unlocked ? (
        <Art art={artStops(PRESET_ARTS[index % PRESET_ARTS.length])} size={64} radius={32} sticker style={{ alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={b.icon} size={28} color={colors.white} />
        </Art>
      ) : (
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.track, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={b.icon} size={28} color={colors.textSecondary} />
        </View>
      )}
      <T size={12} weight={600} align="center" lineHeight={15}>
        {b.label}
      </T>
      {b.unlocked ? (
        <T size={11} color={colors.textSecondary}>
          Unlocked
        </T>
      ) : b.goal > 1 ? (
        <View style={{ width: 64, gap: 3 }}>
          <ProgressBar value={progress / b.goal} height={4} />
          <T size={11} color={colors.textSecondary} align="center">
            {progress} of {b.goal}
          </T>
        </View>
      ) : (
        <T size={11} color={colors.textSecondary} align="center">
          {b.hint}
        </T>
      )}
    </View>
  );
}

export default function Badges() {
  const { user, profile } = useAuth();
  const q = useProgress(user?.id);
  const [filter, setFilter] = useState<Filter>('all');
  const [shareError, setShareError] = useState<string | null>(null);

  const badges = q.data?.badges ?? [];
  const unlocked = badges.filter((b) => b.unlocked);
  const locked = badges.filter((b) => !b.unlocked);

  const filters: { key: Filter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'unlocked', label: `Unlocked ${unlocked.length}` },
    { key: 'locked', label: `Locked ${locked.length}` },
    { key: 'streak', label: 'Streaks' },
    { key: 'social', label: 'Social' },
  ];

  const shown = badges.filter((b) =>
    filter === 'all' ? true : filter === 'unlocked' ? b.unlocked : filter === 'locked' ? !b.unlocked : b.category === filter,
  );

  const share = async () => {
    setShareError(null);
    const names = unlocked.map((b) => b.label).join(', ');
    try {
      await shareSnapshot({
        kind: 'b',
        payload: { got: unlocked.length, total: badges.length, names: unlocked.map((b) => b.label).slice(0, 12) },
        me: { id: user?.id, username: profile?.username },
        title: 'My badges on Zoyra',
        message: unlocked.length
          ? `I've unlocked ${unlocked.length} of ${badges.length} badges on Zoyra: ${names}.`
          : `I'm collecting badges on Zoyra. ${badges.length} to go!`,
      });
    } catch {
      setShareError('Could not open the share sheet');
    }
  };

  return (
    <Screen onRefresh={q.refresh} top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'amberRose' }}>
      <ScreenHeader title="Badges" right={q.data ? <IconButton icon="share" label="Share badges" onPress={() => void share()} /> : undefined} />

      {!user ? (
        <EmptyState icon="users" title="Sign in to collect badges" action="Sign in" href="/login" />
      ) : q.loading && !q.data ? (
        <Loading label="Counting your badges" height={240} />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : q.data ? (
        <>
          <Glass padding={16}>
            <Row gap={16}>
              <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="trophy" size={30} color={colors.amber} />
              </View>
              <View style={{ flex: 1, gap: 8 }}>
                <T size={20} weight={700}>
                  {unlocked.length} of {badges.length} unlocked
                </T>
                <ProgressBar value={badges.length ? unlocked.length / badges.length : 0} />
              </View>
            </Row>
          </Glass>

          <ChipRow options={filters.map((f) => f.label)} onChange={(i) => setFilter(filters[i].key)} />

          {shown.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 20, columnGap: 8 }}>
              {shown.map((b) => (
                <BadgeTile key={b.key} b={b} index={badges.indexOf(b)} />
              ))}
            </View>
          ) : (
            <T size={14} color={colors.textSecondary} align="center" style={{ paddingVertical: 24 }}>
              {filter === 'unlocked' ? 'Nothing unlocked yet. Keep listening!' : 'Nothing here yet.'}
            </T>
          )}

          <T size={12} color={colors.textSecondary} align="center" lineHeight={16}>
            Badges come from your listening history, playlists, likes and follows. Each one is worth 50 XP.
          </T>
          {shareError ? (
            <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
              {shareError}
            </T>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
