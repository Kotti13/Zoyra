import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Art, Button, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, ProgressBar, Row, Screen, SectionHeader, T, Tap, Toast, TrackItem, useAsync, useFocusEffectAfterTransition } from '../../components';
import { HeroButton, InfoPill, ProfileHero, ProfileTabs, StatStrip, usePullRefresh } from '../../features/profile-ui';
import { formatCount } from '../../lib/catalog';
import { useProgress } from '../../lib/levels';
import { loadOverview } from '../../lib/profile';
import { useProfileCustom } from '../../lib/profile-custom';
import { profileShareUrl, shareContent } from '../../lib/share-links';
import { useSpotifyLink } from '../../lib/spotify';
import { useAuth } from '../../state/auth';
import { useLibrary } from '../../state/library';
import { usePlayerActions, usePlayerSelector } from '../../state/player';
import { colors, type ArtName } from '../../theme/tokens';

const BADGE_ART: ArtName[] = ['coral', 'blue', 'rose', 'amber'];
const PLAN_LABEL: Record<string, string> = { premium: 'Premium', family: 'Family', student: 'Student' };

export default function Profile() {
  const { user, profile, refresh } = useAuth();
  const { playlists, liked } = useLibrary();
  // Only the now-playing card's slice; actions are stable (no re-render on queue / buffering changes).
  const playerTrack = usePlayerSelector((x) => x.track);
  const playerPlaying = usePlayerSelector((x) => x.playing);
  const player = usePlayerActions();
  const [note, setNote] = useState<{ text: string; error?: boolean; at?: 'top' | 'links' }>();
  // Toast-style note: clears itself after a few seconds.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), 3200);
    return () => clearTimeout(t);
  }, [note]);
  const uid = user?.id;
  const stats = useAsync(() => (uid ? loadOverview(uid) : Promise.reject(new Error('Not signed in'))), [uid], 'app/(tabs)/profile:36');
  const progress = useProgress(uid);
  const { custom } = useProfileCustom();

  // Refresh counts and listening stats whenever the tab comes back into view.
  const { reload } = stats;
  const { reload: reloadProgress } = progress;
  const firstFocus = useRef(true);
  // Deferred until the tab shift has finished, so the reload's loading/data re-renders don't land mid-transition.
  // The tab may have been preloaded in the background long before its first visit: refresh then too
  // unless the mount-time load is still recent.
  const [mountedAt] = useState(() => Date.now());
  useFocusEffectAfterTransition(() => {
    const first = firstFocus.current;
    firstFocus.current = false;
    if (!first || Date.now() - mountedAt > 30_000) {
      reload();
      reloadProgress();
    }
  });

  // Pull to refresh: reload stats, level/badges and the profile row (name, avatar, customisation).
  const pullControl = usePullRefresh(stats.loading || progress.loading, () =>
    Promise.all([stats.refresh(), progress.refresh(), refresh().catch(() => setNote({ text: 'Could not refresh your profile. Check your connection.', error: true }))]),
  );

  const s = stats.data;
  const name = profile?.display_name ?? 'Listener';
  const handle = profile?.username ? `@${profile.username}` : null;
  const subtitle = [handle, profile?.bio?.trim()].filter(Boolean).join(' · ') || 'Add a username and bio in Edit profile';
  const myPlaylists = playlists.filter((p) => p.owner_id === uid);
  const joined = profile?.created_at ? new Date(profile.created_at).getFullYear() : null;
  const plan = profile?.plan ? PLAN_LABEL[profile.plan] : undefined;
  const lvl = progress.data?.level ?? null;
  // Earned badges first, then the closest to unlocking.
  const badges = [...(progress.data?.badges ?? [])]
    .sort((a, b) => Number(b.unlocked) - Number(a.unlocked) || b.value / b.goal - a.value / a.goal)
    .slice(0, 4);
  const pins = custom.showcase.pinned ? custom.pinned_tracks : [];

  const share = () => {
    if (!uid) return setNote({ text: 'Sign in to share your profile.', error: true });
    const who = handle ? `${name} (${handle})` : name;
    shareContent({ url: profileShareUrl({ id: uid, username: profile?.username }), title: `${name} on Zoyra`, message: `Listen along with ${who} on Zoyra` }).catch(() => setNote({ text: 'Could not open the share menu.', error: true }));
  };

  const spotify = useSpotifyLink();
  const toggleSpotify = async () => {
    if (spotify.busy) return;
    if (!uid) return setNote({ text: 'Sign in to link Spotify.', error: true, at: 'links' });
    try {
      if (spotify.account) {
        await spotify.disconnect();
        setNote({ text: 'Spotify disconnected.', at: 'links' });
        return;
      }
      const res = await spotify.connect();
      if (res) setNote({ text: res.message, error: !res.ok, at: 'links' });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not update the Spotify link.', error: true, at: 'links' });
    }
  };

  // Now playing card: the player's track, otherwise your last play.
  const nowTrack = playerTrack ?? s?.last?.track ?? null;
  const isLive = !!playerTrack;

  const noteView = note ? (
    <View accessibilityLiveRegion="polite">
      <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.error : colors.success} message={note.text} />
    </View>
  ) : null;

  return (
    <Screen
      tabbed
      top={4}
      gap={16}
      backdrop={{ pattern: 'dots', mesh: 'coral' }}
      refreshControl={uid ? pullControl : undefined}
    >
      <ProfileHero
        id={uid}
        name={name}
        avatar={profile?.avatar_url}
        custom={custom}
        level={lvl?.level}
        avatarHref="/avatar-picker"
        left={<HeroButton icon="users" label="Switch account" href="/account-switcher" />}
        right={
          <>
            <HeroButton icon="edit" label="Customize profile" href="/customize-profile" />
            <HeroButton icon="sliders" label="Settings" href="/settings" />
          </>
        }
      />

      {/* Identity */}
      <View style={{ gap: 6, paddingLeft: 4 }}>
        <T size={26} weight={300} tracking={-0.4} accessibilityRole="header">
          {name}
        </T>
        <T size={14} color={colors.textSecondary} numberOfLines={2}>
          {subtitle}
        </T>
        {joined || plan ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginTop: 6 }}>
            {joined ? <InfoPill icon="clock" label={`Joined ${joined}`} /> : null}
            {plan ? <InfoPill icon="star" label={plan} highlight /> : null}
          </ScrollView>
        ) : null}
      </View>

      <Row gap={10}>
        <Button label="Edit profile" href="/edit-profile" style={{ flex: 1 }} />
        <IconButton icon="share" label="Share profile" size={48} iconSize={22} bg={colors.iconGhost} onPress={share} />
        <IconButton icon="qr" label="QR code" size={48} iconSize={22} bg={colors.iconGhost} href="/profile-qr" />
        <IconButton icon="more" label="More options" size={48} iconSize={22} bg={colors.iconGhost} href="/profile-more" />
      </Row>
      {note && note.at !== 'links' ? noteView : null}

      <StatStrip
        items={[
          { value: s ? formatCount(s.followers) : '–', label: 'Followers', onPress: () => router.push('/followers') },
          { value: s ? formatCount(s.following) : '–', label: 'Following', onPress: () => router.push({ pathname: '/followers', params: { tab: 'following' } }) },
          { value: formatCount(myPlaylists.length), label: 'Playlists', onPress: () => router.push('/profile-playlists') },
          { value: s ? formatCount(s.plays) : '–', label: 'Plays' },
        ]}
      />

      <ProfileTabs active="overview" />

      {!uid ? (
        <EmptyState icon="users" title="Sign in to see your profile" body="Your stats, badges and listening show up here once you sign in." action="Sign in" href="/login" />
      ) : stats.error && !s ? (
        <ErrorState message={stats.error} onRetry={stats.reload} />
      ) : null}

      {/* Level */}
      {lvl ? (
        <Glass padding={16} style={{ gap: 14 }}>
          <Row>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.iconGhost, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="trophy" size={22} color={colors.amber} />
            </View>
            <View style={{ flex: 1 }}>
              <T size={16} weight={700}>{`Level ${lvl.level} · ${lvl.title}`}</T>
              <T size={13} color={colors.textSecondary}>{`${formatCount(lvl.next - lvl.xp)} XP to Level ${lvl.level + 1}`}</T>
            </View>
            <IconButton icon="chevronRight" label="Level perks" color={colors.textSecondary} href="/level-perks" />
          </Row>
          <View style={{ gap: 8 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={12} color={colors.textSecondary}>{`${lvl.xp.toLocaleString()} XP`}</T>
              <T size={12} color={colors.textSecondary}>{`${lvl.next.toLocaleString()} XP`}</T>
            </Row>
            <ProgressBar value={lvl.progress} height={10} />
          </View>
          <Row gap={10}>
            <Button label="Achievements" icon="trophy" variant="glass" height={40} href="/achievements" style={{ flex: 1 }} />
            <Button label="Level perks" icon="star" variant="glass" height={40} href="/level-perks" style={{ flex: 1 }} />
          </Row>
        </Glass>
      ) : progress.loading ? (
        <Loading height={120} />
      ) : null}

      {/* Now playing / last played */}
      {nowTrack ? (
        <Glass padding={16}>
          <Row gap={14}>
            <Cover artwork={nowTrack.artwork} id={nowTrack.id} size={64} radius={18} />
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <T size={12} weight={600} tracking={0.4} color={colors.accentLight}>
                {isLive ? 'NOW PLAYING' : 'LAST PLAYED'}
              </T>
              <T size={16} weight={700} numberOfLines={1}>
                {nowTrack.title}
              </T>
              <T size={13} color={colors.textSecondary} numberOfLines={1}>
                {nowTrack.artist.name}
              </T>
            </View>
            <IconButton
              icon={isLive && playerPlaying ? 'pause' : 'play'}
              label={isLive && playerPlaying ? 'Pause' : 'Play'}
              size={48}
              bg={colors.accent}
              color={colors.onAccent}
              filled
              onPress={() => (isLive ? player.toggle() : player.playTrack(nowTrack, 'Profile'))}
            />
          </Row>
        </Glass>
      ) : null}

      {custom.showcase.taste ? (
        <>
      {/* Top artists (last 30 days) */}
      <SectionHeader title="Top artists this month" action="See all" href="/profile-taste" />
      {stats.loading && !s ? (
        <Loading height={100} />
      ) : s && s.topArtists.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginRight: -16 }} contentContainerStyle={{ gap: 14, paddingRight: 16 }}>
          {s.topArtists.map((a) => (
            <Tap
              key={a.id || a.name}
              accessibilityLabel={`${a.name}, ${a.plays} plays this month`}
              onPress={a.id ? () => router.push({ pathname: '/artist', params: { id: a.id } }) : undefined}
              style={{ width: 76, alignItems: 'center', gap: 8 }}
            >
              <Cover uri={a.image} id={a.id || a.name} size={72} radius={36} />
              <T size={12} weight={600} numberOfLines={1} align="center">
                {a.name}
              </T>
            </Tap>
          ))}
        </ScrollView>
      ) : s ? (
        <EmptyState icon="music" title="Nothing yet" body="Play some music and your top artists will show up here." />
      ) : null}
        </>
      ) : null}

      {/* Pinned songs (from Customize); your newest likes stand in when nothing is pinned */}
      {pins.length ? (
        <>
          <SectionHeader title="Pinned songs" action="Edit" href="/customize-profile" />
          <Glass padding={4} style={{ paddingHorizontal: 12 }}>
            {pins.map((t, i, list) => (
              <View key={t.id} style={i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : undefined}>
                <TrackItem track={t} list={list} context="Pinned songs" showDuration={false} artRadius={22} subtitle={`${t.artist.name} · pinned`} right={<Icon name="pin" size={18} color={colors.amber} />} />
              </View>
            ))}
          </Glass>
        </>
      ) : (
        <>
          <SectionHeader title="Recently liked" action={liked.length > 3 ? 'See all' : undefined} href={{ pathname: '/playlist', params: { liked: '1' } }} />
          {liked.length ? (
            <Glass padding={4} style={{ paddingHorizontal: 12 }}>
              {liked.slice(0, 3).map((t, i, list) => (
                <View key={t.id} style={i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : undefined}>
                  <TrackItem track={t} list={list} context="Liked songs" showDuration={false} artRadius={22} />
                </View>
              ))}
            </Glass>
          ) : (
            <EmptyState icon="heart" title="No liked songs yet" body="Tap the heart on any song, or pin songs in Customize profile." />
          )}
        </>
      )}

      {/* Badges */}
      {custom.showcase.badges ? (
        <>
          <SectionHeader title="Badges" action="See all" href="/badges" />
          {badges.length ? (
            <Row gap={8} align="flex-start">
              {badges.map((b, i) => (
                <Tap
                  key={b.key}
                  href="/badges"
                  accessibilityLabel={`${b.label}: ${b.unlocked ? 'earned' : `${Math.min(b.value, b.goal)} of ${b.goal}`}`}
                  style={{ flex: 1, alignItems: 'center', gap: 8, opacity: b.unlocked ? 1 : 0.45 }}
                >
                  <Art art={BADGE_ART[i % BADGE_ART.length]} size={64} radius={32} style={{ alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={b.icon} size={26} color={colors.white} />
                  </Art>
                  <T size={12} weight={600} align="center" lineHeight={15}>
                    {b.label}
                  </T>
                </Tap>
              ))}
            </Row>
          ) : progress.error ? (
            <ErrorState message={progress.error} onRetry={progress.reload} />
          ) : null}
        </>
      ) : null}

      {/* Linked accounts */}
      <SectionHeader title="Linked accounts" />
      <Glass padding={4}>
        <Row style={{ minHeight: 64, paddingHorizontal: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.iconGhost, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="music" size={20} color={colors.success} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={16} weight={500}>
              Spotify
            </T>
            <T size={14} color={colors.textSecondary}>
              {spotify.account === undefined ? 'Checking…' : spotify.account ? `Connected as ${spotify.account}` : spotify.configured ? 'Not connected' : 'Needs Spotify app setup'}
            </T>
          </View>
          <LinkText label={spotify.busy ? 'Connecting…' : spotify.account ? 'Disconnect' : 'Connect'} onPress={() => void toggleSpotify()} />
        </Row>
        <Row style={{ minHeight: 64, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: colors.divider }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="music" size={20} color={colors.accentLight} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={16} weight={500}>
              Apple Music
            </T>
            <T size={14} color={colors.textSecondary}>
              Not available in this version
            </T>
          </View>
        </Row>
      </Glass>
      {note?.at === 'links' ? noteView : null}
    </Screen>
  );
}
