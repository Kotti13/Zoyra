import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { Icon, Row, T, Tap, useReduceMotion, type IconName } from '../components';
import { colors, withAlpha } from '../theme/tokens';

/**
 * Shared pieces for the confirm dialogs (Confirm block, Confirm clear, Confirm unsend) and Blocked done.
 * Colours follow the dialog designs: a softer destructive red than the brand accent.
 */
export const dialogColors = {
  danger: '#E5484D',
  dangerText: '#FF8A8A',
  done: '#2EE59D',
  body: '#D4D4D4',
  card: 'rgba(28,28,28,0.97)',
  field: withAlpha(colors.white, 0.06),
  fieldBorder: withAlpha(colors.white, 0.12),
  ghost: withAlpha(colors.white, 0.08),
  ghostBorder: withAlpha(colors.white, 0.14),
} as const;

/** Moves screen-reader focus to the dialog title once it is on screen. Attach to an `accessible` View. */
export function useDialogFocus() {
  const ref = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      if (ref.current) AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
    }, 350);
    return () => clearTimeout(id);
  }, []);
  return ref;
}

/** Wraps dialog content: modal for screen readers (siblings are hidden), announced as an alert. */
export function DialogBody({ label, gap = 16, children }: { label: string; gap?: number; children: ReactNode }) {
  return (
    <View accessibilityViewIsModal aria-modal accessibilityRole="alert" accessibilityLabel={label} importantForAccessibility="yes" style={{ gap }}>
      {children}
    </View>
  );
}

/** Dialog title (22 px semibold, centered by default). Receives initial screen-reader focus. */
export function DialogTitle({ children, size = 22, align = 'center' }: { children: string; size?: number; align?: 'center' | 'left' }) {
  const ref = useDialogFocus();
  return (
    <View ref={ref} accessible accessibilityRole="header" accessibilityLabel={children}>
      <T size={size} weight={600} align={align}>
        {children}
      </T>
    </View>
  );
}

/** 52 px pill button: `danger` (filled red), `ghost` (outlined glass). Shows a spinner while busy. */
export function DialogButton({ label, onPress, kind = 'ghost', busy, disabled, flex }: { label: string; onPress: () => void; kind?: 'danger' | 'ghost' | 'accent'; busy?: boolean; disabled?: boolean; flex?: boolean }) {
  const off = disabled || busy;
  const bg = kind === 'danger' ? dialogColors.danger : kind === 'accent' ? colors.accent : dialogColors.ghost;
  return (
    <Tap
      onPress={off ? undefined : onPress}
      disabled={off}
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={[
        { height: 52, borderRadius: 26, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', opacity: disabled && !busy ? 0.5 : 1 },
        kind === 'ghost' ? { borderWidth: 1, borderColor: dialogColors.ghostBorder } : null,
        flex ? { flex: 1 } : null,
      ]}
    >
      {busy ? <ActivityIndicator color={colors.white} /> : <T size={16} weight={kind === 'ghost' ? 600 : 700} color={kind === 'ghost' ? colors.text : colors.white}>{label}</T>}
    </Tap>
  );
}

/** Checkbox row from the designs: 56 px, 24 px rounded box, title + subtitle. */
export function CheckRow({ checked, onChange, title, subtitle, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: string; subtitle?: string; disabled?: boolean }) {
  return (
    <Tap
      onPress={disabled ? undefined : () => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      pressScale={0.98}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, backgroundColor: dialogColors.field, borderWidth: 1, borderColor: dialogColors.fieldBorder }}
    >
      <View
        style={[
          { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
          checked ? { backgroundColor: dialogColors.danger } : { borderWidth: 2, borderColor: withAlpha(colors.white, 0.35) },
        ]}
      >
        {checked ? <Icon name="checkBold" size={14} color={colors.white} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T size={14} weight={600}>
          {title}
        </T>
        {subtitle ? (
          <T size={12} color={colors.textSecondary}>
            {subtitle}
          </T>
        ) : null}
      </View>
    </Tap>
  );
}

/** Dialog-only glyphs from the designs that the shared icon set doesn't have (24 grid, 1.6 stroke). */
const GLYPHS = {
  eyeOff: ['M2 12s3.5-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.5 7-10 7c-2 0-3.7-.6-5.1-1.5M3 3l18 18'],
  bellOff: ['M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7', 'M10 20a2 2 0 0 0 4 0M3 3l18 18'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
} as const;
export type DialogGlyph = keyof typeof GLYPHS;

/** A shared icon, or one of the dialog glyphs above. */
export function DialogIcon({ name, size, color }: { name: IconName | DialogGlyph; size: number; color: string }) {
  if (!(name in GLYPHS)) return <Icon name={name as IconName} size={size} color={color} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {GLYPHS[name as DialogGlyph].map((d) => (
        <Path key={d} d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </Svg>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Blocked done's check: 44 px, 2.2 stroke, drawn in (zCheck .5 s after .2 s); static under Reduce Motion. */
export function DrawnCheck({ color, size = 44 }: { color: string; size?: number }) {
  const reduce = useReduceMotion();
  const [offset] = useState(() => new Animated.Value(reduce ? 0 : 40));
  useEffect(() => {
    if (reduce) {
      offset.setValue(0);
      return;
    }
    const a = Animated.timing(offset, { toValue: 0, duration: 500, delay: 200, easing: Easing.out(Easing.ease), useNativeDriver: false });
    a.start();
    return () => a.stop();
  }, [reduce, offset]);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      <AnimatedPath d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="40" strokeDashoffset={offset} />
    </Svg>
  );
}

/** zPop: fade + scale in from 0.9 (0.28 s, slight overshoot). */
export function PopIn({ children, style }: { children: ReactNode; style?: object }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(reduce ? 1 : 0));
  useEffect(() => {
    if (reduce) return;
    const a = Animated.timing(v, { toValue: 1, duration: 280, easing: Easing.bezier(0.2, 0.9, 0.3, 1.15), useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [reduce, v]);
  return <Animated.View style={[style, { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }), transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }]}>{children}</Animated.View>;
}

/** Bulleted fact with a 32 px round icon (Confirm block). */
export function FactRow({ icon, text }: { icon: IconName | DialogGlyph; text: string }) {
  return (
    <Row gap={12}>
      <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: dialogColors.ghost, alignItems: 'center', justifyContent: 'center' }}>
        <DialogIcon name={icon} size={16} color={colors.text} />
      </View>
      <T size={14} color={dialogColors.body} lineHeight={20} style={{ flex: 1 }}>
        {text}
      </T>
    </Row>
  );
}

/** Inline error / status line, announced politely. */
export function DialogNote({ text, ok }: { text: string | null; ok?: boolean }) {
  if (!text) return null;
  return (
    <T size={13} align="center" color={ok ? colors.success : colors.error} accessibilityLiveRegion="polite" accessibilityRole={ok ? undefined : 'alert'}>
      {text}
    </T>
  );
}
