/** Shared UI for the group screens (new-group, group-info): member picker rows and search box. */
import { TextInput, View } from 'react-native';

import { Icon, Row, T, Tap } from '../components';
import { colors, fonts, withAlpha } from '../theme/tokens';
import { ChatAvatar } from './chat-ui';
import type { DmContact } from './dm';
import { refusalLabel, type InviteCheck } from './groups';

/** Selectable person row (shared with group-info's Add members). */
export function PickRow({ c, first, selected, check, onPress, already }: { c: DmContact; first: boolean; selected: boolean; check?: InviteCheck; onPress: () => void; already?: boolean }) {
  const blocked = (check && !check.ok) || already;
  const sub = already ? 'Already in the group' : check && !check.ok ? refusalLabel(check.reason) : c.username ? `@${c.username}` : '';
  return (
    <Tap
      onPress={onPress}
      disabled={blocked}
      pressScale={0.98}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled: blocked }}
      accessibilityLabel={`${c.display_name}${sub ? `, ${sub}` : ''}`}
      style={[{ minHeight: 64, paddingHorizontal: 12, justifyContent: 'center' }, !first && { borderTopWidth: 1, borderTopColor: colors.divider }, blocked && { opacity: 0.5 }]}
    >
      <Row gap={12}>
        <ChatAvatar person={c} size={42} radius={14} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T size={15} weight={600} numberOfLines={1}>
            {c.display_name}
          </T>
          {sub ? (
            <T size={12} color={colors.textSecondary} numberOfLines={1}>
              {sub}
            </T>
          ) : null}
        </View>
        <View
          style={
            selected
              ? { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }
              : { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: withAlpha(colors.white, 0.3) }
          }
        >
          {selected ? <Icon name="checkBold" size={14} color={colors.onAccent} /> : null}
        </View>
      </Row>
    </Tap>
  );
}

/** Search box used by both pickers. */
export function PickSearch({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  return (
    <Row gap={8} style={{ height: 48, borderRadius: 24, paddingHorizontal: 16, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
      <Icon name="search" size={18} color={colors.textSecondary} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search name or @username"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Search people"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
      />
    </Row>
  );
}
