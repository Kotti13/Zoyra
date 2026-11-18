/**
 * Cinematic poster pieces shared by Home, Premieres and Track detail (Components board › "POSTER CARD").
 * Real artwork under a bottom fade, with small frosted badges and a title block.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Cover, Gradient, Icon, T, Tap, type IconName } from '../components';
import { colors, withAlpha } from '../theme/tokens';
import { formatCount, type Artwork } from './catalog';

/** Small dark pill drawn over artwork (e.g. "FRIDAY RELEASE", play counts). */
export function PosterBadge({ label, icon, color = colors.text }: { label: string; icon?: IconName; color?: string }) {
  return (
    <View style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: colors.shade, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' }}>
      {icon ? <Icon name={icon} size={13} color={color} /> : null}
      <T size={11} weight={700} tracking={0.6} color={color}>
        {label}
      </T>
    </View>
  );
}

/** Play count badge (the mocks show a star rating; Audius has no ratings, so we show real plays). */
export function PlaysBadge({ plays }: { plays: number }) {
  return <PosterBadge icon="play" label={formatCount(plays)} color={colors.amber} />;
}

/** Artwork with a dark bottom fade; children are laid out over it (absolute fill). */
export function Poster({
  artwork,
  id,
  width,
  height,
  radius = 32,
  fade = 0.9,
  style,
  children,
}: {
  artwork?: Artwork;
  id?: string;
  width?: number;
  height: number;
  radius?: number;
  fade?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <Cover artwork={artwork} id={id} size={height} width={width} height={height} radius={radius} style={[width === undefined ? { width: '100%' } : null, style]}>
      <Gradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, fade)]} angle={180} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { padding: 12 }]}>{children}</View>
    </Cover>
  );
}

/** 156×196 poster card with title + subtitle at the bottom and a top-left badge. */
export function PosterCard({
  title,
  subtitle,
  artwork,
  id,
  plays,
  badge,
  onPress,
  accessibilityLabel,
  width = 156,
  height = 196,
}: {
  title: string;
  subtitle: string;
  artwork?: Artwork;
  id: string;
  plays?: number;
  badge?: string;
  onPress: () => void;
  accessibilityLabel?: string;
  width?: number;
  height?: number;
}) {
  return (
    <Tap onPress={onPress} accessibilityLabel={accessibilityLabel ?? `${title}, ${subtitle}`} style={{ width }}>
      <Poster artwork={artwork} id={id} width={width} height={height}>
        <View style={{ flex: 1, justifyContent: 'space-between' }}>
          <View>{badge ? <PosterBadge label={badge} /> : plays !== undefined ? <PlaysBadge plays={plays} /> : null}</View>
          <View style={{ gap: 2 }}>
            <T size={15} weight={700} numberOfLines={2} lineHeight={18}>
              {title}
            </T>
            <T size={12} color={colors.peach} numberOfLines={1}>
              {subtitle}
            </T>
          </View>
        </View>
      </Poster>
    </Tap>
  );
}
