import { View } from 'react-native';

import { Cover, Row, T } from '../components';
import { colors } from '../theme/tokens';
import type { Person } from './live';

/** Round profile photo, or the first letter on the profile's art gradient. `ring` = live accent ring. */
export function HostAvatar({ p, size = 44, ring }: { p: Person | null; size?: number; ring?: boolean }) {
  const name = p?.display_name ?? '?';
  const avatar = (
    <Cover uri={p?.avatar_url} id={p?.id} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {p?.avatar_url ? null : (
        <T size={Math.round(size / 3)} weight={600} color={colors.white}>
          {(name[0] ?? '?').toUpperCase()}
        </T>
      )}
    </Cover>
  );
  if (!ring) return avatar;
  return <View style={{ padding: 3, borderRadius: size, borderWidth: 2, borderColor: colors.accent }}>{avatar}</View>;
}

/** Solid accent "LIVE" pill. */
export function LiveBadge({ label = 'LIVE' }: { label?: string }) {
  return (
    <Row gap={6} style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.accent, alignSelf: 'flex-start' }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.white }} />
      <T size={11} weight={700} tracking={0.8} color={colors.white}>
        {label}
      </T>
    </Row>
  );
}
