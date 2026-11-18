/**
 * Building blocks for the Messages inbox (src/app/messages.tsx), in Zoyra's own cinematic style:
 * frosted-glass surfaces, red accent pills with glow, squircle avatars, glass note bubbles.
 *  - SwipeRow: swipeable row with round glass / accent action buttons.
 *  - InboxTabs: accent pill chips (Chip look) with inline counts.
 *  - NoteFace: "Now playing with friends" item: frosted-glass speech bubble (♪ song / note) above a round photo.
 *  - PresenceFace: same item without a bubble (people without a note), avatars aligned with NoteFace.
 *  - GlassCard: blur-free gradient glass (cheap enough to repeat: cards, pills, skeletons).
 *  - ChatContextMenu: long-press menu (MsgLongPress): dimmed screen, the pressed row lifted in place on a
 *    glass card, and a glass action list under it (above it when there's no room below).
 *  - InboxSkeleton, RowPill, CountPill, OnlineDot.
 *
 * Swipes use PanResponder + Animated (native driver); react-native-gesture-handler / reanimated aren't
 * installed. A row only claims clearly horizontal drags (|dx| > 12 and |dx| > 2|dy|), so vertical scrolling
 * and the horizontal strips above keep working. One row is open at a time.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cover, Icon, reduceMotionNow, SkeletonBlock, T, Tap, TopHighlight, useReduceMotion } from '../components';
import type { IconName } from '../components/icons';
import { useHighContrast } from './a11y';
import { colors, glow, withAlpha } from '../theme/tokens';

export const ONLINE_GREEN = '#2EE59D';
/** Approximate colour under the glass list (ring around online dots so they read as cut-outs). */
const GLASS_RING = '#141414';

/* ================================================================== glass */

const GLASS_STOPS = [colors.glassTop, colors.glassMid, colors.glassTint] as const;
const GLASS_LOCATIONS = [0, 0.6, 1] as const;
const GLASS_START = { x: 0.2, y: 0 } as const;
const GLASS_END = { x: 0.8, y: 1 } as const;

/**
 * Glass look without a BlurView: 145deg white sheen (14% → 4% → faint red tint), 1px 16% border and the
 * inset top highlight. Use for repeated surfaces (cards in a strip, pills, skeletons); one real `Glass`
 * per big container is enough for the frosted feel.
 */
export function GlassCard({ children, radius: r = 22, padding, style, tint }: { children?: ReactNode; radius?: number; padding?: number; style?: StyleProp<ViewStyle>; tint?: string }) {
  const [contrast] = useHighContrast();
  return (
    <View style={[{ borderRadius: r, overflow: 'hidden', borderWidth: 1, borderColor: contrast ? withAlpha(colors.white, 0.45) : colors.glassBorder, padding }, style]}>
      <LinearGradient colors={GLASS_STOPS} locations={GLASS_LOCATIONS} start={GLASS_START} end={GLASS_END} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {tint ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}
      <TopHighlight radius={r} />
      {children}
    </View>
  );
}

/* ================================================================== small pieces */

/** Green presence dot with a dark ring. */
export function OnlineDot({ size = 12, ring = GLASS_RING, style }: { size?: number; ring?: string; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: ONLINE_GREEN, borderWidth: Math.max(2, size / 5), borderColor: ring }, style]} />;
}

/** Accent count pill with a soft red glow (unread counts). */
export function CountPill({ count, light }: { count: number; light?: boolean }) {
  return (
    <View
      style={[
        { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: light ? withAlpha(colors.white, 0.24) : colors.accent },
        light ? null : glow(colors.accent, 8, 0.6),
      ]}
    >
      <T size={11} weight={700} color={colors.onAccent} maxFontSizeMultiplier={1.4}>
        {count > 99 ? '99+' : count}
      </T>
    </View>
  );
}

/** Small pill at the end of a chat row's preview ("Blocked", "Request sent"). */
export function RowPill({ label, color = colors.peach, bg = withAlpha(colors.white, 0.1) }: { label: string; color?: string; bg?: string }) {
  return (
    <View style={{ height: 20, paddingHorizontal: 8, borderRadius: 10, backgroundColor: bg, justifyContent: 'center' }}>
      <T size={10} weight={700} tracking={0.4} color={color} maxFontSizeMultiplier={1.3}>
        {label}
      </T>
    </View>
  );
}

/* ================================================================== swipe row */

/** `color` fills the round button; `fg` colours its icon (default white). */
export type SwipeAction = { key: string; label: string; icon: IconName; color: string; fg?: string; onPress: () => void };

const ACTION_W = 68;
const ACTION_DOT = 44;
/** Extra drag allowed past the actions before it stops (rubber band). */
const OVERDRAG = 24;

let openRow: { close: () => void } | null = null;

/** Closes whichever row is swiped open (e.g. when the list scrolls or the tab changes). */
export function closeOpenSwipeRow() {
  openRow?.close();
}

/**
 * A row with actions behind it: swipe right reveals `left` (leading) actions, swipe left reveals `right`
 * (trailing) actions, drawn as round glass / accent buttons with a caption. The action buttons are hidden
 * from screen readers; expose the same actions on the row's own element with `accessibilityActions`.
 * Lives inside a glass list card (clips to its own bounds; no full-bleed margins).
 */
export function SwipeRow({ left = [], right = [], children, disabled }: { left?: SwipeAction[]; right?: SwipeAction[]; children: ReactNode; disabled?: boolean }) {
  const [x] = useState(() => new Animated.Value(0));
  const st = useRef({ offset: 0, L: left.length * ACTION_W, R: right.length * ACTION_W, disabled: !!disabled });
  useEffect(() => {
    st.current.L = left.length * ACTION_W;
    st.current.R = right.length * ACTION_W;
    st.current.disabled = !!disabled;
  }, [left.length, right.length, disabled]);

  // Created once; everything mutable is read from `st` inside gesture callbacks only (never while rendering).
  // eslint-disable-next-line react-hooks/refs
  const [ctl] = useState(() => {
    const self = {
      close: () => to(0),
    };
    function to(v: number) {
      st.current.offset = v;
      if (reduceMotionNow()) x.setValue(v);
      else Animated.spring(x, { toValue: v, damping: 24, stiffness: 280, overshootClamping: true, useNativeDriver: true }).start();
      if (v !== 0) {
        if (openRow && openRow !== self) openRow.close();
        openRow = self;
      } else if (openRow === self) openRow = null;
    }
    const clamp = (v: number) => Math.max(st.current.R ? -st.current.R - OVERDRAG : 0, Math.min(st.current.L ? st.current.L + OVERDRAG : 0, v));
    const pan = PanResponder.create({
      // While open, a tap on the row closes it instead of opening the chat.
      onStartShouldSetPanResponderCapture: () => st.current.offset !== 0,
      onMoveShouldSetPanResponder: (_e, g) => !st.current.disabled && Math.abs(g.dx) > 12 && Math.abs(g.dx) > 2 * Math.abs(g.dy),
      onPanResponderGrant: () => {
        if (openRow && openRow !== self) openRow.close();
        x.stopAnimation();
      },
      onPanResponderMove: (_e, g) => x.setValue(clamp(st.current.offset + g.dx)),
      onPanResponderRelease: (_e, g) => {
        if (st.current.offset !== 0 && Math.abs(g.dx) < 6) {
          to(0);
          return;
        }
        const v = clamp(st.current.offset + g.dx);
        const { L, R } = st.current;
        if (L && (v > L / 2 || (g.vx > 0.5 && v > 0))) to(L);
        else if (R && (v < -R / 2 || (g.vx < -0.5 && v < 0))) to(-R);
        else to(0);
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderTerminate: () => to(st.current.offset),
    });
    return { self, to, handlers: pan.panHandlers };
  });

  useEffect(
    () => () => {
      if (openRow === ctl.self) openRow = null;
    },
    [ctl],
  );

  const run = (a: SwipeAction) => {
    ctl.to(0);
    a.onPress();
  };

  const strip = (list: SwipeAction[], side: 'left' | 'right') =>
    list.length ? (
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: list.length * ACTION_W,
          flexDirection: 'row',
          ...(side === 'right' ? { left: '100%' } : { right: '100%' }),
          transform: [{ translateX: x }],
        }}
      >
        {list.map((a) => {
          const solid = a.color.startsWith('#');
          return (
            <Tap key={a.key} onPress={() => run(a)} pressScale={0.92} accessibilityLabel={a.label} style={{ width: ACTION_W, alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <View
                style={[
                  { width: ACTION_DOT, height: ACTION_DOT, borderRadius: ACTION_DOT / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: a.color },
                  solid ? glow(a.color, 12, 0.55) : { borderWidth: 1, borderColor: colors.glassBorder },
                ]}
              >
                <TopHighlight radius={ACTION_DOT / 2} color={withAlpha(colors.white, solid ? 0.45 : 0.28)} />
                <Icon name={a.icon} size={19} color={a.fg ?? colors.white} strokeWidth={2} />
              </View>
              <T size={10} weight={600} color={colors.textSecondary} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {a.label}
              </T>
            </Tap>
          );
        })}
      </Animated.View>
    ) : null;

  return (
    <View style={{ overflow: 'hidden' }}>
      {strip(left, 'left')}
      {strip(right, 'right')}
      <Animated.View {...ctl.handlers} style={{ paddingHorizontal: 12, transform: [{ translateX: x }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

/* ================================================================== tabs */

export type InboxTab<K extends string> = { key: K; label: string; badge?: number; onPress?: () => void };

/**
 * Filter chips in the app's Chip style: selected = accent fill with a red glow and glossy top edge;
 * others = gradient glass with a 14% outline. Counts sit inline as small pills. Scrolls horizontally.
 */
export function InboxTabs<K extends string>({ tabs, active, onChange }: { tabs: InboxTab<K>[]; active: K; onChange: (k: K) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="tablist" style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <Tap
            key={t.key}
            onPress={() => (t.onPress ? t.onPress() : onChange(t.key))}
            pressScale={0.95}
            accessibilityRole={t.onPress ? 'link' : 'tab'}
            accessibilityState={t.onPress ? undefined : { selected: on }}
            accessibilityLabel={t.badge ? `${t.label}, ${t.badge}` : t.label}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <View
              style={[
                { height: 34, paddingHorizontal: 15, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 7, overflow: on ? undefined : 'hidden' },
                on ? [{ backgroundColor: colors.accent }, glow(colors.accent, 11, 0.5)] : { borderWidth: 1, borderColor: colors.chipOutline },
              ]}
            >
              {on ? (
                <TopHighlight radius={17} color={withAlpha(colors.white, 0.45)} />
              ) : (
                <LinearGradient colors={[withAlpha(colors.white, 0.1), withAlpha(colors.white, 0.02)]} start={GLASS_START} end={GLASS_END} style={StyleSheet.absoluteFill} pointerEvents="none" />
              )}
              <T size={14} weight={on ? 600 : 500} color={on ? colors.onAccent : colors.text}>
                {t.label}
              </T>
              {t.badge ? <CountPill count={t.badge} light={on} /> : null}
            </View>
          </Tap>
        );
      })}
    </ScrollView>
  );
}

/* ================================================================== faces */

/** Avatar (initial when there's no picture). Round by default; pass `radius` for a squircle. */
export function RoundFace({ id, name, uri, size, radius }: { id?: string; name?: string | null; uri?: string | null; size: number; radius?: number }) {
  return (
    <Cover uri={uri} id={id} size={size} radius={radius ?? size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {uri ? null : (
        <T size={Math.round(size / 2.8)} weight={700} color={colors.white}>
          {(name?.trim()[0] ?? '?').toUpperCase()}
        </T>
      )}
    </Cover>
  );
}

/**
 * "Now playing with friends" strip geometry ("glass bubble above photo"). Every item is NOTE_ITEM_W wide and
 * reserves the same fixed bubble row above its avatar (bottom-aligned, clipped), so avatars line up across
 * items with or without a bubble and nothing can rise above the strip (under the Search pill).
 */
export const NOTE_ITEM_W = 96;
const NOTE_AVATAR = 64;
/** Max system font scale for strip text (the bubble row is sized for 2 lines at this cap). */
const NOTE_FONT_CAP = 1.2;
const BUBBLE_LINE = 14;
const BUBBLE_PAD_V = 8;
const BUBBLE_PAD_H = 10;
const BUBBLE_RADIUS = 16;
/** Tail: a rotated square, only its lower half shows (clipped) below the bubble. */
const TAIL_SIDE = 10;
const TAIL_H = 6;
/** 2 lines at the font cap + padding + border. */
const BUBBLE_MAX_H = Math.ceil(BUBBLE_LINE * NOTE_FONT_CAP * 2) + BUBBLE_PAD_V * 2 + 2;
const BUBBLE_ROW_H = BUBBLE_MAX_H + TAIL_H + 2;
/** Tail fill ≈ the bubble's lower gradient (white 4% + faint red tint); it never overlaps the bubble. */
const TAIL_FILL = 'rgba(255,236,236,0.06)';

/** Round 64px avatar: subtle green ring + dot when online, accent "+" badge when `add`. */
function StripAvatar({ id, name, uri, online, add, dim, badge }: { id?: string; name: string; uri?: string | null; online?: boolean; add?: boolean; dim?: boolean; badge?: ReactNode }) {
  const ring = NOTE_AVATAR + 8;
  return (
    <View style={{ width: ring, height: ring, alignItems: 'center', justifyContent: 'center' }}>
      <View pointerEvents="none" style={{ position: 'absolute', width: ring, height: ring, borderRadius: ring / 2, borderWidth: 1.5, borderColor: online ? withAlpha(ONLINE_GREEN, 0.5) : 'transparent' }} />
      <View style={{ opacity: dim ? 0.7 : 1 }}>
        <RoundFace id={id} name={name} uri={uri} size={NOTE_AVATAR} />
      </View>
      {add ? (
        <View style={[{ position: 'absolute', right: 2, bottom: 2, width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.bg, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }, glow(colors.accent, 8, 0.5)]}>
          <Icon name="plus" size={12} color={colors.onAccent} strokeWidth={2.8} />
        </View>
      ) : online ? (
        <OnlineDot size={15} ring={colors.bg} style={{ position: 'absolute', right: 3, bottom: 3 }} />
      ) : null}
      {/* FOREVER: badge (strip avatars receive it through the `badge` prop) */}
      {badge}
    </View>
  );
}

/** Frosted speech bubble (blur-free glass, faint red glow edge) with a centred tail pointing down. */
function NoteBubble({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const [contrast] = useHighContrast();
  const border = contrast ? withAlpha(colors.white, 0.45) : colors.glassBorder;
  return (
    <View style={{ maxWidth: NOTE_ITEM_W, alignItems: 'center' }}>
      <View style={[{ borderRadius: BUBBLE_RADIUS, backgroundColor: 'transparent' }, muted ? null : glow(colors.accent, 8, 0.22)]}>
        <View style={{ maxWidth: NOTE_ITEM_W, maxHeight: BUBBLE_MAX_H, borderRadius: BUBBLE_RADIUS, overflow: 'hidden', borderWidth: 1, borderColor: border, paddingVertical: BUBBLE_PAD_V, paddingHorizontal: BUBBLE_PAD_H, opacity: muted ? 0.8 : 1 }}>
          <LinearGradient colors={GLASS_STOPS} locations={GLASS_LOCATIONS} start={GLASS_START} end={GLASS_END} style={StyleSheet.absoluteFill} pointerEvents="none" />
          {muted ? null : <View pointerEvents="none" style={{ position: 'absolute', left: 10, right: 10, bottom: 0, height: 1, backgroundColor: withAlpha(colors.accent, 0.35) }} />}
          <TopHighlight radius={BUBBLE_RADIUS} />
          {children}
        </View>
      </View>
      <View pointerEvents="none" style={{ width: TAIL_SIDE * 2, height: TAIL_H, marginTop: -1, overflow: 'hidden', alignItems: 'center' }}>
        <View style={{ width: TAIL_SIDE, height: TAIL_SIDE, marginTop: -TAIL_SIDE / 2, transform: [{ rotate: '45deg' }], backgroundColor: TAIL_FILL, borderWidth: 1, borderColor: border }} />
      </View>
    </View>
  );
}

/** Fixed-height, bottom-aligned bubble row (empty for people without a note). */
function BubbleRow({ children }: { children?: ReactNode }) {
  return <View style={{ width: NOTE_ITEM_W, height: BUBBLE_ROW_H, justifyContent: 'flex-end', alignItems: 'center', overflow: 'hidden' }}>{children}</View>;
}

function StripName({ children }: { children: string }) {
  return (
    <T size={12} color={colors.textSecondary} numberOfLines={1} maxFontSizeMultiplier={NOTE_FONT_CAP} style={{ maxWidth: NOTE_ITEM_W - 4, marginTop: 4, textAlign: 'center' }}>
      {children}
    </T>
  );
}

/**
 * Note in the strip: a frosted-glass speech bubble above the person's round photo, first name below.
 * Bubble content: song + text → "♪ title" (accent) over 1 line of text; song only → up to 2 lines of
 * "♪ title · artist"; text only → up to 2 lines. `muted` greys a placeholder ("Share a note"), `add` puts
 * an accent "+" on the avatar (your note when you have none), `online` the green ring + dot.
 */
export function NoteFace({
  id,
  name,
  uri,
  note,
  song,
  songLine,
  caption,
  online,
  muted,
  add,
  badge,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  id?: string;
  name: string;
  uri?: string | null;
  note?: string | null;
  /** Song title on the note. */
  song?: string | null;
  /** "title · artist" (used when the note has no text); falls back to `song`. */
  songLine?: string | null;
  caption: string;
  online?: boolean;
  muted?: boolean;
  add?: boolean;
  /** Overlay on the avatar (e.g. the Forever ∞ chip). */
  badge?: ReactNode;
  onPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  const text = note?.trim() ? note : null;
  const hasBubble = !!(text || song);
  return (
    <Tap onPress={onPress} disabled={!onPress} pressScale={0.96} accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint} style={{ width: NOTE_ITEM_W, alignItems: 'center' }}>
      <BubbleRow>
        {hasBubble ? (
          <NoteBubble muted={muted}>
            {song ? (
              <T size={11} lineHeight={BUBBLE_LINE} weight={600} color={colors.accentLight} numberOfLines={text ? 1 : 2} ellipsizeMode="tail" maxFontSizeMultiplier={NOTE_FONT_CAP}>
                {`♪ ${text ? song : (songLine ?? song)}`}
              </T>
            ) : null}
            {text ? (
              <T size={11} lineHeight={BUBBLE_LINE} weight={500} color={muted ? colors.textSecondary : colors.text} numberOfLines={song ? 1 : 2} ellipsizeMode="tail" maxFontSizeMultiplier={NOTE_FONT_CAP}>
                {text}
              </T>
            ) : null}
          </NoteBubble>
        ) : null}
      </BubbleRow>
      <StripAvatar id={id} name={name} uri={uri} online={online} add={add} dim={add && muted} badge={badge} />
      <StripName>{caption}</StripName>
    </Tap>
  );
}

/** Person without a note in the strip: same geometry as NoteFace (empty bubble row), so avatars align. */
export function PresenceFace({ id, name, uri, caption, online, badge, onPress, accessibilityLabel }: { id?: string; name: string; uri?: string | null; caption: string; online?: boolean; badge?: ReactNode; onPress?: () => void; accessibilityLabel: string }) {
  return (
    <Tap onPress={onPress} disabled={!onPress} pressScale={0.96} accessibilityLabel={accessibilityLabel} style={{ width: NOTE_ITEM_W, alignItems: 'center' }}>
      <BubbleRow />
      <StripAvatar id={id} name={name} uri={uri} online={online} badge={badge} />
      <StripName>{caption}</StripName>
    </Tap>
  );
}

/* ================================================================== skeletons */

/** Placeholder chat rows while the inbox loads: one glass card of squircle + two-line rows. */
export function InboxSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <GlassCard radius={26} style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      <View accessibilityRole="progressbar" accessibilityLabel="Loading chats">
        {Array.from({ length: rows }, (_, i) => (
          <View key={i} style={{ height: 72, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: colors.hairline, marginLeft: 0 }}>
            <SkeletonBlock width={52} height={52} r={17} />
            <View style={{ flex: 1, gap: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <SkeletonBlock width={`${48 - ((i * 11) % 22)}%`} height={13} />
                <SkeletonBlock width={28} height={10} />
              </View>
              <SkeletonBlock width={`${72 - ((i * 7) % 30)}%`} height={11} />
            </View>
          </View>
        ))}
      </View>
    </GlassCard>
  );
}

/* ================================================================== long-press menu */

/** Window rect of the pressed row (measureInWindow). */
export type RowRect = { x: number; y: number; width: number; height: number };

export type ContextMenuItem = {
  key: string;
  label: string;
  /** Second line ("Limit what they can see"). */
  sub?: string;
  icon: IconName;
  tone?: 'danger' | 'warn';
  disabled?: boolean;
  /** Extra element after the label (e.g. the Forever chip). */
  badge?: ReactNode;
  onPress: () => void;
};

const MENU_ROW_H = 50;

/**
 * Long-press menu for a chat row (MsgLongPress): the screen dims, the row is drawn again on a glass card at
 * the same spot (lifted with a small scale-in), and the actions sit on a glass card below it (or above it
 * when it wouldn't fit). Tapping outside, Android back or an action closes it. Rendered in a Modal.
 */
export function ChatContextMenu({ rect, row, items, title, onClose }: { rect: RowRect | null; row: ReactNode; items: ContextMenuItem[]; title: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { height: H, width: W } = useWindowDimensions();
  const reduce = useReduceMotion();
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) t.setValue(1);
    else Animated.timing(t, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [t, reduce]);
  const [scale] = useState(() => t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }));
  const [menuY] = useState(() => t.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }));

  const left = 16;
  const width = W - 32;
  const cardPad = 6;
  const rowTop = rect ? rect.y - cardPad : insets.top + 80;
  const rowH = (rect?.height ?? 74) + cardPad * 2;
  const menuH = items.reduce((h, it) => h + (it.sub ? MENU_ROW_H + 16 : MENU_ROW_H), 8);
  const below = rowTop + rowH + 10;
  const fitsBelow = below + menuH <= H - insets.bottom - 16;
  // Not enough room below: menu above the row, or (tiny screens) row moved up so both fit.
  const fitsAbove = rowTop - 10 - menuH >= insets.top + 8;
  const rowY = fitsBelow || fitsAbove ? rowTop : Math.max(insets.top + 8, H - insets.bottom - 16 - menuH - 10 - rowH);
  const menuTop = fitsBelow || !fitsAbove ? rowY + rowH + 10 : rowTop - 10 - menuH;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close menu" onPress={onClose} style={StyleSheet.absoluteFill}>
        {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={18} style={StyleSheet.absoluteFill} /> : null}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.62)' }]} />
      </Pressable>
      <Animated.View
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{ position: 'absolute', left, width, top: rowY, borderRadius: 26, overflow: 'hidden', paddingHorizontal: 12, paddingVertical: cardPad, backgroundColor: 'rgba(40,40,40,0.8)', borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), transform: [{ scale }] }}
      >
        <TopHighlight radius={26} />
        {row}
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel={`${title} options`}
        style={{ position: 'absolute', left, width, top: menuTop, borderRadius: 26, overflow: 'hidden', paddingHorizontal: 16, paddingVertical: 4, backgroundColor: 'rgba(32,32,32,0.94)', borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), opacity: t, transform: [{ translateY: menuY }] }}
      >
        <TopHighlight radius={26} />
        {items.map((it, i) => {
          const fg = it.tone === 'danger' ? colors.accentLight : colors.text;
          return (
            <Tap
              key={it.key}
              onPress={() => {
                onClose();
                it.onPress();
              }}
              disabled={it.disabled}
              pressScale={0.98}
              accessibilityLabel={it.sub ? `${it.label}. ${it.sub}` : it.label}
              accessibilityState={{ disabled: !!it.disabled }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: it.sub ? MENU_ROW_H + 16 : MENU_ROW_H, paddingHorizontal: 4, borderTopWidth: i ? 1 : 0, borderTopColor: withAlpha(colors.white, 0.07), opacity: it.disabled ? 0.55 : 1 }}
            >
              <Icon name={it.icon} size={20} color={fg} strokeWidth={1.8} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <T size={15} weight={600} color={fg} numberOfLines={1}>
                    {it.label}
                  </T>
                  {it.badge}
                </View>
                {it.sub ? (
                  <T size={12} color={it.tone === 'warn' ? colors.gold : colors.textSecondary} numberOfLines={2}>
                    {it.sub}
                  </T>
                ) : null}
              </View>
            </Tap>
          );
        })}
      </Animated.View>
    </Modal>
  );
}
