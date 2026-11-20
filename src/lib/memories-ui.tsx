import { router } from 'expo-router';
import { View } from 'react-native';

import { Cover, Glass, Icon, Row, T, Tap, useAsync } from '../components';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';
import { loadMemories, yearsAgoLabel } from './memories';

/** Home card: today's oldest memory with a link to "On this day". Renders nothing when there are none. */
export function MemoryCard() {
  const { user } = useAuth();
  const me = user?.id;
  const res = useAsync(() => (me ? loadMemories() : Promise.resolve([])), [me], 'lib/memories-ui:13');
  const m = res.data?.[0];
  if (!m) return null;
  return (
    <Tap onPress={() => router.push('/memories')} accessibilityLabel={`On this day. ${yearsAgoLabel(m.yearsAgo).toLowerCase()}: ${m.track.title}`} pressScale={0.98}>
      <Glass radius={28} padding={12}>
        <Row gap={14}>
          <Cover artwork={m.track.artwork} id={m.track.id} size={56} radius={18} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T variant="overline" color={colors.accentLight}>{`ON THIS DAY · ${yearsAgoLabel(m.yearsAgo)}`}</T>
            <T size={16} weight={600} numberOfLines={1}>
              {m.track.title}
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              {m.track.artist.name}
            </T>
          </View>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </Row>
      </Glass>
    </Tap>
  );
}
