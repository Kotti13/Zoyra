import { useState } from 'react';
import { View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, IconButton, LinkText, Loading, Overline, ProgressBar, Row, Screen, ScreenHeader, SectionHeader, T, TrackItem, useAsync } from '../components';
import { ProfileTabs, usePullRefresh } from '../features/profile-ui';
import { formatCount } from '../lib/catalog';
import { fmtMinutes, loadTaste } from '../lib/profile';
import { shareSnapshot } from '../lib/share-snapshots';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const BAR_COLORS = [colors.accent, colors.rose, colors.like, colors.amber, colors.info];
const RING_COLORS = [colors.like, colors.amber, colors.rose];

function StatRing({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: 4 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={{ width: 64, height: 64, borderRadius: 32, borderWidth: 6, borderColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <T size={15} weight={700}>
          {value}
        </T>
      </View>
      <T size={12} color={colors.textSecondary} align="center">
        {label}
      </T>
    </View>
  );
}

export default function ProfileTaste() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const taste = useAsync(() => (uid ? loadTaste(uid) : Promise.reject(new Error('Sign in to see your taste'))), [uid]);
  const t = taste.data;
  const pullControl = usePullRefresh(taste.loading, taste.refresh);
  const [shareError, setShareError] = useState<string | null>(null);

  const share = () => {
    if (!t?.genres.length) return;
    const top = t.genres
      .slice(0, 3)
      .map((g) => `${g.name} ${Math.round(g.share * 100)}%`)
      .join(', ');
    setShareError(null);
    shareSnapshot({
      kind: 'd',
      payload: { genres: t.genres.slice(0, 6).map((g) => ({ n: g.name, p: Math.round(g.share * 100) })) },
      title: 'My taste DNA on Zoyra',
      me: { id: user?.id, username: profile?.username },
      message: `My Zoyra taste DNA: ${top}.` }).catch(() => setShareError('Could not open the share menu.'));
  };

  const peak = Math.max(1, ...(t?.week ?? [0]));

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }} refreshControl={uid ? pullControl : undefined}>
      <ScreenHeader title={profile?.display_name ?? 'Taste'} right={t?.genres.length ? <IconButton icon="share" label="Share taste" onPress={share} /> : undefined} />
      <ProfileTabs active="taste" />
      {shareError ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {shareError}
        </T>
      ) : null}

      {!uid ? (
        <EmptyState icon="users" title="Sign in to see your taste" body="Your genres, top tracks and listening stats show up here." action="Sign in" href="/login" />
      ) : taste.loading && !t ? (
        <Loading height={240} label="Reading your taste" />
      ) : taste.error && !t ? (
        <ErrorState message={taste.error} onRetry={taste.reload} />
      ) : t && t.plays === 0 ? (
        <EmptyState icon="music" title="No taste yet" body="Listen for a while and your genres, top tracks and stats show up here." action="Find music" href="/search" />
      ) : t ? (
        <>
          {/* Taste DNA: share of your plays per genre, last 90 days */}
          <Glass padding={16} style={{ gap: 14 }}>
            <Overline>TASTE DNA</Overline>
            {t.genres.length ? (
              t.genres.map((g, i) => (
                <View key={g.name} style={{ gap: 6 }} accessible accessibilityLabel={`${g.name}, ${Math.round(g.share * 100)} percent of your plays`}>
                  <Row style={{ justifyContent: 'space-between' }}>
                    <T size={13} weight={600}>
                      {g.name}
                    </T>
                    <T size={13} color={colors.textSecondary}>{`${Math.round(g.share * 100)}%`}</T>
                  </Row>
                  <ProgressBar value={g.share} height={8} color={BAR_COLORS[i % BAR_COLORS.length]} />
                </View>
              ))
            ) : (
              <T size={13} color={colors.textSecondary}>
                The songs you play don’t carry genre tags yet.
              </T>
            )}
            <T size={12} color={colors.textTertiary}>{`Share of your ${formatCount(t.plays)} plays in the last 90 days.`}</T>
          </Glass>

          <Glass padding={16}>
            <Row gap={8} align="flex-start">
              <StatRing value={String(t.streak)} label="Day streak" color={RING_COLORS[0]} />
              <StatRing value={formatCount(t.artists)} label="Artists" color={RING_COLORS[1]} />
              <StatRing value={formatCount(t.genreCount)} label="Genres" color={RING_COLORS[2]} />
            </Row>
          </Glass>

          {/* This week */}
          <Glass padding={16} style={{ gap: 12 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={14} weight={600}>
                This week
              </T>
              <LinkText label="See insights" size={13} href="/insights" />
            </Row>
            <Row align="flex-end" style={{ justifyContent: 'space-between' }}>
              <T variant="display">{fmtMinutes(t.weekMinutes)}</T>
              <Row gap={6} align="flex-end" style={{ width: 140, height: 48 }} accessibilityLabel="Minutes listened over the last 7 days">
                {t.week.map((m, i) => (
                  <View key={i} style={{ flex: 1, height: 8 + Math.round((m / peak) * 40), borderRadius: 4, backgroundColor: i === 6 ? colors.accentLight : colors.track }} />
                ))}
              </Row>
            </Row>
          </Glass>

          <SectionHeader title="Top tracks" action="See all" href="/insights" />
          <Glass padding={4} style={{ paddingHorizontal: 12 }}>
            {t.topTracks.map((x, i, all) => (
              <View key={x.track.id} style={i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : undefined}>
                <TrackItem
                  track={x.track}
                  list={all.map((y) => y.track)}
                  index={i}
                  showIndex
                  context="Your top tracks"
                  showDuration={false}
                  right={
                    <T size={13} color={colors.textSecondary}>
                      {`${formatCount(x.plays)} ${x.plays === 1 ? 'play' : 'plays'}`}
                    </T>
                  }
                />
              </View>
            ))}
          </Glass>
        </>
      ) : null}

      <Row gap={10}>
        <Button label="Compare taste" icon="users" variant="glass" href="/taste-compare" style={{ flex: 1 }} />
        <Button label="Wrapped" icon="star" variant="glass" href="/wrapped" style={{ flex: 1 }} />
      </Row>
    </Screen>
  );
}
