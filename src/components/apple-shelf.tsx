import { memo, type ReactNode } from 'react';
import { FlatList, View, type ListRenderItem, type StyleProp, type ViewStyle } from 'react-native';

import type { Href } from 'expo-router';

import type { Artwork, CatalogTrack } from '../lib/catalog';
import { colors, type ArtName } from '../theme/tokens';
import { Tap } from './controls';
import { Cover, TrackItem } from './media';
import type { IconName } from './icons';
import { Art, Icon, Row, T } from './primitives';

/** Shared rhythm: vertical gap between sections, side padding, gap between shelf cards. */
export const APPLE = { section: 30, side: 16, gap: 12, card: 156, radius: 12 } as const;

/** Large screen title (34px) with optional trailing controls, Apple Music style. */
export function AppleTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: 44 }} gap={8}>
      <T size={34} weight={700} tracking={-0.8} lineHeight={40} accessibilityRole="header" numberOfLines={1} style={{ flexShrink: 1 }}>
        {title}
      </T>
      {right ? (
        <Row gap={8} style={{ flexShrink: 0 }}>
          {right}
        </Row>
      ) : null}
    </Row>
  );
}

/** Shelf header: title left, "See all" + chevron right. */
export function ShelfHeader({ title, action, href }: { title: string; action?: string; href?: Href }) {
  return (
    <Row style={{ justifyContent: 'space-between', minHeight: 32 }}>
      <T size={22} weight={700} tracking={-0.4} accessibilityRole="header" style={{ flexShrink: 1 }} numberOfLines={1}>
        {title}
      </T>
      {action && href ? (
        <Tap href={href} accessibilityLabel={action} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 2, justifyContent: 'flex-end' }}>
          <T size={14} weight={500} color={colors.accentLight}>
            {action}
          </T>
          <Icon name="chevronRight" size={14} color={colors.accentLight} />
        </Tap>
      ) : null}
    </Row>
  );
}

/** Horizontal snapping shelf with 16px side padding and 12px gaps. */
export function Shelf<I>({
  data,
  renderItem,
  keyExtractor,
  itemWidth = APPLE.card,
  contentStyle,
}: {
  data: readonly I[];
  renderItem: ListRenderItem<I>;
  keyExtractor: (item: I, index: number) => string;
  itemWidth?: number;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <FlatList
      horizontal
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -APPLE.side }}
      contentContainerStyle={[{ paddingHorizontal: APPLE.side, gap: APPLE.gap }, contentStyle]}
      snapToInterval={itemWidth + APPLE.gap}
      snapToAlignment="start"
      decelerationRate="fast"
      initialNumToRender={4}
      windowSize={5}
      removeClippedSubviews
    />
  );
}

/** Square artwork card with title + subtitle below (1-2 lines). */
export const ShelfCard = memo(function ShelfCard({
  title,
  subtitle,
  artwork,
  uri,
  id,
  art,
  size = APPLE.card,
  height,
  fit,
  radius = APPLE.radius,
  round,
  onPress,
  accessibilityLabel,
  badge,
  children,
}: {
  title: string;
  subtitle?: string;
  artwork?: Artwork;
  uri?: string | null;
  id: string;
  art?: ArtName;
  size?: number;
  /** Art height when it is not square (e.g. a 16:9 thumbnail tile: size 160, height 90). */
  height?: number;
  fit?: 'auto' | 'cover' | 'contain';
  radius?: number;
  round?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  const r = round ? size / 2 : radius;
  return (
    <Tap onPress={onPress} accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)} style={{ width: size, gap: 8 }}>
      {art ? (
        <Art art={art} size={size} radius={r} style={{ alignItems: 'center', justifyContent: 'center' }}>
          {children}
        </Art>
      ) : (
        <Cover artwork={artwork} uri={uri} id={id} size={size} height={height} radius={r} fit={fit}>
          {children}
        </Cover>
      )}
      {badge}
      <View style={{ gap: 1, alignItems: round ? 'center' : 'flex-start' }}>
        <T size={14} weight={600} numberOfLines={1} lineHeight={18} align={round ? 'center' : 'left'}>
          {title}
        </T>
        {subtitle ? (
          <T size={13} color={colors.textSecondary} numberOfLines={2} lineHeight={17} align={round ? 'center' : 'left'}>
            {subtitle}
          </T>
        ) : null}
      </View>
    </Tap>
  );
});

/** Hairline separator inset from the artwork (row art 56 + gap 12). */
export function AppleSeparator({ inset = 68 }: { inset?: number }) {
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: colors.divider }} />;
}

/** Clean track list: 56px art, title, artist, trailing more; hairlines inset from the art. */
export function AppleTrackList({ tracks, context, subtitle }: { tracks: CatalogTrack[]; context: string; subtitle?: (t: CatalogTrack) => string }) {
  return (
    <View>
      {tracks.map((t, i) => (
        <View key={t.id}>
          {i > 0 ? <AppleSeparator /> : null}
          <TrackItem track={t} list={tracks} index={i} context={context} artSize={56} artRadius={10} showDuration={false} subtitle={subtitle?.(t)} />
        </View>
      ))}
    </View>
  );
}

/** Category row: accent icon, title, trailing chevron (Library). */
export const AppleNavRow = memo(function AppleNavRow({ icon, title, subtitle, href, onPress, accessibilityLabel }: { icon: IconName; title: string; subtitle?: string; href?: Href; onPress?: () => void; accessibilityLabel?: string }) {
  return (
    <Tap href={href} onPress={onPress} accessibilityLabel={accessibilityLabel ?? title} style={{ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <View style={{ width: 32, alignItems: 'center' }}>
        <Icon name={icon} size={24} color={colors.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={18} numberOfLines={1}>
          {title}
        </T>
        {subtitle ? (
          <T size={13} color={colors.textSecondary} numberOfLines={1}>
            {subtitle}
          </T>
        ) : null}
      </View>
      <Icon name="chevronRight" size={18} color={colors.textTertiary} />
    </Tap>
  );
});
