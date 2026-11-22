import { View, type StyleProp, type ViewStyle } from 'react-native';

import { art, withAlpha, type ArtName } from '../theme/tokens';
import type { IconName } from './icons';
import { Gradient, Icon, TopHighlight } from './primitives';

/** What an icon is about decides its colour, so rows of cards read as a varied set that still matches the app's palette. */
type Tone = ArtName | 'graphite';
const TONES: [RegExp, Tone][] = [
  [/^(wifi|wifiOff|cast|speaker|headphones|phone|car|globe|link|broadcast|spatial|storage|call|hangup|video|videoOff|flipCamera)$/, 'blue'],
  [/^(heart|star|trophy|flame)$/, 'rose'],
  [/^(download|clock|clockSmall|chart|timer|bell|bellOff|moon)$/, 'amber'],
  [/^(lock|shield|eye|faceId|ban|block)$/, 'green'],
  [/^(users|user|chat|mail|share|send|qr|camera|image|mic|micOff)$/, 'orange'],
  [/^(sliders|info|infoDot|file|edit|trash|filter|sort|grid|reorder|queue|copy|pin|pushPin|more|moreVertical|plus|search|home)$/, 'graphite'],
];
const GRAPHITE = ['#4A4A4F', '#1F1F23'] as const;

export function toneFor(icon: IconName): Tone {
  return TONES.find(([re]) => re.test(icon))?.[1] ?? 'coral';
}

/**
 * Icon badge for cards and rows: a rounded square with a two-tone gradient, a soft inner highlight at the top edge and
 * a faint glow in its own colour, with a white glyph. Replaces the flat single-colour circles. `tone` forces a colour;
 * otherwise it follows the icon.
 */
export function IconBadge({ icon, size = 40, radius, tone, filled, style }: { icon: IconName; size?: number; radius?: number; tone?: Tone; filled?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = tone ?? toneFor(icon);
  const stops = t === 'graphite' ? GRAPHITE : art[t];
  const r = radius ?? Math.round(size * 0.32);
  return (
    <View
      style={[
        { width: size, height: size, borderRadius: r, flexShrink: 0, shadowColor: stops[0], shadowOpacity: 0.35, shadowRadius: size * 0.22, shadowOffset: { width: 0, height: Math.round(size * 0.08) } },
        style,
      ]}
    >
      <Gradient colors={[stops[0], stops[1]]} style={{ width: size, height: size, borderRadius: r, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {/* A light wash across the top half gives the badge a little depth. */}
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: size / 2, backgroundColor: withAlpha('#FFFFFF', 0.1) }} />
        <Icon name={icon} size={Math.round(size * 0.5)} color="#FFFFFF" filled={filled} strokeWidth={2} glow={false} />
      </Gradient>
      <TopHighlight radius={r} color={withAlpha('#FFFFFF', 0.4)} />
    </View>
  );
}
