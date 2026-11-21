import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, View } from 'react-native';

import { Art, Button, Gradient, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, ProgressBar, Row, Screen, SectionHeader, Sticker, T, Tap, Toast, TrackItem, useAsync, useFocusEffectAfterTransition, type IconName, type NavTarget } from '../../components';
import { InfoPill, ProfileTabs, usePullRefresh } from '../../features/profile-ui';
import { formatCount } from '../../lib/catalog';
import { uploadBanner } from '../../lib/avatar';
import { useProgress } from '../../lib/levels';
import { isImageUri, loadOverview } from '../../lib/profile';
import { artStops, FramedAvatar, useProfileCustom } from '../../lib/profile-custom';
import { profileShareUrl, shareContent } from '../../lib/share-links';
import { useSpotifyLink } from '../../lib/spotify';
import { useAuth } from '../../state/auth';
import { useLibrary } from '../../state/library';
import { usePlayerActions, usePlayerSelector } from '../../state/player';
import { colors, withAlpha, type ArtName } from '../../theme/tokens';

const BADGE_ART: ArtName[] = ['coral', 'blue', 'rose', 'amber'];
const PLAN_LABEL: Record<string, string> = { premium: 'Premium', family: 'Family', student: 'Student' };
const AVATAR = 96;
const BANNER_H = 170;
const GUTTER = 16;

/** One line of the quick-links list: round icon, title + hint, chevron. */
function MenuRow({ icon, label, hint, href, last, tint }: { icon: IconName; label: string; hint?: string; href: NavTarget; last?: boolean; tint?: string }) {
  return (
    <Tap href={href} accessibilityLabel={hint ? `${label}. ${hint}` : label} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 62, paddingHorizontal: 14, borderBottomWidth: last ? 0 : 1, borderBottomColor: colors.divider }}>
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: tint ?? colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={19} color={colors.text} glow={false} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={15} weight={600} numberOfLines={1}>
          {label}
        </T>
        {hint ? (
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {hint}
          </T>
        ) : null}
      </View>
      <Icon name="chevronRight" size={18} color={colors.textTertiary} glow={false} />
    </Tap>
  );
}

/** One counter in the flat stats row. */
function Stat({ value, label, onPress }: { value: string; label: string; onPress?: () => void }) {
  const body = (
    <>
      <T size={22} weight={800} tracking={-0.6}>
        {value}
      </T>
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </>
  );
  return onPress ? (
    <Tap onPress={onPress} accessibilityLabel={`${value} ${label}`} style={{ flex: 1, minHeight: 44 }}>
      {body}
    </Tap>
  ) : (
    <View style={{ flex: 1, minHeight: 44 }} accessible accessibilityLabel={`${value} ${label}`}>
      {body}
    </View>
  );
}

/** Full-bleed banner under the status bar; settings buttons sit top-right. The avatar overlaps it from the header row below. */
function ProfileCover({ custom, top }: { custom: ReturnType<typeof useProfileCustom>['custom']; top?: ReactNode }) {
  const inset = useSafeAreaInsets().top;
  const h = BANNER_H + inset;
  const [c1, c2] = artStops(custom.banner_art);
  return (
    <View style={{ marginHorizontal: -GUTTER, marginTop: -inset, height: h }}>
      <Gradient colors={[c1, c2]} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      {custom.banner_url ? <Image source={{ uri: custom.banner_url }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} contentFit="cover" accessibilityIgnoresInvertColors /> : null}
      <Gradient colors={['rgba(5,5,5,0)', colors.bg]} angle={180} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 120 }} />
      {top ? (
        <Row style={{ position: 'absolute', top: inset + 8, left: GUTTER, right: GUTTER, justifyContent: 'flex-end' }} gap={8}>
          {top}
        </Row>
      ) : null}
    </View>
  );
}

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
  const { custom, save: saveCustom } = useProfileCustom();
  const [bannerBusy, setBannerBusy] = useState(false);

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
  // Banner colours bleed into the page background behind everything, fading out down the screen.
  const [bc1, bc2] = artStops(custom.banner_art);
  const bannerUnderlay = (
    <Gradient colors={[withAlpha(bc1, 0.42), withAlpha(bc2, 0.2), 'rgba(5,5,5,0)']} angle={180} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 760 }} />
  );
  const pins = custom.showcase.pinned ? custom.pinned_tracks : [];

  // Pick a photo from the gallery, upload it and save it as the banner straight away.
  const changeBanner = async () => {
    if (!uid || bannerBusy) return;
    setBannerBusy(true);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('Allow photo access in Settings to pick a banner.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [16, 9], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return;
      const url = await uploadBanner(uid, res.assets[0].uri, res.assets[0].mimeType);
      await saveCustom({ banner_url: url });
      setNote({ text: 'Banner updated.' });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not upload your banner.', error: true });
    } finally {
      setBannerBusy(false);
    }
  };

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

  if (!uid) {
    return (
      <Screen tabbed top={0} gap={16} underlay={bannerUnderlay} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
        <ProfileCover
          custom={custom}
          top={<IconButton icon="sliders" label="Settings" size={40} iconSize={20} bg={colors.overlay} href="/settings" />}
        />
        <EmptyState icon="users" title="Sign in to see your profile" body="Your stats, badges and listening show up here once you sign in." action="Sign in" href="/login" />
        {noteView}
      </Screen>
    );
  }

  return (
    <Screen tabbed top={0} gap={18} underlay={bannerUnderlay} backdrop={{ pattern: 'dots', mesh: 'coral' }} refreshControl={pullControl}>
      <ProfileCover
        custom={custom}
        top={
          <>
            <IconButton icon="camera" label={bannerBusy ? 'Uploading banner' : 'Change banner photo'} size={44} iconSize={20} bg={colors.overlay} onPress={() => void changeBanner()} />
            <IconButton icon="users" label="Switch account" size={44} iconSize={20} bg={colors.overlay} href="/account-switcher" />
            <IconButton icon="sliders" label="Settings" size={44} iconSize={20} bg={colors.overlay} href="/settings" />
          </>
        }
      />

      {/* Header: avatar left, actions right, overlapping the banner */}
      <Row style={{ marginTop: -(AVATAR / 2 + 4), justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <View style={{ padding: 4, borderRadius: AVATAR, backgroundColor: colors.bg }}>
          <FramedAvatar uri={isImageUri(profile?.avatar_url) ? profile?.avatar_url : null} id={uid} name={name} preset={custom.avatar_art} frame={custom.avatar_frame} size={AVATAR} />
          {lvl ? <Sticker label={`Lv ${lvl.level}`} rotate={0} style={{ position: 'absolute', right: -8, bottom: 2, borderWidth: 3, borderColor: colors.bg, height: 28 }} /> : null}
        </View>
        <Row gap={8} style={{ paddingBottom: 4 }}>
          <Button label="Edit profile" href="/edit-profile" height={44} />
          <IconButton icon="share" label="Share" size={44} iconSize={20} bg={colors.iconGhost} onPress={share} />
          <IconButton icon="more" label="More options" size={44} iconSize={22} bg={colors.iconGhost} href="/profile-more" />
        </Row>
      </Row>
      {note && note.at !== 'links' ? noteView : null}

      {/* Identity, left aligned */}
      <View style={{ gap: 4, marginTop: -6 }}>
        <T size={30} weight={800} tracking={-0.9} accessibilityRole="header">
          {name}
        </T>
        <T size={14} color={colors.textSecondary} numberOfLines={2}>
          {subtitle}
        </T>
        {joined || plan ? (
          <Row gap={8} style={{ marginTop: 8 }}>
            {joined ? <InfoPill icon="clock" label={`Joined ${joined}`} /> : null}
            {plan ? <InfoPill icon="star" label={plan} highlight /> : null}
          </Row>
        ) : null}
      </View>

      {/* Stats: flat inline numbers */}
      <Row gap={8} align="flex-start">
        <Stat value={s ? formatCount(s.followers) : '–'} label="Followers" onPress={() => router.push('/followers')} />
        <Stat value={s ? formatCount(s.following) : '–'} label="Following" onPress={() => router.push({ pathname: '/followers', params: { tab: 'following' } })} />
        <Stat value={formatCount(myPlaylists.length)} label="Playlists" onPress={() => router.push('/profile-playlists')} />
        <Stat value={s ? formatCount(s.plays) : '–'} label="Plays" />
      </Row>

      <ProfileTabs active="overview" />

      {stats.error && !s ? <ErrorState message={stats.error} onRetry={stats.reload} /> : null}

      {/* Bento: level + now playing side by side (level goes full width when nothing is playing) */}
      {lvl || nowTrack ? (
        <Row gap={12} align="stretch">
          {lvl ? (
            <Tap href="/level-perks" accessibilityLabel={`Level ${lvl.level}, ${lvl.title}. View perks`} style={{ flex: 1 }}>
              <View style={{ height: 176, borderRadius: 24, overflow: 'hidden', padding: 16, justifyContent: 'space-between' }}>
                <Gradient colors={[colors.accent, colors.accentDark]} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
                <T size={11} weight={700} tracking={1} color="rgba(255,255,255,0.85)">
                  LEVEL
                </T>
                <View>
                  <T size={52} weight={800} tracking={-2} color={colors.white} lineHeight={56}>
                    {String(lvl.level)}
                  </T>
                  <T size={15} weight={700} color={colors.white} numberOfLines={1}>
                    {lvl.title}
                  </T>
                </View>
                <View style={{ gap: 6 }}>
                  <ProgressBar value={lvl.progress} height={6} color={colors.white} track="rgba(255,255,255,0.3)" />
                  <T size={11} color="rgba(255,255,255,0.9)" numberOfLines={1}>{`${formatCount(Math.max(0, lvl.next - lvl.xp))} XP to Level ${lvl.level + 1}`}</T>
                </View>
              </View>
            </Tap>
          ) : progress.loading ? (
            <View style={{ flex: 1 }}>
              <Loading height={176} />
            </View>
          ) : null}
          {nowTrack ? (
            <Tap href="/player" accessibilityLabel={`${isLive ? 'Now playing' : 'Last played'}: ${nowTrack.title} by ${nowTrack.artist.name}. Open player`} style={{ flex: 1 }}>
              <View style={{ height: 176, borderRadius: 24, overflow: 'hidden', padding: 14, justifyContent: 'space-between', borderWidth: 1, borderColor: colors.glassBorder }}>
                <Gradient colors={[colors.accentTint, 'rgba(255,255,255,0.03)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
                <Row gap={6}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isLive ? colors.live : colors.textTertiary }} />
                  <T size={11} weight={700} tracking={1} color={colors.textSecondary}>
                    {isLive ? 'NOW PLAYING' : 'LAST PLAYED'}
                  </T>
                </Row>
                <Cover artwork={nowTrack.artwork} id={nowTrack.id} size={64} radius={14} />
                <Row gap={8} align="flex-end">
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={14} weight={700} numberOfLines={1}>
                      {nowTrack.title}
                    </T>
                    <T size={12} color={colors.textSecondary} numberOfLines={1}>
                      {nowTrack.artist.name}
                    </T>
                  </View>
                  <IconButton
                    icon={isLive && playerPlaying ? 'pause' : 'play'}
                    label={isLive && playerPlaying ? 'Pause' : 'Play'}
                    size={44}
                    bg={colors.accent}
                    color={colors.onAccent}
                    filled
                    onPress={() => (isLive ? player.toggle() : player.playTrack(nowTrack, 'Profile'))}
                  />
                </Row>
              </View>
            </Tap>
          ) : null}
        </Row>
      ) : null}

      {/* Top artists (last 30 days): ranked list */}
      {custom.showcase.taste ? (
        <>
          <SectionHeader title="Top artists this month" action="See all" href="/profile-taste" />
          {stats.loading && !s ? (
            <Loading height={100} />
          ) : s && s.topArtists.length ? (
            <Glass padding={0} style={{ paddingHorizontal: 16 }}>
              {s.topArtists.slice(0, 3).map((a, i, list) => (
                <Tap
                  key={`${a.id || a.name}-${i}`}
                  accessibilityLabel={`Number ${i + 1}, ${a.name}, ${a.plays} plays this month`}
                  onPress={a.id ? () => router.push({ pathname: '/artist', params: { id: a.id } }) : undefined}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, borderBottomWidth: i < list.length - 1 ? 1 : 0, borderBottomColor: colors.divider }}
                >
                  <T size={18} weight={800} color={i === 0 ? colors.accent : colors.textSecondary} style={{ width: 22 }}>
                    {String(i + 1)}
                  </T>
                  <Cover uri={a.image} id={a.id || a.name} size={48} radius={24} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} weight={600} numberOfLines={1}>
                      {a.name}
                    </T>
                    <T size={12} color={colors.textSecondary}>{`${a.plays} plays`}</T>
                  </View>
                </Tap>
              ))}
            </Glass>
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
              <View key={`${t.id}-${i}`} style={i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : undefined}>
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
                <View key={`${t.id}-${i}`} style={i > 0 ? { borderTopWidth: 1, borderTopColor: colors.divider } : undefined}>
                  <TrackItem track={t} list={list} context="Liked songs" showDuration={false} artRadius={22} />
                </View>
              ))}
            </Glass>
          ) : (
            <EmptyState icon="heart" title="No liked songs yet" body="Tap the heart on any song, or pin songs in Customize profile." />
          )}
        </>
      )}

      {/* Badges: horizontal cards with progress */}
      {custom.showcase.badges ? (
        <>
          <SectionHeader title="Badges" action="See all" href="/badges" />
          {badges.length ? (
            <Glass padding={0}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 20, paddingHorizontal: 16 }}>
                {badges.map((b, i) => {
                  const pct = Math.min(1, b.value / Math.max(1, b.goal));
                  return (
                    <Tap key={b.key} href="/badges" accessibilityLabel={`${b.label}: ${b.unlocked ? 'earned' : `${Math.min(b.value, b.goal)} of ${b.goal}`}`} style={{ width: 112, paddingVertical: 14, gap: 10, opacity: b.unlocked ? 1 : 0.85 }}>
                      <Art art={BADGE_ART[i % BADGE_ART.length]} size={44} radius={14} style={{ alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name={b.icon} size={22} color={colors.white} />
                      </Art>
                      <T size={14} weight={700} numberOfLines={1}>
                        {b.label}
                      </T>
                      {b.unlocked ? (
                        <T size={12} weight={600} color={colors.success}>
                          Earned
                        </T>
                      ) : (
                        <View style={{ gap: 4 }}>
                          <ProgressBar value={pct} height={4} />
                          <T size={11} color={colors.textSecondary}>{`${Math.min(b.value, b.goal)} / ${b.goal}`}</T>
                        </View>
                      )}
                    </Tap>
                  );
                })}
              </ScrollView>
            </Glass>
          ) : progress.error ? (
            <ErrorState message={progress.error} onRetry={progress.reload} />
          ) : null}
        </>
      ) : null}

      {/* Account */}
      <SectionHeader title="Your account" />
      <Glass padding={0}>
        <MenuRow icon="trophy" label="Achievements" hint="Goals and milestones" href="/achievements" />
        <MenuRow icon="star" label="Level perks" hint={lvl ? `You are Level ${lvl.level}` : undefined} href="/level-perks" />
        <MenuRow icon="edit" label="Customize profile" hint="Banner, avatar frame, showcase" href="/customize-profile" />
        <MenuRow icon="qr" label="QR code" hint="Let friends scan your profile" href="/profile-qr" />
        <MenuRow icon="users" label="Switch account" href="/account-switcher" />
        <MenuRow icon="sliders" label="Settings" href="/settings" last />
      </Glass>

      {/* Linked accounts */}
      <SectionHeader title="Linked accounts" />
      <Glass padding={4}>
        <Row style={{ minHeight: 68, paddingHorizontal: 12 }}>
          <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: withAlpha(colors.success, 0.16), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="music" size={20} color={colors.success} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={16} weight={600}>
              Spotify
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              {spotify.account === undefined ? 'Checking…' : spotify.account ? `Connected as ${spotify.account}` : spotify.configured ? 'Not connected' : 'Needs Spotify app setup'}
            </T>
          </View>
          <LinkText label={spotify.busy ? 'Connecting…' : spotify.account ? 'Disconnect' : 'Connect'} onPress={() => void toggleSpotify()} />
        </Row>
      </Glass>
      {note?.at === 'links' ? noteView : null}
    </Screen>
  );
}
