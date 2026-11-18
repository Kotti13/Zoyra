import { LinearGradient } from 'expo-linear-gradient';
import { router, type Href } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { colors, fonts, glow, radius, shadow, withAlpha } from '../theme/tokens';
import type { IconName } from './icons';
import { PopRing, reduceMotionNow, usePop, useReduceMotion } from './motion';
import { useScreenReaderHints } from '../lib/a11y';
import { Glass, Icon, Row, T, TopHighlight, useStatusColor, useStatusColors } from './primitives';

/* ------------------------------------------------------------------ navigation helper */

export type NavTarget = Href | 'back';

export function go(to: NavTarget) {
  if (to === 'back') {
    if (router.canGoBack()) router.back();
    else router.replace('/');
    return;
  }
  router.push(to);
}

export type TapProps = Omit<PressableProps, 'style' | 'children'> & {
  href?: NavTarget;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Scale while pressed (default 0.96). Use ~0.98 for full-width rows; 1 disables the scale. */
  pressScale?: number;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
/** Opacity while pressed. */
const PRESS_DIM = 0.82;
const PRESS_IN = { speed: 48, bounciness: 0, useNativeDriver: true } as const;
const PRESS_OUT = { speed: 22, bounciness: 7, useNativeDriver: true } as const;

/**
 * Pressable that navigates when given `href`, with spring press feedback: scales to `pressScale`
 * and dims while held, then springs back. Native-driver only, no re-render per press; the two
 * Animated values are created once per mount. Under Reduce Motion only the opacity changes.
 */
export function Tap({ href, onPress, onPressIn, onPressOut, style, children, accessibilityRole, accessibilityHint, pressScale = 0.96, ...rest }: TapProps) {
  const [hints] = useScreenReaderHints();
  const flat = StyleSheet.flatten(style);
  // Respect a caller's own opacity (e.g. a dimmed locked item): rest there, dim relative to it.
  const baseOpacity = typeof flat?.opacity === 'number' ? flat.opacity : 1;
  const baseTransform = Array.isArray(flat?.transform) ? flat.transform : null;
  const [scale] = useState(() => new Animated.Value(1));
  const [opacity] = useState(() => new Animated.Value(baseOpacity));
  useEffect(() => {
    opacity.setValue(baseOpacity);
  }, [opacity, baseOpacity]);

  return (
    <AnimatedPressable
      accessibilityRole={accessibilityRole ?? (href ? 'link' : 'button')}
      accessibilityHint={hints ? accessibilityHint : undefined}
      onPress={(e) => {
        onPress?.(e);
        if (href) go(href);
      }}
      onPressIn={(e) => {
        const reduce = reduceMotionNow();
        Animated.parallel([
          Animated.timing(opacity, { toValue: baseOpacity * PRESS_DIM, duration: 90, useNativeDriver: true }),
          ...(reduce || pressScale === 1 ? [] : [Animated.spring(scale, { toValue: pressScale, ...PRESS_IN })]),
        ]).start();
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: baseOpacity, duration: 160, useNativeDriver: true }),
          Animated.spring(scale, { toValue: 1, ...PRESS_OUT }),
        ]).start();
        onPressOut?.(e);
      }}
      style={[style, { opacity, transform: [...(baseTransform ?? []), { scale }] }]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

/* ------------------------------------------------------------------ buttons */

export type ButtonVariant = 'primary' | 'secondary' | 'glass' | 'destructive' | 'light' | 'disabled';

export function Button({
  label,
  variant = 'primary',
  icon,
  href,
  onPress,
  style,
  height = 48,
  accent = colors.accent,
}: {
  label: string;
  variant?: ButtonVariant;
  icon?: IconName;
  href?: NavTarget;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  height?: number;
  accent?: string;
}) {
  const v = {
    primary: { bg: accent, fg: colors.onAccent, border: undefined, size: 16 },
    secondary: { bg: 'transparent', fg: colors.accentLight, border: colors.accent, size: 16 },
    glass: { bg: undefined, fg: colors.text, border: undefined, size: 15 },
    destructive: { bg: 'transparent', fg: colors.error, border: colors.error, size: 16 },
    light: { bg: colors.text, fg: colors.playerBg, border: undefined, size: 15 },
    disabled: { bg: colors.bgTertiary, fg: colors.textTertiary, border: undefined, size: 16 },
  }[variant];

  // Toggle-style buttons (Follow → Following, Save → Saved) pop when their label changes, with sparkles on "on".
  const pop = usePop(label);
  const toggledOn = /^(following|saved|added|liked|subscribed|in your library)$/i.test(label.trim());
  const content = (
    <Animated.View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', height: '100%', paddingHorizontal: 20, transform: [{ scale: pop }] }}>
      {icon ? <Icon name={icon} size={20} color={v.fg} /> : null}
      <T weight={variant === 'light' ? 700 : 600} size={v.size} color={v.fg}>
        {label}
      </T>
    </Animated.View>
  );

  const r = height / 2;
  const primary = variant === 'primary';
  return (
    <Tap
      href={variant === 'disabled' ? undefined : href}
      onPress={variant === 'disabled' ? undefined : onPress}
      disabled={variant === 'disabled'}
      accessibilityState={{ disabled: variant === 'disabled' }}
      style={[{ height, borderRadius: r }, primary && [shadow.float, glow(accent, 15, 0.45), { elevation: 6 }], style]}
    >
      {variant === 'glass' ? (
        <Glass radius={r} style={StyleSheet.absoluteFill}>
          {null}
        </Glass>
      ) : (
        <View
          style={[
            StyleSheet.absoluteFill,
            { borderRadius: r, backgroundColor: v.bg, overflow: 'hidden' },
            v.border ? { borderWidth: 1, borderColor: v.border } : null,
          ]}
        >
          {primary ? (
            <>
              {/* Glossy top sheen: linear-gradient(180deg, rgba(255,255,255,.34), transparent 55%). */}
              <LinearGradient colors={GLOSS} locations={GLOSS_AT} style={StyleSheet.absoluteFill} pointerEvents="none" />
              <TopHighlight radius={r} color={withAlpha(colors.white, 0.55)} />
            </>
          ) : null}
        </View>
      )}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
        <PopRing active={toggledOn} size={height} color={colors.accentLight} glyph="✦" count={7} />
      </View>
      {content}
    </Tap>
  );
}

const GLOSS = [withAlpha(colors.white, 0.34), withAlpha(colors.white, 0)] as const;
const GLOSS_AT = [0, 0.55] as const;

/** Icon-only button. `bg` gives the round tinted variant from the Components board. */
export function IconButton({
  icon,
  label,
  size = 44,
  iconSize = 24,
  color = colors.text,
  bg,
  filled,
  href,
  onPress,
  style,
  glass,
}: {
  icon: IconName;
  label: string;
  size?: number;
  iconSize?: number;
  color?: string;
  bg?: string;
  filled?: boolean;
  href?: NavTarget;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /** Frosted glass round button (Components board › "Icon buttons"). */
  glass?: boolean;
}) {
  const r = size / 2;
  // Like / save hearts pop when they turn on (only when `filled` actually changes).
  const pop = usePop(filled);
  // Solid (opaque hex) fills get the board's colour glow + glossy top edge; translucent tints stay flat.
  const solid = !!bg && bg.startsWith('#');
  return (
    <Tap
      href={href}
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={size < 44 ? (44 - size) / 2 : undefined}
      style={[
        { width: size, height: size, borderRadius: r, alignItems: 'center', justifyContent: 'center', backgroundColor: glass ? undefined : bg },
        solid && glow(bg, 14, 0.5),
        style,
      ]}
    >
      {glass ? (
        <Glass radius={r} style={StyleSheet.absoluteFill}>
          {null}
        </Glass>
      ) : solid ? (
        <TopHighlight radius={r} color={withAlpha(colors.white, 0.5)} />
      ) : null}
      {filled !== undefined ? <PopRing active={filled} size={iconSize * 1.6} color={color} glyph={icon === 'heart' ? '♥' : '✦'} count={icon === 'heart' ? 8 : 6} /> : null}
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <Icon name={icon} size={iconSize} color={color} filled={filled} glow={solid ? false : undefined} />
      </Animated.View>
    </Tap>
  );
}

/** Small text link (accent light, 44 px tall target). */
export function LinkText({ label, href, onPress, color = colors.accentLight, size = 14, icon }: { label: string; href?: NavTarget; onPress?: () => void; color?: string; size?: number; icon?: IconName }) {
  return (
    <Tap href={href} onPress={onPress} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Row gap={6}>
        {icon ? <Icon name={icon} size={16} color={color} /> : null}
        <T weight={600} size={size} color={color}>
          {label}
        </T>
      </Row>
    </Tap>
  );
}

/* ------------------------------------------------------------------ chips */

/**
 * Pill chip (cinematic): selected = solid white with near-black text; unselected = 1px 14% white outline.
 * Pass `accent` to colour the selected state instead (e.g. a coloured filter); text then uses `onAccent`.
 */
export function Chip({ label, active, onPress, accent, weight = 500 }: { label: string; active?: boolean; onPress?: () => void; accent?: string; weight?: 500 | 600 }) {
  const fill = accent ?? colors.text;
  const fg = accent ? colors.onAccent : colors.onLight;
  return (
    <Tap onPress={onPress} accessibilityState={{ selected: !!active }} style={{ height: 44, justifyContent: 'center' }}>
      <View
        style={[
          { height: 32, paddingHorizontal: 16, borderRadius: 16, justifyContent: 'center' },
          active ? [{ backgroundColor: fill }, accent ? glow(accent, 11, 0.5) : null] : { borderWidth: 1, borderColor: colors.chipOutline },
        ]}
      >
        <T size={14} weight={active ? 600 : weight} color={active ? fg : colors.text}>
          {label}
        </T>
      </View>
    </Tap>
  );
}

/** Glass fill for inputs and segmented controls: 145deg 12% → 3% white. */
const FIELD_GLASS = [withAlpha(colors.white, 0.12), withAlpha(colors.white, 0.03)] as const;

/** Horizontally scrolling (or wrapping) single-select chip group. */
export function ChipRow({
  options,
  initial = 0,
  wrap,
  onChange,
  bleed = true,
}: {
  options: string[];
  initial?: number;
  wrap?: boolean;
  onChange?: (i: number) => void;
  bleed?: boolean;
}) {
  const [sel, setSel] = useState(initial);
  const chips = options.map((o, i) => (
    <Chip
      key={o}
      label={o}
      active={i === sel}
      onPress={() => {
        setSel(i);
        onChange?.(i);
      }}
    />
  ));
  if (wrap) return <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, rowGap: 4 }}>{chips}</View>;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={bleed ? { marginHorizontal: -16 } : undefined}
      contentContainerStyle={{ gap: 8, paddingHorizontal: bleed ? 16 : 0 }}
    >
      {chips}
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ segmented, toggle, progress */

export function Segmented({ options, initial = 0, onChange, accent = colors.accent }: { options: string[]; initial?: number; onChange?: (i: number) => void; accent?: string }) {
  const [sel, setSel] = useState(initial);
  return (
    <View style={styles.segmented}>
      <LinearGradient colors={FIELD_GLASS} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <TopHighlight radius={22} color={withAlpha(colors.white, 0.16)} />
      {options.map((o, i) => {
        const on = i === sel;
        return (
          <Tap
            key={o}
            accessibilityState={{ selected: on }}
            onPress={() => {
              setSel(i);
              onChange?.(i);
            }}
            style={{ flex: 1, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? accent : undefined }}
          >
            <T size={13} weight={on ? 600 : 500} color={on ? colors.onAccent : colors.textSecondary}>
              {o}
            </T>
          </Tap>
        );
      })}
    </View>
  );
}

export function Toggle({ value, onChange, label, accent = colors.accent }: { value: boolean; onChange?: (v: boolean) => void; label: string; accent?: string }) {
  const reduce = useReduceMotion();
  // 0 = off, 1 = on. Created once; the knob slides and the fills cross-fade on the native driver.
  const [pos] = useState(() => new Animated.Value(value ? 1 : 0));
  useEffect(() => {
    if (reduce) {
      pos.setValue(value ? 1 : 0);
      return;
    }
    const a = Animated.spring(pos, { toValue: value ? 1 : 0, speed: 20, bounciness: 6, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [value, reduce, pos]);
  const [knobX] = useState(() => pos.interpolate({ inputRange: [0, 1], outputRange: [0, TOGGLE_TRAVEL] }));
  const [onFade] = useState(() => pos.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }));
  return (
    <Tap
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      onPress={() => onChange?.(!value)}
      pressScale={0.94}
      style={{ width: 52, height: 44, alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <View style={[{ width: 48, height: 28, borderRadius: 14, backgroundColor: colors.track }, value && glow(accent, 11, 0.5)]}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: 14, backgroundColor: accent, opacity: onFade }]} />
        <Animated.View style={[styles.knob, { backgroundColor: colors.textSecondary, transform: [{ translateX: knobX }] }]}>
          <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: 12, backgroundColor: colors.white, opacity: onFade }]} />
        </Animated.View>
      </View>
    </Tap>
  );
}

/** Knob travel: 48 track − 24 knob − 2 × 2 inset. */
const TOGGLE_TRAVEL = 20;

/** Self-managing toggle for static mock rows. */
export function StatefulToggle({ initial = false, label, accent }: { initial?: boolean; label: string; accent?: string }) {
  const [v, setV] = useState(initial);
  return <Toggle value={v} onChange={setV} label={label} accent={accent} />;
}

export function ProgressBar({ value, height = 6, color = colors.accent, track = colors.track, style }: { value: number; height?: number; color?: string; track?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ height, borderRadius: height / 2, backgroundColor: track, overflow: 'hidden' }, style]}>
      <View style={{ width: `${Math.round(value * 100)}%`, height, backgroundColor: color }} />
    </View>
  );
}

/** Player seek bar: 4 px track, accent fill, 14 px white thumb, mono timestamps. */
export function SeekBar({ value, elapsed, remaining, accent = colors.accent, timeColor = colors.peach }: { value: number; elapsed?: string; remaining?: string; accent?: string; timeColor?: string }) {
  const pct = `${value * 100}%` as const;
  return (
    <View style={{ gap: 4 }} accessibilityRole="adjustable" accessibilityLabel="Seek" accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}>
      <View style={{ height: 20, justifyContent: 'center' }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.track }} />
        <View style={{ position: 'absolute', left: 0, width: pct, height: 4, borderRadius: 2, backgroundColor: accent }} />
        <View style={{ position: 'absolute', left: pct, marginLeft: -7, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.white }} />
      </View>
      {elapsed || remaining ? (
        <Row style={{ justifyContent: 'space-between' }}>
          <T mono size={12} color={timeColor}>
            {elapsed}
          </T>
          <T mono size={12} color={timeColor}>
            {remaining}
          </T>
        </Row>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ inputs */

export function TextField({
  label,
  icon,
  error,
  style,
  hideLabel,
  ...input
}: TextInputProps & { label: string; icon?: IconName; error?: string; style?: StyleProp<ViewStyle>; hideLabel?: boolean }) {
  const [focused, setFocused] = useState(false);
  const status = useStatusColors();
  const borderColor = error ? status.error : focused ? colors.accent : colors.glassBorder;
  const idle = !error && !focused;
  return (
    <View style={[{ gap: 6 }, style]}>
      {hideLabel ? null : (
        <T variant="caption" color={colors.textSecondary}>
          {label}
        </T>
      )}
      <Row gap={8} style={[styles.field, { borderColor, backgroundColor: idle ? undefined : colors.bgTertiary }]}>
        {idle ? (
          <>
            <LinearGradient colors={FIELD_GLASS} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
            <TopHighlight radius={radius.pill} color={withAlpha(colors.white, 0.16)} />
          </>
        ) : null}
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={colors.textTertiary}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={styles.input}
          {...input}
        />
        {icon ? <Icon name={icon} size={20} color={colors.textSecondary} /> : null}
      </Row>
      {error ? (
        <T size={12} color={status.error}>
          {error}
        </T>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ badges */

/** Tilted "sticker" badge (NEW, SMART, HOT, LOSSLESS…). */
export function Sticker({ label, bg = colors.amber, rotate = -4, style }: { label: string; bg?: string; rotate?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        { height: 26, paddingHorizontal: 12, borderRadius: 13, backgroundColor: bg, justifyContent: 'center', alignSelf: 'flex-start', transform: [{ rotate: `${rotate}deg` }] },
        shadow.stickerSm,
        style,
      ]}
    >
      <T size={12} weight={700} tracking={0.2} color={colors.onAccent}>
        {label}
      </T>
    </View>
  );
}

export function OutlineTag({ label, color = colors.violet }: { label: string; color?: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 6 }}>
      <T variant="overline" color={color}>
        {label}
      </T>
    </View>
  );
}

export function LiveDot({ label = 'LIVE' }: { label?: string }) {
  return (
    <Row gap={6}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.error }} />
      <T size={12} weight={600} color={colors.error}>
        {label}
      </T>
    </Row>
  );
}

/* ------------------------------------------------------------------ toast */

export function Toast({ icon = 'check', iconColor: rawIconColor = colors.success, message, action, onAction }: { icon?: IconName; iconColor?: string; message: string; action?: string; onAction?: () => void }) {
  const iconColor = useStatusColor(rawIconColor);
  return (
    <Glass padding={12}>
      <Row>
        <Icon name={icon} size={20} color={iconColor} />
        <T size={14} style={{ flex: 1 }}>
          {message}
        </T>
        {action ? <LinkText label={action} onPress={onAction} /> : null}
      </Row>
    </Glass>
  );
}

const styles = StyleSheet.create({
  knob: { position: 'absolute', top: 2, left: 2, width: 24, height: 24, borderRadius: 12 },
  segmented: {
    flexDirection: 'row',
    gap: 4,
    padding: 4,
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  field: {
    height: 48,
    borderRadius: radius.pill,
    overflow: 'hidden',
    borderWidth: 1,
    paddingLeft: 14,
    paddingRight: 12,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: 44,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
});
