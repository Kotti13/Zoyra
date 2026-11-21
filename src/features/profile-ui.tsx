import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Animated, View, type LayoutChangeEvent } from 'react-native';

import { Art, Cover, Glass, Icon, IconButton, reduceMotionNow, Row, Sticker, T, Tap, ThemedRefreshControl, useRefresh, type IconName, type NavTarget } from '../components';
import { initialOf, isImageUri } from '../lib/profile';
import { artStops, DEFAULT_CUSTOM, FramedAvatar, ProfileBanner, type ProfileCustom } from '../lib/profile-custom';
import { colors } from '../theme/tokens';

/** Shared pieces for the profile hub screens (Profile, ProfileActivity, ProfilePlaylists, ProfileTaste, PublicProfile). */

export type ProfileTab = 'overview' | 'playlists' | 'activity' | 'taste';

const TABS: { key: ProfileTab; label: string; path: '/profile' | '/profile-playlists' | '/profile-activity' | '/profile-taste' }[] = [
  { key: 'overview', label: 'Overview', path: '/profile' },
  { key: 'playlists', label: 'Playlists', path: '/profile-playlists' },
  { key: 'activity', label: 'Activity', path: '/profile-activity' },
  { key: 'taste', label: 'Taste', path: '/profile-taste' },
];

/** The tab the indicator was last on, so the next profile page can slide it from there. */
const tabMemory: { last: ProfileTab } = { last: 'overview' };
const rememberTab = (t: ProfileTab) => {
  tabMemory.last = t;
};
const TAB_GAP = 4;
const indexOf = (k: ProfileTab) => Math.max(0, TABS.findIndex((t) => t.key === k));

/**
 * Overview · Playlists · Activity · Taste. Overview is the Profile tab; the others are pushed sub-pages that swap in place.
 * The accent pill slides between tabs (spring, native driver): it moves as soon as you tap, and the page that
 * opens picks it up from the previous tab. Under Reduce Motion it jumps instead.
 */
export function ProfileTabs({ active }: { active: ProfileTab }) {
  const idx = indexOf(active);
  const [rowW, setRowW] = useState(0);
  const [pos] = useState(() => new Animated.Value(indexOf(tabMemory.last)));
  const segW = rowW > 0 ? (rowW - TAB_GAP * (TABS.length - 1)) / TABS.length : 0;
  const translateX = useMemo(() => pos.interpolate({ inputRange: [0, 1], outputRange: [0, segW + TAB_GAP] }), [pos, segW]);

  const slideTo = useCallback(
    (i: number) => {
      if (reduceMotionNow()) pos.setValue(i);
      else Animated.spring(pos, { toValue: i, speed: 16, bounciness: 5, useNativeDriver: true }).start();
    },
    [pos],
  );

  // On focus (first open, or coming back to Overview): slide from wherever the pill last was to this page's tab.
  useFocusEffect(
    useCallback(() => {
      pos.setValue(indexOf(tabMemory.last));
      slideTo(idx);
      rememberTab(active);
    }, [active, idx, pos, slideTo]),
  );

  const open = (t: (typeof TABS)[number]) => {
    if (t.key === active) return;
    slideTo(indexOf(t.key));
    rememberTab(active);
    if (active === 'overview') router.push(t.path);
    else if (t.key === 'overview') {
      if (router.canGoBack()) router.back();
      else router.replace('/profile');
    } else router.replace(t.path);
  };
  const onLayout = (e: LayoutChangeEvent) => setRowW(e.nativeEvent.layout.width);

  return (
    <Glass padding={4}>
      <Row gap={TAB_GAP} accessibilityRole="tablist" onLayout={onLayout}>
        {segW > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, top: 0, width: segW, height: 40, borderRadius: 28, backgroundColor: colors.accent, transform: [{ translateX }] }}
          />
        ) : null}
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <Tap
              key={t.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.label}
              onPress={() => open(t)}
              style={{ flex: 1, height: 40, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: on && segW === 0 ? colors.accent : undefined }}
            >
              <T size={13} weight={on ? 700 : 500} color={on ? colors.onAccent : colors.textSecondary}>
                {t.label}
              </T>
            </Tap>
          );
        })}
      </Row>
    </Glass>
  );
}

/** Round avatar: photo when there is one, else the preset gradient (`avatar_art`) or a stable one, with the initial. */
export function PersonAvatar({ id, name, uri, preset, size = 48 }: { id?: string; name: string; uri?: string | null; preset?: string | null; size?: number }) {
  const img = isImageUri(uri) ? uri : null;
  const letter = (
    <T size={Math.round(size / 3)} weight={700} color={colors.white}>
      {initialOf(name)}
    </T>
  );
  if (!img && preset) {
    return (
      <Art art={artStops(preset)} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
        {letter}
      </Art>
    );
  }
  return (
    <Cover uri={img} id={id} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {img ? null : letter}
    </Cover>
  );
}

/** Banner in the user's gradient with overlay buttons, and their framed avatar overlapping its bottom edge. */
export function ProfileHero({
  id,
  name,
  avatar,
  custom = DEFAULT_CUSTOM,
  level,
  height = 150,
  avatarSize = 96,
  avatarHref,
  left,
  right,
}: {
  id?: string;
  name: string;
  avatar?: string | null;
  custom?: ProfileCustom;
  level?: number;
  height?: number;
  avatarSize?: number;
  /** Makes the avatar a button (e.g. to the avatar picker). */
  avatarHref?: NavTarget;
  left?: ReactNode;
  right?: ReactNode;
}) {
  const face = (
    <View>
      <FramedAvatar uri={isImageUri(avatar) ? avatar : null} id={id} name={name} preset={custom.avatar_art} frame={custom.avatar_frame} size={avatarSize} />
      {level ? <Sticker label={`Lv ${level}`} style={{ position: 'absolute', right: -6, bottom: 0, borderWidth: 3, borderColor: colors.bg, height: 28 }} /> : null}
    </View>
  );
  return (
    <View style={{ marginBottom: avatarSize / 2 - 8 }}>
      <ProfileBanner banner={custom.banner_art} uri={custom.banner_url} height={height} />
      <Row style={{ position: 'absolute', top: 12, left: 12, right: 12, justifyContent: 'space-between' }}>
        <View>{left}</View>
        <Row gap={8}>{right}</Row>
      </Row>
      <View style={{ position: 'absolute', left: 16, top: height - avatarSize / 2 - 4 }}>
        {avatarHref ? (
          <Tap href={avatarHref} accessibilityLabel="Change avatar">
            {face}
          </Tap>
        ) : (
          face
        )}
      </View>
    </View>
  );
}

/** Small round button that sits on the hero banner. */
export function HeroButton({ icon, label, href, onPress }: { icon: IconName; label: string; href?: NavTarget; onPress?: () => void }) {
  return <IconButton icon={icon} label={label} size={40} iconSize={20} bg={colors.overlay} href={href} onPress={onPress} />;
}

/** Glass strip of counters with hairline separators. Items with `onPress` are tappable. */
export function StatStrip({ items }: { items: { value: string; label: string; onPress?: () => void }[] }) {
  return (
    <Glass padding={4}>
      <Row gap={0} align="stretch">
        {items.map((st, i) => {
          const body = (
            <View style={{ alignItems: 'center', gap: 2, paddingVertical: 12 }}>
              <T size={20} weight={700}>
                {st.value}
              </T>
              <T variant="caption" weight={400} color={colors.textSecondary}>
                {st.label}
              </T>
            </View>
          );
          return (
            <View key={st.label} style={{ flex: 1, flexDirection: 'row' }}>
              {i > 0 ? <View style={{ width: 1, backgroundColor: colors.glassBorder }} /> : null}
              <View style={{ flex: 1 }}>
                {st.onPress ? (
                  <Tap onPress={st.onPress} accessibilityLabel={`${st.value} ${st.label}`}>
                    {body}
                  </Tap>
                ) : (
                  body
                )}
              </View>
            </View>
          );
        })}
      </Row>
    </Glass>
  );
}

/** Pill tag under the name (Joined 2023, Premium…). */
export function InfoPill({ icon, label, highlight }: { icon: IconName; label: string; highlight?: boolean }) {
  const fg = highlight ? colors.onAccent : colors.text;
  return (
    <Row gap={6} style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: highlight ? colors.amber : colors.iconGhost }}>
      <Icon name={icon} size={14} color={fg} />
      <T size={12} weight={600} color={fg}>
        {label}
      </T>
    </Row>
  );
}

/**
 * Pull-to-refresh for profile pages: a themed RefreshControl for `Screen`. `start` kicks off the
 * reloads; return a promise (useAsync `reload()` returns one) and the spinner stays until it settles.
 * `_loading` is kept for older callers; the promise is what drives the spinner now.
 */
export function usePullRefresh(_loading: boolean, start: () => Promise<unknown> | void) {
  const { refreshing, onRefresh } = useRefresh(start);
  return <ThemedRefreshControl refreshing={refreshing} onRefresh={onRefresh} />;
}
