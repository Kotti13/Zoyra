import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Glass, Icon, IconButton, Loading, Row, Screen, T, Tap, Toast, useAsync } from '../components';
import { loadMySettings, updateMySettings } from '../lib/chat';
import { muteConversationFor } from '../lib/dm';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

/**
 * Per-chat notifications (MsgNotif): back · "Notifications" · "For <name>" · radio card (All messages / Mute) ·
 * "Mute for" glass card (1 hour, 8 hours, 1 week). The server only stores muted / muted-until per chat
 * (conversation_members.muted, mute_conversation), so the design's Mentions-and-songs, Preview and Reactions
 * rows are not shown: they would not do anything yet.
 */
const MUTE_FOR: { minutes: number; label: string }[] = [
  { minutes: 60, label: '1 hour' },
  { minutes: 480, label: '8 hours' },
  { minutes: 10_080, label: '1 week' },
];

function Radio({ on }: { on: boolean }) {
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: on ? colors.accent : 'transparent',
        borderWidth: on ? 0 : 2,
        borderColor: withAlpha(colors.white, 0.3),
      }}
    >
      {on ? <Icon name="check" size={14} color={colors.white} strokeWidth={3} /> : null}
    </View>
  );
}

export default function ChatNotifications() {
  const { id, name } = useLocalSearchParams<{ id?: string; name?: string }>();
  const { user } = useAuth();
  const me = user?.id;
  const res = useAsync(() => (id && me ? loadMySettings(id, me) : Promise.resolve(null)), [id, me], 'app/chat-notifications:46');
  const [override, setOverride] = useState<boolean | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const muted = override ?? !!res.data?.muted;

  const apply = async (next: boolean, minutes?: number) => {
    if (!id || !me || busy) return;
    setBusy(true);
    setToast(null);
    try {
      if (next && minutes) await muteConversationFor(id, minutes);
      else if (next) await updateMySettings(id, me, { muted: true });
      else {
        await updateMySettings(id, me, { muted: false });
        await muteConversationFor(id, null);
      }
      setOverride(next);
      setToast({ ok: true, text: next ? (minutes ? `Muted for ${MUTE_FOR.find((m) => m.minutes === minutes)?.label}` : 'Notifications muted') : 'Notifications on' });
    } catch (e) {
      setToast({ ok: false, text: e instanceof Error ? e.message : 'Could not change notifications' });
    } finally {
      setBusy(false);
    }
  };

  const options = [
    { key: 'all', title: 'All messages', sub: 'Sound and preview', on: !muted, onPress: () => void apply(false) },
    { key: 'mute', title: 'Mute', sub: 'Silent, still shows unread', on: muted, onPress: () => void apply(true) },
  ];

  return (
    <Screen top={4} gap={14} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral', orbs: true }}>
      <Row gap={8} style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" size={44} iconSize={20} glass href="back" />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={40} accessibilityRole="header">
          Notifications
        </T>
        <T size={14} lineHeight={20} color={colors.textSecondary} numberOfLines={1}>
          {name ? `For ${name}` : 'For this chat'}
        </T>
      </View>

      {res.loading && !res.data ? (
        <Loading label="Loading notification settings" />
      ) : (
        <>
          <Glass radius={32} padding={0}>
            {options.map((o, i) => (
              <Tap
                key={o.key}
                onPress={o.onPress}
                accessibilityRole="radio"
                accessibilityState={{ selected: o.on, disabled: busy }}
                accessibilityLabel={`${o.title}. ${o.sub}`}
                style={[{ minHeight: 64 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
              >
                <Row gap={12} style={{ minHeight: 64, paddingHorizontal: 16 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T size={15} weight={600}>
                      {o.title}
                    </T>
                    <T size={12} color={colors.textSecondary}>
                      {o.sub}
                    </T>
                  </View>
                  <Radio on={o.on} />
                </Row>
              </Tap>
            ))}
          </Glass>

          <View style={{ paddingHorizontal: 4 }}>
            <T variant="overline" color={colors.textSecondary} accessibilityRole="header" style={{ textTransform: 'uppercase' }}>
              Mute for
            </T>
          </View>
          <Glass radius={36} padding={0} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
            {MUTE_FOR.map((m, i) => (
              <Tap
                key={m.minutes}
                onPress={() => void apply(true, m.minutes)}
                accessibilityLabel={`Mute for ${m.label}`}
                style={[{ minHeight: 56 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
              >
                <Row gap={12} style={{ minHeight: 56, paddingHorizontal: 12 }}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.accent, 0.18), alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="bellOff" size={18} color={colors.accentLight} />
                  </View>
                  <T size={16} weight={500} style={{ flex: 1 }}>
                    {m.label}
                  </T>
                </Row>
              </Tap>
            ))}
          </Glass>
        </>
      )}
      {toast ? <Toast icon={toast.ok ? 'check' : 'info'} iconColor={toast.ok ? colors.accentLight : colors.error} message={toast.text} /> : null}
    </Screen>
  );
}
