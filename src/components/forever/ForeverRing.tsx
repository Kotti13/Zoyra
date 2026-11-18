import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { ChatAvatar } from '../../lib/chat-ui';
import { GOLD, useForeverIds } from '../../lib/forever';
import { ForeverBadge } from './ForeverBadge';

/**
 * Gold ring (2 px #FFB020, 4 px outside the avatar) + ∞ badge on the top-right corner, around any avatar.
 * `active` forces it on / off; otherwise pass `uid` and it shows only when that person is my Forever friend.
 * Renders children unchanged when not active (safe to wrap every avatar in a list).
 */
export function ForeverRing({
  children,
  uid,
  active,
  radius,
  inset = 4,
  badge = true,
  style,
}: {
  children: ReactNode;
  uid?: string | null;
  active?: boolean;
  /** Corner radius of the wrapped avatar (ring radius = radius + inset). */
  radius: number;
  inset?: number;
  badge?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const ids = useForeverIds();
  const on = active ?? (!!uid && ids.has(uid));
  if (!on) return <View style={style}>{children}</View>;
  return (
    <View style={[{ position: 'relative' }, style]}>
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: -inset, left: -inset, right: -inset, bottom: -inset, borderRadius: radius + inset, borderWidth: 2, borderColor: GOLD.mid }}
      />
      {children}
      {badge ? <ForeverBadge style={{ position: 'absolute', right: -6, top: -6 }} /> : null}
    </View>
  );
}

/** ChatAvatar with the Forever ring + badge (when `forever` is true, or `person.id` is my Forever friend). */
export function ForeverAvatar({
  person,
  size = 54,
  radius,
  forever,
  badge = true,
}: {
  person: { id: string; display_name: string; avatar_url: string | null; username?: string | null } | null;
  size?: number;
  radius?: number;
  forever?: boolean;
  badge?: boolean;
}) {
  const r = radius ?? Math.round(size / 3);
  return (
    <ForeverRing uid={person?.id} active={forever} radius={r} badge={badge}>
      <ChatAvatar person={person} size={size} radius={r} />
    </ForeverRing>
  );
}
