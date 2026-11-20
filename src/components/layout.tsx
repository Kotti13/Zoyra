import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, KeyboardAvoidingView, PanResponder, Platform, Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent, type ScrollViewProps, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePlaybackProgress, usePlayerActions, usePlayerSelector } from '../state/player';
import { colors, glow, layout, motion, radius, shadow, withAlpha, type ArtName } from '../theme/tokens';
import { Backdrop, type BackdropPattern, type Glow, type MeshName } from './Backdrop';
import { go, IconButton, LinkText, Tap, type NavTarget } from './controls';
import type { IconName } from './icons';
import { Cover } from './media';
import { ThemedRefreshControl, useRefresh } from './refresh';
import { decelerate, springy, Stagger, useReduceMotion } from './motion';
import { EqBars, LightSweep } from './art-fx';
import { SkeletonScreen, useAfterTransition } from './Skeleton';
import { Art, Glass, Icon, Row, T, TopHighlight } from './primitives';

/* ------------------------------------------------------------------ Screen */

export type ScreenProps = {
  children?: ReactNode;
  /** Background pattern + mesh preset (see Backdrop). `false` = flat background. */
  backdrop?: { pattern?: BackdropPattern; mesh?: MeshName; glows?: Glow[]; orbs?: boolean } | false;
  bg?: string;
  /** Custom absolutely-positioned background layer drawn under the backdrop pattern (e.g. player gradient). */
  underlay?: ReactNode;
  scroll?: boolean;
  /** Gap between direct children (default 24, like the mocks). */
  gap?: number;
  /** Top padding below the safe area (mock uses 56 px incl. a 44 px status bar → 12). */
  top?: number;
  bottom?: number;
  /** Fixed, non-scrolling content under the scroll area (CTA bars, composer, mini player…). */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  /** Tab root screens: leave room for the floating mini player + tab bar. */
  tabbed?: boolean;
  /**
   * Swipe down to close (screens that slide up, like the player). `true` = drag anywhere while the
   * page is scrolled to the top; `'top'` = only drags that start in the top 180 px (use when the
   * screen has its own inner list, e.g. lyrics or a reorderable queue).
   */
  swipeDown?: boolean | 'top';
  /**
   * Render a light skeleton until the navigation transition finishes, then the real content (default on).
   * Mounting a heavy screen during the slide animation is what made navigation stutter.
   */
  defer?: boolean;
  /** Add the bottom safe-area inset under `footer` (default on). Turn off while the keyboard is open. */
  footerInset?: boolean;
  /** List entrance: direct children fade in and rise 16 px, 40 ms apart (first 8). Default on; respects Reduce Motion. */
  stagger?: boolean;
  /** Custom pull-to-refresh control for the scroll area (overrides `onRefresh`). */
  refreshControl?: ScrollViewProps['refreshControl'];
  /**
   * Swipe down to refresh (themed). Return a promise — e.g. `Promise.all([a.reload(), b.reload()])` —
   * and the spinner stays until it settles (min 400 ms). Only applies when `scroll` is on.
   */
  onRefresh?: () => Promise<unknown> | void;
  /** Force the refresh spinner on (e.g. while a reload you started elsewhere is running). */
  refreshing?: boolean;
};

const noop = () => undefined;

/** Height of the floating mini player (64+10) + tab bar (64+20). */
export const TAB_CHROME_HEIGHT = 158;

/** Root of every screen: dark bg, decorative backdrop, safe-area aware padded column. */
/** Widest the main column of a screen gets (dp); phones are narrower, so this only affects tablets and foldables. */
const CONTENT_MAX_WIDTH = 640;

export function Screen({ children, backdrop = {}, bg = colors.bg, underlay, scroll = true, gap = 24, top = 12, bottom = 24, footer, contentStyle, tabbed, stagger = true, swipeDown = false, refreshControl, onRefresh, refreshing, defer = true, footerInset = true }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const pull = useRefresh(onRefresh ?? noop);
  const ready = useAfterTransition(defer);
  const body = ready ? <Stagger enabled={stagger}>{children}</Stagger> : <SkeletonScreen />;
  const swipe = useSwipeDownToClose(swipeDown, insets.top);
  const pad: ViewStyle = {
    // Tablets, foldables and landscape: keep content in a centred column instead of stretching edge to edge.
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    paddingTop: insets.top + top,
    paddingHorizontal: layout.gutter,
    paddingBottom: footer ? 12 : bottom + insets.bottom + (tabbed ? TAB_CHROME_HEIGHT : 0),
    gap,
  };
  return (
    <Animated.View {...swipe.handlers} style={{ flex: 1, backgroundColor: bg, transform: [{ translateY: swipe.y }] }}>
      {underlay}
      {backdrop ? <Backdrop {...backdrop} /> : null}
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={[pad, contentStyle]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onScroll={swipe.onScroll}
          scrollEventThrottle={32}
          refreshControl={refreshControl ?? (onRefresh ? <ThemedRefreshControl refreshing={pull.refreshing || !!refreshing} onRefresh={pull.onRefresh} /> : undefined)}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, pad, contentStyle]}>
          {body}
        </View>
      )}
      {footer && ready ? <View style={{ paddingBottom: footerInset ? insets.bottom : 0, width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center' }}>{footer}</View> : null}
    </Animated.View>
  );
}

/** Drag-down-to-dismiss for full screens that slide up from the bottom. */
function useSwipeDownToClose(mode: boolean | 'top', safeTop: number) {
  const [y] = useState(() => new Animated.Value(0));
  const state = useRef({ atTop: true, mode, zone: safeTop + 180 });
  useEffect(() => {
    state.current.mode = mode;
    state.current.zone = safeTop + 180;
  }, [mode, safeTop]);

  // The ref is only read inside gesture callbacks (never while rendering); the compiler rule can't tell.
  // eslint-disable-next-line react-hooks/refs
  const [handlers] = useState(() => {
    const settle = () => Animated.spring(y, { toValue: 0, damping: 20, stiffness: 240, useNativeDriver: true }).start();
    return PanResponder.create({
      // Capture so it wins over buttons/rows, but only for a clear downward drag at the top of the page.
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        const st = state.current;
        if (!st.mode || !st.atTop) return false;
        if (st.mode === 'top' && g.y0 > st.zone) return false;
        return g.dy > 12 && g.dy > Math.abs(g.dx) * 1.6;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => y.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 110 || g.vy > 1) {
          Animated.timing(y, { toValue: 900, duration: 180, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => go('back'));
        } else settle();
      },
      onPanResponderTerminate: settle,
    }).panHandlers;
  });

  const onScroll = useCallback((e: { nativeEvent: { contentOffset: { y: number } } }) => {
    state.current.atTop = e.nativeEvent.contentOffset.y <= 2;
  }, []);

  return { y, handlers: mode ? handlers : {}, onScroll };
}

/* ------------------------------------------------------------------ headers */

/** Back button + centered 18/600 title + optional right action (sub-pages). */
export function ScreenHeader({ title, back = 'back', right, backIcon = 'back' }: { title?: string; back?: NavTarget | false; right?: ReactNode; backIcon?: IconName }) {
  return (
    <Row gap={8} style={{ minHeight: 44 }}>
      <View style={{ minWidth: 44 }}>{back !== false ? <IconButton icon={backIcon} label="Back" href={back} /> : null}</View>
      <T variant="section" align="center" style={{ flex: 1 }} accessibilityRole="header" numberOfLines={1}>
        {title}
      </T>
      <View style={{ minWidth: 44, alignItems: 'flex-end' }}>{right}</View>
    </Row>
  );
}

/** Large left-aligned page title (tab roots). */
export function PageTitle({ title, size = 28, right }: { title: string; size?: number; right?: ReactNode }) {
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="display" size={size} accessibilityRole="header">
        {title}
      </T>
      {right}
    </Row>
  );
}

export function SectionHeader({ title, action, href, onAction, icon }: { title: string; action?: string; href?: NavTarget; onAction?: () => void; icon?: IconName }) {
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: action ? 44 : undefined }}>
      <T variant="section" accessibilityRole="header">
        {title}
      </T>
      {action ? <LinkText label={action} href={href} onPress={onAction} size={13} icon={icon} /> : null}
    </Row>
  );
}

/** Small uppercase overline label (accent light by default). */
export function Overline({ children, color = colors.accentLight }: { children: ReactNode; color?: string }) {
  return (
    <T variant="overline" color={color}>
      {children}
    </T>
  );
}

/* ------------------------------------------------------------------ rows */

export function TrackRow({
  title,
  artist,
  art = 'coral',
  duration,
  index,
  href = '/player',
  artRadius = radius.sm,
  artSize = 48,
  right,
  active,
  onMore,
}: {
  title: string;
  artist: string;
  art?: ArtName;
  duration?: string;
  index?: number | string;
  href?: NavTarget;
  artRadius?: number;
  artSize?: number;
  right?: ReactNode;
  active?: boolean;
  onMore?: () => void;
}) {
  return (
    <Tap href={href} style={{ minHeight: 64 }} pressScale={0.98}>
      <Row style={{ minHeight: 64 }}>
        {index !== undefined ? (
          <T mono size={13} color={colors.textSecondary} align="center" style={{ width: 20 }}>
            {index}
          </T>
        ) : null}
        <Art art={art} size={artSize} radius={artRadius} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="bodyStrong" numberOfLines={1} color={active ? colors.accentLight : colors.text}>
            {title}
          </T>
          <T variant="small" color={colors.textSecondary} numberOfLines={1}>
            {artist}
          </T>
        </View>
        {duration ? (
          <T mono size={12} color={colors.textSecondary}>
            {duration}
          </T>
        ) : null}
        {right ?? <IconButton icon="more" label="More options" color={colors.textSecondary} onPress={onMore ?? (() => go('/song-options'))} />}
      </Row>
    </Tap>
  );
}

/** Settings-style row: tinted round icon, title + subtitle, trailing slot (chevron by default). */
export function ListRow({
  title,
  subtitle,
  icon,
  iconColor = colors.accentLight,
  iconBg = colors.accentTint,
  href,
  onPress,
  right,
  divider,
  minHeight = 68,
  titleColor = colors.text,
  leading,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  href?: NavTarget;
  onPress?: () => void;
  right?: ReactNode | false;
  divider?: boolean;
  minHeight?: number;
  titleColor?: string;
  leading?: ReactNode;
}) {
  const body = (
    <Row style={[{ minHeight, paddingHorizontal: 12 }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
      {leading ??
        (icon ? (
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} size={20} color={iconColor} />
          </View>
        ) : null)}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500} color={titleColor}>
          {title}
        </T>
        {subtitle ? (
          <T variant="small" color={colors.textSecondary}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right === false ? null : right ?? <Icon name="chevronRight" size={18} color={colors.textSecondary} />}
    </Row>
  );
  if (!href && !onPress) return body;
  return (
    <Tap href={href} onPress={onPress} pressScale={0.98}>
      {body}
    </Tap>
  );
}

/** Glass card that stacks ListRows with hairline dividers (pass `divider` on rows after the first). */
export function ListGroup({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <View style={{ gap: 8 }}>
      {title ? <Overline color={colors.textSecondary}>{title}</Overline> : null}
      <Glass padding={4}>{children}</Glass>
    </View>
  );
}

/* ------------------------------------------------------------------ sheets and modals */

/** Dimmed backdrop that dismisses on tap. Used by sheets and modals (routes presented as transparentModal). */
function Scrim({ onDismiss, opacity }: { onDismiss?: () => void; opacity?: Animated.AnimatedInterpolation<number> | Animated.Value }) {
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: opacity ?? 1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={onDismiss ?? (() => go('back'))}
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]}
      />
    </Animated.View>
  );
}

/** Bottom sheet: 36 px top radius, rgba(28,28,28,.92) + blur 40, glass edge, drag handle. Springs up on open (scrim fades in); drag the handle down to close. */
export function Sheet({ children, gap = 12, onDismiss, maxHeight = 760 }: { children: ReactNode; gap?: number; onDismiss?: () => void; maxHeight?: number }) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const y = useState(() => new Animated.Value(reduce ? 0 : 420))[0];
  const dismiss = useCallback(() => (onDismiss ? onDismiss() : go('back')), [onDismiss]);

  useEffect(() => {
    Animated.spring(y, { toValue: 0, damping: 22, stiffness: 220, mass: 0.9, useNativeDriver: true }).start();
  }, [y]);

  const close = useCallback(() => {
    Animated.timing(y, { toValue: 600, duration: reduce ? 0 : 200, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(dismiss);
  }, [y, reduce, dismiss]);

  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx) * 1.4,
      onPanResponderMove: (_e, g) => y.setValue(Math.max(0, g.dy)),
      onPanResponderTerminate: () => Animated.spring(y, { toValue: 0, damping: 20, stiffness: 240, useNativeDriver: true }).start(),
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 120 || g.vy > 1.1) close();
        else Animated.spring(y, { toValue: 0, damping: 20, stiffness: 240, useNativeDriver: true }).start();
      },
    }),
  );

  const [scrim] = useState(() => y.interpolate({ inputRange: [0, 420], outputRange: [1, 0], extrapolate: 'clamp' }));
  return (
    // Sheets with text fields (comments, search…) rise above the keyboard on both platforms.
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
      <Scrim onDismiss={close} opacity={scrim} />
      <Animated.View {...pan.panHandlers} style={[styles.sheet, shadow.float, { maxHeight, paddingBottom: 34 + insets.bottom / 2, transform: [{ translateY: y }] }]}>
        {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.sheet }]} />
        <TopHighlight radius={36} color={withAlpha(colors.white, 0.22)} />
        <View accessibilityRole="button" accessibilityLabel="Close" accessibilityHint="Or drag the sheet down" onAccessibilityTap={close} style={{ paddingTop: 12, paddingBottom: 4 }}>
          <View style={styles.handle} />
        </View>
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap, paddingHorizontal: 16 }}>
          {children}
        </ScrollView>
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

/** Centered modal card (Update available, Create playlist…). "Modal pop": scales from 85% with a small overshoot, 400 ms. */
export function ModalCard({ children, gap = 16, onDismiss }: { children: ReactNode; gap?: number; onDismiss?: () => void }) {
  const reduce = useReduceMotion();
  const t = useState(() => new Animated.Value(0))[0];
  const fade = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    Animated.parallel([
      Animated.timing(t, { toValue: 1, duration: reduce ? 0 : 400, easing: springy, useNativeDriver: true }),
      Animated.timing(fade, { toValue: 1, duration: reduce ? motion.fast : 160, easing: decelerate, useNativeDriver: true }),
    ]).start();
  }, [t, fade, reduce]);
  const [scale] = useState(() => t.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }));
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <Scrim onDismiss={onDismiss} opacity={fade} />
      <Animated.View style={[styles.modal, shadow.float, { gap, opacity: fade, transform: [{ scale }] }]}>
        {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.sheet }]} />
        <TopHighlight radius={32} color={withAlpha(colors.white, 0.26)} />
        {children}
      </Animated.View>
    </View>
  );
}

/* ------------------------------------------------------------------ mini player + tab bar */

/**
 * Floating mini player. Subscribes only to track / playing / buffering (not the queue, sleep timer,
 * notices…), and the progress line lives in its own <MiniProgress> so the 2 Hz position ticks never
 * re-render the bar, the tab bar or any screen.
 */
export const MiniPlayer = memo(function MiniPlayer({ accent = colors.accent }: { accent?: string }) {
  const track = usePlayerSelector((s) => s.track);
  const playing = usePlayerSelector((s) => s.playing);
  const buffering = usePlayerSelector((s) => s.buffering);
  const { toggle, next } = usePlayerActions();
  const live = playing && !buffering;
  if (!track) return null;
  return (
    <View style={[{ marginHorizontal: 12, marginBottom: 10, height: 60, borderRadius: 16 }, shadow.float, { shadowOpacity: 0.45, shadowRadius: 12 }]}>
      <View style={[styles.chrome, { borderRadius: 16, borderColor: colors.hairline, justifyContent: 'center', paddingHorizontal: 8 }]}>
        {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.glassStrong }]} />
        <Row gap={4}>
          <Tap href="/player" accessibilityLabel="Open full player" style={{ flex: 1, minWidth: 0 }}>
            <Row>
              {/* Rounded-square art with a light sweep and a tiny equaliser while playing */}
              <View style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden' }}>
                <Cover artwork={track.artwork} id={track.id} size={44} radius={8} />
                <LightSweep active={live} width={44} periodMs={5000} opacity={0.3} />
                <EqBars active={live} bars={3} height={10} barWidth={2} color={colors.white} style={{ position: 'absolute', right: 4, bottom: 4 }} />
              </View>
              <View style={{ minWidth: 0, gap: 2, flex: 1 }}>
                <T size={14} weight={600} numberOfLines={1}>
                  {track.title}
                </T>
                <T size={12} tracking={0.1} color={colors.textSecondary} numberOfLines={1}>
                  {buffering ? 'Loading…' : track.artist.name}
                </T>
              </View>
            </Row>
          </Tap>
          <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} iconSize={24} onPress={toggle} />
          <IconButton icon="next" label="Next track" iconSize={22} onPress={next} />
        </Row>
        <MiniProgress accent={accent} />
      </View>
    </View>
  );
});

function MiniProgress({ accent }: { accent: string }) {
  const { progress } = usePlaybackProgress();
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, backgroundColor: withAlpha(colors.white, 0.12) }}>
      <View style={{ width: `${progress * 100}%`, height: 2, backgroundColor: accent }} />
    </View>
  );
}

export type TabKey = 'home' | 'search' | 'library' | 'profile';
const tabs: { key: TabKey; label: string; icon: IconName; href: NavTarget }[] = [
  { key: 'home', label: 'Home', icon: 'home', href: '/' },
  { key: 'search', label: 'Search', icon: 'search', href: '/search' },
  { key: 'library', label: 'Library', icon: 'library', href: '/library' },
  { key: 'profile', label: 'Profile', icon: 'user', href: '/profile' },
];

const TAB_GAP = 4;
const TAB_PAD = 6;
const ORB = 52;
const ORB_GLOSS = [withAlpha(colors.white, 0.3), withAlpha(colors.white, 0)] as const;
const ORB_GLOSS_AT = [0, 0.55] as const;

/**
 * Cinematic dock: four icon-only tabs in a dark frosted pill. The active tab sits in a 52 px glowing
 * accent circle that glides to the tapped tab (200 ms, native driver; instant with Reduce Motion).
 */
export const TabBar = memo(function TabBar({ active, onSelect, accent = colors.accent }: { active: TabKey; onSelect?: (k: TabKey) => void; accent?: string }) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [inner, setInner] = useState(0);
  const index = Math.max(0, tabs.findIndex((t) => t.key === active));
  const unit = (inner - TAB_GAP * (tabs.length - 1)) / tabs.length;
  const target = index * (unit + TAB_GAP) + (unit - ORB) / 2;
  const x = useState(() => new Animated.Value(0))[0];
  const placed = useRef(false);

  useEffect(() => {
    if (inner <= 0) return;
    if (!placed.current || reduce) {
      placed.current = true;
      x.setValue(target);
      return;
    }
    Animated.timing(x, { toValue: target, duration: motion.fast, easing: decelerate, useNativeDriver: true }).start();
  }, [target, inner, reduce, x]);

  const onLayout = (e: LayoutChangeEvent) => setInner(e.nativeEvent.layout.width - TAB_PAD * 2);

  return (
    <View
      style={[
        { marginHorizontal: 16, marginBottom: Math.max(20, insets.bottom), height: 64, borderRadius: 32 },
        shadow.float,
        { shadowOpacity: 0.55, shadowRadius: 19, shadowOffset: { width: 0, height: 14 } },
      ]}
    >
      <View
        accessibilityRole="tablist"
        onLayout={onLayout}
        style={[styles.chrome, { borderColor: withAlpha(colors.white, 0.18), padding: TAB_PAD, flexDirection: 'row', gap: TAB_GAP }]}
      >
        {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.glassStrong }]} />
        <TopHighlight radius={32} color={withAlpha(colors.white, 0.26)} />
        {inner > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              { position: 'absolute', top: TAB_PAD, left: TAB_PAD, width: ORB, height: ORB, borderRadius: ORB / 2 },
              glow(accent, 14, 0.55),
              { transform: [{ translateX: x }] },
            ]}
          >
            <View style={[StyleSheet.absoluteFill, { borderRadius: ORB / 2, backgroundColor: accent, overflow: 'hidden' }]}>
              <LinearGradient colors={ORB_GLOSS} locations={ORB_GLOSS_AT} style={StyleSheet.absoluteFill} />
              <TopHighlight radius={ORB / 2} color={withAlpha(colors.white, 0.5)} />
            </View>
          </Animated.View>
        ) : null}
        {tabs.map((t) => (
          <TabButton key={t.key} tab={t} on={t.key === active} placed={inner > 0} accent={accent} onSelect={onSelect} />
        ))}
      </View>
    </View>
  );
});

/** One dock button. Memoized: a tab switch re-renders only the two buttons whose `on` flipped. */
const TabButton = memo(function TabButton({
  tab: t,
  on,
  placed,
  accent,
  onSelect,
}: {
  tab: (typeof tabs)[number];
  on: boolean;
  placed: boolean;
  accent: string;
  onSelect?: (k: TabKey) => void;
}) {
  const onPress = useCallback(() => (onSelect ? onSelect(t.key) : go(t.href)), [onSelect, t]);
  return (
    <Tap
      accessibilityRole="tab"
      accessibilityLabel={t.label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={styles.tab}
    >
      <View style={[styles.tabIcon, { backgroundColor: on && !placed ? accent : undefined }]}>
        <Icon name={t.icon} size={24} color={on ? colors.onAccent : colors.textSecondary} glow={false} />
      </View>
    </Tap>
  );
});

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 36,
    borderTopRightRadius: 36,
    overflow: 'hidden',
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: withAlpha(colors.white, 0.16),
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.handle, marginBottom: 8 },
  modal: {
    borderRadius: 32,
    overflow: 'hidden',
    paddingTop: 24,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: withAlpha(colors.white, 0.18),
  },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  tabIcon: { width: ORB, height: ORB, borderRadius: ORB / 2, alignItems: 'center', justifyContent: 'center' },
  /** Floating chrome (mini player, tab bar): rgba(20,20,20,.82–.88) + blur 24. */
  chrome: {
    flex: 1,
    borderRadius: 32,
    overflow: 'hidden',
    borderWidth: 1,
  },
});
