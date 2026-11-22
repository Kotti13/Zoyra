import { type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { catalog, type Artwork } from '../lib/catalog';
import { colors } from '../theme/tokens';
import { Tap } from './controls';
import { Cover, useAsync } from './media';
import { Gradient, Icon, T } from './primitives';

/**
 * The picture for a category (genre, language, mood…): the cover of the top song for it, found once and remembered on
 * the device for a few days, so reopening a screen shows the pictures at once and makes no requests. undefined while
 * loading or when nothing is found; the tile keeps its colour until then.
 */
export function useCategoryCover(label: string, query?: string): Artwork | undefined {
  const q = query ?? `top ${label.replace(/[/&]+/g, ' ').replace(/\s+/g, ' ').trim()} songs`;
  const found = useAsync<Artwork | null>(
    async () => {
      const tracks = await catalog.searchTracks(q, { limit: 5 }).catch(() => []);
      return tracks.find((t) => t.artwork.large ?? t.artwork.medium ?? t.artwork.small)?.artwork ?? null;
    },
    [q],
    { id: 'category.cover', persist: true },
  );
  return found.data ?? undefined;
}

/**
 * A category card with its picture: the top song's cover fills the card under a dark fade, with the name on it.
 * `bg` is the colour shown until the picture arrives (and behind it). `selected` adds the accent border and a tick
 * (sign-up genre picker); without `onPress` the card is just a picture.
 */
export function CategoryTile({
  label,
  query,
  width,
  height,
  radius = 14,
  bg = colors.bgTertiary,
  selected,
  onPress,
  accessibilityLabel,
  style,
  children,
}: {
  label: string;
  /** What to search for the picture; defaults to "top <label> songs". */
  query?: string;
  width: number;
  height: number;
  radius?: number;
  bg?: string;
  selected?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const artwork = useCategoryCover(label, query);
  const on = !!selected;
  return (
    <Tap
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={selected === undefined ? 'button' : 'checkbox'}
      accessibilityState={selected === undefined ? undefined : { checked: on }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={[{ width, height, borderRadius: radius, overflow: 'hidden', backgroundColor: bg, borderWidth: on ? 3 : 0, borderColor: colors.accentLight }, style]}
    >
      <Cover artwork={artwork} id={label} width={width} height={height} radius={0} fit="cover" />
      <Gradient colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.78)']} angle={180} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 0 }} />
      <View style={{ position: 'absolute', left: 12, right: 12, bottom: 10 }}>
        <T size={16} weight={700} color={colors.white} numberOfLines={2}>
          {label}
        </T>
      </View>
      {on ? (
        <View style={{ position: 'absolute', top: 8, right: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accentLight, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="check" size={15} color={colors.onAccent} />
        </View>
      ) : null}
      {children}
    </Tap>
  );
}
