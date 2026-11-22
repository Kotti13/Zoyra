import { BlurView } from 'expo-blur';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import type { ReactNode } from 'react';

import { colors, withAlpha } from '../theme/tokens';
import { IconButton, Tap, type NavTarget } from './controls';
import { IconBadge } from './IconBadge';
import type { IconName } from './icons';
import { Icon, Row, T } from './primitives';

/**
 * Flat frosted panel used by the settings-family boards: rgba(255,255,255,.06) fill, blur 20,
 * 1px rgba(255,255,255,.12) edge. Radius 36 by default (the boards' list cards and tiles).
 */
export function Panel({ children, radius = 36, padding, style }: { children?: ReactNode; radius?: number; padding?: number | { v?: number; h?: number }; style?: StyleProp<ViewStyle> }) {
  const pad = typeof padding === 'object' ? { paddingVertical: padding.v, paddingHorizontal: padding.h } : { padding };
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), backgroundColor: withAlpha(colors.white, 0.06) }, pad, style]}>
      {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={20} style={StyleSheet.absoluteFill} pointerEvents="none" /> : null}
      {children}
    </View>
  );
}

/** Section label from the boards: 12-13 px / 600, uppercase, tracked, #A3A3A3. */
export function SectionLabel({ children, size = 12, tracking = 0.5, color = colors.textSecondary }: { children: ReactNode; size?: number; tracking?: number; color?: string }) {
  return (
    <T size={size} weight={600} color={color} tracking={tracking} style={{ textTransform: 'uppercase', paddingHorizontal: 4 }} accessibilityRole="header">
      {children}
    </T>
  );
}

/**
 * Icon chip for Panel rows. With no colours given it is the gradient `IconBadge` (colour follows the icon); a caller
 * that passes `tint`, `bg` or `color` explicitly keeps the plain tinted chip it asked for.
 */
export function IconChip({ icon, size = 40, radius, tint, alpha = 0.18, color, filled, bg }: { icon: IconName; size?: number; radius?: number; tint?: string; alpha?: number; color?: string; filled?: boolean; bg?: string }) {
  if (tint === undefined && bg === undefined && color === undefined) return <IconBadge icon={icon} size={size} radius={radius} filled={filled} />;
  return (
    <View style={{ width: size, height: size, borderRadius: radius ?? size / 2, backgroundColor: bg ?? withAlpha(tint ?? colors.accent, alpha), alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <Icon name={icon} size={Math.round(size * 0.5)} color={color ?? colors.accentLight} filled={filled} />
    </View>
  );
}

/**
 * List row for Panel cards: IconChip + title / subtitle + trailing slot. `divider` draws the 1px
 * rgba(255,255,255,.06) rule above the row.
 */
export function PanelRow({
  title,
  subtitle,
  icon,
  iconColor,
  iconBg,
  tint,
  href,
  onPress,
  right,
  divider,
  titleSize = 16,
  titleWeight = 500,
  subSize = 14,
  minHeight = 68,
  vPad = 0,
  titleColor = colors.text,
  leading,
  label,
  chevron = true,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  iconBg?: string;
  tint?: string;
  href?: NavTarget;
  onPress?: () => void;
  right?: ReactNode;
  divider?: boolean;
  titleSize?: number;
  titleWeight?: 500 | 600;
  subSize?: number;
  minHeight?: number;
  vPad?: number;
  titleColor?: string;
  leading?: ReactNode;
  label?: string;
  chevron?: boolean;
}) {
  const body = (
    <Row gap={12} style={[{ minHeight, paddingVertical: vPad }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
      {leading ?? (icon ? <IconChip icon={icon} color={iconColor} tint={tint} bg={iconBg} /> : null)}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={titleSize} weight={titleWeight} color={titleColor}>
          {title}
        </T>
        {subtitle ? (
          <T size={subSize} color={colors.textSecondary}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right}
      {chevron && right === undefined ? <Icon name="chevronRight" size={18} color={colors.textSecondary} /> : null}
    </Row>
  );
  if (!href && !onPress) return body;
  return (
    <Tap href={href} onPress={onPress} pressScale={0.98} accessibilityLabel={label}>
      {body}
    </Tap>
  );
}

/** Large-title header from the settings boards: ghost back chip, then a 36/300 title (-1 tracking). */
export function BigHeader({ title, size = 36, tracking = -1, right }: { title: string; size?: number; tracking?: number; right?: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Row style={{ justifyContent: 'space-between', minHeight: 44 }}>
        <IconButton icon="back" label="Back" href="back" bg={colors.chipGhost} />
        {right}
      </Row>
      <T variant="display" size={size} tracking={tracking} lineHeight={Math.round(size * 1.08)} accessibilityRole="header">
        {title}
      </T>
    </View>
  );
}
