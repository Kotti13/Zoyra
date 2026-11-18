import { View, type StyleProp, type ViewStyle } from 'react-native';

import { GOLD } from '../../lib/forever';
import { T } from '../primitives';
import { goldTint } from './gold';

/**
 * ∞ gold badge for avatars (MsgHome / MsgForever: 20 px pill, #1A1206 fill, 1 px #FFB020 edge, gold ∞).
 * Position it yourself, or use <ForeverRing> which places it on the top-right corner.
 */
export function ForeverBadge({ size = 20, style }: { size?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessibilityLabel="Forever friend"
      style={[
        {
          height: size,
          minWidth: size,
          paddingHorizontal: Math.round(size * 0.25),
          borderRadius: size / 2,
          backgroundColor: GOLD.inkBg,
          borderWidth: 1,
          borderColor: GOLD.mid,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <T size={Math.round(size * 0.6)} weight={800} color={GOLD.light} style={{ lineHeight: Math.round(size * 0.8) }}>
        ∞
      </T>
    </View>
  );
}

/** "∞ Forever" pill (the disabled Block row in the long-press menu: MsgLongPress). */
export function ForeverTag({ label = 'Forever' }: { label?: string }) {
  return (
    <View
      style={{ height: 22, paddingHorizontal: 8, borderRadius: 11, backgroundColor: goldTint(0.14), borderWidth: 1, borderColor: goldTint(0.5), flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <T size={12} weight={800} color={GOLD.light}>
        ∞
      </T>
      <T size={11} weight={700} color={GOLD.mid}>
        {label}
      </T>
    </View>
  );
}
